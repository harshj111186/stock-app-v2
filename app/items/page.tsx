"use client";
import { useEffect, useState, useMemo } from "react";
import { Plus, Search } from "lucide-react";
import { Shell } from "@/components/shell";
import { sb, type Item, type Stock } from "@/lib/supabase";
import { colourCss, fmtN } from "@/lib/utils";

type Combined = Item & { totalA: number; totalB: number };

export default function ItemsPage() {
  const [items, setItems] = useState<Combined[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [q, setQ] = useState("");
  const [brand, setBrand] = useState("");
  const [cat, setCat] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    (async () => {
      const c = sb();
      const [{ data: rows }, { data: stock }] = await Promise.all([
        c.from("items").select("*").order("item_code"),
        c.from("godown_stock").select("*"),
      ]);
      const sMap: Record<string, { A: Stock; B: Stock }> = {};
      (stock || []).forEach((s: any) => {
        sMap[s.item_id] = sMap[s.item_id] || { A: { item_id: s.item_id, godown: "A", cases: 0, loose: 0 }, B: { item_id: s.item_id, godown: "B", cases: 0, loose: 0 } };
        sMap[s.item_id][s.godown as "A" | "B"] = s as Stock;
      });
      const combined: Combined[] = (rows || []).map((i: any) => {
        const cs = i.case_size || 0;
        const a = sMap[i.id]?.A || { cases: 0, loose: 0 };
        const b = sMap[i.id]?.B || { cases: 0, loose: 0 };
        return {
          ...i,
          totalA: cs > 0 ? a.cases * cs + a.loose : a.loose,
          totalB: cs > 0 ? b.cases * cs + b.loose : b.loose,
        };
      });
      setItems(combined);
      setLoaded(true);
    })();
  }, []);

  const brands = useMemo(() => [...new Set(items.map(i => i.brand || "").filter(Boolean))].sort(), [items]);
  const cats = useMemo(() => [...new Set(items.map(i => i.category || "").filter(Boolean))].sort(), [items]);

  const filtered = items.filter(i => {
    if (brand && i.brand !== brand) return false;
    if (cat && i.category !== cat) return false;
    const total = i.totalA + i.totalB;
    if (status === "stock" && total === 0) return false;
    if (status === "out" && total > 0) return false;
    if (status === "low" && !(total > 0 && total <= 2)) return false;
    if (q) {
      const hay = `${i.brand || ""} ${i.model} ${i.size} ${i.colour} ${i.category || ""} ${i.item_code}`.toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    return true;
  });

  const statusBadge = (i: Combined) => {
    const t = i.totalA + i.totalB;
    if (t === 0) return <span className="text-rose-500 text-xs">● Out</span>;
    if (t <= 2) return <span className="text-amber-500 text-xs">● Low</span>;
    return <span className="text-emerald-500 text-xs">● Healthy</span>;
  };

  return (
    <Shell title="Items">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Items</h1>
          <p className="text-sm text-zinc-500 mt-1">{loaded ? `${items.length} products in catalogue` : "Loading..."}</p>
        </div>
        <button className="bg-cyan-500 hover:bg-cyan-400 text-zinc-900 px-3 py-1.5 rounded-md text-sm font-medium flex items-center gap-1.5">
          <Plus className="w-4 h-4" /> New item
        </button>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <div className="flex-1 min-w-[200px] relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search items…"
            className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md pl-9 pr-3 py-1.5 text-sm focus:outline-none focus:border-cyan-500" />
        </div>
        <select value={brand} onChange={(e) => setBrand(e.target.value)}
          className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md px-3 py-1.5 text-sm">
          <option value="">All brands</option>
          {brands.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <select value={cat} onChange={(e) => setCat(e.target.value)}
          className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md px-3 py-1.5 text-sm">
          <option value="">All categories</option>
          {cats.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}
          className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md px-3 py-1.5 text-sm">
          <option value="">All statuses</option>
          <option value="stock">In stock</option>
          <option value="out">Out of stock</option>
          <option value="low">Low (≤2)</option>
        </select>
        <div className="text-xs text-zinc-500 self-center ml-auto">{filtered.length} shown</div>
      </div>

      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 dark:bg-zinc-900/50 border-b border-zinc-200 dark:border-zinc-800">
            <tr className="text-zinc-500 text-[11px] uppercase tracking-wider">
              <th className="text-left px-5 py-2.5 font-medium">Brand</th>
              <th className="text-left px-3 py-2.5 font-medium">Model</th>
              <th className="text-left px-3 py-2.5 font-medium">Size</th>
              <th className="text-left px-3 py-2.5 font-medium">Colour</th>
              <th className="text-right px-3 py-2.5 font-medium">Stock A</th>
              <th className="text-right px-3 py-2.5 font-medium">Stock B</th>
              <th className="text-right px-3 py-2.5 font-medium">Total</th>
              <th className="text-right px-5 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {!loaded && Array.from({ length: 5 }).map((_, idx) => (
              <tr key={idx} className="border-t border-zinc-200/50 dark:border-zinc-800/50">
                {Array.from({ length: 8 }).map((__, j) => (
                  <td key={j} className="px-3 py-3"><div className="h-3 rounded shimmer" /></td>
                ))}
              </tr>
            ))}
            {loaded && filtered.map(i => {
              const c = colourCss(i.colour);
              return (
                <tr key={i.id} className="border-t border-zinc-200/50 dark:border-zinc-800/50 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 cursor-pointer">
                  <td className="px-5 py-2.5">{i.brand
                    ? <span className="bg-cyan-500/15 text-cyan-600 dark:text-cyan-300 px-2 py-0.5 rounded text-[11px]">{i.brand}</span>
                    : <span className="text-zinc-400 text-xs">—</span>}
                  </td>
                  <td className="px-3 py-2.5">{i.model}</td>
                  <td className="px-3 py-2.5 text-zinc-500">{i.size}</td>
                  <td className="px-3 py-2.5">
                    {c
                      ? <span style={{ background: c.bg, color: c.fg }} className="px-2 py-0.5 rounded text-[11px]">{i.colour}</span>
                      : i.colour}
                  </td>
                  <td className="px-3 py-2.5 text-right tnum">{fmtN(i.totalA)}</td>
                  <td className="px-3 py-2.5 text-right tnum">{fmtN(i.totalB)}</td>
                  <td className="px-3 py-2.5 text-right tnum font-semibold">{fmtN(i.totalA + i.totalB)}</td>
                  <td className="px-5 py-2.5 text-right">{statusBadge(i)}</td>
                </tr>
              );
            })}
            {loaded && filtered.length === 0 && (
              <tr><td colSpan={8} className="py-12 text-center text-sm text-zinc-500">No items match your filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
