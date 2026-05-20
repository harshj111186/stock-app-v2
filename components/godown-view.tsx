"use client";
import { Fragment, useEffect, useState, useMemo } from "react";
import {
  Search, ChevronRight, ChevronDown,
  LayoutGrid, Table as TableIcon, Package,
} from "lucide-react";
import { Shell } from "@/components/shell";
import { sb, type Item, type Stock } from "@/lib/supabase";
import { colourCss, fmtN } from "@/lib/utils";

// ─── types ───────────────────────────────────────────────────────────────
type Godown = "A" | "B";
type View = "grid" | "table";
type Depth = 0 | 1 | 2 | 3;

// Item enriched with this godown's stock numbers. `hasStockRow` distinguishes
// "never stocked here" (no godown_stock row) from "ran out" (row exists, qty 0).
type ItemHere = Item & {
  cases: number;
  loose: number;
  total: number;
  hasStockRow: boolean;
};

// ─── grouping helpers ────────────────────────────────────────────────────
const groupVal = (i: ItemHere, level: number): string => {
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
  items?: ItemHere[];   // leaf
  children?: Node[];    // branch
};

function buildTree(items: ItemHere[], depth: number): Node[] {
  if (depth === 0) {
    return [{ key: "__all", label: "All items", count: items.length, items }];
  }
  const recurse = (subset: ItemHere[], level: number, parentKey: string): Node[] => {
    const buckets = new Map<string, ItemHere[]>();
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

// ─── component ───────────────────────────────────────────────────────────
export function GodownView({ godown }: { godown: Godown }) {
  const [items, setItems] = useState<ItemHere[]>([]);
  const [loaded, setLoaded] = useState(false);

  // filters
  const [q, setQ] = useState("");
  const [brand, setBrand] = useState("");
  const [cat, setCat] = useState("");
  const [status, setStatus] = useState(""); // "" | "stock" | "out" | "low" | "never"

  // view + grouping (persisted per-godown so the two pages don't fight each other)
  const [view, setView] = useState<View>("grid");
  const [depth, setDepth] = useState<Depth>(2);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const lsKey = `godown-${godown.toLowerCase()}`;

  // load persisted UI state once
  useEffect(() => {
    try {
      const v = localStorage.getItem(`${lsKey}.view`);
      if (v === "grid" || v === "table") setView(v);
      const d = localStorage.getItem(`${lsKey}.depth`);
      if (d !== null) setDepth(Number(d) as Depth);
      const e = localStorage.getItem(`${lsKey}.expanded`);
      if (e) setExpanded(new Set(JSON.parse(e)));
    } catch { /* ignore */ }
  }, [lsKey]);
  useEffect(() => { try { localStorage.setItem(`${lsKey}.view`, view); } catch {} }, [view, lsKey]);
  useEffect(() => { try { localStorage.setItem(`${lsKey}.depth`, String(depth)); } catch {} }, [depth, lsKey]);
  useEffect(() => { try { localStorage.setItem(`${lsKey}.expanded`, JSON.stringify([...expanded])); } catch {} }, [expanded, lsKey]);

  // ─── load data (filters godown_stock to this warehouse only) ───────────
  useEffect(() => {
    (async () => {
      const c = sb();
      const [{ data: rows }, { data: stock }, { data: cats }] = await Promise.all([
        c.from("items").select("*").order("item_code"),
        c.from("godown_stock").select("*").eq("godown", godown),
        c.from("categories").select("id, name"),
      ]);
      const catMap = new Map<string, string>(
        (cats || []).map((x: any) => [x.id as string, x.name as string])
      );
      const sMap = new Map<string, Stock>();
      (stock || []).forEach((s: any) => sMap.set(s.item_id, s as Stock));

      const combined: ItemHere[] = (rows || []).map((i: any) => {
        const cs = i.case_size || 0;
        const s = sMap.get(i.id);
        const cases = s?.cases ?? 0;
        const loose = s?.loose ?? 0;
        const total = cs > 0 ? cases * cs + loose : loose;
        return {
          ...i,
          // join category name via FK (preferred over the legacy text column)
          category: catMap.get(i.category_id) ?? i.category ?? null,
          cases,
          loose,
          total,
          hasStockRow: !!s,
        };
      });
      setItems(combined);
      setLoaded(true);
    })();
  }, [godown]);

  // ─── derived: filter dropdown sources ──────────────────────────────────
  const brands = useMemo(
    () => [...new Set(items.map(i => i.brand || "").filter(Boolean))].sort(),
    [items]
  );
  const cats = useMemo(
    () => [...new Set(items.map(i => i.category || "").filter(Boolean))].sort(),
    [items]
  );

  // ─── derived: helpers ──────────────────────────────────────────────────
  // Reorder point for THIS godown. Fallback to 2 if both are 0/null.
  const reorderFor = (i: ItemHere) =>
    godown === "A" ? (i.reorder_point_a || 0) : (i.reorder_point_b || 0);

  const statusOf = (i: ItemHere): "never" | "out" | "low" | "ok" => {
    if (!i.hasStockRow) return "never";
    if (i.total === 0) return "out";
    const threshold = Math.max(reorderFor(i), 2);
    if (i.total <= threshold) return "low";
    return "ok";
  };

  // ─── derived: filtered items ───────────────────────────────────────────
  const filtered = useMemo(() => items.filter(i => {
    if (brand && i.brand !== brand) return false;
    if (cat && i.category !== cat) return false;
    const s = statusOf(i);
    if (status === "stock" && (s === "out" || s === "never")) return false;
    if (status === "out" && s !== "out") return false;
    if (status === "low" && s !== "low") return false;
    if (status === "never" && s !== "never") return false;
    if (q) {
      const hay = `${i.brand || ""} ${i.model} ${i.size} ${i.colour} ${i.category || ""} ${i.subcategory || ""} ${i.item_code}`.toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    return true;
  }), [items, q, brand, cat, status, godown]);

  // ─── derived: header stats ─────────────────────────────────────────────
  const stats = useMemo(() => {
    const inStock = filtered.filter(i => i.hasStockRow && i.total > 0);
    return {
      countInStock: inStock.length,
      totalCases: inStock.reduce((s, i) => s + i.cases, 0),
      totalLoose: inStock.reduce((s, i) => s + i.loose, 0),
      totalUnits: inStock.reduce((s, i) => s + i.total, 0),
    };
  }, [filtered]);

  // ─── derived: grouped tree ─────────────────────────────────────────────
  const tree = useMemo(() => buildTree(filtered, depth), [filtered, depth]);

  // ─── expand helpers ────────────────────────────────────────────────────
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

  // ─── render ────────────────────────────────────────────────────────────
  return (
    <Shell title={`Godown ${godown}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Godown {godown}</h1>
          <p className="text-sm text-zinc-500 mt-1 tabular-nums">
            {loaded
              ? <>
                  {fmtN(stats.countInStock)} items in stock ·{" "}
                  <span className="text-zinc-700 dark:text-zinc-300">{fmtN(stats.totalCases)}</span> cases +{" "}
                  <span className="text-zinc-700 dark:text-zinc-300">{fmtN(stats.totalLoose)}</span> loose ={" "}
                  <span className="text-zinc-700 dark:text-zinc-300 font-medium">{fmtN(stats.totalUnits)}</span> units
                </>
              : "Loading…"}
          </p>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap gap-2 mb-4 items-center">
        <div className="flex-1 min-w-[200px] relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
          <input
            value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={`Search items in Godown ${godown}…`}
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
          <option value="low">Low (≤ reorder)</option>
          <option value="out">Out of stock</option>
          <option value="never">Never stocked here</option>
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

      {/* Body */}
      {!loaded ? (
        <Skeleton view={view} />
      ) : filtered.length === 0 ? (
        <Empty godown={godown} />
      ) : view === "grid" ? (
        <GridBody tree={tree} depth={depth} isOpen={isOpen} toggle={toggle} statusOf={statusOf} />
      ) : (
        <TableBody tree={tree} depth={depth} isOpen={isOpen} toggle={toggle} statusOf={statusOf} />
      )}
    </Shell>
  );
}

// ─── grid view ───────────────────────────────────────────────────────────
function GridBody({
  tree, depth, isOpen, toggle, statusOf,
}: {
  tree: Node[];
  depth: number;
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
  statusOf: (i: ItemHere) => "never" | "out" | "low" | "ok";
}) {
  if (depth === 0) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
        {tree[0]?.items?.map(i => <GodownCard key={i.id} item={i} statusOf={statusOf} />)}
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
  statusOf: (i: ItemHere) => "never" | "out" | "low" | "ok";
}) {
  const open = isOpen(node.key);
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
          {node.items.map(i => <GodownCard key={i.id} item={i} statusOf={statusOf} />)}
        </div>
      )}
    </section>
  );
}

// One card per item, scoped to one godown. Carton + loose are ALWAYS shown
// separately — non-negotiable per project rules.
function GodownCard({
  item, statusOf,
}: {
  item: ItemHere;
  statusOf: (i: ItemHere) => "never" | "out" | "low" | "ok";
}) {
  const c = colourCss(item.colour);
  const s = statusOf(item);
  const statusColour =
    s === "never" ? "text-zinc-400 dark:text-zinc-500"
    : s === "out" ? "text-rose-500"
    : s === "low" ? "text-amber-500"
    : "text-emerald-500";
  const statusLabel =
    s === "never" ? "Never stocked"
    : s === "out" ? "Out"
    : s === "low" ? "Low"
    : "Healthy";

  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-3 hover:border-cyan-500/50 hover:shadow-sm dark:hover:shadow-cyan-500/5 transition-all cursor-pointer flex flex-col">
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

      <div className="text-sm font-medium truncate" title={item.model}>{item.model}</div>

      <div className="text-xs text-zinc-500 mb-3 truncate">
        {[item.size, item.colour].filter(Boolean).join(" · ") || "—"}
      </div>

      {/* Carton + loose split + total + status */}
      <div className="mt-auto border-t border-zinc-100 dark:border-zinc-800 pt-2 flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5 tabular-nums">
          {s === "never" ? (
            <span className="text-zinc-400 dark:text-zinc-500 italic">no entry</span>
          ) : (
            <>
              <span className="bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 px-1.5 py-0.5 rounded font-medium">
                {fmtN(item.cases)}c
              </span>
              <span className="bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 px-1.5 py-0.5 rounded font-medium">
                {fmtN(item.loose)}L
              </span>
              <span className="text-zinc-400">=</span>
              <span className="text-zinc-700 dark:text-zinc-200 font-medium">{fmtN(item.total)}</span>
            </>
          )}
        </div>
        <span className={`${statusColour} font-medium`}>● {statusLabel}</span>
      </div>
    </div>
  );
}

// ─── table view (grouped) ────────────────────────────────────────────────
function TableBody({
  tree, depth, isOpen, toggle, statusOf,
}: {
  tree: Node[];
  depth: number;
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
  statusOf: (i: ItemHere) => "never" | "out" | "low" | "ok";
}) {
  const renderItemRow = (i: ItemHere, indent: number) => {
    const c = colourCss(i.colour);
    const s = statusOf(i);
    const statusColour =
      s === "never" ? "text-zinc-400 dark:text-zinc-500"
      : s === "out" ? "text-rose-500"
      : s === "low" ? "text-amber-500"
      : "text-emerald-500";
    const statusLabel =
      s === "never" ? "Never"
      : s === "out" ? "Out"
      : s === "low" ? "Low"
      : "Healthy";

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
        <td className="px-3 py-2.5 text-right tabular-nums">{s === "never" ? "—" : fmtN(i.cases)}</td>
        <td className="px-3 py-2.5 text-right tabular-nums">{s === "never" ? "—" : fmtN(i.loose)}</td>
        <td className="px-3 py-2.5 text-right tabular-nums font-semibold">{s === "never" ? "—" : fmtN(i.total)}</td>
        <td className={`px-5 py-2.5 text-right text-xs ${statusColour} font-medium`}>● {statusLabel}</td>
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
            <th className="text-right px-3 py-2.5 font-medium">Cases</th>
            <th className="text-right px-3 py-2.5 font-medium">Loose</th>
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

// ─── states ──────────────────────────────────────────────────────────────
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

function Empty({ godown }: { godown: Godown }) {
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg py-16 text-center">
      <Package className="w-8 h-8 text-zinc-400 dark:text-zinc-600 mx-auto mb-3" strokeWidth={1.5} />
      <div className="text-sm text-zinc-500">No items in Godown {godown} match your filters.</div>
    </div>
  );
}
