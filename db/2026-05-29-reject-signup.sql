-- Reject a pending signup.
--
-- Adds a reversible "rejected" state: the signup leaves the Pending list,
-- can't sign in, and shows under a Rejected list where an admin can Approve it
-- or move it back to Pending. We DON'T delete the auth account (that would
-- need a service-role Edge Function and is irreversible) — a rejected user
-- simply stays approved_at = NULL + rejected_at set, so the existing gate
-- (which already blocks anyone without approved_at) keeps them out.
--
-- Depends on _is_active_admin / _is_super_admin from the PIN-auth migration.
-- Safe to run twice. Run once in Supabase → SQL Editor.

alter table user_profiles
  add column if not exists rejected_at timestamptz,
  add column if not exists rejected_by uuid references auth.users(id);

comment on column user_profiles.rejected_at is
  'When an admin rejected this pending signup. Non-null = rejected: hidden '
  'from Pending and cannot sign in. Cleared on approve or move-to-pending.';

-- Extend the authenticated SELECT whitelist with the two new columns
-- (pin_hash stays excluded). Column grants are additive, so re-granting the
-- full list is safe + idempotent.
grant select (
  id, email, name, role, active,
  is_super_admin, approved_at, approved_by,
  pin_set_at, pin_attempts, pin_locked_until,
  created_at, rejected_at, rejected_by
) on user_profiles to authenticated;

-- ── admin_reject_user — set (p_rejected=true) or clear (false) the flag. ────
-- Rejecting also deactivates; clearing returns the user to Pending. Any active
-- admin can do it; a super-admin can never be rejected.
create or replace function admin_reject_user(p_user_id uuid, p_rejected boolean default true)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_me uuid := auth.uid();
begin
  if not _is_active_admin(v_me) then raise exception 'admin only'; end if;
  if _is_super_admin(p_user_id) then raise exception 'cannot reject a super admin'; end if;
  if coalesce(p_rejected, true) then
    update user_profiles
       set rejected_at = now(), rejected_by = v_me, active = false
     where id = p_user_id;
  else
    update user_profiles
       set rejected_at = null, rejected_by = null
     where id = p_user_id;
  end if;
end $$;

grant execute on function admin_reject_user(uuid, boolean) to authenticated;

-- ── admin_approve_user — now also clears any rejected flag on approve. ──────
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
         approved_by = v_me,
         rejected_at = null,
         rejected_by = null
   where id = p_user_id;
end $$;

grant execute on function admin_approve_user(uuid) to authenticated;

select 'reject-signup ready' as status,
       count(*) filter (where rejected_at is not null) as rejected_now
from user_profiles;
