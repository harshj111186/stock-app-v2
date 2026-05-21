"use client";
import { useEffect, useMemo, useState } from "react";
import {
  Calendar, Download, RotateCcw, ShoppingCart, Boxes, ListChecks, AlertCircle,
} from "lucide-react";
import { Shell } from "@/components/shell";
import { ReportsSubnav } from "@/components/reports-subnav";
import { sb, type Txn } from "@/lib/supabase";
import { fmtN } from "@/lib/utils";

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
// is parsed as local time, not UTC.
const fmtDateDisplay = (iso: string) => {
  if (!iso) return "";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-IN", {
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
  const [preset, setPreset] = useState<Preset>("thisMonth");
  const [customFrom, setCustomFrom] = useState(fmtISO(startOfMonth(now())));
  const [customTo, setCustomTo] = useState(fmtISO(now()));
  const [showReversed, setShowReversed] = useState(false);

  const { from, to } = useMemo(
    () => rangeFor(preset, customFrom, customTo),
    [preset, customFrom, customTo]
  );

  const [rows, setRows] = useState<SaleRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hitLimit, setHitLimit] = useState(false);

  // Persist filter state so a refresh doesn't kick you back to "this month"
  // mid-investigation.
  useEffect(() => {
    try {
      const p = localStorage.getItem("salesReg.preset");
      if (p) setPreset(p as Preset);
      const f = localStorage.getItem("salesReg.customFrom");
      if (f) setCustomFrom(f);
      const t = localStorage.getItem("salesReg.customTo");
      if (t) setCustomTo(t);
      const sr = localStorage.getItem("salesReg.showReversed");
      if (sr !== null) setShowReversed(sr === "true");
    } catch { /* ignore */ }
  }, []);
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

        // 1) All Sale rows in range.
        const { data: sales, error: e1 } = await c
          .from("transactions")
          .select("*")
          .eq("action", "Sale")
          .gte("txn_date", from)
          .lte("txn_date", to)
          .order("txn_date", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(LIMIT);
        if (e1) throw e1;
        if (cancelled) return;

        if (!sales || sales.length === 0) {
          setRows([]);
          setLoaded(true);
          return;
        }
        if (sales.length === LIMIT) setHitLimit(true);

        const saleIds = (sales as Txn[]).map(s => s.id);

        // 2) Reversal rows that point at any of these sales. We have to query
        //    this separately because a sale on May 5 reversed in June would
        //    have its reversal row outside the date filter — but the May 5
        //    sale still needs to render as "reversed" and drop out of totals.
        //    Action isn't constrained: reverse_transaction may insert the
        //    inverse as Purchase / Sale-with-direction+1 / etc., depending on
        //    the SQL branch; we just care that something points back.
        const { data: reversals, error: e2 } = await c
          .from("transactions")
          .select("id, reverses_id")
          .in("reverses_id", saleIds);
        if (e2) throw e2;
        if (cancelled) return;
        const reversedIds = new Set(
          (reversals || []).map((r: any) => r.reverses_id as string)
        );

        // 3) Item labels (one fetch, not one per row).
        const itemIds = [...new Set((sales as Txn[]).map(s => s.item_id))];
        const { data: items, error: e3 } = await c
          .from("items")
          .select("id, item_code, brand, model, size, colour")
          .in("id", itemIds);
        if (e3) throw e3;
        if (cancelled) return;
        const itemMap = new Map<string, any>(
          (items || []).map((i: any) => [i.id, i])
        );

        const formatted: SaleRow[] = (sales as Txn[]).map(s => {
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

        setRows(formatted);
        setLoaded(true);
      } catch (e: any) {
        if (cancelled) return;
        console.error("[sales register] load failed", e);
        setErr(e?.message || "Failed to load sales.");
        setRows([]);
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

  // ── CSV export ─────────────────────────────────────────────────────────
  const csvCell = (s: string) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const exportCsv = () => {
    const header = ["Date", "Item code", "Item", "Godown", "Qty", "Status"];
    const lines = [header.join(",")];
    for (const r of visibleRows) {
      lines.push([
        r.txn_date,
        r.itemCode,
        csvCell(r.itemLabel),
        r.godown,
        String(r.qty),
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
      <ReportsSubnav />
      <div className="mb-6">
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Sales register</h1>
        <p className="text-sm text-zinc-500 mt-1 tabular-nums">
          {loaded
            ? <>{rangeLabel} · {fmtN(visibleRows.length)} {visibleRows.length === 1 ? "row" : "rows"} shown</>
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
          Showing the first {fmtN(LIMIT)} sales in this range. Pick a shorter range to see everything.
        </div>
      )}

      {/* KPI strip */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
        <Kpi
          icon={<ShoppingCart className="w-3.5 h-3.5" />}
          label="Active sales"
          value={loaded ? fmtN(totals.count) : ""}
          note="excludes reversed pairs"
        />
        <Kpi
          icon={<Boxes className="w-3.5 h-3.5" />}
          label="Units sold"
          value={loaded ? fmtN(totals.qty) : ""}
          note="total quantity"
        />
        <Kpi
          icon={<ListChecks className="w-3.5 h-3.5" />}
          label="Rows in view"
          value={loaded ? fmtN(visibleRows.length) : ""}
          note={showReversed ? "incl. reversed + reversals" : "active only"}
        />
      </div>

      {/* Table — desktop */}
      <div className="hidden md:block bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 dark:bg-zinc-900/50 border-b border-zinc-200 dark:border-zinc-800">
            <tr className="text-zinc-500 text-[11px] uppercase tracking-wider">
              <th className="text-left px-5 py-2.5 font-medium">Date</th>
              <th className="text-left px-3 py-2.5 font-medium">Item</th>
              <th className="text-left px-3 py-2.5 font-medium">Godown</th>
              <th className="text-right px-3 py-2.5 font-medium">Qty</th>
              <th className="text-left px-5 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {!loaded && (
              <tr><td colSpan={5} className="py-10 text-center text-sm text-zinc-500">Loading…</td></tr>
            )}
            {loaded && visibleRows.length === 0 && !err && (
              <tr>
                <td colSpan={5} className="py-12 text-center text-sm text-zinc-500">
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
                <td className="px-5 py-2.5 text-xs text-zinc-500">
                  {fmtN(totals.count)} sale{totals.count === 1 ? "" : "s"}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden shadow-sm">
        {!loaded && <div className="py-10 text-center text-sm text-zinc-500">Loading…</div>}
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
      <div className="text-2xl font-semibold tnum">
        {value || <span className="shimmer inline-block h-7 w-16 rounded" />}
      </div>
      <div className="text-[11px] text-zinc-500 mt-1">{note}</div>
    </div>
  );
}
