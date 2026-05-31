-- Master key — a super-admin-set secret that unlocks ANY account's PIN gate
-- EXCEPT the main master (super-admin) account.
--
-- Why: forgotten PINs, shared devices, owner oversight. Entered at the PIN
-- gate in place of an account's own PIN, it lets you into that account and
-- also clears any 5-attempt lockout. It deliberately CANNOT unlock the
-- super-admin account (harsh) — that's enforced here in SQL, not just in the
-- UI, so it can't be bypassed from the API.
--
-- Security:
--   • Stored bcrypt-hashed in a one-row app_config table that clients can
--     neither read nor write — everything goes through SECURITY DEFINER RPCs.
--   • Only the super-admin can set or clear it.
--   • verify_master_key returns false for the super-admin's own session.
--
-- Depends on _is_super_admin() + pgcrypto from db/2026-05-22-pin-auth-and-approval.sql.
-- Safe to run twice. Run once in Supabase Dashboard → SQL Editor.

create extension if not exists pgcrypto;

-- ──────────────────────────────────────────────────────────────────────────
-- 1. Storage — single-row config table, fully locked down to clients.
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists app_config (
  id              text primary key default 'singleton',
  master_key_hash text,
  updated_at      timestamptz,
  updated_by      uuid references auth.users(id),
  constraint app_config_singleton check (id = 'singleton')
);
insert into app_config (id) values ('singleton') on conflict (id) do nothing;

alter table app_config enable row level security;
-- No policies + no grants → authenticated/anon can't touch it directly. The
-- SECURITY DEFINER functions below run as the table owner and bypass RLS.
revoke all on app_config from authenticated, anon;

-- ──────────────────────────────────────────────────────────────────────────
-- 2. set_master_key — super-admin only. Alphanumeric, ≥ 4 chars (longer than
--    a 4-digit PIN because it unlocks every non-master account).
-- ──────────────────────────────────────────────────────────────────────────
create or replace function set_master_key(p_key text)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if not _is_super_admin(v_uid) then
    raise exception 'only the super-admin can set the master key';
  end if;
  if p_key is null or length(btrim(p_key)) < 4 then
    raise exception 'master key must be at least 4 characters';
  end if;
  update app_config
     set master_key_hash = extensions.crypt(btrim(p_key), extensions.gen_salt('bf')),
         updated_at = now(), updated_by = v_uid
   where id = 'singleton';
end $$;
grant execute on function set_master_key(text) to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 3. clear_master_key — super-admin only.
-- ──────────────────────────────────────────────────────────────────────────
create or replace function clear_master_key()
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if not _is_super_admin(v_uid) then
    raise exception 'only the super-admin can clear the master key';
  end if;
  update app_config set master_key_hash = null, updated_at = now(), updated_by = v_uid
   where id = 'singleton';
end $$;
grant execute on function clear_master_key() to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 4. master_key_is_set — boolean, so the UI knows whether to offer the option
--    / show "set" vs "not set". Not sensitive (no hash exposed).
-- ──────────────────────────────────────────────────────────────────────────
create or replace function master_key_is_set()
returns boolean language sql stable security definer set search_path = public as $$
  select master_key_hash is not null from app_config where id = 'singleton';
$$;
grant execute on function master_key_is_set() to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 5. verify_master_key — true iff p_key matches AND the caller is NOT the
--    super-admin. On success, clears the caller's PIN lockout (recovery path).
--    Returns false (never raises) on a bad key so the gate shows a clean error.
-- ──────────────────────────────────────────────────────────────────────────
create or replace function verify_master_key(p_key text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_hash text;
  v_ok   boolean;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  -- The master key can NEVER unlock the main master account.
  if _is_super_admin(v_uid) then return false; end if;
  if p_key is null or btrim(p_key) = '' then return false; end if;

  select master_key_hash into v_hash from app_config where id = 'singleton';
  if v_hash is null then return false; end if;

  v_ok := (v_hash = extensions.crypt(btrim(p_key), v_hash));
  if v_ok then
    update user_profiles set pin_attempts = 0, pin_locked_until = null where id = v_uid;
  end if;
  return v_ok;
end $$;
grant execute on function verify_master_key(text) to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 6. Smoke check
-- ──────────────────────────────────────────────────────────────────────────
select 'master key ready' as status,
       (select master_key_hash is not null from app_config where id = 'singleton') as key_is_set;
