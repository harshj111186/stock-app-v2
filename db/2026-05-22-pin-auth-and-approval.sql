-- PIN-based auth + signup-approval workflow + super-admin protection
--
-- This migration:
--   1. Adds a 4-digit PIN per user (bcrypt-hashed, never leaves the DB).
--   2. Adds an approval gate on new signups (active=false until an admin OKs them).
--   3. Designates harsh.j111186@gmail.com as super-admin (immune to other admins).
--   4. Auto-approves harsh + bhavik9347@gmail.com on signup as admins.
--   5. Locks down the pin_hash column so authenticated users CAN'T read it.
--   6. Adds SECURITY DEFINER RPCs for set_pin / verify_pin / change_pin /
--      admin_reset_pin / admin_approve_user / admin_set_role / admin_set_active.
--
-- Safe to run twice — every step is idempotent.
--
-- Run once in Supabase Dashboard → SQL Editor.

-- ──────────────────────────────────────────────────────────────────────────
-- 1. pgcrypto for bcrypt
-- ──────────────────────────────────────────────────────────────────────────
create extension if not exists pgcrypto;

-- ──────────────────────────────────────────────────────────────────────────
-- 2. New columns on user_profiles
-- ──────────────────────────────────────────────────────────────────────────
alter table user_profiles
  add column if not exists pin_hash         text,
  add column if not exists pin_set_at       timestamptz,
  add column if not exists pin_attempts     smallint not null default 0,
  add column if not exists pin_locked_until timestamptz,
  add column if not exists is_super_admin   boolean not null default false,
  add column if not exists approved_at      timestamptz,
  add column if not exists approved_by      uuid references auth.users(id);

comment on column user_profiles.pin_hash is
  '4-digit PIN, bcrypt-hashed via pgcrypto. NEVER selectable from the client — '
  'access only through verify_pin() / change_pin() / set_pin() RPCs.';
comment on column user_profiles.pin_set_at is
  'When the current PIN was set. NULL means user has no PIN yet — UI should '
  'show the "Set PIN" gate.';
comment on column user_profiles.pin_attempts is
  'Consecutive bad-PIN attempts since the last good one. Lockout at 5.';
comment on column user_profiles.pin_locked_until is
  'If now() < this value, all PIN verification calls fail. Cleared on a '
  'successful verify or admin reset.';
comment on column user_profiles.is_super_admin is
  'Only harsh.j111186@gmail.com is true. Super-admins can manage admin role; '
  'other admins cannot modify a super-admin row.';
comment on column user_profiles.approved_at is
  'When this signup was approved by an admin. NULL = pending. Required for '
  'active=true to actually unlock the app.';
comment on column user_profiles.approved_by is
  'Which admin approved this user.';

-- ──────────────────────────────────────────────────────────────────────────
-- 3. Grandfather existing active users — mark them as already-approved
--    so they don't get bounced to "pending" after this migration runs.
-- ──────────────────────────────────────────────────────────────────────────
update user_profiles
   set approved_at = coalesce(created_at, now())
 where approved_at is null
   and active = true;

-- ──────────────────────────────────────────────────────────────────────────
-- 4. Seed harsh as super-admin (idempotent)
-- ──────────────────────────────────────────────────────────────────────────
update user_profiles
   set is_super_admin = true,
       role           = 'admin',
       active         = true,
       approved_at    = coalesce(approved_at, now())
 where email = 'harsh.j111186@gmail.com';

-- ──────────────────────────────────────────────────────────────────────────
-- 5. Tighten column-level SELECT so pin_hash never reaches the client.
--    The whitelist below = every column the app currently reads + the new
--    ones. Add new columns here as the schema evolves.
-- ──────────────────────────────────────────────────────────────────────────
revoke select on user_profiles from authenticated;
grant select (
  id, email, name, role, active,
  is_super_admin, approved_at, approved_by,
  pin_set_at, pin_attempts, pin_locked_until,
  created_at
) on user_profiles to authenticated;

revoke select on user_profiles from anon;
-- anon doesn't need any user_profiles access.

-- Same lockdown for UPDATE: an authenticated user can ONLY directly update
-- their own display name. Every other column (role, active, approved_at,
-- pin_hash, is_super_admin, …) is changeable only through the admin RPCs
-- below, which run as SECURITY DEFINER and enforce the role / super-admin
-- rules. Without this, a user with raw UPDATE permission on user_profiles
-- could escalate themselves to super-admin via a direct API call.
revoke update on user_profiles from authenticated;
grant  update (name) on user_profiles to authenticated;
revoke update on user_profiles from anon;

-- INSERT stays revoked from clients — only the trigger inserts.
revoke insert on user_profiles from authenticated, anon;
revoke delete on user_profiles from authenticated, anon;

-- ──────────────────────────────────────────────────────────────────────────
-- 6. Override handle_new_user trigger:
--      - harsh / bhavik → admin, active, approved on signup
--      - everyone else  → viewer, inactive, pending approval
--      - harsh also gets is_super_admin=true
--    Replaces the old "first user becomes admin" logic.
-- ──────────────────────────────────────────────────────────────────────────
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_seed_admin boolean := new.email in ('harsh.j111186@gmail.com', 'bhavik9347@gmail.com');
  v_is_super      boolean := new.email = 'harsh.j111186@gmail.com';
begin
  insert into user_profiles (
    id, email, role, active, is_super_admin, approved_at
  )
  values (
    new.id,
    new.email,
    case when v_is_seed_admin then 'admin' else 'viewer' end,
    v_is_seed_admin,
    v_is_super,
    case when v_is_seed_admin then now() else null end
  )
  on conflict (id) do update set
    -- If somehow a row exists already (rare), upgrade the seed admins.
    role           = case when excluded.role::text = 'admin' then 'admin' else user_profiles.role end,
    active         = user_profiles.active or excluded.active,
    is_super_admin = user_profiles.is_super_admin or excluded.is_super_admin,
    approved_at    = coalesce(user_profiles.approved_at, excluded.approved_at);
  return new;
end $$;

-- Ensure the trigger is in place. (Re-creating is harmless.)
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ──────────────────────────────────────────────────────────────────────────
-- 7. Helper predicates used by the admin RPCs below.
-- ──────────────────────────────────────────────────────────────────────────
create or replace function _is_active_admin(p_uid uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select role::text = 'admin' and active from user_profiles where id = p_uid),
    false
  );
$$;

create or replace function _is_super_admin(p_uid uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select is_super_admin from user_profiles where id = p_uid),
    false
  );
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- 8. set_pin — used at signup and as the only way for a user to "create"
--    their PIN if they don't have one yet. Always overwrites — change_pin
--    is the version that requires the old PIN.
-- ──────────────────────────────────────────────────────────────────────────
create or replace function set_pin(p_pin text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_pin is null or p_pin !~ '^\d{4}$' then
    raise exception 'PIN must be exactly 4 digits';
  end if;
  update user_profiles
     set pin_hash         = crypt(p_pin, gen_salt('bf')),
         pin_set_at       = now(),
         pin_attempts     = 0,
         pin_locked_until = null
   where id = v_uid;
  if not found then
    raise exception 'profile not found for this user';
  end if;
end $$;

grant execute on function set_pin(text) to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 9. verify_pin — returns true/false. Increments attempts on miss; locks
--    after 5 misses for 15 minutes. Returns false (not raises) on bad PIN
--    so the UI can show a clean "wrong PIN" message; raises only on
--    structural problems (no PIN set, locked out, not authenticated).
-- ──────────────────────────────────────────────────────────────────────────
create or replace function verify_pin(p_pin text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid          uuid       := auth.uid();
  v_hash         text;
  v_attempts     smallint;
  v_locked       timestamptz;
  v_ok           boolean;
  v_new_attempts smallint;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_pin is null or p_pin !~ '^\d{4}$' then
    return false;
  end if;

  select pin_hash, pin_attempts, pin_locked_until
    into v_hash, v_attempts, v_locked
    from user_profiles
   where id = v_uid;

  if v_hash is null then
    raise exception 'PIN not set' using errcode = '02000';
  end if;

  if v_locked is not null and v_locked > now() then
    raise exception 'PIN locked. Try again after %',
      to_char(v_locked at time zone 'Asia/Kolkata', 'HH24:MI');
  end if;

  v_ok := (v_hash = crypt(p_pin, v_hash));

  if v_ok then
    update user_profiles
       set pin_attempts = 0, pin_locked_until = null
     where id = v_uid;
  else
    v_new_attempts := v_attempts + 1;
    update user_profiles
       set pin_attempts     = v_new_attempts,
           pin_locked_until = case
             when v_new_attempts >= 5 then now() + interval '15 minutes'
             else null
           end
     where id = v_uid;
  end if;

  return v_ok;
end $$;

grant execute on function verify_pin(text) to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 10. change_pin — verify old PIN, then set new. Returns false if the
--     supplied old PIN is wrong; the UI can react without a thrown error.
-- ──────────────────────────────────────────────────────────────────────────
create or replace function change_pin(p_old_pin text, p_new_pin text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid := auth.uid(); v_hash text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_new_pin is null or p_new_pin !~ '^\d{4}$' then
    raise exception 'new PIN must be exactly 4 digits';
  end if;
  if p_old_pin = p_new_pin then
    raise exception 'new PIN must differ from the current PIN';
  end if;
  select pin_hash into v_hash from user_profiles where id = v_uid;
  if v_hash is null then raise exception 'no current PIN to change'; end if;
  if v_hash <> crypt(p_old_pin, v_hash) then return false; end if;

  update user_profiles
     set pin_hash         = crypt(p_new_pin, gen_salt('bf')),
         pin_set_at       = now(),
         pin_attempts     = 0,
         pin_locked_until = null
   where id = v_uid;
  return true;
end $$;

grant execute on function change_pin(text, text) to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 11. admin_reset_pin — admin nukes a user's PIN; user sets a new one on
--     next sign-in. Regular admin can reset anyone EXCEPT super-admin.
-- ──────────────────────────────────────────────────────────────────────────
create or replace function admin_reset_pin(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_me uuid := auth.uid();
begin
  if not _is_active_admin(v_me) then raise exception 'admin only'; end if;
  if _is_super_admin(p_user_id) and not _is_super_admin(v_me) then
    raise exception 'cannot modify super admin';
  end if;
  update user_profiles
     set pin_hash         = null,
         pin_set_at       = null,
         pin_attempts     = 0,
         pin_locked_until = null
   where id = p_user_id;
end $$;

grant execute on function admin_reset_pin(uuid) to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 12. admin_approve_user — flip a pending user to active.
-- ──────────────────────────────────────────────────────────────────────────
create or replace function admin_approve_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_me uuid := auth.uid();
begin
  if not _is_active_admin(v_me) then raise exception 'admin only'; end if;
  update user_profiles
     set active      = true,
         approved_at = now(),
         approved_by = v_me
   where id = p_user_id;
end $$;

grant execute on function admin_approve_user(uuid) to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 13. admin_set_role — role changes have two tiers:
--       - any admin can move staff ↔ viewer
--       - only super-admin can promote to admin OR demote an existing admin
--     Super-admin themselves can never be demoted by anyone (including
--     themselves through this function — protects against accidents).
-- ──────────────────────────────────────────────────────────────────────────
create or replace function admin_set_role(p_user_id uuid, p_new_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me           uuid := auth.uid();
  v_target_role  text;
begin
  if not _is_active_admin(v_me) then raise exception 'admin only'; end if;
  if p_new_role not in ('admin', 'staff', 'viewer') then
    raise exception 'role must be admin, staff, or viewer';
  end if;
  if _is_super_admin(p_user_id) then
    raise exception 'cannot change super-admin role';
  end if;

  select role::text into v_target_role from user_profiles where id = p_user_id;

  if (p_new_role = 'admin' or v_target_role = 'admin')
     and not _is_super_admin(v_me) then
    raise exception 'only the super-admin can manage the admin role';
  end if;

  update user_profiles set role = p_new_role where id = p_user_id;
end $$;

grant execute on function admin_set_role(uuid, text) to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 14. admin_set_active — deactivate / re-activate a user. Cannot be used
--     to flip a never-approved user; use admin_approve_user for that.
--     Super-admin protected.
-- ──────────────────────────────────────────────────────────────────────────
create or replace function admin_set_active(p_user_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_me uuid := auth.uid();
begin
  if not _is_active_admin(v_me) then raise exception 'admin only'; end if;
  if _is_super_admin(p_user_id) then
    raise exception 'cannot modify super admin';
  end if;
  update user_profiles
     set active = p_active
   where id = p_user_id
     and approved_at is not null;  -- never-approved users must go through approve flow
end $$;

grant execute on function admin_set_active(uuid, boolean) to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 15. admin_set_name — admin can fix a user's display name (e.g. set
--     "Bhavik" for bhavik's auto-created profile so the sidebar isn't
--     showing his email). Optional but handy.
-- ──────────────────────────────────────────────────────────────────────────
create or replace function admin_set_name(p_user_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_me uuid := auth.uid();
begin
  if not _is_active_admin(v_me) then raise exception 'admin only'; end if;
  if _is_super_admin(p_user_id) and not _is_super_admin(v_me) then
    raise exception 'cannot modify super admin';
  end if;
  update user_profiles set name = p_name where id = p_user_id;
end $$;

grant execute on function admin_set_name(uuid, text) to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 16. Verification — should all return clean.
-- ──────────────────────────────────────────────────────────────────────────
select
  count(*)                                       as total_users,
  count(*) filter (where is_super_admin)         as super_admins,
  count(*) filter (where role::text = 'admin')   as admins,
  count(*) filter (where approved_at is null)    as pending_users,
  count(*) filter (where pin_hash is not null)   as users_with_pin
from user_profiles;

-- Confirm the column-level grants stuck. `pin_hash` should NOT appear.
select column_name
from information_schema.column_privileges
where table_schema = 'public'
  and table_name   = 'user_profiles'
  and grantee      = 'authenticated'
  and privilege_type = 'SELECT'
order by column_name;
