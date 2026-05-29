-- Cast the text p_godown parameter to godown_t inside reconcile_stock_split.
--
-- godown_stock.godown is the enum `godown_t` (values 'A' / 'B'). Postgres
-- does not auto-coerce text → enum inside an INSERT VALUES list from
-- inside a SECURITY DEFINER function. Earlier versions of this RPC tried
-- it anyway and failed at runtime with:
--   column "godown" is of type godown_t but expression is of type text
--
-- This migration recreates the function with an explicit ::godown_t cast.
-- Existing reconciliation drafts are unaffected — once this runs, the
-- next "Make adjustments" click will process them cleanly. The earlier
-- Adjustment txns already moved the totals; this second pass just sets
-- the cases/loose split exactly to what was counted.
--
-- Safe to run twice. Idempotent.

create or replace function reconcile_stock_split(
  p_item_id uuid,
  p_godown  text,
  p_cases   int,
  p_loose   int
) returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_role text;
begin
  select role::text into v_role
    from user_profiles
   where id = auth.uid()
     and active = true;
  if v_role is null or v_role not in ('admin', 'staff') then
    raise exception 'Only an active admin or staff can sync the stock split (got role=%)', v_role;
  end if;

  if p_godown not in ('A', 'B') then
    raise exception 'godown must be A or B (got %)', p_godown;
  end if;
  if coalesce(p_cases, 0) < 0 or coalesce(p_loose, 0) < 0 then
    raise exception 'cases and loose must be >= 0 (got cases=%, loose=%)', p_cases, p_loose;
  end if;

  -- Explicit enum cast — godown_stock.godown is godown_t, not text.
  insert into godown_stock (item_id, godown, cases, loose)
  values (p_item_id, p_godown::godown_t, p_cases, p_loose)
  on conflict (item_id, godown)
  do update set cases = excluded.cases, loose = excluded.loose;
end;
$$;

select 'reconcile_stock_split now casts text → godown_t' as status;
