-- Per-user transaction queue (persistent batch staging).
--
-- The Transactions page lets a user QUEUE several entries (Purchase / Sale /
-- Transfer / Adjustment / Return) and then process them in one safe-ordered
-- run. Until now that queue lived only in React state, so leaving the app
-- (or a refresh / different device) lost it. This table persists the queue
-- per user, so an employee who queues entries and walks away still sees them
-- waiting when they return.
--
-- Rows here are STAGING only — they don't touch stock. Processing each one
-- calls process_transaction (which is what actually moves godown_stock and
-- logs the transaction), and the row is deleted from the queue on success.
--
-- RLS: a user only ever sees / edits their own queued rows.
--
-- Safe to run repeatedly. Run once in Supabase → SQL Editor.

create table if not exists transaction_queue (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  item_id     uuid not null references items(id) on delete cascade,
  action      text not null,             -- Purchase | Sale | Transfer | Adjustment | Return
  godown      text not null,             -- 'A' | 'B' (from-godown for Transfer)
  to_godown   text,                      -- Transfer destination
  cartons     int  not null default 0,
  loose       int  not null default 0,
  total_qty   int  not null default 0,
  rate        text,
  invoice_no  text,
  party_name  text,
  reason      text,
  return_dir  int,                       -- Return: +1 in / -1 out
  direction   int,                       -- null for Purchase/Sale/Transfer; ±1 for Adjustment/Return
  txn_date    date not null default current_date,
  created_at  timestamptz not null default now()
);

comment on table transaction_queue is
  'Per-user staging of un-processed batch transactions. Cleared row-by-row as '
  'each is processed via process_transaction. RLS-scoped to the owner.';

create index if not exists transaction_queue_user_idx on transaction_queue (user_id, created_at);

alter table transaction_queue enable row level security;

-- One policy for everything: you can only touch your own rows.
drop policy if exists transaction_queue_owner on transaction_queue;
create policy transaction_queue_owner on transaction_queue
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update, delete on transaction_queue to authenticated;

select 'transaction_queue ready' as status,
       (select count(*) from transaction_queue) as rows_now;
