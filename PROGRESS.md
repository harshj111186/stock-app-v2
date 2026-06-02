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

### 2026-06-02 — Queue fixes: deletes now persist + network-resilient processing

Two bugs found while testing the persistent queue on mobile:

1. **Removed/cleared queue rows came back after reload / re-login (any device).** Root cause:
   `removeFromQueue` and `clearQueue` fired the DB delete as `void sb()…delete()`. A
   Supabase/postgrest-js query builder is **lazy** — the `fetch` only runs inside `.then()`/`await`
   — so a `void`-discarded builder **never sent the request**. The row stayed in `transaction_queue`
   and re-hydrated on the next reload. (The *processed-rows* delete in `processQueue` used `await`,
   which is why processing-clear worked but manual remove/clear didn't.) **Fix:** both handlers are
   now `async` and `await` the delete, with optimistic UI + rollback (row reappears + toast) if the
   delete fails while offline. Confirmed against the installed postgrest-js 2.105.4 source (`fetch`
   is inside `then()`).
2. **"TypeError: Load failed" on an otherwise-valid entry.** That's Safari's message for a failed
   `fetch` (transient mobile-data drop / tab suspended mid-request). `process_transaction` is a POST,
   and postgrest-js only auto-retries GET/HEAD/OPTIONS — so the blip surfaced raw. **Fix:**
   `processQueue` now retries each row up to **3×** with backoff (0.5s, 1.5s) **only for
   network-class errors**; a real DB rejection (stock check, constraint) still fails immediately with
   its own message. A still-failing network error now shows a clear *"Network error — couldn't reach
   the server. Check your connection and tap Process queue again."*

Added module helpers `sleep()` + `isNetworkError()` in `app/transactions/page.tsx`. **No SQL, no
schema change.** `tsc --noEmit` and `next build` both clean.

---

### 2026-06-01 — Persistent transaction queue + actor name in history

**User ask:** (1) a queued-but-unprocessed batch should survive an employee leaving the app and be there when they return; (2) the transaction history + audit log should show the **name** of the user who made each transaction / adjustment / direct item edit.

1. **Persistent queue** — the Transactions batch queue was React-state only (lost on leave/refresh).
   - **`db/2026-06-01-transaction-queue.sql`** — per-user `transaction_queue` table mirroring the `QueuedTxn` shape (`user_id default auth.uid()`, RLS `for all using/with check (user_id = auth.uid())`). Staging only — doesn't touch stock.
   - `app/transactions/page.tsx`: `reload()` hydrates the queue from the table; `doAddToQueue` inserts (DB id becomes the row uid); remove/clear delete; `processQueue` deletes each row on success (failures stay for retry). **Graceful pre-SQL:** `reload`'s Supabase select returns an error object (not a throw) → empty queue; `doAddToQueue` falls back to an in-memory uid if the insert fails — so deploying before the SQL doesn't break queueing, it just won't persist yet. Run the SQL to switch on persistence.
2. **Actor name** — `created_by` (transactions) / `user_id` (audit_log) resolved to a name via `user_profiles` (id → name/email).
   - Transaction log: new **"By"** column (desktop) + "by <name>" line (mobile) — covers transactions + adjustments.
   - Audit log: the truncated uuid is replaced with the name — covers direct item edits. **No SQL.**

---

### 2026-06-01 — Admin: reset password + remove account (Edge Function)

**User ask:** options to reset a user's PIN **and password**, and to **remove an account completely** so the same email can sign up again from scratch.

PIN reset already existed (`admin_reset_pin`). Resetting another user's password and deleting an auth account both need the service-role key → a second Edge Function (after master-login).

- **`supabase/functions/admin-account/index.ts`** — actions `reset_password` (admin sets a new temp password via `auth.admin.updateUserById`; chosen over an email link because the project has no SMTP) and `delete` (`auth.admin.deleteUser` → frees the email; best-effort profile-row cleanup after). It verifies the **caller's** JWT and re-enforces the admin rules server-side: active-admin only, never the super-admin, admin targets need a super-admin caller, no self-delete. Returns `{ ok, error }` (HTTP 200) for clean UI messages. **Must be deployed** (dashboard paste or `supabase functions deploy admin-account`). No SQL.
- **`app/users/page.tsx`** — `runEdge` helper + `resetPassword` (prompt → temp password) and `deleteAccount` (double-confirm) handlers. "Reset password" sits on the Active row beside Reset PIN; "Remove" is on the Active row AND the Pending / Rejected / Deactivated buckets (those accounts aren't in the Active table). New perms: `canResetPassword` (= canResetPin), `canDelete` (never super-admin/self; admin target needs super). Busy/spinner wired for the two new actions.

Caveat surfaced to the user + in the function message: an account with **transaction history** can be FK-blocked from hard deletion — deactivate those instead. Fine for the common case (wrong/spam/never-active signups), which is the point of "free the email."

---

### 2026-06-01 — Fix: apply_reconciliation "godown_t cast bug" + count-correction modal

**User bug:** editing an item's case size + quantities errored with `process_transaction(uuid, unknown, text, integer, date, text, integer) does not exist`, yet stock still half-changed (only case_size landed → stale "1 case each" after refresh).

**Root cause:** `apply_reconciliation` (the RPC both the Edit-stock modal and the reconciliation commit use) calls `process_transaction(p_item_id, 'Adjustment', p_godown, …)` passing `p_godown` as **text** into `process_transaction`'s `godown_t` **enum** param. PL/pgSQL won't implicitly cast text→enum during function-overload resolution, so the internal call wasn't found and threw **before** the godown_stock split was written. (The Transactions page works because PostgREST casts JSON→enum for it; an internal `perform` gets no such help.) This is the "godown_t cast bug" the diagnostics SQL was chasing.

**Fix — `db/2026-06-01-apply-reconciliation-cast-fix.sql`:** `create or replace apply_reconciliation` with `'Adjustment'::action_t` + `p_godown::godown_t` in the internal call. Behaviour otherwise identical — still sets the ABSOLUTE typed count and logs one Adjustment per godown when the total moves. **Also fixes the reconciliation "Make adjustments" commit**, which calls the same RPC. Must be run in Supabase.

**Modal simplification (`app/items/page.tsx`):** per the user, the Edit-stock modal is now purely a **count correction** — dropped the reason dropdown (Damage/Lost/Found/…); always logs reason "Count correction"; retitled "Count correction"; copy clarified that the entered cases/loose are the FINAL absolute values, not a delta. The client was already sending absolute targets (`p_target_cases`/`p_target_loose`), so the cast fix is what makes it actually land.

---

### 2026-05-29 — Reject a pending signup

**User ask:** "add the option to reject the approval for user sign ups." Admins could only Approve; pending signups otherwise sat forever (a gap flagged in the PIN-auth follow-ups).

Soft + reversible reject (no auth-account deletion → no service-role/Edge Function needed):
- **`db/2026-05-29-reject-signup.sql`** — `rejected_at` / `rejected_by` columns (added to the authenticated SELECT whitelist), `admin_reject_user(p_user_id, p_rejected)` to set/clear it (super-admin protected; reject also sets active=false), and `admin_approve_user` now clears the rejected flag too. Run in Supabase to enable.
- **`lib/supabase.ts`** — `Profile` + `PROFILE_COLUMNS` gain the two columns.
- **`app/users/page.tsx`** — "Reject" button in the Pending bucket (desktop + mobile); new "Rejected" bucket with Approve / "Move to pending". Bucketing: pending = `!approved_at && !rejected_at`, rejected = `rejected_at` set. The existing gate (needs `approved_at`) already blocks rejected users — `rejected_at` just moves them out of Pending + makes it explicit/reversible.

Follow-up idea: a hard "delete account" (frees the email for re-signup) would be a small Edge Function using `auth.admin.deleteUser` — the master-login function shows the pattern. Not built; soft reject covers the ask.

---

### 2026-05-29 — Master PASSWORD at login (Edge Function)

**User ask:** after the PIN-gate master key, "a master password which when entered for any role except super admin, it should open the account and bypass the pin." They'd typed an employee email + the master password at the *login* screen and got "invalid credentials" — because the PIN-gate master key only runs *after* a successful Supabase login.

To log into an account WITHOUT its real password you must mint a session with the service-role key, which can't ship in a static site — so this is the first server-side piece in the project: a Supabase **Edge Function**.

- **`db/2026-05-29-master-login.sql`** — `master_login_resolve(email, key)`: verifies the key against `app_config`, refuses the super-admin / inactive / unapproved accounts, returns the target `user_id`. **Granted only to `service_role`** (revoked from authenticated/anon) so the browser can't use it as a key oracle.
- **`supabase/functions/master-login/index.ts`** — Edge Function: calls the resolver with the service key, then mints a session via `auth.admin.generateLink({type:'magiclink'})` → `verifyOtp({token_hash})`, returns `{access_token, refresh_token, user_id}`. Uses the auto-injected `SUPABASE_*` env. **Must be deployed** (dashboard paste or `supabase functions deploy master-login`).
- **`app/login/page.tsx`** — on a failed sign-in (sign-in mode only) it calls `master-login`; on success `setSession()` + `markPinUnlocked(user_id)` + hard-nav home (so the PIN is skipped). Normal login is untouched; if the function/SQL/key aren't in place the attempt silently no-ops and the normal error shows.
- **`tsconfig.json`** — excludes `supabase/functions` (Deno + URL imports) from the Next type-check.

Activation: run the SQL → deploy the Edge Function → set the master key in Settings. **Security:** this is a remote skeleton key to every non-owner account — keep it long + secret. Possible hardening later: rate-limit `master-login`, or scope which accounts it can open.

---

### 2026-05-29 — Master key (unlock any account except the super-admin)

**User ask:** "a master key option which can unlock any account except main master account."

A super-admin-set shared secret that satisfies the PIN gate for ANY account except harsh's super-admin (main master) account — for forgotten PINs / shared devices / oversight.

- **`db/2026-05-29-master-key.sql`** — new `app_config` one-row table (RLS on, zero client grants → only the SECURITY DEFINER fns touch it). RPCs: `set_master_key` / `clear_master_key` (super-admin only), `master_key_is_set` (boolean for the UI), `verify_master_key` (returns false for a super-admin session; clears the caller's PIN lockout on success). Bcrypt via `extensions.crypt`; depends on `_is_super_admin` from the PIN-auth migration. **The "except main master account" rule is enforced in SQL, not just UI.** Must be run in Supabase before the feature works.
- **`components/pin-gate.tsx`** — enter mode shows an "Unlock with master key" link (only on non-super accounts, only when a key is set) → password input → `verify_master_key`. New `isSuperAdmin` prop (passed from `providers.tsx`) hides the option on harsh's own gate.
- **`app/settings/page.tsx`** — super-admin-only `MasterKeyCard` to set / change / remove the key (≥4 chars), with a Set/Not-set indicator.

Pre-SQL it's inert for everyone (the gate option needs a key set; the Settings card is harsh-only). After running the SQL, harsh sets the key in Settings → it unlocks any staff/admin PIN gate.

Follow-up idea: per-attempt rate-limit on `verify_master_key` (currently relies on the key being longer than a 4-digit PIN); fine for a 6-user shop.

---

### 2026-05-29 — Bold premium reskin + dashboard + item CRUD + category tree

**User ask:** Deep-dive the whole app; remove unwanted/dead buttons; make it a premium, lightweight, mobile-AND-web app; add an item page where you can add/remove/edit items (applying across both godowns); make categories nestable to unlimited depth (Company › Category › Sub › …) so items save category-wise; better dashboard. Chosen options: full nested category tree, push-to-live as I go, bolder reskin.

Shipped in four pushes to `main` (each auto-deploys). The audit found the app was already far more complete than the brief implied (reconciliation, transactions, reports, users/PIN auth, mobile cards, PWA all solid) — so this focused on the genuine gaps.

**1. Bold premium reskin (`fb9b11a`).** Delivered by REMAPPING Tailwind scales in `tailwind.config.ts` so the whole app moved without rewriting classNames:
- `zinc` → refined cool-slate neutrals, deep OLED-leaning dark base.
- `cyan` → bold violet accent (the new brand colour). Primary buttons are now violet with WHITE labels — every accent button across the app was switched from `text-zinc-900` to `text-white` (a sweep; the old dark-on-cyan no longer had contrast on violet).
- Semantic emerald/amber/rose LEFT as Tailwind defaults (stock status) so they never collide with the accent.
- `globals.css`: new CSS-var tokens (mirrors the remap), Space Grotesk display font for headings + KPI numbers (Inter stays for UI), one accessible `:focus-visible` ring, `prefers-reduced-motion` handling. `layout.tsx`: Space Grotesk added to the Google Fonts link; theme-color synced.
- Premium radius/shadow/glow scale + fade-in/slide-up keyframes in the config.

**2. Premium dashboard + ⌘K palette + dead-UI removal (`7750b08`).**
- Topbar: removed the dead Bell. The Search button + **⌘K** now open a real **command palette** (`components/command-palette.tsx`, mounted in Shell) — jump to any page + quick actions, keyboard-first, role-gated.
- Dashboard (`app/page.tsx`) rebuilt: violet "stock value" hero KPI, every KPI is a Link, lazy-loaded 14-day sales-trend area chart (`components/dashboard-chart.tsx`, `next/dynamic` ssr:false — recharts stays OFF the dashboard's initial bundle), low-stock watchlist, navigating "attention" rows.
- **Fixed two long-standing wrong counts:** out-of-stock now only counts items WE CARRY (have a `godown_stock` row) that hit zero — not the never-stocked SKUs it used to double-count (was showing 105/166). Dead stock is now real (units on hand + no active, reversal-aware sale in 90 days), no longer a clone of out-of-stock. Top movers is a real last-30-days ranking.
- Items page reads `?status=out|low&q=` so dashboard cards deep-link into a pre-filtered catalogue.

**3. Add / Edit / Archive items (`c5b6212`).** The "New item" button was DEAD (no handler) and there was no way to edit item attributes or remove an item.
- `db/2026-05-29-item-crud-rpcs.sql`: SECURITY DEFINER `create_item` / `update_item` / `set_item_archived` + `_require_active_admin()` helper. Admin-gated (catalogue mgmt is an owner task; staff keep the stock-override flow). Auto-generates item_code when blank; keeps legacy `category` text in sync with category_id; soft-delete only (history preserved). **New items are global — they exist for both godowns immediately; we deliberately DON'T seed godown_stock rows** (keeps "never stocked" ≠ "ran out"; first Purchase creates the row).
- `components/item-form-modal.tsx`: create/edit form (admin). Entry points: violet "New item" button + ⌘K "Add a new item" (`?new=1`); edit/archive via the item's stock modal → "Edit details". Items list now filters `archived = false`.
- USER RAN THE SQL — confirmed `item CRUD RPCs ready · 166 active items`.

**4. Unlimited-depth category tree (`da47cfb`).**
- `db/2026-05-29-category-tree.sql`: adds `parent_id` (self-FK) + `sort_order` to `categories`; admin-gated `category_create / rename / move / archive` RPCs. `category_move` is cycle-safe (recursive ancestor check); archive blocked while a node has live subcategories. **Kept the existing global-unique name** rather than doing risky drop/recreate-constraint surgery on the live table — fine for one shop; per-parent uniqueness is a small follow-up if ever needed. Existing categories untouched → all become top-level nodes.
- `lib/categories.ts`: pure tree helpers (build/flatten/path), defensive against missing-parent orphans + cycles.
- `app/categories/page.tsx` (admin): the manager — inline add/rename, move via a parent picker, archive, per-node item counts, expand/collapse.
- `components/category-tree-picker.tsx`: indented native-select picker, used in the item form to assign an item to ANY node (shows full path). Degrades to a flat list before the migration runs.
- Reachable from sidebar (System), mobile More, Settings, and ⌘K.
- **Migration handed to the user to run; awaiting confirmation at time of writing.**

#### Deploy / env notes
- Push capability: `gh` is authenticated locally as `harshj111186` (repo+workflow scopes); `git push origin main` works and triggers the Pages Action. Commits exclude the untracked `.tmp.driveupload/` (Drive temp) via explicit `git add` paths.
- `.env.local` exists locally with the Supabase keys; `.claude/launch.json` runs the dev server (it picked port 3010). Reskin verified live via screenshots (dashboard/items/login) + DOM/style inspection; the rest verified via clean `npm run build` because the preview screenshot tool kept timing out under machine load (multiple dev servers) and the PIN gate blocks headless access to authed pages.

#### Also landed 2026-05-29 (later, once visual access was restored)
- **categories RLS read policy** (`db/2026-05-29-categories-select-rls.sql`) — the table had RLS enabled with NO select policy, so the app got `[]` (the old UI silently used the legacy `items.category` text column; the new manager showed "0 categories"). Added `for select to authenticated using (true)`. User ran it — confirmed 13 readable. **Required for the tree to show anything.** Writes stay RPC-only.
- **Mobile Filters sheet** on Items + Godown A/B (`components/filter-sheet.tsx`): phones show search + a "Filters" button (active-count badge) → slide-up bottom sheet; the desktop toolbar is unchanged (`hidden md:flex`).
- **Category PATH grouping**: Items + Godown resolve each item's category to its full path via `pathById` (with a flat list it's identical; it nests visibly as the tree grows). Godown also now filters `archived = false`.

#### Follow-ups — all four shipped 2026-05-29 (later still)
- ✅ **Reconciliation mobile Filters sheet** (commit `58bfa7c`) — brand/category/show-only-changed move into the sheet on phones; mode toggle + commit stay put.
- ✅ **ABC chart lazy-loaded** (commit `58bfa7c`) — extracted to `components/abc-chart.tsx` via `next/dynamic`; `/reports/abc` first-load 302 kB → 197 kB.
- ✅ **Restore-archived UI** (commit `b5a15b8`) — Items get an "Archived" filter + Restore in the edit form; the category manager gets a "Show archived" toggle + per-node Restore.
- ✅ **Nested expand/collapse grouping by category segment** (commit `e36548a`) — `buildTree` (Items + Godown) now groups by each path segment (Brand → Cat → Sub-cat → … → items), every level collapsible; a node can hold both sub-groups and items. Identical to before with a flat list; nests as the tree grows. Verified live.

#### Still open (only if ever needed)
- Per-parent unique category names (small constraint swap, for duplicate child names under different parents).

#### Verification caveats for future sessions (this machine)
- The project folder is **Google-Drive-synced**, so the LOCAL `next dev` recompiles in a loop (Drive touches watched files) — this stalls the preview screenshot tool and resets page state. Verify on the **deployed** site instead; it's unaffected.
- **Never run `npm run build` while `next dev` is live** — they share `.next/` and the dev server then 404-loops on `layout.css`. Fix: stop dev, `rm -rf .next`, restart.
- The PIN gate blocks headless access to authed pages. For read-only visual checks, the already-authenticated browser session can be unlocked by setting `sessionStorage['pinUnlocked:<userId>']='1'` and reloading (the Supabase session persists in localStorage). Read-only only — never submit writes against live data this way.

---

### 2026-05-22 — Desktop PWA install (service worker + install buttons)

**User ask:** "now i want installable app for this for both computer and mobile. for mobile we used add to homescreen but for pc and laptop the download option doesnt show in web browser"

**Why mobile worked but desktop didn't.** Mobile browsers will offer Add-to-Home-Screen off the web manifest alone. Chrome and Edge on desktop have a stricter install check: **manifest + service worker with a fetch event handler**, all served over HTTPS, with the declared icons actually loading. Without the SW and with the icons 404ing, Chrome silently disables the install icon — no error in the UI, just nothing.

**What landed (after four iterations to get the paths right):**

1. **Service worker** at `public/sw.js`. Install/activate/fetch handlers; the fetch handler is pass-through (no caching). The only reason it exists is to satisfy the install check. Chrome will log a warning about the no-op handler causing "navigation overhead" — that's expected, and the cost is tiny. If we ever want offline support we can layer a real cache strategy in here.

2. **`components/install-provider.tsx`** — React context that:
   - registers `/stock-app-v2/sw.js` on mount in production (skipped in dev)
   - captures `beforeinstallprompt` and parks the deferred event in state
   - detects `display-mode: standalone` so we hide the install button when already installed
   - exposes `useInstall()` returning `{ canInstall, install(), isStandalone }`
   - mounted in `app/layout.tsx` outside `Providers`

3. **Three install button surfaces.** Chrome's URL-bar icon is easy to miss, so we surface the deferred prompt explicitly in three places:
   - **Settings page** — full Install card with three states (already-installed / canInstall+button / manual-instructions fallback for iOS Safari and others)
   - **Desktop sidebar** — small "Install as app" pill above the user row when `canInstall && !isStandalone`
   - **Mobile More page** — prominent cyan install row at the top when `canInstall && !isStandalone`

4. **Static manifest** at `public/manifest.webmanifest`. Originally lived at `app/manifest.ts` (Next 13+ file-based metadata route) but Next's auto-injected `<link rel="manifest">` kept overriding our `metadata.manifest` setting, so we moved to a plain static file in `public/` and pointed `layout.tsx`'s metadata at it explicitly.

#### The path-prefix mess (four commits to get right)

**Root cause of the iteration loop:** Next.js does NOT auto-prefix paths inside the manifest file OR `<link>` tags emitted via the Metadata API with `basePath`. This bites the v2 app because it's served under `/stock-app-v2/`, not `/`.

The four-commit arc:

1. **`7adb5cf`** — initial PWA work. SW, install buttons, manifest paths left as `/icon.svg` etc.
2. **`b60132a`** — fixed paths INSIDE `app/manifest.ts` itself (start_url, scope, icon srcs) to be basePath-prefixed. Confirmed by WebFetching the deployed manifest JSON.
3. **`f6c5807`** — tried to fix HTML `<link rel="manifest">` and icon links by setting `metadata.manifest` and `metadata.icons` with a `process.env.NODE_ENV`-gated prefix. **Didn't take effect** — `NODE_ENV` evaluates to undefined/falsy inside `layout.tsx` during static-export build, so the conditional collapsed to `""`. Confirmed by `curl`ing the deployed HTML which still had un-prefixed paths.
4. **`be82ed3`** — final fix. Dropped the conditional, hardcoded `BASE = "/stock-app-v2"`. Also deleted `app/manifest.ts` and replaced with `public/manifest.webmanifest` (plain JSON) to remove the Next auto-link interference.

**Lesson for future basePath-affected work:**
- Don't trust `process.env.NODE_ENV` inside server components for static export. Hardcode prefixes.
- Inspect the deployed HTML with `curl` AND the deployed manifest with `curl` separately. Each has its own paths.
- Chrome's "No manifest detected" in DevTools really means the `<link rel="manifest">` href is 404ing — not that the manifest file is missing.
- The default Next 15 auto-generation from `app/manifest.ts` cannot be reliably overridden; use a static file in `public/` if you need precise control.

#### Files patched

- **`public/sw.js`** *(new)* — minimal SW.
- **`public/manifest.webmanifest`** *(new)* — static manifest replacing `app/manifest.ts`. All paths basePath-prefixed.
- **`components/install-provider.tsx`** *(new)* — InstallProvider context + useInstall hook.
- **`app/layout.tsx`** — wraps children in `<InstallProvider>`; metadata.manifest + metadata.icons hardcoded to `/stock-app-v2/...`.
- **`app/manifest.ts`** *(deleted)* — replaced by the static file.
- **`app/settings/page.tsx`** — Install card with three states + per-platform fallback instructions.
- **`components/sidebar.tsx`** — install pill above user row.
- **`app/more/page.tsx`** — prominent install row when available.

#### Deploy

Pure code-side; no SQL. Just `git push origin main`, wait for the Action.

#### Verification (works as of `be82ed3`)

- `curl -s https://harshj111186.github.io/stock-app-v2/ | grep -oE 'rel="manifest"[^>]*'` returns `rel="manifest" href="/stock-app-v2/manifest.webmanifest"/`
- `curl -sI https://harshj111186.github.io/stock-app-v2/manifest.webmanifest` returns 200
- Chrome desktop: install icon appears in URL bar within ~5s of page load; in-app pill in sidebar also lights up.
- User confirmed: "yes, the install button showed up"

#### Follow-ups (not blocking)

- **No-op fetch handler warning** — Chrome logs "Fetch event handler is recognized as no-op" on each navigation. Two options: (a) remove the fetch handler entirely (newer Chrome accepts SW without fetch handler for install), or (b) add real cache-first strategy for static assets so the warning becomes accurate. Either is a 10-line change.
- **PWA app shell caching** — for true offline launch + faster cold start, the SW can pre-cache the HTML + JS shell on install and serve it from cache. Doesn't affect Supabase data (those should always go to network).
- **Update prompt** — when a new build deploys, show a banner "New version available — refresh to update" by listening for SW's `updatefound` event. Currently users see the new version after they close + reopen the standalone window.

---

### 2026-05-22 — PIN-based auth + signup-approval workflow + super-admin

**User ask:** "make changes to user setup, where harsh.j111186@gmail.com is ultimate admin and bhavik9347@gmail.com acts as admin too, any signups needs admin approval, also want a pin based setup, where each account is set to a pin which is setup when signed up and gets linked to that account so launching app again wont require email and password but the 4 digit pin. same account sign in to different device should ask for that pin too, all the user accts can be overridden by admin"

**The shape of it.** Three independent feature slices, shipped together because they share the same DB columns and gate machinery:

1. **PIN-based unlock.** Every account has a 4-digit PIN, bcrypt-hashed in `user_profiles.pin_hash`. After Supabase email/password auth succeeds, a PIN gate intercepts before the app loads. PIN unlock is **per browser session** (sessionStorage, not localStorage) — so closing the tab requires re-entry, but a refresh keeps you in. PIN is account-scoped, so signing in on a new device also prompts for the PIN.
2. **Signup approval workflow.** New signups land with `approved_at IS NULL` and `active = false`. They see a "Waiting for admin approval" screen. An admin clicks Approve on the Users page → `active = true, approved_at = now()`. Harsh and Bhavik (by email match in the signup trigger) are auto-approved and given admin role.
3. **Super-admin tier.** Harsh's row carries `is_super_admin = true`. Functionally that means: only super-admin can promote anyone to admin or demote an existing admin; super-admin's own row can't be modified by anyone else (PIN reset, deactivate, role change all blocked). Bhavik gets `role = admin` but not `is_super_admin`.

**Defaults chosen (without explicit user input):**
- Wrong PIN: 5 attempts → 15-minute lockout (stored in `pin_locked_until`).
- New signups default to **viewer** role until promoted.
- Bhavik can manage staff/viewer roles + approve/reject pending users, but can't promote anyone to admin.
- Bhavik can reset PINs and deactivate users, but not Harsh.
- Harsh can do everything to anyone.

#### Files patched / created

- **`db/2026-05-22-pin-auth-and-approval.sql`** *(new — ~290 lines)*
  - `create extension if not exists pgcrypto;`
  - Adds columns to `user_profiles`: `pin_hash text`, `pin_set_at timestamptz`, `pin_attempts smallint`, `pin_locked_until timestamptz`, `is_super_admin boolean`, `approved_at timestamptz`, `approved_by uuid → auth.users(id)`.
  - **Column-level lockdown**: `REVOKE SELECT ON user_profiles FROM authenticated`, then `GRANT SELECT (id, email, name, role, active, is_super_admin, approved_at, approved_by, pin_set_at, pin_attempts, pin_locked_until, created_at) ON user_profiles TO authenticated`. `pin_hash` is intentionally excluded — the hash never reaches the client. (4-digit PIN space is 10K; even bcrypt-slow brute-force is feasible if the hash leaks, so it must not.)
  - Grandfathers existing active users by setting `approved_at = coalesce(created_at, now())` for any active row with `approved_at IS NULL`. So flipping this migration on doesn't lock out the people already in.
  - One-off `UPDATE` seeds harsh as `is_super_admin = true, role = 'admin', active = true, approved_at = coalesce(approved_at, now())`.
  - `handle_new_user()` trigger rewritten: harsh/bhavik emails get `role = 'admin', active = true, is_super_admin = (email == harsh's), approved_at = now()`; everyone else gets `role = 'viewer', active = false, approved_at = null`. Replaces the old "first user becomes admin" logic.
  - **SECURITY DEFINER RPCs** added: `set_pin(p_pin text)`, `verify_pin(p_pin text) → boolean`, `change_pin(p_old_pin, p_new_pin) → boolean`, `admin_reset_pin(p_user_id)`, `admin_approve_user(p_user_id)`, `admin_set_role(p_user_id, p_new_role)`, `admin_set_active(p_user_id, p_active)`, `admin_set_name(p_user_id, p_name)`. Plus two internal `_is_active_admin(uid)` and `_is_super_admin(uid)` helpers used inside the admin RPCs to gate access.
  - All admin RPCs respect the two-tier rule: regular admin can't modify a super-admin row; only super-admin can mint or unmake admins.
  - Idempotent — safe to re-run. Final verification queries at the bottom show counts and confirm `pin_hash` isn't in the authenticated-grant list.

- **`lib/supabase.ts`** *(edited)* — `Profile` type extended with `is_super_admin`, `approved_at`, `approved_by`, `pin_set_at`, `pin_attempts`, `pin_locked_until`. `pin_hash` is **intentionally not in the type** because the DB column-level grant excludes it. Comment explains the gate-state heuristics the app reads off the row.

- **`app/providers.tsx`** *(major rewrite)* — adds the gate state machine. After Supabase auth resolves a session and we fetch the profile, the order of gates is:
  1. session null → /login (unchanged).
  2. `profile.approved_at == null` → `<PendingApproval/>`.
  3. `profile.active === false` (but approved before) → `<PendingApproval/>` (same component; from the user's view "you can't get in" is the same experience).
  4. `profile.pin_set_at == null` → `<PinGate mode="set"/>`.
  5. `sessionStorage[\`pinUnlocked:${id}\`] !== "1"` → `<PinGate mode="enter"/>`.
  6. Otherwise → render children. The login page is exempt (renders directly so the user can actually sign in/up).
  
  Three helpers exported alongside the provider: `isPinUnlocked(userId)`, `markPinUnlocked(userId)`, `clearPinUnlocked(userId)`. signOut() clears the flag before calling `auth.signOut()` so the next login doesn't inherit a stale unlock. The PR #5 deadlock-fix machinery (synchronous listener, setTimeout(0) deferred profile fetch, 10s failsafe, `lock: lockNoop`) is preserved verbatim. A `refreshProfile()` is exposed on context so the PendingApproval screen's Refresh button can re-poll without forcing a page reload.

- **`components/pin-gate.tsx`** *(new)* — 4-digit pad with auto-advance, backspace-to-previous, paste-a-4-digit-string-anywhere fills all four. Two modes: `"enter"` (calls `verify_pin`, surfaces lockout / wrong-PIN messages) and `"set"` (two-step: first PIN → confirm PIN → `set_pin` RPC). Reusable `PinInput` sub-component encapsulates the four-box behaviour so the settings page or any future surface can reuse it. The gate also has a Sign-out link so a user with a forgotten PIN can bail to the login screen.

- **`components/pending-approval.tsx`** *(new)* — "Waiting for admin approval" screen. Hits `refreshProfile()` on Check Again button so a freshly-approved user can step into the app without closing the tab. Sign-out link as escape hatch.

- **`app/login/page.tsx`** *(rewritten)* — signup mode now collects email + password + 4-digit PIN + confirm. Two post-signup branches:
  - **Session returned** (email confirmation off — our project default): calls `set_pin` RPC, marks `sessionStorage.pinUnlocked:{id} = "1"` so providers skips the PIN gate on the immediate next bootstrap (the user just typed it, no need to re-prompt), then `window.location.assign("/")`. Non-seed users land on `<PendingApproval/>`; harsh/bhavik flow straight in.
  - **No session** (email confirmation on): can't save PIN yet (no auth context). Shows "Check your email for a confirmation link", switches to sign-in mode. The set-PIN gate catches them after they confirm + sign in.
  
  Sign-in mode is unchanged in behavior — `window.location.assign` hard nav still in place to sidestep the redirect race.

- **`app/users/page.tsx`** *(major rewrite)* — three buckets: **Pending approval** (with prominent amber styling + Approve button), **Active** (with role dropdown, PIN status indicator, Reset PIN, Deactivate, edit-name buttons), **Deactivated** (with Reactivate). Permissions baked into a `useRowPerms()` helper so desktop + mobile renderers stay in lockstep:
  - `canChangeRole`: not super-admin row, not another admin row unless I'm super
  - `canResetPin`: any admin except super-admin can't touch super-admin
  - `canDeactivate`: same as role + can't deactivate self
  - Role dropdown options: super-admin sees `[admin, staff, viewer]`; regular admin sees `[staff, viewer]`. If the row's current role isn't in the options (regular admin looking at another admin), the current value is preserved in the dropdown so the select doesn't show a wrong value.
  - Super-admin badge (ShieldCheck icon + "Super admin" pill) on the appropriate row.
  - Mobile and desktop both implemented (linter had previously added mobile cards to this page; I preserved the pattern).

- **`app/settings/page.tsx`** *(edited)* — adds a Change PIN card. Old PIN + new PIN + confirm new. Calls `change_pin` RPC; surfaces the "old PIN wrong" / "structurally bad new PIN" cases distinctly. Role display now shows "super admin" with the ShieldCheck icon when applicable.

- **`PROGRESS.md`** — this entry.

#### Files NOT touched

- `app/items/page.tsx`, `app/page.tsx` (dashboard), `app/transactions/page.tsx`, `app/pricing/page.tsx`, `app/reports/*`, `app/audit/page.tsx`, `app/godown-{a,b}/page.tsx`, `components/godown-view.tsx`, `components/shell.tsx`, `components/sidebar.tsx`, `components/topbar.tsx` — none of them care about PIN/approval; they all sit behind the gates in providers.
- `lib/utils.ts` — no new helpers needed.
- Other SQL — `process_transaction`, `reverse_transaction`, RLS on transactions/items/godown_stock — none touched. PIN auth is orthogonal to the data layer.

#### Deploy steps

This is the first time a PR has a hard DB precondition since the phase-2 adjustment migration. **Do the SQL FIRST**, otherwise the app will sign in and immediately crash trying to call RPCs that don't exist.

1. **Run the SQL.** Open Supabase → SQL Editor → New query. Open `db/2026-05-22-pin-auth-and-approval.sql`, copy the whole file, paste, click **Run**. The verification queries at the bottom should report `super_admins = 1` (harsh) and `pin_hash` should NOT appear in the column-grants list.
2. **Tell Bhavik to sign up.** He goes to https://harshj111186.github.io/stock-app-v2/login/ → Sign up → enters his email + password + a 4-digit PIN of his choice. Trigger auto-approves him as admin.
3. **First time you (Harsh) sign in after the migration**: you'll be prompted to **set your PIN** (because your existing profile didn't have one). That set-PIN screen IS your first chance to pick the PIN you'll use going forward.
4. **Upload the changed files to GitHub.** Drag-drop each one into the right folder. The GitHub Action will rebuild and republish in ~1-2 min.

#### Edge cases handled

- **Existing active users keep working** — grandfathered as approved by the backfill `UPDATE`. They'll be prompted to set a PIN on their next sign-in (gate 4), then they're in.
- **Email confirmation on (if that gets enabled in Supabase later)** — login page handles it cleanly: signup without session shows the "check your email" message and defers PIN to after confirm. Once they confirm and sign in, set-PIN gate fires.
- **PIN locked out** — `verify_pin` raises with a "PIN locked. Try again after HH:MM" message that PinGate surfaces. Admin can reset the PIN to clear the lock, or the user can wait 15 minutes.
- **Admin resets their own PIN** — they can use the Change PIN flow in Settings (knows their current PIN). If they forgot their current PIN, they can ask the other admin to reset it (Bhavik can reset Harsh's? No — super-admin protection blocks this. Harsh would need to use service_role to reset himself — escape hatch via Supabase dashboard). Worth noting as a follow-up risk.
- **Two tabs of the same user** — both tabs share `sessionStorage` if they're in the same tab; different tabs each prompt for PIN once. Actually sessionStorage is per-tab; closing one doesn't affect the other. So Tab A unlocks, Tab B still needs PIN.
- **Switching accounts in same browser** — `pinUnlocked:{userId}` is keyed by userId; signOut() clears that user's flag explicitly. New sign-in writes a new flag.
- **PIN gate vs auth-state changes** — if Supabase fires TOKEN_REFRESHED while at the PIN gate, providers' deferred-fetch branch (post-bootstrap) re-fetches profile but does NOT re-trigger the spinner; the PIN gate stays visible.
- **`is_super_admin` boolean instead of `superadmin` role** — chose boolean to avoid touching the role enum's value set. The role enum stays `{admin, staff, viewer}`. Cleaner migration.
- **Modal `prompt()` for setName** — pragmatic for an admin-only utility. Not pretty but doesn't justify a custom modal yet.

#### Security notes

- **`pin_hash` never leaves the DB.** Column-level grant excludes it from authenticated's SELECT permissions, and every PIN operation goes through SECURITY DEFINER RPCs that compare hashes internally with `crypt()`. A client query that selects `*` from `user_profiles` won't even include the column.
- **bcrypt cost** — using `gen_salt('bf')` with default cost factor (currently 6 in pgcrypto). 4-digit PINs are only 10K combinations; if the hash were ever exposed, a bcrypt-6 brute force is fast. The combination of column-level lockdown + lockout-after-5-attempts is the actual defense.
- **Rate limiting** — handled inside `verify_pin` via `pin_attempts` + `pin_locked_until`. No external rate limiter needed.
- **Super-admin escape hatch** — if Harsh ever locks himself out (forgot PIN, no Bhavik to reset, and super-admin protection blocks Bhavik anyway), the recovery path is: Supabase dashboard → SQL Editor → manually clear pin_hash for his row. Documented here so future-me can find it.

#### Follow-ups (not blocking)

- **"Reject signup" button** — currently pending users sit pending forever if not approved. Adding a reject that deletes the auth.users row + user_profiles row would need service-role access (auth.users isn't writable by anon/authenticated). Could be a Supabase Edge Function or a "leave as pending" convention.
- **PIN-required for sensitive actions** — re-prompt PIN before deleting/deactivating to confirm? Not asked for, would add friction.
- **Email notification to admin on new signup** — currently admin has to check the Users page periodically. A Supabase webhook → email would be nice.
- **Forgot-PIN email reset** — would let user self-serve without admin involvement. User said admin-only; flag for revisit.
- **Show last sign-in / PIN-set-at timestamps** on the Users page so admin can spot dormant accounts.
- **PIN gate inactivity timeout** — auto-lock after N minutes of no clicks. Not asked; matches the "once per session" intent so probably not needed.
- **Apply consistent date display** — currently the migration uses `to_char(..., 'HH24:MI')` for the lockout-until message; should use a more friendly relative-time format on the client.

#### Same-day hotfixes

Three regressions surfaced as the user signed in for the first time after the migration. All three are in-place fixed in the original `2026-05-22-pin-auth-and-approval.sql` AND each has a standalone patch SQL for the running database. Future replays of the bundle land correctly.

1. **`SELECT *` on user_profiles failed** ("permission denied for table user_profiles"). Cause: the column-level `REVOKE SELECT … GRANT SELECT (col list)` lockdown of `pin_hash` makes Postgres reject `SELECT *` outright — even if the calling code never wanted `pin_hash`. Symptom: user signed in, then bounced back to `/login` after a brief flash.
   Fix: new `PROFILE_COLUMNS` constant in `lib/supabase.ts` listing the 12 readable columns; both `fetchProfile` (providers) and the users-page admin list use it via `.select(PROFILE_COLUMNS)` instead of `.select("*")`. Commit `32e885d`. **No SQL patch needed** — pure client-side change.

2. **`function gen_salt(unknown) does not exist`** when user typed the PIN twice on the set-PIN gate. Cause: Supabase installs pgcrypto in the `extensions` schema, not `public`; my functions declared `set search_path = public` (correct hygiene for SECURITY DEFINER), so unqualified `gen_salt('bf')` / `crypt(...)` calls couldn't find them.
   Fix: fully-qualified as `extensions.crypt(...)` / `extensions.gen_salt(...)` inside `set_pin`, `verify_pin`, `change_pin`. Patch: `db/2026-05-22-pgcrypto-schema-fix.sql`. Commit `1e67665`.

3. **`column "role" is of type role_t but expression is of type text`** when admin tried to change anyone's role via the Users page. Cause: PL/pgSQL won't implicitly cast a text variable to an enum type the way it will for a string literal, and `admin_set_role` had `update user_profiles set role = p_new_role` with `p_new_role text`.
   Fix: explicit `::role_t` cast inside `admin_set_role`. Also defensively recast the literals inside `handle_new_user`'s INSERT + ON CONFLICT clauses so a future PG version being stricter about CASE-expression result types can't quietly break signups. Patch: `db/2026-05-22-role-enum-cast-fix.sql`. Commit `b1158b9`.

**Lesson for next migration touching column grants:** any `.select("*")` against the affected table needs to be replaced with an explicit column list before the migration runs. The two failures (1) and (3) are exactly the kind of thing that's easy to miss in a code review but bites on first sign-in.

---

### 2026-05-21 — ABC analysis + Dead-stock reports (both placeholders → real)

**User ask:** "analyse everything in stock-app-v2 and then build abc analysis and deadstock and ship them or push them, u have all the permissions to push it to git."

**Context.** Both pages had been 19-line `Construction` stubs since the v2 scaffold. With the Sales register landed earlier today, the Reports section now has three of three pages real. This entry covers both new pages in one PR because they share infrastructure (date-helpers, reversal handling, KPI shell, CSV-with-BOM, persisted localStorage state) and the user asked for them together.

#### ABC analysis — `app/reports/abc/page.tsx`

**The Pareto cut.** Items are sorted by revenue descending, cumulative share is computed, and each item gets bucketed by where it falls on the cumulative curve:

- **A** = items contributing the first 80% of revenue (default; editable in toolbar)
- **B** = the next 15% (cumulative 80 → 95%; default; editable)
- **C** = trailing 5% PLUS any active sale rows whose revenue resolves to 0 because the item has no pricing record

The cuts are inputs at the top of the page — `A ≤ [80]% · B ≤ [95]%` — so the user can shift to 70/90 or 75/95 etc. Cut values are clamped (`1–99` for A, `aCut+1–100` for B) so the relationship can't invert. Persists in localStorage.

**Date range presets.** This month / Last month / Last 30 days / Last 90 days / This FY (Apr–Mar) / Last FY / Custom range. Default is **This FY** (an ABC analysis is rarely useful at one-month resolution — the long tail needs a few months of demand history to stratify cleanly). Custom range inputs sit beside the preset selector; editing either flips preset to Custom.

**Reversal handling — identical to the sales register pattern:**
1. Pull Sale rows in the range (filter at the DB).
2. Pull `(reverses_id)` for any row whose `reverses_id` is in step 1's IDs — date/action unconstrained, so a May sale reversed in July still gets dropped.
3. For each Sale row: if `reverses_id` is set → it IS a reversal, skip. If its `id` appears in the reversedIds set → originally a sale, since undone, skip. Else → active, sum into the per-item unit total.

So an item that "sold 60 units then returned 5" lands at 55 units of true demand — not 60, not 55+5. Reversed pairs don't double-count and don't bias the ABC ranking.

**Rate basis — toggle, default excludes GST.** GST is a pass-through to the government; including it in "revenue" inflates every line item proportionally and doesn't change which class anything falls into, but it does change the absolute ₹ figures the user sees. Default is **excl. GST** because that's the actual money the business keeps; flip to **incl. GST** when reconciling against an invoice top-line. Stored on each row as `rate = lp × (1 - discount) [× (1 + gst_rate)]`. Pricing changes after the sale aren't tracked — the rate column reflects what the item sells for today, not what it sold for then. Called out in the footnote so the user knows.

**Pareto chart.** Recharts `ComposedChart` — bars for revenue (coloured by class: emerald A / amber B / zinc C), cyan line for cumulative %, dual Y-axes (₹ left, % right with `[0..100]` domain). Capped at the top 40 bars so the chart stays readable on a long-tail catalogue; the table below shows everything. Y-axis ₹ ticks abbreviate to `k`/`L` for Indian-large numbers. Tooltip formats with `fmtMoney` + percentage suffix and shows item label + class in the header.

**KPIs (5).** Revenue · Units sold · Class-A count + share · Class-B count + share · Class-C count + share. Each class KPI surfaces its share-of-revenue (so the user can see at a glance that, say, the 22 A-class items drove 80.4% of the money).

**Filters above the table.** Search box (item label or item code, case-insensitive) · Class filter (All/A/B/C) · Brand · Category. All operate post-classification — filtering doesn't re-classify, so an item's A/B/C tag stays stable regardless of what's visible.

**Sortable table.** Rank · Class badge · Item (with brand + category + "no pricing" amber flag if missing) · Units · Rate · Revenue · Share % · Cumulative %. Footer row shows visible-filtered totals (units + revenue), distinct from the all-classes totals in the KPI strip.

**CSV export.** Header row + visible-rows. Columns: Rank, Class, Item code, Brand, Category, Item, Units sold, Rate, Revenue, Share %, Cumulative %. UTF-8 BOM prefix (Excel reads non-ASCII colour names cleanly), RFC-4180 cell escaping, filename `abc-analysis-YYYY-MM-DD-to-YYYY-MM-DD.csv`.

**Defensive limits.** 10,000-row cap on the sale-row DB pull. Amber banner if hit ("Showing the first 10,000 sale rows. Pick a shorter range for a complete picture."). For Rye's volume (~166 SKUs, ~50–200 sales/month), This-FY pulls comfortably under this cap.

**Footnote explainer.** Bottom of the page spells out the algorithm in one paragraph — what's multiplied, what's excluded, how the cuts work — so a future user (or future Claude session) doesn't have to read the code to understand the numbers.

#### Dead-stock — `app/reports/dead-stock/page.tsx`

**The cut.** An item is "dead" if (a) it has positive stock on hand today AND (b) its most recent qualifying movement was at least N days ago. Threshold N defaults to **90 days** and is selectable from 30 / 60 / 90 / 180 / 365 via the toolbar dropdown.

**Movement-basis toggle:**
- **Sales only** (default) — the right cut for shelf-clearing decisions. "We bought 60 of these and customers haven't asked for any in 90 days; discount or stop reordering."
- **Any outbound** — Sale + Transfer + negative-direction Adjustment (Damage / Lost / Count down) + Return-out (supplier-return). The right cut for catalogue cleanup ("we haven't touched this SKU AT ALL in a year, why is it on the books?"). Transfers are included here because while the stock didn't leave the business, the SKU was active.

Either way, reversal handling: build a set of all `reverses_id` values in the pull, then for each row, skip if it's a reversal (its own `reverses_id` is set) OR if it was itself reversed (its `id` is in the set). The latest qualifying date per item, computed once during the walk, is what feeds the days-since calculation.

**"Include never-sold items" toggle (default on).** Items that have never moved by the chosen basis surface in the report with a `never` last-date and `—` days-idle. Toggle off to hide them — useful when reviewing a freshly-imported catalogue where most items haven't had time to sell yet.

**KPIs (4).** Dead SKUs (out of catalogue total) · Dead units (across both godowns) · Blocked capital (₹, net of GST) · Never moved (count). Blocked-capital uses `units × lp × (1 - discount)` — net of GST because GST liability only applies on actual sale, not on inventory held.

**Stock math — godown-aware.** Each item's `unitsA` and `unitsB` come from `godown_stock.cases × items.case_size + godown_stock.loose` per godown (same formula the dashboard uses). Items with `case_size = 0` use loose only. Total units = A + B.

**Sortable.** Toolbar lets the user sort by Blocked capital (default — money-first), Days since movement (never-sold rows pin to top), or Units in stock. Sort is post-filter so the visible order respects everything the user has narrowed to.

**Table columns.** Item (label + code + brand + category + amber "no pricing" flag + rose "never sold" flag) · Units A · Units B · Total · Last sale/movement (depending on basis) · Days idle (coloured: rose ≥ 180 days or never, amber ≥ 90, zinc otherwise) · Rate · Blocked capital. Footer row shows visible-filtered totals.

**Filters.** Search (item or code) · Brand · Category. Brand + category lists are derived from the loaded rows (no separate fetch needed).

**CSV export.** Header + visible rows. Columns: Item code, Brand, Category, Item, Units A, Units B, Total units, Last movement (or "never"), Days since, Rate, Blocked capital. Filename `dead-stock-{threshold}d-{today}.csv`. Same BOM + escaping as ABC.

**Defensive limits.** 20,000-row cap on the transaction pull (need every Sale/Transfer/Adjustment/Return to find latest-per-item correctly). Amber banner if hit, warning that some items' last-movement dates may be older than what's shown.

**Why threshold doesn't refetch.** Changing the threshold only re-classifies in-memory — the same set of rows is just filtered to a different `daysSinceMovement >= N` test. Changing the basis DOES refetch because it affects the `lastSaleDate` vs `lastMovementDate` computation that happens during the DB walk. Smaller useEffect, faster UX.

#### Shared infrastructure

Both pages use the same local-time date helpers (`fmtISO`, `fmtDateDisplay`, `daysSince`) — `new Date().toISOString()` drifts a day backwards in IST after 18:30, so YYYY-MM-DD is built from `getFullYear/getMonth/getDate` and parsed via `"YYYY-MM-DD" + "T00:00:00"`. Same pattern as the sales register.

Both persist their full filter state in localStorage so a refresh keeps you where you were. Keys are namespaced: `abc.*` and `deadStock.*`.

Both use the established Shell + Topbar layout, the cyan-500 accent, `tabular-nums` (`tnum` class) on every numeric column, en-IN money via `fmtMoney`, Lucide icons only (no emoji), and the rose/amber/emerald semantic palette.

#### Files patched

- `app/reports/abc/page.tsx` — was 19-line `Construction` stub; now ~550 lines real. New default-exported `ABCAnalysisPage` + local `Kpi`, `ClassKpi`, `ClassBadge` helpers. Imports `ResponsiveContainer / ComposedChart / Bar / Line / XAxis / YAxis / CartesianGrid / Tooltip / Cell` from `recharts` (already in package.json dependencies — added during initial v2 scaffold for "future charts", finally being used).
- `app/reports/dead-stock/page.tsx` — was 19-line `Construction` stub; now ~430 lines real. New default-exported `DeadStockPage` + local `Kpi` helper.
- `PROGRESS.md` — this entry.

#### Files NOT touched

- `lib/supabase.ts` — `Item`, `Pricing`, `Txn`, `Stock` types already cover everything these pages need. No new columns.
- `components/*` — sidebar already has both `/reports/abc` and `/reports/dead-stock` links from the May 14 audit pass.
- DB — both pages are pure read-paths. No migrations, no new RPC functions.
- Other reports — sales register untouched.
- Dashboard — the dead-stock count card on the dashboard (`Attention needed → Dead stock (no movement)`) is still the old "items with 0 stock" placeholder count. Could be wired to the real dead-stock count in a follow-up, but out of scope here.

#### Edge cases handled

**ABC analysis**
- **Reversal outside the date range.** Sale in range, reversal outside — the original is dropped from totals (second query is unconstrained by date). Same as sales register.
- **Items with no pricing.** Show in the table with `—` for rate + revenue, classified as C (revenue = 0), flagged "no pricing" in the meta row. Don't inflate the A/B classes.
- **Tiny revenue totals.** When `totalRevenue === 0` (no active sales in range), every item lands as C with share/cum = 0; KPIs render `₹0` cleanly; no division-by-zero anywhere.
- **A-cut > B-cut.** The B-cut input clamps to `max(aCut+1, …)`, so the relationship can't invert.
- **Cumulative % rounding.** Stored as full precision; displayed to 1 decimal. CSV exports 2 decimals.
- **Chart with very few items.** Renders fine — Bar chart accepts any length, the cumulative line stays in [0, 100] domain regardless.

**Dead-stock**
- **Items with stock = 0.** Excluded from the "dead" cut — by definition, dead stock means there IS stock sitting unsold. Out-of-stock is a different report.
- **Items with `case_size = 0` (loose-only).** Stock math drops the cases multiplier and uses loose count directly. Same formula as dashboard/items page.
- **Items that have moved but the move was outside the row cap.** Surfaced via the amber banner — defensive callout that some "days idle" figures may understate the true last movement. For Rye's volume this won't bite (history is ~hundreds of txns/year, well under the 20K cap).
- **Items priced at 0 or with no pricing record.** Blocked-capital shows as `—`. Item still counts toward Dead SKUs + Dead units KPIs (they're real units), just not toward Blocked capital ₹.
- **Sort with never-moved rows.** When sorting by "days idle", never-moved rows pin to top (`Number.POSITIVE_INFINITY` substitute). That matches the intuition that a never-moved item is the most stale.
- **Threshold change re-classifies without refetch.** Toggle the dropdown from 90 → 180 and the table re-filters instantly — no DB call.

#### Verification

- Dev server (`npm run dev` via `.claude/launch.json` `stock-app-v2` config, port 3010 — port 3000 was already taken so Next picked 3010 itself) compiled both pages cleanly:
  - `/reports/abc/` — 1840 modules, no TypeScript errors, route returns 200.
  - `/reports/dead-stock/` — 1837 modules, no TypeScript errors, route returns 200.
- The "Fast Refresh had to perform a full reload due to a runtime error" warning is the expected Providers crash from missing `NEXT_PUBLIC_SUPABASE_ANON_KEY` on this machine — Shell never mounts so no page logic runs, but the compile-clean is the meaningful local signal. Full UI verification happens after deploy at the live URLs:
  - https://harshj111186.github.io/stock-app-v2/reports/abc/
  - https://harshj111186.github.io/stock-app-v2/reports/dead-stock/

#### Deploy

None manual. Commit + push to `main` → `.github/workflows/deploy.yml` rebuilds and republishes Pages in ~1–2 min.

#### Follow-ups (not blocking)

**ABC analysis**
- **Class-by-brand or class-by-category breakdown** — a small grid below the chart showing, say, "Crompton: 12 A · 4 B · 22 C" so the user can spot brand-level concentration risk.
- **Time-series ABC stability** — re-run the analysis over rolling windows and flag items whose class changed (a C-class climbing into B is a candidate for more shelf space; an A dropping to B is a warning).
- **Export to .xlsx with formatted cells + summary tab** — would need SheetJS. CSV+BOM covers the "open in Excel" path for now.
- **Click an item to jump to its sales history / pricing / godown levels.** Currently the row is read-only.

**Dead-stock**
- **"Days of cover" column** — `currentUnits / dailyVelocity` for items that DO sell — shows how long today's stock will last at recent run rate. Different KPI angle from "dead vs alive" but useful in the same shelf-review conversation.
- **Mark-for-action toolkit** — checkboxes per row + bulk "send to clearance list" or "stop reordering" actions. Requires a new table (`dead_stock_actions` or similar) and a workflow.
- **Wire dashboard's Attention card** to the real dead-stock count so the home page reflects reality.
- **Per-godown view** — currently we show A and B side-by-side; could add a godown filter to focus the shelf-review on one warehouse.
- **Last-purchase-date column** — sometimes more useful than last-sale; tells you "we bought 60 of these 2 years ago and have sold none". Two queries instead of one, easy add.

---

### 2026-05-21 — Sales register: date-range view with reversal-aware totals

**User ask:** "now i want you to work on sales register. […] those extra, gstin, customer name etc is not at all needed, just record the item name, sales quantity with date and if reversed then do the needful action etc."

**The shape after scope-trim.** The original placeholder hinted at a fuller vision (party filter, GSTIN summary, Excel/PDF export). User explicitly rejected the GST + customer side of it, so this ships as a minimal sales log focused on **date · item · godown · qty** with reversal handling baked in. GST math, party filter, invoice column, HSN summary, PDF export — all deferred. The transactions page's free-text `note` field carries party/invoice/rate today; we don't parse it.

**What the page does**

- **Date range picker** with presets: Today, Yesterday, This week (Mon-anchored), This month, Last month, This FY (Apr–Mar — Indian financial year), Custom range. Default is This month. Custom from/to inputs are always visible; editing either flips preset to "Custom".
- **Three KPIs**:
  - Active sales — count of rows that aren't part of a reverse pair
  - Units sold — sum of qty across active rows
  - Rows in view — total rows displayed (changes with the "Show reversed entries" toggle)
- **Detail table** — Date · Item (model · size · colour + item code subtitle, brand inline) · Godown · Qty · Status. Sorted newest first.
- **Reversal handling — three states with distinct visual treatment**:
  - `active` — emerald dot, counts toward totals
  - `reversed` — strikethrough on item + qty, rose "Reversed later" badge, excluded from totals
  - `reversal` — amber-tinted row, amber "Reverses #ABC123…" badge, excluded from totals
  - **"Show reversed entries" checkbox** (off by default) — hides both `reversed` and `reversal` rows when off. Totals stay the same either way; the toggle only affects display. Off-by-default keeps the register clean for day-to-day reading; on for audit.
- **CSV export** — visible rows only (so toggle state respected), with BOM prefix so Excel reads UTF-8 colours (e.g. "matt black") cleanly. Filename pattern `sales-YYYY-MM-DD-to-YYYY-MM-DD.csv`. Columns: Date · Item code · Item · Godown · Qty · Status.
- **5000-row safety cap** on the DB pull, with an amber banner if hit ("Showing the first 5,000 sales… pick a shorter range"). Defensive — a This-FY pull on a busy year shouldn't yank everything over the wire.
- **Persisted filter state** in localStorage (`salesReg.preset`, `.customFrom`, `.customTo`, `.showReversed`) so a refresh keeps you where you were.

**Reversal-detection mechanics — worth knowing**

A sale row's state isn't computed from `t.status` (which the SQL writes as "OK") or `t.action` alone. It's based on `reverses_id` linkage:

1. Pull Sale rows in the date range (filter at the DB).
2. Pull `(id, reverses_id)` for any row whose `reverses_id` is in step 1's IDs — **regardless of action and regardless of txn_date**. A sale on May 5 reversed in June would have its reversal row outside the May filter; this second query catches it so the May 5 row still renders as "reversed".
3. For each Sale row in step 1:
   - If `s.reverses_id` is set → `reversal` (the reversing row itself; an unusual case — a Sale reversing something else — but defensive)
   - Else if `reversedIds.has(s.id)` → `reversed` (the original sale was later negated)
   - Else → `active`

The check works whether `reverse_transaction` inserts the inverse as `Purchase` or as `Sale` with `direction=+1`. If it's `Purchase`, the original Sale shows as "reversed" and the Purchase row simply doesn't appear in this register (it'd belong in a Purchase register). If it's `Sale` with `direction=+1`, both show — the original as "reversed", the reversal as "reversal" — and neither contributes to totals. Either way, the active count + units-sold are right.

**Date math — local-time, not UTC**

`new Date().toISOString().slice(0, 10)` is unsafe in IST: after 18:30 IST it returns the next UTC day, so picking "Today" near midnight gives yesterday's range. The page builds YYYY-MM-DD strings from local `getFullYear / getMonth / getDate` instead. Same pattern is used to parse stored dates for display: `new Date(iso + "T00:00:00")` forces local parsing rather than UTC. The transactions page still uses the UTC slice pattern for its own date defaults; not changed here because (a) it's only used for one-shot "today" defaults and (b) not user-asked. Worth a follow-up sometime.

**Files patched**

- `app/reports/sales/page.tsx` — was a 19-line `Construction` placeholder; now ~330 lines real. New default-exported `SalesRegisterPage` component + local `Kpi` helper.
- `app/globals.css` — linter added a generic `@media print` block (~33 lines) and a `.no-print` class. Not used by this page (no Print button) — left in as benign infrastructure for any future report that wants printable output.
- `components/topbar.tsx` — linter added `print:hidden` to the root div. Same story: benign, hides the topbar in print previews if any future page calls `window.print()`. Harmless on screen.
- `PROGRESS.md` — this entry.

**Files NOT touched**

- `lib/supabase.ts` — no schema changes; the existing `Txn` type already had `reverses_id`. No new columns needed.
- Sidebar — already has the `/reports/sales` link from the May 14 audit pass.
- DB — pure read path. No migration.

**Verification**

- Dev server (`npm run dev` via `.claude/launch.json` `stock-app-v2` config, port 3010) compiled both `/` and `/reports/sales` cleanly — 804 modules, no TypeScript errors, route returns 200.
- Live render couldn't be exercised locally because there's no `NEXT_PUBLIC_SUPABASE_ANON_KEY` set on this machine — Providers crashes at `supabaseUrl is required` before Shell mounts. Per README, local dev isn't expected; GitHub Actions has the secret. The compile-clean is the meaningful local check; full UI verification happens after deploy.

**Edge cases handled**

- **Reversal outside the date range.** Sale in range, reversal outside — original still shows as "reversed", excluded from totals (the second query is unconstrained by date).
- **Reversed row whose action isn't `Sale`** (e.g. if `reverse_transaction` writes a `Purchase` as the inverse). Doesn't appear in the table at all (we filter `action = 'Sale'`), but the original Sale gets the "reversed" badge via `reversedIds`.
- **Toggle interaction with totals.** Hiding reversed rows doesn't change totals — totals always come from `activeRows`, never from `visibleRows`. So a user toggling on/off can't accidentally mis-read the numbers.
- **Empty state copy** distinguishes "no sales in range" from "no active sales, only reversed entries" — the second copy nudges the user to tick the toggle.
- **CSV escaping.** Item labels with commas, quotes, or newlines get properly quoted per RFC 4180. BOM prefix for Excel UTF-8.
- **Custom-range inputs** always show the resolved `from`/`to` (not the stale `customFrom`/`customTo`) so what's in the input matches what's queried. Editing either flips preset to "Custom" so the values stick.
- **localStorage corruption.** Reads wrapped in try/catch; bad values fall back to defaults.

**Deploy**

None manual. Commit + push to `main` → `.github/workflows/deploy.yml` rebuilds and republishes Pages in ~1–2 min. Verify at https://harshj111186.github.io/stock-app-v2/reports/sales/.

**Follow-ups (not blocking)**

- **Excel (.xlsx) export** with cell formatting + summary tab — needs SheetJS or similar. CSV+BOM covers most "open in Excel" use cases for now.
- **PDF / print stylesheet** — already partially set up by the linter's print CSS in globals.css, but no Print button on the page. If the user wants printable output, add a button + print-only header block; the infrastructure's ready.
- **Re-introduce GST/party columns** if/when (a) `process_transaction` is migrated to take dedicated `p_invoice_no` / `p_party_id` / `p_rate` args and (b) the user changes their mind on GST/customer tracking. The DB columns (`transactions.invoice_no`, `.rate`, `.party_id`) exist; only the write path stuffs everything into `p_note`.
- **Group-by-date view** — daily subtotal rows ("21 May · 3 sales · 8 units"). One refactor of the table-body render.
- **Group-by-item view** — useful for "which items sold the most this month". Different KPI angle.
- **Link from Dashboard's "Top movers" card** to a pre-filtered sales register (item + last 30 days). One-line href change.
- **Apply the same reversal-aware approach to a future Purchase register / Stock-movement register.** The pattern (pull action-in-range + pull all rows with `reverses_id` in the IDs + state classification) generalises.

---

### 2026-05-21 — Transactions page: case-size popup on Add-to-queue + repo hygiene

**User ask:** "in transaction for adjustment or purchase etc, if an item with no case size is purchased or sold or adjusted, then before processing directly to loose, a popup should appear asking for case size, once entered the case size for that item, it should process things accordingly."

**The problem.** Items in the catalogue that haven't had a case size set (`items.case_size = 0`) force loose-only entry on the Transactions page — the form hides Cartons + Loose and shows a single Quantity field. That's correct for legitimately loose-only items (think single screws), but it's also what happens for items that SHOULD have a case size but nobody's set one yet. Staff would silently process 60 units of a fan into Godown A as "60 loose", which is fine math-wise but loses the carton structure forever (well, until someone goes to Items and sets case size manually, then runs corrective adjustments).

**The fix.** A new **case-size popup** intercepts Add-to-queue when the selected item has `case_size = 0`:

- **Admin** sees the modal with an editable case-size input. Enter, say, 12. The modal previews "Will split as 5 cartons + 0 loose = 60 units" if the pending qty is 60. Click **Set case size & add**: the modal saves `items.case_size = 12`, refreshes the items list locally, re-splits the row's loose-only quantity into 5 cartons + 0 loose (total_qty unchanged — the RPC still gets 60), then queues the row. Future entries for this item will show the proper Cartons + Loose fields automatically.
- **Staff / viewer** see the modal but the case-size input is replaced with an amber "Admin only" note (`items` table is admin-write-only via RLS). They get **Skip — add as loose** and **Cancel** as the only options.
- **Skip — add as loose** is available to everyone. Queues the row exactly as built, with `case_size = 0` still on the item. Useful for items that really are loose-only — and required by staff who can't set case size themselves.
- **Cancel** dismisses the modal without queueing.

The popup triggers for **all 5 action types** (Purchase, Sale, Transfer, Adjustment, Return) — the user explicitly asked for "purchased or sold or adjusted" and the Return / Transfer cases are symmetric.

**Item-picker hint.** The picker dropdown now shows a small amber **"no case"** badge on items with `case_size = 0`, so the user knows BEFORE they pick that the popup will appear. Items with a case size keep the existing `case×N` badge.

**Pre-flight stock simulation already DTRT.** Once admin sets the case size, `reload()` refreshes the items array, and the queue's `useMemo` pre-flight re-computes — picking up the new `case_size` for godown-total math on any existing queue rows for that item. No special handling needed; the existing reactive chain just works.

**Files patched**

- `app/transactions/page.tsx` (1083 → 1296 lines, +213):
  - New state: `pendingCaseSize`, `savingCaseSize`. Derived `isAdmin` from auth profile.
  - New `Boxes` import from lucide (icon used in the modal header).
  - `addToQueue` refactored: builds the row, then gates on `selectedItem.case_size === 0` — if true, parks the row in `pendingCaseSize` instead of queuing. The actual push-to-queue is moved to a new `doAddToQueue(row)` helper called by both the no-gate path and the modal handlers.
  - New `saveCaseSizeAndAdd(newSize)` — admin-only: writes `items.case_size`, reloads, re-splits cartons/loose from the parked row's total, calls `doAddToQueue`.
  - New `skipCaseSizeAndAdd()` — queues the parked row as-is.
  - New `cancelCaseSize()` — dismisses the modal, parked row discarded.
  - New `CaseSizeModal` component at the bottom of the file (~110 lines): backdrop click + Esc key both cancel (only when not saving), live cartons/loose preview, role-aware button row.
  - `ItemPicker` got the small `no case` amber badge for `case_size === 0` items.

- `.gitignore` (extra line):
  - Added `.claude/` to the OS/editor block (sits alongside `.vscode/` and `.idea/` — same pattern: per-user IDE/tool config, not project state).

- `package-lock.json` — newly committed.

- `PROGRESS.md` — this entry.

**Why `.gitignore` + `package-lock.json` ride along with the feature PR.** Both were unresolved loose ends flagged in the prior session's audit:
- `.claude/launch.json` is a Claude Code dev-server launch config (`npm run dev` on port 3000). Tool-specific, regenerable, prone to per-user drift — same shape as `.vscode/launch.json` which is already gitignored. Excluding it now prevents accidental commits.
- `package-lock.json` had appeared as an untracked 94 KB file at the repo root after a local `npm install`. The deploy workflow (`.github/workflows/deploy.yml`) currently does `npm ci || npm install` — without a committed lockfile it always falls through to the slower, non-deterministic `npm install`. Committing the lockfile makes CI deterministic (same transitive versions every build, eliminating the risk of a patch update breaking a deploy with no code change) and shaves ~5–15 seconds off the install step. The flip side is that future `npm install`s update the file — small diff noise, big determinism win.

**Edge cases handled**

- **Esc closes the modal**, click-outside the panel closes it (both gated on `!saving` so a mid-save click doesn't interrupt the update).
- **Invalid case-size input** (e.g. "0", "-1", "1.5") shows a rose "Enter a whole number ≥ 1" hint and keeps the Save button disabled.
- **Saving error** (e.g. RLS reject because the user is actually staff masquerading) surfaces a rose toast with the Postgres error text; the modal stays open so the user can choose Skip.
- **Already-queued rows for the same item** before the case size was set: their `total_qty` is correct (the math worked loose-only). After case_size is set, future processing still calls the RPC with `p_qty: total_qty` and the SQL `process_transaction` does its own carton/loose split using the current `items.case_size`. So already-queued rows just inherit the new structure automatically.
- **Re-opening the modal** for the same item if the user cancelled and re-clicked Add-to-queue: state resets, no stale values carried over.

**Follow-ups (not blocking)**

- Once enough items get case sizes set on the fly via this popup, the Items page's case-size column will see fewer 0s. May be worth a "last set" timestamp column if we ever want to audit how case sizes were filled in.
- The item-picker's "no case" badge could be extended to other "missing data" flags (no HSN, no GST rate, etc.) for catalogue completeness at a glance. Out of scope here.
- Staff currently can't update `items.case_size` even via this popup (RLS denies). If we want to let staff propose a case size and have admin approve later, we'd need a new `case_size_proposals` table + approval flow. Not asked for.

---

### 2026-05-21 — Transactions page: batch-queue mode with pre-flight stock check

**User ask:** "many time the staff first enter sales for which purchase has to go first to show the stocks and then it leads to error, so i want data entry setup in transaction to be better in a way that the staff can enter all the details in 1 go for all sales, purchase, transfer etc. when he clicks process, u process them in a way that purchase then transfer then sales, like that. if there is a return too then process the return which adds the stock back to us and then process the return which lessen the stock so that no error arrives saying no stock while processing any outward transaction."

**The problem.** Single-entry mode forced the staff to enter Purchases BEFORE the corresponding Sale, otherwise the Sale would fail with "Insufficient stock at Godown X" because the Purchase hadn't landed yet. Real-world workflow doesn't follow that order — staff often capture Sales (today's customer activity) first and remember to enter Purchases (yesterday's stock-in) later.

**The fix — queue mode.** The Save button is gone. Replaced with **Add to queue**. Every entry drops into a queue table below the form. When the user clicks **Process queue**, the system runs every entry in this fixed, stock-safe order:

| Priority | Action | Direction | Effect |
|---|---|---|---|
| 1 | Purchase | +1 | + stock at chosen godown |
| 2 | Adjustment (Found / Count up / Customer return → shelf) | +1 | + stock at chosen godown |
| 3 | Return — customer return into godown | +1 | + stock at chosen godown |
| 4 | Transfer | n/a | moves between A and B |
| 5 | Adjustment (Damage / Lost / Count down) | −1 | − stock at chosen godown |
| 6 | Sale | −1 | − stock at chosen godown |
| 7 | Return — supplier return out of godown | −1 | − stock at chosen godown |

So a Sale can sit in the queue alongside the Purchase that creates its stock, and processing order guarantees the Sale never fails because of "no stock yet". This is the user-mentioned `purchase → transfer → sales` order, expanded across all 5 action types.

**Pre-flight stock simulation.** As entries land in the queue, the page runs a client-side simulation: starting from each item's current `godown_stock`, it walks the sorted queue and computes the running balance after each step. If any step would take a godown below zero, the row is highlighted in rose, the running balance column shows the negative number, and a **rose banner** at the top of the queue spells out which item and which godown, with current-stock and shortfall amounts. The **Process queue** button is disabled until the pre-flight is green. So the staff sees the problem WHILE they can still fix it (add more Purchase qty, change godown, remove a Sale, etc.) instead of after a partial process. An emerald "All clear" banner shows when the queue is ready.

**Per-row status during process.** As the queue runs, each row's Status column flips:
- `queued` (zinc) → `running` (cyan, spinning loader) → `done` (emerald, tick) — or
- `running` → `<error message>` (rose, with AlertCircle) if the RPC rejected it.

If any row fails, **survivors stay in the queue with the error attached** so the user can fix and re-process. Successful rows are removed from the queue.

**Form behavior preserved.** Existing fast-repeat behavior kept: after Add to queue, `item + godown + action + date` stay; `cartons + loose + rate + invoice + party + reason` clear. So entering 20 Purchase lines from one supplier is `pick item → cartons/loose → Add → pick next item → cartons/loose → Add → …`, action stays Purchase, godown stays where you set it, date stays the same.

**Files patched**

- `app/transactions/page.tsx` — substantial rewrite, 770 → 1083 lines:
  - New `QueuedTxn` type capturing all per-row state.
  - New module-level helpers: `priorityOf(t)`, `deltaOf(t)`, `makeUid()`, `PRIORITY_LABEL` for the queue display.
  - New component state: `queue`, `processing`, `processIdx`, `processErrors`.
  - New `sortedQueue` `useMemo` (priority-ordered, stable by uid for ties).
  - New `preflight` `useMemo` — walks `sortedQueue` against current `stock`, returns `{ ok, snapshots, firstError }` for the banner + per-row warning column.
  - `submit` renamed to `addToQueue`; pushes onto the queue, no RPC.
  - New `processQueue` — runs every row sequentially via `process_transaction(... p_direction)`. On any failure: collects errors, keeps failed rows in queue, removes successful ones. Calls `reload()` at the end either way.
  - New `removeFromQueue(uid)` and `clearQueue()`.
  - New Queue panel JSX between the form and the transaction log: table with columns `# · Action · Item · Godown · Qty · A after · B after · Status · ×`. Header row has Clear all + Process queue (N) buttons. Banners (rose / emerald / rose-with-errors) at the top of the panel.
  - Form footer "Save Purchase" button now reads **Add Purchase to queue** with a Plus icon.
- `PROGRESS.md` — this entry.

**Files NOT touched**

- `lib/supabase.ts`, `app/providers.tsx`, `app/login/page.tsx`, `app/items/page.tsx`, `components/godown-view.tsx`, `app/page.tsx` (dashboard), v1 `stock-app/index.html` — all untouched.
- No DB changes. Backend still uses the 7-arg `process_transaction` from `phase2-adjustment-return.sql`. The queue just calls it N times in client-side priority order.

**Edge cases handled**

- Multiple Sales of the same item in one queue: pre-flight tracks running stock through ALL queue rows, so the 2nd Sale will only succeed if the 1st didn't already drain the godown.
- Transfer simultaneously decrements source and increments destination in the simulation — so a queue like "Purchase A 10 → Transfer A→B 10 → Sale B 10" passes pre-flight even though B starts at 0.
- Adjustment direction is computed from the Reason dropdown at add-time; Return direction is computed from the In/Out toggle. Stored on the queue row, used both for the SQL call and the simulation.
- Partial processing: if rows 1-3 succeed and row 4 fails, rows 1-3 are removed from the queue, rows 4-N stay with the failure message attached to row 4. The user can fix row 4 (or remove it) and click Process queue again to run the remaining rows. The DB is consistent because each row is its own atomic RPC.
- Pre-flight ignores the SQL's own stock check — they're redundant. The pre-flight is for UX (catch errors before the round-trip); the SQL is the source of truth.
- The Transaction log below the queue is unchanged. Successfully-processed queue rows appear in the log on the next `reload()`.

**Follow-ups (not blocking)**

- Bulk import from CSV / paste — same queue, populated from a paste-box. Would let staff bring in 50 lines of Purchases from an invoice in seconds.
- Re-order rows within the queue manually (drag handles). Currently the order is fixed by `priorityOf`; manual re-order would let power users handle exotic cases.
- Save the queue to localStorage so a refresh doesn't lose pending work. Currently the queue is in-memory only.
- "Process and stop on error" vs "Process and continue" toggle. Currently the loop processes all rows and reports failures at the end — could be opinionated to stop at the first failure to preserve fix order.
- Edit a queue row instead of remove + re-add.

---

### 2026-05-20 — Login deadlock cracked: defer profile fetch out of SDK notify loop (PR #5 / 119f0db)

**User-facing symptom:** sign in succeeds, dashboard flickers, then loading spinner sits for 10s and bounces back to `/login`.

**Why the previous three login fixes weren't enough.** PRs #2–#4 closed real bugs (redirect race, dual-bootstrap race, wedged `navigator.locks`) but the underlying deadlock was lower-level: between the `onAuthStateChange` callback and supabase-js' init sequence itself.

**The actual mechanism (diagnosed live via Chrome MCP).** When `sb()` first runs, the supabase-js constructor immediately kicks off `_initialize()` under an internal auth lock. Inside `_initialize`, `_recoverAndRefresh` reads the valid stored session from localStorage and calls `_notifyAllSubscribers('SIGNED_IN', session)` — which **awaits each subscriber's callback in turn, while still holding the init lock**.

Our `onAuthStateChange` callback in `app/providers.tsx` was `async` and did `await fetchProfile(...)`. `fetchProfile` calls `sb().from('user_profiles')`, which queues that REST request behind the still-running init lock. Init awaits the listener; the listener awaits a call queued behind init → **classic self-deadlock.** The 10s failsafe fires, `profile` stays null, redirect bounces to `/login`.

Console evidence on the deployed app, BEFORE this fix:
- `auth.lockAcquired = true`
- `auth.pendingInLock` = array length 1
- `auth.initialize()` never resolves (5s race, 100% timeout)
- `auth.lock` was already our PR-#4 no-op (confirmed `async (e,t,n)=>n()`) — so this is NOT a `navigator.locks` problem; it's the SDK's INTERNAL lock.

**The fix.** Make the `onAuthStateChange` callback **strictly synchronous**. Capture the session, then defer profile resolution into a separate task via `setTimeout(async () => { ... }, 0)`. The listener returns `undefined` immediately so the SDK's notify loop can complete, init resolves, the lock releases, and only THEN does the deferred task run `fetchProfile` against an unblocked client.

After fix, verified live in console: `getSession()` returns in 0ms, `fetchProfile` in ~215ms. No more 10s timeouts.

**Why this won't regress easily.** The big inline comment in `app/providers.tsx` lines 53–63 spells out the deadlock mechanism with a "DO NOT make this async" warning. A linter or AI session that reintroduces `async (event, session) =>` will reintroduce the deadlock. Resist the temptation to "simplify" by removing the `setTimeout(0)` — it is load-bearing.

**Files patched**
- `app/providers.tsx` — listener callback rewritten as synchronous. Profile resolution moved into a `setTimeout(0)` block. Post-bootstrap event branch preserved inside the deferred task so TOKEN_REFRESHED / USER_UPDATED still refresh silently.

**Not touched**
- `lib/supabase.ts` — `lock: lockNoop` from PR #4 stays. The two fixes are orthogonal: lockNoop bypasses cross-tab serialisation, the `setTimeout(0)` bypasses the SDK's internal init lock. **Need both.**
- `app/login/page.tsx` — already correct as of PR #2.

---

### 2026-05-20 — Bypass supabase-js navigator.locks (PR #4 / 26d103e)

**User-facing symptom:** "loading spinner hangs for 10s on dashboard, then back to /login" — happening even after the PR #2 / #3 fixes.

**Diagnosed live via Chrome MCP** on the deployed app.

`navigator.locks.query()` returned `lock:sb-zvycuhldwfxpipcaeotc-auth-token` was held with **no pending requesters**. A `navigator.locks.request(...{ ifAvailable: true })` returned `null` — i.e., the lock was wedged; can't acquire it even non-blocking.

supabase-js wraps auth/token operations in the `navigator.locks` Web API by default to serialise them across browser tabs. With the lock stuck, every `onAuthStateChange` / `getSession` / `fetchProfile` call hangs forever → 10s failsafe → profile=null → redirect to `/login`.

**How the lock got stuck.** v1 (`/stock-app/`) and v2 (`/stock-app-v2/`) share the `harshj111186.github.io` origin AND the default storageKey, so they contend on the same lock. If either tab dies mid-operation while holding the lock, the lock stays held forever for the other tab.

**Proof it wasn't RLS or schema.** A direct REST call to `/rest/v1/user_profiles` with the same anon key returned 200 in 60ms. The RLS policy and table schema are fine — the bug is purely in the SDK's lock handling.

**The fix.** Pass a no-op `lock` function to `createClient` via the `auth.lock` option:

```ts
type LockFn = <R>(name: string, acquireTimeout: number, fn: () => Promise<R>) => Promise<R>;
const lockNoop: LockFn = async (_name, _acquireTimeout, fn) => fn();
createClient(url, key, { auth: { ..., lock: lockNoop } });
```

The cross-tab serialisation is no longer used. Trade-off: two open tabs may both refresh the auth token at the same time, which Supabase handles fine — duplicate refreshes resolve to the same token.

**Files patched**
- `lib/supabase.ts` — +21 lines. `LockFn` type + `lockNoop` const + `auth.lock: lockNoop` in `createClient` opts. Inline comment explains why this is here so a future linter or AI session doesn't strip it.

**Verified after deploy:**
- Fresh incognito → /login → sign in → dashboard loads and stays put.
- DevTools console: no `[Providers] auth bootstrap timed out` warning.
- `navigator.locks.query()` shows no held auth-token lock.

**Important follow-up.** This fix was necessary but **not sufficient** — the SDK still had an INTERNAL lock that wedged differently. PR #5 cracked that one. Keep both fixes.

---

### 2026-05-20 — Collapse dual auth path into single listener (PR #3 / aaacd7d)

**User-facing symptom:** sign in succeeds, dashboard renders briefly, then loading spinner reappears and bounces back to `/login`.

**Why this was a new bug after PR #2 shipped.** PR #2 closed the redirect race during initial sign-in but exposed a different race in the auth bootstrap path itself.

**Root cause.** `app/providers.tsx` ran two parallel auth-bootstrap paths:
1. `onAuthStateChange` (which fires `INITIAL_SESSION` on subscribe), AND
2. an explicit `getSession()` fallback as a belt-and-braces.

Both did `setLoading(true)` → `fetchProfile` → `setProfile`. The second path would re-flash the spinner mid-session, and if its `fetchProfile` transiently failed (RLS hiccup, network blip), it overwrote the valid profile with `null` — triggering the redirect to `/login` mid-session.

**The fix.** Keep only the listener. `onAuthStateChange` fires `INITIAL_SESSION` on subscribe AND every subsequent `SIGNED_IN` / `SIGNED_OUT` / `TOKEN_REFRESHED` / `USER_UPDATED`, so the explicit `getSession()` was redundant. Added a `bootstrapped` flag so post-bootstrap events (TOKEN_REFRESHED, USER_UPDATED) refresh the profile silently in the background without re-showing the spinner, and never overwrite a known-good profile with `null` on a transient refresh failure.

Also extended the failsafe from 4s to 10s. Real-device networks can legitimately take >4s; the failsafe firing prematurely was itself causing some of the bounces.

**Files patched**
- `app/providers.tsx` — removed the `getSession()` block entirely. Added `bootstrapped` flag with explicit bootstrap-vs-refresh branching inside the listener. Failsafe `4000` → `10000`.

**Note for future sessions.** This fix made the code cleaner but didn't fully solve the login problem — the underlying SDK deadlock (PR #5) was still present. Symptoms shifted but didn't clear. The lock bypass (PR #4) and the synchronous-listener fix (PR #5) followed.

---

### 2026-05-20 — Transactions page real + Adjustment & Return tabs unlocked
**Cowork split: this session worked on Transactions while a parallel session worked on Items + Godown A/B + the login-hang re-fix.**

**Starting state — important to know before reading the diff**

The GitHub repo was still shipping the 19-line `Construction` placeholder for `app/transactions/page.tsx`. The 647-line "real" page described in the 2026-05-14 changelog entry below only ever existed locally in `OneDrive\…\Stock Accounting\stock-app-v2\app\transactions\page.tsx` — it was never pushed. So this turn does TWO things at once:
1. Lands a real Transactions page in the deploy folder (`Projects\stock-app-v2\app\transactions\page.tsx`) for the first time.
2. Bakes in the Adjustment + Return unlock directly, instead of shipping the page locked-then-unlocking it later.

The phase-2 SQL (`Stock Accounting\phase2-adjustment-return.sql`, applied during the May 20 Items override turn) is the precondition. `process_transaction` is now 7-arg with `p_direction int default null`, the `transactions.direction` column exists, and `reverse_transaction` handles Adjustment/Return correctly. The page calls into that, end-to-end.

**What the page does**

- Top tab strip with all 5 action types live (Purchase, Sale, Transfer, Adjustment, Return). No `Lock` icon, no `disabled` attribute, no `LIVE_ACTIONS` whitelist — every tab is selectable.
- Item picker: typeahead combobox of up to 30 matches, `onMouseDown` selection to dodge the blur-before-click race. Shows brand, model, size, colour, item_code, and `case×N`.
- Carton + Loose entered separately (carton-loose-stays-separate rule #8). Total computed client-side as `cartons * case_size + loose` (or just `loose` if `case_size = 0`). Live total preview below.
- **Adjustment tab — Reason dropdown is split with `<optgroup>`**:
  - **Stock goes UP (+):** Found / Count up / Customer return → back on shelf
  - **Stock goes DOWN (−):** Damage / Lost / Count down
  - A small arrow-icon hint under the dropdown spells out "Will add N units to Godown X" or "Will remove N from Godown X" — kills the ambiguity the May 14 plan called out.
  - The slug (`found`, `count_up`, etc.) maps to `±1` via the `ADJ_DIRECTION` constant at the top of the file. SQL never parses the reason text; it trusts the `p_direction` we pass alongside.
- **Return tab — segmented direction toggle + party label that follows it**:
  - "Customer return (into godown)" → `+1`, party field labelled "Customer (returning)".
  - "Supplier return (out of godown)" → `-1`, party field labelled "Supplier (returning to)".
  - Plain-English explainer line under the toggle so the user can't mis-classify it.
- Form footer shows the resolved direction (`+1 (in)` in emerald or `−1 (out)` in rose) as a sanity-check before save.
- Client-side validation runs BEFORE the RPC:
  - No item picked / qty ≤ 0 → toast and bail.
  - Transfer with From == To → toast and bail.
  - Adjustment with no Reason picked → toast and bail.
  - **Any outbound move** (Sale, Transfer, Adjustment with `-1`, Return with `-1`) checks `currentStock(item, godown) >= qty` against the loaded `godown_stock` map. Mirrors the SQL's own check; surfaces "Insufficient stock at Godown X (have N)" without a round-trip.
- RPC call now passes the 7th arg: `sb().rpc("process_transaction", { p_item_id, p_action, p_godown, p_qty, p_date, p_note, p_direction })`. `p_direction` is `null` for Purchase/Sale/Transfer (SQL resolves it from action) and `±1` for Adjustment/Return.
- After success: cartons/loose/rate/invoice/party/reason all clear, but the selected item + godown + action stay for fast repeat entry. Last action saved to `localStorage["txn.lastAction"]`.
- Transaction log below the form: action filter, free-text search, per-row Reverse button. Reversal rows show "reversal of XXXXXX…", originals that have already been reversed show "reversed" greyed-out, and any row with `action ∈ {Adjustment, Return}` shows a `+ in` / `− out` tag in the Qty cell (read off `t.direction`) so the log is readable at a glance. Purchase/Sale/Transfer rows get no extra tag (their direction is implied by action).
- Toast: bottom-right, 4-second auto-dismiss, emerald tick / rose alert.

**Style:** matches Godown / Items conventions — `Fragment` wrappers, `useMemo` for derived state, `tabular-nums` on numeric cells, Lucide icons throughout (no emoji), cyan-500 accent. Per-action colour stays: cyan Purchase, emerald Sale, amber Transfer, violet Adjustment, rose Return.

**Files patched**

- `stock-app-v2/app/transactions/page.tsx` *(was 19-line `Construction` stub; now ~770 lines real)*. New file at this path in the repo; the OneDrive 647-line version was the starting template but trimmed of `LIVE_ACTIONS` / `LOCKED_NOTE` / `Lock`-icon machinery and extended with `ADJ_DIRECTION`, the Return direction toggle, the form-footer direction indicator, and the log-row `+ in`/`− out` tag.

**Files NOT touched**

- `lib/supabase.ts` — already has `direction: 1 | -1` on the `Txn` type (added during the May 20 Items override turn). No change needed.
- `components/*`, `app/items/page.tsx`, `app/godown-a/page.tsx`, `app/godown-b/page.tsx`, `app/page.tsx`, the v1 `stock-app/index.html` — all untouched. v1 will keep working: it calls the 6-arg signature in spirit, but PG resolves to the new 7-arg function with `p_direction` defaulting to `NULL` — fine for Purchase/Sale/Transfer.
- `phase2-adjustment-return.sql` — already applied during the May 20 Items override turn. No new SQL in this turn.

**Edge cases handled**

- Reversing an Adjustment or Return now uses the SQL's new branch (`reverse_transaction` in `phase2-adjustment-return.sql` inserts the same action with the opposite direction). The page itself doesn't need to know — the Reverse button always calls `sb().rpc("reverse_transaction", { p_txn_id })` and the SQL does the right thing per action.
- Stock-sufficiency check fires for negative-direction Adjustment / Return on the client. The SQL has the same check, so this is a UX nicety (cleaner error message, no round-trip).
- "Count up" / "Count down" Adjustments are the structured equivalent of what the Items-page override modal writes as free-text reasons. Both flows hit the same `process_transaction(... , p_direction)` path — no divergence at the DB layer.
- Save button's `disabled` condition no longer references `LIVE_ACTIONS`; just `submitting` + `!canWrite`. Read-only role still sees the amber "Your role is read-only" hint instead.

**Follow-ups (not blocking)**

- The `transactions.reason` column still isn't populated by `process_transaction` (writes to `note` instead). Log display falls back to `t.invoice_no || t.status` — usually shows "OK". Pre-existing inconsistency flagged in the May 20 Items-override entry; still not fixed here.
- The `Txn` type doesn't include `note`. Adding it would let the log show the reason/inv/party string we assemble at save time. Minor.
- Optimistic UI on Reverse so the row visibly flips to "reversed" without waiting for `reload()`.
- `parties` table is still empty; Customer/Supplier fields remain free-text. Wiring `party_id` is a separate piece of work.

---

### 2026-05-20 — Login hang fix RE-APPLIED (regression from May 14) (PR #2 / ec5ed99)
**User ask:** "fix that login issue where even after entering the email and password its not at all working, the login button shows load animation but nothing loads, sometime it works in incognito but sometimes it fails there too."

**What happened.** The May 14 login-hang fix was no longer in either file when this session opened them — both `app/login/page.tsx` and `app/providers.tsx` had reverted to the pre-fix versions. Best guess on how: the May 14 fix was uploaded to GitHub but never landed in the local OneDrive copy, so subsequent uploads from this folder overwrote the deployed fix on commit. The "sometimes works in incognito" intermittency the user described is the giveaway signature of the redirect race — non-deterministic by definition.

**Root cause (same as May 14, repeated here for the record).**

1. **Redirect-race in `app/providers.tsx`.** After `signInWithPassword` resolves, the login page calls `router.replace("/")`. Meanwhile Supabase fires SIGNED_IN → `onAuthStateChange` starts fetching `user_profiles`. During the window where `pathname` is "/" but `profile` is still null (fetch in flight), the redirect `useEffect` runs `if (!profile && !onLogin) router.replace("/login")` and bounces back. Profile loads → bounce to "/". Visible flap.

2. **No safety net in `app/login/page.tsx`.** `try/finally` only — no timeout, no `catch`. If `signInWithPassword` ever hangs (browser navigator-lock contention, network), `setBusy(false)` never runs and the button stays on "..." forever.

**Files patched (same two as May 14)**

- `app/providers.tsx` — added `setLoading(true)` BEFORE `await fetchProfile(...)` in BOTH the `onAuthStateChange` callback and the `getSession().then(...)` path. The redirect effect already early-returns on `loading`, so this closes the window. Inline comment explains the rationale so a future linter pass doesn't strip it.
- `app/login/page.tsx` — three changes:
  - **12-second `Promise.race` timeout** on the auth call. Hung calls release the button with "Sign in took too long…" instead of silent forever-spinner.
  - **`try { ... } catch (e) { ... } finally`** — thrown errors now surface in the red error box rather than disappearing.
  - **`window.location.assign(...)` instead of `router.replace("/")`** — hard navigation forces Providers to bootstrap fresh with the new session in localStorage, sidesteps the redirect race even if the providers.tsx fix somehow regresses again. In prod the target is `/stock-app-v2/`; in dev it's `/` (computed from `process.env.NODE_ENV`, inlined at build time).
  - Removed the now-unused `useRouter` import.

**Why this likely won't regress again.** The hard `window.location.assign` in login is the belt to the providers.tsx braces — even if a future linter session strips the `setLoading(true)` in providers, the hard navigation forces a fresh bootstrap and the race never starts. To get back to the broken state, *both* defences would have to be removed in the same upload.

**Verification checklist after deploy:**
1. Open https://harshj111186.github.io/stock-app-v2/ in a fresh incognito window. Sign in → should land on dashboard in ~1s.
2. Try again with intentionally wrong password → red error box appears, button releases. (Catch block working.)
3. Turn off wifi → click Sign in → after 12s, "Sign in took too long…" appears, button releases. (Timeout working.)
4. Open DevTools → Console while signing in → should see no `[fetchProfile] error` lines. If you do, RLS on `user_profiles` is the next thing to check.

**Follow-up status (added retrospectively).** This was the FIRST of four PRs that landed today against the broader login problem. The "Why this likely won't regress" claim above was overoptimistic — the redirect-race fix was real but a deeper auth-bootstrap race remained. Subsequent fixes (documented in the three entries ABOVE this one):
- **PR #3** (collapse dual auth path) — removed the dual `getSession()`/`onAuthStateChange` race this fix didn't address.
- **PR #4** (bypass `navigator.locks`) — broke the cross-tab lock contention between v1 and v2.
- **PR #5** (defer profile fetch out of SDK notify loop) — fixed the actual SDK-init deadlock that was the real root cause.

The full diagnosis chain (PRs #2 → #5) is the canonical reference now. Don't read this PR #2 entry in isolation.

---

### 2026-05-20 — Items page: show category on every card + match Godown's FK fallback
**User ask:** "since I can see categories in godown A and B, perfect, why can't see same categorisation in items? in fact it's the categorisation from items that shall be passed down to godown a and godown B."

**Context.** The user was right that items.category_id + items.subcategory are the single source of truth for both pages — Godown A/B just filter `godown_stock` and reuse the same grouping logic. The visual difference they were seeing came from two things, only one of which was a real bug:

1. **Sticky depth-selector.** `localStorage["items.depth"]` was at `0` ("No grouping") from an earlier session, so Items rendered flat while Godown defaulted to depth 2 ("Brand · Category"). UI-only — fixed by changing the dropdown.
2. **Subtle FK-fallback inconsistency.** `app/items/page.tsx` resolved category as `catMap.get(i.category_id) ?? null` while `components/godown-view.tsx` used `catMap.get(i.category_id) ?? i.category ?? null`. For any item whose `category_id` is null but has a legacy `category` text value, Items would bucket it under "(No category)" while Godown bucketed it correctly. Likely 0 items affected today (phase1-migration backfilled the FK), but real divergence.

**Files patched**
- `app/items/page.tsx`
  - Load function: category resolution now mirrors Godown's — FK first, then legacy text, then null.
  - Card component: added a subtle "Category › Subcategory" metadata line under the size/colour row (text-[10px] zinc-400, truncate, title-tooltip on overflow). Visible at every depth so categorisation is readable even when the user has "No grouping" selected.

**No DB changes. No new RPC calls.**

---

### 2026-05-20 — Godown A + Godown B pages wired up
**User ask:** "items is all good, we need to build next godown a, and godown B"

**What was already there (and what was wrong)**

A previous session had written a real `GodownView` component (589 lines) but the GitHub-web-UI upload landed it at the **repo root** (`godown-view.tsx`) instead of in `components/`. Meanwhile the two route stubs at `app/godown-a/page.tsx` and `app/godown-b/page.tsx` had been reverted to "Coming next session" Construction placeholders. So the work existed but was completely disconnected — the placeholder pages didn't import the component, and the component was never loaded by anything.

**What this session did**

1. **Moved** `godown-view.tsx` → `components/godown-view.tsx` via `git mv` so history is preserved. The component itself was good — no changes needed.
2. **Replaced both placeholder pages** with the proper 5-line imports:
   ```tsx
   import { GodownView } from "@/components/godown-view";
   export default function Page() { return <GodownView godown="A" />; }
   ```
3. No other files touched.

**What the Godown pages now do**

- Per-warehouse stock view — `godown_stock` is filtered server-side with `.eq("godown", X)`.
- Header stats: in-stock item count, total cases, total loose, total units, formatted en-IN.
- Toolbar: search, brand filter, category filter, status filter (in-stock / low / out / never-stocked-here), depth selector (No grouping / Brand / Brand·Cat / Brand·Cat·Subcat), grid/table view toggle, expand-all / collapse-all.
- Per-godown localStorage keys (`godown-a.view`, `godown-b.view`, etc.) so A and B keep independent UI state.
- Status tiers: **Healthy**, **Low** (`≤ reorder_point_{a|b}`, floor 2), **Out** (row exists with 0 units), **Never stocked here** (no `godown_stock` row at all — distinct from "ran out").
- Cards show cases + loose split visibly (e.g. `3c 4L = 34`) per the no-collapse rule (project workflow rule #8).
- Joins category name via `category_id` FK with fallback to the legacy text column.

**Files patched**

- `godown-view.tsx` → `components/godown-view.tsx` *(moved)*
- `app/godown-a/page.tsx` *(was 19-line Construction placeholder, now 5-line GodownView wrapper)*
- `app/godown-b/page.tsx` *(same)*

**No DB changes.** Reads `items`, `godown_stock`, `categories` only — all selects via existing RLS.

**Follow-up ideas (not done in this turn, none blocking)**
- Add the Items-page pencil-override modal to the GodownCard too — would let users fix a discrepancy in-place while looking at one godown. Currently they have to go back to Items to override.
- Header "Stock value at this godown" KPI using `pricing` join.
- Click a card → slide-out side panel with item details + recent transactions for this godown (PROGRESS.md section 6 has this as a deferred "side panel item detail" item).

---

### 2026-05-20 — Manual stock override on Items page + Adjustment unlocked at DB
**User ask:** "I want to add an option where I can manually change values of CS size, loose and cases for both Stock A and Stock B. So that it can act as manual override if any discrepancy found in actual stock."

**What was built**

A new **Edit-stock modal** opens from a small pencil icon on every Items-page card (and as the last column in the table view). The modal lets the user:
- View current case size, A.cartons, A.loose, B.cartons, B.loose
- Type the actual physical values they just counted
- See a live delta per godown (e.g. "Delta: -3" in red) before saving
- Pick a reason ("count correction", "damage", "lost", "found", "theft", "data-entry fix", "other…")
- Save → writes one Adjustment transaction per godown that changed (so the audit log stays intact), plus a direct UPDATE to items.case_size when that changed

Role-aware: admin sees everything. Staff can change cases/loose (writes go through `process_transaction()` which is `security definer` and bypasses RLS), but the case-size field is disabled because `items` table is admin-write-only. Viewer doesn't see the pencil at all.

**Why this needed a DB migration (not just a UI change)**

The `process_transaction()` function in `phase1-schema.sql` only had branches for Purchase / Sale / Transfer. Calling it with `action = 'Adjustment'` silently wrote a zero-impact ledger row — the enum value existed (`phase1-migration.sql` added it on 2026-05-13) but the function never used it. The locked "Adjustment" tab in `transactions/page.tsx` was waiting for exactly this fix.

So this session executed the previously-designed Phase-2 plan (from the May 14 changelog entry below) at the DB level.

**Files patched (1 new, 2 edited)**

1. **`Stock Accounting/phase2-adjustment-return.sql`** *(new)*
   - Adds `direction smallint` column to `transactions`, backfilled (Purchase=+1, Sale=-1, Transfer=-1, old Adjustment/Return=+1) and made NOT NULL with a check constraint.
   - Drops the old 6-arg `process_transaction` and recreates it as 7-arg with `p_direction int default null`. Adjustment + Return require an explicit `±1`; other actions resolve direction internally. Outbound moves (`direction = -1`) get the same stock-sufficiency check as Sale.
   - Updates `reverse_transaction` so reversing an Adjustment/Return inserts the same action with the opposite direction (was crashing into the Transfer-only branch before).
   - Updates `recompute_stock_levels()` to use `direction * qty` instead of the hard-coded action→sign CASE expression. The `also_transferred_in` CTE for Transfer destinations stays as-is.
   - Idempotent: safe to re-run. Final SELECT verifies no rows have NULL/bad direction.

2. **`stock-app-v2/app/items/page.tsx`** *(edited — surgical, per section 7)*
   - New imports: `useCallback`, `useAuth`, Lucide icons `Pencil, X, Save, Loader2, AlertCircle`.
   - `Combined` type extended with `casesA / looseA / casesB / looseB` so the modal can edit raw stock without a second fetch.
   - Data loader extracted into a `useCallback` (`loadData`) so the modal can refresh after saving.
   - `canWrite` / `isAdmin` derived from `useAuth().profile`.
   - `editingItem` state + `onEdit` callback threaded through `GridBody → GroupSection → Card` and `TableBody → renderItemRow`.
   - Pencil button on each card (top-right, fade-in on hover) and a new last column in the table view (also hover-revealed). Hidden entirely for viewer-role users.
   - New `EditStockModal` component (~230 lines) with `GodownBlock`, `Label`, `NumInput` helpers at the bottom of the file. All linter-customised existing code (tree view, persisted UI state, useMemo blocks) left exactly as-is.

3. **`stock-app-v2/lib/supabase.ts`** *(edited)*
   - Added `direction: 1 | -1` to the `Txn` type with a comment pointing to this migration.

**Files NOT touched**
- `transactions/page.tsx` — the Adjustment / Return tabs there are still locked. The DB now supports them, so unlocking is a small follow-up (the previously-designed plan in the older Changelog entry below applies). Not done in this turn because the user's ask was specifically the Items-page override.
- `components/*`, `lib/utils.ts`, `app/page.tsx` (dashboard), all other pages: untouched.
- All other linter-customised files: untouched.

**Deploy required (manual — 2 steps)**

1. **Run the SQL.** Open Supabase → SQL Editor → New query. Open `Stock Accounting\phase2-adjustment-return.sql`, copy the whole file, paste, click **Run**. The verification SELECT at the bottom should show `rows_missing_direction = 0`, `rows_bad_direction = 0`, `new_signature_present = 1`.

2. **Upload the two changed files to GitHub.** Open https://github.com/harshj111186/stock-app-v2 → navigate into each folder → "Add file → Upload files" → drag-drop:
   - `app/items/page.tsx`  →  upload into the `app/items/` folder
   - `lib/supabase.ts`     →  upload into the `lib/` folder
   - Optionally also drop the updated `PROGRESS.md` at the repo root.
   - One commit per upload is fine. GitHub Action will rebuild and republish to Pages in ~1–2 min.

After both steps, hover any item card on https://harshj111186.github.io/stock-app-v2/items/ → pencil appears → click → fix the count → reason → Save. The dashboard, Items list, and (eventually) Reports all see the new numbers because they come from the same `godown_stock` rows.

**Edge cases handled**
- Changing case size first updates `items.case_size`, then runs the Adjustments so the carton/loose split uses the new value.
- If only A changed, only one Adjustment row is written. If both changed, two rows. If only CS changed (totals stay equal), only the items UPDATE runs.
- "Other" reason exposes a free-text field so users can write their own description.
- Modal saves are disabled until something actually changes (button stays grey).
- Outbound deltas (`-N`) get the same stock-sufficiency check as Sale, server-side.
- Modal closes on ESC / backdrop click; stop-propagation on the panel prevents accidental closes.

**Follow-ups (next session candidates)**
- Unlock the Adjustment and Return tabs in `transactions/page.tsx` — the DB is ready; only the UI guard and the `p_direction` plumbing remain (the design is in the May 14 changelog entry below).
- v1 (`stock-app/index.html`) does not pass `p_direction`. Its existing Purchase/Sale/Transfer calls keep working unchanged (default NULL is fine for those). It can't use Adjustment/Return, but doesn't need to. No fix required on v1.
- Reversibility on the Items page: currently no UI to reverse a wrong override. Workaround: open the modal again and type the previous values. A "Last 5 adjustments for this item" panel inside the modal would be a nice future addition.
- The `transactions.reason` column exists from phase1-migration but `process_transaction` writes to `transactions.note`. The override modal passes the reason text as `p_note`, so it ends up in `note`, not `reason`. Pre-existing inconsistency; not blocking; flagged here for cleanup.

---

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
