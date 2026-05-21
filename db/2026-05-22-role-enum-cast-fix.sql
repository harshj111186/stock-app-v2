-- Patch: admin_set_role couldn't assign a text variable to the role enum.
--
-- The `role` column in user_profiles is an enum type (role_t — per the
-- error returned from PostgREST: "column \"role\" is of type role_t but
-- expression is of type text"). PL/pgSQL won't implicitly cast a text
-- variable to an enum type the way it will for a string literal.
--
-- Fix: explicit `::role_t` cast inside admin_set_role. Also re-create
-- handle_new_user with explicit literal casts so future signups don't
-- trip the same wall if Postgres ever decides to be stricter about CASE
-- expressions resolving to text.
--
-- Idempotent: just CREATE OR REPLACE on the two functions.
--
-- Run once in Supabase Dashboard → SQL Editor.

-- ──────────────────────────────────────────────────────────────────────────
-- admin_set_role — the broken one
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

  -- Explicit text → enum cast. p_new_role is already validated to one of
  -- the three known values, so the cast can't fail at runtime.
  update user_profiles set role = p_new_role::role_t where id = p_user_id;
end $$;

grant execute on function admin_set_role(uuid, text) to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- handle_new_user — same defensive treatment, even though it works today
-- because string literals get cast through context. CREATE OR REPLACE so
-- this is safe to re-run; the trigger binding is unchanged.
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
    approved_at    = coalesce(user_profiles.approved_at, excluded.approved_at);
  return new;
end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- Smoke test — confirm the enum cast resolves cleanly.
-- ──────────────────────────────────────────────────────────────────────────
select 'admin'::role_t   as admin_cast,
       'staff'::role_t   as staff_cast,
       'viewer'::role_t  as viewer_cast;
