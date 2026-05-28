-- Let the app actually READ categories.
--
-- Discovered while building the category tree: `select * from categories` as
-- the authenticated role returns [] (HTTP 200, zero rows) — RLS is enabled on
-- the table but there's no permissive SELECT policy, so PostgREST filters
-- everything out. The old UI never noticed because category display silently
-- falls back to the legacy `items.category` text column when the FK lookup is
-- empty; the new /categories manager (and proper FK-based category names) need
-- the real rows.
--
-- Categories are shop-wide reference data — every signed-in user should read
-- them. WRITES still go only through the admin-gated SECURITY DEFINER RPCs
-- (category_create / rename / move / archive), so opening up SELECT doesn't let
-- anyone modify the tree.
--
-- Safe to run repeatedly. Run once in Supabase Dashboard -> SQL Editor.

alter table categories enable row level security;

drop policy if exists categories_select on categories;
create policy categories_select
  on categories
  for select
  to authenticated
  using (true);

grant select on categories to authenticated;

-- After this, the app should see all of them. (This count runs as the SQL
-- editor / postgres role, which bypasses RLS — the real proof is the
-- /categories page now listing your categories instead of "0".)
select 'categories readable by authenticated' as status,
       (select count(*) from categories) as total_rows;
