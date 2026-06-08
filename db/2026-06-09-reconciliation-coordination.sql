-- Reconciliation coordination upgrade
--
-- Adds the backend pieces behind the 2026-06-09 reconciliation rework:
--
--   1. Cross-counter visibility — every authenticated user can now READ all
--      drafts (not just their own). This powers the "also counted by …" +
--      live delta-vs-other-staff coordination in My count. Writes stay
--      locked to your own row (or admin override) exactly as before.
--
--   2. A per-user "Done" flag (reconciliation_done) — a counter marks their
--      whole count finished, which (a) freezes their entries in the UI and
--      (b) turns their BLANK on any item someone else counted into an
--      explicit "found nothing here" (= 0). That 0-vs-entered mismatch is
--      what surfaces a conflict to the reviewer, so a finished counter who
--      missed an item is flagged automatically — without flagging items the
--      other counters simply haven't reached yet.
--
--   3. reconciliation_drafts_with_user now carries each row's owner Done
--      state so the client doesn't need a second correlated fetch.
--
--   4. apply_reconciliation normalises the committed split (rolls loose that
--      meets/exceeds the case size up into cases) so stored stock stays tidy,
--      matching the same rollover the count UI now does on entry.
--
-- Idempotent — safe to run repeatedly. Run once in Supabase → SQL Editor.

-- ──────────────────────────────────────────────────────────────────────────
-- 1. Cross-counter read visibility on drafts
--    (replace the self-or-admin SELECT policy with read-to-all-authenticated;
--     INSERT/UPDATE/DELETE policies are left untouched = still own-or-admin.)
-- ──────────────────────────────────────────────────────────────────────────
drop policy if exists "drafts_select" on reconciliation_drafts;
create policy "drafts_select" on reconciliation_drafts
  for select to authenticated
  using (true);

-- ──────────────────────────────────────────────────────────────────────────
-- 2. Per-user "count done" flag
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists reconciliation_done (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  done        boolean not null default false,
  done_at     timestamptz,
  updated_at  timestamptz not null default now()
);

comment on table reconciliation_done is
  'Per-user "I have finished my physical count" flag. When done = true the '
  'user''s draft entries are frozen in the UI and any item they left blank '
  'but another counter filled is treated as a 0 (found nothing) for conflict '
  'detection. Reset to false for a user once their drafts are committed.';

create or replace function reconciliation_done_touch_updated_at()
  returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists reconciliation_done_touch on reconciliation_done;
create trigger reconciliation_done_touch
  before update on reconciliation_done
  for each row execute function reconciliation_done_touch_updated_at();

alter table reconciliation_done enable row level security;

-- Everyone authenticated can read who is done (counters coordinate; reviewer
-- needs it for conflict detection).
drop policy if exists "done_select" on reconciliation_done;
create policy "done_select" on reconciliation_done
  for select to authenticated
  using (true);

-- You may flip your own flag; an active admin may flip anyone's (used to
-- reset stale flags after a commit).
drop policy if exists "done_insert" on reconciliation_done;
create policy "done_insert" on reconciliation_done
  for insert to authenticated
  with check (
    user_id = auth.uid()
    or exists (select 1 from user_profiles up
                where up.id = auth.uid() and up.role::text = 'admin' and up.active = true)
  );

drop policy if exists "done_update" on reconciliation_done;
create policy "done_update" on reconciliation_done
  for update to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from user_profiles up
                where up.id = auth.uid() and up.role::text = 'admin' and up.active = true)
  )
  with check (
    user_id = auth.uid()
    or exists (select 1 from user_profiles up
                where up.id = auth.uid() and up.role::text = 'admin' and up.active = true)
  );

drop policy if exists "done_delete" on reconciliation_done;
create policy "done_delete" on reconciliation_done
  for delete to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from user_profiles up
                where up.id = auth.uid() and up.role::text = 'admin' and up.active = true)
  );

grant select, insert, update, delete on reconciliation_done to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 3. View: drafts + owner Done state (security_invoker → RLS still applies)
-- ──────────────────────────────────────────────────────────────────────────
create or replace view reconciliation_drafts_with_user
  with (security_invoker = true) as
select
  d.id,
  d.user_id,
  d.item_id,
  d.case_size_raw,
  d.a_cases_raw,
  d.a_loose_raw,
  d.b_cases_raw,
  d.b_loose_raw,
  d.updated_at,
  up.email                  as user_email,
  up.name                   as user_name,
  up.role::text             as user_role,
  coalesce(rd.done, false)  as user_done,
  rd.done_at                as user_done_at
from reconciliation_drafts d
left join user_profiles    up on up.id = d.user_id
left join reconciliation_done rd on rd.user_id = d.user_id;

grant select on reconciliation_drafts_with_user to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 4. apply_reconciliation — normalise the committed split.
--    Same signature/behaviour; the only change is rolling loose >= case_size
--    up into cases before storing, so godown_stock never holds e.g. 0c/3L on
--    a case size of 2 (it becomes 1c/1L). Piece total is identical, so the
--    Adjustment delta and audit trail are unchanged.
-- ──────────────────────────────────────────────────────────────────────────
create or replace function apply_reconciliation(
  p_item_id       uuid,
  p_godown        text,
  p_target_cases  int,
  p_target_loose  int,
  p_reason        text
) returns int
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_role        text;
  v_cur_cases   int;
  v_cur_loose   int;
  v_case_size   int;
  v_old_pieces  int;
  v_new_pieces  int;
  v_delta       int;
  v_store_cases int;
  v_store_loose int;
begin
  select role::text into v_role
    from user_profiles
   where id = auth.uid()
     and active = true;
  if v_role is null or v_role not in ('admin', 'staff') then
    raise exception 'Only an active admin or staff can apply reconciliation (got role=%)', v_role;
  end if;

  if p_godown not in ('A', 'B') then
    raise exception 'godown must be A or B (got %)', p_godown;
  end if;
  if coalesce(p_target_cases, 0) < 0 or coalesce(p_target_loose, 0) < 0 then
    raise exception 'target cases and loose must be >= 0 (got cases=%, loose=%)', p_target_cases, p_target_loose;
  end if;
  if coalesce(p_reason, '') = '' then
    raise exception 'reason is required for audit trail';
  end if;

  select cases, loose
    into v_cur_cases, v_cur_loose
    from godown_stock
   where item_id = p_item_id
     and godown  = p_godown::godown_t
   for update;
  v_cur_cases := coalesce(v_cur_cases, 0);
  v_cur_loose := coalesce(v_cur_loose, 0);

  select case_size into v_case_size from items where id = p_item_id;
  v_case_size := coalesce(v_case_size, 0);

  v_old_pieces := case when v_case_size > 0
                       then v_cur_cases * v_case_size + v_cur_loose
                       else v_cur_loose end;
  v_new_pieces := case when v_case_size > 0
                       then p_target_cases * v_case_size + p_target_loose
                       else p_target_loose end;
  v_delta := v_new_pieces - v_old_pieces;

  -- Normalise the split we store: roll loose >= case size up into cases.
  if v_case_size > 0 then
    v_store_cases := p_target_cases + (p_target_loose / v_case_size);  -- int div
    v_store_loose := p_target_loose % v_case_size;
  else
    v_store_cases := p_target_cases;   -- 0 in practice for loose-only items
    v_store_loose := p_target_loose;
  end if;

  if v_delta <> 0 then
    perform process_transaction(
      p_item_id,
      'Adjustment'::action_t,
      p_godown::godown_t,
      abs(v_delta),
      current_date,
      p_reason,
      (case when v_delta > 0 then 1 else -1 end)::int
    );
  end if;

  insert into godown_stock (item_id, godown, cases, loose)
  values (p_item_id, p_godown::godown_t, v_store_cases, v_store_loose)
  on conflict (item_id, godown)
  do update set cases = excluded.cases, loose = excluded.loose;

  return v_delta;
end;
$$;

grant execute on function apply_reconciliation(uuid, text, int, int, text) to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 5. Smoke checks
-- ──────────────────────────────────────────────────────────────────────────
select 'reconciliation coordination ready' as status,
       (select count(*) from reconciliation_done) as done_rows,
       (select count(*) from reconciliation_drafts) as draft_rows;
