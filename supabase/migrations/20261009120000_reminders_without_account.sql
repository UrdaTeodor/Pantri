-- Reminders without an account. A phone that only wants notifications signs in anonymously (Supabase
-- anonymous sign-ins, switched on in the project's auth settings). Such a user can register the phone's
-- push subscription and its reminders, but can't keep a pantry online. None of it stays longer than
-- needed: forget_anonymous_device() deletes it when the phone switches notifications off or signs in to
-- an account, and a daily job deletes anonymous users that have had no device for a week.

-- Whether the caller signed in anonymously (false for accounts and for the server's own jobs).
create function private.is_anonymous()
returns boolean
language sql
stable
set search_path = ''
as $$ select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) $$;

create function private.pantry_needs_account()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if private.is_anonymous() then
    raise exception 'Create an account to keep the pantry online.' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.is_anonymous() from public;
revoke all on function private.pantry_needs_account() from public;

create trigger pantries_need_account before insert or update on public.pantries
  for each row execute function private.pantry_needs_account();
create trigger pantry_history_needs_account before insert on public.pantry_history
  for each row execute function private.pantry_needs_account();

-- Delete the calling anonymous user, with its push subscription and reminders.
create function public.forget_anonymous_device()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.signed_in_user();
begin
  if not private.is_anonymous() then
    raise exception 'Only for phones without an account.' using errcode = '42501';
  end if;
  delete from auth.users u where u.id = uid and u.is_anonymous;
end;
$$;

revoke all on function public.forget_anonymous_device() from public, anon;
grant execute on function public.forget_anonymous_device() to authenticated;

-- Anonymous users that have had no device for a week: the phone switched notifications off while it
-- couldn't reach the server, or the push service dropped its subscription. Returns how many went.
create function private.forget_idle_anonymous_users()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  delete from auth.users u
   where u.is_anonymous
     and u.created_at < now() - interval '7 days'
     and not exists (select 1 from public.push_subscriptions s where s.user_id = u.id);
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function private.forget_idle_anonymous_users() from public;

select cron.schedule('pantri-forget-idle-anonymous', '17 3 * * *', 'select private.forget_idle_anonymous_users()');
