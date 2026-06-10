# HANDOVER — Stock Manager v2

> Snapshot to resume work in a fresh session. **Read `PROGRESS.md` too** — it's the
> full source of truth (this file is just the "where things stand right now" summary).
> As of the 2026-06-10 "god mode" audit commit. Branch `main` should be in sync with origin.

---

## ⚠️ Status: TWO migrations to run, then fully activated

1. **`db/2026-06-10-count-log.sql`** (if not yet run) — creates `reconciliation_count_log`, the
   permanent per-counter record behind the Reviewer's Count history modal. Commits work without it
   (they just warn). Idempotent.
2. **`db/2026-06-10-hardening-fixes.sql`** (NEW — run it soon, it closes real security holes):
   role-gates `process_transaction`/`reverse_transaction` (any authenticated account could post
   stock via raw RPC), server-side double-reverse guard + unique index, optional invoice/rate params
   (the client auto-falls-back to the old 7-arg call until this runs), PIN `set_pin`/`change_pin`
   lockout hardening, peer-admin/self guards on admin RPCs, master-login brute-force throttle,
   viewer-proof reconciliation drafts/done RLS, `user_names` view (staff see colleague names in the
   log), friendly category-collision errors, `price_history.discounts`. Idempotent.

Optional: redeploy `supabase/functions/master-login` (CORS now origin-locked) — the brute-force
throttle lives in SQL and works without the redeploy.

The 2026-06-09 coordination migration **has been run** (live-confirmed). Every earlier `db/*.sql`
(through `2026-06-02-category-redo.sql`) has been run; both Edge Functions are deployed.

**2026-06-10 (later): full-app "god mode" audit** — 7 subsystems audited adversarially, ~70 findings
fixed in one pass (the silent PostgREST 1,000-row cap corrupting reports, ABC class-boundary bug,
3 conflicting low-stock rules unified into `lib/utils`, queue double-posting, returns netting,
IST dates, truthful reconciliation count-log ordering, pricing silent-coercion saves, 13 native
confirm/prompts → styled `useConfirm` dialog, toasts/buttons/tables/modals converged, demo-mode
repairs). Full detail in the PROGRESS changelog. `transactions.reason` is still a dead column —
audit text lives in `transactions.note`.

**Known follow-ups (low priority, not blocking):**
- `items.image_url` + `items.alert_threshold` are dead schema columns (no UI reads/writes them) —
  either wire item photos someday or drop them from the docs.
- `category_rename` doesn't sync the legacy `items.category` text column (only v1 would notice).
- Invoice/rate now land in real columns for NEW transactions; party name still lives in the note
  (parties table is empty — a party master is a future feature).

---

## How this project ships

- **Frontend deploy = `git push origin main`** → GitHub Actions (`.github/workflows/deploy.yml`)
  builds the static export → GitHub Pages. Live at **https://harshj111186.github.io/stock-app-v2/**
  (~1–2 min after push). `gh` is authed locally as `harshj111186` (repo+workflow scopes).
- **SQL migrations** live in `db/*.sql`; the user runs them by hand in **Supabase → SQL Editor**
  (never auto-applied). Schema/RPC changes go in a new dated `.sql` file.
- **Edge Functions** live in `supabase/functions/<name>/index.ts`; the user deploys them via the
  Supabase dashboard (paste) or `supabase functions deploy <name>`. `SUPABASE_*` env is auto-injected.
- **Backend** = Supabase project `zvycuhldwfxpipcaeotc`. Super-admin (main master) =
  `harsh.j111186@gmail.com`.

## Backend activation state

- **All `db/*.sql` have been run by the user**, through `2026-06-01-transaction-queue.sql`.
- **Master key is set** (Settings → Master key) and master login works.
- **Edge Functions:** `master-login` and `admin-account` are **both deployed**.

---

## What shipped this session (newest first; full detail in PROGRESS.md changelog)

- **(newest) 2026-06-10 full-app audit + fixes** — see the changelog's "GOD MODE" entry: pagination
  helper (`fetchAllRows`), security hardening migration, unified low-stock rules, queue claim
  semantics, returns netting, truthful count-log ordering, `useConfirm` dialog system, design
  convergence across every page, demo-mode repairs. NEW shared files: `lib/hooks.ts`,
  `components/confirm-dialog.tsx`.
- **Persistent transaction queue** (run `transaction_queue` SQL) + **actor name** shown
  in the transaction log & audit log (resolves `created_by` / `user_id` → name).
1. **Admin: reset password + remove account** (`admin-account` Edge Function) — pending deploy.
2. **Fix:** `apply_reconciliation` "godown_t cast bug" (the Edit-stock `process_transaction does
   not exist` error); Edit-stock modal simplified to **count-correction only**, quantities taken
   **absolute**. Verified working. Also fixed the reconciliation "Make adjustments" commit (same RPC).
3. **Reject a pending signup** (soft, reversible) — Users page Reject + Rejected bucket.
4. **Master password at login** (`master-login` Edge Function) — email + master password signs into
   any non-super account, skips PIN.
5. **Master key** at the PIN gate — unlocks any account except the super-admin (Settings to set it).
6. **Mobile filter sheets** (Items / Godown / Reconciliation), **category-path grouping**,
   **restore-archived** (items + categories), **ABC chart lazy-load**.
7. **Unlimited-depth category tree** — `/categories` manager + tree picker on items.
8. **Item add / edit / archive** (admin) — the dead "New item" button now works.
9. **Premium dashboard rebuild** + **⌘K command palette**; removed dead Search/Bell; fixed the
   wrong out-of-stock / dead-stock counts.
10. **Bold premium reskin** — violet accent + cool-slate/OLED neutrals via Tailwind scale remap,
    Space Grotesk display font.

## Project layout (key bits)

```
app/            pages (page=dashboard, items, godown-{a,b}, transactions, reconciliation,
                pricing, categories, reports/{sales,abc,dead-stock}, audit, users, settings, login)
  providers.tsx auth + PIN-gate state machine
components/     shell, sidebar, topbar, bottom-tab-bar, command-palette, filter-sheet,
                item-form-modal, category-tree-picker, dashboard-chart, abc-chart, pin-gate
lib/            supabase.ts (client + types + PROFILE_COLUMNS), utils.ts, categories.ts
db/             SQL migrations (run manually in Supabase)
supabase/functions/  master-login, admin-account  (Deno edge functions)
```

## Gotchas for the next session

- **This folder is Google-Drive-synced.** That makes the LOCAL `next dev` recompile in a loop and
  the preview **screenshot** tool time out — verify on the **deployed** site, not local dev.
- **Never run `npm run build` while `next dev` is running** — they share `.next/` and dev then
  404-loops on `layout.css`. Fix: stop dev, `rm -rf .next`, restart.
- **The Next build type-checks `app/**` etc. but `supabase/functions` is excluded** in `tsconfig.json`
  (Deno + URL imports). Keep it excluded.
- **PIN gate** blocks headless access to authed pages. For read-only visual checks you can set
  `sessionStorage['pinUnlocked:<userId>']='1'` and reload (the Supabase session persists). Read-only
  only — never submit writes to live data that way.
- **Respect linter-customised files** (`app/items/page.tsx`, `app/page.tsx`, `lib/supabase.ts`,
  `components/sidebar.tsx`) — edit surgically; the user's editor sometimes refactors them.
- Commit messages end with the `Co-Authored-By` trailer; `git add` explicit paths (don't `-A` — it
  would catch the untracked `.tmp.driveupload/` Drive temp).
