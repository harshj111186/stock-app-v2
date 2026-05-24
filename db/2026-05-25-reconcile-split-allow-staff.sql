-- Expand reconcile_stock_split to allow active staff, not just admin.
--
-- The reconciliation page is admin-only at the UI layer, but the items
-- "Edit stock" modal also needs to force the cases/loose split for both
-- admin and staff edits (staff use it to fix small discrepancies during
-- daily work). Page-level guards still gate "who sees what"; the RPC
-- just needs to accept either role.
--
-- Safe to run repeatedly. Run once in Supabase Dashboard → SQL Editor.

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

  insert into godown_stock (item_id, godown, cases, loose)
  values (p_item_id, p_godown, p_cases, p_loose)
  on conflict (item_id, godown)
  do update set cases = excluded.cases, loose = excluded.loose;
end;
$$;

select 'reconcile_stock_split now accepts staff' as status;
