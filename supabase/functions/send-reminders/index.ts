// send-reminders: sends the reminders that are due as Web Push notifications to every device of
// their user. Called every 10 minutes by the pg_cron job (migrations/*_reminder_schedule.sql) with the
// shared secret in the x-cron-secret header; any other caller gets 401.
// Function secrets: CRON_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (docs/cloud-setup.md).
// Push payload (JSON): { "title", "body"?, "url"?, "tag"? } (empty fields are left out).

import { createClient } from 'npm:@supabase/supabase-js@2.117.3';
import { importVapidKeys, sendPush } from './webpush.js';

type Due = {
  id: number; user_id: string; send_at: string; stale: boolean;
  title: string | null; body: string | null; url: string | null; tag: string | null;
};
type Subscription = { id: number; user_id: string; endpoint: string; p256dh: string; auth: string };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Compares in constant time, so response times don't give the secret away. */
function sameSecret(given: string, expected: string) {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** A new-style secret key when the project has one, else the legacy service_role key. */
function serviceKey() {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    const key = keys.default ?? Object.values(keys)[0];
    if (typeof key === 'string' && key) return key;
  } catch { /* not set */ }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
}

/** Runs `fn` for every item, at most `limit` at a time. */
async function inParallel<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const retryable = (status: number) => status === 429 || status >= 500;

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  const secret = Deno.env.get('CRON_SECRET') ?? '';
  if (!secret) return json({ error: 'CRON_SECRET is not set.' }, 500);
  if (!sameSecret(req.headers.get('x-cron-secret') ?? '', secret)) return json({ error: 'Unauthorized.' }, 401);

  const subject = Deno.env.get('VAPID_SUBJECT') ?? '';
  if (!/^(mailto:|https:\/\/)\S+$/.test(subject)) {
    return json({ error: 'VAPID_SUBJECT must be a mailto: or https:// address.' }, 500);
  }
  let vapid;
  try {
    vapid = await importVapidKeys(Deno.env.get('VAPID_PUBLIC_KEY') ?? '', Deno.env.get('VAPID_PRIVATE_KEY') ?? '');
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }

  const db = createClient(Deno.env.get('SUPABASE_URL') ?? '', serviceKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await db.rpc('claim_due_reminders', { p_limit: 500 });
  if (error) return json({ error: `claim_due_reminders: ${error.message}` }, 500);
  const claimed = (data ?? []) as Due[];
  const due = claimed.filter((r) => !r.stale);
  const result = {
    due: due.length, skipped: claimed.length - due.length, sent: 0, noDevice: 0, failed: 0, retryLater: 0,
    removedSubscriptions: 0,
  };
  if (!due.length) return json(result);

  // Claimed reminders count as sent; give them back if we can't even look up the devices.
  const release = (ids: number[]) => db.from('reminders').update({ sent_at: null, status: null }).in('id', ids);
  const { data: subs, error: subsError } = await db
    .from('push_subscriptions')
    .select('id, user_id, endpoint, p256dh, auth')
    .in('user_id', [...new Set(due.map((r) => r.user_id))]);
  if (subsError) {
    await release(due.map((r) => r.id));
    return json({ error: `push_subscriptions: ${subsError.message}` }, 500);
  }
  const devices = new Map<string, Subscription[]>();
  for (const s of subs as Subscription[]) devices.set(s.user_id, [...(devices.get(s.user_id) ?? []), s]);

  const delivered = new Set<number>(); // reminder ids that reached at least one device
  const tryAgain = new Set<number>(); // reminder ids with a temporary failure
  const working = new Set<number>(); // subscription ids that accepted a message
  const gone = new Set<number>(); // subscription ids the push service no longer knows (404 / 410)
  const jobs = due.flatMap((r) => (devices.get(r.user_id) ?? []).map((s) => ({ r, s })));
  await inParallel(jobs, 8, async ({ r, s }) => {
    if (gone.has(s.id)) return;
    const message = JSON.stringify({
      title: r.title,
      ...(r.body ? { body: r.body } : {}),
      ...(r.url ? { url: r.url } : {}),
      ...(r.tag ? { tag: r.tag } : {}),
    });
    try {
      const res = await sendPush(s, message, { vapid, subject });
      if (res.ok) {
        delivered.add(r.id);
        working.add(s.id);
      } else if (res.gone) {
        gone.add(s.id);
      } else {
        if (retryable(res.status)) tryAgain.add(r.id);
        console.error(`Push to subscription ${s.id} failed: ${res.status} ${res.detail}`);
      }
    } catch (e) {
      tryAgain.add(r.id); // network error or timeout
      console.error(`Push to subscription ${s.id} failed: ${(e as Error).message}`);
    }
  });

  const byStatus = new Map<string, number[]>();
  const later: number[] = [];
  for (const r of due) {
    const left = (devices.get(r.user_id) ?? []).filter((s) => !gone.has(s.id));
    if (!delivered.has(r.id) && left.length && tryAgain.has(r.id)) {
      later.push(r.id);
      continue;
    }
    const status = delivered.has(r.id) ? 'sent' : left.length ? 'failed' : 'no-device';
    byStatus.set(status, [...(byStatus.get(status) ?? []), r.id]);
  }
  for (const [status, ids] of byStatus) {
    const { error: e } = await db.from('reminders').update({ status }).in('id', ids);
    if (e) console.error(`Marking reminders ${status} failed: ${e.message}`);
  }
  if (later.length) await release(later); // the next run tries again (until they are 6 hours late)
  if (gone.size) {
    const { error: e } = await db.from('push_subscriptions').delete().in('id', [...gone]);
    if (e) console.error(`Removing expired subscriptions failed: ${e.message}`);
  }
  if (working.size) {
    await db.from('push_subscriptions').update({ last_success_at: new Date().toISOString() }).in('id', [...working]);
  }

  Object.assign(result, {
    sent: byStatus.get('sent')?.length ?? 0,
    noDevice: byStatus.get('no-device')?.length ?? 0,
    failed: byStatus.get('failed')?.length ?? 0,
    retryLater: later.length,
    removedSubscriptions: gone.size,
  });
  console.log(JSON.stringify(result));
  return json(result);
});
