-- FIX: apply_reconciliation → "process_transaction(...) does not exist".
--
-- Root cause (the "godown_t cast bug"): apply_reconciliation called
--   process_transaction(p_item_id, 'Adjustment', p_godown, ...)
-- passing p_godown as TEXT into process_transaction's godown_t ENUM
-- parameter (and 'Adjustment' similarly). Inside PL/pgSQL, Postgres does NOT
-- implicitly cast text → enum during function-overload resolution, so it
-- couldn't find a matching process_transaction and raised
--   function process_transaction(uuid, unknown, text, integer, date, text, integer) does not exist
-- The Transactions page works because PostgREST casts JSON → the enum types
-- for it; an internal `perform` gets no such help.
--
-- The error fired BEFORE the godown_stock split was written, so the Edit-stock
-- modal only applied the case-size change and the typed quantities never
-- landed (you saw stale values after refresh). Setting everything to 0 only
-- "worked" when the delta happened to be 0 and the failing call was skipped.
--
-- Fix: cast the arguments to the enum types in the internal call. Behaviour is
-- otherwise unchanged — apply_reconciliation still sets the ABSOLUTE physical
-- count the user typed and logs one Adjustment per godown when the total moved.
--
-- Safe to run repeatedly (create or replace). Run once in Supabase → SQL Editor.

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
  -- Role gate: active admin OR active staff.
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

  -- Row-lock the godown_stock row (treat missing as 0/0).
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

  -- Log an Adjustment when (and only when) the piece total actually moved.
  -- *** THE FIX *** — cast text → enum so the internal call resolves.
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

  -- Force the split to the absolute values the user typed (overrides whatever
  -- split process_transaction chose), so the end state matches the paper count.
  insert into godown_stock (item_id, godown, cases, loose)
  values (p_item_id, p_godown::godown_t, p_target_cases, p_target_loose)
  on conflict (item_id, godown)
  do update set cases = excluded.cases, loose = excluded.loose;

  return v_delta;
end;
$$;

grant execute on function apply_reconciliation(uuid, text, int, int, text) to authenticated;

select 'apply_reconciliation cast fix applied' as status;
