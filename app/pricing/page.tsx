"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Search, Loader2, Check, AlertCircle, Receipt, Plus, X,
} from "lucide-react";
import { Shell } from "@/components/shell";
import { useAuth } from "@/app/providers";
import { sb, type Item, type Pricing } from "@/lib/supabase";
import { fmtMoney } from "@/lib/utils";

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
  // redundant saves (each save fires an audit-trigger insert into price_history).
  baseLp: number;
  baseDiscs: number[];   // stored fractions, in order
  baseGst: number;
  hasRow: boolean;
};
type SaveState = "idle" | "saving" | "saved" | "error";

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
  const canWrite = profile?.role === "admin" || profile?.role === "staff";

  const [rows, setRows] = useState<Row[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [q, setQ] = useState("");
  const [brandFilter, setBrandFilter] = useState("");
  const [catFilter, setCatFilter] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(false);

  // Per-row save state — keyed by item id
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});

  // We read the latest row inside saveRow via this ref so blur handlers
  // don't capture stale closures from the change handlers above them.
  const rowsRef = useRef<Row[]>([]);
  rowsRef.current = rows;

  // ─── Load ─────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const c = sb();
      const [{ data: items, error: e1 }, { data: pricing, error: e2 }, { data: cats }] = await Promise.all([
        c.from("items").select("*").eq("archived", false).order("item_code"),
        c.from("pricing").select("*"),
        c.from("categories").select("id, name"),
      ]);
      if (e1 || e2) { setError((e1 || e2)!.message); setLoaded(true); return; }
      const catMap = new Map<string, string>(
        (cats || []).map((x: any) => [x.id as string, x.name as string])
      );
      const pMap = new Map<string, Pricing>();
      (pricing || []).forEach((p: any) => pMap.set(p.item_id, p as Pricing));

      const next: Row[] = (items || []).map((i: any) => {
        const p = pMap.get(i.id);
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
          category: catMap.get(i.category_id) ?? i.category ?? null,
          lp: lp ? String(lp) : "",
          discPcts: baseDiscs.map(d => String(+(d * 100).toFixed(2))),
          gstPct: String(+(gst * 100).toFixed(2)),
          baseLp: lp,
          baseDiscs,
          baseGst: gst,
          hasRow: !!p,
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
    if (onlyMissing && r.hasRow) return false;
    if (q) {
      const hay = `${r.brand || ""} ${r.model} ${r.size} ${r.colour} ${r.category || ""} ${r.subcategory || ""} ${r.item_code}`.toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    return true;
  }), [rows, q, brandFilter, catFilter, onlyMissing]);

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
  }, []);

  const saveRow = useCallback(async (id: string) => {
    const r = rowsRef.current.find(x => x.id === id);
    if (!r) return;

    const lpN = num(r.lp);
    // Filter out empty / zero discount slots before saving — a 0% discount
    // is a no-op, and we don't want to persist empty cells the user opened
    // with + but never filled.
    const discFracs = r.discPcts
      .map(pctToFrac)
      .filter(f => f > 0);
    const combined = combinedDisc(discFracs);
    const gstN = pctToFrac(r.gstPct);

    // Dirty check — short-circuit if nothing changed, so blurring an
    // unchanged input doesn't append a row to price_history.
    const eq = (a: number, b: number) => Math.round(a * 10000) === Math.round(b * 10000);
    if (eq(lpN, r.baseLp) && arrEq(discFracs, r.baseDiscs) && eq(gstN, r.baseGst)) return;

    // Don't create a pricing row from nothing — if LP is 0 and there's no
    // existing row, treat it as "still unset" and skip the write.
    if (!r.hasRow && lpN === 0) return;

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

      setRows(prev => prev.map(x => x.id === id ? {
        ...x,
        baseLp: lpN, baseDiscs: discFracs, baseGst: gstN,
        // Normalise the display strings to match what was saved (drops the
        // empty slots that were filtered above) so the dirty check stays
        // honest on the next blur.
        discPcts: discFracs.map(d => String(+(d * 100).toFixed(2))),
        hasRow: true,
      } : x));
      setSaveStates(prev => ({ ...prev, [id]: "saved" }));
      window.setTimeout(() => {
        setSaveStates(prev => prev[id] === "saved" ? { ...prev, [id]: "idle" } : prev);
      }, 1500);
    } catch (e: any) {
      setSaveStates(prev => ({ ...prev, [id]: "error" }));
      console.error("[pricing] save failed", e);
    }
  }, []);

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
        <div className="flex-1 min-w-[200px] relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
          <input
            value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search items…"
            className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md pl-9 pr-3 py-1.5 text-sm focus:outline-none focus:border-cyan-500"
          />
        </div>

        <select value={brandFilter} onChange={(e) => setBrandFilter(e.target.value)}
          className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md px-3 py-1.5 text-sm">
          <option value="">All brands</option>
          {brands.map(b => <option key={b} value={b}>{b}</option>)}
        </select>

        <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)}
          className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md px-3 py-1.5 text-sm">
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

        <div className="text-xs text-zinc-500 self-center ml-auto tabular-nums">
          {filtered.length} shown
        </div>
      </div>

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
        <Empty />
      ) : (
        <PricingTable
          rows={filtered}
          canWrite={canWrite}
          saveStates={saveStates}
          onLpChange={setLp}
          onGstChange={setGst}
          onDiscChange={setDiscAt}
          onDiscAdd={addDisc}
          onDiscRemove={removeDisc}
          onCommit={saveRow}
        />
      )}
    </Shell>
  );
}

// ─── Table ──────────────────────────────────────────────────────────────
// Desktop: real <table>. Mobile: stacked cards, one per item, with the same
// edit handlers so blur-save behaviour is identical.
function PricingTable({
  rows, canWrite, saveStates,
  onLpChange, onGstChange, onDiscChange, onDiscAdd, onDiscRemove, onCommit,
}: {
  rows: Row[];
  canWrite: boolean;
  saveStates: Record<string, SaveState>;
  onLpChange: (id: string, v: string) => void;
  onGstChange: (id: string, v: string) => void;
  onDiscChange: (id: string, idx: number, v: string) => void;
  onDiscAdd: (id: string) => void;
  onDiscRemove: (id: string, idx: number) => void;
  onCommit: (id: string) => void;
}) {
  return (
    <>
      {/* Desktop / tablet table — overflow-x-auto so a row with many stacked
          discounts can scroll horizontally rather than forcing the layout to
          widen. */}
      <div className="hidden md:block bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-x-auto">
        <table className="w-full text-sm min-w-[900px]">
          <thead className="bg-zinc-50 dark:bg-zinc-900/50 border-b border-zinc-200 dark:border-zinc-800">
            <tr className="text-zinc-500 text-[11px] uppercase tracking-wider">
              <th className="text-left px-5 py-2.5 font-medium">Item</th>
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
                onLpChange={onLpChange}
                onGstChange={onGstChange}
                onDiscChange={onDiscChange}
                onDiscAdd={onDiscAdd}
                onDiscRemove={onDiscRemove}
                onCommit={onCommit}
              />
            ))}
          </tbody>
        </table>
      </div>
      {/* Mobile cards */}
      <div className="md:hidden space-y-2">
        {rows.map(r => (
          <PricingMobileCard
            key={r.id}
            row={r}
            canWrite={canWrite}
            saveState={saveStates[r.id] ?? "idle"}
            onLpChange={onLpChange}
            onGstChange={onGstChange}
            onDiscChange={onDiscChange}
            onDiscAdd={onDiscAdd}
            onDiscRemove={onDiscRemove}
            onCommit={onCommit}
          />
        ))}
      </div>
    </>
  );
}

function PricingMobileCard({
  row, canWrite, saveState,
  onLpChange, onGstChange, onDiscChange, onDiscAdd, onDiscRemove, onCommit,
}: {
  row: Row;
  canWrite: boolean;
  saveState: SaveState;
  onLpChange: (id: string, v: string) => void;
  onGstChange: (id: string, v: string) => void;
  onDiscChange: (id: string, idx: number, v: string) => void;
  onDiscAdd: (id: string) => void;
  onDiscRemove: (id: string, idx: number) => void;
  onCommit: (id: string) => void;
}) {
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
          <div className="text-[11px] text-zinc-500 truncate">
            {[row.size, row.colour].filter(Boolean).join(" · ") || "—"}
            <span className="text-zinc-400"> · {row.item_code}</span>
            {!row.hasRow && <span className="ml-1 text-amber-500 uppercase tracking-wider">unpriced</span>}
          </div>
        </div>
        <SaveIndicator state={saveState} />
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
            onChange={(e) => onLpChange(row.id, e.target.value)}
            onBlur={commit}
            onKeyDown={handleKey}
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
            onChange={(e) => onGstChange(row.id, e.target.value)}
            onBlur={commit}
            onKeyDown={handleKey}
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
                  autoFocus={idx === row.discPcts.length - 1 && !pct}
                  onChange={(e) => onDiscChange(row.id, idx, e.target.value)}
                  onBlur={commit}
                  onKeyDown={handleKey}
                  onFocus={(e) => e.target.select()}
                  className="w-16 bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1.5 text-sm tnum text-right focus:outline-none focus:border-cyan-500 disabled:opacity-60 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
                {canWrite && (
                  <button
                    type="button"
                    onClick={() => onDiscRemove(row.id, idx)}
                    aria-label={`Remove discount ${idx + 1}`}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-zinc-200 dark:bg-zinc-700 text-zinc-500 hover:bg-rose-500 hover:text-white flex items-center justify-center"
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
}

function PricingRow({
  row, canWrite, saveState,
  onLpChange, onGstChange, onDiscChange, onDiscAdd, onDiscRemove, onCommit,
}: {
  row: Row;
  canWrite: boolean;
  saveState: SaveState;
  onLpChange: (id: string, v: string) => void;
  onGstChange: (id: string, v: string) => void;
  onDiscChange: (id: string, idx: number, v: string) => void;
  onDiscAdd: (id: string) => void;
  onDiscRemove: (id: string, idx: number) => void;
  onCommit: (id: string) => void;
}) {
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
        <div className="text-[11px] text-zinc-500 mt-0.5">
          {[row.size, row.colour].filter(Boolean).join(" · ") || "—"}
          <span className="text-zinc-400"> · {row.item_code}</span>
          {!row.hasRow && (
            <span className="ml-2 text-amber-500 text-[10px] uppercase tracking-wider">unpriced</span>
          )}
        </div>
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
                />
                {canWrite && (
                  <button
                    type="button"
                    onClick={() => onDiscRemove(row.id, idx)}
                    aria-label={`Remove discount ${idx + 1}`}
                    title="Remove this discount"
                    className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 rounded-full bg-zinc-200 dark:bg-zinc-700 text-zinc-500 hover:bg-rose-500 hover:text-white opacity-0 group-hover/disc:opacity-100 transition-opacity flex items-center justify-center"
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
        />
      </td>

      {/* Final (derived) */}
      <td className="px-3 py-2.5 text-right tnum font-semibold">
        {lpN > 0 ? fmtMoney(final) : <span className="text-zinc-400 font-normal">—</span>}
      </td>

      {/* Status */}
      <td className="px-3 py-2.5 text-center w-10">
        <SaveIndicator state={saveState} />
      </td>
    </tr>
  );
}

function NumCell({
  value, disabled, onChange, onBlur, onKeyDown, placeholder, align = "right",
  width = "w-full", autoFocus,
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
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      onFocus={(e) => e.target.select()}
      className={`${width} bg-transparent border border-transparent hover:border-zinc-200 dark:hover:border-zinc-700 focus:border-cyan-500 focus:bg-white dark:focus:bg-zinc-800 rounded px-2 py-1 ${align === "right" ? "text-right" : "text-left"} tnum focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
    />
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state === "saving") return <Loader2 className="w-3.5 h-3.5 text-zinc-400 animate-spin inline" aria-label="Saving" />;
  if (state === "saved")  return <Check className="w-3.5 h-3.5 text-emerald-500 inline" aria-label="Saved" />;
  if (state === "error")  return <AlertCircle className="w-3.5 h-3.5 text-rose-500 inline" aria-label="Save failed" />;
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

function Empty() {
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg py-16 text-center">
      <Receipt className="w-8 h-8 text-zinc-400 dark:text-zinc-600 mx-auto mb-3" strokeWidth={1.5} />
      <div className="text-sm text-zinc-500">No items match your filters.</div>
    </div>
  );
}
