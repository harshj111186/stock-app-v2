-- Patch: pgcrypto lives in the `extensions` schema on Supabase, not `public`.
--
-- The set_pin / verify_pin / change_pin functions from
-- 2026-05-22-pin-auth-and-approval.sql declare `set search_path = public`,
-- so when they call `gen_salt('bf')` or `crypt(...)` Postgres can't find
-- those functions and bails with:
--
--   ERROR:  function gen_salt(unknown) does not exist
--
-- Fix: fully-qualify every pgcrypto call as `extensions.gen_salt(...)` /
-- `extensions.crypt(...)`. This is the recommended Supabase pattern —
-- safer than widening search_path because it's explicit about what schema
-- each function comes from.
--
-- Idempotent: just CREATE OR REPLACE on the three functions. No data
-- migration needed; no rows are touched.
--
-- Run once in Supabase Dashboard → SQL Editor.

-- ──────────────────────────────────────────────────────────────────────────
-- set_pin
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
     set pin_hash         = extensions.crypt(p_pin, extensions.gen_salt('bf')),
         pin_set_at       = now(),
         pin_attempts     = 0,
         pin_locked_until = null
   where id = v_uid;
  if not found then
    raise exception 'profile not found for this user';
  end if;
end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- verify_pin
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

  v_ok := (v_hash = extensions.crypt(p_pin, v_hash));

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

-- ──────────────────────────────────────────────────────────────────────────
-- change_pin
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
  if v_hash <> extensions.crypt(p_old_pin, v_hash) then return false; end if;

  update user_profiles
     set pin_hash         = extensions.crypt(p_new_pin, extensions.gen_salt('bf')),
         pin_set_at       = now(),
         pin_attempts     = 0,
         pin_locked_until = null
   where id = v_uid;
  return true;
end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- Smoke test — should print one row with a 60-char bcrypt hash.
-- ──────────────────────────────────────────────────────────────────────────
select
  extensions.crypt('1234', extensions.gen_salt('bf')) as sample_hash,
  length(extensions.crypt('1234', extensions.gen_salt('bf'))) as hash_len;
