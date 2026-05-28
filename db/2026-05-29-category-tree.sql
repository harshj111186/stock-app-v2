-- Category tree — unlimited-depth nesting
--
-- `categories` was a flat list (id, name, normalised_name, hsn_code, gst_rate,
-- archived). This adds a self-referential parent_id so categories can nest to
-- any depth (e.g. Company > Fans > Ceiling > Premium), plus admin-gated CRUD
-- RPCs to build and reshape the tree from the new /categories manager.
--
-- DELIBERATELY NOT touching the existing UNIQUE on name / normalised_name.
-- Keeping category names globally unique is a safe, low-risk choice for a
-- single shop and avoids dropping/recreating constraints on a live table. If
-- you ever need the same child name under two different parents, that's a
-- small follow-up migration (swap to a per-parent unique).
--
-- Existing rows are untouched: parent_id defaults NULL, so every current
-- category simply becomes a top-level node. Nothing re-parents itself.
--
-- Safe to run repeatedly. Run once in Supabase Dashboard -> SQL Editor.

-- ── 1. Columns ──────────────────────────────────────────────────────────────
alter table categories
  add column if not exists parent_id  uuid references categories(id) on delete restrict,
  add column if not exists sort_order int not null default 0;

create index if not exists categories_parent_idx on categories (parent_id);

-- ── 2. Admin guard (idempotent; also defined in the item-CRUD migration) ────
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
    raise exception 'Only an active admin can manage categories (got role=%)', coalesce(v_role, 'none');
  end if;
end;
$$;

-- ── 3. CRUD RPCs ────────────────────────────────────────────────────────────

-- Create a category, optionally under a parent. Returns the new id.
create or replace function category_create(
  p_name      text,
  p_parent_id uuid default null
) returns uuid
  language plpgsql
  security definer
  set search_path = public, auth
as $$
declare
  v_id uuid;
begin
  perform _require_active_admin();
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'Category name is required.';
  end if;
  if p_parent_id is not null and not exists (select 1 from categories where id = p_parent_id) then
    raise exception 'Parent category not found.';
  end if;

  insert into categories (name, parent_id)
  values (btrim(p_name), p_parent_id)
  returning id into v_id;
  return v_id;
end;
$$;

-- Rename a category.
create or replace function category_rename(
  p_id   uuid,
  p_name text
) returns void
  language plpgsql
  security definer
  set search_path = public, auth
as $$
begin
  perform _require_active_admin();
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'Category name is required.';
  end if;
  update categories set name = btrim(p_name) where id = p_id;
  if not found then raise exception 'Category % not found.', p_id; end if;
end;
$$;

-- Re-parent a category. Rejects cycles (a node can't move under itself or any
-- of its own descendants). Pass NULL to make it a top-level node.
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
begin
  perform _require_active_admin();
  if p_parent_id = p_id then
    raise exception 'A category cannot be its own parent.';
  end if;
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

  update categories set parent_id = p_parent_id where id = p_id;
  if not found then raise exception 'Category % not found.', p_id; end if;
end;
$$;

-- Archive (soft-delete) / restore. Blocks archiving a node that still has
-- non-archived children, so the tree never shows orphaned branches — move or
-- archive the children first. Items pointing at an archived category keep
-- working; the category just disappears from the picker/manager.
create or replace function category_archive(
  p_id       uuid,
  p_archived boolean default true
) returns void
  language plpgsql
  security definer
  set search_path = public, auth
as $$
begin
  perform _require_active_admin();
  if coalesce(p_archived, true) and exists (
    select 1 from categories
     where parent_id = p_id and coalesce(archived, false) = false
  ) then
    raise exception 'This category has subcategories — move or archive them first.';
  end if;
  update categories set archived = coalesce(p_archived, true) where id = p_id;
  if not found then raise exception 'Category % not found.', p_id; end if;
end;
$$;

grant execute on function category_create(text, uuid) to authenticated;
grant execute on function category_rename(uuid, text) to authenticated;
grant execute on function category_move(uuid, uuid) to authenticated;
grant execute on function category_archive(uuid, boolean) to authenticated;

-- ── 4. Smoke check ──────────────────────────────────────────────────────────
select 'category tree ready' as status,
       (select count(*) from categories where coalesce(archived, false) = false) as categories,
       (select count(*) from categories where parent_id is not null) as nested;
