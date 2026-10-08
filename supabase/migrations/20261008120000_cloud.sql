-- Pantri online storage. Each account keeps one pantry (the app's whole state object), some earlier
-- versions of it, the push subscriptions of its devices and its scheduled reminders.
-- Users only ever see their own rows. Writes go through the functions below, which check their input;
-- the tables themselves only allow reading (and deleting) your own rows.

create schema if not exists private;

-- ---------- pantries ----------

create table public.pantries (
  user_id uuid primary key references auth.users (id) on delete cascade,
  state jsonb not null,
  -- Bumped by every save. A save names the revision it was based on (compare-and-swap).
  rev bigint not null default 1,
  products integer generated always as (jsonb_array_length(state -> 'products')) stored,
  -- When the newest change in this copy was made (the device's clock), and which device saved it.
  changed_at timestamptz not null default now(),
  device text,
  device_id text,
  updated_at timestamptz not null default now()
);

alter table public.pantries enable row level security;
create policy "Users read their own pantry" on public.pantries
  for select to authenticated using (user_id = (select auth.uid()));
create policy "Users delete their own pantry" on public.pantries
  for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.pantries from anon;
revoke insert, update, truncate, references, trigger on public.pantries from authenticated;

-- ---------- earlier versions ----------

create table public.pantry_history (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  state jsonb not null,
  products integer generated always as (jsonb_array_length(state -> 'products')) stored,
  -- The online revision this copy had; null for a phone's copy that never was the online one.
  rev bigint,
  changed_at timestamptz,
  device text,
  -- Why it was kept: 'checkpoint' (at most hourly), 'other-device' (another device saved over it),
  -- 'shrink' (the next save had far fewer products), 'conflict' (lost a conflict), 'first-sync'
  -- (replaced when a phone signed in), 'restore' (replaced by an earlier version).
  reason text not null,
  saved_at timestamptz not null default now()
);
create index pantry_history_user_saved_at on public.pantry_history (user_id, saved_at desc);

alter table public.pantry_history enable row level security;
create policy "Users read their own earlier versions" on public.pantry_history
  for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.pantry_history from anon;
revoke insert, update, delete, truncate, references, trigger on public.pantry_history from authenticated;

-- ---------- push subscriptions (one per device that wants reminders) ----------

create table public.push_subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  device text,
  created_at timestamptz not null default now(),
  last_success_at timestamptz
);
create index push_subscriptions_user_id on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
create policy "Users read their own push subscriptions" on public.push_subscriptions
  for select to authenticated using (user_id = (select auth.uid()));
create policy "Users delete their own push subscriptions" on public.push_subscriptions
  for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.push_subscriptions from anon;
revoke insert, update, truncate, references, trigger on public.push_subscriptions from authenticated;

-- ---------- reminders (sent as push notifications by the send-reminders function) ----------

create table public.reminders (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  send_at timestamptz not null,
  title text not null,
  body text,
  url text,
  tag text,
  sent_at timestamptz,
  -- Null while waiting; then 'sending', 'sent', 'no-device', 'failed' or 'skipped' (too late to send).
  status text,
  created_at timestamptz not null default now()
);
create index reminders_due on public.reminders (send_at) where sent_at is null;
create index reminders_user_send_at on public.reminders (user_id, send_at);

alter table public.reminders enable row level security;
create policy "Users read their own reminders" on public.reminders
  for select to authenticated using (user_id = (select auth.uid()));
create policy "Users delete their own reminders" on public.reminders
  for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.reminders from anon;
revoke insert, update, truncate, references, trigger on public.reminders from authenticated;

-- ---------- helpers (not reachable through the API) ----------

create function private.signed_in_user()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  return uid;
end;
$$;

create function private.check_pantry(p_state jsonb)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_state is null or jsonb_typeof(p_state) <> 'object'
     or jsonb_typeof(p_state -> 'products') is distinct from 'array'
     or jsonb_typeof(p_state -> 'batches') is distinct from 'array' then
    raise exception 'This is not Pantri data.' using errcode = '22023';
  end if;
  if octet_length(p_state::text) > 10 * 1024 * 1024 then
    raise exception 'The pantry is too large to store online (over 10 MB).' using errcode = '54000';
  end if;
end;
$$;

-- A short label such as "iPhone · app"; empty means none.
create function private.label(p_text text, p_max integer default 100)
returns text
language sql
immutable
set search_path = ''
as $$ select left(nullif(btrim(p_text), ''), p_max) $$;

-- Keep a copy in the history: at most 20 per user, the oldest go first.
create function private.keep_version(
  p_user uuid, p_state jsonb, p_rev bigint, p_changed_at timestamptz, p_device text, p_reason text
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  insert into public.pantry_history (user_id, state, rev, changed_at, device, reason)
  values (p_user, p_state, p_rev, p_changed_at, p_device, p_reason);
  delete from public.pantry_history h
  where h.user_id = p_user
    and h.id not in (
      select k.id from public.pantry_history k
      where k.user_id = p_user
      order by k.saved_at desc, k.id desc
      limit 20);
end;
$$;

revoke all on function private.signed_in_user() from public;
revoke all on function private.check_pantry(jsonb) from public;
revoke all on function private.label(text, integer) from public;
revoke all on function private.keep_version(uuid, jsonb, bigint, timestamptz, text, text) from public;

-- ---------- saving and restoring the pantry ----------

-- Save the pantry if the online copy is still the revision this device last saw (p_base_rev; 0 when the
-- account has no online copy yet). Returns {"ok": true, "rev": n} or {"ok": false, "reason":
-- "conflict" | "missing", "rev": current}. "missing": the copy this device was based on was deleted.
-- The replaced version is kept in pantry_history when another device saved it, when the new one has
-- far fewer products, at most hourly otherwise, and always when p_reason ('conflict', 'first-sync')
-- says this save deliberately replaces a different copy.
create function public.save_pantry(
  p_state jsonb,
  p_base_rev bigint,
  p_changed_at timestamptz default null,
  p_device text default null,
  p_device_id text default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.signed_in_user();
  cur public.pantries%rowtype;
  keep text;
  -- The device's clock decides which copy is newer; one running fast must not win every conflict.
  changed timestamptz := least(coalesce(p_changed_at, now()), now() + interval '5 minutes');
  dev text := private.label(p_device);
  dev_id text := private.label(p_device_id, 64);
begin
  perform private.check_pantry(p_state);
  if p_reason is not null and p_reason not in ('conflict', 'first-sync') then
    raise exception 'Unknown reason: %', p_reason using errcode = '22023';
  end if;

  select * into cur from public.pantries where user_id = uid for update;
  if not found then
    if coalesce(p_base_rev, 0) <> 0 then
      return jsonb_build_object('ok', false, 'reason', 'missing', 'rev', 0);
    end if;
    insert into public.pantries (user_id, state, rev, changed_at, device, device_id)
    values (uid, p_state, 1, changed, dev, dev_id)
    on conflict (user_id) do nothing;
    if not found then -- another device created it at the same moment
      return jsonb_build_object('ok', false, 'reason', 'conflict',
        'rev', (select p.rev from public.pantries p where p.user_id = uid));
    end if;
    return jsonb_build_object('ok', true, 'rev', 1);
  end if;

  if cur.rev <> coalesce(p_base_rev, 0) then
    return jsonb_build_object('ok', false, 'reason', 'conflict', 'rev', cur.rev);
  end if;

  keep := case
    when p_reason is not null then p_reason
    when cur.device_id is distinct from dev_id then 'other-device'
    when cur.products > 0 and jsonb_array_length(p_state -> 'products') * 2 < cur.products then 'shrink'
    when not exists (
      select 1 from public.pantry_history h
      where h.user_id = uid and h.saved_at > now() - interval '1 hour') then 'checkpoint'
  end;
  if keep is not null then
    perform private.keep_version(uid, cur.state, cur.rev, cur.changed_at, cur.device, keep);
  end if;

  update public.pantries
     set state = p_state, rev = cur.rev + 1, changed_at = changed, device = dev, device_id = dev_id,
         updated_at = now()
   where user_id = uid;
  return jsonb_build_object('ok', true, 'rev', cur.rev + 1);
end;
$$;

-- Keep a copy from this device in the history without making it the online copy (the copy that
-- lost a conflict, or the phone's data that was replaced by the online copy at sign-in).
create function public.stash_pantry(
  p_state jsonb,
  p_changed_at timestamptz default null,
  p_device text default null,
  p_reason text default 'conflict'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.signed_in_user();
begin
  perform private.check_pantry(p_state);
  if p_reason is null or p_reason not in ('conflict', 'first-sync') then
    raise exception 'Unknown reason: %', p_reason using errcode = '22023';
  end if;
  perform private.keep_version(uid, p_state, null, least(coalesce(p_changed_at, now()), now()),
    private.label(p_device), p_reason);
end;
$$;

-- Make an earlier version the online copy again (the current one is kept in the history).
-- Returns {"rev", "changedAt", "state"} of the new online copy.
create function public.restore_pantry_version(
  p_id bigint,
  p_device text default null,
  p_device_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.signed_in_user();
  earlier public.pantry_history%rowtype;
  cur public.pantries%rowtype;
  next_rev bigint := 1;
begin
  select * into earlier from public.pantry_history where id = p_id and user_id = uid;
  if not found then
    raise exception 'That version no longer exists.' using errcode = 'P0002';
  end if;
  select * into cur from public.pantries where user_id = uid for update;
  if found then
    perform private.keep_version(uid, cur.state, cur.rev, cur.changed_at, cur.device, 'restore');
    next_rev := cur.rev + 1;
    update public.pantries
       set state = earlier.state, rev = next_rev, changed_at = now(), device = private.label(p_device),
           device_id = private.label(p_device_id, 64), updated_at = now()
     where user_id = uid;
  else
    insert into public.pantries (user_id, state, rev, changed_at, device, device_id)
    values (uid, earlier.state, 1, now(), private.label(p_device), private.label(p_device_id, 64));
  end if;
  return jsonb_build_object('rev', next_rev, 'changedAt', now(), 'state', earlier.state);
end;
$$;

-- "Delete my online data": the pantry, its earlier versions, push subscriptions and reminders.
-- The account itself stays, so signing in again starts afresh.
create function public.delete_my_data()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.signed_in_user();
begin
  delete from public.reminders where user_id = uid;
  delete from public.push_subscriptions where user_id = uid;
  delete from public.pantry_history where user_id = uid;
  delete from public.pantries where user_id = uid;
end;
$$;

-- ---------- push subscriptions ----------

-- Store (or update) this device's push subscription for the signed-in user. The endpoint is unique:
-- a device that switches accounts moves its subscription to the new account.
create function public.save_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_device text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.signed_in_user();
begin
  if p_endpoint is null or p_endpoint !~ '^https://[^\s]+$' or length(p_endpoint) > 1000 then
    raise exception 'Not a valid push endpoint.' using errcode = '22023';
  end if;
  if p_p256dh is null or p_p256dh !~ '^[A-Za-z0-9_+/=-]{80,100}$'
     or p_auth is null or p_auth !~ '^[A-Za-z0-9_+/=-]{16,32}$' then
    raise exception 'Not valid push subscription keys.' using errcode = '22023';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, device)
  values (uid, p_endpoint, p_p256dh, p_auth, private.label(p_device))
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
        device = excluded.device;
  -- At most 20 devices per account.
  delete from public.push_subscriptions s
  where s.user_id = uid
    and s.id not in (
      select k.id from public.push_subscriptions k
      where k.user_id = uid
      order by coalesce(k.last_success_at, k.created_at) desc, k.id desc
      limit 20);
end;
$$;

-- ---------- reminders ----------

-- Replace the signed-in user's unsent reminders with `items` in one go:
--   [{ "sendAt": ISO-8601 with time zone, "title": text, "body"?: text, "url"?: text, "tag"?: text }]
-- At most 60 items. Items more than 6 hours in the past are dropped (they would not be sent), and so
-- are items that already went out (same time, title and tag), so sending the same list twice never
-- notifies twice. Returns how many reminders are now waiting.
create function public.replace_reminders(items jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.signed_in_user();
  item jsonb;
  k integer := 0;
  n integer := 0;
  raw text;
  send_time timestamptz;
  t text;
  b text;
  u text;
  g text;
begin
  if items is null or jsonb_typeof(items) <> 'array' then
    raise exception 'replace_reminders: items must be an array.' using errcode = '22023';
  end if;
  if jsonb_array_length(items) > 60 then
    raise exception 'replace_reminders: at most 60 reminders (got %).', jsonb_array_length(items)
      using errcode = '22023';
  end if;

  delete from public.reminders where user_id = uid and sent_at is null;

  for item in select value from jsonb_array_elements(items) loop
    k := k + 1;
    if jsonb_typeof(item) <> 'object' then
      raise exception 'replace_reminders: item % is not an object.', k using errcode = '22023';
    end if;
    raw := coalesce(item ->> 'sendAt', item ->> 'send_at');
    if raw is null or raw !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$' then
      raise exception 'replace_reminders: item %: sendAt must be an ISO-8601 time with a time zone (got %).', k, raw
        using errcode = '22007';
    end if;
    send_time := raw::timestamptz;
    t := btrim(item ->> 'title');
    b := nullif(item ->> 'body', '');
    u := nullif(btrim(item ->> 'url'), '');
    g := nullif(item ->> 'tag', '');
    if t is null or t = '' or length(t) > 200 then
      raise exception 'replace_reminders: item %: title is required (at most 200 characters).', k
        using errcode = '22023';
    end if;
    if length(b) > 1000 or length(u) > 1000 or length(g) > 200 then
      raise exception 'replace_reminders: item %: body and url are limited to 1000 characters, tag to 200.', k
        using errcode = '22023';
    end if;
    if u ~* '^\s*(javascript|data|vbscript):' then
      raise exception 'replace_reminders: item %: url must be a web address.', k using errcode = '22023';
    end if;
    continue when send_time < now() - interval '6 hours';
    continue when exists (
      select 1 from public.reminders r
      where r.user_id = uid and r.sent_at is not null and r.send_at = send_time and r.title = t
        and r.tag is not distinct from g);
    insert into public.reminders (user_id, send_at, title, body, url, tag)
    values (uid, send_time, t, b, u, g);
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- For the send-reminders function (service role only): mark reminders that are too late (over 6 hours)
-- as skipped, and claim the due ones (marked as sent right away, so overlapping runs never send twice).
-- Skipped rows come back with stale = true and without their text.
create function public.claim_due_reminders(p_limit integer default 500)
returns table (
  id bigint, user_id uuid, send_at timestamptz, title text, body text, url text, tag text, stale boolean
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  -- Sent reminders are only kept for a week (long enough to recognise one that is sent again).
  delete from public.reminders r where r.sent_at < now() - interval '7 days';
  return query
    update public.reminders r set sent_at = now(), status = 'skipped'
     where r.sent_at is null and r.send_at < now() - interval '6 hours'
    returning r.id, r.user_id, r.send_at, null::text, null::text, null::text, null::text, true;
  return query
    update public.reminders r set sent_at = now(), status = 'sending'
     where r.id in (
       select x.id from public.reminders x
       where x.sent_at is null and x.send_at <= now()
       order by x.send_at
       limit greatest(1, least(coalesce(p_limit, 500), 5000))
       for update skip locked)
    returning r.id, r.user_id, r.send_at, r.title, r.body, r.url, r.tag, false;
end;
$$;

-- ---------- who may call what ----------

revoke all on function public.save_pantry(jsonb, bigint, timestamptz, text, text, text) from public, anon;
revoke all on function public.stash_pantry(jsonb, timestamptz, text, text) from public, anon;
revoke all on function public.restore_pantry_version(bigint, text, text) from public, anon;
revoke all on function public.delete_my_data() from public, anon;
revoke all on function public.save_push_subscription(text, text, text, text) from public, anon;
revoke all on function public.replace_reminders(jsonb) from public, anon;
revoke all on function public.claim_due_reminders(integer) from public, anon, authenticated;

grant execute on function public.save_pantry(jsonb, bigint, timestamptz, text, text, text) to authenticated;
grant execute on function public.stash_pantry(jsonb, timestamptz, text, text) to authenticated;
grant execute on function public.restore_pantry_version(bigint, text, text) to authenticated;
grant execute on function public.delete_my_data() to authenticated;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;
grant execute on function public.replace_reminders(jsonb) to authenticated;
grant execute on function public.claim_due_reminders(integer) to service_role;
