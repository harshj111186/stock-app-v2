-- Reconciliation integrity check (unified output) — did the 60-item
-- commit land cleanly, and were any adjustments double-applied after the
-- godown_t error? Read-only. Returns ONE table so Supabase shows it all.
--
-- The decisive row is "double-applied item-godown-days": it must be 0.
-- Anything > 0 means a delta moved a total twice and needs correcting.

with
drafts_left as (
  select count(*)::int c from reconciliation_drafts
),
recon as (
  select t.item_id, t.godown, t.txn_date, t.qty, t.direction, t.created_at
    from transactions t
   -- The audit text lives in `note` (process_transaction maps its reason
   -- param there); `reason` is never written, so filtering on it returned
   -- 0 rows and the double-applied check below could never fire.
   where t.note like 'Reconciliation%'
),
dbl as (  -- (item, godown, day) groups that got more than one adjustment
  select item_id, godown, txn_date, count(*) c
    from recon
   group by item_id, godown, txn_date
  having count(*) > 1
),
neg as (
  select count(*)::int c from godown_stock where cases < 0 or loose < 0
),
days as (
  select count(distinct txn_date)::int c from recon
)
select 1 as ord,
       'drafts still pending (expect 0)' as check_name,
       (select c from drafts_left)::text as value
union all
select 2,
       'DOUBLE-APPLIED item-godown-days (MUST be 0)',
       (select count(*) from dbl)::text
union all
select 3,
       'total reconciliation adjustments',
       (select count(*) from recon)::text
union all
select 4,
       'distinct items reconciled',
       (select count(distinct item_id) from recon)::text
union all
select 5,
       'distinct item-godown pairs reconciled',
       (select count(distinct (item_id, godown)) from recon)::text
union all
select 6,
       'days adjustments were made on',
       (select c from days)::text
union all
select 7,
       'negative stock rows (expect 0)',
       (select c from neg)::text
order by ord;
