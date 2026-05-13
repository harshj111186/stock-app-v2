"use client";
import { useEffect, useState } from "react";
import { Boxes, Layers3, IndianRupee, PackageX, TrendingDown, ReceiptIndianRupee, BellRing, ChevronRight, ArrowUpRight, Flame } from "lucide-react";
import { Shell } from "@/components/shell";
import { sb, type Item, type Stock, type Pricing, type Txn } from "@/lib/supabase";
import { fmtN, fmtMoney } from "@/lib/utils";

type Combined = Item & { totalA: number; totalB: number; price?: Pricing };

export default function Dashboard() {
  const [data, setData] = useState<{ items: Combined[]; txn: Txn[]; loaded: boolean }>({ items: [], txn: [], loaded: false });

  useEffect(() => {
    (async () => {
      const c = sb();
      const [{ data: items }, { data: stock }, { data: pricing }, { data: txn }] = await Promise.all([
        c.from("items").select("*").order("item_code"),
        c.from("godown_stock").select("*"),
        c.from("pricing").select("*"),
        c.from("transactions").select("*").order("created_at", { ascending: false }).limit(20),
      ]);
      const sMap: Record<string, { A: Stock; B: Stock }> = {};
      (stock || []).forEach((s: any) => {
        sMap[s.item_id] = sMap[s.item_id] || { A: { item_id: s.item_id, godown: "A", cases: 0, loose: 0 }, B: { item_id: s.item_id, godown: "B", cases: 0, loose: 0 } };
        sMap[s.item_id][s.godown as "A" | "B"] = s as Stock;
      });
      const pMap: Record<string, Pricing> = {};
      (pricing || []).forEach((p: any) => { pMap[p.item_id] = p as Pricing; });
      const combined: Combined[] = (items || []).map((i: any) => {
        const cs = i.case_size || 0;
        const a = sMap[i.id]?.A || { cases: 0, loose: 0 };
        const b = sMap[i.id]?.B || { cases: 0, loose: 0 };
        return {
          ...i,
          totalA: cs > 0 ? a.cases * cs + a.loose : a.loose,
          totalB: cs > 0 ? b.cases * cs + b.loose : b.loose,
          price: pMap[i.id],
        };
      });
      setData({ items: combined, txn: (txn || []) as Txn[], loaded: true });
    })();
  }, []);

  const totA = data.items.reduce((s, i) => s + i.totalA, 0);
  const totB = data.items.reduce((s, i) => s + i.totalB, 0);
  const stockValue = data.items.reduce((s, i) => {
    if (!i.price) return s;
    const rate = i.price.lp * (1 - (i.price.discount || 0)) * (1 + (i.price.gst_rate || 0.18));
    return s + (i.totalA + i.totalB) * rate;
  }, 0);
  const outOfStock = data.items.filter(i => i.totalA + i.totalB === 0).length;
  const lowStock = data.items.filter(i => {
    const t = i.totalA + i.totalB;
    return t > 0 && t <= Math.max(i.reorder_point_a + i.reorder_point_b, 2);
  }).length;

  const formatTxnTime = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} hr ago`;
    return new Date(iso).toLocaleDateString("en-IN");
  };
  const itemLabel = (id: string) => {
    const i = data.items.find(x => x.id === id);
    return i ? `${i.model} ${i.size} · ${i.colour}` : "?";
  };
  const actionStyle = (a: Txn["action"]) => ({
    Purchase: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-300",
    Sale: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
    Transfer: "bg-amber-500/15 text-amber-600 dark:text-amber-300",
    Adjustment: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-300",
    Return: "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-300",
  })[a] || "";

  return (
    <Shell title="Dashboard">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome back.</h1>
        <p className="text-sm text-zinc-500 mt-1">Live snapshot of your shop — pulled from Supabase.</p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-8">
        <Kpi icon={<Boxes className="w-3.5 h-3.5" />} label="SKUs" value={data.loaded ? String(data.items.length) : ""} note="in catalogue" />
        <Kpi icon={<Layers3 className="w-3.5 h-3.5" />} label="Stock A" value={data.loaded ? fmtN(totA) : ""} note="units" />
        <Kpi icon={<Layers3 className="w-3.5 h-3.5" />} label="Stock B" value={data.loaded ? fmtN(totB) : ""} note="units" />
        <Kpi icon={<IndianRupee className="w-3.5 h-3.5" />} label="Stock value" value={data.loaded ? fmtMoney(stockValue) : ""} note="at sale price" />
        <Kpi icon={<PackageX className="w-3.5 h-3.5" />} label="Out of stock" value={data.loaded ? String(outOfStock) : ""} note="zero units" tone="bad" />
        <Kpi icon={<TrendingDown className="w-3.5 h-3.5" />} label="Low stock" value={data.loaded ? String(lowStock) : ""} note="below reorder" tone="warn" />
      </div>

      {/* Attention + Recent */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
        <Card title="Attention needed" icon={<BellRing className="w-4 h-4 text-amber-500" />}>
          <Attention label="Out of stock" count={outOfStock} tone="bad" />
          <Attention label="Low stock" count={lowStock} tone="warn" />
          <Attention label="Dead stock (no movement)" count={data.items.filter(i => i.totalA + i.totalB === 0).length} tone="neutral" />
        </Card>
        <Card title="Top movers — last 30 days" icon={<Flame className="w-4 h-4 text-rose-500" />}>
          {!data.loaded ? <Skeleton rows={5} /> : (
            <table className="w-full text-sm">
              <tbody>
                {topMovers(data.txn, data.items).slice(0, 5).map((m, idx) => (
                  <tr key={idx} className="border-t border-zinc-200/50 dark:border-zinc-800/50">
                    <td className="py-2">{m.label}</td>
                    <td className="text-right tnum text-zinc-500 py-2">{m.sold} sold</td>
                  </tr>
                ))}
                {topMovers(data.txn, data.items).length === 0 && (
                  <tr><td className="py-4 text-center text-sm text-zinc-500">No sales yet.</td></tr>
                )}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {/* Recent activity */}
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b border-zinc-200 dark:border-zinc-800 text-sm font-medium">Recent activity</div>
        {!data.loaded ? <Skeleton rows={6} /> : (
          <table className="w-full text-sm">
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
              {data.txn.slice(0, 10).map((t) => (
                <tr key={t.id} className="border-t border-zinc-200/50 dark:border-zinc-800/50 hover:bg-zinc-50 dark:hover:bg-zinc-800/30">
                  <td className="px-5 py-2.5 text-zinc-500 tnum">{formatTxnTime(t.created_at)}</td>
                  <td className="px-3 py-2.5"><span className={`px-2 py-0.5 rounded text-xs ${actionStyle(t.action)}`}>{t.action}</span></td>
                  <td className="px-3 py-2.5">{itemLabel(t.item_id)}</td>
                  <td className="px-3 py-2.5 text-zinc-500">{t.godown}</td>
                  <td className="px-5 py-2.5 text-right tnum">{t.qty}</td>
                </tr>
              ))}
              {data.txn.length === 0 && (
                <tr><td colSpan={5} className="py-10 text-center text-sm text-zinc-500">No transactions logged yet.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </Shell>
  );
}

function Kpi({ icon, label, value, note, tone }: { icon: React.ReactNode; label: string; value: string; note: string; tone?: "warn" | "bad" }) {
  const valueColour = tone === "bad" ? "text-rose-500" : tone === "warn" ? "text-amber-500" : "";
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4">
      <div className="flex items-center gap-2 text-xs text-zinc-500 mb-2">{icon} {label}</div>
      <div className={`text-2xl font-semibold tnum ${valueColour}`}>{value || <span className="shimmer inline-block h-7 w-16 rounded" />}</div>
      <div className="text-[11px] text-zinc-500 mt-1">{note}</div>
    </div>
  );
}

function Card({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-5">
      <div className="flex items-center gap-2 mb-4">{icon}<div className="text-sm font-medium">{title}</div></div>
      {children}
    </div>
  );
}

function Attention({ label, count, tone }: { label: string; count: number; tone: "bad" | "warn" | "neutral" }) {
  const colour = tone === "bad" ? "text-rose-500" : tone === "warn" ? "text-amber-500" : "text-zinc-700 dark:text-zinc-300";
  return (
    <button className="w-full flex items-center justify-between p-2.5 rounded-md hover:bg-zinc-50 dark:hover:bg-zinc-800 text-left">
      <div className="text-sm">{label}</div>
      <div className="flex items-center gap-2">
        <span className={`text-lg font-semibold tnum ${colour}`}>{count}</span>
        <ChevronRight className="w-4 h-4 text-zinc-400" />
      </div>
    </button>
  );
}

function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="p-5 space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-4 rounded shimmer" style={{ width: `${50 + Math.random() * 50}%` }} />
      ))}
    </div>
  );
}

function topMovers(txns: Txn[], items: Combined[]) {
  const byItem: Record<string, number> = {};
  txns.filter(t => t.action === "Sale" && (t.status || "").includes("OK")).forEach(t => {
    byItem[t.item_id] = (byItem[t.item_id] || 0) + t.qty;
  });
  return Object.entries(byItem)
    .map(([id, sold]) => {
      const i = items.find(x => x.id === id);
      return { label: i ? `${i.model} · ${i.size} · ${i.colour}` : "?", sold };
    })
    .sort((a, b) => b.sold - a.sold);
}
