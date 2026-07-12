-- =====================================================================
--  LOGIN DIRECTORY — profile-picker sign-in (2026-06-11)
--  Idempotent. Run once in Supabase → SQL Editor (or via Management API).
--
--  Lets the login screen show every sign-in-able profile as a tappable
--  card (name + role), so people pick their name instead of typing an
--  email. Supabase still signs in with email under the hood, so the
--  picker needs each profile's email — exposed here to `anon` via a
--  tightly-scoped view (NO pin_hash / nothing sensitive; only accounts
--  that can actually sign in).
--
--  Also: capture the display name at signup so the picker has a name to
--  show immediately (was NULL until an admin set it).
-- =====================================================================


-- ─── 1) Anon-readable sign-in directory ───────────────────────────────
-- Owner-rights view (security_invoker = false, the default) so `anon`
-- can read it even though `anon` can't read user_profiles directly.
-- Filtered to approved + active + not-rejected = the only accounts you
-- can sign into. name falls back to the email's local part when unset.
create or replace view public.login_directory
with (security_invoker = false) as
  select
    up.id,
    coalesce(nullif(btrim(up.name), ''), split_part(up.email, '@', 1)) as name,
    up.email,
    up.role::text   as role,
    up.is_super_admin
  from user_profiles up
  where up.approved_at is not null
    and up.active = true
    and up.rejected_at is null;

comment on view public.login_directory is
  'Anon-readable sign-in picker: id + display name + email + role for accounts '
  'that can sign in (approved + active + not rejected). Email is exposed so the '
  'picker can call signInWithPassword without the user typing it. Owner-rights '
  'view — exposes NO pin_hash or other sensitive columns. Sign-in is still '
  'protected by password + PIN.';

grant select on public.login_directory to anon, authenticated;


-- ─── 2) Capture display name at signup ────────────────────────────────
-- The picker is name-first, so every profile needs a name. signUp() now
-- passes the name in user_metadata; the trigger reads it. Existing logic
-- (seed admins, super-admin, approval gate, on-conflict upgrade) is
-- preserved exactly — only `name` is added.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_seed_admin boolean := new.email in ('harsh.j111186@gmail.com', 'bhavik9347@gmail.com');
  v_is_super      boolean := new.email = 'harsh.j111186@gmail.com';
  v_name          text    := nullif(btrim(new.raw_user_meta_data->>'name'), '');
begin
  insert into user_profiles (
    id, email, name, role, active, is_super_admin, approved_at
  )
  values (
    new.id,
    new.email,
    v_name,
    (case when v_is_seed_admin then 'admin' else 'viewer' end)::role_t,
    v_is_seed_admin,
    v_is_super,
    case when v_is_seed_admin then now() else null end
  )
  on conflict (id) do update set
    role           = case
                       when excluded.role::text = 'admin' then 'admin'::role_t
                       else user_profiles.role
                     end,
    active         = user_profiles.active or excluded.active,
    is_super_admin = user_profiles.is_super_admin or excluded.is_super_admin,
    approved_at    = coalesce(user_profiles.approved_at, excluded.approved_at),
    -- Only fill the name if it isn't already set (don't clobber an
    -- admin-curated name with a later metadata value).
    name           = coalesce(user_profiles.name, excluded.name);
  return new;
end $$;


-- ─── 3) Verification ───────────────────────────────────────────────────
select
  (select count(*) from information_schema.views where table_name='login_directory') as view_present,        -- expect 1
  (select count(*) from information_schema.role_table_grants
     where table_name='login_directory' and grantee='anon' and privilege_type='SELECT') as anon_can_read,     -- expect 1
  (select count(*) from public.login_directory) as signin_able_accounts;
