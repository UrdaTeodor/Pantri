-- Every 10 minutes, ask the send-reminders Edge Function to send the reminders that are due.
-- Where the function lives and the shared secret it expects are read from Vault on every run, so this
-- migration is the same in every environment. Each environment stores its own two values once:
--   select vault.create_secret('<project URL>', 'project_url');   -- e.g. https://<ref>.supabase.co
--   select vault.create_secret('<secret>', 'cron_secret');        -- same as the function's CRON_SECRET
-- (supabase/seed.sql does this for the local stack; docs/cloud-setup.md for production.)

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Returns the pg_net request id, or null (with a notice) while the Vault values are missing.
create function private.send_due_reminders()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  base text;
  secret text;
begin
  select decrypted_secret into base from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'cron_secret';
  if base is null or secret is null then
    raise notice 'send_due_reminders: store project_url and cron_secret in Vault first';
    return null;
  end if;
  return net.http_post(
    url := rtrim(base, '/') || '/functions/v1/send-reminders',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret),
    timeout_milliseconds := 60000
  );
end;
$$;

revoke all on function private.send_due_reminders() from public;

select cron.schedule('pantri-send-reminders', '*/10 * * * *', 'select private.send_due_reminders()');
