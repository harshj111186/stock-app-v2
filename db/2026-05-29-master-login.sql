-- Master LOGIN — server-side resolver for the master-password sign-in.
--
-- Companion to the master-login Edge Function. Given an email + the master
-- key, returns the target account's user_id IF the key is correct AND the
-- target is a normal, active, approved account — NEVER the super-admin (main
-- master account). Returns NULL otherwise.
--
-- This function is callable ONLY by the service_role (i.e. only from inside
-- the Edge Function, which holds the service key). It is NOT exposed to
-- authenticated/anon clients, so it can't be used as a "is this the master
-- key?" oracle from the browser.
--
-- Depends on app_config + _is_super_admin + pgcrypto from the earlier
-- migrations. Safe to run twice. Run once in Supabase → SQL Editor.

create or replace function master_login_resolve(p_email text, p_key text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash     text;
  v_uid      uuid;
  v_super    boolean;
  v_active   boolean;
  v_approved timestamptz;
begin
  if p_email is null or p_key is null or btrim(p_key) = '' then
    return null;
  end if;

  select master_key_hash into v_hash from app_config where id = 'singleton';
  if v_hash is null then return null; end if;
  if v_hash <> extensions.crypt(btrim(p_key), v_hash) then return null; end if;

  select id, is_super_admin, active, approved_at
    into v_uid, v_super, v_active, v_approved
    from user_profiles
   where lower(email) = lower(btrim(p_email))
   limit 1;

  if v_uid is null then return null; end if;
  if coalesce(v_super, false) then return null; end if;        -- never the main master account
  if not coalesce(v_active, false) or v_approved is null then  -- only active + approved accounts
    return null;
  end if;

  return v_uid;
end $$;

-- Lock it down to the service role only (the Edge Function). Clients can't call it.
revoke all on function master_login_resolve(text, text) from public;
revoke all on function master_login_resolve(text, text) from authenticated, anon;
grant execute on function master_login_resolve(text, text) to service_role;

select 'master_login_resolve ready (service_role only)' as status;
