# Stock Manager — v2

Next.js 15 + Tailwind + shadcn-style components + Lucide + Supabase. Static-exported to GitHub Pages.

This is the v2 rebuild of the stock manager. The original (v1) lives at
[github.com/harshj111186/stock-app](https://github.com/harshj111186/stock-app)
and stays running while v2 is being built.

## Local dev (optional — you don't need to run this; GitHub Actions handles the build)

```bash
npm install
NEXT_PUBLIC_SUPABASE_URL=https://zvycuhldwfxpipcaeotc.supabase.co \
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_ANON_KEY \
npm run dev
```

## Deploy

Push to `main` → GitHub Action builds and publishes to GitHub Pages.

**Required GitHub repo secrets** (Settings → Secrets and variables → Actions → New repository secret):

| Name | Value |
|---|---|
| `SUPABASE_URL` | `https://zvycuhldwfxpipcaeotc.supabase.co` |
| `SUPABASE_ANON_KEY` | Your anon (public) key from Supabase → Settings → API |

Then in repo Settings → Pages, set Source to **GitHub Actions**.

## Stack

- **Next.js 15 App Router** — `output: 'export'` static export
- **Tailwind CSS** — design tokens in `app/globals.css`
- **Lucide React** — icons
- **Supabase JS v2** — auth + data
- **Recharts** — charts (dashboard, reports)

## Roadmap (from `stock_app_upgrade_prompt.md`)

- ✅ Phase 0 — Discovery
- ⏳ Phase 1 — UI foundation + data quality (current)
- Phase 2 — Inventory + side panel + all transaction types + realtime
- Phase 3 — Reports & analytics (10 reports)
- Phase 4 — GST + invoicing (deprioritised)
- Phase 5 — Power features

## Folder map

```
app/                 — Pages (Next.js App Router)
  layout.tsx         — Root + theme + auth provider
  page.tsx           — Dashboard
  login/page.tsx
  items/page.tsx
  godown-{a,b}/page.tsx
  transactions/page.tsx
  providers.tsx      — Theme + Supabase auth context
  globals.css        — Tailwind base + tokens
components/
  shell.tsx          — Layout wrapper (sidebar + topbar + auth guard)
  sidebar.tsx
  topbar.tsx
lib/
  supabase.ts        — Singleton Supabase client + DB types
  utils.ts           — cn(), fmt helpers, colourCss() (auto-fill)
```
