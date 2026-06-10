"use client";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2, Check, AlertCircle, Receipt, Plus, X,
} from "lucide-react";
import { Shell } from "@/components/shell";
import { useAuth } from "@/app/providers";
import { sb, type Item, type Pricing } from "@/lib/supabase";
import { cn, fmtMoney, fmtN, matchesQuery } from "@/lib/utils";
import { pathById, type CatRow } from "@/lib/categories";
import { useMediaQuery } from "@/lib/hooks";
import { FilterSheet, SheetField, FilterButton } from "@/components/filter-sheet";
import { SearchBox } from "@/components/search-box";

// Pricing values are stored as FRACTIONS in Supabase (0.18 = 18%, 0.15 = 15%)
// but edited as plain percentages in the UI ("18", "15"). We convert at the
// boundary so the user never sees 0.18 in an input.
const DEFAULT_GST = 0.18;

type Row = Item & {
  // Editable display values (strings so the inputs can hold partial entries
  // like "" or "1." mid-typing without React coercing to NaN).
  lp: string;
  // Stacked discount inputs, each shown as % ("40" for 40%). Each entry is
  // applied to the price AFTER the preceding entry. e.g. ["40", "5"] means
  // 40% off, then a further 5% off the discounted price. Length is variable
  // — user adds/removes slots inline.
  discPcts: string[];
  gstPct: string;
  // What we last persisted — used to detect dirty edits and short-circuit
  // redundant saves (each save also appends a price_history audit row).
  baseLp: number;
  baseDiscs: number[];   // stored fractions, in order
  baseGst: number;
  hasRow: boolean;
  // Current physical stock (info only — not editable on this page).
  stock: number;
  stockA: number;
  stockB: number;
};
type SaveState = "idle" | "saving" | "saved" | "error";

// Coercing parsers — used ONLY for the live preview cells and the dirty
// check. Persisted values go through the strict validation in saveRow, so a
// cleared LP can never silently save as ₹0 again.
const num = (s: string) => {
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const pctToFrac = (s: string) => Math.min(1, num(s) / 100);
// Combined effective discount from a stack of fractions: 1 - product(1 - d_i).
// e.g. combinedDisc([0.40, 0.05]) === 1 - 0.6*0.95 === 0.43
const combinedDisc = (fracs: number[]) =>
  1 - fracs.reduce((acc, f) => acc * (1 - f), 1);

// Compare two number arrays for "effectively equal" — used in dirty checks.
// Rounded to 4 decimal places to dodge float noise.
const arrEq = (a: number[], b: number[]) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.round(a[i] * 10000) !== Math.round(b[i] * 10000)) return false;
  }
  return true;
};

export default function PricingPage() {
  const { profile } = useAuth();
  // The pricing RLS policy is ADMIN-ONLY (pricing_admin_write) — staff used
  // to get a fully editable UI whose every save silently failed.
  const canWrite = profile?.role === "admin";

  const [rows, setRows] = useState<Row[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [q, setQ] = useState("");
  const [brandFilter, setBrandFilter] = useState("");
  const [catFilter, setCatFilter] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Per-row save state — keyed by item id
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  // Per-row failure message (toast + icon tooltip) and the "set LP first"
  // hint for edits on still-unpriced rows.
  const [errMsgs, setErrMsgs] = useState<Record<string, string>>({});
  const [hints, setHints] = useState<Record<string, string>>({});

  // Page-level toast (validation + save failures).
  const [toast, setToast] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const toastTimer = useRef<number | null>(null);
  const showToast = useCallback((kind: "ok" | "bad", text: string) => {
    setToast({ kind, text });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  }, []);

  // Ids that flipped hasRow during THIS visit. "Only unpriced" keeps showing
  // them — otherwise a row vanished the moment its first field saved, often
  // mid-edit with the cursor still in it.
  const justPriced = useRef<Set<string>>(new Set());

  // We read the latest row inside saveRow via this ref so blur handlers
  // don't capture stale closures from the change handlers above them.
  const rowsRef = useRef<Row[]>([]);
  rowsRef.current = rows;

  // ─── Load ─────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const c = sb();
      const [{ data: items, error: e1 }, { data: pricing, error: e2 }, { data: cats }, { data: stock }] = await Promise.all([
        c.from("items").select("*").eq("archived", false).order("item_code"),
        c.from("pricing").select("*"),
        c.from("categories").select("id, name, parent_id, sort_order, archived"),
        c.from("godown_stock").select("*"),
      ]);
      if (e1 || e2) { setError((e1 || e2)!.message); setLoaded(true); return; }
      // Resolve each item's category to its FULL tree path ("Fans › Ceiling ›
      // Premium") — leaf names alone merge same-named siblings under
      // different parents, diverging from the Items page.
      const catRows: CatRow[] = ((cats || []) as any[]).map(x => ({
        id: x.id, name: x.name, parent_id: x.parent_id ?? null,
        sort_order: x.sort_order ?? 0, archived: x.archived ?? false,
      }));
      const catPath = pathById(catRows);
      const pMap = new Map<string, Pricing>();
      (pricing || []).forEach((p: any) => pMap.set(p.item_id, p as Pricing));
      // Current stock per item (info only): cases × case_size + loose, per godown.
      const sMap = new Map<string, { A: { cases: number; loose: number }; B: { cases: number; loose: number } }>();
      (stock || []).forEach((s: any) => {
        const e = sMap.get(s.item_id) ?? { A: { cases: 0, loose: 0 }, B: { cases: 0, loose: 0 } };
        if (s.godown === "A" || s.godown === "B") e[s.godown as "A" | "B"] = { cases: s.cases || 0, loose: s.loose || 0 };
        sMap.set(s.item_id, e);
      });

      const next: Row[] = (items || []).map((i: any) => {
        const p = pMap.get(i.id);
        const cs = i.case_size || 0;
        const sa = sMap.get(i.id)?.A ?? { cases: 0, loose: 0 };
        const sbk = sMap.get(i.id)?.B ?? { cases: 0, loose: 0 };
        const stockA = cs > 0 ? sa.cases * cs + sa.loose : sa.loose;
        const stockB = cs > 0 ? sbk.cases * cs + sbk.loose : sbk.loose;
        // Prefer the explicit discounts array (post-migration). Fall back to
        // the legacy single `discount` column if the array is empty but the
        // legacy field is set — covers any row that wasn't backfilled.
        const baseDiscs: number[] =
          Array.isArray(p?.discounts) && p!.discounts.length > 0
            ? (p!.discounts as number[])
            : p?.discount ? [p.discount] : [];
        // Default GST falls back: explicit pricing → item's own rate → 18%.
        const lp = p?.lp ?? 0;
        const gst = p?.gst_rate ?? (i.gst_rate ?? DEFAULT_GST);
        return {
          ...i,
          category: catPath.get(i.category_id) ?? i.category ?? null,
          lp: lp ? String(lp) : "",
          discPcts: baseDiscs.map(d => String(+(d * 100).toFixed(2))),
          gstPct: String(+(gst * 100).toFixed(2)),
          baseLp: lp,
          baseDiscs,
          baseGst: gst,
          hasRow: !!p,
          stockA, stockB, stock: stockA + stockB,
        };
      });
      setRows(next);
      setLoaded(true);
    })();
  }, []);

  // ─── Derived filter sources ──────────────────────────────────────────
  const brands = useMemo(
    () => [...new Set(rows.map(r => r.brand || "").filter(Boolean))].sort(),
    [rows]
  );
  // Categories cascade off the brand filter: pick a brand and the category
  // dropdown narrows to only the categories that brand actually has items in.
  // If no brand is picked, all categories show.
  const cats = useMemo(() => {
    const source = brandFilter ? rows.filter(r => r.brand === brandFilter) : rows;
    return [...new Set(source.map(r => r.category || "").filter(Boolean))].sort();
  }, [rows, brandFilter]);
  // If the currently-picked category is no longer valid for the new brand
  // (e.g. user picked "Switches" then changed brand to one that doesn't sell
  // switches), drop it. Otherwise the filter silently shows zero rows.
  useEffect(() => {
    if (catFilter && !cats.includes(catFilter)) setCatFilter("");
  }, [cats, catFilter]);

  // ─── Filtered rows ───────────────────────────────────────────────────
  const filtered = useMemo(() => rows.filter(r => {
    if (brandFilter && r.brand !== brandFilter) return false;
    if (catFilter && r.category !== catFilter) return false;
    // Rows priced during this visit stay visible (justPriced) so the row
    // doesn't vanish under the cursor after its first field saves.
    if (onlyMissing && r.hasRow && !justPriced.current.has(r.id)) return false;
    const hay = `${r.brand || ""} ${r.model} ${r.size} ${r.colour} ${r.category || ""} ${r.subcategory || ""} ${r.item_code}`;
    if (!matchesQuery(hay, q)) return false;
    return true;
  }), [rows, q, brandFilter, catFilter, onlyMissing]);

  const hasFilters = !!(q || brandFilter || catFilter || onlyMissing);
  const clearFilters = useCallback(() => {
    setQ(""); setBrandFilter(""); setCatFilter(""); setOnlyMissing(false);
  }, []);

  // ─── Counts for the header ───────────────────────────────────────────
  const priced = useMemo(() => rows.filter(r => r.hasRow).length, [rows]);

  // ─── Edit + save ─────────────────────────────────────────────────────
  // Plain-field updaters
  const setLp = useCallback((id: string, v: string) => {
    setRows(prev => prev.map(r => r.id === id ? { ...r, lp: v } : r));
  }, []);
  const setGst = useCallback((id: string, v: string) => {
    setRows(prev => prev.map(r => r.id === id ? { ...r, gstPct: v } : r));
  }, []);

  // Discount-stack operations
  const setDiscAt = useCallback((id: string, idx: number, v: string) => {
    setRows(prev => prev.map(r => {
      if (r.id !== id) return r;
      const next = r.discPcts.slice();
      next[idx] = v;
      return { ...r, discPcts: next };
    }));
  }, []);
  const addDisc = useCallback((id: string) => {
    setRows(prev => prev.map(r => r.id === id ? { ...r, discPcts: [...r.discPcts, ""] } : r));
  }, []);

  // Mark a row's save as failed: rose icon (with the message as tooltip) +
  // toast, then auto-clear after ~5s so the error state doesn't stick
  // around forever like it used to.
  const failRow = useCallback((id: string, msg: string) => {
    setSaveStates(prev => ({ ...prev, [id]: "error" }));
    setErrMsgs(prev => ({ ...prev, [id]: msg }));
    showToast("bad", msg);
    window.setTimeout(() => {
      setSaveStates(prev => (prev[id] === "error" ? { ...prev, [id]: "idle" } : prev));
      setErrMsgs(prev => {
        if (prev[id] !== msg) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }, 5000);
  }, [showToast]);

  const saveRow = useCallback(async (id: string) => {
    const r = rowsRef.current.find(x => x.id === id);
    if (!r) return;

    // Dirty check — short-circuit if nothing changed, so blurring an
    // unchanged input doesn't append a row to price_history. Uses the
    // coercing parsers purely for COMPARISON; nothing here is persisted.
    const lpDirty = num(r.lp);
    const discDirty = r.discPcts.map(pctToFrac).filter(f => f > 0);
    const gstDirty = pctToFrac(r.gstPct);
    const eq = (a: number, b: number) => Math.round(a * 10000) === Math.round(b * 10000);
    if (eq(lpDirty, r.baseLp) && arrEq(discDirty, r.baseDiscs) && eq(gstDirty, r.baseGst)) return;

    const lpText = r.lp.trim();
    const lpN = Number(lpText);

    // Don't create a pricing row from nothing — and TELL the user (the old
    // code silently dropped a discount/GST typed before any LP was set).
    if (!r.hasRow && (lpText === "" || lpN === 0)) {
      setHints(prev => ({ ...prev, [id]: "Set LP first — nothing saved yet" }));
      return;
    }

    // Validate BEFORE saving — never persist a coerced value the user
    // didn't type (clearing LP used to auto-save ₹0 over the real price,
    // and a 250% discount silently became 100%). The typed text stays in
    // the inputs so it can be fixed.
    if (lpText === "") { failRow(id, "LP can't be empty — not saved"); return; }
    if (!Number.isFinite(lpN) || lpN < 0) { failRow(id, "LP must be a number ≥ 0 — not saved"); return; }
    for (let i = 0; i < r.discPcts.length; i++) {
      const t = r.discPcts[i].trim();
      if (t === "") continue; // empty slot opened with + — filtered on save
      const n = Number(t);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        failRow(id, `Discount ${i + 1} must be between 0 and 100% — not saved`);
        return;
      }
    }
    const gstText = r.gstPct.trim();
    if (gstText === "") { failRow(id, "GST % can't be empty — not saved"); return; }
    const gstNum = Number(gstText);
    if (!Number.isFinite(gstNum) || gstNum < 0 || gstNum > 100) {
      failRow(id, "GST % must be between 0 and 100 — not saved");
      return;
    }

    // Filter out empty / zero discount slots before saving — a 0% discount
    // is a no-op, and we don't want to persist empty cells the user opened
    // with + but never filled.
    const discFracs = r.discPcts
      .map(s => s.trim())
      .filter(s => s !== "")
      .map(t => Number(t) / 100)
      .filter(f => f > 0);
    const combined = combinedDisc(discFracs);
    const gstN = gstNum / 100;

    setSaveStates(prev => ({ ...prev, [id]: "saving" }));
    try {
      const today = new Date().toISOString().slice(0, 10);
      const { error: e } = await sb().from("pricing").upsert({
        item_id: id,
        lp: lpN,
        // Keep both columns in sync: `discount` is the combined effective
        // (legacy readers like the dashboard's stock-value KPI use this),
        // `discounts` is the breakdown (so the page can reconstruct the
        // stack on reload).
        discount: combined,
        discounts: discFracs,
        gst_rate: gstN,
        effective_from: today,
      }, { onConflict: "item_id" });
      if (e) throw e;

      // History row keeps the stacked breakdown too. `price_history.discounts`
      // arrives with the 2026-06-10 migration — if it hasn't been run yet,
      // retry without the field so the history row is never lost.
      const hist: Record<string, unknown> = {
        item_id: id, lp: lpN, discount: combined, discounts: discFracs, gst_rate: gstN,
      };
      let { error: he } = await sb().from("price_history").insert(hist);
      if (he && /discounts/i.test(he.message || "")) {
        delete hist.discounts;
        ({ error: he } = await sb().from("price_history").insert(hist));
      }
      if (he) console.error("[pricing] price_history insert failed (pricing row itself saved)", he);

      if (!r.hasRow) justPriced.current.add(id);
      setRows(prev => prev.map(x => x.id === id ? {
        ...x,
        baseLp: lpN, baseDiscs: discFracs, baseGst: gstN,
        // Normalise the display strings to match what was saved (drops the
        // empty slots that were filtered above) so the dirty check stays
        // honest on the next blur.
        discPcts: discFracs.map(d => String(+(d * 100).toFixed(2))),
        hasRow: true,
      } : x));
      setHints(prev => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setSaveStates(prev => ({ ...prev, [id]: "saved" }));
      window.setTimeout(() => {
        setSaveStates(prev => prev[id] === "saved" ? { ...prev, [id]: "idle" } : prev);
      }, 1500);
    } catch (e: any) {
      console.error("[pricing] save failed", e);
      failRow(id, e?.message || "Save failed — check your connection.");
    }
  }, [failRow]);

  // Removing a discount triggers an immediate save — clicking × is an
  // explicit "I'm done with this" action, no blur needed.
  const removeDisc = useCallback((id: string, idx: number) => {
    setRows(prev => prev.map(r => {
      if (r.id !== id) return r;
      const next = r.discPcts.slice();
      next.splice(idx, 1);
      return { ...r, discPcts: next };
    }));
    // Defer save by a tick so the state has settled.
    window.setTimeout(() => saveRow(id), 0);
  }, [saveRow]);

  return (
    <Shell title="Pricing">
      {/* ─── Header ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Pricing</h1>
          <p className="text-sm text-zinc-500 mt-1">
            {loaded
              ? <>{priced} of {rows.length} items priced · LP, stacked discounts, GST. Edits save on blur.</>
              : "Loading…"}
          </p>
        </div>
      </div>

      {/* ─── Toolbar ────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2 mb-4 items-center">
        <SearchBox
          value={q}
          onChange={setQ}
          placeholder="Search — model, colour, size…"
          className="flex-1 min-w-[200px]"
        />

        {/* Mobile: filters live in a bottom sheet to keep the toolbar to one row */}
        <FilterButton
          activeCount={(brandFilter ? 1 : 0) + (catFilter ? 1 : 0) + (onlyMissing ? 1 : 0)}
          onClick={() => setFiltersOpen(true)}
        />

        {/* Desktop: inline filters */}
        <div className="hidden md:flex md:flex-wrap md:gap-2 md:items-center">
          <select value={brandFilter} onChange={(e) => setBrandFilter(e.target.value)}
            className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:border-cyan-500">
            <option value="">All brands</option>
            {brands.map(b => <option key={b} value={b}>{b}</option>)}
          </select>

          <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)}
            className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:border-cyan-500">
            <option value="">{brandFilter ? `All categories in ${brandFilter}` : "All categories"}</option>
            {cats.map(c => <option key={c} value={c}>{c}</option>)}
          </select>

          <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400 px-2 py-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={onlyMissing}
              onChange={(e) => setOnlyMissing(e.target.checked)}
              className="accent-cyan-500"
            />
            Only unpriced
          </label>
        </div>

        <div className="text-xs text-zinc-500 self-center ml-auto tabular-nums">
          {filtered.length} shown
        </div>
      </div>

      {/* Mobile filters sheet */}
      <FilterSheet
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        onClear={() => { setBrandFilter(""); setCatFilter(""); setOnlyMissing(false); }}
      >
        <SheetField label="Brand">
          <select value={brandFilter} onChange={(e) => setBrandFilter(e.target.value)} className="w-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-cyan-500">
            <option value="">All brands</option>
            {brands.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </SheetField>
        <SheetField label="Category">
          <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)} className="w-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-cyan-500">
            <option value="">{brandFilter ? `All categories in ${brandFilter}` : "All categories"}</option>
            {cats.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </SheetField>
        <SheetField label="Pricing">
          <label className="flex items-center gap-2 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm cursor-pointer select-none">
            <input
              type="checkbox"
              checked={onlyMissing}
              onChange={(e) => setOnlyMissing(e.target.checked)}
              className="accent-cyan-500"
            />
            Only unpriced
          </label>
        </SheetField>
      </FilterSheet>

      {/* ─── Body ──────────────────────────────────────────────── */}
      {error && (
        <div className="mb-3 text-sm text-rose-600 dark:text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-md p-2.5 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!loaded ? (
        <Skeleton />
      ) : filtered.length === 0 ? (
        <Empty hasFilters={hasFilters} onClear={clearFilters} />
      ) : (
        <PricingTable
          rows={filtered}
          canWrite={canWrite}
          saveStates={saveStates}
          errMsgs={errMsgs}
          hints={hints}
          onLpChange={setLp}
          onGstChange={setGst}
          onDiscChange={setDiscAt}
          onDiscAdd={addDisc}
          onDiscRemove={removeDisc}
          onCommit={saveRow}
        />
      )}

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            "fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg shadow-lg text-sm font-medium",
            toast.kind === "ok"
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/40"
              : "bg-rose-500/15 text-rose-700 dark:text-rose-300 border border-rose-500/40"
          )}
        >
          {toast.text}
        </div>
      )}
    </Shell>
  );
}

// ─── Table ──────────────────────────────────────────────────────────────
// Desktop: real <table>. Mobile: stacked cards, one per item, with the same
// edit handlers so blur-save behaviour is identical. Renders EXACTLY ONE of
// the two layouts via media query (mounting both meant ~2× the live inputs,
// all re-rendered per keystroke).
type RowHandlers = {
  onLpChange: (id: string, v: string) => void;
  onGstChange: (id: string, v: string) => void;
  onDiscChange: (id: string, idx: number, v: string) => void;
  onDiscAdd: (id: string) => void;
  onDiscRemove: (id: string, idx: number) => void;
  onCommit: (id: string) => void;
};

function PricingTable({
  rows, canWrite, saveStates, errMsgs, hints,
  onLpChange, onGstChange, onDiscChange, onDiscAdd, onDiscRemove, onCommit,
}: {
  rows: Row[];
  canWrite: boolean;
  saveStates: Record<string, SaveState>;
  errMsgs: Record<string, string>;
  hints: Record<string, string>;
} & RowHandlers) {
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const handlers = { onLpChange, onGstChange, onDiscChange, onDiscAdd, onDiscRemove, onCommit };

  if (isDesktop) {
    return (
      // overflow-x-auto so a row with many stacked discounts can scroll
      // horizontally rather than forcing the layout to widen.
      <div className="hidden md:block bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-x-auto">
        <table className="w-full text-sm min-w-[900px]">
          <thead className="bg-zinc-50 dark:bg-zinc-900/50 border-b border-zinc-200 dark:border-zinc-800">
            <tr className="text-zinc-500 text-[11px] uppercase tracking-wider">
              <th className="text-left px-5 py-2.5 font-medium">Item</th>
              <th className="text-right px-3 py-2.5 font-medium w-20">Stock</th>
              <th className="text-right px-3 py-2.5 font-medium w-28">LP (₹)</th>
              <th className="text-left px-3 py-2.5 font-medium">Discounts (%)</th>
              <th className="text-right px-3 py-2.5 font-medium w-28">Taxable (₹)</th>
              <th className="text-right px-3 py-2.5 font-medium w-24">GST %</th>
              <th className="text-right px-3 py-2.5 font-medium w-28">Final (₹)</th>
              <th className="text-center px-3 py-2.5 font-medium w-10" aria-label="save status" />
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <PricingRow
                key={r.id}
                row={r}
                canWrite={canWrite}
                saveState={saveStates[r.id] ?? "idle"}
                errorMsg={errMsgs[r.id]}
                hint={hints[r.id]}
                {...handlers}
              />
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div className="md:hidden space-y-2">
      {rows.map(r => (
        <PricingMobileCard
          key={r.id}
          row={r}
          canWrite={canWrite}
          saveState={saveStates[r.id] ?? "idle"}
          errorMsg={errMsgs[r.id]}
          hint={hints[r.id]}
          {...handlers}
        />
      ))}
    </div>
  );
}

type RowProps = {
  row: Row;
  canWrite: boolean;
  saveState: SaveState;
  errorMsg?: string;
  hint?: string;
} & RowHandlers;

// memo: only the row being edited re-renders per keystroke — the handler
// props are all stable useCallbacks and everything else is a primitive.
const PricingMobileCard = memo(function PricingMobileCard({
  row, canWrite, saveState, errorMsg, hint,
  onLpChange, onGstChange, onDiscChange, onDiscAdd, onDiscRemove, onCommit,
}: RowProps) {
  const lpN = num(row.lp);
  const discFracs = row.discPcts.map(pctToFrac).filter(f => f > 0);
  const combined = combinedDisc(discFracs);
  const gstN = pctToFrac(row.gstPct);
  const taxable = lpN * (1 - combined);
  const final = taxable * (1 + gstN);

  const commit = () => onCommit(row.id);
  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
  };
  // Mouse-wheel over a focused number input mutates the value, which the
  // blur then saves — bail out of focus instead.
  const wheelBlur = (e: React.WheelEvent<HTMLInputElement>) =>
    (e.currentTarget as HTMLInputElement).blur();
  const lastIsEmpty = row.discPcts.length > 0 && !row.discPcts[row.discPcts.length - 1].trim();
  const canAddDisc = canWrite && !lastIsEmpty;

  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-sm p-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            {row.brand
              ? <span className="bg-cyan-500/15 text-cyan-600 dark:text-cyan-300 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-medium flex-shrink-0">{row.brand}</span>
              : <span className="text-zinc-400 text-[10px] italic">no brand</span>}
            <span className="text-sm font-medium truncate">{row.model}</span>
          </div>
          <div className="text-[10px] text-zinc-500 tnum">{row.item_code}</div>
          <div className="text-[11px] text-zinc-500 truncate">
            {[row.size, row.colour].filter(Boolean).join(" · ") || "—"}
            <span className="ml-1 text-zinc-400" title={`A: ${fmtN(row.stockA)} · B: ${fmtN(row.stockB)}`}>
              · stock <span className={`tnum ${row.stock === 0 ? "text-rose-500" : "text-zinc-600 dark:text-zinc-300"}`}>{fmtN(row.stock)}</span>
            </span>
            {!row.hasRow && <span className="ml-1 text-amber-500 uppercase tracking-wider">unpriced</span>}
          </div>
        </div>
        <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
          <SaveIndicator state={saveState} errorMsg={errorMsg} />
          {hint && <span className="text-[10px] text-amber-500 text-right">{hint}</span>}
        </div>
      </div>

      {/* LP + GST in a row */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">LP (₹)</div>
          <input
            type="number" inputMode="decimal" min="0" step="0.01"
            value={row.lp}
            placeholder="0"
            disabled={!canWrite}
            aria-label={`${row.model} ${row.size} — LP`}
            onChange={(e) => onLpChange(row.id, e.target.value)}
            onBlur={commit}
            onKeyDown={handleKey}
            onWheel={wheelBlur}
            onFocus={(e) => e.target.select()}
            className="w-full bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-2 text-sm tnum focus:outline-none focus:border-cyan-500 disabled:opacity-60 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">GST %</div>
          <input
            type="number" inputMode="decimal" min="0" step="0.01"
            value={row.gstPct}
            placeholder="18"
            disabled={!canWrite}
            aria-label={`${row.model} ${row.size} — GST %`}
            onChange={(e) => onGstChange(row.id, e.target.value)}
            onBlur={commit}
            onKeyDown={handleKey}
            onWheel={wheelBlur}
            onFocus={(e) => e.target.select()}
            className="w-full bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-2 text-sm tnum focus:outline-none focus:border-cyan-500 disabled:opacity-60 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
        </div>
      </div>

      {/* Stacked discounts */}
      <div className="mb-3">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">Discounts (%)</div>
        <div className="flex flex-wrap items-center gap-1.5">
          {row.discPcts.map((pct, idx) => (
            <span key={idx} className="flex items-center gap-1 group/disc">
              {idx > 0 && <span className="text-zinc-400 text-[11px] select-none">×</span>}
              <div className="relative">
                <input
                  type="number" inputMode="decimal" min="0" step="0.01"
                  value={pct}
                  placeholder="0"
                  disabled={!canWrite}
                  aria-label={`${row.model} ${row.size} — discount ${idx + 1}`}
                  autoFocus={idx === row.discPcts.length - 1 && !pct}
                  onChange={(e) => onDiscChange(row.id, idx, e.target.value)}
                  onBlur={commit}
                  onKeyDown={handleKey}
                  onWheel={wheelBlur}
                  onFocus={(e) => e.target.select()}
                  className="w-16 bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1.5 text-sm tnum text-right focus:outline-none focus:border-cyan-500 disabled:opacity-60 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
                {canWrite && (
                  <button
                    type="button"
                    onClick={() => onDiscRemove(row.id, idx)}
                    aria-label={`Remove discount ${idx + 1}`}
                    className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-zinc-200 dark:bg-zinc-700 text-zinc-500 hover:bg-rose-500 hover:text-white flex items-center justify-center"
                  >
                    <X className="w-3 h-3" strokeWidth={3} />
                  </button>
                )}
              </div>
            </span>
          ))}
          {canWrite && (
            <button
              type="button"
              onClick={() => onDiscAdd(row.id)}
              disabled={!canAddDisc}
              aria-label="Add stacked discount"
              className="w-8 h-8 rounded border border-dashed border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:border-cyan-500 hover:text-cyan-500 disabled:opacity-30 flex items-center justify-center"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          )}
          {discFracs.length > 1 && (
            <span className="ml-1 text-[10px] tabular-nums text-zinc-400 dark:text-zinc-500 self-center" title="Combined effective discount">
              = {(combined * 100).toFixed(combined * 100 < 10 ? 2 : 1)}%
            </span>
          )}
        </div>
      </div>

      {/* Derived values */}
      <div className="grid grid-cols-2 gap-3 pt-3 border-t border-zinc-100 dark:border-zinc-800/60 text-sm">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-0.5">Taxable</div>
          <div className="tnum text-zinc-700 dark:text-zinc-300">
            {lpN > 0 ? fmtMoney(taxable) : <span className="text-zinc-400">—</span>}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-0.5">Final</div>
          <div className="tnum font-semibold">
            {lpN > 0 ? fmtMoney(final) : <span className="text-zinc-400 font-normal">—</span>}
          </div>
        </div>
      </div>
    </div>
  );
});

const PricingRow = memo(function PricingRow({
  row, canWrite, saveState, errorMsg, hint,
  onLpChange, onGstChange, onDiscChange, onDiscAdd, onDiscRemove, onCommit,
}: RowProps) {
  // Live-computed values for the read-only Taxable / Final cells. Combine
  // the stack each render so the user sees the effect of every keystroke.
  const lpN = num(row.lp);
  const discFracs = row.discPcts.map(pctToFrac).filter(f => f > 0);
  const combined = combinedDisc(discFracs);
  const gstN = pctToFrac(row.gstPct);
  const taxable = lpN * (1 - combined);
  const final = taxable * (1 + gstN);

  const commit = () => onCommit(row.id);
  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter commits without forcing the user to tab out.
    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
  };

  // Disable + when the last existing slot is empty — prevents the user from
  // racking up a row of blank inputs that get filtered out on save anyway.
  const lastIsEmpty = row.discPcts.length > 0 && !row.discPcts[row.discPcts.length - 1].trim();
  const canAddDisc = canWrite && !lastIsEmpty;

  return (
    <tr className="border-t border-zinc-200/50 dark:border-zinc-800/50 hover:bg-zinc-50 dark:hover:bg-zinc-800/30">
      {/* Item identity */}
      <td className="px-5 py-2.5 min-w-[260px]">
        <div className="flex items-center gap-2">
          {row.brand
            ? <span className="bg-cyan-500/15 text-cyan-600 dark:text-cyan-300 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-medium">{row.brand}</span>
            : <span className="text-zinc-400 text-[10px] italic">no brand</span>}
          <span className="truncate">{row.model}</span>
        </div>
        {/* Item code — same model/size/colour variants are otherwise
            indistinguishable on this page. */}
        <div className="text-[10px] text-zinc-500 tnum mt-0.5">{row.item_code}</div>
        <div className="text-[11px] text-zinc-500 mt-0.5">
          {[row.size, row.colour].filter(Boolean).join(" · ") || "—"}
          {!row.hasRow && (
            <span className="ml-2 text-amber-500 text-[10px] uppercase tracking-wider">unpriced</span>
          )}
        </div>
      </td>

      {/* Current stock (info only) */}
      <td className="px-3 py-2.5 text-right">
        <span
          className={`tnum text-xs ${row.stock === 0 ? "text-rose-500" : "text-zinc-600 dark:text-zinc-300"}`}
          title={`A: ${fmtN(row.stockA)} · B: ${fmtN(row.stockB)}`}
        >
          {fmtN(row.stock)}
        </span>
      </td>

      {/* LP */}
      <td className="px-3 py-2.5 text-right">
        <NumCell
          value={row.lp}
          disabled={!canWrite}
          onChange={(v) => onLpChange(row.id, v)}
          onBlur={commit}
          onKeyDown={handleKey}
          placeholder="0"
          align="right"
          ariaLabel={`${row.model} ${row.size} — LP`}
        />
      </td>

      {/* Stacked discounts */}
      <td className="px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-1">
          {row.discPcts.map((pct, idx) => (
            <span key={idx} className="flex items-center gap-1 group/disc">
              {idx > 0 && <span className="text-zinc-400 text-[11px] select-none">×</span>}
              <div className="relative">
                <NumCell
                  value={pct}
                  disabled={!canWrite}
                  onChange={(v) => onDiscChange(row.id, idx, v)}
                  onBlur={commit}
                  onKeyDown={handleKey}
                  placeholder="0"
                  align="right"
                  width="w-16"
                  autoFocus={idx === row.discPcts.length - 1 && !pct}
                  ariaLabel={`${row.model} ${row.size} — discount ${idx + 1}`}
                />
                {canWrite && (
                  <button
                    type="button"
                    onClick={() => onDiscRemove(row.id, idx)}
                    aria-label={`Remove discount ${idx + 1}`}
                    title="Remove this discount"
                    className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 rounded-full bg-zinc-200 dark:bg-zinc-700 text-zinc-500 hover:bg-rose-500 hover:text-white opacity-0 group-hover/disc:opacity-100 focus-visible:opacity-100 transition-opacity flex items-center justify-center"
                  >
                    <X className="w-2.5 h-2.5" strokeWidth={3} />
                  </button>
                )}
              </div>
            </span>
          ))}
          {canWrite && (
            <button
              type="button"
              onClick={() => onDiscAdd(row.id)}
              disabled={!canAddDisc}
              aria-label="Add stacked discount"
              title={lastIsEmpty ? "Fill the last discount first" : "Add another stacked discount"}
              className="w-6 h-6 rounded border border-dashed border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:border-cyan-500 hover:text-cyan-500 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:border-zinc-300 dark:disabled:hover:border-zinc-700 disabled:hover:text-zinc-500 flex items-center justify-center"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          )}
          {/* Show the combined effective when there's >1 active discount, so
              the user can confirm "40 + 5" really arrived at 43%. */}
          {discFracs.length > 1 && (
            <span
              className="ml-2 text-[10px] tabular-nums text-zinc-400 dark:text-zinc-500 self-center"
              title="Combined effective discount = 1 − ∏(1 − dᵢ)"
            >
              = {(combined * 100).toFixed(combined * 100 < 10 ? 2 : 1)}%
            </span>
          )}
        </div>
      </td>

      {/* Taxable (derived) */}
      <td className="px-3 py-2.5 text-right tnum text-zinc-700 dark:text-zinc-300">
        {lpN > 0 ? fmtMoney(taxable) : <span className="text-zinc-400">—</span>}
      </td>

      {/* GST % */}
      <td className="px-3 py-2.5 text-right">
        <NumCell
          value={row.gstPct}
          disabled={!canWrite}
          onChange={(v) => onGstChange(row.id, v)}
          onBlur={commit}
          onKeyDown={handleKey}
          placeholder="18"
          align="right"
          ariaLabel={`${row.model} ${row.size} — GST %`}
        />
      </td>

      {/* Final (derived) */}
      <td className="px-3 py-2.5 text-right tnum font-semibold">
        {lpN > 0 ? fmtMoney(final) : <span className="text-zinc-400 font-normal">—</span>}
      </td>

      {/* Status */}
      <td className="px-3 py-2.5 text-center w-10">
        <SaveIndicator state={saveState} errorMsg={errorMsg} />
        {hint && (
          <div className="text-[10px] text-amber-500 whitespace-nowrap mt-0.5">{hint}</div>
        )}
      </td>
    </tr>
  );
});

function NumCell({
  value, disabled, onChange, onBlur, onKeyDown, placeholder, align = "right",
  width = "w-full", autoFocus, ariaLabel,
}: {
  value: string;
  disabled?: boolean;
  onChange: (v: string) => void;
  onBlur: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  placeholder?: string;
  align?: "right" | "left";
  width?: string;
  autoFocus?: boolean;
  ariaLabel?: string;
}) {
  if (disabled) {
    return <span className={`tnum text-zinc-600 dark:text-zinc-400 ${align === "right" ? "text-right" : ""}`}>{value || "—"}</span>;
  }
  return (
    <input
      type="number"
      inputMode="decimal"
      min="0"
      step="0.01"
      value={value}
      placeholder={placeholder}
      autoFocus={autoFocus}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      // Mouse-wheel over a focused number input mutates the value, which the
      // blur then saves — bail out of focus instead.
      onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()}
      onFocus={(e) => e.target.select()}
      className={`${width} bg-transparent border border-transparent hover:border-zinc-200 dark:hover:border-zinc-700 focus:border-cyan-500 focus:bg-white dark:focus:bg-zinc-800 rounded px-2 py-1 ${align === "right" ? "text-right" : "text-left"} tnum focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
    />
  );
}

function SaveIndicator({ state, errorMsg }: { state: SaveState; errorMsg?: string }) {
  if (state === "saving") return <Loader2 className="w-3.5 h-3.5 text-zinc-400 animate-spin inline" aria-label="Saving" />;
  if (state === "saved")  return <Check className="w-3.5 h-3.5 text-emerald-500 inline" aria-label="Saved" />;
  if (state === "error")  return (
    <span title={errorMsg || "Save failed"}>
      <AlertCircle className="w-3.5 h-3.5 text-rose-500 inline" aria-label={errorMsg || "Save failed"} />
    </span>
  );
  return null;
}

// ─── States ─────────────────────────────────────────────────────────────
function Skeleton() {
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden p-5 space-y-3">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="h-4 rounded shimmer" style={{ width: `${55 + (i * 7) % 45}%` }} />
      ))}
    </div>
  );
}

function Empty({ hasFilters, onClear }: { hasFilters: boolean; onClear: () => void }) {
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg py-16 text-center">
      <Receipt className="w-8 h-8 text-zinc-400 dark:text-zinc-600 mx-auto mb-3" strokeWidth={1.5} />
      <div className="text-sm text-zinc-500">No items match your filters.</div>
      {hasFilters && (
        <button onClick={onClear} className="mt-3 text-xs text-cyan-600 dark:text-cyan-400 hover:underline">Clear filters</button>
      )}
    </div>
  );
}
