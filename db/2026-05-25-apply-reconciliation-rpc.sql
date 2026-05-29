-- apply_reconciliation — single atomic "set absolute physical count" RPC.
--
-- The reconciliation page and the items "Edit stock" modal both think
-- in absolute terms: the user types the physical cases/loose, and the
-- end-state in godown_stock should be exactly those values. Logging the
-- piece-level delta is incidental, not the model.
--
-- Earlier we did this in two client-side calls:
--   1. process_transaction (Adjustment ± |delta|)  — for the audit log
--   2. reconcile_stock_split (upsert absolute cases/loose) — for the split
--
-- Two problems with that:
--   a) The client's delta is computed from page state, which can be
--      stale by minutes (other users, prior failed run). On retry it
--      double-counted.
--   b) Two round-trips per side, with the second one needed to clean
--      up after the first.
--
-- This RPC does both in ONE atomic transaction, with the delta computed
-- from the row-locked CURRENT godown_stock value. So:
--   - Retries are idempotent. Second click sees the already-updated row,
--     delta = 0, no Adjustment logged, no over-correction.
--   - The Adjustment audit row only appears when there's a real change.
--   - The cases/loose split always lands exactly where the user typed.
--
-- Role: active admin OR active staff. The page-level UI is the gate
-- for who can actually press "Make adjustments"; the RPC just matches.
--
-- Safe to run repeatedly. Idempotent.

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
begin
  -- Role gate.
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

  -- Row-lock the godown_stock row (or treat as 0/0 if it doesn't exist
  -- yet — first-time stock at this godown).
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

  -- Log audit row when (and only when) the piece total actually moved.
  -- Calling process_transaction keeps the audit format identical to
  -- transactions logged from anywhere else.
  if v_delta <> 0 then
    perform process_transaction(
      p_item_id,
      'Adjustment',
      p_godown,
      abs(v_delta),
      current_date,
      p_reason,
      case when v_delta > 0 then 1 else -1 end
    );
  end if;

  -- Force the split to the absolute values. process_transaction may have
  -- moved godown_stock by its own rules (cases vs loose split); override
  -- with what the user counted so end state matches paper.
  insert into godown_stock (item_id, godown, cases, loose)
  values (p_item_id, p_godown::godown_t, p_target_cases, p_target_loose)
  on conflict (item_id, godown)
  do update set cases = excluded.cases, loose = excluded.loose;

  return v_delta;
end;
$$;

grant execute on function apply_reconciliation(uuid, text, int, int, text) to authenticated;

select 'apply_reconciliation ready' as status;
