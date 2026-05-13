# PROGRESS — Stock Manager (Rye Electricals)

> **READ THIS FILE BEFORE TOUCHING ANY CODE.** This is the project's source of truth for what's been done, what's live, what's broken, and what NOT to redo. If you're a fresh Cowork / Claude session, scroll the whole file first, then look at the user's request.
>
> **WRITE TO THIS FILE AFTER EVERY MEANINGFUL CHANGE.** Add a dated entry to the Changelog with what you did, why, and which files moved. Don't be terse — future-you needs the context.

---

## 1. What this project is

A small retail electrical shop in India (fans, geysers, ~13 categories, ~166 SKUs across 2 godowns) replacing a macro-driven Excel workbook (`stock entry.xlsm`) with a real web app. Excel → Supabase Postgres + a frontend.

**User profile (Harsh Bagrecha):**
- 0 coding background; decent general tech literacy. Everything has to be explained in plain English.
- Communicates from Windows + OneDrive. Wants Indian-friendly defaults (₹ formatting, en-IN dates).
- Will NEVER share Personal Access Tokens or Supabase service-role keys. Files go to GitHub via the web-UI drag-drop.
- Frequently uses an editor with a linter that auto-modifies files. Those changes are intentional. Don't revert them unless explicitly asked.

---

## 2. Live URLs + credentials

| Thing | Value |
|---|---|
| **v1 app** (stable, daily use) | https://harshj111186.github.io/stock-app/ |
| **v1 repo** | https://github.com/harshj111186/stock-app (public) |
| **v2 app** (rebuilt, modern UI) | https://harshj111186.github.io/stock-app-v2/ |
| **v2 repo** | https://github.com/harshj111186/stock-app-v2 (public) |
| **Supabase project URL** | https://zvycuhldwfxpipcaeotc.supabase.co |
| **Supabase project ref** | `zvycuhldwfxpipcaeotc` |
| **Admin login** | `harsh.j111186@gmail.com` |
| **GitHub username** | `harshj111186` |
| **GitHub Pages source** | "GitHub Actions" (NOT branch-based) |
| **GitHub Action env** | repo secret `SUPABASE_ANON_KEY` (already set) |
| **Local working folder** | `C:\Users\USER\OneDrive\RYE DOCS\rye docs\Stock Accounting\` |

Both apps point at the **same** Supabase database. Anything entered in v1 shows up in v2 instantly and vice versa.

---

## 3. Tech stack

**v1** (single-file, no build step)
- `index.html` — ~50 KB, vanilla HTML + CSS + JS
- Supabase JS via CDN
- Pages: Dashboard, Items, Godown A/B, Master Stock, Pricing, New Transaction, Transaction Log, Audit Log, Users
- Features added during life: brand chips, subcategory, drag-drop bulk-move, auto-colour cells, light theme toggle, role-based UI
- Deploys: edit `stock-app/index.html` → commit to GitHub → Pages serves it (~1 min)

**v2** (Next.js + Tailwind + shadcn-style + Lucide)
- Next.js 15 App Router with `output: 'export'` static export
- Tailwind CSS, Lucide React icons, Recharts (for future charts), Supabase JS v2
- `basePath: '/stock-app-v2'`, `trailingSlash: true`
- Deploys: GitHub Actions workflow `.github/workflows/deploy.yml` runs `npm install && npm run build` → publishes `out/` to Pages

---

## 4. Database schema (LIVE state — what's actually in Supabase right now)

Tables present in `public` schema:
- **`items`** — id (uuid pk), item_code, brand, category_id (fk → categories), subcategory, model, size, colour, case_size, hsn_code, gst_rate, reorder_point_a, reorder_point_b, image_url, alert_threshold, archived, archived_at, created_at, updated_at
  - NOTE: an older `category` text column may still exist alongside category_id — both currently work, but new code should prefer the FK
- **`categories`** — id (uuid pk), name (unique), normalised_name (generated), hsn_code, gst_rate, archived
- **`godown_stock`** — item_id (fk), godown ('A'|'B' enum), cases, loose — PK = (item_id, godown)
- **`pricing`** — item_id (pk), lp, discount, gst_rate, effective_from
- **`price_history`** — id, item_id, lp, discount, gst_rate, recorded_at
- **`transactions`** — id, item_id, txn_date, action enum {Purchase, Sale, Transfer, Adjustment, Return}, godown, qty, status, reverses_id, party_id, invoice_no, reason, rate, created_by, created_at
- **`parties`** — id, type {customer/supplier/both}, name, phone, email, gstin, address (empty so far)
- **`audit_log`** — append-only, written by triggers
- **`user_profiles`** — id (fk to auth.users), email, name, role enum {admin, staff, viewer}, active

**Postgres functions:**
- `process_transaction(item_id, action, godown, qty, date, note)` — the ONLY way the app changes stock. Atomic. Carton+loose math.
- `reverse_transaction(txn_id)` — inserts the inverse, sets `reverses_id`. Never deletes.
- `recompute_stock_levels()` — sanity-check helper (replays the ledger).
- `handle_new_user()` — fires on auth.users INSERT, creates user_profiles row; first user becomes admin.
- `my_role()` — helper for RLS policies.

**RLS** is enabled on every table. The audit trigger is attached to items / godown_stock / pricing / transactions.

**Anon role can do:** auth signin, signup. CANNOT read any business data. Authenticated role can read everything; admin role can write to most things; staff/viewer scoped down.

**Schema migration script:** `phase1-migration.sql` (in the Stock Accounting folder). Was run on 2026-05-13.

---

## 5. Folder layout

```
Stock Accounting/                              ← workspace root in OneDrive
├── PROGRESS.md                                 ← THIS FILE
├── stock entry.xlsm                            ← the original Excel — source of all data
├── migrated-data.json                          ← extracted catalogue + stock + 267 txns
├── phase1-schema.sql                           ← original Phase 1 schema (already applied)
├── phase1-migration.sql                        ← extension: categories table, parties, etc. (applied 2026-05-13)
├── phase1-bundle.sql                           ← schema + data, combined (for one-shot rebuilds)
├── phase1-data-only.sql                        ← just INSERTs (used during recovery)
├── stock-app-prototype.html                    ← original prototype (local-only, localStorage)
├── stock-app/                                  ← v1 deploy folder (synced to GitHub repo `stock-app`)
│   ├── index.html
│   ├── manifest.webmanifest
│   └── icon.svg
├── stock-app-v2/                               ← v2 deploy folder (synced to GitHub repo `stock-app-v2`)
│   ├── .github/workflows/deploy.yml
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx                            ← Dashboard
│   │   ├── providers.tsx                       ← Auth + theme provider (has 4s timeout fallback)
│   │   ├── not-found.tsx                       ← 404 fallback
│   │   ├── login/page.tsx
│   │   ├── items/page.tsx                      ← Catalogue (linter has heavily customised; tree view, persisted UI state)
│   │   ├── godown-a/page.tsx                   ← placeholder
│   │   ├── godown-b/page.tsx                   ← placeholder
│   │   ├── transactions/page.tsx               ← placeholder
│   │   ├── pricing/page.tsx                    ← placeholder
│   │   ├── audit/page.tsx                      ← real (admin only)
│   │   ├── users/page.tsx                      ← real (admin only)
│   │   ├── settings/page.tsx                   ← account info
│   │   ├── reports/sales/page.tsx              ← placeholder
│   │   ├── reports/abc/page.tsx                ← placeholder
│   │   ├── reports/dead-stock/page.tsx         ← placeholder
│   │   └── globals.css
│   ├── components/
│   │   ├── shell.tsx                           ← layout wrapper (sidebar + topbar + auth guard)
│   │   ├── sidebar.tsx
│   │   └── topbar.tsx
│   ├── lib/
│   │   ├── supabase.ts                         ← singleton client + types
│   │   └── utils.ts                            ← cn, fmtN, fmtMoney, colourCss (auto-fill helper)
│   ├── package.json, tsconfig.json, next.config.mjs, tailwind.config.ts, postcss.config.mjs
│   ├── README.md, .gitignore
│   └── BLUEPRINT_v_LIVE.md                     ← if present, schema vs blueprint divergence notes
├── Stock App Plan.docx                         ← original plan
├── Phase 1 Runbook.docx                        ← deployment runbook
├── stock_app_upgrade_prompt.md                 ← the comprehensive upgrade brief
├── v2-mockup.html                              ← static visual mockup (Linear/Notion preview)
└── misc/ Modules/ Rye Biller/ etc.             ← unrelated files in the same OneDrive folder
```

---

## 6. Status (as of 2026-05-14)

### Working
- v1 fully functional, used daily.
- v2 dashboard + items + login + audit + users + settings all real.
- Sidebar nav reaches every page; no more 404s.
- Auth bootstrap has a 4-second timeout fallback (can't hang forever).
- Auto-deploy: any push to v2 `main` triggers GitHub Action → Pages.
- Schema migration applied: categories, parties, hsn_code, gst_rate, reorder_point_a/b, etc.

### Placeholder pages in v2 (next sessions to build)
- Godown A / Godown B — per-warehouse stock view with filters
- Transactions — the New-Transaction form (5 action types) + the full transaction log
- Pricing — per-item LP / discount / GST editor
- Reports section (Sales register, ABC analysis, Dead stock)

### Known cosmetic issues
- v2 dashboard's "Out of stock: 105" double-counts items that have never been stocked (not just SKUs that genuinely went out of stock). Needs a filter that excludes never-stocked items.
- v2 dashboard "Dead stock" currently equals "Out of stock" because the 90-day-no-movement query isn't written yet.

### Not started
- WhatsApp price-list share
- Bulk CSV import/export
- Low-stock daily email alert
- Product images (Supabase Storage bucket)
- GST invoice PDF (Phase 4 — deprioritised per user)
- Barcode labels + camera scan
- Realtime subscriptions
- Cmd+K command palette
- Inline editing in tables
- Side panel item detail (currently only the items page is rebuilt; side panel deferred)

---

## 7. Files with active linter / human edits — DO NOT REVERT BLINDLY

The user uses an editor (Cursor or similar) that runs a linter / AI to improve files. Those edits are INTENTIONAL and informed by knowledge the AI session may not have. Specifically these files have been customised:

| File | Linter additions worth knowing |
|---|---|
| `stock-app-v2/app/items/page.tsx` | Tree view (group by Brand → Category → Subcategory), grid + table view toggle, persisted UI state (view/depth/expanded sets in localStorage), `useMemo` for derived state. Heavy — don't rewrite from scratch. |
| `stock-app-v2/app/page.tsx` | Defensive pricing math (`asFraction` handles % vs fraction), joins `categories(name)` via FK. |
| `stock-app-v2/lib/supabase.ts` | Type definitions updated to match LIVE schema (not the blueprint). Comments reference a `BLUEPRINT_v_LIVE.md` file. |
| `stock-app-v2/components/sidebar.tsx` | Hover colour polish, minor responsive tweaks. |

If you must touch one of these files: **read first, edit surgically, never replace whole file** unless the user explicitly asks.

---

## 8. Workflow rules for any AI session

1. **READ this PROGRESS.md fully** before proposing changes.
2. **Plain English for the user.** No technical jargon without explanation.
3. **No PATs, no service-role keys.** File upload via GitHub web UI is the only path.
4. **GitHub web upload quirk:** drag-drop strips dot-folders (`.github/`). For workflow files, use "Create new file" with the full slashed path (`.github/workflows/deploy.yml`).
5. **Don't redo what's already done.** If something on the live URL already works, leave it alone.
6. **Don't touch v1 except for explicit feature requests.** v1 is the safety net.
7. **All quantity math = server-side** via `process_transaction()`. The client never POSTs a computed `total_units`.
8. **Carton + loose stays separate** at data entry. Never collapse them into one total field.
9. **Transactions are immutable.** Corrections = a reversing entry that points to the original via `reverses_id`.
10. **Schema changes go in a `.sql` file in the Stock Accounting folder.** Never have the user click around the Supabase dashboard to alter tables.
11. **Update this file** in the Changelog section at the end of any meaningful change.
12. **Respect linter changes** — see section 7.

---

## 9. Design system (v2)

- Font: Inter (Google Fonts CDN), system-ui fallback
- Numeric: `font-variant-numeric: tabular-nums` for all numbers, money via `fmtMoney()` (₹ + en-IN)
- Dark mode default, light theme via `.dark` class on `<html>`
- Accent colour: cyan-500 (`#06b6d4`) — one primary accent only
- Semantic state: emerald healthy, amber low, rose out, zinc neutral
- Icons: Lucide React only. **No emoji icons** anywhere in v2.
- Layout: sidebar (`w-60`) + topbar (`h-14`) + scrollable main
- Shell wraps every page and handles auth gating + the loading spinner

---

## 10. Open decisions / parked items

- **Drop the old `items.category` text column?** Currently both `category` (text) and `category_id` (fk) exist. v2 reads via the FK join. Decision: keep both for a while; drop text after v2 is daily-driver.
- **Per-item GST rate vs global 18%?** Brief says some items differ; not implemented yet. `items.gst_rate` field exists but unused.
- **Reorder points** — column exists on items; UI to set them not built yet. Defaults to 0; low-stock fallback is `≤ 2` units.
- **PWA install** — v1 has a manifest; v2 needs one too. Deferred.
- **Cutover plan** — when v2 reaches feature parity, rename repos. Not yet.

---

## 11. Changelog (latest first — add new entries at the top)

### 2026-05-14 — v2 sign-in hang fixed (button stuck on "...")
**Symptom reported by user:** clicking Sign in on the v2 login page leaves the button showing "..." endlessly. Confirmed reproducing in Incognito too — so NOT a stale-token issue.

**Root cause — two bugs compounding:**

1. **Redirect-loop race in `app/providers.tsx`.** After `signInWithPassword` resolves, the login page calls `router.replace("/")`. Meanwhile, Supabase fires SIGNED_IN → the `onAuthStateChange` listener starts fetching the user's profile from `user_profiles`. During the brief window where `pathname` has just changed to "/" but `profile` is still null (fetch in flight), the redirect `useEffect` in providers ran `if (!profile && !onLogin) router.replace("/login")` and bounced the user back. Profile would eventually load and push back to "/", creating a visible flap that looks like "stuck on the login button".

2. **No safety net on the sign-in submit in `app/login/page.tsx`.** Submit handler used only `try/finally` — no timeout, no `catch`. If `signInWithPassword` ever hung (browser navigator-lock contention, network), the `await` would never resolve, `setBusy(false)` in `finally` never ran, and the button stayed disabled forever with no error visible.

**Files patched:**

- `stock-app-v2/app/providers.tsx` — in the `onAuthStateChange` callback AND the `getSession().then()` callback, added `setLoading(true)` BEFORE `await fetchProfile(...)`. The redirect effect already early-returns when `loading` is true, so this guarantees no /login bounce during the brief session-exists-but-profile-not-loaded window. Comments inline explain why.
- `stock-app-v2/app/login/page.tsx` — rewrote `submit()` with three changes:
  - **12-second `Promise.race` timeout** on the auth call. If it hangs, the button releases and shows a "took too long, try again or refresh" error instead of staying stuck.
  - **`try { ... } catch (e) { ... } finally`** around the whole thing — thrown errors now surface in the red error box instead of being silently dropped.
  - **Replaced `router.replace("/")` with `window.location.assign("/stock-app-v2/")`** (or "/" in dev). Hard navigation forces Providers to bootstrap fresh with the new session in localStorage — sidesteps the redirect-race entirely as a belt-and-braces second line of defence.
  - Removed the now-unused `useRouter` import.

**Files NOT touched:** every other file in `stock-app-v2/` left clean. Linter-customised files (`items/page.tsx`, `page.tsx`, `supabase.ts`, `sidebar.tsx`) untouched.

**Deploy required:** user must upload the two changed files via GitHub web UI to `harshj111186/stock-app-v2`:
- `app/login/page.tsx`
- `app/providers.tsx`

GitHub Action will rebuild and republish (~1–2 min). After that, sign-in should be clean: click → ~1s pause → dashboard loads. If anything still hangs, the 12s timeout will release the button with a clear message.

**Follow-ups (if it STILL hangs after deploy):**
- Open browser DevTools → Network tab and check whether the `/auth/v1/token?grant_type=password` request returns a 200 quickly (network issue) or never resolves (browser/lock issue).
- Open DevTools → Console and look for any `[fetchProfile] error` lines — if `user_profiles` RLS is rejecting the read, profile stays null and the redirect bounces even with the new fix. Would point at an RLS policy on `user_profiles` needing review.
- As a hard reset, sign out → clear site data in DevTools → Application → Storage → "Clear site data" → retry.

### 2026-05-14 — Project instructions extended to enforce PROGRESS.md read/append
**Why:** user noted that being in the same Cowork project shares the static instructions but does NOT share chat history across sessions. Without an explicit rule, fresh chats were skipping PROGRESS.md and risking duplicate or conflicting work.

**What was done in this session:**
- Confirmed PROGRESS.md already exists at the workspace root and is well-structured (no rewrite needed).
- Drafted the exact text to add to the Cowork project instructions ("Stock Manager — Rye Electricals" → Project Instructions field) that forces every chat to (a) read PROGRESS.md before doing anything, (b) re-check it before declaring done, (c) append a dated Changelog entry at the end of every meaningful change.

**Action still on the USER (Claude cannot edit project settings directly):**
- Open Cowork → this project ("Stock Manager — Rye Electricals") → Project Instructions → paste the new top-of-file block (provided in chat) above "ABOUT ME".
- Once pasted, every new chat will automatically receive the read-PROGRESS.md rule as part of its system context.

**Files touched:** only this Changelog entry.

**Next task planned in this session (handoff to the fresh chat that picks this up):**

*Title:* Unlock Adjustment + Return action types in v2 transactions.

*Why now:* The DB enum `action_t` already includes 'Adjustment' and 'Return' (added by `phase1-migration.sql` on 2026-05-13), and the v2 transactions/page.tsx already renders both tabs but `disabled` with a Lock icon. The blocker is purely that `process_transaction()` in `phase1-schema.sql` has no branch for the two new values — calling it with them silently writes a zero-impact ledger row. Unlocking these two completes the "all 5 action types" promise of Phase 1 / Phase 2 and is a closed-loop, single-session task.

*Design decisions ALREADY MADE (do not re-ask the user):*

1. **Adjustment direction handling = client-driven reason groups.** The Reason dropdown in the Adjustment tab is split into two visual groups. Group "Stock goes UP" = Found / Count-up / Customer return-to-shelf → direction +1. Group "Stock goes DOWN" = Damage / Lost / Count-down → direction -1. The client computes the +1/-1 from the chosen reason and passes it explicitly to `process_transaction`. The SQL does NOT parse reason strings; it just trusts the passed direction. Reason text is still saved on the transaction row for audit.

2. **Return covers BOTH customer returns AND supplier returns.** The Return tab gets a small In/Out segmented control. "Customer return — into godown" = direction +1, party label says "Customer". "Supplier return — out of godown" = direction -1, party label says "Supplier". Client computes direction from the toggle.

3. **SQL approach for tracking direction:** add a `direction smallint not null` column to `transactions` (back-filled from existing rows per the recompute_stock_levels view's current assumption — Purchase=+1, Sale=-1, Transfer=-1, old Adjustment/Return=+1). Constraint `check (direction in (-1, 1))`. The `process_transaction` function sets it canonically per action and uses the new `p_direction int` parameter for Adjustment and Return only.

*Plan to execute in the fresh chat:*

A. **Read PROGRESS.md fully (per the new rule the user just added to project instructions).**

B. **Write `phase2-adjustment-return.sql` in the Stock Accounting folder.** Should contain:
   - `drop function if exists process_transaction(uuid, action_t, godown_t, int, date, text);` (kills the old signature so the new one with the extra `p_direction` parameter is unambiguous).
   - `alter table transactions add column if not exists direction smallint;` then a backfill `update` + `alter ... set not null` + check constraint.
   - `create or replace function process_transaction(...) ...` with the new signature `(p_item_id uuid, p_action action_t, p_godown godown_t, p_qty int, p_date date default current_date, p_note text default null, p_direction int default null)`. Add `elsif p_action = 'Adjustment'` and `elsif p_action = 'Return'` branches that use `v_dir` from `p_direction`. Validate direction is not null and is in (-1, 1) for these two actions. For direction = -1, run the same stock-sufficiency check as Sale. Inside the existing `insert into transactions` at the bottom, set `direction` to: Purchase=1, Sale=-1, Transfer=-1, Adjustment/Return=v_dir.
   - `create or replace view recompute_stock_levels as ...` updated to use `t.direction * t.qty` directly instead of the hard-coded `case action when ... end` mapping.
   - `grant execute on function process_transaction(uuid, action_t, godown_t, int, date, text, int) to authenticated;`
   - Wrap key statements idempotently (`if not exists`, `do $$`/`exception when ...`) so user can re-run safely.

C. **Edit `stock-app-v2/app/transactions/page.tsx` surgically (linter-customised file per section 7 — read whole file, edit only the affected blocks; do NOT rewrite).** Specifically:
   - Remove `disabled` and the `<Lock>` icon from the Adjustment and Return tab buttons.
   - Remove the in-page guard in the submit handler that bails when action is Adjustment/Return.
   - In the Adjustment tab's Reason dropdown, group options visually under "Stock goes UP" and "Stock goes DOWN" headers. Maintain a small map at the top of the component: `ADJ_DIRECTION = { found: 1, count_up: 1, customer_return_to_shelf: 1, damage: -1, lost: -1, count_down: -1 }`.
   - In the Return tab, add an In/Out segmented control above the qty field. When In: party label "Customer (returning)", direction = +1. When Out: party label "Supplier (returning to)", direction = -1.
   - In the submit handler, compute `p_direction` from action + reason (Adjustment) or action + In/Out toggle (Return). Pass it as the 7th argument to the `sb.rpc("process_transaction", { ... p_direction })`.
   - Client-side validation: when direction = -1 for Adjustment or Return, check `currentStock(item, godown) >= qty` before the RPC call. Reuse the existing Sale stock-check helper.
   - Update the action color palette in the transactions log to keep what's there (cyan Purchase / emerald Sale / amber Transfer / violet Adjustment / rose Return) but add a small "+ in" / "- out" annotation on Adjustment and Return rows so the log is readable at a glance.

D. **Update PROGRESS.md:** add a new Changelog entry at the top of section 11 with full detail per the existing entry style (what files, why, follow-ups). Also update section 4 to note the new `direction` column on `transactions` and the new `p_direction` parameter on `process_transaction`. Update section 6 "Status — Working" with "Adjustment + Return now live".

E. **Hand the user two manual steps:** (1) paste `phase2-adjustment-return.sql` into Supabase SQL Editor (one paste, one Run click — show them where). (2) drag the updated `transactions/page.tsx` into the GitHub `stock-app-v2/app/transactions/` folder via web UI (Add file → Upload files → drag → Commit).

*Edge cases the fresh chat must handle:*
- The existing v1 (`stock-app/index.html`) does NOT pass `p_direction`. After the migration, v1's existing calls (Purchase/Sale/Transfer) still work because `p_direction` defaults to null and those actions ignore it. v1 cannot use the new actions but doesn't need to. Don't break v1.
- The `reverse_transaction` function (lines 315-345 of phase1-schema.sql) currently builds a reverse-action map. It will need to be updated too: reversing an Adjustment with direction=+1 inserts an Adjustment with direction=-1, and vice versa. Same for Return. Add that to the SQL migration.
- The audit_log trigger should fire on the new `direction` column without changes (it uses `to_jsonb(new)`).

*Estimate:* one session, comfortably. SQL ~100 lines, page.tsx surgical diff ~150 lines.

### 2026-05-14 — Transactions page built (parallel session)
**Cowork session, parallel split with the session that built Godown A/B.**

**Replaced:** `stock-app-v2/app/transactions/page.tsx` (was placeholder, now 647 lines real).

**What it does:**
- Top tab strip with 5 actions: **Purchase, Sale, Transfer** live; **Adjustment, Return** rendered but locked (with `Lock` icon + tooltip) because `process_transaction()` doesn't handle those enum values yet. Locking is a hard `disabled` plus an in-page guard in the submit handler.
- Item picker is a typeahead combobox (no datalist — custom dropdown of up to 30 matches with `onMouseDown` selection to dodge the blur-before-click race). Shows brand, model, size, colour, item_code, and `case×N` annotation.
- Carton + Loose entered separately. Total computed client-side as `cartons * case_size + loose` (or just `loose` if `case_size = 0` — then a single "Quantity" field is shown instead). Live total preview below.
- Action-specific extras: Purchase/Sale expose `Supplier|Customer (text)`, `Invoice no.`, `Rate per unit`. Transfer swaps the single Godown for From/To segmented buttons. Adjustment exposes a Reason dropdown (damage/lost/found/count correction).
- Client-side validation BEFORE calling the RPC: no item picked, qty=0, Transfer From==To, Sale > sourceTotal — each shows a toast and bails.
- Server call: `sb.rpc("process_transaction", { p_item_id, p_action, p_godown, p_qty, p_date, p_note })`. `note` is a joined string of `reason / inv / party / rate` — keeps the schema simple until a separate `notes` column / parties join is plumbed in. (Form has `party_name` free-text since the `parties` table is empty; party_id linkage comes later.)
- After success: cartons/loose/rate/invoice/party/reason reset, but the **selected item + godown + action stay** for fast repeat entry (common when checking in a Purchase line by line). Last action saved to `localStorage["txn.lastAction"]` and restored on next visit.
- Below the form: full transaction log with action filter, free-text search, and per-row Reverse button. Reverse uses `sb.rpc("reverse_transaction", { p_txn_id })`. Reversal rows show "reversal of XXXXXX…" instead of a Reverse button. Originals that have already been reversed show "reversed" greyed out.
- Toast system at bottom-right (auto-dismiss 4s) — green tick for OK, red alert icon for errors.

**Style:** matches godown-view.tsx / items page conventions — Fragments to keep wrappers tidy, `useMemo` for derived state, tabular-nums on all numeric cells, Lucide icons throughout (no emoji), cyan-500 accent, semantic colours per action (cyan Purchase, emerald Sale, amber Transfer, violet Adjustment, rose Return).

**Not touched:** Godown A/B, Items, Dashboard, Pricing, Reports, sidebar, auth, supabase.ts, utils.ts.

**Outstanding follow-ups (next session):**
- Extend `process_transaction()` to handle `Adjustment` (signed delta) and `Return` (links to original by `reverses_id`). Two-line SQL migration.
- Wire `party_id` once `parties` table is populated (currently free-text only).
- Optimistic UI on reverse so the row visibly moves to "reversed" state without waiting for reload.

### 2026-05-14 — Godown A/B pages built + dashboard out-of-stock / dead-stock fixed
**Cowork session, parallel split with another session working on Transactions.**

**New:** `stock-app-v2/components/godown-view.tsx` (~480 lines). A shared component used by both Godown A and Godown B pages. Same UX patterns as the Items page (grid + table view toggle, configurable depth tree grouping, persisted UI state, search auto-expand), but scoped to a single warehouse and showing carton + loose explicitly on every card. Status uses the godown-specific reorder point (`reorder_point_a` or `reorder_point_b`, fallback ≤ 2). New status: "Never stocked here" — items that have no `godown_stock` row in this warehouse. UI state persisted under `godown-a.*` / `godown-b.*` localStorage keys so the two pages remember independent layouts.

**Replaced:** `stock-app-v2/app/godown-a/page.tsx` and `app/godown-b/page.tsx`. Previously "Coming next session" placeholders. Now one-line wrappers around `<GodownView godown="A" />` and `<GodownView godown="B" />`.

**Patched:** `stock-app-v2/app/page.tsx` (dashboard) — four surgical edits.
- State extended with `stockedIds` (items that have a real `godown_stock` row anywhere) and `movedIds` (items with at least one `Sale` in the last 90 days).
- Added a 5th query to the existing `Promise.all`: `transactions.select("item_id").eq("action","Sale").gte("created_at", 90daysAgo)`.
- Out-of-stock KPI + Attention card now require `stockedIds.has(id) && total === 0`. Items that were catalogued but never received are no longer double-counted as "Out of stock".
- Dead-stock Attention card now means "has stock right now but no Sale in last 90 days" (was previously identical to Out-of-stock because no 90-day query existed). Label updated.
- Added a "Never stocked" Attention card so the count that moved out of Out-of-stock is still visible.

**Files touched:** `components/godown-view.tsx` (new); `app/godown-a/page.tsx`, `app/godown-b/page.tsx`, `app/page.tsx` (all modified).

**Not touched:** Items page, Transactions, Pricing, Reports, sidebar, auth, supabase.ts, utils.ts — left clean.

**Verified:** local file structure consistent. Build not run locally (no Node setup); GitHub Actions will compile on push. If `recentSales` query returns 0 rows historically, Dead-stock count = neverStocked count, which is expected for a freshly migrated dataset.

### 2026-05-14 — PROGRESS.md created
**Why:** user asked for a persistent handoff file so future Cowork sessions don't redo work or step on existing changes. File now exists at `Stock Accounting/PROGRESS.md`.

### 2026-05-14 — v2 complete audit + fresh rebuild
**Changes:**
- Created 7 missing pages so sidebar nav never 404s: `pricing/`, `audit/`, `users/`, `settings/`, `reports/sales/`, `reports/abc/`, `reports/dead-stock/`.
- Added `app/not-found.tsx` as a friendly 404 fallback that links back to dashboard.
- Patched `app/providers.tsx` with: a 4-second safety timeout (loading state cannot hang), `onAuthStateChange` as primary path, `getSession()` as fallback, error swallowing.
- User then ran `phase1-migration.sql` in Supabase (added categories table, parties, hsn_code, gst_rate, reorder_point_a/b, etc.).
- User uploaded all 30 files to GitHub at once; Action rebuilt; site verified live.
**Files touched:** all of `stock-app-v2/`.

### 2026-05-13/14 — v2 first deploy + auth hang debugging
- Scaffolded Next.js + Tailwind + Lucide v2 project (`stock-app-v2/`, ~22 files).
- Deployed to GitHub Pages via custom Action (`.github/workflows/deploy.yml`).
- Debugged via Chrome MCP: spinner-forever bug traced to `getSession()` hanging when a stale token sits in localStorage. Patched providers.tsx.
- Discovered the GitHub web-UI drag-drop quirk that omits dot-folders → manually authored `.github/workflows/deploy.yml` via the "Create new file" path.
- Fixed the missing-`package-lock.json` cache error by removing `cache: npm` from setup-node.

### 2026-05-13 — Phase 1.0 schema migration drafted
- Wrote `phase1-migration.sql` that adds categories, parties, HSN/GST/reorder fields, price_history, recompute_stock_levels(). Idempotent. User initially did NOT run it; ran on 2026-05-14.
- Auto-merged category typos: `celing fan`→`ceiling fan`, `standaed fans`→`standard fans`, `wall fan/ceiling fan`→`ceiling fan`.

### 2026-05-13 — v2 visual mockup
- Built `v2-mockup.html` — static preview using Tailwind CDN + Chart.js + Lucide CDN. Demonstrates Linear/Notion design language: sidebar, KPI cards, side panel, command palette overlay, theme toggle. No backend.

### 2026-05-13 — Path decision: hybrid rebuild
- User uploaded `stock_app_upgrade_prompt.md` — comprehensive brief asking for Linear/Notion-quality UI, Tailwind + shadcn/ui, Recharts, Lucide.
- Decision: Path C (Hybrid) — keep v1 live; build v2 in a separate repo + URL; cut over when ready.

### 2026-05-12/13 — v1 feature additions
- Phase 2A: brand column on items, bulk-move with drag chips, light-theme toggle.
- Phase 2B: subcategory column, colour-cell auto-fill with WCAG contrast, UI polish.
- Migrated v1 hosting Netlify → GitHub Pages (one platform). User answered "make repo public" → GitHub Pages enabled.

### 2026-05-11 — v1 first cloud deploy
- Supabase project created at `zvycuhldwfxpipcaeotc.supabase.co`.
- `phase1-bundle.sql` (schema + 267 transactions + 166 items + 81 prices + 85 stock rows) pasted into SQL Editor and run.
- Diagnosed and fixed audit_trigger_fn `cannot cast type items to jsonb` error (used `to_jsonb(old)` / `to_jsonb(new)`).
- Fixed `handle_new_user()` schema-search-path bug ("Database error saving new user").
- v1 first signed-up admin = harsh.j111186@gmail.com.

### 2026-05-11 — v1 single-file HTML prototype + Excel migration
- Read `stock entry.xlsm`: 8 sheets (2 hidden), VBA macros decoded (ProcessPending, ReverseOneRow, MirrorNewItems, etc.).
- Migrated 166 items + 89 stock rows + 81 prices + 268 transactions to `migrated-data.json`.
- Built local-only HTML prototype as a feel test.

---

## 12. Quick references

**SQL queries you'll run often:**
```sql
-- Count everything
select
  (select count(*) from items) as items,
  (select count(*) from categories) as categories,
  (select count(*) from godown_stock) as stock_rows,
  (select count(*) from pricing) as priced,
  (select count(*) from transactions) as txns,
  (select count(*) from user_profiles) as users;

-- See recent audit
select occurred_at, table_name, operation, row_id
from audit_log
order by occurred_at desc
limit 20;
```

**The user's anon Supabase key** is in `.github/workflows/deploy.yml` env block as a fallback, and stored as the `SUPABASE_ANON_KEY` GitHub secret. Anon keys are safe to expose by design (RLS enforces permissions).

**Service-role key** — user has it in their notes but DON'T ASK FOR IT. We never need it from the client side.

---

*End of PROGRESS.md. If you're an AI session and you've read this, you're ready to work. Update the Changelog when you're done.*
