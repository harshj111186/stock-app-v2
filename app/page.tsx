"use client";
import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  Boxes, Layers3, IndianRupee, PackageX, TrendingDown, BellRing,
  ChevronRight, Flame, LineChart, AlertOctagon, ArrowUpRight, AlertCircle,
} from "lucide-react";
import { Shell } from "@/components/shell";
import { useAuth } from "@/app/providers";
import { sb, fetchAllRows, type Item, type Stock, type Pricing, type Txn } from "@/lib/supabase";
import { fmtN, fmtMoney, cn, netRate, DEFAULT_GST, lowThresholdCombined } from "@/lib/utils";

// Recharts is heavy (~50kB) — load it lazily so it never touches the initial
// dashboard payload. A small skeleton holds its space to avoid layout shift.
const DashboardChart = dynamic(() => import("@/components/dashboard-chart"), {
  ssr: false,
  loading: () => <div className="h-[180px] rounded-lg shimmer" />,
});

type Combined = Item & {
  totalA: number; totalB: number; total: number;
  hasStockRow: boolean; price?: Pricing;
};

// Local-time YYYY-MM-DD for `n` days ago (avoids the IST midnight drift that
// toISOString() introduces).
function daysAgoISO(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function Dashboard() {
  const { profile } = useAuth();
  const [data, setData] = useState<{
    items: Combined[]; allItems: Combined[]; txn: Txn[]; loaded: boolean; error: string | null;
  }>({ items: [], allItems: [], txn: [], loaded: false, error: null });
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const c = sb();
      const since90 = daysAgoISO(90);
      // Paginated pulls — PostgREST silently clamps any select to 1,000 rows,
      // so .limit(2000) never actually returned 2,000 (see fetchAllRows doc).
      // Items are fetched INCLUDING archived so Recent activity can label
      // transactions of archived SKUs; every metric uses the active subset.
      const [itemsR, stockR, pricingR, txnR] = await Promise.all([
        fetchAllRows<Item>((f, t) => c.from("items").select("*").order("item_code").order("id").range(f, t)),
        fetchAllRows<Stock>((f, t) => c.from("godown_stock").select("*").order("item_id").order("godown").range(f, t)),
        fetchAllRows<Pricing>((f, t) => c.from("pricing").select("*").order("item_id").range(f, t)),
        fetchAllRows<Txn>((f, t) =>
          c.from("transactions").select("*").gte("txn_date", since90)
            .order("created_at", { ascending: false }).order("id").range(f, t),
          { maxRows: 10000 }),
      ]);
      if (cancelled) return;
      const error = itemsR.error || stockR.error || pricingR.error || txnR.error;
      if (error) {
        setData((d) => ({ ...d, loaded: true, error }));
        return;
      }
      const sMap: Record<string, { A?: Stock; B?: Stock }> = {};
      stockR.rows.forEach((s) => {
        sMap[s.item_id] = sMap[s.item_id] || {};
        sMap[s.item_id][s.godown] = s;
      });
      const pMap: Record<string, Pricing> = {};
      pricingR.rows.forEach((p) => { pMap[p.item_id] = p; });
      const combined: Combined[] = itemsR.rows.map((i) => {
        const cs = i.case_size || 0;
        const a = sMap[i.id]?.A; const b = sMap[i.id]?.B;
        const totalA = a ? (cs > 0 ? a.cases * cs + a.loose : a.loose) : 0;
        const totalB = b ? (cs > 0 ? b.cases * cs + b.loose : b.loose) : 0;
        return {
          ...i, totalA, totalB, total: totalA + totalB,
          hasStockRow: !!a || !!b, price: pMap[i.id],
        };
      });
      setData({
        items: combined.filter((i) => !i.archived),
        allItems: combined,
        txn: txnR.rows,
        loaded: true,
        error: null,
      });
    })();
    return () => { cancelled = true; };
  }, [reloadTick]);

  const m = useMemo(() => {
    const items = data.items;
    const totA = items.reduce((s, i) => s + i.totalA, 0);
    const totB = items.reduce((s, i) => s + i.totalB, 0);
    // Shared, defensive pricing math (netRate guards legacy percent-valued
    // discounts; DEFAULT_GST = 18% when the pricing row has no rate).
    const stockValue = items.reduce((s, i) => {
      if (!i.price) return s;
      const rate = netRate(i.price.lp, i.price.discount) * (1 + (i.price.gst_rate ?? DEFAULT_GST));
      return s + i.total * rate;
    }, 0);
    const unpricedWithStock = items.filter(i => !i.price && i.total > 0).length;
    // Out of stock = items WE CARRY (have a godown_stock row) that are now at
    // zero — no longer counting never-stocked SKUs (the old double-count bug).
    const outOfStock = items.filter(i => i.hasStockRow && i.total === 0);
    // Low stock = the ONE shared rule (lib/utils): ≤ max(reorder A + B, 2).
    const lowStock = items.filter(i => i.total > 0 && i.total <= lowThresholdCombined(i));

    // Active rows (drop reversals + reversed originals) within the window.
    const reversedIds = new Set(data.txn.map(t => t.reverses_id).filter(Boolean) as string[]);
    const activeSale = (t: Txn) => t.action === "Sale" && !t.reverses_id && !reversedIds.has(t.id);
    // Customer return = Return with direction +1 (stock came back). Netting
    // these keeps "units sold" honest across dashboard + reports.
    const activeCustReturn = (t: Txn) =>
      t.action === "Return" && t.direction === 1 && !t.reverses_id && !reversedIds.has(t.id);

    const since30 = daysAgoISO(30);
    const moversMap: Record<string, number> = {};
    data.txn.filter(t => (t.txn_date || "") >= since30).forEach(t => {
      if (activeSale(t)) moversMap[t.item_id] = (moversMap[t.item_id] || 0) + t.qty;
      else if (activeCustReturn(t)) moversMap[t.item_id] = (moversMap[t.item_id] || 0) - t.qty;
    });
    const itemById = new Map(items.map(i => [i.id, i]));
    const topMovers = Object.entries(moversMap)
      .map(([id, units]) => ({ item: itemById.get(id), units }))
      .filter(x => x.item && x.units > 0)
      .sort((a, b) => b.units - a.units)
      .slice(0, 5);

    // Dead stock = has units on hand but no active sale in the last 90 days.
    // Strictly newer than the boundary: a sale exactly 90 days ago counts as
    // dead — same rule as the Dead-stock report (≥ threshold days idle).
    const soldIds90 = new Set(
      data.txn.filter(t => activeSale(t) && (t.txn_date || "") > daysAgoISO(90)).map(t => t.item_id)
    );
    const deadStock = items.filter(i => i.total > 0 && !soldIds90.has(i.id));

    // 14-day sales trend (units/day, net of customer returns).
    const trend: { label: string; units: number }[] = [];
    for (let k = 13; k >= 0; k--) {
      const iso = daysAgoISO(k);
      const units = data.txn.filter(t => (t.txn_date || "").slice(0, 10) === iso)
        .reduce((s, t) => s + (activeSale(t) ? t.qty : activeCustReturn(t) ? -t.qty : 0), 0);
      const d = new Date(iso + "T00:00:00");
      trend.push({ label: d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }), units });
    }
    const trendTotal = trend.reduce((s, p) => s + p.units, 0);

    return { totA, totB, stockValue, unpricedWithStock, outOfStock, lowStock, topMovers, deadStock, trend, trendTotal };
  }, [data]);

  const firstName = (profile?.name || profile?.email?.split("@")[0] || "").split(" ")[0];

  return (
    <Shell title="Dashboard">
      <div className="mb-6 md:mb-8 animate-fade-in">
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">
          Welcome back{firstName ? <>, <span className="text-cyan-600 dark:text-cyan-400">{firstName}</span></> : ""}.
        </h1>
        <p className="text-sm text-zinc-500 mt-1">Live snapshot of Rye Electricals — straight from the ledger.</p>
      </div>

      {data.error && (
        <div className="mb-4 text-sm text-rose-600 dark:text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-md p-2.5 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="flex-1">Couldn&apos;t load the dashboard — {data.error}</span>
          <button
            type="button"
            onClick={() => { setData((d) => ({ ...d, loaded: false, error: null })); setReloadTick((t) => t + 1); }}
            className="font-medium underline underline-offset-2 hover:text-rose-700 dark:hover:text-rose-200"
          >
            Retry
          </button>
        </div>
      )}

      {/* KPIs — stock value is the hero metric (violet treatment). */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 mb-5 md:mb-6">
        <ValueKpi loaded={data.loaded} value={data.loaded ? fmtMoney(m.stockValue) : ""} unpriced={m.unpricedWithStock} />
        <Kpi href="/items" icon={<Boxes className="w-4 h-4" />} label="SKUs" value={data.loaded ? String(data.items.length) : ""} note="in catalogue" loaded={data.loaded} />
        <Kpi href="/godown-a" icon={<Layers3 className="w-4 h-4" />} label="Godown A" value={data.loaded ? fmtN(m.totA) : ""} note="units" loaded={data.loaded} />
        <Kpi href="/godown-b" icon={<Layers3 className="w-4 h-4" />} label="Godown B" value={data.loaded ? fmtN(m.totB) : ""} note="units" loaded={data.loaded} />
        <Kpi href="/items?status=out" icon={<PackageX className="w-4 h-4" />} label="Out of stock" value={data.loaded ? String(m.outOfStock.length) : ""} note="carried, now zero" tone="bad" loaded={data.loaded} />
        <Kpi href="/items?status=low" icon={<TrendingDown className="w-4 h-4" />} label="Low stock" value={data.loaded ? String(m.lowStock.length) : ""} note="below reorder" tone="warn" loaded={data.loaded} className="col-span-2 lg:col-span-1" />
      </div>

      {/* Sales trend + Attention */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-5 md:mb-6">
        <Card className="lg:col-span-2" title="Sales — last 14 days" icon={<LineChart className="w-4 h-4 text-cyan-500" />}
          right={data.loaded ? <span className="text-xs text-zinc-500"><b className="text-zinc-700 dark:text-zinc-200 tnum">{fmtN(m.trendTotal)}</b> units · net of returns</span> : null}>
          {!data.loaded ? <div className="h-[180px] rounded-lg shimmer" /> :
            m.trendTotal === 0 ? <EmptyMini icon={<LineChart className="w-6 h-6" />} text="No sales in the last 14 days." /> :
            <DashboardChart data={m.trend} />}
        </Card>
        <Card title="Attention needed" icon={<BellRing className="w-4 h-4 text-amber-500" />}>
          <div className="space-y-1">
            <Attention href="/items?status=out" label="Out of stock" count={m.outOfStock.length} tone="bad" loaded={data.loaded} />
            <Attention href="/items?status=low" label="Low stock" count={m.lowStock.length} tone="warn" loaded={data.loaded} />
            <Attention href="/reports/dead-stock" label="Dead stock (90d idle)" count={m.deadStock.length} tone="neutral" loaded={data.loaded} />
          </div>
        </Card>
      </div>

      {/* Top movers + Low-stock watchlist */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-5 md:mb-6">
        <Card title="Top movers — last 30 days" icon={<Flame className="w-4 h-4 text-rose-500" />}>
          {!data.loaded ? <Skeleton rows={5} /> : m.topMovers.length === 0 ? (
            <EmptyMini icon={<Flame className="w-6 h-6" />} text="No sales in the last 30 days yet." />
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
              {m.topMovers.map((mv, idx) => (
                <li key={idx} className="flex items-center gap-3 py-2.5">
                  <span className="w-5 text-center text-xs font-semibold text-zinc-400 tnum">{idx + 1}</span>
                  <span className="flex-1 min-w-0 text-sm truncate">
                    {mv.item!.brand && <span className="text-zinc-400">{mv.item!.brand} · </span>}
                    {mv.item!.model} <span className="text-zinc-500">{mv.item!.size}</span>
                  </span>
                  <span className="text-sm font-semibold tnum text-emerald-600 dark:text-emerald-400">{fmtN(mv.units)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Low-stock watchlist" icon={<AlertOctagon className="w-4 h-4 text-amber-500" />}
          right={<Link href="/items?status=low" className="text-xs text-cyan-600 dark:text-cyan-400 inline-flex items-center gap-0.5 hover:underline">View all <ArrowUpRight className="w-3 h-3" /></Link>}>
          {!data.loaded ? <Skeleton rows={5} /> : m.lowStock.length === 0 ? (
            <EmptyMini icon={<AlertOctagon className="w-6 h-6" />} text="Nothing below reorder. Healthy shelves." />
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
              {m.lowStock.slice(0, 6).map((i) => (
                <li key={i.id} className="flex items-center gap-3 py-2.5">
                  <span className="flex-1 min-w-0 text-sm truncate">
                    {i.brand && <span className="text-zinc-400">{i.brand} · </span>}
                    {i.model} <span className="text-zinc-500">{i.size}</span>
                  </span>
                  <span className="text-xs text-zinc-500 tnum">A {fmtN(i.totalA)} · B {fmtN(i.totalB)}</span>
                  <span className="text-sm font-semibold tnum text-amber-600 dark:text-amber-400 w-8 text-right">{fmtN(i.total)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* Recent activity */}
      <Card title="Recent activity" noPad>
        {!data.loaded ? <Skeleton rows={6} /> : data.txn.length === 0 ? (
          <div className="py-10 text-center text-sm text-zinc-500">No transactions logged yet.</div>
        ) : (
          <RecentActivity txn={data.txn} items={data.allItems} />
        )}
      </Card>
    </Shell>
  );
}

// ─── Recent activity (table on md+, cards on mobile) ───────────────────────
function RecentActivity({ txn, items }: { txn: Txn[]; items: Combined[] }) {
  const itemLabel = (id: string) => {
    const i = items.find(x => x.id === id);
    if (!i) return "(deleted item)";
    return `${i.model} ${i.size} · ${i.colour}${i.archived ? " (archived)" : ""}`;
  };
  const fmtTime = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} hr ago`;
    return new Date(iso).toLocaleDateString("en-IN");
  };
  // One canonical action→colour map, shared visually with the Transactions
  // log (the two pages used to disagree on Adjustment + Return).
  const actionStyle = (a: Txn["action"]) => ({
    Purchase: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-300",
    Sale: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
    Transfer: "bg-amber-500/15 text-amber-600 dark:text-amber-300",
    Adjustment: "bg-sky-500/15 text-sky-600 dark:text-sky-300",
    Return: "bg-rose-500/15 text-rose-600 dark:text-rose-300",
  })[a] || "";

  return (
    <>
      <table className="w-full text-sm hidden md:table">
        <thead className="bg-zinc-50 dark:bg-zinc-900/50 border-b border-zinc-200 dark:border-zinc-800">
          <tr className="text-zinc-500 text-[11px] uppercase tracking-wider">
            <th className="text-left px-5 py-2.5 font-medium">When</th>
            <th className="text-left px-3 py-2.5 font-medium">Action</th>
            <th className="text-left px-3 py-2.5 font-medium">Item</th>
            <th className="text-left px-3 py-2.5 font-medium">Godown</th>
            <th className="text-right px-5 py-2.5 font-medium">Qty</th>
          </tr>
        </thead>
        <tbody>
          {txn.slice(0, 10).map((t) => (
            <tr key={t.id} className="border-t border-zinc-200/50 dark:border-zinc-800/50 hover:bg-zinc-50 dark:hover:bg-zinc-800/30">
              <td className="px-5 py-2.5 text-zinc-500 tnum">{fmtTime(t.created_at)}</td>
              <td className="px-3 py-2.5"><span className={`px-2 py-0.5 rounded text-xs ${actionStyle(t.action)}`}>{t.action}</span></td>
              <td className="px-3 py-2.5">{itemLabel(t.item_id)}</td>
              <td className="px-3 py-2.5 text-zinc-500">{t.godown}</td>
              <td className="px-5 py-2.5 text-right tnum">{fmtN(t.qty)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="md:hidden divide-y divide-zinc-200/60 dark:divide-zinc-800/60">
        {txn.slice(0, 10).map((t) => (
          <li key={t.id} className="px-4 py-3.5">
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <span className={`px-2 py-0.5 rounded text-xs ${actionStyle(t.action)}`}>{t.action}</span>
              <span className="text-xs text-zinc-500 tnum">{fmtTime(t.created_at)}</span>
            </div>
            <div className="text-sm font-medium truncate">{itemLabel(t.item_id)}</div>
            <div className="text-xs text-zinc-500 mt-1 flex items-center justify-between">
              <span>Godown {t.godown}</span>
              <span className="tnum text-zinc-900 dark:text-zinc-100 font-semibold text-sm">{fmtN(t.qty)}</span>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

// ─── KPI cards ─────────────────────────────────────────────────────────────
function ValueKpi({ value, loaded, unpriced }: { value: string; loaded: boolean; unpriced?: number }) {
  void loaded;
  return (
    <Link href="/pricing"
      className="col-span-2 lg:col-span-1 relative overflow-hidden rounded-2xl md:rounded-lg p-4 bg-gradient-to-br from-cyan-500 to-violet-700 text-white shadow-glow transition-transform hover:scale-[1.01]">
      <div className="absolute -right-6 -top-6 w-24 h-24 rounded-full bg-white/10" />
      <div className="flex items-center gap-2 text-xs text-white/80 mb-2"><IndianRupee className="w-4 h-4" /> Stock value</div>
      <div className="text-2xl md:text-[1.65rem] font-semibold font-display tracking-tight">
        {value || <span className="shimmer inline-block h-7 w-24 rounded bg-white/20" />}
      </div>
      <div className="text-[11px] text-white/70 mt-1">
        at sale price · incl. GST{unpriced ? ` · ${unpriced} unpriced excluded` : ""}
      </div>
    </Link>
  );
}

function Kpi({
  href, icon, label, value, note, tone, loaded, className,
}: {
  href: string; icon: React.ReactNode; label: string; value: string; note: string;
  tone?: "warn" | "bad"; loaded: boolean; className?: string;
}) {
  void loaded;
  const valueColour = tone === "bad" ? "text-rose-500" : tone === "warn" ? "text-amber-500" : "";
  return (
    <Link href={href}
      className={cn("group bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl md:rounded-lg shadow-sm md:shadow-none p-4 transition-colors hover:border-cyan-500/50", className)}>
      <div className="flex items-center justify-between text-xs text-zinc-500 mb-2">
        <span className="inline-flex items-center gap-1.5">
          <span className="text-zinc-400 group-hover:text-cyan-500 transition-colors">{icon}</span> {label}
        </span>
        <ChevronRight className="w-3.5 h-3.5 text-zinc-300 dark:text-zinc-700 group-hover:text-cyan-500 transition-colors" />
      </div>
      <div className={cn("text-2xl font-semibold font-display tnum", valueColour)}>
        {value || <span className="shimmer inline-block h-7 w-14 rounded" />}
      </div>
      <div className="text-[11px] text-zinc-500 mt-1">{note}</div>
    </Link>
  );
}

function Card({
  title, icon, children, right, className, noPad,
}: {
  title: string; icon?: React.ReactNode; children: React.ReactNode;
  right?: React.ReactNode; className?: string; noPad?: boolean;
}) {
  return (
    <div className={cn("bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl md:rounded-lg shadow-sm md:shadow-none overflow-hidden", className)}>
      <div className={cn("flex items-center justify-between gap-2", noPad ? "px-5 py-3 border-b border-zinc-200 dark:border-zinc-800" : "px-5 pt-4 pb-3")}>
        <div className="flex items-center gap-2 text-sm font-medium">{icon}{title}</div>
        {right}
      </div>
      <div className={noPad ? "" : "px-5 pb-4"}>{children}</div>
    </div>
  );
}

function Attention({
  href, label, count, tone, loaded,
}: {
  href: string; label: string; count: number; tone: "bad" | "warn" | "neutral"; loaded: boolean;
}) {
  const colour = tone === "bad" ? "text-rose-500" : tone === "warn" ? "text-amber-500" : "text-zinc-700 dark:text-zinc-300";
  return (
    <Link href={href} className="w-full flex items-center justify-between p-2.5 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors group">
      <div className="text-sm">{label}</div>
      <div className="flex items-center gap-2">
        <span className={cn("text-lg font-semibold tnum font-display", colour)}>{loaded ? count : "—"}</span>
        <ChevronRight className="w-4 h-4 text-zinc-400 group-hover:translate-x-0.5 transition-transform" />
      </div>
    </Link>
  );
}

function EmptyMini({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="py-8 text-center text-zinc-400 dark:text-zinc-600">
      <div className="flex justify-center mb-2">{icon}</div>
      <div className="text-sm text-zinc-500">{text}</div>
    </div>
  );
}

function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="py-2 space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-4 rounded shimmer" style={{ width: `${55 + ((i * 9) % 40)}%` }} />
      ))}
    </div>
  );
}
