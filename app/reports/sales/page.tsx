"use client";
import { Fragment, useEffect, useMemo, useState } from "react";
import {
  BarChart3, Download, Printer, Search,
  IndianRupee, Receipt, Boxes, AlertCircle,
  ChevronDown, ChevronRight, TrendingUp,
} from "lucide-react";
import { Shell } from "@/components/shell";
import { sb, type Item, type Pricing, type Txn } from "@/lib/supabase";
import { fmtN, fmtMoney } from "@/lib/utils";

// ─── helpers: date math ──────────────────────────────────────────────────
// Local-date ISO (NOT UTC) so an entry made at 11pm IST doesn't get
// classified into the next day when the date picker passes through.
const iso = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const today = () => new Date();
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const endOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0);
const startOfWeek = (d: Date) => {
  // ISO week: Monday as first day
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  return x;
};
// Indian financial year: April 1 → March 31
const indianFYStart = (d: Date) =>
  new Date(d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1, 3, 1);
const indianFYEnd = (d: Date) => {
  const s = indianFYStart(d);
  return new Date(s.getFullYear() + 1, 2, 31);
};

type Preset = "today" | "yesterday" | "this_week" | "this_month" | "last_month" | "this_fy" | "custom";

function rangeFor(p: Preset, customFrom: string, customTo: string): { from: string; to: string } {
  const t = today();
  switch (p) {
    case "today": return { from: iso(t), to: iso(t) };
    case "yesterday": {
      const y = new Date(t); y.setDate(y.getDate() - 1);
      return { from: iso(y), to: iso(y) };
    }
    case "this_week": return { from: iso(startOfWeek(t)), to: iso(t) };
    case "this_month": return { from: iso(startOfMonth(t)), to: iso(t) };
    case "last_month": {
      const lm = new Date(t.getFullYear(), t.getMonth() - 1, 1);
      return { from: iso(startOfMonth(lm)), to: iso(endOfMonth(lm)) };
    }
    case "this_fy": {
      const e = indianFYEnd(t);
      return { from: iso(indianFYStart(t)), to: iso(e < t ? e : t) };
    }
    case "custom":
    default: return { from: customFrom, to: customTo };
  }
}

// ─── helpers: note parsing ───────────────────────────────────────────────
// process_transaction bundles invoice / party / rate / reason into ONE note
// string of the form "reason: X • inv: Y • party: Z • rate: N" (see the
// transactions page's `note` assembly). Depending on which version of the
// SQL is live, that string lands in t.reason, t.status, or a future `note`
// column. We parse defensively and fall back to the per-column values when
// they're populated separately (e.g. on rows written by v1).
type Parsed = { reason: string | null; invoice: string | null; party: string | null; rate: number | null };
function parseNote(raw: string | null | undefined): Parsed {
  const out: Parsed = { reason: null, invoice: null, party: null, rate: null };
  if (!raw) return out;
  // Only parse as key:value bundle if at least one segment matches the
  // expected prefix shape. Otherwise treat the whole string as a freeform
  // reason — except for the literal "OK" status which means nothing.
  if (raw === "OK") return out;
  const looksBundled = /(^|\s•\s)(reason|inv|party|rate): /.test(raw);
  if (!looksBundled) {
    out.reason = raw.trim() || null;
    return out;
  }
  for (const p of raw.split(" • ")) {
    if (p.startsWith("reason: ")) out.reason = p.slice(8).trim() || null;
    else if (p.startsWith("inv: ")) out.invoice = p.slice(5).trim() || null;
    else if (p.startsWith("party: ")) out.party = p.slice(7).trim() || null;
    else if (p.startsWith("rate: ")) {
      const n = Number(p.slice(6));
      if (Number.isFinite(n) && n > 0) out.rate = n;
    }
  }
  return out;
}

// ─── enriched sale row ───────────────────────────────────────────────────
type RateSource = "txn" | "note" | "pricing" | "none";
type SaleRow = {
  id: string;
  txn_date: string;
  created_at: string;
  item_id: string;
  godown: "A" | "B";
  qty: number;
  isReversal: boolean;
  signedQty: number;        // negative if reversal — used for revenue math
  item: Item | null;
  brand: string;
  itemLabel: string;
  hsn: string;
  rate: number;             // resolved per-unit, pre-GST
  rateSource: RateSource;
  gstRate: number;          // 0..1
  taxable: number;
  gstAmt: number;
  total: number;
  invoice: string;
  party: string;
  note: string | null;
};

// ─── component ───────────────────────────────────────────────────────────
export default function SalesRegisterPage() {
  // ── Filter state ──────────────────────────────────────────────────────
  const [preset, setPreset] = useState<Preset>("this_month");
  const [customFrom, setCustomFrom] = useState(iso(startOfMonth(today())));
  const [customTo, setCustomTo] = useState(iso(today()));
  const { from, to } = useMemo(
    () => rangeFor(preset, customFrom, customTo),
    [preset, customFrom, customTo]
  );

  // ── Data ──────────────────────────────────────────────────────────────
  const [txns, setTxns] = useState<Txn[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [pricing, setPricing] = useState<Pricing[]>([]);
  const [parties, setParties] = useState<{ id: string; name: string; gstin: string | null }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hitLimit, setHitLimit] = useState(false);

  // ── UI filters ────────────────────────────────────────────────────────
  const [godownFilter, setGodownFilter] = useState<"" | "A" | "B">("");
  const [search, setSearch] = useState("");
  const [showReversed, setShowReversed] = useState(true);
  const [hsnOpen, setHsnOpen] = useState(true);

  // Persist preset + custom range so a refresh doesn't kick the user
  // back to "this month" mid-investigation.
  useEffect(() => {
    try {
      const p = localStorage.getItem("salesReg.preset");
      if (p) setPreset(p as Preset);
      const f = localStorage.getItem("salesReg.customFrom");
      if (f) setCustomFrom(f);
      const t = localStorage.getItem("salesReg.customTo");
      if (t) setCustomTo(t);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { try { localStorage.setItem("salesReg.preset", preset); } catch {} }, [preset]);
  useEffect(() => { try { localStorage.setItem("salesReg.customFrom", customFrom); } catch {} }, [customFrom]);
  useEffect(() => { try { localStorage.setItem("salesReg.customTo", customTo); } catch {} }, [customTo]);

  // ── Fetch on range change ─────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoaded(false);
      setError(null);
      setHitLimit(false);
      try {
        const c = sb();
        const LIMIT = 5000;
        const [{ data: t, error: et }, { data: it, error: ei }, { data: pr, error: ep }, { data: pa }] = await Promise.all([
          c.from("transactions")
            .select("*")
            .eq("action", "Sale")
            .gte("txn_date", from)
            .lte("txn_date", to)
            .order("txn_date", { ascending: false })
            .order("created_at", { ascending: false })
            .limit(LIMIT),
          c.from("items").select("*"),
          c.from("pricing").select("*"),
          c.from("parties").select("id, name, gstin"),
        ]);
        if (cancelled) return;
        if (et || ei || ep) {
          setError((et || ei || ep)!.message);
          setLoaded(true);
          return;
        }
        const rows = (t || []) as Txn[];
        if (rows.length === LIMIT) setHitLimit(true);
        setTxns(rows);
        setItems((it || []) as Item[]);
        setPricing((pr || []) as Pricing[]);
        // parties may be empty — still a valid response
        setParties((pa as { id: string; name: string; gstin: string | null }[] | null) || []);
        setLoaded(true);
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load sales.");
        setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [from, to]);

  // ── Lookups ───────────────────────────────────────────────────────────
  const itemById = useMemo(() => {
    const m = new Map<string, Item>();
    items.forEach(i => m.set(i.id, i));
    return m;
  }, [items]);
  const pricingById = useMemo(() => {
    const m = new Map<string, Pricing>();
    pricing.forEach(p => m.set(p.item_id, p));
    return m;
  }, [pricing]);
  const partyById = useMemo(() => {
    const m = new Map<string, { name: string; gstin: string | null }>();
    parties.forEach(p => m.set(p.id, { name: p.name, gstin: p.gstin }));
    return m;
  }, [parties]);

  // ── Build resolved rows ───────────────────────────────────────────────
  const rows: SaleRow[] = useMemo(() => {
    return txns.map((t): SaleRow => {
      const item = itemById.get(t.item_id) ?? null;
      const price = pricingById.get(t.item_id);

      // Note may sit in any of these — try in order. Skip the literal "OK"
      // status because that's the success marker, not user data.
      const tAny = t as Txn & { note?: string | null };
      const noteText = tAny.note ?? t.reason ?? (t.status === "OK" ? null : t.status) ?? null;
      const parsed = parseNote(noteText);

      // Rate: explicit column → parsed from note → estimated from pricing → none
      let rate = 0;
      let rateSource: RateSource = "none";
      if (t.rate && t.rate > 0) {
        rate = t.rate;
        rateSource = "txn";
      } else if (parsed.rate) {
        rate = parsed.rate;
        rateSource = "note";
      } else if (price && price.lp) {
        // Effective taxable price = LP × (1 − combined discount).
        // `pricing.discount` is kept in sync with the stacked array as the
        // combined effective fraction, so this works for both old single
        // and new stacked rows.
        const r = price.lp * (1 - (price.discount || 0));
        if (r > 0) { rate = r; rateSource = "pricing"; }
      }

      // GST: pricing → item → 18% default
      const gstRate =
        (price?.gst_rate ?? null) !== null ? (price!.gst_rate as number)
        : (item?.gst_rate ?? null) !== null ? (item!.gst_rate as number)
        : 0.18;

      // Reversal sign
      const isReversal = !!t.reverses_id;
      const signedQty = isReversal ? -t.qty : t.qty;
      const taxable = signedQty * rate;
      const gstAmt = taxable * gstRate;
      const total = taxable + gstAmt;

      const invoice = t.invoice_no || parsed.invoice || "—";
      const party =
        (t.party_id && partyById.get(t.party_id)?.name) ||
        parsed.party ||
        "—";

      return {
        id: t.id,
        txn_date: t.txn_date,
        created_at: t.created_at,
        item_id: t.item_id,
        godown: t.godown,
        qty: t.qty,
        isReversal,
        signedQty,
        item,
        brand: item?.brand || "",
        itemLabel: item ? `${item.model} · ${item.size} · ${item.colour}` : "?",
        hsn: item?.hsn_code || "—",
        rate,
        rateSource,
        gstRate,
        taxable,
        gstAmt,
        total,
        invoice,
        party,
        note: noteText,
      };
    });
  }, [txns, itemById, pricingById, partyById]);

  // ── Filter ────────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let list = rows;
    if (!showReversed) list = list.filter(r => !r.isReversal);
    if (godownFilter) list = list.filter(r => r.godown === godownFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(r =>
        `${r.itemLabel} ${r.brand} ${r.invoice} ${r.party} ${r.hsn} ${r.note || ""}`
          .toLowerCase()
          .includes(q)
      );
    }
    return list;
  }, [rows, godownFilter, search, showReversed]);

  // ── KPIs ──────────────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    let units = 0, taxable = 0, gst = 0, missingRate = 0, reversed = 0;
    const invoiceSet = new Set<string>();
    let standaloneSales = 0;
    for (const r of filtered) {
      if (r.isReversal) reversed++;
      units += r.signedQty;
      taxable += r.taxable;
      gst += r.gstAmt;
      if (r.rate === 0) missingRate++;
      if (r.invoice && r.invoice !== "—") invoiceSet.add(r.invoice);
      else standaloneSales++;
    }
    return {
      sales: filtered.length,
      invoiceCount: invoiceSet.size + standaloneSales,
      units,
      taxable,
      gst,
      total: taxable + gst,
      missingRate,
      reversed,
    };
  }, [filtered]);

  // ── HSN / GST summary ─────────────────────────────────────────────────
  type HsnBucket = {
    key: string;
    hsn: string;
    gstRate: number;
    sales: number;
    units: number;
    taxable: number;
    gst: number;
    total: number;
  };
  const hsnSummary: HsnBucket[] = useMemo(() => {
    const map = new Map<string, HsnBucket>();
    for (const r of filtered) {
      const key = `${r.hsn}|${r.gstRate}`;
      const b = map.get(key) || {
        key, hsn: r.hsn, gstRate: r.gstRate,
        sales: 0, units: 0, taxable: 0, gst: 0, total: 0,
      };
      b.sales++;
      b.units += r.signedQty;
      b.taxable += r.taxable;
      b.gst += r.gstAmt;
      b.total += r.total;
      map.set(key, b);
    }
    return [...map.values()].sort((a, b) => b.taxable - a.taxable);
  }, [filtered]);

  // ── Export CSV (Excel opens it directly) ──────────────────────────────
  const downloadCsv = () => {
    const header = [
      "Date", "Type", "Invoice", "Party", "Brand", "Model", "Size", "Colour", "Item Code",
      "HSN", "Godown", "Qty", "Rate (Rs)", "Taxable (Rs)", "GST %", "GST (Rs)", "Total (Rs)", "Note",
    ];
    const data = filtered.map(r => [
      r.txn_date.slice(0, 10),
      r.isReversal ? "Reversal" : "Sale",
      r.invoice,
      r.party,
      r.brand,
      r.item?.model || "",
      r.item?.size || "",
      r.item?.colour || "",
      r.item?.item_code || "",
      r.hsn,
      r.godown,
      r.signedQty,
      r.rate ? r.rate.toFixed(2) : "",
      r.rate ? r.taxable.toFixed(2) : "",
      (r.gstRate * 100).toFixed(2),
      r.rate ? r.gstAmt.toFixed(2) : "",
      r.rate ? r.total.toFixed(2) : "",
      r.note || "",
    ]);
    const all = [header, ...data];
    const csv = all
      .map(row =>
        row
          .map(cell => {
            const s = String(cell ?? "");
            // Excel-safe quoting: wrap if contains comma / quote / newline.
            if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
            return s;
          })
          .join(",")
      )
      .join("\n");
    // BOM so Excel reads UTF-8 without mangling.
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sales-register-${from}-to-${to}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const print = () => window.print();

  // Range label — short for same-day, longer otherwise.
  const rangeLabel = (() => {
    const fOpts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
    if (from === to) return new Date(from).toLocaleDateString("en-IN", fOpts);
    const shortOpts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
    return `${new Date(from).toLocaleDateString("en-IN", shortOpts)} – ${new Date(to).toLocaleDateString("en-IN", fOpts)}`;
  })();

  return (
    <Shell title="Sales register">
      {/* Print-only header (hidden on screen) */}
      <div className="hidden print:block mb-6">
        <h1 className="text-xl font-semibold">Sales register · Rye Electricals</h1>
        <div className="text-sm">{rangeLabel}</div>
      </div>

      {/* ─── Header ─── */}
      <div className="flex items-center justify-between mb-6 no-print">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Sales register</h1>
          <p className="text-sm text-zinc-500 mt-1 tabular-nums">
            {loaded
              ? <>{rangeLabel} · <b className="text-zinc-700 dark:text-zinc-300">{fmtN(filtered.length)}</b> {filtered.length === 1 ? "entry" : "entries"}</>
              : "Loading…"}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={print}
            disabled={!loaded || filtered.length === 0}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm border border-zinc-200 dark:border-zinc-800 hover:border-cyan-500/50 hover:text-cyan-600 dark:hover:text-cyan-300 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Print / save as PDF"
          >
            <Printer className="w-4 h-4" />
            Print
          </button>
          <button
            type="button"
            onClick={downloadCsv}
            disabled={!loaded || filtered.length === 0}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm bg-cyan-500 hover:bg-cyan-400 text-zinc-900 font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            title="Download CSV (opens in Excel)"
          >
            <Download className="w-4 h-4" />
            Export CSV
          </button>
        </div>
      </div>

      {/* ─── Filters ─── */}
      <div className="flex flex-wrap gap-2 mb-4 items-center no-print">
        <select
          value={preset}
          onChange={(e) => setPreset(e.target.value as Preset)}
          className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md px-3 py-1.5 text-sm"
        >
          <option value="today">Today</option>
          <option value="yesterday">Yesterday</option>
          <option value="this_week">This week</option>
          <option value="this_month">This month</option>
          <option value="last_month">Last month</option>
          <option value="this_fy">This FY (Apr–Mar)</option>
          <option value="custom">Custom range…</option>
        </select>

        {preset === "custom" && (
          <Fragment>
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md px-3 py-1.5 text-sm tnum"
            />
            <span className="text-xs text-zinc-500">→</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md px-3 py-1.5 text-sm tnum"
            />
          </Fragment>
        )}

        <select
          value={godownFilter}
          onChange={(e) => setGodownFilter(e.target.value as "" | "A" | "B")}
          className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md px-3 py-1.5 text-sm"
        >
          <option value="">All godowns</option>
          <option value="A">Godown A</option>
          <option value="B">Godown B</option>
        </select>

        <div className="flex-1 min-w-[200px] relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search item / invoice / party / HSN / note…"
            className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md pl-9 pr-3 py-1.5 text-sm focus:outline-none focus:border-cyan-500"
          />
        </div>

        <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400 px-2 py-1.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showReversed}
            onChange={(e) => setShowReversed(e.target.checked)}
            className="accent-cyan-500"
          />
          Show reversals
        </label>
      </div>

      {/* ─── Banners ─── */}
      {error && (
        <div className="mb-3 text-sm text-rose-600 dark:text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-md p-2.5 flex items-start gap-2 no-print">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {hitLimit && (
        <div className="mb-3 text-xs text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-md p-2.5 no-print">
          Showing the first 5,000 sales in this range. Pick a shorter range to see everything.
        </div>
      )}

      {/* ─── KPIs ─── */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3 mb-6">
        <Kpi
          icon={<Receipt className="w-3.5 h-3.5" />}
          label="Sales"
          value={loaded ? fmtN(kpis.sales) : ""}
          sub={kpis.reversed > 0 ? `${fmtN(kpis.reversed)} reversed` : "entries"}
        />
        <Kpi
          icon={<Boxes className="w-3.5 h-3.5" />}
          label="Units sold"
          value={loaded ? fmtN(kpis.units) : ""}
          sub="net of reversals"
        />
        <Kpi
          icon={<IndianRupee className="w-3.5 h-3.5" />}
          label="Taxable"
          value={loaded ? fmtMoney(kpis.taxable) : ""}
          sub="pre-GST"
        />
        <Kpi
          icon={<BarChart3 className="w-3.5 h-3.5" />}
          label="GST"
          value={loaded ? fmtMoney(kpis.gst) : ""}
          sub="collected"
        />
        <Kpi
          icon={<TrendingUp className="w-3.5 h-3.5" />}
          label="Total"
          value={loaded ? fmtMoney(kpis.total) : ""}
          sub="inc. GST"
          tone="good"
        />
      </div>

      {/* ─── HSN/GST summary ─── */}
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden mb-6">
        <button
          onClick={() => setHsnOpen(o => !o)}
          className="w-full flex items-center gap-2 px-5 py-3 border-b border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900/60 text-left no-print"
        >
          {hsnOpen ? <ChevronDown className="w-4 h-4 text-zinc-500" /> : <ChevronRight className="w-4 h-4 text-zinc-500" />}
          <div className="text-sm font-medium">HSN / GST summary</div>
          <span className="text-[10px] bg-zinc-200/70 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 px-1.5 py-0.5 rounded tabular-nums">{hsnSummary.length}</span>
          <span className="ml-auto text-[11px] text-zinc-500">For GSTR-1 / consolidated filing</span>
        </button>
        {/* Always rendered on print so the printout has the summary */}
        {(hsnOpen || typeof window !== "undefined") && (
          <div className={hsnOpen ? "" : "hidden print:block"}>
            <div className="hidden print:block px-5 py-3 text-sm font-medium">HSN / GST summary</div>
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 dark:bg-zinc-900/50">
                <tr className="text-zinc-500 text-[11px] uppercase tracking-wider">
                  <th className="text-left px-5 py-2.5 font-medium">HSN</th>
                  <th className="text-right px-3 py-2.5 font-medium">GST %</th>
                  <th className="text-right px-3 py-2.5 font-medium">Sales</th>
                  <th className="text-right px-3 py-2.5 font-medium">Units</th>
                  <th className="text-right px-3 py-2.5 font-medium">Taxable</th>
                  <th className="text-right px-3 py-2.5 font-medium">GST</th>
                  <th className="text-right px-5 py-2.5 font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {!loaded && (
                  <tr><td colSpan={7} className="py-8 text-center text-sm text-zinc-500">Loading…</td></tr>
                )}
                {loaded && hsnSummary.length === 0 && (
                  <tr><td colSpan={7} className="py-6 text-center text-sm text-zinc-500">No sales in this range.</td></tr>
                )}
                {loaded && hsnSummary.map(b => (
                  <tr key={b.key} className="border-t border-zinc-200/50 dark:border-zinc-800/50">
                    <td className="px-5 py-2 tnum text-zinc-700 dark:text-zinc-200">{b.hsn}</td>
                    <td className="px-3 py-2 text-right tnum text-zinc-500">{(b.gstRate * 100).toFixed(0)}%</td>
                    <td className="px-3 py-2 text-right tnum">{fmtN(b.sales)}</td>
                    <td className="px-3 py-2 text-right tnum">{fmtN(b.units)}</td>
                    <td className="px-3 py-2 text-right tnum">{fmtMoney(b.taxable)}</td>
                    <td className="px-3 py-2 text-right tnum">{fmtMoney(b.gst)}</td>
                    <td className="px-5 py-2 text-right tnum font-semibold">{fmtMoney(b.total)}</td>
                  </tr>
                ))}
                {loaded && hsnSummary.length > 0 && (
                  <tr className="border-t-2 border-zinc-300 dark:border-zinc-700 bg-zinc-50/70 dark:bg-zinc-900/40 font-semibold">
                    <td className="px-5 py-2 text-xs uppercase tracking-wider text-zinc-500">Total</td>
                    <td />
                    <td className="px-3 py-2 text-right tnum">{fmtN(hsnSummary.reduce((s, b) => s + b.sales, 0))}</td>
                    <td className="px-3 py-2 text-right tnum">{fmtN(hsnSummary.reduce((s, b) => s + b.units, 0))}</td>
                    <td className="px-3 py-2 text-right tnum">{fmtMoney(hsnSummary.reduce((s, b) => s + b.taxable, 0))}</td>
                    <td className="px-3 py-2 text-right tnum">{fmtMoney(hsnSummary.reduce((s, b) => s + b.gst, 0))}</td>
                    <td className="px-5 py-2 text-right tnum">{fmtMoney(hsnSummary.reduce((s, b) => s + b.total, 0))}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ─── Detail table ─── */}
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-2 flex-wrap">
          <div className="text-sm font-medium">Detail</div>
          {loaded && kpis.missingRate > 0 && (
            <span className="text-[11px] text-amber-600 dark:text-amber-400 inline-flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              {fmtN(kpis.missingRate)} {kpis.missingRate === 1 ? "row has" : "rows have"} no rate — those are excluded from Totals. Set a rate on Pricing to fix.
            </span>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[1100px]">
            <thead className="bg-zinc-50 dark:bg-zinc-900/50">
              <tr className="text-zinc-500 text-[11px] uppercase tracking-wider">
                <th className="text-left px-5 py-2.5 font-medium">Date</th>
                <th className="text-left px-3 py-2.5 font-medium">Invoice</th>
                <th className="text-left px-3 py-2.5 font-medium">Item</th>
                <th className="text-left px-3 py-2.5 font-medium">HSN</th>
                <th className="text-left px-3 py-2.5 font-medium">Godown</th>
                <th className="text-right px-3 py-2.5 font-medium">Qty</th>
                <th className="text-right px-3 py-2.5 font-medium">Rate</th>
                <th className="text-right px-3 py-2.5 font-medium">Taxable</th>
                <th className="text-right px-3 py-2.5 font-medium">GST</th>
                <th className="text-right px-3 py-2.5 font-medium">Total</th>
                <th className="text-left px-5 py-2.5 font-medium">Party</th>
              </tr>
            </thead>
            <tbody>
              {!loaded && (
                <tr><td colSpan={11} className="py-10 text-center text-sm text-zinc-500">Loading…</td></tr>
              )}
              {loaded && filtered.length === 0 && (
                <tr>
                  <td colSpan={11} className="py-12 text-center text-sm text-zinc-500">
                    No sales match these filters. Try a wider date range or clear the search.
                  </td>
                </tr>
              )}
              {loaded && filtered.map(r => (
                <tr
                  key={r.id}
                  className={[
                    "border-t border-zinc-200/50 dark:border-zinc-800/50",
                    r.isReversal
                      ? "bg-rose-500/5"
                      : "hover:bg-zinc-50 dark:hover:bg-zinc-800/30",
                  ].join(" ")}
                >
                  <td className="px-5 py-2 text-zinc-500 tnum whitespace-nowrap">
                    {r.txn_date.slice(0, 10)}
                    {r.isReversal && <span className="ml-1.5 text-[10px] text-rose-500 font-medium">REV</span>}
                  </td>
                  <td className="px-3 py-2 tnum">{r.invoice}</td>
                  <td className="px-3 py-2 min-w-[260px]">
                    {r.brand && (
                      <span className="bg-cyan-500/15 text-cyan-600 dark:text-cyan-300 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-medium mr-1.5">
                        {r.brand}
                      </span>
                    )}
                    <span>{r.itemLabel}</span>
                  </td>
                  <td className="px-3 py-2 tnum text-zinc-500">{r.hsn}</td>
                  <td className="px-3 py-2 text-zinc-500">{r.godown}</td>
                  <td className="px-3 py-2 text-right tnum">
                    <span className={r.isReversal ? "text-rose-500" : ""}>{fmtN(r.signedQty)}</span>
                  </td>
                  <td className="px-3 py-2 text-right tnum">
                    {r.rate > 0
                      ? <span title={`Source: ${r.rateSource}`}>{fmtMoney(r.rate)}</span>
                      : <span className="text-zinc-400">—</span>}
                    {r.rateSource === "pricing" && (
                      <span className="ml-1 text-[9px] text-zinc-400 uppercase">est</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tnum">
                    {r.rate > 0 ? fmtMoney(r.taxable) : <span className="text-zinc-400">—</span>}
                  </td>
                  <td className="px-3 py-2 text-right tnum text-zinc-500">
                    {r.rate > 0
                      ? `${(r.gstRate * 100).toFixed(0)}% · ${fmtMoney(r.gstAmt)}`
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tnum font-semibold">
                    {r.rate > 0 ? fmtMoney(r.total) : <span className="text-zinc-400 font-normal">—</span>}
                  </td>
                  <td className="px-5 py-2 text-zinc-500 truncate max-w-[200px]" title={r.party}>{r.party}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Footnote */}
      <p className="text-[11px] text-zinc-500 mt-3 leading-relaxed no-print">
        <b>Rate sources:</b> hover the rate cell to see where it came from — <code>txn</code> (stored on the transaction), <code>note</code> (parsed from the note string), or <code>est</code> (estimated from current Pricing: LP × (1 − combined discount)). GST is computed per row from Pricing → Item → 18% fallback. Reversals are subtracted from totals. CGST/SGST split is not shown until customer state is captured on parties.
      </p>
    </Shell>
  );
}

// ─── KPI card ────────────────────────────────────────────────────────────
function Kpi({
  icon, label, value, sub, tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  tone?: "good" | "bad" | "warn";
}) {
  const cls =
    tone === "bad" ? "text-rose-500"
    : tone === "warn" ? "text-amber-500"
    : tone === "good" ? "text-emerald-500"
    : "";
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4">
      <div className="flex items-center gap-2 text-xs text-zinc-500 mb-2">{icon} {label}</div>
      <div className={`text-2xl font-semibold tnum ${cls}`}>
        {value || <span className="shimmer inline-block h-7 w-16 rounded" />}
      </div>
      <div className="text-[11px] text-zinc-500 mt-1">{sub}</div>
    </div>
  );
}
