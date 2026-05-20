-- Stacked discounts on pricing
--
-- Pricing previously had a single `discount` fraction. Brands often quote
-- discounts as a stack ("40% off, plus an additional 5% on top") — the
-- second discount applies to the price AFTER the first discount, not to
-- the original LP. Storing only the combined effective fraction (0.43 for
-- 40+5) loses the breakdown, so the next user looking at the row can't
-- tell how it was arrived at.
--
-- This adds a `discounts` array column that holds the breakdown. The
-- existing `discount` column stays — it's now kept in sync (by the app)
-- as the *combined effective* fraction = 1 - product(1 - d_i). That keeps
-- the dashboard's stock-value formula working without changes.
--
-- Run once in Supabase Dashboard → SQL Editor.

alter table pricing
  add column if not exists discounts numeric[] default '{}';

comment on column pricing.discounts is
  'Stacked discounts as fractions, applied multiplicatively in order. '
  'e.g. {0.40, 0.05} = 40% off, then a further 5% off the discounted price. '
  'The `discount` column is kept in sync by the app as the combined effective '
  'fraction (1 - product(1 - d_i)) so existing readers (dashboard stock value) '
  'still work without joining the array.';

-- Backfill: copy each existing single discount into the array so historical
-- rows show their breakdown (a one-element stack). Only touches rows that
-- have no array yet AND have a non-zero legacy discount.
update pricing
   set discounts = array[discount]::numeric[]
 where (discounts is null or discounts = '{}')
   and coalesce(discount, 0) > 0;
