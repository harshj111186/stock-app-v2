# HANDOVER — Stock Manager v2

> Snapshot to resume work in a fresh session. **Read `PROGRESS.md` too** — it's the
> full source of truth (this file is just the "where things stand right now" summary).
> As of commit **`7abfc97`** (2026-06-01). Branch `main` is in sync with origin.

---

## ⚠️ The one outstanding action

Everything built this session is **committed, pushed, and live** EXCEPT one deploy step the
user still needs to do:

- **Deploy the `admin-account` Edge Function** (for "Reset password" + "Remove account" on the
  Users page). Supabase → Edge Functions → Deploy a new function → name it exactly
  **`admin-account`** → paste `supabase/functions/admin-account/index.ts` → Deploy. No SQL.
  Then test: reset a test user's password, and remove a throwaway signup.

Until that's deployed, those two buttons error (admin-only, so only the owner sees them).
Everything else is verified working.

Also dangling: `db/diagnostics-reconciliation-integrity.sql` has an **uncommitted local edit**
(the user's read-only diagnostic query, not from our work). Decide to commit or leave it; it has
zero effect on the app.

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

- **All `db/*.sql` through 2026-06-01 have been run by the user** (confirmed via smoke checks),
  including the latest `2026-06-01-apply-reconciliation-cast-fix.sql`.
- **Master key is set** (Settings → Master key) and master login works.
- **Edge Functions:** `master-login` = **deployed & working**. `admin-account` = **NOT yet deployed**
  (see outstanding action).

---

## What shipped this session (newest first; full detail in PROGRESS.md changelog)

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
