-- Reconciliation integrity check — did the 60-item commit land cleanly,
-- and were there any double-applied adjustments after the godown_t error?
--
-- Read-only. Run in Supabase SQL Editor and share the output.
--
-- Background: the first "Make adjustments" run fired the Adjustment
-- transactions (moving the totals) but then failed at the split-sync
-- step (godown_t cast bug), so drafts were kept. A later run after the
-- fix should have: seen delta = 0 (totals already at target), logged NO
-- new adjustment, fixed the cases/loose split, and deleted the drafts.
--
-- The danger we're checking for is a DOUBLE-COUNT: the same (item,
-- godown) getting two Reconciliation adjustments, which would have moved
-- the total twice.

-- 1) Are any drafts still pending? (0 = everything committed & cleaned)
select '1. drafts remaining' as check_name,
       count(*) as value
  from reconciliation_drafts;

-- 2) DOUBLE-COUNT DETECTOR — any (item, godown, day) with more than one
--    Reconciliation adjustment. ANY ROWS HERE = a delta was applied more
--    than once and the total is wrong for that item/godown. Expect 0 rows.
select '2. double-applied (item, godown, day) — expect 0 rows' as check_name,
       t.item_id,
       i.brand, i.model, i.size,
       t.godown,
       t.txn_date,
       count(*)              as adjustment_count,
       array_agg(t.qty * t.direction order by t.created_at) as signed_qtys
  from transactions t
  join items i on i.id = t.item_id
 where t.reason like 'Reconciliation%'
 group by t.item_id, i.brand, i.model, i.size, t.godown, t.txn_date
having count(*) > 1
 order by adjustment_count desc, i.model;

-- 3) Summary of all Reconciliation adjustments: how many fired, over how
--    many items, on what dates. (1 adjustment per changed item-godown is
--    normal.)
select '3. reconciliation adjustments summary' as check_name,
       count(*)                        as total_adjustments,
       count(distinct t.item_id)       as distinct_items,
       count(distinct (t.item_id, t.godown)) as distinct_item_godowns,
       min(t.txn_date)                 as first_date,
       max(t.txn_date)                 as last_date
  from transactions t
 where t.reason like 'Reconciliation%';

-- 4) Per-day breakdown so you can see if there were two separate runs
--    (e.g. the failed first attempt + the successful retry) and how many
--    adjustments each produced.
select '4. reconciliation adjustments by day' as check_name,
       t.txn_date,
       count(*)                  as adjustments,
       sum(t.qty * t.direction)  as net_pieces
  from transactions t
 where t.reason like 'Reconciliation%'
 group by t.txn_date
 order by t.txn_date;

-- 5) Sanity: any negative stock anywhere? (should never happen)
select '5. negative stock rows — expect 0' as check_name,
       count(*) as value
  from godown_stock
 where cases < 0 or loose < 0;
