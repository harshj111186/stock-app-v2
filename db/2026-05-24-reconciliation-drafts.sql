-- Per-user reconciliation drafts
--
-- Lifts the in-progress stocktake state out of each user's browser
-- localStorage into a shared table so:
--   1. Two staff counting at the same time don't overwrite each other.
--   2. Admin gets a Reviewer view that sees every user's entries.
--   3. Drafts survive across devices and tab reloads for the same user.
--
-- Draft fields are stored as raw text ("5+1+2") because the UI lets the
-- user append arithmetic to a previous entry — the evaluation happens on
-- read. Once admin commits via /reconciliation → "Make adjustments",
-- the corresponding draft rows are deleted.
--
-- RLS lets a user read/write their own row OR lets an admin do it for
-- any user (so admin can override a staff entry from Reviewer view).
--
-- Safe to run twice — every step is idempotent.
-- Run once in Supabase Dashboard → SQL Editor.

-- ──────────────────────────────────────────────────────────────────────────
-- 1. Table
-- ──────────────────────────────────────────────────────────────────────────
create table if not exists reconciliation_drafts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  item_id         uuid not null references items(id) on delete cascade,
  case_size_raw   text not null default '',
  a_cases_raw     text not null default '',
  a_loose_raw     text not null default '',
  b_cases_raw     text not null default '',
  b_loose_raw     text not null default '',
  updated_at      timestamptz not null default now(),
  unique (user_id, item_id)
);

comment on table reconciliation_drafts is
  'In-progress physical stock-take entries, one row per (user, item). '
  'Cleared by /reconciliation → "Make adjustments" once admin commits.';

create index if not exists reconciliation_drafts_user_idx
  on reconciliation_drafts (user_id);
create index if not exists reconciliation_drafts_item_idx
  on reconciliation_drafts (item_id);
create index if not exists reconciliation_drafts_updated_idx
  on reconciliation_drafts (updated_at desc);

-- ──────────────────────────────────────────────────────────────────────────
-- 2. updated_at trigger
-- ──────────────────────────────────────────────────────────────────────────
create or replace function reconciliation_drafts_touch_updated_at()
  returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists reconciliation_drafts_touch on reconciliation_drafts;
create trigger reconciliation_drafts_touch
  before update on reconciliation_drafts
  for each row execute function reconciliation_drafts_touch_updated_at();

-- ──────────────────────────────────────────────────────────────────────────
-- 3. RLS
-- ──────────────────────────────────────────────────────────────────────────
alter table reconciliation_drafts enable row level security;

-- Helper: am I an active admin?
-- Inlined as a sub-select so the policy can stay self-contained.
-- Using `role::text` since the column is the role_t enum.
drop policy if exists "drafts_select" on reconciliation_drafts;
create policy "drafts_select" on reconciliation_drafts
  for select to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from user_profiles up
      where up.id = auth.uid()
        and up.role::text = 'admin'
        and up.active = true
    )
  );

drop policy if exists "drafts_insert" on reconciliation_drafts;
create policy "drafts_insert" on reconciliation_drafts
  for insert to authenticated
  with check (
    user_id = auth.uid()
    or exists (
      select 1 from user_profiles up
      where up.id = auth.uid()
        and up.role::text = 'admin'
        and up.active = true
    )
  );

drop policy if exists "drafts_update" on reconciliation_drafts;
create policy "drafts_update" on reconciliation_drafts
  for update to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from user_profiles up
      where up.id = auth.uid()
        and up.role::text = 'admin'
        and up.active = true
    )
  )
  with check (
    user_id = auth.uid()
    or exists (
      select 1 from user_profiles up
      where up.id = auth.uid()
        and up.role::text = 'admin'
        and up.active = true
    )
  );

drop policy if exists "drafts_delete" on reconciliation_drafts;
create policy "drafts_delete" on reconciliation_drafts
  for delete to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from user_profiles up
      where up.id = auth.uid()
        and up.role::text = 'admin'
        and up.active = true
    )
  );

grant select, insert, update, delete on reconciliation_drafts to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 4. View: drafts joined with the user's display name + role
--    The page uses this for the Reviewer table so each row shows who
--    entered it without a second round-trip. Defined as a security_invoker
--    view so RLS still applies (each user only sees rows they're allowed
--    to see via the policies above).
-- ──────────────────────────────────────────────────────────────────────────
create or replace view reconciliation_drafts_with_user
  with (security_invoker = true) as
select
  d.id,
  d.user_id,
  d.item_id,
  d.case_size_raw,
  d.a_cases_raw,
  d.a_loose_raw,
  d.b_cases_raw,
  d.b_loose_raw,
  d.updated_at,
  up.email      as user_email,
  up.name       as user_name,
  up.role::text as user_role
from reconciliation_drafts d
left join user_profiles up on up.id = d.user_id;

grant select on reconciliation_drafts_with_user to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 5. Smoke checks
-- ──────────────────────────────────────────────────────────────────────────
select 'reconciliation_drafts ready' as status,
       (select count(*) from reconciliation_drafts) as existing_rows;
