-- =====================================================================
--  HARDENING + FIXES (2026-06-10 audit) — run once in Supabase → SQL Editor.
--  Idempotent — safe to re-run.
--
--  What this fixes (found in the full-app audit):
--   1. process_transaction / reverse_transaction had NO role gate — any
--      authenticated account (viewer, pending, deactivated) could post
--      stock by calling the RPC directly. Now: active admin/staff only.
--   2. reverse_transaction could reverse the SAME transaction twice from
--      a stale tab / second device (client-only guard). Now guarded
--      server-side + a unique index makes a double physically impossible.
--   3. Transfer reversal tagged `reverses_id` via a "latest Transfer"
--      heuristic that could tag the WRONG row under concurrency. Now it
--      uses the id returned by process_transaction.
--   4. process_transaction gains optional p_invoice_no / p_rate params —
--      invoice + rate were being flattened into the note text while the
--      real columns stayed forever NULL. Old 7-arg calls keep working.
--   5. set_pin let a hijacked session OVERWRITE an existing PIN (and clear
--      the lockout) without knowing the old one. Now set_pin only works
--      when no PIN exists; change_pin now honours/feeds the 5-miss lockout.
--   6. admin_set_active / admin_reject_user / admin_set_name /
--      admin_reset_pin let a regular admin act on ANOTHER admin (the UI
--      hides it; the server now enforces it) and let an admin deactivate /
--      reject themselves.
--   7. master_login_resolve was brute-forceable (unlimited tries). Now:
--      per-email throttle (5 fails / 15 min) + global circuit breaker.
--   8. Reconciliation drafts/done RLS allowed VIEWERS to write counts and
--      flip "done". Now: own-row writes require an active admin/staff role.
--   9. user_names view — staff/viewer could not resolve colleague names
--      (user_profiles RLS is self-or-admin), so the transaction log showed
--      "—" for everyone else. The view exposes id+name+email only.
--  10. category_rename / category_move / category_archive(restore) raised
--      raw "duplicate key" errors on name collisions. Now: friendly errors.
--  11. price_history.discounts — history rows now keep the stacked
--      breakdown, not just the combined fraction.
-- =====================================================================


-- ─── 0) Helper: active admin OR staff ─────────────────────────────────
create or replace function _is_active_staff_or_admin(p_uid uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select up.role::text in ('admin','staff')
        and up.active
        and up.approved_at is not null
       from user_profiles up where up.id = p_uid),
    false
  );
$$;
revoke all on function _is_active_staff_or_admin(uuid) from public, anon;
grant execute on function _is_active_staff_or_admin(uuid) to authenticated, service_role;


-- ─── 1) process_transaction: role gate + invoice/rate params ──────────
-- Drop the 7-arg version so exactly ONE signature exists (avoids named-call
-- ambiguity). The new 9-arg version defaults the extra params, so the old
-- 7-arg call style — including apply_reconciliation's internal call — keeps
-- working unchanged.
drop function if exists public.process_transaction(uuid, action_t, godown_t, int, date, text, int);

create or replace function public.process_transaction(
  p_item_id    uuid,
  p_action     action_t,
  p_godown     godown_t,
  p_qty        int,
  p_date       date    default current_date,
  p_note       text    default null,
  p_direction  int     default null,
  p_invoice_no text    default null,
  p_rate       numeric default null
) returns uuid as $$
declare
  v_case_size int;
  v_cases int; v_loose int; v_total int; v_new_total int;
  v_dest godown_t;
  v_dc int; v_dl int;
  v_txn_id uuid;
  v_dir smallint;
begin
  -- Role gate: an end-user JWT must belong to an active, approved admin or
  -- staff profile. Calls with NO JWT (SQL editor / service key) pass — they
  -- are already privileged; PostgREST exposure is controlled by the grants
  -- below (anon has no execute).
  if auth.uid() is not null and not _is_active_staff_or_admin(auth.uid()) then
    raise exception 'Only an active admin or staff account can post transactions';
  end if;

  if p_qty <= 0 then raise exception 'Quantity must be > 0'; end if;

  -- Resolve direction by action. Adjustment / Return are caller-supplied.
  v_dir := case p_action
    when 'Purchase'   then 1
    when 'Sale'       then -1
    when 'Transfer'   then -1   -- source-side; destination handled below
    when 'Adjustment' then p_direction::smallint
    when 'Return'     then p_direction::smallint
  end;

  if v_dir is null or v_dir not in (-1, 1) then
    raise exception 'Adjustment and Return require p_direction = +1 or -1 (got %)', p_direction;
  end if;

  -- Look up case_size (may be 0 → item sold loose only)
  select case_size into v_case_size from items where id = p_item_id;
  if not found then raise exception 'Item not found'; end if;

  -- Ensure source row exists, then lock it
  insert into godown_stock(item_id, godown) values (p_item_id, p_godown)
    on conflict do nothing;
  select cases, loose into v_cases, v_loose
    from godown_stock where item_id = p_item_id and godown = p_godown for update;

  -- Current total in physical units
  v_total := case when v_case_size > 0 then v_cases * v_case_size + v_loose else v_loose end;

  -- For outbound moves (direction = -1) require sufficient stock
  if v_dir = -1 and p_qty > v_total then
    raise exception 'Insufficient stock at godown % (have %, need %)', p_godown, v_total, p_qty;
  end if;

  -- Apply delta and re-split into cases + loose
  v_new_total := v_total + (v_dir * p_qty);
  if v_case_size > 0 then
    v_cases := v_new_total / v_case_size;
    v_loose := v_new_total - v_cases * v_case_size;
  else
    v_cases := 0;
    v_loose := v_new_total;
  end if;

  update godown_stock
     set cases = v_cases, loose = v_loose, updated_at = now()
   where item_id = p_item_id and godown = p_godown;

  -- Transfer: also credit the destination godown (+p_qty there)
  if p_action = 'Transfer' then
    v_dest := case p_godown when 'A' then 'B' else 'A' end;
    insert into godown_stock(item_id, godown) values (p_item_id, v_dest)
      on conflict do nothing;
    select cases, loose into v_dc, v_dl
      from godown_stock where item_id = p_item_id and godown = v_dest for update;
    v_dl := v_dl + p_qty;
    if v_case_size > 0 then
      v_dc := v_dc + v_dl / v_case_size;
      v_dl := v_dl % v_case_size;
    end if;
    update godown_stock
       set cases = v_dc, loose = v_dl, updated_at = now()
     where item_id = p_item_id and godown = v_dest;
  end if;

  -- Write the ledger row (invoice_no / rate now land in their real columns)
  insert into transactions(
    item_id, action, godown, qty, txn_date, status, note, direction,
    invoice_no, rate, created_by
  )
  values (
    p_item_id, p_action, p_godown, p_qty, p_date, 'OK', p_note, v_dir,
    nullif(btrim(coalesce(p_invoice_no, '')), ''), p_rate, auth.uid()
  )
  returning id into v_txn_id;

  return v_txn_id;
end $$ language plpgsql security definer set search_path = public;

revoke all on function public.process_transaction(uuid, action_t, godown_t, int, date, text, int, text, numeric) from public, anon;
grant execute on function public.process_transaction(uuid, action_t, godown_t, int, date, text, int, text, numeric) to authenticated, service_role;


-- ─── 2) reverse_transaction: double-reverse guard + safe Transfer tag ──
-- Belt: the function refuses when a reversal already points at the txn.
-- Braces: a partial unique index makes a second reversal row impossible
-- even under a concurrent race.
create unique index if not exists transactions_reverses_id_uq
  on transactions (reverses_id) where reverses_id is not null;

create or replace function public.reverse_transaction(p_txn_id uuid)
returns uuid as $$
declare
  t transactions%rowtype;
  v_new uuid;
  v_reverse_action action_t;
begin
  if auth.uid() is not null and not _is_active_staff_or_admin(auth.uid()) then
    raise exception 'Only an active admin or staff account can reverse transactions';
  end if;

  select * into t from transactions where id = p_txn_id for update;
  if not found then raise exception 'Transaction not found'; end if;
  if t.reverses_id is not null then raise exception 'Already a reversal'; end if;
  if exists (select 1 from transactions where reverses_id = p_txn_id) then
    raise exception 'This transaction has already been reversed';
  end if;

  -- Adjustment / Return: insert opposite-direction row with same action
  if t.action in ('Adjustment', 'Return') then
    v_new := process_transaction(
      t.item_id, t.action, t.godown, t.qty,
      current_date, 'Reversal of ' || t.id,
      (-t.direction)::int
    );
    update transactions set reverses_id = t.id where id = v_new;
    return v_new;
  end if;

  -- Transfer reversal: send the same qty back from the destination.
  -- Uses the returned id directly (the old "latest unmarked Transfer"
  -- subquery could tag a concurrent user's row).
  if t.action = 'Transfer' then
    v_new := process_transaction(t.item_id, 'Transfer',
              case t.godown when 'A' then 'B' else 'A' end,
              t.qty, current_date,
              'Reversal of ' || t.id);
    update transactions set reverses_id = t.id where id = v_new;
    return v_new;
  end if;

  -- Purchase ↔ Sale: invert the action
  if t.action = 'Purchase' then v_reverse_action := 'Sale';
  else v_reverse_action := 'Purchase';
  end if;

  v_new := process_transaction(t.item_id, v_reverse_action, t.godown, t.qty,
                               current_date, 'Reversal of ' || t.id);
  update transactions set reverses_id = t.id where id = v_new;
  return v_new;
end $$ language plpgsql security definer set search_path = public;

revoke all on function public.reverse_transaction(uuid) from public, anon;
grant execute on function public.reverse_transaction(uuid) to authenticated, service_role;


-- ─── 3) PIN hardening ──────────────────────────────────────────────────
-- set_pin: creation only. With a PIN already set, the holder of a live
-- session can no longer overwrite it (and wipe the lockout) — they must go
-- through change_pin (old PIN) or an admin reset.
create or replace function set_pin(p_pin text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid := auth.uid(); v_existing text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_pin is null or p_pin !~ '^\d{4}$' then
    raise exception 'PIN must be exactly 4 digits';
  end if;
  select pin_hash into v_existing from user_profiles where id = v_uid;
  if not found then
    raise exception 'profile not found for this user';
  end if;
  if v_existing is not null then
    raise exception 'A PIN is already set — use Change PIN (or ask an admin to reset it)';
  end if;
  update user_profiles
     set pin_hash         = extensions.crypt(p_pin, extensions.gen_salt('bf')),
         pin_set_at       = now(),
         pin_attempts     = 0,
         pin_locked_until = null
   where id = v_uid;
end $$;

-- change_pin: now respects + feeds the same 5-miss / 15-min lockout as
-- verify_pin, so it can't be used as an unthrottled old-PIN oracle.
create or replace function change_pin(p_old_pin text, p_new_pin text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid          uuid := auth.uid();
  v_hash         text;
  v_attempts     smallint;
  v_locked       timestamptz;
  v_new_attempts smallint;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_new_pin is null or p_new_pin !~ '^\d{4}$' then
    raise exception 'new PIN must be exactly 4 digits';
  end if;
  if p_old_pin = p_new_pin then
    raise exception 'new PIN must differ from the current PIN';
  end if;

  select pin_hash, pin_attempts, pin_locked_until
    into v_hash, v_attempts, v_locked
    from user_profiles where id = v_uid;
  if v_hash is null then raise exception 'no current PIN to change'; end if;

  if v_locked is not null and v_locked > now() then
    raise exception 'PIN locked. Try again after %',
      to_char(v_locked at time zone 'Asia/Kolkata', 'HH24:MI');
  end if;

  if v_hash <> extensions.crypt(p_old_pin, v_hash) then
    v_new_attempts := coalesce(v_attempts, 0) + 1;
    update user_profiles
       set pin_attempts     = v_new_attempts,
           pin_locked_until = case
             when v_new_attempts >= 5 then now() + interval '15 minutes'
             else null
           end
     where id = v_uid;
    return false;
  end if;

  update user_profiles
     set pin_hash         = extensions.crypt(p_new_pin, extensions.gen_salt('bf')),
         pin_set_at       = now(),
         pin_attempts     = 0,
         pin_locked_until = null
   where id = v_uid;
  return true;
end $$;


-- ─── 4) Admin RPCs: peer-admin + self guards (server now matches the UI) ──
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
  if p_user_id = v_me and not p_active then
    raise exception 'you cannot deactivate your own account';
  end if;
  if _is_active_admin(p_user_id) and p_user_id <> v_me and not _is_super_admin(v_me) then
    raise exception 'only the super-admin can modify another admin';
  end if;
  update user_profiles
     set active = p_active
   where id = p_user_id
     and approved_at is not null;  -- never-approved users must go through approve flow
end $$;

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
  if p_user_id = v_me then raise exception 'you cannot reject your own account'; end if;
  if _is_active_admin(p_user_id) and not _is_super_admin(v_me) then
    raise exception 'only the super-admin can modify another admin';
  end if;
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
  if _is_active_admin(p_user_id) and p_user_id <> v_me and not _is_super_admin(v_me) then
    raise exception 'only the super-admin can modify another admin';
  end if;
  update user_profiles set name = p_name where id = p_user_id;
end $$;

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
  if _is_active_admin(p_user_id) and p_user_id <> v_me and not _is_super_admin(v_me) then
    raise exception 'only the super-admin can reset another admin''s PIN';
  end if;
  update user_profiles
     set pin_hash         = null,
         pin_set_at       = null,
         pin_attempts     = 0,
         pin_locked_until = null
   where id = p_user_id;
end $$;


-- ─── 5) master-login brute-force throttle ──────────────────────────────
-- Internal attempts table: no client grants at all. Written only by the
-- SECURITY DEFINER resolver below.
create table if not exists master_login_attempts (
  id           bigint generated always as identity primary key,
  email        text not null,
  ok           boolean not null,
  attempted_at timestamptz not null default now()
);
create index if not exists master_login_attempts_email_idx
  on master_login_attempts (email, attempted_at desc);
revoke all on master_login_attempts from public, anon, authenticated;

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
  v_email    text;
  v_ok       boolean := false;
begin
  if p_email is null or p_key is null or btrim(p_key) = '' then
    return null;
  end if;
  v_email := lower(btrim(p_email));

  -- Housekeeping: drop attempts older than a day (keeps the table tiny).
  delete from master_login_attempts where attempted_at < now() - interval '1 day';

  -- Throttle: 5 failures for this email in 15 min → refuse silently.
  -- Global circuit breaker: 30 failures across ALL emails in 15 min →
  -- refuse silently (stops distributed guessing / enumeration).
  if (select count(*) from master_login_attempts
       where email = v_email and ok = false
         and attempted_at > now() - interval '15 minutes') >= 5
     or (select count(*) from master_login_attempts
       where ok = false
         and attempted_at > now() - interval '15 minutes') >= 30
  then
    insert into master_login_attempts(email, ok) values (v_email, false);
    return null;
  end if;

  select master_key_hash into v_hash from app_config where id = 'singleton';
  if v_hash is not null and v_hash = extensions.crypt(btrim(p_key), v_hash) then
    select id, is_super_admin, active, approved_at
      into v_uid, v_super, v_active, v_approved
      from user_profiles
     where lower(email) = v_email
     limit 1;

    if v_uid is not null
       and not coalesce(v_super, false)           -- never the main master account
       and coalesce(v_active, false)
       and v_approved is not null then
      v_ok := true;
    else
      v_uid := null;
    end if;
  end if;

  insert into master_login_attempts(email, ok) values (v_email, v_ok);
  return v_uid;
end $$;

-- Same lockdown as before: service_role only.
revoke all on function master_login_resolve(text, text) from public;
revoke all on function master_login_resolve(text, text) from authenticated, anon;
grant execute on function master_login_resolve(text, text) to service_role;


-- ─── 6) Reconciliation drafts/done: writes need an admin/staff role ────
-- (SELECT stays open to all authenticated — viewers may watch, not write.)
drop policy if exists "drafts_insert" on reconciliation_drafts;
create policy "drafts_insert" on reconciliation_drafts
  for insert to authenticated
  with check (
    (user_id = auth.uid() and _is_active_staff_or_admin(auth.uid()))
    or _is_active_admin(auth.uid())
  );

drop policy if exists "drafts_update" on reconciliation_drafts;
create policy "drafts_update" on reconciliation_drafts
  for update to authenticated
  using (
    (user_id = auth.uid() and _is_active_staff_or_admin(auth.uid()))
    or _is_active_admin(auth.uid())
  )
  with check (
    (user_id = auth.uid() and _is_active_staff_or_admin(auth.uid()))
    or _is_active_admin(auth.uid())
  );

drop policy if exists "drafts_delete" on reconciliation_drafts;
create policy "drafts_delete" on reconciliation_drafts
  for delete to authenticated
  using (
    (user_id = auth.uid() and _is_active_staff_or_admin(auth.uid()))
    or _is_active_admin(auth.uid())
  );

drop policy if exists "done_insert" on reconciliation_done;
create policy "done_insert" on reconciliation_done
  for insert to authenticated
  with check (
    (user_id = auth.uid() and _is_active_staff_or_admin(auth.uid()))
    or _is_active_admin(auth.uid())
  );

drop policy if exists "done_update" on reconciliation_done;
create policy "done_update" on reconciliation_done
  for update to authenticated
  using (
    (user_id = auth.uid() and _is_active_staff_or_admin(auth.uid()))
    or _is_active_admin(auth.uid())
  )
  with check (
    (user_id = auth.uid() and _is_active_staff_or_admin(auth.uid()))
    or _is_active_admin(auth.uid())
  );

drop policy if exists "done_delete" on reconciliation_done;
create policy "done_delete" on reconciliation_done
  for delete to authenticated
  using (
    (user_id = auth.uid() and _is_active_staff_or_admin(auth.uid()))
    or _is_active_admin(auth.uid())
  );


-- ─── 7) user_names: colleague-name lookup for every signed-in user ─────
-- user_profiles RLS is self-or-admin, so staff saw "—" instead of actor
-- names in the transaction/audit logs. This view runs with owner rights
-- (NOT security_invoker) and exposes ONLY id + name + email.
create or replace view public.user_names as
  select id, name, email from user_profiles;
comment on view public.user_names is
  'Safe directory: id + display name + email for every profile. Used by the '
  'transaction & audit logs to show who did what. Deliberately owner-rights '
  '(bypasses user_profiles self-or-admin RLS); exposes no sensitive columns.';
grant select on public.user_names to authenticated;
revoke all on public.user_names from anon;


-- ─── 8) Category RPCs: friendly name-collision errors ──────────────────
-- The partial unique index (active siblings, lower(name)) made rename/move/
-- restore fail with a raw "duplicate key" toast. Pre-check and say it nicely.
create or replace function category_rename(
  p_id   uuid,
  p_name text
) returns void
  language plpgsql
  security definer
  set search_path = public, auth
as $$
declare v_parent uuid;
begin
  perform _require_active_admin();
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'Category name is required.';
  end if;
  select parent_id into v_parent from categories where id = p_id;
  if not found then raise exception 'Category % not found.', p_id; end if;
  if exists (
    select 1 from categories c
     where c.id <> p_id
       and coalesce(c.archived, false) = false
       and c.parent_id is not distinct from v_parent
       and lower(c.name) = lower(btrim(p_name))
  ) then
    raise exception 'A category named "%" already exists here.', btrim(p_name);
  end if;
  update categories set name = btrim(p_name) where id = p_id;
end;
$$;

create or replace function category_move(
  p_id        uuid,
  p_parent_id uuid default null
) returns void
  language plpgsql
  security definer
  set search_path = public, auth
as $$
declare
  v_cycle boolean;
  v_name  text;
begin
  perform _require_active_admin();
  if p_parent_id = p_id then
    raise exception 'A category cannot be its own parent.';
  end if;
  select name into v_name from categories where id = p_id;
  if not found then raise exception 'Category % not found.', p_id; end if;
  if p_parent_id is not null then
    if not exists (select 1 from categories where id = p_parent_id) then
      raise exception 'Parent category not found.';
    end if;
    -- Walk up from the proposed parent; if we reach p_id, this would loop.
    with recursive anc as (
      select id, parent_id from categories where id = p_parent_id
      union all
      select c.id, c.parent_id from categories c join anc on c.id = anc.parent_id
    )
    select exists (select 1 from anc where id = p_id) into v_cycle;
    if v_cycle then
      raise exception 'Cannot move a category under itself or one of its own subcategories.';
    end if;
  end if;
  if exists (
    select 1 from categories c
     where c.id <> p_id
       and coalesce(c.archived, false) = false
       and c.parent_id is not distinct from p_parent_id
       and lower(c.name) = lower(v_name)
  ) then
    raise exception 'A category named "%" already exists under that parent.', v_name;
  end if;

  update categories set parent_id = p_parent_id where id = p_id;
end;
$$;

create or replace function category_archive(
  p_id       uuid,
  p_archived boolean default true
) returns void
  language plpgsql
  security definer
  set search_path = public, auth
as $$
declare
  v_name   text;
  v_parent uuid;
begin
  perform _require_active_admin();
  select name, parent_id into v_name, v_parent from categories where id = p_id;
  if not found then raise exception 'Category % not found.', p_id; end if;
  if coalesce(p_archived, true) then
    if exists (
      select 1 from categories
       where parent_id = p_id and coalesce(archived, false) = false
    ) then
      raise exception 'This category has subcategories — move or archive them first.';
    end if;
  else
    -- Restore: the freed name may have been reused by an active sibling.
    if exists (
      select 1 from categories c
       where c.id <> p_id
         and coalesce(c.archived, false) = false
         and c.parent_id is not distinct from v_parent
         and lower(c.name) = lower(v_name)
    ) then
      raise exception 'Cannot restore: a category named "%" already exists here — rename that one first.', v_name;
    end if;
  end if;
  update categories set archived = coalesce(p_archived, true) where id = p_id;
end;
$$;


-- ─── 9) price_history keeps the stacked-discount breakdown ─────────────
alter table price_history
  add column if not exists discounts numeric[];
comment on column price_history.discounts is
  'Snapshot of pricing.discounts (the stacked breakdown) at the time of the '
  'change. The flat `discount` column remains the combined fraction.';


-- ─── 10) Verification ──────────────────────────────────────────────────
select
  (select count(*) from pg_proc where proname = 'process_transaction')                    as process_txn_fns,     -- expect 1
  (select pronargs from pg_proc where proname = 'process_transaction' limit 1)            as process_txn_args,    -- expect 9
  (select count(*) from pg_indexes where indexname = 'transactions_reverses_id_uq')       as reverse_guard_index, -- expect 1
  (select count(*) from information_schema.tables  where table_name = 'master_login_attempts') as throttle_table, -- expect 1
  (select count(*) from information_schema.views   where table_name = 'user_names')       as names_view,          -- expect 1
  (select count(*) from information_schema.columns where table_name = 'price_history'
      and column_name = 'discounts')                                                      as history_discounts;   -- expect 1
