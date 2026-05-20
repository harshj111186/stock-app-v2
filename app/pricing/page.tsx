"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Search, Loader2, Check, AlertCircle, Receipt, IndianRupee,
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
  discPct: string;   // shown as % ("15" for 15%)
  gstPct: string;    // shown as % ("18" for 18%)
  // What we last persisted — used to detect dirty edits and short-circuit
  // redundant saves (each save fires an audit-trigger insert into price_history).
  baseLp: number;
  baseDisc: number;
  baseGst: number;
  hasRow: boolean;
};
type SaveState = "idle" | "saving" | "saved" | "error";

const num = (s: string) => {
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const pctToFrac = (s: string) => Math.min(1, num(s) / 100);

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
        // Default GST falls back: explicit pricing → item's own rate → 18%.
        // items.gst_rate is unused per PROGRESS.md but we honour it if set.
        const lp = p?.lp ?? 0;
        const disc = p?.discount ?? 0;
        const gst = p?.gst_rate ?? (i.gst_rate ?? DEFAULT_GST);
        return {
          ...i,
          category: catMap.get(i.category_id) ?? i.category ?? null,
          lp: lp ? String(lp) : "",
          discPct: disc ? String(+(disc * 100).toFixed(2)) : "",
          gstPct: String(+(gst * 100).toFixed(2)),
          baseLp: lp,
          baseDisc: disc,
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
  const cats = useMemo(
    () => [...new Set(rows.map(r => r.category || "").filter(Boolean))].sort(),
    [rows]
  );

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
  const updateRow = useCallback((id: string, patch: Partial<Pick<Row, "lp" | "discPct" | "gstPct">>) => {
    setRows(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r));
  }, []);

  const saveRow = useCallback(async (id: string) => {
    const r = rowsRef.current.find(x => x.id === id);
    if (!r) return;

    const lpN = num(r.lp);
    const discN = pctToFrac(r.discPct);
    const gstN = pctToFrac(r.gstPct);

    // Dirty check — round to 4 decimals to dodge float noise (0.15 !== 0.15000000000000002).
    const eq = (a: number, b: number) => Math.round(a * 10000) === Math.round(b * 10000);
    if (eq(lpN, r.baseLp) && eq(discN, r.baseDisc) && eq(gstN, r.baseGst)) return;

    // Don't create a pricing row from nothing — if LP is 0 and there's no
    // existing row, treat it as "still unset" and skip the write.
    if (!r.hasRow && lpN === 0) return;

    setSaveStates(prev => ({ ...prev, [id]: "saving" }));
    try {
      const today = new Date().toISOString().slice(0, 10);
      const { error: e } = await sb().from("pricing").upsert({
        item_id: id,
        lp: lpN,
        discount: discN,
        gst_rate: gstN,
        effective_from: today,
      }, { onConflict: "item_id" });
      if (e) throw e;

      setRows(prev => prev.map(x => x.id === id ? {
        ...x,
        baseLp: lpN, baseDisc: discN, baseGst: gstN,
        hasRow: true,
      } : x));
      setSaveStates(prev => ({ ...prev, [id]: "saved" }));
      // Fade the "saved" tick after a moment so the table goes quiet again.
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
          <h1 className="text-2xl font-semibold tracking-tight">Pricing</h1>
          <p className="text-sm text-zinc-500 mt-1">
            {loaded
              ? <>{priced} of {rows.length} items priced · LP, discount, GST. Edits save on blur.</>
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
          <option value="">All categories</option>
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
          onChange={updateRow}
          onCommit={saveRow}
        />
      )}
    </Shell>
  );
}

// ─── Table ──────────────────────────────────────────────────────────────
function PricingTable({
  rows, canWrite, saveStates, onChange, onCommit,
}: {
  rows: Row[];
  canWrite: boolean;
  saveStates: Record<string, SaveState>;
  onChange: (id: string, patch: Partial<Pick<Row, "lp" | "discPct" | "gstPct">>) => void;
  onCommit: (id: string) => void;
}) {
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 dark:bg-zinc-900/50 border-b border-zinc-200 dark:border-zinc-800">
          <tr className="text-zinc-500 text-[11px] uppercase tracking-wider">
            <th className="text-left px-5 py-2.5 font-medium">Item</th>
            <th className="text-right px-3 py-2.5 font-medium w-28">LP (₹)</th>
            <th className="text-right px-3 py-2.5 font-medium w-24">Disc %</th>
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
              onChange={onChange}
              onCommit={onCommit}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PricingRow({
  row, canWrite, saveState, onChange, onCommit,
}: {
  row: Row;
  canWrite: boolean;
  saveState: SaveState;
  onChange: (id: string, patch: Partial<Pick<Row, "lp" | "discPct" | "gstPct">>) => void;
  onCommit: (id: string) => void;
}) {
  // Live-computed values for the read-only Taxable / Final cells.
  const lpN = num(row.lp);
  const discN = pctToFrac(row.discPct);
  const gstN = pctToFrac(row.gstPct);
  const taxable = lpN * (1 - discN);
  const final = taxable * (1 + gstN);

  const commit = () => onCommit(row.id);
  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter commits without forcing the user to tab out.
    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
  };

  return (
    <tr className="border-t border-zinc-200/50 dark:border-zinc-800/50 hover:bg-zinc-50 dark:hover:bg-zinc-800/30">
      {/* Item identity — brand chip + model · size · colour, item_code beneath */}
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
          onChange={(v) => onChange(row.id, { lp: v })}
          onBlur={commit}
          onKeyDown={handleKey}
          placeholder="0"
        />
      </td>

      {/* Discount % */}
      <td className="px-3 py-2.5 text-right">
        <NumCell
          value={row.discPct}
          disabled={!canWrite}
          onChange={(v) => onChange(row.id, { discPct: v })}
          onBlur={commit}
          onKeyDown={handleKey}
          placeholder="0"
        />
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
          onChange={(v) => onChange(row.id, { gstPct: v })}
          onBlur={commit}
          onKeyDown={handleKey}
          placeholder="18"
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
  value, disabled, onChange, onBlur, onKeyDown, placeholder,
}: {
  value: string;
  disabled?: boolean;
  onChange: (v: string) => void;
  onBlur: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  placeholder?: string;
}) {
  if (disabled) {
    return <span className="tnum text-zinc-600 dark:text-zinc-400">{value || "—"}</span>;
  }
  return (
    <input
      type="number"
      inputMode="decimal"
      min="0"
      step="0.01"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      onFocus={(e) => e.target.select()}
      className="w-full bg-transparent border border-transparent hover:border-zinc-200 dark:hover:border-zinc-700 focus:border-cyan-500 focus:bg-white dark:focus:bg-zinc-800 rounded px-2 py-1 text-right tnum focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
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
