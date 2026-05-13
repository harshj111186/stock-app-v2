"use client";
import { Fragment, useEffect, useState, useMemo } from "react";
import {
  Plus, Search, ChevronRight, ChevronDown,
  LayoutGrid, Table as TableIcon, Package,
} from "lucide-react";
import { Shell } from "@/components/shell";
import { sb, type Item, type Stock } from "@/lib/supabase";
import { colourCss, fmtN } from "@/lib/utils";

type Combined = Item & { totalA: number; totalB: number };
type View = "grid" | "table";
type Depth = 0 | 1 | 2 | 3;

// ─── group helpers ────────────────────────────────────────────────────────
// Level 0 = Brand, level 1 = Category, level 2 = Subcategory.
const groupVal = (i: Combined, level: number): string => {
  if (level === 0) return i.brand || "(No brand)";
  if (level === 1) return i.category || "(No category)";
  if (level === 2) return i.subcategory || "(No subcategory)";
  return "";
};
const SEP = "›";

type Node = {
  key: string;
  label: string;
  count: number;
  items?: Combined[];   // leaf
  children?: Node[];    // branch
};

function buildTree(items: Combined[], depth: number): Node[] {
  if (depth === 0) {
    return [{ key: "__all", label: "All items", count: items.length, items }];
  }
  const recurse = (subset: Combined[], level: number, parentKey: string): Node[] => {
    const buckets = new Map<string, Combined[]>();
    for (const i of subset) {
      const v = groupVal(i, level);
      if (!buckets.has(v)) buckets.set(v, []);
      buckets.get(v)!.push(i);
    }
    return [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, group]) => {
        const key = parentKey ? `${parentKey}${SEP}${label}` : label;
        if (level + 1 < depth) {
          return { key, label, count: group.length, children: recurse(group, level + 1, key) };
        }
        return { key, label, count: group.length, items: group };
      });
  };
  return recurse(items, 0, "");
}

// ─── component ────────────────────────────────────────────────────────────
export default function ItemsPage() {
  const [items, setItems] = useState<Combined[]>([]);
  const [loaded, setLoaded] = useState(false);

  // filters
  const [q, setQ] = useState("");
  const [brand, setBrand] = useState("");
  const [cat, setCat] = useState("");
  const [status, setStatus] = useState("");

  // view + grouping
  const [view, setView] = useState<View>("grid");
  const [depth, setDepth] = useState<Depth>(2);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // ─── load persisted UI state once ───────────────────────────────────────
  useEffect(() => {
    try {
      const v = localStorage.getItem("items.view");
      if (v === "grid" || v === "table") setView(v);
      const d = localStorage.getItem("items.depth");
      if (d !== null) setDepth(Number(d) as Depth);
      const e = localStorage.getItem("items.expanded");
      if (e) setExpanded(new Set(JSON.parse(e)));
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { try { localStorage.setItem("items.view", view); } catch {} }, [view]);
  useEffect(() => { try { localStorage.setItem("items.depth", String(depth)); } catch {} }, [depth]);
  useEffect(() => { try { localStorage.setItem("items.expanded", JSON.stringify([...expanded])); } catch {} }, [expanded]);

  // ─── load data ──────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const c = sb();
      const [{ data: rows }, { data: stock }, { data: cats }] = await Promise.all([
        c.from("items").select("*").order("item_code"),
        c.from("godown_stock").select("*"),
        c.from("categories").select("id, name"),
      ]);
      const catMap = new Map<string, string>(
        (cats || []).map((x: any) => [x.id as string, x.name as string])
      );
      const sMap: Record<string, { A: Stock; B: Stock }> = {};
      (stock || []).forEach((s: any) => {
        sMap[s.item_id] = sMap[s.item_id] || {
          A: { item_id: s.item_id, godown: "A", cases: 0, loose: 0 },
          B: { item_id: s.item_id, godown: "B", cases: 0, loose: 0 },
        };
        sMap[s.item_id][s.godown as "A" | "B"] = s as Stock;
      });
      const combined: Combined[] = (rows || []).map((i: any) => {
        const cs = i.case_size || 0;
        const a = sMap[i.id]?.A || { cases: 0, loose: 0 };
        const b = sMap[i.id]?.B || { cases: 0, loose: 0 };
        return {
          ...i,
          category: catMap.get(i.category_id) ?? null,
          totalA: cs > 0 ? a.cases * cs + a.loose : a.loose,
          totalB: cs > 0 ? b.cases * cs + b.loose : b.loose,
        };
      });
      setItems(combined);
      setLoaded(true);
    })();
  }, []);

  // ─── derived: filter dropdown sources ───────────────────────────────────
  const brands = useMemo(
    () => [...new Set(items.map(i => i.brand || "").filter(Boolean))].sort(),
    [items]
  );
  const cats = useMemo(
    () => [...new Set(items.map(i => i.category || "").filter(Boolean))].sort(),
    [items]
  );

  // ─── derived: filtered items ────────────────────────────────────────────
  const filtered = useMemo(() => items.filter(i => {
    if (brand && i.brand !== brand) return false;
    if (cat && i.category !== cat) return false;
    const total = i.totalA + i.totalB;
    if (status === "stock" && total === 0) return false;
    if (status === "out" && total > 0) return false;
    if (status === "low" && !(total > 0 && total <= 2)) return false;
    if (q) {
      const hay = `${i.brand || ""} ${i.model} ${i.size} ${i.colour} ${i.category || ""} ${i.subcategory || ""} ${i.item_code}`.toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    return true;
  }), [items, q, brand, cat, status]);

  // ─── derived: grouped tree ──────────────────────────────────────────────
  const tree = useMemo(() => buildTree(filtered, depth), [filtered, depth]);

  // ─── expand helpers ─────────────────────────────────────────────────────
  // Searching auto-expands all matches so nothing stays hidden.
  const searching = q.trim().length > 0;
  const isOpen = (key: string) => searching || expanded.has(key);
  const toggle = (key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };
  const allKeys = useMemo(() => {
    const out = new Set<string>();
    const walk = (nodes: Node[]) => {
      for (const n of nodes) {
        out.add(n.key);
        if (n.children) walk(n.children);
      }
    };
    walk(tree);
    return out;
  }, [tree]);
  const expandAll = () => setExpanded(new Set(allKeys));
  const collapseAll = () => setExpanded(new Set());

  // ─── render helpers ─────────────────────────────────────────────────────
  const statusOf = (i: Combined): "out" | "low" | "ok" => {
    const t = i.totalA + i.totalB;
    if (t === 0) return "out";
    if (t <= 2) return "low";
    return "ok";
  };
  const statusBadge = (i: Combined) => {
    const s = statusOf(i);
    return s === "out" ? <span className="text-rose-500 text-xs">● Out</span>
      : s === "low" ? <span className="text-amber-500 text-xs">● Low</span>
      : <span className="text-emerald-500 text-xs">● Healthy</span>;
  };

  return (
    <Shell title="Items">
      {/* ─── Header ──────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Items</h1>
          <p className="text-sm text-zinc-500 mt-1">
            {loaded ? `${items.length} products in catalogue` : "Loading…"}
          </p>
        </div>
        <button className="bg-cyan-500 hover:bg-cyan-400 text-zinc-900 px-3 py-1.5 rounded-md text-sm font-medium flex items-center gap-1.5">
          <Plus className="w-4 h-4" /> New item
        </button>
      </div>

      {/* ─── Toolbar ─────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2 mb-4 items-center">
        <div className="flex-1 min-w-[200px] relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
          <input
            value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search items…"
            className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md pl-9 pr-3 py-1.5 text-sm focus:outline-none focus:border-cyan-500"
          />
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

        <select value={depth} onChange={(e) => setDepth(Number(e.target.value) as Depth)}
          className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md px-3 py-1.5 text-sm">
          <option value={0}>No grouping</option>
          <option value={1}>Group: Brand</option>
          <option value={2}>Group: Brand · Category</option>
          <option value={3}>Group: Brand · Category · Subcat.</option>
        </select>

        {/* View toggle */}
        <div className="flex bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md overflow-hidden">
          <button
            onClick={() => setView("grid")}
            className={`px-2.5 py-1.5 ${view === "grid" ? "bg-cyan-500/15 text-cyan-600 dark:text-cyan-300" : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200"}`}
            aria-label="Grid view"
            title="Grid view"
          >
            <LayoutGrid className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setView("table")}
            className={`px-2.5 py-1.5 border-l border-zinc-200 dark:border-zinc-800 ${view === "table" ? "bg-cyan-500/15 text-cyan-600 dark:text-cyan-300" : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200"}`}
            aria-label="Table view"
            title="Table view"
          >
            <TableIcon className="w-3.5 h-3.5" />
          </button>
        </div>

        {depth > 0 && (
          <div className="flex items-center gap-1 text-xs">
            <button onClick={expandAll} className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 px-2 py-1">Expand all</button>
            <span className="text-zinc-300 dark:text-zinc-700">·</span>
            <button onClick={collapseAll} className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 px-2 py-1">Collapse all</button>
          </div>
        )}

        <div className="text-xs text-zinc-500 self-center ml-auto tabular-nums">{filtered.length} shown</div>
      </div>

      {/* ─── Body ────────────────────────────────────────────── */}
      {!loaded ? (
        <Skeleton view={view} />
      ) : filtered.length === 0 ? (
        <Empty />
      ) : view === "grid" ? (
        <GridBody tree={tree} depth={depth} isOpen={isOpen} toggle={toggle} statusOf={statusOf} />
      ) : (
        <TableBody tree={tree} depth={depth} isOpen={isOpen} toggle={toggle} statusBadge={statusBadge} />
      )}
    </Shell>
  );
}

// ─── grid view ────────────────────────────────────────────────────────────
function GridBody({
  tree, depth, isOpen, toggle, statusOf,
}: {
  tree: Node[];
  depth: number;
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
  statusOf: (i: Combined) => "out" | "low" | "ok";
}) {
  // When grouping is off, just render one big grid.
  if (depth === 0) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
        {tree[0]?.items?.map(i => <Card key={i.id} item={i} statusOf={statusOf} />)}
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {tree.map(node => <GroupSection key={node.key} node={node} level={0} isOpen={isOpen} toggle={toggle} statusOf={statusOf} />)}
    </div>
  );
}

function GroupSection({
  node, level, isOpen, toggle, statusOf,
}: {
  node: Node;
  level: number;
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
  statusOf: (i: Combined) => "out" | "low" | "ok";
}) {
  const open = isOpen(node.key);
  // Heading sizes scale down with level.
  const headingClass =
    level === 0 ? "text-base font-semibold"
    : level === 1 ? "text-sm font-medium text-zinc-700 dark:text-zinc-300"
    : "text-xs font-medium text-zinc-500 uppercase tracking-wider";
  return (
    <section style={{ paddingLeft: level === 0 ? 0 : `${level * 12}px` }}>
      <button
        onClick={() => toggle(node.key)}
        className="w-full flex items-center gap-2 mb-3 group"
      >
        {open
          ? <ChevronDown className="w-4 h-4 text-zinc-500 group-hover:text-zinc-700 dark:group-hover:text-zinc-200" />
          : <ChevronRight className="w-4 h-4 text-zinc-500 group-hover:text-zinc-700 dark:group-hover:text-zinc-200" />}
        <h2 className={headingClass}>{node.label}</h2>
        <span className="text-[10px] bg-zinc-200/70 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 px-1.5 py-0.5 rounded tabular-nums">{node.count}</span>
        {level === 0 && <div className="flex-1 ml-2 border-b border-zinc-200 dark:border-zinc-800/60" />}
      </button>

      {open && node.children && (
        <div className="space-y-5">
          {node.children.map(c => (
            <GroupSection key={c.key} node={c} level={level + 1} isOpen={isOpen} toggle={toggle} statusOf={statusOf} />
          ))}
        </div>
      )}
      {open && node.items && (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
          {node.items.map(i => <Card key={i.id} item={i} statusOf={statusOf} />)}
        </div>
      )}
    </section>
  );
}

function Card({ item, statusOf }: { item: Combined; statusOf: (i: Combined) => "out" | "low" | "ok" }) {
  const c = colourCss(item.colour);
  const total = item.totalA + item.totalB;
  const s = statusOf(item);
  const statusColour = s === "out" ? "text-rose-500" : s === "low" ? "text-amber-500" : "text-emerald-500";
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-3 hover:border-cyan-500/50 hover:shadow-sm dark:hover:shadow-cyan-500/5 transition-all cursor-pointer flex flex-col">
      {/* Colour-derived header strip; falls back to a neutral gradient */}
      <div
        className="aspect-[5/2] rounded-md mb-3 flex items-center justify-center relative overflow-hidden"
        style={c ? { background: c.bg } : undefined}
      >
        {!c && (
          <div className="absolute inset-0 bg-gradient-to-br from-zinc-100 to-zinc-200 dark:from-zinc-800 dark:to-zinc-900 flex items-center justify-center">
            <Package className="w-6 h-6 text-zinc-400 dark:text-zinc-600" strokeWidth={1.5} />
          </div>
        )}
      </div>

      {/* Brand chip + Item code (small) */}
      <div className="flex items-center justify-between mb-1.5">
        {item.brand ? (
          <span className="bg-cyan-500/15 text-cyan-600 dark:text-cyan-300 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-medium">
            {item.brand}
          </span>
        ) : (
          <span className="text-zinc-400 text-[10px] italic">no brand</span>
        )}
        <span className="text-[10px] text-zinc-400 tabular-nums">{item.item_code}</span>
      </div>

      {/* Model */}
      <div className="text-sm font-medium truncate" title={item.model}>{item.model}</div>

      {/* Size · Colour */}
      <div className="text-xs text-zinc-500 mb-3 truncate">
        {[item.size, item.colour].filter(Boolean).join(" · ") || "—"}
      </div>

      {/* Footer: stock + status */}
      <div className="mt-auto flex items-center justify-between text-xs border-t border-zinc-100 dark:border-zinc-800 pt-2">
        <div className="flex gap-3 tabular-nums">
          <span className="text-zinc-500">
            A <span className="text-zinc-700 dark:text-zinc-200 font-medium">{fmtN(item.totalA)}</span>
          </span>
          <span className="text-zinc-500">
            B <span className="text-zinc-700 dark:text-zinc-200 font-medium">{fmtN(item.totalB)}</span>
          </span>
        </div>
        <span className={`${statusColour} font-medium tabular-nums`}>● {fmtN(total)}</span>
      </div>
    </div>
  );
}

// ─── table view (grouped) ─────────────────────────────────────────────────
function TableBody({
  tree, depth, isOpen, toggle, statusBadge,
}: {
  tree: Node[];
  depth: number;
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
  statusBadge: (i: Combined) => React.ReactNode;
}) {
  const renderItemRow = (i: Combined, indent: number) => {
    const c = colourCss(i.colour);
    return (
      <tr key={i.id} className="border-t border-zinc-200/50 dark:border-zinc-800/50 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 cursor-pointer">
        <td className="px-5 py-2.5" style={{ paddingLeft: `${indent * 16 + 20}px` }}>
          {i.brand
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
  };

  const renderNode = (n: Node, level: number): React.ReactNode => {
    const open = isOpen(n.key);
    if (depth === 0 && n.items) {
      return n.items.map(i => renderItemRow(i, 0));
    }
    return (
      <Fragment key={n.key}>
        <tr className="bg-zinc-50/50 dark:bg-zinc-900/50 border-t border-zinc-200 dark:border-zinc-800 select-none">
          <td colSpan={8} className="px-3 py-2">
            <button
              onClick={() => toggle(n.key)}
              className="w-full flex items-center gap-2 text-left hover:bg-zinc-100/60 dark:hover:bg-zinc-800/60 -mx-3 px-3 py-1 rounded transition-colors"
              style={{ paddingLeft: `${level * 16 + 12}px` }}
            >
              {open
                ? <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
                : <ChevronRight className="w-3.5 h-3.5 text-zinc-500" />}
              <span className="text-xs font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">{n.label}</span>
              <span className="text-[10px] bg-zinc-200/70 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 px-1.5 py-0.5 rounded tabular-nums">{n.count}</span>
            </button>
          </td>
        </tr>
        {open && n.children && n.children.map(child => renderNode(child, level + 1))}
        {open && n.items && n.items.map(i => renderItemRow(i, level + 1))}
      </Fragment>
    );
  };

  return (
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
          {tree.map(n => renderNode(n, 0))}
        </tbody>
      </table>
    </div>
  );
}

// ─── states ───────────────────────────────────────────────────────────────
function Skeleton({ view }: { view: View }) {
  if (view === "grid") {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-3">
            <div className="aspect-[5/2] rounded-md shimmer mb-3" />
            <div className="h-3 rounded shimmer w-1/3 mb-2" />
            <div className="h-4 rounded shimmer w-3/4 mb-2" />
            <div className="h-3 rounded shimmer w-1/2" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden p-5 space-y-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-4 rounded shimmer" style={{ width: `${50 + (i * 7) % 50}%` }} />
      ))}
    </div>
  );
}

function Empty() {
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg py-16 text-center">
      <Package className="w-8 h-8 text-zinc-400 dark:text-zinc-600 mx-auto mb-3" strokeWidth={1.5} />
      <div className="text-sm text-zinc-500">No items match your filters.</div>
    </div>
  );
}
