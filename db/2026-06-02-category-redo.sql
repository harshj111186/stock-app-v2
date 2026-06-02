-- Category system redo — one source of truth: the category tree
-- ============================================================================
-- The catalogue had TWO parallel ways to categorise an item:
--   1. items.category_id  → a node in the nestable `categories` tree
--   2. items.subcategory  → a free-text string on the item
-- The items page grouped by BOTH (tree path + the free-text string), which
-- caused two bugs the owner hit:
--   • "Subcategory" was shown as optional but behaved like a required/real
--     axis, and category names carried a GLOBAL unique constraint, making the
--     whole thing brittle.
--   • Re-assigning an item re-created a SEPARATE subcategory even when one of
--     the same name already existed — because free text has no dedupe / link.
--
-- This migration makes the TREE the single source of truth. A "subcategory" is
-- just a deeper node. It:
--   1. Switches category-name uniqueness from GLOBAL to PER-PARENT, so the same
--      sub-name (e.g. "Modular", "Premium") can exist under different parents —
--      which is what real deep categorisation needs — while still preventing a
--      true duplicate (same name, same parent).
--   2. Makes category_create a GET-OR-CREATE: asking for a child that already
--      exists under that parent returns the existing one (and un-archives it)
--      instead of erroring or duplicating.
--   3. Adds set_items_category(uuid[], uuid) so items can be moved between
--      categories in bulk (admin only).
--   4. Folds every existing items.subcategory value into the tree as a child
--      node and clears the free-text column, so nothing is lost and everything
--      lines up under one hierarchy.
--
-- Idempotent / safe to run repeatedly. Run once in Supabase -> SQL Editor.

-- ── 1. Per-parent uniqueness ────────────────────────────────────────────────
-- Drop the legacy GLOBAL unique constraints/indexes on categories (they were on
-- name / normalised_name) and replace them with a per-parent unique index on a
-- case-insensitive name. NULL parent (top-level) is treated as a fixed sentinel
-- so two top-level categories still can't share a name. Archived rows are
-- excluded so an archived "ghost" never blocks reusing the name.
do $$
declare r record;
begin
  -- 1a. drop every UNIQUE *constraint* on public.categories (keeps the PK).
  for r in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public' and rel.relname = 'categories' and con.contype = 'u'
  loop
    execute format('alter table public.categories drop constraint %I', r.conname);
  end loop;

  -- 1b. drop any standalone UNIQUE *index* (not the PK, not our new one).
  for r in
    select idx.relname as idxname
      from pg_index x
      join pg_class idx on idx.oid = x.indexrelid
      join pg_class tbl on tbl.oid = x.indrelid
      join pg_namespace nsp on nsp.oid = tbl.relnamespace
     where nsp.nspname = 'public' and tbl.relname = 'categories'
       and x.indisunique and not x.indisprimary
       and idx.relname <> 'categories_parent_name_uq'
  loop
    execute format('drop index if exists public.%I', r.idxname);
  end loop;
end $$;

create unique index if not exists categories_parent_name_uq
  on public.categories (
    coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(name)
  )
  where coalesce(archived, false) = false;

-- ── 2. category_create → get-or-create ──────────────────────────────────────
create or replace function category_create(
  p_name      text,
  p_parent_id uuid default null
) returns uuid
  language plpgsql
  security definer
  set search_path = public, auth
as $$
declare
  v_id  uuid;
  v_nm  text := btrim(p_name);
begin
  perform _require_active_admin();
  if coalesce(v_nm, '') = '' then
    raise exception 'Category name is required.';
  end if;
  if p_parent_id is not null and not exists (select 1 from categories where id = p_parent_id) then
    raise exception 'Parent category not found.';
  end if;

  -- Reuse a sibling with the same (case-insensitive) name — non-archived first.
  select id into v_id
    from categories
   where coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid)
       = coalesce(p_parent_id, '00000000-0000-0000-0000-000000000000'::uuid)
     and lower(name) = lower(v_nm)
   order by coalesce(archived, false)
   limit 1;

  if v_id is not null then
    update categories set archived = false
     where id = v_id and coalesce(archived, false) = true;
    return v_id;
  end if;

  insert into categories (name, parent_id) values (v_nm, p_parent_id) returning id into v_id;
  return v_id;
end;
$$;

grant execute on function category_create(text, uuid) to authenticated;

-- ── 3. Bulk move items between categories ───────────────────────────────────
-- Repoints any number of items at one category node (or NULL = uncategorised),
-- keeps the legacy `category` text column in sync, and clears the obsolete
-- free-text subcategory. Returns the number of items moved.
create or replace function set_items_category(
  p_item_ids   uuid[],
  p_category_id uuid default null
) returns int
  language plpgsql
  security definer
  set search_path = public, auth
as $$
declare
  v_cat text;
  v_n   int;
begin
  perform _require_active_admin();
  if p_item_ids is null or array_length(p_item_ids, 1) is null then
    return 0;
  end if;
  if p_category_id is not null then
    select name into v_cat from categories where id = p_category_id;
    if v_cat is null then
      raise exception 'Target category not found.';
    end if;
  end if;

  update items
     set category_id = p_category_id,
         category    = v_cat,
         subcategory = null
   where id = any(p_item_ids);

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

grant execute on function set_items_category(uuid[], uuid) to authenticated;

-- ── 4. Fold legacy free-text subcategories into the tree ────────────────────
-- For each item that still has a free-text subcategory, ensure a child category
-- of that name exists under the item's current category (or as a top-level node
-- when the item has no category), repoint the item at it, and clear the text.
-- Runs as the table owner, so it inlines the get-or-create (category_create's
-- admin check is for the authenticated client, not this maintenance block).
do $$
declare
  it      record;
  v_child uuid;
begin
  for it in
    select id, category_id, btrim(subcategory) as sub
      from items
     where coalesce(btrim(subcategory), '') <> ''
  loop
    select id into v_child
      from categories
     where coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = coalesce(it.category_id, '00000000-0000-0000-0000-000000000000'::uuid)
       and lower(name) = lower(it.sub)
       and coalesce(archived, false) = false
     limit 1;

    if v_child is null then
      insert into categories (name, parent_id)
      values (it.sub, it.category_id)
      returning id into v_child;
    end if;

    update items
       set category_id = v_child,
           category    = (select name from categories where id = v_child),
           subcategory = null
     where id = it.id;
  end loop;
end $$;

-- ── 5. Smoke check ──────────────────────────────────────────────────────────
select 'category redo ready' as status,
       (select count(*) from categories where coalesce(archived, false) = false) as categories,
       (select count(*) from categories where parent_id is not null)             as nested,
       (select count(*) from items where coalesce(btrim(subcategory), '') <> '') as items_with_legacy_subcat;
