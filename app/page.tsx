"use client";
import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
  Boxes, Layers3, IndianRupee, PackageX, TrendingDown, BellRing,
  ChevronRight, Flame, LineChart, AlertOctagon, ArrowUpRight,
} from "lucide-react";
import { Shell } from "@/components/shell";
import { useAuth } from "@/app/providers";
import { sb, type Item, type Stock, type Pricing, type Txn } from "@/lib/supabase";
import { fmtN, fmtMoney, cn } from "@/lib/utils";

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
  const [data, setData] = useState<{ items: Combined[]; txn: Txn[]; loaded: boolean }>({
    items: [], txn: [], loaded: false,
  });

  useEffect(() => {
    (async () => {
      const c = sb();
      const since90 = daysAgoISO(90);
      const [{ data: items }, { data: stock }, { data: pricing }, { data: txn }] = await Promise.all([
        c.from("items").select("*").eq("archived", false).order("item_code"),
        c.from("godown_stock").select("*"),
        c.from("pricing").select("*"),
        // 90 days covers recent activity + 30-day movers + dead-stock basis in
        // one pull. Rye's volume is a few hundred txns/yr, far under the cap.
        c.from("transactions").select("*").gte("txn_date", since90).order("created_at", { ascending: false }).limit(2000),
      ]);
      const sMap: Record<string, { A?: Stock; B?: Stock }> = {};
      (stock || []).forEach((s: any) => {
        sMap[s.item_id] = sMap[s.item_id] || {};
        sMap[s.item_id][s.godown as "A" | "B"] = s as Stock;
      });
      const pMap: Record<string, Pricing> = {};
      (pricing || []).forEach((p: any) => { pMap[p.item_id] = p as Pricing; });
      const combined: Combined[] = (items || []).map((i: any) => {
        const cs = i.case_size || 0;
        const a = sMap[i.id]?.A; const b = sMap[i.id]?.B;
        const totalA = a ? (cs > 0 ? a.cases * cs + a.loose : a.loose) : 0;
        const totalB = b ? (cs > 0 ? b.cases * cs + b.loose : b.loose) : 0;
        return {
          ...i, totalA, totalB, total: totalA + totalB,
          hasStockRow: !!a || !!b, price: pMap[i.id],
        };
      });
      setData({ items: combined, txn: (txn || []) as Txn[], loaded: true });
    })();
  }, []);

  const m = useMemo(() => {
    const items = data.items;
    const totA = items.reduce((s, i) => s + i.totalA, 0);
    const totB = items.reduce((s, i) => s + i.totalB, 0);
    const stockValue = items.reduce((s, i) => {
      if (!i.price) return s;
      const rate = i.price.lp * (1 - (i.price.discount || 0)) * (1 + (i.price.gst_rate ?? 0.18));
      return s + i.total * rate;
    }, 0);
    // Out of stock = items WE CARRY (have a godown_stock row) that are now at
    // zero — no longer counting never-stocked SKUs (the old double-count bug).
    const outOfStock = items.filter(i => i.hasStockRow && i.total === 0);
    const lowStock = items.filter(i => {
      const threshold = Math.max((i.reorder_point_a || 0) + (i.reorder_point_b || 0), 2);
      return i.total > 0 && i.total <= threshold;
    });

    // Active sales (drop reversals + reversed originals) within the window.
    const reversedIds = new Set(data.txn.map(t => t.reverses_id).filter(Boolean) as string[]);
    const activeSale = (t: Txn) => t.action === "Sale" && !t.reverses_id && !reversedIds.has(t.id);

    const since30 = daysAgoISO(30);
    const moversMap: Record<string, number> = {};
    data.txn.filter(t => activeSale(t) && (t.txn_date || "") >= since30).forEach(t => {
      moversMap[t.item_id] = (moversMap[t.item_id] || 0) + t.qty;
    });
    const itemById = new Map(items.map(i => [i.id, i]));
    const topMovers = Object.entries(moversMap)
      .map(([id, units]) => ({ item: itemById.get(id), units }))
      .filter(x => x.item)
      .sort((a, b) => b.units - a.units)
      .slice(0, 5);

    // Dead stock = has units on hand but no active sale in the last 90 days.
    const soldIds90 = new Set(data.txn.filter(activeSale).map(t => t.item_id));
    const deadStock = items.filter(i => i.total > 0 && !soldIds90.has(i.id));

    // 14-day sales trend (units/day).
    const trend: { label: string; units: number }[] = [];
    for (let k = 13; k >= 0; k--) {
      const iso = daysAgoISO(k);
      const units = data.txn.filter(t => activeSale(t) && (t.txn_date || "").slice(0, 10) === iso)
        .reduce((s, t) => s + t.qty, 0);
      const d = new Date(iso + "T00:00:00");
      trend.push({ label: d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }), units });
    }
    const trendTotal = trend.reduce((s, p) => s + p.units, 0);

    return { totA, totB, stockValue, outOfStock, lowStock, topMovers, deadStock, trend, trendTotal };
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

      {/* KPIs — stock value is the hero metric (violet treatment). */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 mb-5 md:mb-6">
        <ValueKpi loaded={data.loaded} value={data.loaded ? fmtMoney(m.stockValue) : ""} />
        <Kpi href="/items" icon={<Boxes className="w-4 h-4" />} label="SKUs" value={data.loaded ? String(data.items.length) : ""} note="in catalogue" loaded={data.loaded} />
        <Kpi href="/godown-a" icon={<Layers3 className="w-4 h-4" />} label="Godown A" value={data.loaded ? fmtN(m.totA) : ""} note="units" loaded={data.loaded} />
        <Kpi href="/godown-b" icon={<Layers3 className="w-4 h-4" />} label="Godown B" value={data.loaded ? fmtN(m.totB) : ""} note="units" loaded={data.loaded} />
        <Kpi href="/items?status=out" icon={<PackageX className="w-4 h-4" />} label="Out of stock" value={data.loaded ? String(m.outOfStock.length) : ""} note="carried, now zero" tone="bad" loaded={data.loaded} />
        <Kpi href="/items?status=low" icon={<TrendingDown className="w-4 h-4" />} label="Low stock" value={data.loaded ? String(m.lowStock.length) : ""} note="below reorder" tone="warn" loaded={data.loaded} />
      </div>

      {/* Sales trend + Attention */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-5 md:mb-6">
        <Card className="lg:col-span-2" title="Sales — last 14 days" icon={<LineChart className="w-4 h-4 text-cyan-500" />}
          right={data.loaded ? <span className="text-xs text-zinc-500"><b className="text-zinc-700 dark:text-zinc-200 tnum">{fmtN(m.trendTotal)}</b> units sold</span> : null}>
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
          <RecentActivity txn={data.txn} items={data.items} />
        )}
      </Card>
    </Shell>
  );
}

// ─── Recent activity (table on md+, cards on mobile) ───────────────────────
function RecentActivity({ txn, items }: { txn: Txn[]; items: Combined[] }) {
  const itemLabel = (id: string) => {
    const i = items.find(x => x.id === id);
    return i ? `${i.model} ${i.size} · ${i.colour}` : "?";
  };
  const fmtTime = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} hr ago`;
    return new Date(iso).toLocaleDateString("en-IN");
  };
  const actionStyle = (a: Txn["action"]) => ({
    Purchase: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-300",
    Sale: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
    Transfer: "bg-amber-500/15 text-amber-600 dark:text-amber-300",
    Adjustment: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-300",
    Return: "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-300",
  })[a] || "";

  return (
    <>
      <table className="w-full text-sm hidden md:table">
        <thead className="bg-zinc-50 dark:bg-zinc-900/50">
          <tr className="text-zinc-500 text-[11px] uppercase tracking-wider">
            <th className="text-left px-5 py-2 font-medium">When</th>
            <th className="text-left px-3 py-2 font-medium">Action</th>
            <th className="text-left px-3 py-2 font-medium">Item</th>
            <th className="text-left px-3 py-2 font-medium">Godown</th>
            <th className="text-right px-5 py-2 font-medium">Qty</th>
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
function ValueKpi({ value, loaded }: { value: string; loaded: boolean }) {
  return (
    <div className="col-span-2 lg:col-span-1 relative overflow-hidden rounded-2xl md:rounded-xl p-4 bg-gradient-to-br from-cyan-500 to-violet-700 text-white shadow-glow">
      <div className="absolute -right-6 -top-6 w-24 h-24 rounded-full bg-white/10" />
      <div className="flex items-center gap-2 text-xs text-white/80 mb-2"><IndianRupee className="w-4 h-4" /> Stock value</div>
      <div className="text-2xl md:text-[1.65rem] font-semibold font-display tracking-tight">
        {value || <span className="shimmer inline-block h-7 w-24 rounded bg-white/20" />}
      </div>
      <div className="text-[11px] text-white/70 mt-1">at sale price · incl. GST</div>
    </div>
  );
}

function Kpi({
  href, icon, label, value, note, tone, loaded,
}: {
  href: string; icon: React.ReactNode; label: string; value: string; note: string;
  tone?: "warn" | "bad"; loaded: boolean;
}) {
  const valueColour = tone === "bad" ? "text-rose-500" : tone === "warn" ? "text-amber-500" : "";
  return (
    <Link href={href}
      className="group bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl md:rounded-xl shadow-sm md:shadow-none p-4 transition-colors hover:border-cyan-500/50">
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
    <div className={cn("bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl md:rounded-xl shadow-sm md:shadow-none overflow-hidden", className)}>
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
