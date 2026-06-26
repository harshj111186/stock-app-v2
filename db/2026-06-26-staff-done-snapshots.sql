-- Staff "marked done" count snapshots
--
-- Saves the data each staff member produces during reconciliation the MOMENT
-- they mark their own count "done" — independently of, and earlier than, the
-- admin commit (which is what reconciliation_count_log captures).
--
-- Why a separate record from reconciliation_count_log:
--   - count_log is written by the ADMIN at commit time (insert policy = admin
--     only) and carries an `applied`/`commit_kind` shape tied to a commit.
--   - This table is written by the STAFF MEMBER themselves at the instant they
--     freeze their count. Each "Mark my count done" press snapshots every
--     non-empty draft that person currently holds, so their finished count is
--     preserved even if the admin never commits, recounts overwrite it, or a
--     conflict resolution later clears their draft.
--
-- One press of "done" = one batch of rows sharing (user_id, done_at). Rows are
-- denormalized (item + counter identity copied in) so they stay readable after
-- renames/deletes. IMMUTABLE from the client: insert-only (a staff/admin may
-- insert ONLY their own rows), readable by any signed-in user, no update/delete
-- policies. The /reconciliation "Count history" modal reads it alongside the
-- commit log.
--
-- Idempotent — safe to run repeatedly. Run once in Supabase → SQL Editor.

create table if not exists reconciliation_done_snapshots (
  id              uuid primary key default gen_random_uuid(),
  -- Bare uuid with NO FK (matches reconciliation_count_log.user_id): this is an
  -- IMMUTABLE audit that must survive a user being hard-deleted. A FK with
  -- ON DELETE CASCADE would silently wipe exactly the snapshots this table
  -- exists to preserve (counts marked done but never committed → no transaction
  -- → the user IS hard-deletable). user_name below keeps it readable.
  user_id         uuid not null,                    -- the counter whose entries these are
  user_name       text,                             -- display name at done time
  done_at         timestamptz not null default now(),  -- when this count was frozen
  item_id         uuid references items(id) on delete set null,
  item_code       text,
  brand           text,
  model           text,
  size            text,
  colour          text,
  case_size       int not null default 0,           -- item's case size at done time
  case_size_raw   text not null default '',         -- exactly what the counter typed
  a_cases_raw     text not null default '',
  a_loose_raw     text not null default '',
  b_cases_raw     text not null default '',
  b_loose_raw     text not null default '',
  a_pieces        int,                              -- computed total; NULL = godown not counted
  b_pieces        int,
  created_at      timestamptz not null default now()
);

comment on table reconciliation_done_snapshots is
  'Snapshot of one staff member''s reconciliation entries, written the moment '
  'they mark their own count "done" (one batch per done event, keyed by '
  '(user_id, done_at)). Preserves each counter''s finished count independently '
  'of the admin commit. Immutable from the client.';

create index if not exists recon_done_snap_user_idx    on reconciliation_done_snapshots (user_id);
create index if not exists recon_done_snap_doneat_idx  on reconciliation_done_snapshots (done_at desc);
create index if not exists recon_done_snap_item_idx    on reconciliation_done_snapshots (item_id);

alter table reconciliation_done_snapshots enable row level security;

-- Anyone signed in may read the history (same transparency as drafts/count log).
drop policy if exists "done_snap_select" on reconciliation_done_snapshots;
create policy "done_snap_select" on reconciliation_done_snapshots
  for select to authenticated
  using (true);

-- A user may insert ONLY their own snapshot rows (the act of marking THEIR
-- count done); an active admin may insert for anyone (e.g. snapshotting a
-- count they froze on a staffer's behalf). Must be an active staff/admin —
-- viewers can't count, so they can't snapshot.
drop policy if exists "done_snap_insert" on reconciliation_done_snapshots;
create policy "done_snap_insert" on reconciliation_done_snapshots
  for insert to authenticated
  with check (
    exists (
      select 1 from user_profiles up
      where up.id = auth.uid()
        and up.active = true
        and (
          (up.role::text in ('admin', 'staff') and reconciliation_done_snapshots.user_id = auth.uid())
          or (up.role::text = 'admin')
        )
    )
  );

-- No update/delete policies on purpose — the snapshot log is immutable.

grant select, insert on reconciliation_done_snapshots to authenticated;

select 'reconciliation done snapshots ready' as status,
       (select count(*) from reconciliation_done_snapshots) as existing_rows;
