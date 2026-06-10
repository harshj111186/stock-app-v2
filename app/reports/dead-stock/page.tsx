"use client";
import { useEffect, useMemo, useState } from "react";
import {
  AlertOctagon, Download, IndianRupee, Boxes, PackageX, Search,
  AlertCircle, Clock,
} from "lucide-react";
import { Shell } from "@/components/shell";
import { ReportsSubnav } from "@/components/reports-subnav";
import { sb, fetchAllRows, type Item, type Stock, type Pricing, type Txn } from "@/lib/supabase";
import { fmtN, fmtMoney, netRate, csvSafe } from "@/lib/utils";

// ─── date helpers (local-time, NOT UTC) ──────────────────────────────────
const fmtISO = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const fmtDateDisplay = (iso: string | null) => {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
  });
};

// Day differences are computed off the YYYY-MM-DD date strings — convert
// both to local-midnight Date objects, subtract, divide. Using new Date(iso)
// alone treats the string as UTC and can be off-by-one in IST.
const daysSince = (iso: string | null, todayIso: string): number | null => {
  if (!iso) return null;
  const a = new Date(iso + "T00:00:00").getTime();
  const b = new Date(todayIso + "T00:00:00").getTime();
  return Math.max(0, Math.round((b - a) / 86_400_000));
};

// What counts as "movement" for the dead-stock cut. Customer sale is the
// default — that's what "shelf clearing" decisions hang on. Optionally
// the user can widen it to "any outbound move" (Sale + Transfer +
// negative-direction Adjustment + supplier-Return out) for catalogue
// cleanup contexts where any activity means the SKU is alive.
type MovementBasis = "salesOnly" | "anyOutbound";

const THRESHOLDS = [
  { v: 30,  l: "30 days" },
  { v: 60,  l: "60 days" },
  { v: 90,  l: "90 days" },
  { v: 180, l: "180 days" },
  { v: 365, l: "365 days" },
];

const LIMIT = 20000;

type Row = {
  itemId: string;
  itemCode: string;
  brand: string;
  category: string;
  itemLabel: string;
  caseSize: number;
  unitsA: number;
  unitsB: number;
  totalUnits: number;
  lastSaleDate: string | null;
  lastMovementDate: string | null;   // any outbound, used when basis === "anyOutbound"
  daysSinceMovement: number | null;  // null = no movement ever recorded
  rate: number;
  blockedCapital: number;            // units × rate (net of GST)
  hasPricing: boolean;
  neverMoved: boolean;
};

// What the fetch stores: everything except the basis-dependent fields, which
// derive in a memo so switching basis doesn't refetch (both date maps are
// always built anyway).
type BaseRow = Omit<Row, "daysSinceMovement" | "neverMoved">;

export default function DeadStockPage() {
  // Persisted UI state restores LAZILY (not in a post-mount effect) so the
  // first render already has the saved values — no double work on mount.
  const [thresholdDays, setThresholdDays] = useState<number>(() => {
    try {
      if (typeof window === "undefined") return 90;
      return Number(localStorage.getItem("deadStock.threshold")) || 90;
    } catch { return 90; }
  });
  const [basis, setBasis] = useState<MovementBasis>(() => {
    try {
      if (typeof window === "undefined") return "salesOnly";
      const b = localStorage.getItem("deadStock.basis");
      return b === "salesOnly" || b === "anyOutbound" ? b : "salesOnly";
    } catch { return "salesOnly"; }
  });
  const [includeNeverSold, setIncludeNeverSold] = useState<boolean>(() => {
    try {
      if (typeof window === "undefined") return true;
      const n = localStorage.getItem("deadStock.includeNeverSold");
      return n === null ? true : n === "true";
    } catch { return true; }
  });
  const [query, setQuery] = useState("");
  const [brandFilter, setBrandFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [sortBy, setSortBy] = useState<"capital" | "days" | "units">(() => {
    try {
      if (typeof window === "undefined") return "capital";
      const s = localStorage.getItem("deadStock.sortBy");
      return s === "capital" || s === "days" || s === "units" ? s : "capital";
    } catch { return "capital"; }
  });

  const [baseRows, setBaseRows] = useState<BaseRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hitLimit, setHitLimit] = useState(false);
  const todayIso = useMemo(() => fmtISO(new Date()), []);

  // Persist UI state. (Restore happens in the lazy initializers above.)
  useEffect(() => { try { localStorage.setItem("deadStock.threshold", String(thresholdDays)); } catch {} }, [thresholdDays]);
  useEffect(() => { try { localStorage.setItem("deadStock.basis", basis); } catch {} }, [basis]);
  useEffect(() => { try { localStorage.setItem("deadStock.includeNeverSold", String(includeNeverSold)); } catch {} }, [includeNeverSold]);
  useEffect(() => { try { localStorage.setItem("deadStock.sortBy", sortBy); } catch {} }, [sortBy]);

  // ── Fetch ONCE on mount — basis and threshold never change the DB pull.
  //    Both date maps are always built; the basis pick happens in the
  //    `rows` memo below, the threshold cut in `deadRows`. ────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoaded(false);
      setErr(null);
      setHitLimit(false);
      try {
        const c = sb();

        // 1) Full catalogue + current stock + pricing + category names, all
        //    paged past PostgREST's silent 1,000-row clamp. We need every
        //    non-archived item, even ones with zero stock, so the "include
        //    never-sold items" toggle behaves sensibly (it filters by
        //    neverMoved AND totalUnits > 0). Archived items stay excluded —
        //    dead stock is about the active catalogue.
        const [itemsRes, stockRes, pricingRes, catsRes] = await Promise.all([
          fetchAllRows<Item>((f, t) =>
            c.from("items").select("*").eq("archived", false).order("id").range(f, t)),
          fetchAllRows<Stock>((f, t) =>
            c.from("godown_stock").select("*").order("item_id").order("godown").range(f, t)),
          fetchAllRows<Pricing>((f, t) =>
            c.from("pricing").select("*").order("item_id").range(f, t)),
          c.from("categories").select("id, name"),
        ]);
        if (itemsRes.error) throw new Error(itemsRes.error);
        if (stockRes.error) throw new Error(stockRes.error);
        if (pricingRes.error) throw new Error(pricingRes.error);
        if (catsRes.error) throw catsRes.error;
        if (cancelled) return;
        const items = itemsRes.rows;
        const stock = stockRes.rows;
        const pricing = pricingRes.rows;
        const cats = catsRes.data;

        // 2) Outbound transactions — sales by default; also Transfer +
        //    negative-direction Adjustment + Return when basis is broader.
        //    We pull every relevant row (date unconstrained) — finding "the
        //    latest" per item needs the global max, not just recent rows.
        //    Paged: a plain .limit(20000) is clamped to 1,000 server-side,
        //    which falsely branded anything older than the newest-1,000
        //    window as "never sold".
        //    Reversal handling: ignore rows that have reverses_id set (those
        //    are inverses, not real movement) and ignore originals whose id
        //    appears in another row's reverses_id (the move was undone).
        const { rows: txns, error: e5, truncated } = await fetchAllRows<{
          id: string; item_id: string; action: Txn["action"];
          direction: 1 | -1 | null; txn_date: string; reverses_id: string | null;
        }>(
          (f, t) => c
            .from("transactions")
            .select("id, item_id, action, direction, txn_date, reverses_id")
            .in("action", ["Sale", "Transfer", "Adjustment", "Return"])
            .order("txn_date", { ascending: false })
            .order("id")
            .range(f, t),
          { maxRows: LIMIT }
        );
        if (e5) throw new Error(e5);
        if (cancelled) return;
        setHitLimit(truncated);

        const allTxns = txns;

        // Build the reversed-original set: any id that appears as the
        // reverses_id of some other row was itself undone.
        const reversedIds = new Set<string>();
        for (const t of allTxns) {
          if (t.reverses_id) reversedIds.add(t.reverses_id);
        }

        // 3) Walk transactions once, finding the latest qualifying date per
        //    item, separately for "sales only" and "any outbound" buckets.
        const lastSaleByItem = new Map<string, string>();
        const lastOutboundByItem = new Map<string, string>();
        for (const t of allTxns) {
          // Skip reversal rows themselves and originals that got reversed.
          if (t.reverses_id) continue;
          if (reversedIds.has(t.id)) continue;

          // Is this an outbound move?
          // - Sale: always outbound (direction column unused for sales).
          // - Transfer: stock leaves the source, but it doesn't leave the
          //   business — count it as "movement" for the broader basis only.
          // - Adjustment: only when direction = -1 (Damage/Lost/Count down).
          // - Return: only when direction = -1 (supplier-return out).
          let isSale = false;
          let isOutbound = false;
          if (t.action === "Sale") { isSale = true; isOutbound = true; }
          else if (t.action === "Transfer") { isOutbound = true; }
          else if (t.action === "Adjustment" && t.direction === -1) { isOutbound = true; }
          else if (t.action === "Return" && t.direction === -1) { isOutbound = true; }

          if (isSale) {
            const prior = lastSaleByItem.get(t.item_id);
            if (!prior || t.txn_date > prior) lastSaleByItem.set(t.item_id, t.txn_date);
          }
          if (isOutbound) {
            const prior = lastOutboundByItem.get(t.item_id);
            if (!prior || t.txn_date > prior) lastOutboundByItem.set(t.item_id, t.txn_date);
          }
        }

        // 4) Stock per item per godown — cases × case_size + loose per item.
        const itemMap = new Map<string, Item>(items.map(i => [i.id, i]));
        const stockRows: Record<string, { A: { cases: number; loose: number }; B: { cases: number; loose: number } }> = {};
        for (const s of stock) {
          stockRows[s.item_id] = stockRows[s.item_id] || { A: { cases: 0, loose: 0 }, B: { cases: 0, loose: 0 } };
          stockRows[s.item_id][s.godown] = { cases: s.cases || 0, loose: s.loose || 0 };
        }
        const totalUnitsAt = (itemId: string, g: "A" | "B"): number => {
          const item = itemMap.get(itemId);
          const cs = item?.case_size || 0;
          const r = stockRows[itemId]?.[g] || { cases: 0, loose: 0 };
          return cs > 0 ? r.cases * cs + r.loose : r.loose;
        };

        const priceMap = new Map<string, Pricing>(pricing.map(p => [p.item_id, p]));
        const catMap = new Map<string, string>(
          (cats || []).map((x: any) => [x.id as string, x.name as string])
        );

        // 5) Build a BaseRow per item — both last-dates kept; the
        //    basis-dependent fields derive in the memo below.
        const built: BaseRow[] = [];
        for (const i of items) {
          const unitsA = totalUnitsAt(i.id, "A");
          const unitsB = totalUnitsAt(i.id, "B");
          const totalUnits = unitsA + unitsB;
          const lastSaleDate = lastSaleByItem.get(i.id) || null;
          const lastMovementDate = lastOutboundByItem.get(i.id) || null;

          const price = priceMap.get(i.id);
          const hasPricing = !!price && (price.lp ?? 0) > 0;
          const rate = hasPricing ? netRate(price!.lp, price!.discount) : 0;
          const blockedCapital = totalUnits * rate;

          const category = i.category_id
            ? (catMap.get(i.category_id) || i.category || "")
            : (i.category || "");

          built.push({
            itemId: i.id,
            itemCode: i.item_code,
            brand: i.brand || "",
            category,
            itemLabel: [i.brand, i.model, i.size, i.colour].filter(Boolean).join(" · "),
            caseSize: i.case_size || 0,
            unitsA,
            unitsB,
            totalUnits,
            lastSaleDate,
            lastMovementDate,
            rate,
            blockedCapital,
            hasPricing,
          });
        }

        setBaseRows(built);
        setLoaded(true);
      } catch (e: any) {
        if (cancelled) return;
        console.error("[dead-stock] load failed", e);
        setErr(e?.message || "Failed to load dead-stock report.");
        setBaseRows([]);
        setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Pick the movement reference by basis — derived, so flipping the basis
  // select never refetches.
  const rows = useMemo<Row[]>(() => baseRows.map(r => {
    const reference = basis === "salesOnly" ? r.lastSaleDate : r.lastMovementDate;
    return {
      ...r,
      daysSinceMovement: daysSince(reference, todayIso),
      neverMoved: reference === null,
    };
  }), [baseRows, basis, todayIso]);

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

  // Dead-stock cut: positive stock on hand AND (never sold OR last sale ≥ N
  // days ago). The "never sold" branch is gated by the toggle so the user
  // can hide brand-new SKUs that just haven't had time to sell.
  const deadRows = useMemo(() => {
    return rows.filter(r => {
      if (r.totalUnits <= 0) return false;
      if (r.neverMoved) return includeNeverSold;
      return (r.daysSinceMovement ?? 0) >= thresholdDays;
    });
  }, [rows, thresholdDays, includeNeverSold]);

  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = deadRows.filter(r => {
      if (brandFilter && r.brand !== brandFilter) return false;
      if (categoryFilter && r.category !== categoryFilter) return false;
      if (q && !(
        r.itemLabel.toLowerCase().includes(q) ||
        r.itemCode.toLowerCase().includes(q)
      )) return false;
      return true;
    });
    return [...filtered].sort((a, b) => {
      if (sortBy === "capital") return b.blockedCapital - a.blockedCapital;
      if (sortBy === "units") return b.totalUnits - a.totalUnits;
      // "days" — never-moved rows (null) sort to the top as the most stale.
      const da = a.daysSinceMovement ?? Number.POSITIVE_INFINITY;
      const db = b.daysSinceMovement ?? Number.POSITIVE_INFINITY;
      return db - da;
    });
  }, [deadRows, query, brandFilter, categoryFilter, sortBy]);

  const totals = useMemo(() => ({
    skus: deadRows.length,
    units: deadRows.reduce((s, r) => s + r.totalUnits, 0),
    capital: deadRows.reduce((s, r) => s + r.blockedCapital, 0),
    neverMoved: deadRows.filter(r => r.neverMoved).length,
  }), [deadRows]);

  // ── CSV export ──────────────────────────────────────────────────────────
  const csvCell = (s: string) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const exportCsv = () => {
    const header = [
      "Item code", "Brand", "Category", "Item",
      "Units A", "Units B", "Total units",
      "Last movement", "Days since",
      "Rate (₹)", "Blocked capital (₹)",
    ];
    const lines = [header.join(",")];
    visibleRows.forEach(r => {
      lines.push([
        csvCell(csvSafe(r.itemCode)),
        csvCell(csvSafe(r.brand)),
        csvCell(csvSafe(r.category)),
        csvCell(csvSafe(r.itemLabel)),
        String(r.unitsA),
        String(r.unitsB),
        String(r.totalUnits),
        r.neverMoved ? "never" : (basis === "salesOnly" ? (r.lastSaleDate || "") : (r.lastMovementDate || "")),
        r.daysSinceMovement === null ? "—" : String(r.daysSinceMovement),
        String(Math.round(r.rate)),
        String(Math.round(r.blockedCapital)),
      ].join(","));
    });
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dead-stock-${thresholdDays}d-${todayIso}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <Shell title="Dead stock">
      <div className="print:hidden">
        <ReportsSubnav />
      </div>
      <div className="mb-6">
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Dead stock</h1>
        <p className="text-sm text-zinc-500 mt-1 tabular-nums">
          {loaded
            ? <>Items in stock with no {basis === "salesOnly" ? "sales" : "outward movement"} in the last {thresholdDays} days · {fmtN(totals.skus)} SKU{totals.skus === 1 ? "" : "s"} · {fmtMoney(totals.capital)} blocked</>
            : "Loading…"}
        </p>
      </div>

      {/* Toolbar */}
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 mb-6 flex flex-wrap items-center gap-3 print:hidden">
        <Clock className="w-4 h-4 text-zinc-500" />
        <label className="text-xs text-zinc-500 flex items-center gap-2">
          No movement for ≥
          <select
            value={thresholdDays}
            onChange={(e) => setThresholdDays(Number(e.target.value))}
            className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1 tnum"
          >
            {THRESHOLDS.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}
          </select>
        </label>

        <select
          value={basis}
          onChange={(e) => setBasis(e.target.value as MovementBasis)}
          className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-1.5 text-xs"
          title="Sales = customer demand. Any outbound = sales + transfers + reductions."
        >
          <option value="salesOnly">Movement = sales only</option>
          <option value="anyOutbound">Movement = any outbound</option>
        </select>

        <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={includeNeverSold}
            onChange={(e) => setIncludeNeverSold(e.target.checked)}
            className="accent-cyan-500"
          />
          Include never-sold items
        </label>

        <label className="flex items-center gap-2 text-xs text-zinc-500">
          Sort by
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as any)}
            className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1"
          >
            <option value="capital">Blocked capital</option>
            <option value="days">Days since movement</option>
            <option value="units">Units in stock</option>
          </select>
        </label>

        <div className="flex-1" />
        <button
          type="button"
          onClick={exportCsv}
          disabled={visibleRows.length === 0 || !loaded}
          className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed"
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
          Movement scan stopped at {fmtN(LIMIT)} rows — very old items may show as “never sold” even though they sold before the scanned window.
        </div>
      )}

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6 print:hidden">
        <Kpi
          icon={<PackageX className="w-3.5 h-3.5" />}
          label="Dead SKUs"
          value={loaded ? fmtN(totals.skus) : ""}
          note={`out of ${fmtN(rows.length)} catalogue`}
          tone="bad"
        />
        <Kpi
          icon={<Boxes className="w-3.5 h-3.5" />}
          label="Dead units"
          value={loaded ? fmtN(totals.units) : ""}
          note="across both godowns"
        />
        <Kpi
          icon={<IndianRupee className="w-3.5 h-3.5" />}
          label="Blocked capital"
          value={loaded ? fmtMoney(totals.capital) : ""}
          note="net of GST, at current rate"
          tone="warn"
        />
        <Kpi
          icon={<AlertOctagon className="w-3.5 h-3.5" />}
          label="Never moved"
          value={loaded ? fmtN(totals.neverMoved) : ""}
          note={includeNeverSold ? "incl. brand-new SKUs" : "hidden — toggle to include"}
        />
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-3 mb-3 flex flex-wrap items-center gap-3 print:hidden">
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
          {fmtN(visibleRows.length)} of {fmtN(deadRows.length)} dead SKU{deadRows.length === 1 ? "" : "s"} shown
        </div>
      </div>

      {/* Table — desktop (print:block: print widths sit below md, so without
          it the table would never appear on paper) */}
      <div className="hidden md:block print:block bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 dark:bg-zinc-900/50 border-b border-zinc-200 dark:border-zinc-800">
            <tr className="text-zinc-500 text-[11px] uppercase tracking-wider">
              <th className="text-left px-5 py-2.5 font-medium">Item</th>
              <th className="text-right px-3 py-2.5 font-medium">Units A</th>
              <th className="text-right px-3 py-2.5 font-medium">Units B</th>
              <th className="text-right px-3 py-2.5 font-medium">Total</th>
              <th className="text-left px-3 py-2.5 font-medium">Last {basis === "salesOnly" ? "sale" : "movement"}</th>
              <th className="text-right px-3 py-2.5 font-medium">Days idle</th>
              <th className="text-right px-3 py-2.5 font-medium">Rate</th>
              <th className="text-right px-5 py-2.5 font-medium">Blocked capital</th>
            </tr>
          </thead>
          <tbody>
            {!loaded && Array.from({ length: 6 }).map((_, i) => (
              <tr key={i} className="border-t border-zinc-200/50 dark:border-zinc-800/50">
                {Array.from({ length: 8 }).map((__, j) => (
                  <td key={j} className="px-3 py-3"><div className="h-3 rounded shimmer" /></td>
                ))}
              </tr>
            ))}
            {loaded && visibleRows.length === 0 && !err && (
              <tr>
                <td colSpan={8} className="py-12 text-center text-sm text-zinc-500">
                  {deadRows.length === 0
                    ? "No dead stock at this threshold. Everything is moving."
                    : "No items match the current filters."}
                </td>
              </tr>
            )}
            {loaded && visibleRows.map(r => (
              <tr key={r.itemId} className="border-t border-zinc-200/50 dark:border-zinc-800/50 hover:bg-zinc-50 dark:hover:bg-zinc-800/30">
                <td className="px-5 py-2.5">
                  <div>{r.itemLabel}</div>
                  <div className="text-[11px] text-zinc-400 tnum flex items-center gap-2">
                    <span>{r.itemCode}</span>
                    {r.brand && <span className="text-zinc-500">· {r.brand}</span>}
                    {r.category && <span className="text-zinc-500">· {r.category}</span>}
                    {!r.hasPricing && <span className="text-amber-500">· no pricing</span>}
                    {r.neverMoved && <span className="text-rose-500">· never sold</span>}
                  </div>
                </td>
                <td className="px-3 py-2.5 text-right tnum text-zinc-500">{fmtN(r.unitsA)}</td>
                <td className="px-3 py-2.5 text-right tnum text-zinc-500">{fmtN(r.unitsB)}</td>
                <td className="px-3 py-2.5 text-right tnum font-medium">{fmtN(r.totalUnits)}</td>
                <td className="px-3 py-2.5 text-zinc-500 whitespace-nowrap">
                  {r.neverMoved
                    ? <span className="text-rose-500">never</span>
                    : fmtDateDisplay(basis === "salesOnly" ? r.lastSaleDate : r.lastMovementDate)}
                </td>
                <td className={[
                  "px-3 py-2.5 text-right tnum",
                  // Tiers scale with the chosen threshold: rose at 2× the
                  // cut, amber at the cut — not hardcoded 90/180.
                  r.neverMoved || (r.daysSinceMovement ?? 0) >= thresholdDays * 2 ? "text-rose-500" :
                  (r.daysSinceMovement ?? 0) >= thresholdDays ? "text-amber-500" :
                  "text-zinc-500",
                ].join(" ")}>
                  {r.neverMoved ? "—" : fmtN(r.daysSinceMovement ?? 0)}
                </td>
                <td className="px-3 py-2.5 text-right tnum text-zinc-500">
                  {r.hasPricing ? fmtMoney(r.rate) : "—"}
                </td>
                <td className="px-5 py-2.5 text-right tnum font-medium">
                  {r.hasPricing ? fmtMoney(r.blockedCapital) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
          {loaded && visibleRows.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/40">
                <td className="px-5 py-2.5 text-xs uppercase tracking-wider text-zinc-500 font-medium">
                  Visible totals
                </td>
                <td className="px-3 py-2.5 text-right tnum font-semibold">
                  {fmtN(visibleRows.reduce((s, r) => s + r.unitsA, 0))}
                </td>
                <td className="px-3 py-2.5 text-right tnum font-semibold">
                  {fmtN(visibleRows.reduce((s, r) => s + r.unitsB, 0))}
                </td>
                <td className="px-3 py-2.5 text-right tnum font-semibold">
                  {fmtN(visibleRows.reduce((s, r) => s + r.totalUnits, 0))}
                </td>
                <td colSpan={3} />
                <td className="px-5 py-2.5 text-right tnum font-semibold">
                  {fmtMoney(visibleRows.reduce((s, r) => s + r.blockedCapital, 0))}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden print:hidden bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden shadow-sm">
        {!loaded && (
          <div className="p-4 space-y-3">
            {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-3 rounded shimmer" />)}
          </div>
        )}
        {loaded && visibleRows.length === 0 && !err && (
          <div className="py-12 text-center text-sm text-zinc-500 px-4">
            {deadRows.length === 0
              ? "No dead stock at this threshold. Everything is moving."
              : "No items match the current filters."}
          </div>
        )}
        <ul className="divide-y divide-zinc-200/60 dark:divide-zinc-800/60">
          {loaded && visibleRows.map(r => {
            const daysToneCls =
              r.neverMoved || (r.daysSinceMovement ?? 0) >= thresholdDays * 2 ? "text-rose-500" :
              (r.daysSinceMovement ?? 0) >= thresholdDays ? "text-amber-500" :
              "text-zinc-500";
            return (
              <li key={r.itemId} className="px-4 py-3">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <div className="text-sm font-medium truncate">{r.itemLabel}</div>
                  <span className={`text-[11px] tnum flex-shrink-0 ${daysToneCls}`}>
                    {r.neverMoved ? "never sold" : `${fmtN(r.daysSinceMovement ?? 0)}d idle`}
                  </span>
                </div>
                <div className="text-[11px] text-zinc-400 tnum flex flex-wrap items-center gap-x-2 gap-y-0.5 mb-2">
                  <span>{r.itemCode}</span>
                  {r.brand && <span className="text-zinc-500">· {r.brand}</span>}
                  {r.category && <span className="text-zinc-500">· {r.category}</span>}
                  {!r.hasPricing && <span className="text-amber-500">· no pricing</span>}
                </div>
                <div className="flex items-center justify-between text-xs">
                  <div className="flex gap-3 tabular-nums">
                    <span className="text-zinc-500">A <b className="text-zinc-700 dark:text-zinc-200">{fmtN(r.unitsA)}</b></span>
                    <span className="text-zinc-500">B <b className="text-zinc-700 dark:text-zinc-200">{fmtN(r.unitsB)}</b></span>
                    <span className="text-zinc-500">= <b className="text-zinc-700 dark:text-zinc-200">{fmtN(r.totalUnits)}</b></span>
                  </div>
                  <span className="tnum font-semibold">
                    {r.hasPricing ? fmtMoney(r.blockedCapital) : "—"}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
        {loaded && visibleRows.length > 0 && (
          <div className="border-t-2 border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/40 px-4 py-2.5 flex items-center justify-between text-xs">
            <span className="uppercase tracking-wider text-zinc-500 font-medium">Visible totals</span>
            <span className="tnum font-semibold">
              {fmtN(visibleRows.reduce((s, r) => s + r.totalUnits, 0))} units · {fmtMoney(visibleRows.reduce((s, r) => s + r.blockedCapital, 0))}
            </span>
          </div>
        )}
      </div>

      <div className="mt-4 text-[11px] text-zinc-500 leading-relaxed max-w-3xl">
        <strong>How this works.</strong> An item is "dead" if it has positive stock today AND its last
        {basis === "salesOnly" ? " customer sale " : " outward movement "}
        was at least {thresholdDays} days ago{includeNeverSold && " — or it never moved at all"}.
        Blocked capital = units × current sell rate (LP × (1 − discount), net of GST).
        Reversed sales are ignored when finding the latest movement date. Use this to spot SKUs to
        push, discount, or stop reordering.
      </div>
    </Shell>
  );
}

function Kpi({
  icon, label, value, note, tone,
}: { icon: React.ReactNode; label: string; value: string; note: string; tone?: "warn" | "bad" }) {
  const valueColour = tone === "bad" ? "text-rose-500" : tone === "warn" ? "text-amber-500" : "";
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4">
      <div className="flex items-center gap-2 text-xs text-zinc-500 mb-2">{icon} {label}</div>
      <div className={`text-2xl font-semibold font-display tnum ${valueColour}`}>
        {value || <span className="shimmer inline-block h-7 w-16 rounded" />}
      </div>
      <div className="text-[11px] text-zinc-500 mt-1">{note}</div>
    </div>
  );
}
