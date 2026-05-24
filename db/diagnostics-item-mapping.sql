-- Item-mapping integrity check (unified output)
--
-- Read-only — no writes. Returns ONE result table with every check on a
-- separate row, so Supabase SQL Editor shows them all at once. Paste the
-- full output back to confirm items map cleanly across godown_stock,
-- pricing, transactions, and reconciliation_drafts.
--
-- severity column:
--   info  — informational only
--   warn  — worth eyeballing but not necessarily a bug
--   error — should be zero; investigate before hiding item_code

with
-- ── counts ──────────────────────────────────────────────────────────────
c_items          as (select count(*)::int c from items),
c_items_active   as (select count(*)::int c from items where not archived),
c_items_archived as (select count(*)::int c from items where archived),
c_stock          as (select count(*)::int c from godown_stock),
c_txns           as (select count(*)::int c from transactions),
c_pricing        as (select count(*)::int c from pricing),
c_drafts         as (select count(*)::int c from reconciliation_drafts),
c_draft_users    as (select count(distinct user_id)::int c from reconciliation_drafts),

-- ── item_code health ────────────────────────────────────────────────────
empty_codes      as (select count(*)::int c, array_agg(id::text)              ids from items where item_code is null or trim(item_code) = ''),
dup_codes        as (select count(*)::int c, array_agg(item_code)             names from (
                       select item_code from items
                        where item_code is not null and trim(item_code) <> ''
                        group by item_code having count(*) > 1) x),

-- ── attribute-level duplicates ──────────────────────────────────────────
dup_attrs        as (select count(*)::int c, array_agg(brand || ' / ' || model || ' / ' || coalesce(size, '') || ' / ' || coalesce(colour, '')) labels from (
                       select brand, model, size, colour from items
                        where not archived
                        group by brand, model, size, colour
                       having count(*) > 1) x),

-- ── orphans (FK should make these impossible) ───────────────────────────
orphan_stock     as (select count(*)::int c from godown_stock gs          left join items i on i.id = gs.item_id where i.id is null),
orphan_txns      as (select count(*)::int c from transactions t           left join items i on i.id = t.item_id  where i.id is null),
orphan_pricing   as (select count(*)::int c from pricing p                left join items i on i.id = p.item_id  where i.id is null),
orphan_drafts    as (select count(*)::int c from reconciliation_drafts d  left join items i on i.id = d.item_id  where i.id is null),

-- ── coverage (informational) ────────────────────────────────────────────
no_stock_anywhere as (select count(*)::int c from items i
                       where not i.archived
                         and not exists (select 1 from godown_stock gs where gs.item_id = i.id)),
no_pricing       as (select count(*)::int c from items i
                       where not i.archived
                         and not exists (select 1 from pricing p where p.item_id = i.id)),
no_txns          as (select count(*)::int c from items i
                       where not i.archived
                         and not exists (select 1 from transactions t where t.item_id = i.id)),

-- ── stock-vs-transactions gap ───────────────────────────────────────────
stock_vs_txn as (
  with stock_pieces as (
    select gs.item_id, gs.godown,
           (gs.cases * coalesce(i.case_size, 0) + gs.loose) as stock_pcs
      from godown_stock gs join items i on i.id = gs.item_id
  ),
  txn_sums as (
    select item_id, godown, sum(qty * direction)::int as net_pcs
      from transactions group by item_id, godown
  )
  select count(*)::int c, sum(abs(coalesce(s.stock_pcs, 0) - coalesce(t.net_pcs, 0)))::int total_gap
    from stock_pieces s
    full outer join txn_sums t on t.item_id = s.item_id and t.godown = s.godown
   where coalesce(s.stock_pcs, 0) <> coalesce(t.net_pcs, 0)
)

select 1  as ord, 'items total'              as check_name, c_items.c::text          as value, 'info'  as severity, ''::text as detail from c_items
union all select 2,  'items active',                   c_items_active.c::text,   'info',  ''      from c_items_active
union all select 3,  'items archived',                 c_items_archived.c::text, 'info',  ''      from c_items_archived
union all select 4,  'godown_stock rows',              c_stock.c::text,          'info',  ''      from c_stock
union all select 5,  'transactions rows',              c_txns.c::text,           'info',  ''      from c_txns
union all select 6,  'pricing rows',                   c_pricing.c::text,        'info',  ''      from c_pricing
union all select 7,  'reconciliation drafts',          c_drafts.c::text,         'info',  ''      from c_drafts
union all select 8,  'distinct users with drafts',     c_draft_users.c::text,    'info',  ''      from c_draft_users
union all select 9,  'items with empty item_code',     empty_codes.c::text,
                                                      case when empty_codes.c=0 then 'ok' else 'error' end,
                                                      coalesce(array_to_string(empty_codes.ids, ', '), '')
                                                      from empty_codes
union all select 10, 'duplicate item_codes',           dup_codes.c::text,
                                                      case when dup_codes.c=0 then 'ok' else 'error' end,
                                                      coalesce(array_to_string(dup_codes.names, ', '), '')
                                                      from dup_codes
union all select 11, 'duplicate brand+model+size+colour', dup_attrs.c::text,
                                                      case when dup_attrs.c=0 then 'ok' else 'warn' end,
                                                      coalesce(array_to_string((select array_agg(x) from unnest(dup_attrs.labels) x limit 10), ' | '), '')
                                                      from dup_attrs
union all select 12, 'orphan godown_stock rows',       orphan_stock.c::text,
                                                      case when orphan_stock.c=0 then 'ok' else 'error' end,
                                                      ''      from orphan_stock
union all select 13, 'orphan transactions',            orphan_txns.c::text,
                                                      case when orphan_txns.c=0 then 'ok' else 'error' end,
                                                      ''      from orphan_txns
union all select 14, 'orphan pricing',                 orphan_pricing.c::text,
                                                      case when orphan_pricing.c=0 then 'ok' else 'error' end,
                                                      ''      from orphan_pricing
union all select 15, 'orphan reconciliation drafts',   orphan_drafts.c::text,
                                                      case when orphan_drafts.c=0 then 'ok' else 'error' end,
                                                      ''      from orphan_drafts
union all select 16, 'active items never stocked',     no_stock_anywhere.c::text,'info',  ''      from no_stock_anywhere
union all select 17, 'active items without pricing',   no_pricing.c::text,       'info',  ''      from no_pricing
union all select 18, 'active items without any txns',  no_txns.c::text,          'info',  ''      from no_txns
union all select 19, 'stock vs txn mismatches (item-godown pairs)',
                                                      stock_vs_txn.c::text,
                                                      case when stock_vs_txn.c=0 then 'ok' else 'warn' end,
                                                      case when stock_vs_txn.c=0 then '' else 'total pieces gap: ' || stock_vs_txn.total_gap::text end
                                                      from stock_vs_txn
order by ord;
