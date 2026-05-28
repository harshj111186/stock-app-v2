-- Item create / update / archive RPCs
--
-- The v2 catalogue page could VIEW items and override stock, but had no way
-- to ADD a new item, EDIT its attributes, or ARCHIVE it. These three
-- SECURITY DEFINER functions add that, gated to active admins (catalogue
-- management is an owner task; staff continue to use the stock-override flow
-- for day-to-day quantity fixes).
--
-- Why RPCs and not direct table writes: items has RLS, and routing privileged
-- writes through SECURITY DEFINER functions is the established pattern in this
-- project (process_transaction, reconcile_stock_split, admin_*). One function
-- = one audited, role-checked entry point, and the client never needs broad
-- table grants.
--
-- New items are global by design: an item exists for BOTH godowns the moment
-- it's created. We deliberately DON'T seed godown_stock rows — "never stocked
-- here" stays distinct from "stocked and ran out", and the first Purchase /
-- Adjustment creates the row via process_transaction. The catalogue, godown,
-- and reconciliation pages already show every item in both godowns.
--
-- Safe to run repeatedly. Run once in Supabase Dashboard -> SQL Editor.

-- ── helper: am I an active admin? ──────────────────────────────────────────
-- Mirrors the inline check used elsewhere; kept as a small local helper so the
-- three functions below stay readable.
create or replace function _require_active_admin()
  returns void
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
  if v_role is null or v_role <> 'admin' then
    raise exception 'Only an active admin can manage the catalogue (got role=%)', coalesce(v_role, 'none');
  end if;
end;
$$;

-- ── create_item ────────────────────────────────────────────────────────────
-- Returns the new item's id. item_code is auto-generated when blank so the
-- user never has to invent one. Keeps the legacy `category` text column in
-- sync with category_id for any reader still using it.
create or replace function create_item(
  p_model            text,
  p_brand            text default null,
  p_category_id      uuid default null,
  p_subcategory      text default null,
  p_size             text default null,
  p_colour           text default null,
  p_case_size        int  default 0,
  p_hsn_code         text default null,
  p_gst_rate         numeric default null,
  p_reorder_point_a  int  default 0,
  p_reorder_point_b  int  default 0,
  p_item_code        text default null
) returns uuid
  language plpgsql
  security definer
  set search_path = public, auth
as $$
declare
  v_id   uuid;
  v_code text;
  v_cat  text;
begin
  perform _require_active_admin();

  if coalesce(btrim(p_model), '') = '' then
    raise exception 'Model is required.';
  end if;

  v_code := nullif(btrim(coalesce(p_item_code, '')), '');
  if v_code is null then
    v_code := 'IT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  end if;

  -- Resolve the category name for the legacy text column (best effort).
  if p_category_id is not null then
    select name into v_cat from categories where id = p_category_id;
  end if;

  insert into items (
    item_code, brand, category_id, category, subcategory, model, size, colour,
    case_size, hsn_code, gst_rate, reorder_point_a, reorder_point_b, archived
  ) values (
    v_code,
    nullif(btrim(coalesce(p_brand, '')), ''),
    p_category_id,
    v_cat,
    nullif(btrim(coalesce(p_subcategory, '')), ''),
    btrim(p_model),
    coalesce(nullif(btrim(coalesce(p_size, '')), ''), ''),
    coalesce(nullif(btrim(coalesce(p_colour, '')), ''), ''),
    greatest(coalesce(p_case_size, 0), 0),
    nullif(btrim(coalesce(p_hsn_code, '')), ''),
    p_gst_rate,
    greatest(coalesce(p_reorder_point_a, 0), 0),
    greatest(coalesce(p_reorder_point_b, 0), 0),
    false
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- ── update_item ────────────────────────────────────────────────────────────
-- Updates catalogue attributes. Quantity is NOT touched here — stock changes
-- always go through process_transaction / reconcile_stock_split.
create or replace function update_item(
  p_item_id          uuid,
  p_model            text,
  p_brand            text default null,
  p_category_id      uuid default null,
  p_subcategory      text default null,
  p_size             text default null,
  p_colour           text default null,
  p_case_size        int  default 0,
  p_hsn_code         text default null,
  p_gst_rate         numeric default null,
  p_reorder_point_a  int  default 0,
  p_reorder_point_b  int  default 0
) returns void
  language plpgsql
  security definer
  set search_path = public, auth
as $$
declare
  v_cat text;
begin
  perform _require_active_admin();

  if coalesce(btrim(p_model), '') = '' then
    raise exception 'Model is required.';
  end if;

  if p_category_id is not null then
    select name into v_cat from categories where id = p_category_id;
  end if;

  update items set
    brand           = nullif(btrim(coalesce(p_brand, '')), ''),
    category_id     = p_category_id,
    category        = v_cat,
    subcategory     = nullif(btrim(coalesce(p_subcategory, '')), ''),
    model           = btrim(p_model),
    size            = coalesce(nullif(btrim(coalesce(p_size, '')), ''), ''),
    colour          = coalesce(nullif(btrim(coalesce(p_colour, '')), ''), ''),
    case_size       = greatest(coalesce(p_case_size, 0), 0),
    hsn_code        = nullif(btrim(coalesce(p_hsn_code, '')), ''),
    gst_rate        = p_gst_rate,
    reorder_point_a = greatest(coalesce(p_reorder_point_a, 0), 0),
    reorder_point_b = greatest(coalesce(p_reorder_point_b, 0), 0)
  where id = p_item_id;

  if not found then
    raise exception 'Item % not found.', p_item_id;
  end if;
end;
$$;

-- ── set_item_archived ──────────────────────────────────────────────────────
-- Soft delete / restore. We never hard-delete: an item may be referenced by
-- historical transactions, and archiving preserves the audit trail. Archived
-- items drop out of the catalogue/transaction/reconciliation lists (those
-- already filter archived = false) but stay readable for reports.
create or replace function set_item_archived(
  p_item_id  uuid,
  p_archived boolean
) returns void
  language plpgsql
  security definer
  set search_path = public, auth
as $$
begin
  perform _require_active_admin();

  update items set
    archived    = coalesce(p_archived, true),
    archived_at = case when coalesce(p_archived, true) then now() else null end
  where id = p_item_id;

  if not found then
    raise exception 'Item % not found.', p_item_id;
  end if;
end;
$$;

grant execute on function create_item(text, text, uuid, text, text, text, int, text, numeric, int, int, text) to authenticated;
grant execute on function update_item(uuid, text, text, uuid, text, text, text, int, text, numeric, int, int) to authenticated;
grant execute on function set_item_archived(uuid, boolean) to authenticated;

-- ── smoke check ────────────────────────────────────────────────────────────
select 'item CRUD RPCs ready' as status,
       (select count(*) from items where archived = false) as active_items;
