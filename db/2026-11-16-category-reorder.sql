-- Category order — let an admin put sibling categories in the order they want
-- (2026-11-16, drag-and-drop reshuffle on the Items / Categories screens).
--
-- `categories.sort_order` has existed since 2026-05-29 but nothing could write
-- it (no UPDATE policy on categories; every write goes through an admin-gated
-- SECURITY DEFINER RPC), so every tree was simply A–Z. This adds ONE RPC:
--
--   category_reorder(p_parent_id, p_ids)
--     p_ids = the children of p_parent_id (NULL = main categories) in the new
--     order; each gets sort_order = its 1-based position. Every id must
--     already sit under that parent (move it first with category_move).
--
-- Additive, idempotent (create or replace). Touches only sort_order. Stock,
-- items, names and parents are never changed by it.

create or replace function category_reorder(
  p_parent_id uuid,
  p_ids       uuid[]
) returns int
  language plpgsql
  security definer
  set search_path = public, auth
as $$
declare
  v_n int;
begin
  perform _require_active_admin();
  if p_ids is null or array_length(p_ids, 1) is null then
    return 0;
  end if;
  if exists (
    select 1 from categories c
     where c.id = any(p_ids)
       and coalesce(c.parent_id, '00000000-0000-0000-0000-000000000000'::uuid)
        <> coalesce(p_parent_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) then
    raise exception 'All categories being re-ordered must sit under the same parent.';
  end if;

  update categories c
     set sort_order = x.ord
    from unnest(p_ids) with ordinality as x(id, ord)
   where c.id = x.id;

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function category_reorder(uuid, uuid[]) from public, anon;
grant execute on function category_reorder(uuid, uuid[]) to authenticated, service_role;

select 'category_reorder ready' as status;
