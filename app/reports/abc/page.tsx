"use client";
import { useEffect, useMemo, useState } from "react";
import {
  Calendar, Download, IndianRupee, TrendingUp, Layers, Percent, AlertCircle, Search,
} from "lucide-react";
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Cell,
} from "recharts";
import { Shell } from "@/components/shell";
import { sb, type Item, type Pricing, type Txn } from "@/lib/supabase";
import { fmtN, fmtMoney } from "@/lib/utils";

// ─── date helpers (local-time, NOT UTC) ──────────────────────────────────
// Same pattern as the sales register: .toISOString() drifts a day in IST
// after 18:30, so build YYYY-MM-DD from local getters.
const fmtISO = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const now = () => new Date();
const startOfWeek = (d: Date) => {
  const x = new Date(d);
  const offset = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - offset);
  return x;
};
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const endOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0);
const indianFYStart = (d: Date) =>
  new Date(d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1, 3, 1);

type Preset = "thisMonth" | "lastMonth" | "last30" | "last90" | "thisFY" | "lastFY" | "custom";

function rangeFor(p: Preset, customFrom: string, customTo: string): { from: string; to: string } {
  const t = now();
  switch (p) {
    case "thisMonth": return { from: fmtISO(startOfMonth(t)), to: fmtISO(t) };
    case "lastMonth": {
      const lm = new Date(t.getFullYear(), t.getMonth() - 1, 1);
      return { from: fmtISO(startOfMonth(lm)), to: fmtISO(endOfMonth(lm)) };
    }
    case "last30": {
      const x = new Date(t); x.setDate(x.getDate() - 29);
      return { from: fmtISO(x), to: fmtISO(t) };
    }
    case "last90": {
      const x = new Date(t); x.setDate(x.getDate() - 89);
      return { from: fmtISO(x), to: fmtISO(t) };
    }
    case "thisFY": return { from: fmtISO(indianFYStart(t)), to: fmtISO(t) };
    case "lastFY": {
      const thisFy = indianFYStart(t);
      const lastFyStart = new Date(thisFy.getFullYear() - 1, 3, 1);
      const lastFyEnd = new Date(thisFy.getFullYear(), 2, 31);
      return { from: fmtISO(lastFyStart), to: fmtISO(lastFyEnd) };
    }
    case "custom":
    default: return { from: customFrom, to: customTo };
  }
}

const PRESETS: { v: Preset; l: string }[] = [
  { v: "thisMonth", l: "This month" },
  { v: "lastMonth", l: "Last month" },
  { v: "last30", l: "Last 30 days" },
  { v: "last90", l: "Last 90 days" },
  { v: "thisFY", l: "This FY (Apr–Mar)" },
  { v: "lastFY", l: "Last FY" },
  { v: "custom", l: "Custom range" },
];

const fmtDateDisplay = (iso: string) => {
  if (!iso) return "";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
  });
};

// Defensive cap so a This-FY pull on a busy shop doesn't yank the universe.
const LIMIT = 10000;

// Default ABC cuts. These are the classic 80/95 Pareto buckets — A drives
// the first 80% of revenue, B the next 15% (80→95), C the trailing 5%.
// Editable in the toolbar so the user can shift to 70/90 etc.
const DEFAULT_A_CUT = 80;
const DEFAULT_B_CUT = 95;

type Row = {
  itemId: string;
  itemCode: string;
  brand: string;
  category: string;
  itemLabel: string;
  units: number;
  rate: number;       // per-unit selling rate (₹) at current pricing
  revenue: number;    // units × rate
  pctShare: number;   // revenue / totalRevenue × 100
  cumPct: number;     // cumulative pct, sorted by revenue desc
  cls: "A" | "B" | "C";
  hasPricing: boolean;
};

// Two ways to read "rate": exclude GST (most common for sales-contribution
// analytics — GST is a pass-through to the government) or include it
// (matches the headline ₹ on an invoice). Toggle in the toolbar.
type RateBasis = "exGst" | "inclGst";

export default function ABCAnalysisPage() {
  const [preset, setPreset] = useState<Preset>("thisFY");
  const [customFrom, setCustomFrom] = useState(fmtISO(indianFYStart(now())));
  const [customTo, setCustomTo] = useState(fmtISO(now()));
  const [aCut, setACut] = useState<number>(DEFAULT_A_CUT);
  const [bCut, setBCut] = useState<number>(DEFAULT_B_CUT);
  const [rateBasis, setRateBasis] = useState<RateBasis>("exGst");
  const [query, setQuery] = useState("");
  const [classFilter, setClassFilter] = useState<"all" | "A" | "B" | "C">("all");
  const [brandFilter, setBrandFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");

  const { from, to } = useMemo(
    () => rangeFor(preset, customFrom, customTo),
    [preset, customFrom, customTo]
  );

  const [rows, setRows] = useState<Row[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hitLimit, setHitLimit] = useState(false);

  // Persist filter state so a refresh keeps the user where they were.
  useEffect(() => {
    try {
      const p = localStorage.getItem("abc.preset");
      if (p) setPreset(p as Preset);
      const f = localStorage.getItem("abc.customFrom");
      if (f) setCustomFrom(f);
      const t = localStorage.getItem("abc.customTo");
      if (t) setCustomTo(t);
      const a = localStorage.getItem("abc.aCut");
      if (a) setACut(Number(a) || DEFAULT_A_CUT);
      const b = localStorage.getItem("abc.bCut");
      if (b) setBCut(Number(b) || DEFAULT_B_CUT);
      const rb = localStorage.getItem("abc.rateBasis");
      if (rb === "exGst" || rb === "inclGst") setRateBasis(rb);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { try { localStorage.setItem("abc.preset", preset); } catch {} }, [preset]);
  useEffect(() => { try { localStorage.setItem("abc.customFrom", customFrom); } catch {} }, [customFrom]);
  useEffect(() => { try { localStorage.setItem("abc.customTo", customTo); } catch {} }, [customTo]);
  useEffect(() => { try { localStorage.setItem("abc.aCut", String(aCut)); } catch {} }, [aCut]);
  useEffect(() => { try { localStorage.setItem("abc.bCut", String(bCut)); } catch {} }, [bCut]);
  useEffect(() => { try { localStorage.setItem("abc.rateBasis", rateBasis); } catch {} }, [rateBasis]);

  // ── Fetch on range / basis change ─────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoaded(false);
      setErr(null);
      setHitLimit(false);
      try {
        const c = sb();

        // 1) All Sale rows in range. Direction is irrelevant — every Sale row
        //    is a customer-outbound by definition; the SQL records qty as a
        //    positive number with action='Sale'. Reversal handling kicks in
        //    via the second query below.
        const { data: sales, error: e1 } = await c
          .from("transactions")
          .select("id, item_id, qty, txn_date, reverses_id, action")
          .eq("action", "Sale")
          .gte("txn_date", from)
          .lte("txn_date", to)
          .limit(LIMIT);
        if (e1) throw e1;
        if (cancelled) return;
        if (sales && sales.length === LIMIT) setHitLimit(true);

        const saleIds = (sales || []).map((s: any) => s.id as string);

        // 2) Anything pointing back at these sales (reversals). Action /
        //    date unconstrained — a May sale reversed in July still needs
        //    its May row dropped from totals.
        let reversedIds = new Set<string>();
        if (saleIds.length > 0) {
          const { data: revs, error: e2 } = await c
            .from("transactions")
            .select("reverses_id")
            .in("reverses_id", saleIds);
          if (e2) throw e2;
          if (cancelled) return;
          reversedIds = new Set((revs || []).map((r: any) => r.reverses_id as string));
        }

        // 3) Catalogue + pricing + categories. We need every item that sold
        //    (for labels) — load the full catalogue so brand/category filters
        //    work even on items with zero sales in the range.
        const [{ data: items, error: e3 }, { data: pricing, error: e4 }, { data: cats, error: e5 }] =
          await Promise.all([
            c.from("items").select("*").eq("archived", false),
            c.from("pricing").select("*"),
            c.from("categories").select("id, name"),
          ]);
        if (e3) throw e3;
        if (e4) throw e4;
        if (e5) throw e5;
        if (cancelled) return;

        const itemMap = new Map<string, Item>(
          (items || []).map((i: any) => [i.id as string, i as Item])
        );
        const priceMap = new Map<string, Pricing>(
          (pricing || []).map((p: any) => [p.item_id as string, p as Pricing])
        );
        const catMap = new Map<string, string>(
          (cats || []).map((c: any) => [c.id as string, c.name as string])
        );

        // 4) Aggregate active sale qty per item_id.
        const unitsById = new Map<string, number>();
        for (const s of (sales || []) as Array<{ id: string; item_id: string; qty: number; reverses_id: string | null }>) {
          // Skip reversal rows (they ARE the inverse) and skip originals that
          // were later reversed.
          if (s.reverses_id) continue;
          if (reversedIds.has(s.id)) continue;
          unitsById.set(s.item_id, (unitsById.get(s.item_id) || 0) + s.qty);
        }

        // 5) Build per-item revenue rows. Items that sold but have no pricing
        //    record contribute 0 revenue but are still listed — flagged.
        const built: Omit<Row, "pctShare" | "cumPct" | "cls">[] = [];
        for (const [itemId, units] of unitsById) {
          const item = itemMap.get(itemId);
          const price = priceMap.get(itemId);
          const hasPricing = !!price && (price.lp ?? 0) > 0;
          const baseRate = hasPricing
            ? price!.lp * (1 - (price!.discount || 0))
            : 0;
          const rate = rateBasis === "inclGst"
            ? baseRate * (1 + (price?.gst_rate ?? 0))
            : baseRate;
          const revenue = units * rate;

          const itemLabel = item
            ? [item.brand, item.model, item.size, item.colour].filter(Boolean).join(" · ")
            : "(unknown item)";
          const categoryName = item?.category_id
            ? (catMap.get(item.category_id) || item.category || "")
            : (item?.category || "");

          built.push({
            itemId,
            itemCode: item?.item_code || "—",
            brand: item?.brand || "",
            category: categoryName,
            itemLabel,
            units,
            rate,
            revenue,
            hasPricing,
          });
        }

        // 6) Sort by revenue desc + compute cumulative % + classify A/B/C.
        const totalRevenue = built.reduce((s, r) => s + r.revenue, 0);
        built.sort((a, b) => b.revenue - a.revenue);

        let running = 0;
        const classified: Row[] = built.map((r) => {
          running += r.revenue;
          const pctShare = totalRevenue > 0 ? (r.revenue / totalRevenue) * 100 : 0;
          const cumPct = totalRevenue > 0 ? (running / totalRevenue) * 100 : 0;
          let cls: "A" | "B" | "C" = "C";
          if (totalRevenue > 0) {
            // A: rows whose CUMULATIVE share is within the A-cut.
            // B: between A-cut and B-cut.
            // C: beyond B-cut, and anything with zero revenue.
            if (r.revenue === 0) cls = "C";
            else if (cumPct <= aCut) cls = "A";
            else if (cumPct <= bCut) cls = "B";
            else cls = "C";
          }
          return { ...r, pctShare, cumPct, cls };
        });

        setRows(classified);
        setLoaded(true);
      } catch (e: any) {
        if (cancelled) return;
        console.error("[abc] load failed", e);
        setErr(e?.message || "Failed to load ABC analysis.");
        setRows([]);
        setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [from, to, rateBasis, aCut, bCut]);

  const brands = useMemo(() => {
    const s = new Set<string>();
    rows.forEach(r => { if (r.brand) s.add(r.brand); });
    return [...s].sort();
  }, [rows]);
  const categories = useMemo(() => {
    const s = new Set<string>();
    rows.forEach(r => { if (r.category) s.add(r.category); });
    return [...s].sort();
  }, [rows]);

  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(r => {
      if (classFilter !== "all" && r.cls !== classFilter) return false;
      if (brandFilter && r.brand !== brandFilter) return false;
      if (categoryFilter && r.category !== categoryFilter) return false;
      if (q && !(
        r.itemLabel.toLowerCase().includes(q) ||
        r.itemCode.toLowerCase().includes(q)
      )) return false;
      return true;
    });
  }, [rows, query, classFilter, brandFilter, categoryFilter]);

  const totals = useMemo(() => {
    const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);
    const totalUnits = rows.reduce((s, r) => s + r.units, 0);
    const counts = { A: 0, B: 0, C: 0 };
    rows.forEach(r => { counts[r.cls] += 1; });
    const revByClass = { A: 0, B: 0, C: 0 };
    rows.forEach(r => { revByClass[r.cls] += r.revenue; });
    return { totalRevenue, totalUnits, counts, revByClass };
  }, [rows]);

  // Pareto chart data — cap at first 40 bars so the chart stays readable on
  // a long-tail catalogue. The cumulative line still climbs to the visible
  // window's end; the table below shows everything.
  const chartData = useMemo(() => {
    const top = rows.slice(0, 40);
    return top.map((r, idx) => ({
      idx: idx + 1,
      label: r.itemLabel.length > 24 ? r.itemLabel.slice(0, 22) + "…" : r.itemLabel,
      revenue: Math.round(r.revenue),
      cumPct: Math.round(r.cumPct * 10) / 10,
      cls: r.cls,
    }));
  }, [rows]);

  // ── CSV export ──────────────────────────────────────────────────────────
  const csvCell = (s: string) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const exportCsv = () => {
    const header = [
      "Rank", "Class", "Item code", "Brand", "Category", "Item",
      "Units sold", "Rate (₹)", "Revenue (₹)", "Share %", "Cumulative %",
    ];
    const lines = [header.join(",")];
    visibleRows.forEach((r, idx) => {
      lines.push([
        String(idx + 1),
        r.cls,
        csvCell(r.itemCode),
        csvCell(r.brand),
        csvCell(r.category),
        csvCell(r.itemLabel),
        String(r.units),
        String(Math.round(r.rate)),
        String(Math.round(r.revenue)),
        r.pctShare.toFixed(2),
        r.cumPct.toFixed(2),
      ].join(","));
    });
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `abc-analysis-${from}-to-${to}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const rangeLabel = from === to
    ? fmtDateDisplay(from)
    : `${fmtDateDisplay(from)} → ${fmtDateDisplay(to)}`;

  return (
    <Shell title="ABC analysis">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">ABC analysis</h1>
        <p className="text-sm text-zinc-500 mt-1 tabular-nums">
          {loaded
            ? <>{rangeLabel} · {fmtN(rows.length)} item{rows.length === 1 ? "" : "s"} with sales · {fmtMoney(totals.totalRevenue)} revenue</>
            : "Loading…"}
        </p>
      </div>

      {/* Toolbar */}
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 mb-6 flex flex-wrap items-center gap-3">
        <Calendar className="w-4 h-4 text-zinc-500" />
        <select
          value={preset}
          onChange={(e) => setPreset(e.target.value as Preset)}
          className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-1.5 text-sm"
        >
          {PRESETS.map(p => <option key={p.v} value={p.v}>{p.l}</option>)}
        </select>

        <div className="flex items-center gap-2 text-xs">
          <label className="text-zinc-500 flex items-center gap-1.5">
            From
            <input
              type="date"
              value={from}
              onChange={(e) => { setCustomFrom(e.target.value); setPreset("custom"); }}
              className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1 tnum"
            />
          </label>
          <label className="text-zinc-500 flex items-center gap-1.5">
            to
            <input
              type="date"
              value={to}
              onChange={(e) => { setCustomTo(e.target.value); setPreset("custom"); }}
              className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1 tnum"
            />
          </label>
        </div>

        <div className="flex items-center gap-1.5 text-xs text-zinc-500 ml-1">
          <Percent className="w-3.5 h-3.5" />
          A ≤
          <input
            type="number" min={1} max={99}
            value={aCut}
            onChange={(e) => setACut(Math.min(99, Math.max(1, Number(e.target.value) || DEFAULT_A_CUT)))}
            className="w-14 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1 tnum text-right"
          />
          % · B ≤
          <input
            type="number" min={1} max={100}
            value={bCut}
            onChange={(e) => setBCut(Math.min(100, Math.max(aCut + 1, Number(e.target.value) || DEFAULT_B_CUT)))}
            className="w-14 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1 tnum text-right"
          />
          %
        </div>

        <select
          value={rateBasis}
          onChange={(e) => setRateBasis(e.target.value as RateBasis)}
          className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-1.5 text-xs"
          title="GST is a pass-through; excluding it gives true business revenue"
        >
          <option value="exGst">Revenue excl. GST</option>
          <option value="inclGst">Revenue incl. GST</option>
        </select>

        <div className="flex-1" />
        <button
          type="button"
          onClick={exportCsv}
          disabled={visibleRows.length === 0 || !loaded}
          className="bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed text-zinc-900 px-3 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5"
        >
          <Download className="w-3.5 h-3.5" />
          Export CSV
        </button>
      </div>

      {/* Banners */}
      {err && (
        <div className="mb-4 text-sm text-rose-600 dark:text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-md p-2.5 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{err}</span>
        </div>
      )}
      {hitLimit && (
        <div className="mb-4 text-xs text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-md p-2.5">
          Showing the first {fmtN(LIMIT)} sale rows. Pick a shorter range for a complete picture.
        </div>
      )}

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <Kpi
          icon={<IndianRupee className="w-3.5 h-3.5" />}
          label="Revenue"
          value={loaded ? fmtMoney(totals.totalRevenue) : ""}
          note={rateBasis === "inclGst" ? "incl. GST" : "excl. GST"}
        />
        <Kpi
          icon={<Layers className="w-3.5 h-3.5" />}
          label="Units sold"
          value={loaded ? fmtN(totals.totalUnits) : ""}
          note="active only"
        />
        <ClassKpi
          cls="A"
          count={totals.counts.A}
          revenue={totals.revByClass.A}
          totalRevenue={totals.totalRevenue}
          loaded={loaded}
        />
        <ClassKpi
          cls="B"
          count={totals.counts.B}
          revenue={totals.revByClass.B}
          totalRevenue={totals.totalRevenue}
          loaded={loaded}
        />
        <ClassKpi
          cls="C"
          count={totals.counts.C}
          revenue={totals.revByClass.C}
          totalRevenue={totals.totalRevenue}
          loaded={loaded}
        />
      </div>

      {/* Pareto chart */}
      {loaded && chartData.length > 0 && (
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 mb-6">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp className="w-4 h-4 text-cyan-500" />
            <div className="text-sm font-medium">Pareto — revenue + cumulative %</div>
            <div className="text-xs text-zinc-500">
              top {chartData.length} {chartData.length === 40 && "of " + fmtN(rows.length)}
            </div>
          </div>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 8, right: 24, left: 0, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-zinc-200 dark:stroke-zinc-800" />
                <XAxis
                  dataKey="idx"
                  tick={{ fontSize: 10, fill: "currentColor" }}
                  className="text-zinc-500"
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  yAxisId="left"
                  tick={{ fontSize: 10, fill: "currentColor" }}
                  className="text-zinc-500"
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => v >= 100000 ? `${(v / 100000).toFixed(1)}L` : v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  domain={[0, 100]}
                  tick={{ fontSize: 10, fill: "currentColor" }}
                  className="text-zinc-500"
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => `${v}%`}
                />
                <Tooltip
                  contentStyle={{
                    background: "rgb(24 24 27)",
                    border: "1px solid rgb(63 63 70)",
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: "#a1a1aa" }}
                  formatter={(value: any, name: string, ctx: any) => {
                    if (name === "revenue") return [fmtMoney(value), "Revenue"];
                    if (name === "cumPct") return [`${value}%`, "Cumulative"];
                    return [value, name];
                  }}
                  labelFormatter={(idx: number) => {
                    const d = chartData[idx - 1];
                    return d ? `#${idx} · ${d.label} · ${d.cls}` : `#${idx}`;
                  }}
                />
                <Bar yAxisId="left" dataKey="revenue" radius={[2, 2, 0, 0]}>
                  {chartData.map((d, i) => (
                    <Cell key={i} fill={d.cls === "A" ? "#10b981" : d.cls === "B" ? "#f59e0b" : "#71717a"} />
                  ))}
                </Bar>
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="cumPct"
                  stroke="#06b6d4"
                  strokeWidth={2}
                  dot={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Filters above table */}
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-3 mb-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5 text-xs">
          <Search className="w-3.5 h-3.5 text-zinc-500" />
          <input
            type="text"
            placeholder="Search item or code…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1 w-56"
          />
        </div>
        <select
          value={classFilter}
          onChange={(e) => setClassFilter(e.target.value as any)}
          className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-1.5 text-xs"
        >
          <option value="all">All classes</option>
          <option value="A">A only</option>
          <option value="B">B only</option>
          <option value="C">C only</option>
        </select>
        <select
          value={brandFilter}
          onChange={(e) => setBrandFilter(e.target.value)}
          className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-1.5 text-xs"
        >
          <option value="">All brands</option>
          {brands.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-1.5 text-xs"
        >
          <option value="">All categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <div className="text-xs text-zinc-500">
          {fmtN(visibleRows.length)} of {fmtN(rows.length)} item{rows.length === 1 ? "" : "s"} shown
        </div>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 dark:bg-zinc-900/50 border-b border-zinc-200 dark:border-zinc-800">
            <tr className="text-zinc-500 text-[11px] uppercase tracking-wider">
              <th className="text-right px-3 py-2.5 font-medium w-12">#</th>
              <th className="text-center px-3 py-2.5 font-medium w-16">Class</th>
              <th className="text-left px-3 py-2.5 font-medium">Item</th>
              <th className="text-right px-3 py-2.5 font-medium">Units</th>
              <th className="text-right px-3 py-2.5 font-medium">Rate</th>
              <th className="text-right px-3 py-2.5 font-medium">Revenue</th>
              <th className="text-right px-3 py-2.5 font-medium">Share</th>
              <th className="text-right px-5 py-2.5 font-medium">Cumulative</th>
            </tr>
          </thead>
          <tbody>
            {!loaded && (
              <tr><td colSpan={8} className="py-10 text-center text-sm text-zinc-500">Loading…</td></tr>
            )}
            {loaded && visibleRows.length === 0 && !err && (
              <tr>
                <td colSpan={8} className="py-12 text-center text-sm text-zinc-500">
                  {rows.length === 0
                    ? "No sales in this range."
                    : "No items match the current filters."}
                </td>
              </tr>
            )}
            {loaded && visibleRows.map((r, idx) => (
              <tr key={r.itemId} className="border-t border-zinc-200/50 dark:border-zinc-800/50 hover:bg-zinc-50 dark:hover:bg-zinc-800/30">
                <td className="px-3 py-2.5 text-right text-zinc-500 tnum">{idx + 1}</td>
                <td className="px-3 py-2.5 text-center">
                  <ClassBadge cls={r.cls} />
                </td>
                <td className="px-3 py-2.5">
                  <div>{r.itemLabel}</div>
                  <div className="text-[11px] text-zinc-400 tnum flex items-center gap-2">
                    <span>{r.itemCode}</span>
                    {r.brand && <span className="text-zinc-500">· {r.brand}</span>}
                    {r.category && <span className="text-zinc-500">· {r.category}</span>}
                    {!r.hasPricing && <span className="text-amber-500">· no pricing</span>}
                  </div>
                </td>
                <td className="px-3 py-2.5 text-right tnum">{fmtN(r.units)}</td>
                <td className="px-3 py-2.5 text-right tnum text-zinc-500">
                  {r.hasPricing ? fmtMoney(r.rate) : "—"}
                </td>
                <td className="px-3 py-2.5 text-right tnum font-medium">
                  {r.hasPricing ? fmtMoney(r.revenue) : "—"}
                </td>
                <td className="px-3 py-2.5 text-right tnum text-zinc-500">
                  {r.pctShare.toFixed(1)}%
                </td>
                <td className="px-5 py-2.5 text-right tnum text-zinc-500">
                  {r.cumPct.toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
          {loaded && visibleRows.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/40">
                <td colSpan={3} className="px-5 py-2.5 text-xs uppercase tracking-wider text-zinc-500 font-medium">
                  Visible totals
                </td>
                <td className="px-3 py-2.5 text-right tnum font-semibold">
                  {fmtN(visibleRows.reduce((s, r) => s + r.units, 0))}
                </td>
                <td />
                <td className="px-3 py-2.5 text-right tnum font-semibold">
                  {fmtMoney(visibleRows.reduce((s, r) => s + r.revenue, 0))}
                </td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div className="mt-4 text-[11px] text-zinc-500 leading-relaxed max-w-3xl">
        <strong>How this works.</strong> For every Sale in the range (excluding reversed pairs), we multiply
        units × current effective rate (LP × (1 − discount){rateBasis === "inclGst" && " × (1 + GST)"}).
        Items are sorted by revenue descending, the cumulative share is computed, and each item is bucketed —
        first items up to {aCut}% cumulative revenue = <span className="text-emerald-600 dark:text-emerald-400 font-semibold">A</span>,
        next up to {bCut}% = <span className="text-amber-600 dark:text-amber-400 font-semibold">B</span>,
        the rest = <span className="text-zinc-600 dark:text-zinc-400 font-semibold">C</span>.
        Pricing changes after the sale aren't tracked here — the rate column is what the item sells for today.
      </div>
    </Shell>
  );
}

function Kpi({
  icon, label, value, note,
}: { icon: React.ReactNode; label: string; value: string; note: string }) {
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4">
      <div className="flex items-center gap-2 text-xs text-zinc-500 mb-2">{icon} {label}</div>
      <div className="text-2xl font-semibold tnum">
        {value || <span className="shimmer inline-block h-7 w-16 rounded" />}
      </div>
      <div className="text-[11px] text-zinc-500 mt-1">{note}</div>
    </div>
  );
}

function ClassKpi({
  cls, count, revenue, totalRevenue, loaded,
}: { cls: "A" | "B" | "C"; count: number; revenue: number; totalRevenue: number; loaded: boolean }) {
  const tone =
    cls === "A" ? "text-emerald-600 dark:text-emerald-400" :
    cls === "B" ? "text-amber-600 dark:text-amber-400" :
    "text-zinc-600 dark:text-zinc-400";
  const pct = totalRevenue > 0 ? (revenue / totalRevenue) * 100 : 0;
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4">
      <div className="flex items-center gap-2 text-xs text-zinc-500 mb-2">
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
          cls === "A" ? "bg-emerald-500/15" : cls === "B" ? "bg-amber-500/15" : "bg-zinc-500/15"
        } ${tone}`}>{cls}</span>
        Class {cls}
      </div>
      <div className={`text-2xl font-semibold tnum ${tone}`}>
        {loaded ? fmtN(count) : <span className="shimmer inline-block h-7 w-16 rounded" />}
      </div>
      <div className="text-[11px] text-zinc-500 mt-1 tnum">
        {loaded ? `${pct.toFixed(1)}% of revenue` : " "}
      </div>
    </div>
  );
}

function ClassBadge({ cls }: { cls: "A" | "B" | "C" }) {
  const tone =
    cls === "A" ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" :
    cls === "B" ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" :
    "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400";
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${tone}`}>
      {cls}
    </span>
  );
}
