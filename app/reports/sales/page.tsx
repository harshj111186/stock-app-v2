"use client";
import { useEffect, useMemo, useState } from "react";
import {
  Calendar, Download, RotateCcw, ShoppingCart, Boxes, IndianRupee, AlertCircle,
} from "lucide-react";
import { Shell } from "@/components/shell";
import { ReportsSubnav } from "@/components/reports-subnav";
import { sb, fetchAllRows, type Txn } from "@/lib/supabase";
import { fmtN, fmtMoney, csvSafe } from "@/lib/utils";

// ─── date helpers (local-time, NOT UTC) ──────────────────────────────────
// Using .toISOString().slice(0,10) here drifts a day backwards in IST after
// 18:30 IST, so "Today" near midnight could show yesterday. Build the string
// from local getFullYear/getMonth/getDate instead.
const fmtISO = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const now = () => new Date();
const startOfWeek = (d: Date) => {
  // ISO week: Monday is day 0
  const x = new Date(d);
  const offset = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - offset);
  return x;
};
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const endOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0);
// Indian financial year: April 1 → March 31
const indianFYStart = (d: Date) =>
  new Date(d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1, 3, 1);

type Preset = "today" | "yesterday" | "thisWeek" | "thisMonth" | "lastMonth" | "thisFY" | "custom";

function rangeFor(p: Preset, customFrom: string, customTo: string): { from: string; to: string } {
  const t = now();
  switch (p) {
    case "today": return { from: fmtISO(t), to: fmtISO(t) };
    case "yesterday": {
      const y = new Date(t); y.setDate(y.getDate() - 1);
      return { from: fmtISO(y), to: fmtISO(y) };
    }
    case "thisWeek": return { from: fmtISO(startOfWeek(t)), to: fmtISO(t) };
    case "thisMonth": return { from: fmtISO(startOfMonth(t)), to: fmtISO(t) };
    case "lastMonth": {
      const lm = new Date(t.getFullYear(), t.getMonth() - 1, 1);
      return { from: fmtISO(startOfMonth(lm)), to: fmtISO(endOfMonth(lm)) };
    }
    case "thisFY": return { from: fmtISO(indianFYStart(t)), to: fmtISO(t) };
    case "custom":
    default: return { from: customFrom, to: customTo };
  }
}

// "21 May 2026" — readable en-IN. Append T00:00:00 so the YYYY-MM-DD string
// is parsed as local time, not UTC. Slice to 10 chars first so a full
// timestamp input doesn't produce "…T08:00:00T00:00:00" → Invalid Date.
const fmtDateDisplay = (iso: string) => {
  if (!iso) return "";
  return new Date(iso.slice(0, 10) + "T00:00:00").toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
};

// ─── types ───────────────────────────────────────────────────────────────
// "active"   = a real sale that hasn't been reversed
// "reversed" = an original sale that was later reversed (visible for audit,
//              excluded from totals)
// "reversal" = the reversing row itself (visible for audit, excluded too)
type SaleState = "active" | "reversed" | "reversal";

type SaleRow = Txn & {
  itemLabel: string;
  itemCode: string;
  state: SaleState;
};

const PRESETS: { v: Preset; l: string }[] = [
  { v: "today", l: "Today" },
  { v: "yesterday", l: "Yesterday" },
  { v: "thisWeek", l: "This week" },
  { v: "thisMonth", l: "This month" },
  { v: "lastMonth", l: "Last month" },
  { v: "thisFY", l: "This FY (Apr–Mar)" },
  { v: "custom", l: "Custom range" },
];

// Defensive cap so a "This FY" pull on a busy shop doesn't yank ten thousand
// rows over the wire. We surface a banner if the limit was hit so the user
// can narrow the range.
const LIMIT = 5000;

// ─── component ───────────────────────────────────────────────────────────
export default function SalesRegisterPage() {
  // Persisted filter state restores LAZILY (not in a post-mount effect) so
  // the first fetch already uses the saved range — no double fetch on mount.
  const [preset, setPreset] = useState<Preset>(() => {
    try {
      if (typeof window === "undefined") return "thisMonth";
      return (localStorage.getItem("salesReg.preset") as Preset | null) ?? "thisMonth";
    } catch { return "thisMonth"; }
  });
  const [customFrom, setCustomFrom] = useState<string>(() => {
    try {
      if (typeof window === "undefined") return fmtISO(startOfMonth(now()));
      return localStorage.getItem("salesReg.customFrom") ?? fmtISO(startOfMonth(now()));
    } catch { return fmtISO(startOfMonth(now())); }
  });
  const [customTo, setCustomTo] = useState<string>(() => {
    try {
      if (typeof window === "undefined") return fmtISO(now());
      return localStorage.getItem("salesReg.customTo") ?? fmtISO(now());
    } catch { return fmtISO(now()); }
  });
  const [showReversed, setShowReversed] = useState<boolean>(() => {
    try {
      if (typeof window === "undefined") return false;
      const sr = localStorage.getItem("salesReg.showReversed");
      return sr === null ? false : sr === "true";
    } catch { return false; }
  });

  const { from, to } = useMemo(
    () => rangeFor(preset, customFrom, customTo),
    [preset, customFrom, customTo]
  );

  const [rows, setRows] = useState<SaleRow[]>([]);
  // Active customer-return units in range (Return + direction:1, excluding
  // reversal pairs) — feeds the net "Units sold" and "Customer returns" KPIs.
  const [returnUnits, setReturnUnits] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hitLimit, setHitLimit] = useState(false);

  // Persist filter state so a refresh doesn't kick you back to "this month"
  // mid-investigation. (Restore happens in the lazy initializers above.)
  useEffect(() => { try { localStorage.setItem("salesReg.preset", preset); } catch {} }, [preset]);
  useEffect(() => { try { localStorage.setItem("salesReg.customFrom", customFrom); } catch {} }, [customFrom]);
  useEffect(() => { try { localStorage.setItem("salesReg.customTo", customTo); } catch {} }, [customTo]);
  useEffect(() => { try { localStorage.setItem("salesReg.showReversed", String(showReversed)); } catch {} }, [showReversed]);

  // ── Fetch on range change ──────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoaded(false);
      setErr(null);
      setHitLimit(false);
      try {
        const c = sb();

        // 1) All Sale + Return rows in range, paged past PostgREST's silent
        //    1,000-row clamp (a plain .limit(5000) only ever returns 1,000).
        //    Sales drive the table; Return rows with direction +1 are
        //    customer returns and feed the netted KPIs.
        const { rows: txns, error: e1, truncated } = await fetchAllRows<Txn>(
          (f, t) => c
            .from("transactions")
            .select("*")
            .in("action", ["Sale", "Return"])
            .gte("txn_date", from)
            .lte("txn_date", to)
            .order("txn_date", { ascending: false })
            .order("created_at", { ascending: false })
            .order("id")
            .range(f, t),
          { maxRows: LIMIT }
        );
        if (e1) throw new Error(e1);
        if (cancelled) return;
        setHitLimit(truncated);

        const saleTxns = txns.filter(t => t.action === "Sale");
        const returnTxns = txns.filter(t => t.action === "Return" && t.direction === 1);

        if (saleTxns.length === 0 && returnTxns.length === 0) {
          setRows([]);
          setReturnUnits(0);
          setLoaded(true);
          return;
        }

        // 2) Reversal rows that point at any of these rows. We have to query
        //    this separately because a sale on May 5 reversed in June would
        //    have its reversal row outside the date filter — but the May 5
        //    sale still needs to render as "reversed" and drop out of totals.
        //    Action isn't constrained: reverse_transaction may insert the
        //    inverse as Purchase / Sale-with-direction+1 / etc., depending on
        //    the SQL branch; we just care that something points back.
        //    Chunked 200 ids at a time: 5,000 UUIDs in one .in() builds a
        //    ~190KB URL, and the response would be clamped at 1,000 anyway.
        const lookupIds = [...saleTxns, ...returnTxns].map(t => t.id);
        const reversedIds = new Set<string>();
        for (let i = 0; i < lookupIds.length; i += 200) {
          const { data: reversals, error: e2 } = await c
            .from("transactions")
            .select("reverses_id")
            .in("reverses_id", lookupIds.slice(i, i + 200));
          if (e2) throw e2;
          if (cancelled) return;
          for (const r of (reversals || []) as Array<{ reverses_id: string | null }>) {
            if (r.reverses_id) reversedIds.add(r.reverses_id);
          }
        }

        // 3) Item labels (one paged fetch, not one per row). Deliberately
        //    includes archived items — an archived item's past sales still
        //    need a readable label.
        const itemIds = [...new Set(saleTxns.map(s => s.item_id))];
        let itemMap = new Map<string, any>();
        if (itemIds.length > 0) {
          const { rows: items, error: e3 } = await fetchAllRows<any>(
            (f, t) => c
              .from("items")
              .select("id, item_code, brand, model, size, colour")
              .in("id", itemIds)
              .order("id")
              .range(f, t)
          );
          if (e3) throw new Error(e3);
          if (cancelled) return;
          itemMap = new Map<string, any>(items.map((i: any) => [i.id, i]));
        }

        const formatted: SaleRow[] = saleTxns.map(s => {
          const item = itemMap.get(s.item_id);
          const itemLabel = item
            ? [item.brand, item.model, item.size, item.colour].filter(Boolean).join(" · ")
            : "(unknown item)";
          const itemCode = item?.item_code ?? "—";

          // Order matters: a row that IS a reversal should be classified
          // first, even if it itself was later reversed (rare). That keeps
          // reversal rows out of totals regardless.
          let state: SaleState = "active";
          if (s.reverses_id) state = "reversal";
          else if (reversedIds.has(s.id)) state = "reversed";

          return { ...s, itemLabel, itemCode, state };
        });

        // Active customer-return units — same reversal-pair rules as sales:
        // skip rows that ARE reversals and originals that were reversed.
        let retUnits = 0;
        for (const r of returnTxns) {
          if (r.reverses_id) continue;
          if (reversedIds.has(r.id)) continue;
          retUnits += r.qty;
        }

        setRows(formatted);
        setReturnUnits(retUnits);
        setLoaded(true);
      } catch (e: any) {
        if (cancelled) return;
        console.error("[sales register] load failed", e);
        setErr(e?.message || "Failed to load sales.");
        setRows([]);
        setReturnUnits(0);
        setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [from, to]);

  // What gets shown in the table.
  const visibleRows = useMemo(
    () => showReversed ? rows : rows.filter(r => r.state === "active"),
    [rows, showReversed]
  );

  // Totals always come from active rows only — toggling the "show reversed"
  // checkbox changes what you see, not what counts. So a reversed sale
  // disappears from totals whether you're hiding the rows or not.
  const activeRows = useMemo(() => rows.filter(r => r.state === "active"), [rows]);
  const totals = useMemo(() => ({
    count: activeRows.length,
    qty: activeRows.reduce((s, r) => s + r.qty, 0),
  }), [activeRows]);

  // Billed value: Σ qty × rate over ACTIVE sales that actually carry a rate.
  // Sales without a rate are excluded (counted via `count` for the caption).
  const billed = useMemo(() => {
    let value = 0, count = 0;
    for (const r of activeRows) {
      if (r.rate != null) { value += r.qty * r.rate; count += 1; }
    }
    return { value, count };
  }, [activeRows]);

  // ── CSV export ─────────────────────────────────────────────────────────
  const csvCell = (s: string) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const exportCsv = () => {
    const header = ["Date", "Item code", "Item", "Godown", "Qty", "Rate", "Value", "Status"];
    const lines = [header.join(",")];
    for (const r of visibleRows) {
      // Reversal rows export with NEGATIVE qty/value so a quick Σ over the
      // Qty column doesn't double-count reversed pairs (table display keeps
      // the positive label — Status still says "reversal").
      const signedQty = r.state === "reversal" ? -r.qty : r.qty;
      lines.push([
        r.txn_date,
        csvCell(csvSafe(r.itemCode)),
        csvCell(csvSafe(r.itemLabel)),
        r.godown,
        String(signedQty),
        r.rate == null ? "" : String(r.rate),
        r.rate == null ? "" : String(signedQty * r.rate),
        r.state,
      ].join(","));
    }
    // BOM so Excel reads UTF-8 cleanly (item colours can have non-ASCII).
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sales-${from}-to-${to}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const rangeLabel = from === to
    ? fmtDateDisplay(from)
    : `${fmtDateDisplay(from)} → ${fmtDateDisplay(to)}`;

  return (
    <Shell title="Sales register">
      <div className="print:hidden">
        <ReportsSubnav />
      </div>
      <div className="mb-6">
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Sales register</h1>
        <p className="text-sm text-zinc-500 mt-1 tabular-nums">
          {loaded
            ? <>{rangeLabel} · {fmtN(visibleRows.length)} {visibleRows.length === 1 ? "row" : "rows"} shown</>
            : "Loading…"}
        </p>
      </div>

      {/* Toolbar */}
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 mb-6 flex flex-wrap items-center gap-3 print:hidden">
        <Calendar className="w-4 h-4 text-zinc-500" />
        <select
          value={preset}
          onChange={(e) => setPreset(e.target.value as Preset)}
          className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-1.5 text-sm"
        >
          {PRESETS.map(p => <option key={p.v} value={p.v}>{p.l}</option>)}
        </select>

        <div className="flex items-center gap-2 text-xs">
          {/* Editing either bound while on a preset seeds BOTH custom dates
              from the currently-displayed range first — otherwise the other
              bound silently jumps to a stale custom value. */}
          <label className="text-zinc-500 flex items-center gap-1.5">
            From
            <input
              type="date"
              value={from}
              onChange={(e) => {
                if (preset !== "custom") setCustomTo(to);
                setCustomFrom(e.target.value);
                setPreset("custom");
              }}
              className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1 tnum"
            />
          </label>
          <label className="text-zinc-500 flex items-center gap-1.5">
            to
            <input
              type="date"
              value={to}
              onChange={(e) => {
                if (preset !== "custom") setCustomFrom(from);
                setCustomTo(e.target.value);
                setPreset("custom");
              }}
              className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1 tnum"
            />
          </label>
          {from > to && (
            <span className="text-amber-600 dark:text-amber-400">
              From is after To — no rows match.
            </span>
          )}
        </div>

        <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showReversed}
            onChange={(e) => setShowReversed(e.target.checked)}
            className="accent-cyan-500"
          />
          Show reversed entries
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
          Showing the first {fmtN(LIMIT)} rows in this range. Pick a shorter range to see everything.
        </div>
      )}

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6 print:hidden">
        <Kpi
          icon={<ShoppingCart className="w-3.5 h-3.5" />}
          label="Active sales"
          value={loaded ? fmtN(totals.count) : ""}
          note="excludes reversed pairs"
        />
        <Kpi
          icon={<Boxes className="w-3.5 h-3.5" />}
          label="Units sold"
          value={loaded ? fmtN(totals.qty - returnUnits) : ""}
          note="net of returns"
        />
        <Kpi
          icon={<RotateCcw className="w-3.5 h-3.5" />}
          label="Customer returns"
          value={loaded ? fmtN(returnUnits) : ""}
          note="in range"
        />
        <Kpi
          icon={<IndianRupee className="w-3.5 h-3.5" />}
          label="Billed value"
          value={loaded ? fmtMoney(billed.value) : ""}
          note={`from ${fmtN(billed.count)} sale${billed.count === 1 ? "" : "s"} with a rate`}
        />
      </div>

      {/* Table — desktop (print:block: print widths sit below md, so without
          it the table would never appear on paper) */}
      <div className="hidden md:block print:block bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 dark:bg-zinc-900/50 border-b border-zinc-200 dark:border-zinc-800">
            <tr className="text-zinc-500 text-[11px] uppercase tracking-wider">
              <th className="text-left px-5 py-2.5 font-medium">Date</th>
              <th className="text-left px-3 py-2.5 font-medium">Item</th>
              <th className="text-left px-3 py-2.5 font-medium">Godown</th>
              <th className="text-right px-3 py-2.5 font-medium">Qty</th>
              <th className="text-right px-3 py-2.5 font-medium">Rate</th>
              <th className="text-right px-3 py-2.5 font-medium">Value</th>
              <th className="text-left px-5 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {!loaded && Array.from({ length: 6 }).map((_, i) => (
              <tr key={i} className="border-t border-zinc-200/50 dark:border-zinc-800/50">
                {Array.from({ length: 7 }).map((__, j) => (
                  <td key={j} className="px-3 py-3"><div className="h-3 rounded shimmer" /></td>
                ))}
              </tr>
            ))}
            {loaded && visibleRows.length === 0 && !err && (
              <tr>
                <td colSpan={7} className="py-12 text-center text-sm text-zinc-500">
                  {rows.length === 0
                    ? "No sales in this range."
                    : "No active sales in this range. Tick “Show reversed entries” to see the audit rows."}
                </td>
              </tr>
            )}
            {loaded && visibleRows.map(r => (
              <tr key={r.id} className={[
                "border-t border-zinc-200/50 dark:border-zinc-800/50 hover:bg-zinc-50 dark:hover:bg-zinc-800/30",
                r.state === "reversal" ? "bg-amber-500/5" : "",
              ].join(" ")}>
                <td className="px-5 py-2.5 text-zinc-500 tnum whitespace-nowrap">
                  {fmtDateDisplay(r.txn_date)}
                </td>
                <td className="px-3 py-2.5">
                  <div className={r.state === "reversed" ? "line-through text-zinc-500" : ""}>
                    {r.itemLabel}
                  </div>
                  <div className="text-[11px] text-zinc-400 tnum">{r.itemCode}</div>
                </td>
                <td className="px-3 py-2.5 text-zinc-500">{r.godown}</td>
                <td className={[
                  "px-3 py-2.5 text-right tnum font-medium",
                  r.state === "reversed" ? "line-through text-zinc-500" : "",
                  r.state === "reversal" ? "text-amber-600 dark:text-amber-400" : "",
                ].join(" ")}>
                  {fmtN(r.qty)}
                </td>
                <td className={[
                  "px-3 py-2.5 text-right tnum text-zinc-500",
                  r.state === "reversed" ? "line-through" : "",
                ].join(" ")}>
                  {r.rate != null ? fmtMoney(r.rate) : "—"}
                </td>
                <td className={[
                  "px-3 py-2.5 text-right tnum text-zinc-500",
                  r.state === "reversed" ? "line-through" : "",
                ].join(" ")}>
                  {r.rate != null ? fmtMoney(r.qty * r.rate) : "—"}
                </td>
                <td className="px-5 py-2.5 text-xs">
                  {r.state === "active" && (
                    <span className="text-emerald-600 dark:text-emerald-400">● Active</span>
                  )}
                  {r.state === "reversed" && (
                    <span className="text-rose-500 inline-flex items-center gap-1">
                      <RotateCcw className="w-3 h-3" /> Reversed later
                    </span>
                  )}
                  {r.state === "reversal" && (
                    <span className="text-amber-600 dark:text-amber-400 inline-flex items-center gap-1">
                      <RotateCcw className="w-3 h-3" /> Reverses {(r.reverses_id || "").slice(0, 8)}…
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          {loaded && activeRows.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/40">
                <td colSpan={3} className="px-5 py-2.5 text-xs uppercase tracking-wider text-zinc-500 font-medium">
                  Totals (active sales)
                </td>
                <td className="px-3 py-2.5 text-right tnum font-semibold">
                  {fmtN(totals.qty)}
                </td>
                <td />
                <td className="px-3 py-2.5 text-right tnum font-semibold">
                  {fmtMoney(billed.value)}
                </td>
                <td className="px-5 py-2.5 text-xs text-zinc-500">
                  {fmtN(totals.count)} sale{totals.count === 1 ? "" : "s"}
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
            {rows.length === 0
              ? "No sales in this range."
              : "No active sales in this range. Tick “Show reversed entries” to see the audit rows."}
          </div>
        )}
        <ul className="divide-y divide-zinc-200/60 dark:divide-zinc-800/60">
          {loaded && visibleRows.map(r => (
            <li key={r.id} className={[
              "px-4 py-3",
              r.state === "reversal" ? "bg-amber-500/5" : "",
            ].join(" ")}>
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-[11px] text-zinc-500 tnum">{fmtDateDisplay(r.txn_date)}</span>
                <span className="text-xs">
                  {r.state === "active" && <span className="text-emerald-600 dark:text-emerald-400">● Active</span>}
                  {r.state === "reversed" && (
                    <span className="text-rose-500 inline-flex items-center gap-1">
                      <RotateCcw className="w-3 h-3" /> Reversed
                    </span>
                  )}
                  {r.state === "reversal" && (
                    <span className="text-amber-600 dark:text-amber-400 inline-flex items-center gap-1">
                      <RotateCcw className="w-3 h-3" /> Reverses…
                    </span>
                  )}
                </span>
              </div>
              <div className={["text-sm truncate", r.state === "reversed" ? "line-through text-zinc-500" : ""].join(" ")}>
                {r.itemLabel}
              </div>
              <div className="flex items-center justify-between mt-1 text-xs text-zinc-500">
                <span className="tnum">{r.itemCode} · Godown {r.godown}</span>
                <span className={[
                  "tnum font-medium",
                  r.state === "reversed" ? "line-through text-zinc-500" : "",
                  r.state === "reversal" ? "text-amber-600 dark:text-amber-400" : "text-zinc-700 dark:text-zinc-200",
                ].join(" ")}>
                  {fmtN(r.qty)}
                </span>
              </div>
            </li>
          ))}
        </ul>
        {loaded && activeRows.length > 0 && (
          <div className="border-t-2 border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/40 px-4 py-2.5 flex items-center justify-between text-xs">
            <span className="uppercase tracking-wider text-zinc-500 font-medium">Totals (active)</span>
            <span className="tnum">
              <b>{fmtN(totals.qty)}</b> units · {fmtN(totals.count)} sale{totals.count === 1 ? "" : "s"}
            </span>
          </div>
        )}
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
      <div className="text-2xl font-semibold font-display tnum">
        {value || <span className="shimmer inline-block h-7 w-16 rounded" />}
      </div>
      <div className="text-[11px] text-zinc-500 mt-1">{note}</div>
    </div>
  );
}
