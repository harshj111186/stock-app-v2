-- Reconciliation count log
--
-- Permanent record of WHO counted WHAT, captured at the moment counts are
-- committed (bulk "Make adjustments" AND per-item "Apply this count") — just
-- before the drafts are deleted. Born from the 2026-06-10 incident: after a
-- commit, items whose count MATCHED the system left no transaction (delta 0),
-- so "counted-and-correct" was indistinguishable from "never counted". With
-- this log, every committed cycle keeps the full per-counter entries forever.
--
-- Rows are denormalized (item code/brand/model + counter name copied in) so
-- the log stays readable even if items are renamed/deleted or users removed.
-- The log is IMMUTABLE from the client: insert-only (active admins — both
-- commit paths are admin-only), readable by any signed-in user, no update or
-- delete policies.
--
-- Idempotent — safe to run repeatedly. Run once in Supabase → SQL Editor.

create table if not exists reconciliation_count_log (
  id              uuid primary key default gen_random_uuid(),
  commit_note     text not null,                    -- e.g. 'Reconciliation 2026-06-10'
  commit_kind     text not null check (commit_kind in ('bulk', 'single')),
  committed_by    uuid references auth.users(id) on delete set null,
  user_id         uuid not null,                    -- the counter whose entries these are
  user_name       text,                             -- display name at commit time
  item_id         uuid references items(id) on delete set null,
  item_code       text,
  brand           text,
  model           text,
  size            text,
  colour          text,
  case_size       int not null default 0,           -- item's case size at commit
  case_size_raw   text not null default '',         -- exactly what the counter typed
  a_cases_raw     text not null default '',
  a_loose_raw     text not null default '',
  b_cases_raw     text not null default '',
  b_loose_raw     text not null default '',
  a_pieces        int,                              -- computed total; NULL = godown not counted
  b_pieces        int,
  applied         boolean not null default false,   -- this row's values fed the committed stock
  created_at      timestamptz not null default now()
);

comment on table reconciliation_count_log is
  'Snapshot of every counter''s reconciliation entries, written at commit time '
  '(before drafts are wiped). Permanent audit of who counted what, per cycle.';

create index if not exists recon_count_log_created_idx on reconciliation_count_log (created_at desc);
create index if not exists recon_count_log_item_idx    on reconciliation_count_log (item_id);
create index if not exists recon_count_log_note_idx    on reconciliation_count_log (commit_note);

alter table reconciliation_count_log enable row level security;

-- Anyone signed in may read the history (same transparency as drafts).
drop policy if exists "count_log_select" on reconciliation_count_log;
create policy "count_log_select" on reconciliation_count_log
  for select to authenticated
  using (true);

-- Only an active admin may write (both commit paths are admin-only).
drop policy if exists "count_log_insert" on reconciliation_count_log;
create policy "count_log_insert" on reconciliation_count_log
  for insert to authenticated
  with check (
    exists (select 1 from user_profiles up
             where up.id = auth.uid() and up.role::text = 'admin' and up.active = true)
  );

-- No update/delete policies on purpose — the log is immutable from the client.

grant select, insert on reconciliation_count_log to authenticated;

select 'reconciliation count log ready' as status,
       (select count(*) from reconciliation_count_log) as existing_rows;
