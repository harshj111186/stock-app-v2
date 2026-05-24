-- reconcile_stock_split — admin-only RPC that forces godown_stock's
-- (cases, loose) split to match the physical count from /reconciliation.
--
-- WHY THIS EXISTS
-- ---------------
-- godown_stock has RLS that blocks direct client-side writes — only
-- process_transaction (SECURITY DEFINER) is allowed to mutate it.
-- That's correct in general: every stock change should go through the
-- audit-logged transaction path.
--
-- The reconciliation flow already calls process_transaction with an
-- Adjustment for the piece-level delta — that updates the total stock
-- and records the audit row. But process_transaction settles cases vs
-- loose using its own rules (break/repack a case as needed). The
-- physical count might leave the same total of pieces but a different
-- split (e.g. counted 4 cases + 5 loose where the RPC parked 3 cases +
-- 17 loose). The user is the source of truth for the split, so we need
-- one extra deterministic write to match what they counted.
--
-- This RPC piggy-backs on the same security model: SECURITY DEFINER +
-- explicit admin check inside, so RLS no longer blocks the upsert but
-- it's still locked to active admins (matches "only admin commits" in
-- the reconciliation UI).
--
-- Safe to run twice — every step is idempotent.
-- Run once in Supabase Dashboard → SQL Editor.

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
  -- Admin gate. Matches the "only admin commits" rule in the page.
  select role::text into v_role
    from user_profiles
   where id = auth.uid()
     and active = true;
  if v_role is null or v_role <> 'admin' then
    raise exception 'Only an active admin can sync the stock split (got role=%)', v_role;
  end if;

  if p_godown not in ('A', 'B') then
    raise exception 'godown must be A or B (got %)', p_godown;
  end if;
  if coalesce(p_cases, 0) < 0 or coalesce(p_loose, 0) < 0 then
    raise exception 'cases and loose must be >= 0 (got cases=%, loose=%)', p_cases, p_loose;
  end if;

  -- Upsert. If godown is an enum, the implicit text→enum cast handles it
  -- for the valid values 'A' / 'B' that we just validated.
  insert into godown_stock (item_id, godown, cases, loose)
  values (p_item_id, p_godown, p_cases, p_loose)
  on conflict (item_id, godown)
  do update set cases = excluded.cases, loose = excluded.loose;
end;
$$;

grant execute on function reconcile_stock_split(uuid, text, int, int) to authenticated;

select 'reconcile_stock_split ready' as status;
