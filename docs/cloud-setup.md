# Accounts, online backup and reminders (Supabase)

Everything online in Pantri is optional. With empty values in `app/js/config.js` (as committed), the
app works only on the phone: no account screen, nothing is fetched. Filling in two public values
switches on accounts and online backup; a third one switches on reminder notifications.

What runs where:

| Piece | Where | What it does |
| --- | --- | --- |
| `app/js/cloud.js`, `app/js/sync.js` | the app | Sign in, keep the pantry in sync, store reminders and push subscriptions |
| `supabase/migrations/` | the database | Tables with row-level security, the save/restore functions, a cron job every 10 minutes |
| `supabase/functions/send-reminders/` | an Edge Function | Sends the reminders that are due as Web Push notifications |

## Production setup

You need Node.js and a free account at [supabase.com](https://supabase.com). Run the commands from
the repository folder; they work the same in PowerShell and Git Bash.

### 1. Create the project

1. In the Supabase dashboard: **New project**. Name it (e.g. `pantri`), pick an **EU region** (for
   example *Central EU (Frankfurt)*), and generate a strong database password. Keep the password in
   your password manager; it never goes into the repository.
2. Note the **project ref**: the part before `.supabase.co` in the project URL
   (*Project Settings → General → Project ID*). Below it is written as `<ref>`.

### 2. Link the repository and create the database

```sh
npx supabase login
npx supabase link --project-ref <ref>
npx supabase db push
```

`link` asks for the database password. `db push` creates the tables, functions and the cron job
(answer `Y` when it asks). `supabase/seed.sql` is only for the local stack and is not applied here.

### 3. Function secrets (VAPID keys and the cron secret)

```sh
node tools/vapid.mjs --write supabase/.env.production --subject https://urdateodor.github.io/Pantri/
npx supabase secrets set --env-file supabase/.env.production
```

The first command writes a fresh VAPID key pair, the subject and a random `CRON_SECRET` into
`supabase/.env.production` (git-ignored) and prints the **VAPID public key** and the **CRON_SECRET**:
you need both below. Keep the file somewhere safe or delete it after step 5. Never commit it: it holds
the VAPID private key.

Keep the VAPID keys once phones have turned on reminders: new keys make every existing subscription
invalid, and each phone has to turn reminders on again.

### 4. Deploy the function

```sh
npx supabase functions deploy send-reminders --no-verify-jwt --use-api
```

`--no-verify-jwt` is correct: the function isn't called with a user's token but by the cron job,
with the `x-cron-secret` header, and refuses every request without it. `--use-api` bundles the
function on Supabase's side, so Docker isn't needed.

### 5. Tell the cron job where to call (Vault)

Replace `<ref>` and `<CRON_SECRET>` (the value printed in step 3):

```sh
npx supabase db query --linked "select vault.create_secret('https://<ref>.supabase.co', 'project_url', 'Base URL for the reminder cron job')"
npx supabase db query --linked "select vault.create_secret('<CRON_SECRET>', 'cron_secret', 'Shared secret for send-reminders')"
```

Check that the chain works (cron job → function → database):

```sh
npx supabase db query --linked "select private.send_due_reminders()"
npx supabase db query --linked "select status_code, content from net._http_response order by id desc limit 1"
```

The second command should show `200` and `{"due":0,...}`. To change a value later:
`select vault.update_secret((select id from vault.secrets where name = 'cron_secret'), '<new value>')`
(and `npx supabase secrets set CRON_SECRET=<new value>` so both sides match).

### 6. Auth settings (dashboard → Authentication)

- **Sign In / Providers → Email**: enabled, and **Confirm email off**. Pantri uses email and password
  only, so signing in never depends on opening a link (links open in the browser, not in an app
  installed on an iPhone's home screen).
- **URL Configuration**: Site URL `https://urdateodor.github.io/Pantri/`, and under Redirect URLs add
  `https://urdateodor.github.io/Pantri/**`. Password-reset links return there.
- **Password**: set the minimum length to 8 (the app asks for 8 when creating an account).
- **Sign In / Providers → Allow anonymous sign-ins**: on. A phone without an account that turns on
  the daily reminder signs in anonymously: that user can only hold the phone's push subscription and
  reminders (the database refuses to store a pantry for it). It is deleted when the phone switches
  the reminder off or signs in to an account, and a daily job deletes anonymous users that have had
  no device for a week.
- **Emails → SMTP Settings**: only password-reset emails are sent. Supabase's built-in mailer is meant
  for trying things out: it sends only a few emails per hour and only to addresses of your project's
  team members. For password resets that reach everyone, set up your own SMTP server here (any
  transactional email service works).

### 7. Put the public values into the app

In the dashboard, **Project Settings → API Keys**: copy the **publishable key** (`sb_publishable_…`;
the legacy `anon` key works too). Then fill in the defaults in `app/js/config.js`:

```js
export const SUPABASE_URL = override.SUPABASE_URL ?? 'https://<ref>.supabase.co';
export const SUPABASE_ANON_KEY = override.SUPABASE_ANON_KEY ?? '<publishable key>';
export const VAPID_PUBLIC_KEY = override.VAPID_PUBLIC_KEY ?? '<VAPID public key from step 3>';
```

These three values are public by design: row-level security keeps every account's data to itself.
Never put the database password, a `service_role`/secret key, the VAPID private key or the cron
secret into the app. Commit and publish as usual (`npm run deploy`).

### Later updates

- Changed migrations: `npx supabase db push`
- Changed function: `npx supabase functions deploy send-reminders --no-verify-jwt --use-api`
- Function logs: dashboard → Edge Functions → send-reminders → Logs. Cron runs:
  `npx supabase db query --linked "select status, start_time from cron.job_run_details order by start_time desc limit 5"`

Free projects are paused after a week without activity; the data is kept and you can restore the
project from the dashboard.

## How it works

**Accounts.** Email and password. Signing out keeps the pantry on the phone (or removes it, if you
choose). *Delete my online data* removes the online pantry, its earlier versions, the push
subscriptions and reminders; the account itself stays, so signing in again starts afresh.

**Online copy.** The app keeps one state object, and so does the server: one row per account in
`pantries`, with a revision number. Every save names the revision it was based on (compare-and-swap,
`save_pantry`), so two phones can never overwrite each other blindly. The app uploads about two seconds
after a change, checks for a newer online copy when it starts and when it comes back to the
foreground, and retries when the connection returns. The site a phone shows and its "last backup file"
date stay on that phone.

**Signing in.** If the account has no online copy, the phone's pantry is uploaded. If the phone has no
products, it takes the online copy. If both have products (and they differ), the app asks which one
to keep.

**Conflicts.** If two phones changed the pantry before seeing each other's changes, the one changed
most recently wins everywhere. The other version is never thrown away: it goes into `pantry_history`.

**Earlier versions.** The server keeps up to 20 earlier versions per account: one an hour at most
while the same phone keeps saving, one whenever another device saves over a version, one before a save
that removes most products, and every copy replaced by a conflict, a sign-in choice or a restore.
Account → Earlier versions restores any of them (on every device).

**Reminders.** The phone stores its push subscription (`save_push_subscription`) and its upcoming
reminders (`replace_reminders`: at most 60, replaced as a whole). Every 10 minutes the cron job calls
`send-reminders`, which sends what is due to every device of that account as Web Push (VAPID,
`aes128gcm`, payload `{ "title", "body", "url", "tag" }`), marks it sent, skips reminders that are over
6 hours late, and deletes subscriptions the push service no longer knows (404/410).

## Local development

Needs Docker Desktop (running).

```sh
node tools/vapid.mjs --write supabase/functions/.env --cron-secret local-dev-cron-secret
npx supabase start          # first run downloads the images; prints the local URL and keys
npm run e2e:cloud           # accounts, sync, conflicts, RLS, reminders and pushes against the local stack
npx supabase stop
```

`supabase/seed.sql` stores the local cron settings in Vault (`project_url` = the API inside Docker,
`cron_secret` = `local-dev-cron-secret`, matching the `.env` above). If you create the `.env` while
the stack runs, restart it (`npx supabase stop` then `npx supabase start`) so the function sees it.

To try the app against the local stack, temporarily put the local `API_URL` and `PUBLISHABLE_KEY`
from `npx supabase status` into `app/js/config.js` (don't commit them) and run `npm run serve`.
Studio (tables, logs) is at http://127.0.0.1:54323; emails such as password resets land in Mailpit at
http://127.0.0.1:54324.
