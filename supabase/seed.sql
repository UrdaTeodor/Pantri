-- Local stack only (run by `supabase start` on a new database and by `supabase db reset`).
-- Tells the reminder cron job where the send-reminders function is, as seen from the database
-- container, and the shared secret it sends. Production values are set by hand: docs/cloud-setup.md.
-- The secret must match CRON_SECRET in supabase/functions/.env (see `node tools/vapid.mjs --help`).
select vault.create_secret('http://kong:8000', 'project_url', 'Base URL of the API, for the reminder cron job');
select vault.create_secret('local-dev-cron-secret', 'cron_secret', 'Shared secret for send-reminders (local stack only)');
