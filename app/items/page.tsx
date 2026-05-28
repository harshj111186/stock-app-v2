"use client";
import { Fragment, useEffect, useState, useMemo, useCallback } from "react";
import {
  Plus, Search, ChevronRight, ChevronDown,
  LayoutGrid, Table as TableIcon, Package,
  Pencil, X, Save, Loader2, AlertCircle,
} from "lucide-react";
import { Shell } from "@/components/shell";
import { useAuth } from "@/app/providers";
import { sb, type Item, type Stock } from "@/lib/supabase";
import { colourCss, fmtN } from "@/lib/utils";
import { ItemFormModal } from "@/components/item-form-modal";
import { pathById, type CatRow } from "@/lib/categories";
import { FilterSheet, SheetField, FilterButton } from "@/components/filter-sheet";

// Combined now also carries raw cases/loose so the override modal can edit them directly.
type Combined = Item & {
  totalA: number; totalB: number;
  casesA: number; looseA: number;
  casesB: number; looseB: number;
};
type View = "grid" | "table";
type Depth = 0 | 1 | 2 | 3;

// ─── group helpers ────────────────────────────────────────────────────────
// Group path per item: Brand, then EACH category-tree segment (so a nested
// category like "Fans › Ceiling › Premium" becomes three expandable levels),
// then Subcategory. `depth` controls how far down we group.
const SEP = "›";
const groupPath = (i: Combined, depth: number): string[] => {
  const out: string[] = [];
  if (depth >= 1) out.push(i.brand || "(No brand)");
  if (depth >= 2) out.push(...(i.category ? i.category.split(" › ") : ["(No category)"]));
  if (depth >= 3) out.push(i.subcategory || "(No subcategory)");
  return out;
};

type Node = {
  key: string;
  label: string;
  count: number;
  items?: Combined[];   // items that live directly at this node
  children?: Node[];    // sub-groups
};

// Builds a tree from each item's variable-length group path. A node can carry
// BOTH children (deeper groups) AND items (things that stop at this level) —
// the grid/table/mobile renderers already handle each independently. With a
// FLAT category list this reproduces exactly the old Brand → Category →
// Subcategory shape; it only nests further once the category tree grows.
function buildTree(items: Combined[], depth: number): Node[] {
  if (depth === 0) {
    return [{ key: "__all", label: "All items", count: items.length, items }];
  }
  const recurse = (subset: Combined[], level: number, parentKey: string): { nodes: Node[]; direct: Combined[] } => {
    const direct: Combined[] = [];
    const buckets = new Map<string, Combined[]>();
    for (const i of subset) {
      const path = groupPath(i, depth);
      if (level >= path.length) { direct.push(i); continue; }
      const v = path[level];
      if (!buckets.has(v)) buckets.set(v, []);
      buckets.get(v)!.push(i);
    }
    const nodes: Node[] = [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, group]) => {
        const key = parentKey ? `${parentKey}${SEP}${label}` : label;
        const sub = recurse(group, level + 1, key);
        return {
          key, label, count: group.length,
          children: sub.nodes.length ? sub.nodes : undefined,
          items: sub.direct.length ? sub.direct : undefined,
        };
      });
    return { nodes, direct };
  };
  return recurse(items, 0, "").nodes;
}

// ─── component ────────────────────────────────────────────────────────────
export default function ItemsPage() {
  const { profile } = useAuth();
  const canWrite = profile?.role === "admin" || profile?.role === "staff";
  const isAdmin = profile?.role === "admin";

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

  // manual override modal
  const [editingItem, setEditingItem] = useState<Combined | null>(null);
  // create / edit-details / archive (admin)
  const [categories, setCategories] = useState<CatRow[]>([]);
  const [creating, setCreating] = useState(false);
  const [editingDetails, setEditingDetails] = useState<Combined | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

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
  // Deep-link filters + actions from the dashboard / command palette
  // (e.g. /items?status=out, ?status=low, ?new=1).
  useEffect(() => {
    try {
      const p = new URLSearchParams(window.location.search);
      const s = p.get("status");
      if (s && ["stock", "out", "low"].includes(s)) setStatus(s);
      const query = p.get("q");
      if (query) setQ(query);
      if (p.get("new") === "1" && isAdmin) setCreating(true);
    } catch { /* ignore */ }
  }, [isAdmin]);
  useEffect(() => { try { localStorage.setItem("items.view", view); } catch {} }, [view]);
  useEffect(() => { try { localStorage.setItem("items.depth", String(depth)); } catch {} }, [depth]);
  useEffect(() => { try { localStorage.setItem("items.expanded", JSON.stringify([...expanded])); } catch {} }, [expanded]);

  // ─── load data ──────────────────────────────────────────────────────────
  // Extracted to a callback so the override modal can refresh after saving.
  const loadData = useCallback(async () => {
    const c = sb();
    const [{ data: rows }, { data: stock }, { data: cats }] = await Promise.all([
      c.from("items").select("*").order("item_code"),
      c.from("godown_stock").select("*"),
      c.from("categories").select("*"),
    ]);
    const catRows: CatRow[] = ((cats || []) as any[]).map(x => ({
      id: x.id, name: x.name, parent_id: x.parent_id ?? null,
      sort_order: x.sort_order ?? 0, archived: x.archived ?? false,
    }));
    setCategories(catRows);
    // Resolve each item's category to its FULL tree path (e.g. "Fans › Ceiling
    // › Premium") so grouping + filters reflect the hierarchy, not just the leaf.
    const catPath = pathById(catRows);
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
        // Prefer category name via FK; fall back to the legacy category text column
        // for any row whose category_id wasn't backfilled. Matches GodownView's
        // resolution so both pages bucket identical items into identical groups.
        category: catPath.get(i.category_id) ?? i.category ?? null,
        totalA: cs > 0 ? a.cases * cs + a.loose : a.loose,
        totalB: cs > 0 ? b.cases * cs + b.loose : b.loose,
        casesA: a.cases || 0, looseA: a.loose || 0,
        casesB: b.cases || 0, looseB: b.loose || 0,
      };
    });
    setItems(combined);
    setLoaded(true);
  }, []);
  useEffect(() => { loadData(); }, [loadData]);

  // open edit modal — only callable when canWrite (button is hidden otherwise)
  const onEdit = useCallback((it: Combined) => setEditingItem(it), []);

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
    // Archived items only appear under the "Archived" status filter.
    if (status === "archived") { if (!i.archived) return false; }
    else if (i.archived) return false;
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
      <div className="flex items-center justify-between mb-6 gap-3">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Items</h1>
          <p className="text-sm text-zinc-500 mt-1">
            {loaded ? `${items.filter(i => !i.archived).length} products in catalogue` : "Loading…"}
          </p>
        </div>
        {isAdmin && (
          <button onClick={() => setCreating(true)} className="bg-cyan-500 hover:bg-cyan-400 text-white px-3 py-1.5 rounded-md text-sm font-medium flex items-center gap-1.5 flex-shrink-0">
            <Plus className="w-4 h-4" /> <span className="hidden sm:inline">New item</span><span className="sm:hidden">New</span>
          </button>
        )}
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

        {/* Mobile: filters live in a bottom sheet to keep the toolbar to one row */}
        <FilterButton activeCount={(brand ? 1 : 0) + (cat ? 1 : 0) + (status ? 1 : 0)} onClick={() => setFiltersOpen(true)} />

        {/* Desktop: inline filters */}
        <div className="hidden md:flex md:flex-wrap md:gap-2 md:items-center">
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
            <option value="archived">Archived</option>
          </select>

          <select value={depth} onChange={(e) => setDepth(Number(e.target.value) as Depth)}
            className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md px-3 py-1.5 text-sm">
            <option value={0}>No grouping</option>
            <option value={1}>Group: Brand</option>
            <option value={2}>Group: Brand · Category</option>
            <option value={3}>Group: Brand · Category · Subcat.</option>
          </select>
        </div>

        {/* View toggle */}
        <div className="flex bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md overflow-hidden flex-shrink-0">
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
          <div className="hidden md:flex items-center gap-1 text-xs">
            <button onClick={expandAll} className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 px-2 py-1">Expand all</button>
            <span className="text-zinc-300 dark:text-zinc-700">·</span>
            <button onClick={collapseAll} className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 px-2 py-1">Collapse all</button>
          </div>
        )}

        <div className="text-xs text-zinc-500 self-center ml-auto tabular-nums">{filtered.length} shown</div>
      </div>

      {/* Mobile filters sheet — keeps the toolbar to one row on phones */}
      <FilterSheet
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        onClear={() => { setBrand(""); setCat(""); setStatus(""); }}
      >
        <SheetField label="Brand">
          <select value={brand} onChange={(e) => setBrand(e.target.value)} className="w-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-cyan-500">
            <option value="">All brands</option>
            {brands.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </SheetField>
        <SheetField label="Category">
          <select value={cat} onChange={(e) => setCat(e.target.value)} className="w-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-cyan-500">
            <option value="">All categories</option>
            {cats.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </SheetField>
        <SheetField label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="w-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-cyan-500">
            <option value="">All statuses</option>
            <option value="stock">In stock</option>
            <option value="out">Out of stock</option>
            <option value="low">Low (≤2)</option>
            <option value="archived">Archived</option>
          </select>
        </SheetField>
        <SheetField label="Grouping">
          <select value={depth} onChange={(e) => setDepth(Number(e.target.value) as Depth)} className="w-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-cyan-500">
            <option value={0}>No grouping</option>
            <option value={1}>Group: Brand</option>
            <option value={2}>Group: Brand · Category</option>
            <option value={3}>Group: Brand · Category · Subcat.</option>
          </select>
        </SheetField>
        {depth > 0 && (
          <div className="flex gap-2">
            <button onClick={expandAll} className="flex-1 border border-zinc-200 dark:border-zinc-700 rounded-md py-2 text-sm text-zinc-600 dark:text-zinc-300">Expand all</button>
            <button onClick={collapseAll} className="flex-1 border border-zinc-200 dark:border-zinc-700 rounded-md py-2 text-sm text-zinc-600 dark:text-zinc-300">Collapse all</button>
          </div>
        )}
      </FilterSheet>

      {/* ─── Body ────────────────────────────────────────────── */}
      {!loaded ? (
        <Skeleton view={view} />
      ) : filtered.length === 0 ? (
        <Empty />
      ) : view === "grid" ? (
        <GridBody tree={tree} depth={depth} isOpen={isOpen} toggle={toggle} statusOf={statusOf} canWrite={canWrite} onEdit={onEdit} />
      ) : (
        <TableBody tree={tree} depth={depth} isOpen={isOpen} toggle={toggle} statusBadge={statusBadge} canWrite={canWrite} onEdit={onEdit} />
      )}

      {/* ─── Manual override modal ───────────────────────────── */}
      {editingItem && (
        <EditStockModal
          item={editingItem}
          isAdmin={isAdmin}
          onClose={() => setEditingItem(null)}
          onSaved={async () => { await loadData(); setEditingItem(null); }}
          onEditDetails={isAdmin ? () => { const it = editingItem; setEditingItem(null); setEditingDetails(it); } : undefined}
        />
      )}

      {/* ─── Create / edit item details (admin) ──────────────── */}
      {creating && (
        <ItemFormModal
          mode="create"
          categories={categories}
          brands={brands}
          onClose={() => setCreating(false)}
          onSaved={async () => { await loadData(); setCreating(false); }}
        />
      )}
      {editingDetails && (
        <ItemFormModal
          mode="edit"
          item={editingDetails}
          categories={categories}
          brands={brands}
          onClose={() => setEditingDetails(null)}
          onSaved={async () => { await loadData(); setEditingDetails(null); }}
        />
      )}
    </Shell>
  );
}

// ─── grid view ────────────────────────────────────────────────────────────
function GridBody({
  tree, depth, isOpen, toggle, statusOf, canWrite, onEdit,
}: {
  tree: Node[];
  depth: number;
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
  statusOf: (i: Combined) => "out" | "low" | "ok";
  canWrite: boolean;
  onEdit: (i: Combined) => void;
}) {
  // When grouping is off, just render one big grid.
  if (depth === 0) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
        {tree[0]?.items?.map(i => <Card key={i.id} item={i} statusOf={statusOf} canWrite={canWrite} onEdit={onEdit} />)}
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {tree.map(node => <GroupSection key={node.key} node={node} level={0} isOpen={isOpen} toggle={toggle} statusOf={statusOf} canWrite={canWrite} onEdit={onEdit} />)}
    </div>
  );
}

function GroupSection({
  node, level, isOpen, toggle, statusOf, canWrite, onEdit,
}: {
  node: Node;
  level: number;
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
  statusOf: (i: Combined) => "out" | "low" | "ok";
  canWrite: boolean;
  onEdit: (i: Combined) => void;
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
            <GroupSection key={c.key} node={c} level={level + 1} isOpen={isOpen} toggle={toggle} statusOf={statusOf} canWrite={canWrite} onEdit={onEdit} />
          ))}
        </div>
      )}
      {open && node.items && (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
          {node.items.map(i => <Card key={i.id} item={i} statusOf={statusOf} canWrite={canWrite} onEdit={onEdit} />)}
        </div>
      )}
    </section>
  );
}

function Card({ item, statusOf, canWrite, onEdit }: {
  item: Combined;
  statusOf: (i: Combined) => "out" | "low" | "ok";
  canWrite: boolean;
  onEdit: (i: Combined) => void;
}) {
  const c = colourCss(item.colour);
  const total = item.totalA + item.totalB;
  const s = statusOf(item);
  const statusColour = s === "out" ? "text-rose-500" : s === "low" ? "text-amber-500" : "text-emerald-500";
  return (
    <div className="group relative bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-3 hover:border-cyan-500/50 hover:shadow-sm dark:hover:shadow-cyan-500/5 transition-all cursor-pointer flex flex-col">
      {/* Manual override edit button (only for admin/staff) — always visible
          on touch so mobile users can find it; hover-reveal kept on md+. */}
      {canWrite && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onEdit(item); }}
          title="Edit stock (manual override)"
          aria-label="Edit stock (manual override)"
          className="absolute top-2 right-2 z-10 p-1.5 rounded-md bg-white/90 dark:bg-zinc-900/90 border border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:text-cyan-600 dark:hover:text-cyan-300 hover:border-cyan-500/50 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity shadow-sm"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
      )}
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
      <div className="text-xs text-zinc-500 mb-1 truncate">
        {[item.size, item.colour].filter(Boolean).join(" · ") || "—"}
      </div>

      {/* Category › Subcategory — shown on every card so categorisation is
          visible even at the "No grouping" depth setting. Subtle grey to keep
          the model as the primary identifier. */}
      {(item.category || item.subcategory) && (
        <div
          className="text-[10px] text-zinc-400 dark:text-zinc-500 mb-3 truncate"
          title={[item.category, item.subcategory].filter(Boolean).join(" › ")}
        >
          {[item.category, item.subcategory].filter(Boolean).join(" › ")}
        </div>
      )}

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
// On md+ this is a real <table>. On mobile it collapses to a stacked card
// list with the same grouping. Both render from the same tree so the toggle
// state and counts stay in sync.
function TableBody({
  tree, depth, isOpen, toggle, statusBadge, canWrite, onEdit,
}: {
  tree: Node[];
  depth: number;
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
  statusBadge: (i: Combined) => React.ReactNode;
  canWrite: boolean;
  onEdit: (i: Combined) => void;
}) {
  // ── mobile card row ────────────────────────────────────────────────────
  const renderMobileItem = (i: Combined) => {
    const total = i.totalA + i.totalB;
    const s = total === 0 ? "out" : total <= 2 ? "low" : "ok";
    const statusColour = s === "out" ? "text-rose-500" : s === "low" ? "text-amber-500" : "text-emerald-500";
    const swatch = colourCss(i.colour);
    return (
      <div key={i.id} className="border-t border-zinc-200/60 dark:border-zinc-800/60 px-4 py-4 active:bg-zinc-50 dark:active:bg-zinc-800/30 flex gap-3">
        {/* Colour swatch chip */}
        <div
          className="w-11 h-11 rounded-xl flex-shrink-0 flex items-center justify-center text-[10px] font-medium"
          style={swatch ? { background: swatch.bg, color: swatch.fg } : undefined}
        >
          {!swatch && <Package className="w-5 h-5 text-zinc-400" strokeWidth={1.5} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {i.brand && (
              <span className="bg-cyan-500/15 text-cyan-600 dark:text-cyan-300 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-medium flex-shrink-0">{i.brand}</span>
            )}
            <span className="text-[15px] font-semibold truncate">{i.model}</span>
          </div>
          <div className="text-xs text-zinc-500 mb-2 truncate">
            {[i.size, i.colour].filter(Boolean).join(" · ") || "—"}
            <span className="text-zinc-400"> · {i.item_code}</span>
          </div>
          <div className="flex items-center justify-between gap-2 text-sm tnum">
            <div className="flex gap-3">
              <span className="text-zinc-500">A <b className="text-zinc-900 dark:text-zinc-100">{fmtN(i.totalA)}</b></span>
              <span className="text-zinc-500">B <b className="text-zinc-900 dark:text-zinc-100">{fmtN(i.totalB)}</b></span>
              <span className={`${statusColour} font-semibold`}>● {fmtN(total)}</span>
            </div>
            {canWrite && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onEdit(i); }}
                className="p-2 -mr-2 rounded text-zinc-400 hover:text-cyan-600 dark:hover:text-cyan-300"
                aria-label="Edit stock (manual override)"
              >
                <Pencil className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  // Flatten tree into a stack of (header | card) entries for mobile.
  const renderMobile = (nodes: Node[], level: number): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    for (const n of nodes) {
      if (depth === 0 && n.items) {
        n.items.forEach(i => out.push(renderMobileItem(i)));
        continue;
      }
      const open = isOpen(n.key);
      out.push(
        <button
          key={`hdr-${n.key}`}
          onClick={() => toggle(n.key)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/50 hover:bg-zinc-100/60 dark:hover:bg-zinc-800/60"
          style={{ paddingLeft: `${level * 12 + 12}px` }}
        >
          {open ? <ChevronDown className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />}
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300 truncate">{n.label}</span>
          <span className="text-[10px] bg-zinc-200/70 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 px-1.5 py-0.5 rounded tabular-nums ml-auto flex-shrink-0">{n.count}</span>
        </button>
      );
      if (open) {
        if (n.children) out.push(...renderMobile(n.children, level + 1));
        if (n.items) n.items.forEach(i => out.push(renderMobileItem(i)));
      }
    }
    return out;
  };

  const renderItemRow = (i: Combined, indent: number) => {
    const c = colourCss(i.colour);
    return (
      <tr key={i.id} className="group border-t border-zinc-200/50 dark:border-zinc-800/50 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 cursor-pointer">
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
        <td className="px-3 py-2.5 text-right">{statusBadge(i)}</td>
        <td className="px-5 py-2.5 text-right w-10">
          {canWrite && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onEdit(i); }}
              title="Edit stock (manual override)"
              aria-label="Edit stock (manual override)"
              className="p-1 rounded text-zinc-400 hover:text-cyan-600 dark:hover:text-cyan-300 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
        </td>
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
          <td colSpan={9} className="px-3 py-2">
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
    <>
      {/* Desktop / tablet table */}
      <div className="hidden md:block bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
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
              <th className="text-right px-3 py-2.5 font-medium">Status</th>
              <th className="px-5 py-2.5 font-medium w-10" aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {tree.map(n => renderNode(n, 0))}
          </tbody>
        </table>
      </div>
      {/* Mobile card stack */}
      <div className="md:hidden bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden shadow-sm">
        {renderMobile(tree, 0)}
      </div>
    </>
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

// ─── manual stock-override modal ──────────────────────────────────────────
// Lets the user fix discrepancies between system stock and physical count.
// Writes one or two Adjustment transactions (one per godown that changed)
// via process_transaction() so the audit trail is intact. Case size
// (which lives on the items table, not godown_stock) is updated separately
// via a plain UPDATE — admin only, because of items-table RLS.
function EditStockModal({
  item, isAdmin, onClose, onSaved, onEditDetails,
}: {
  item: Combined;
  isAdmin: boolean;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onEditDetails?: () => void;
}) {
  const oldCs = item.case_size || 0;
  const [cs, setCs] = useState(String(oldCs));
  const [aCases, setACases] = useState(String(item.casesA));
  const [aLoose, setALoose] = useState(String(item.looseA));
  const [bCases, setBCases] = useState(String(item.casesB));
  const [bLoose, setBLoose] = useState(String(item.looseB));
  const [reason, setReason] = useState("count correction");
  const [reasonOther, setReasonOther] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // numeric parsings (default 0 on empty / NaN)
  const csN = Math.max(0, Number(cs || 0) | 0);
  const aCN = Math.max(0, Number(aCases || 0) | 0);
  const aLN = Math.max(0, Number(aLoose || 0) | 0);
  const bCN = Math.max(0, Number(bCases || 0) | 0);
  const bLN = Math.max(0, Number(bLoose || 0) | 0);

  // Total physical units, before and after
  const oldATotal = oldCs > 0 ? item.casesA * oldCs + item.looseA : item.looseA;
  const oldBTotal = oldCs > 0 ? item.casesB * oldCs + item.looseB : item.looseB;
  const newATotal = csN > 0 ? aCN * csN + aLN : aLN;
  const newBTotal = csN > 0 ? bCN * csN + bLN : bLN;
  const deltaA = newATotal - oldATotal;
  const deltaB = newBTotal - oldBTotal;
  const csChanged = csN !== oldCs;
  const nothingChanged = !csChanged && deltaA === 0 && deltaB === 0;

  // chosen reason text to write to the ledger
  const reasonText = reason === "other" ? reasonOther.trim() : reason;

  const onlyDigits = (s: string) => s.replace(/[^\d]/g, "");

  async function save() {
    if (nothingChanged) { setError("Nothing to save — change at least one value."); return; }
    if (!reasonText) { setError("Please provide a reason."); return; }
    if (csChanged && !isAdmin) {
      setError("Only admins can change case size. Ask an admin, or untouch the case size field.");
      return;
    }

    setError(null);
    setSaving(true);
    try {
      const c = sb();
      const today = new Date().toISOString().slice(0, 10);

      // 1) Update case_size on items if it changed. Done first so the
      //    Adjustment calls split the new total using the new case size.
      let effectiveCs = oldCs;
      if (csChanged) {
        const { error: e1 } = await c.from("items").update({ case_size: csN }).eq("id", item.id);
        if (e1) throw e1;
        effectiveCs = csN;
      }

      // 2) Refresh godown_stock RIGHT NOW so deltas come from the real
      //    current state, not whatever the items page loaded earlier.
      //    Without this, reconciliation runs (or any other write since
      //    the page loaded) leave the modal showing stale numbers and
      //    process_transaction errors with "Insufficient stock at
      //    godown X (have N, need M)" because its server-side check
      //    sees the fresher value.
      const { data: freshStock, error: fsErr } = await c
        .from("godown_stock")
        .select("godown, cases, loose")
        .eq("item_id", item.id);
      if (fsErr) throw fsErr;
      const freshA = freshStock?.find((s: any) => s.godown === "A") ?? { cases: 0, loose: 0 };
      const freshB = freshStock?.find((s: any) => s.godown === "B") ?? { cases: 0, loose: 0 };

      const freshOldA = effectiveCs > 0 ? freshA.cases * effectiveCs + freshA.loose : freshA.loose;
      const freshOldB = effectiveCs > 0 ? freshB.cases * effectiveCs + freshB.loose : freshB.loose;
      const newA = effectiveCs > 0 ? aCN * effectiveCs + aLN : aLN;
      const newB = effectiveCs > 0 ? bCN * effectiveCs + bLN : bLN;
      const dA = newA - freshOldA;
      const dB = newB - freshOldB;

      // 3) Adjustment txns for the piece-level delta — gives the audit
      //    log a row. process_transaction also moves godown_stock, but
      //    step 4 below will override its cases/loose split with the
      //    exact values the user typed.
      if (dA !== 0) {
        const { error: eA } = await c.rpc("process_transaction", {
          p_item_id: item.id,
          p_action: "Adjustment",
          p_godown: "A",
          p_qty: Math.abs(dA),
          p_date: today,
          p_note: reasonText,
          p_direction: dA > 0 ? 1 : -1,
        });
        if (eA) throw eA;
      }
      if (dB !== 0) {
        const { error: eB } = await c.rpc("process_transaction", {
          p_item_id: item.id,
          p_action: "Adjustment",
          p_godown: "B",
          p_qty: Math.abs(dB),
          p_date: today,
          p_note: reasonText,
          p_direction: dB > 0 ? 1 : -1,
        });
        if (eB) throw eB;
      }

      // 4) Force the cases/loose split to exactly what was typed.
      //    Fires for any godown the user touched (or whose totals
      //    shifted due to a case-size change). godown_stock RLS blocks
      //    direct client writes, so we go through the SECURITY DEFINER
      //    RPC.
      const aTouched = aCN !== item.casesA || aLN !== item.looseA || csChanged;
      const bTouched = bCN !== item.casesB || bLN !== item.looseB || csChanged;
      if (aTouched) {
        const { error: eSA } = await c.rpc("reconcile_stock_split", {
          p_item_id: item.id, p_godown: "A", p_cases: aCN, p_loose: aLN,
        });
        if (eSA) throw eSA;
      }
      if (bTouched) {
        const { error: eSB } = await c.rpc("reconcile_stock_split", {
          p_item_id: item.id, p_godown: "B", p_cases: bCN, p_loose: bLN,
        });
        if (eSB) throw eSB;
      }

      await onSaved();
    } catch (e: any) {
      setError(e?.message || "Failed to save override.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 dark:bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Manual stock override"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-zinc-900 rounded-t-2xl sm:rounded-lg w-full max-w-2xl shadow-2xl border border-zinc-200 dark:border-zinc-800 flex flex-col max-h-[95vh] sm:max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800 flex items-start justify-between gap-4 flex-shrink-0">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">Manual stock override</h2>
            <p className="text-xs text-zinc-500 mt-0.5 truncate">
              {item.brand && <span>{item.brand} · </span>}{item.model} · {item.size} · {item.colour}
              <span className="text-zinc-400"> · {item.item_code}</span>
            </p>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {onEditDetails && (
              <button
                type="button"
                onClick={onEditDetails}
                className="text-xs text-cyan-600 dark:text-cyan-400 hover:bg-cyan-500/10 rounded-md px-2 py-1 inline-flex items-center gap-1 whitespace-nowrap"
              >
                <Pencil className="w-3.5 h-3.5" /> Edit details
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 p-1"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body — scrolls within the modal so header+footer stay anchored */}
        <div className="p-5 space-y-5 overflow-y-auto flex-1">
          <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-md p-3 text-[12px] text-amber-800 dark:text-amber-200 leading-relaxed">
            Use this only to <b>fix discrepancies</b> between the system and the actual physical count.
            For everyday Purchase / Sale / Transfer, use the Transactions page instead.
            Saving here writes an <b>Adjustment</b> entry per godown so the audit log is preserved.
          </div>

          {/* Case size */}
          <div>
            <Label>Case size (units per carton)</Label>
            <NumInput value={cs} onChange={(v) => setCs(onlyDigits(v))} disabled={!isAdmin} />
            {!isAdmin && (
              <div className="text-[11px] text-zinc-500 mt-1">Admin only — sign in as admin to edit.</div>
            )}
            {csChanged && isAdmin && (
              <div className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">
                Changing case size from <b>{oldCs}</b> to <b>{csN}</b>. The carton counts below are interpreted with the <b>new</b> value.
              </div>
            )}
          </div>

          {/* Godown A + B */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <GodownBlock
              label="Stock A"
              casesValue={aCases} setCases={(v) => setACases(onlyDigits(v))}
              looseValue={aLoose} setLoose={(v) => setALoose(onlyDigits(v))}
              oldTotal={oldATotal} newTotal={newATotal} delta={deltaA} cs={csN}
              casesN={aCN} looseN={aLN}
            />
            <GodownBlock
              label="Stock B"
              casesValue={bCases} setCases={(v) => setBCases(onlyDigits(v))}
              looseValue={bLoose} setLoose={(v) => setBLoose(onlyDigits(v))}
              oldTotal={oldBTotal} newTotal={newBTotal} delta={deltaB} cs={csN}
              casesN={bCN} looseN={bLN}
            />
          </div>

          {/* Reason */}
          <div>
            <Label>Reason (saved to the audit log)</Label>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-cyan-500"
            >
              <option value="count correction">Count correction</option>
              <option value="damage">Damage</option>
              <option value="lost">Lost</option>
              <option value="found">Found</option>
              <option value="theft">Theft</option>
              <option value="data-entry fix">Data-entry fix</option>
              <option value="other">Other…</option>
            </select>
            {reason === "other" && (
              <input
                type="text"
                placeholder="Describe the reason…"
                value={reasonOther}
                onChange={(e) => setReasonOther(e.target.value)}
                className="mt-2 w-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-cyan-500"
              />
            )}
          </div>

          {error && (
            <div className="text-sm text-rose-600 dark:text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-md p-2.5 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="px-5 py-3 border-t border-zinc-200 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-3 bg-zinc-50 dark:bg-zinc-900/50 rounded-b-none sm:rounded-b-lg flex-shrink-0"
          style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
        >
          <div className="text-[11px] text-zinc-500 w-full sm:w-auto sm:flex-1 min-w-0">
            {nothingChanged
              ? "No changes yet."
              : `Will write ${[csChanged && "case-size update", deltaA !== 0 && "A adjustment", deltaB !== 0 && "B adjustment"].filter(Boolean).join(" + ")}.`}
          </div>
          <div className="flex gap-2 ml-auto">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 text-sm text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded-md"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving || nothingChanged}
              className="bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed text-white px-3.5 py-2 rounded-md text-sm font-medium flex items-center gap-1.5"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {saving ? "Saving…" : "Save override"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function GodownBlock({
  label, casesValue, setCases, looseValue, setLoose,
  oldTotal, newTotal, delta, cs, casesN, looseN,
}: {
  label: string;
  casesValue: string; setCases: (v: string) => void;
  looseValue: string; setLoose: (v: string) => void;
  oldTotal: number; newTotal: number; delta: number; cs: number;
  casesN: number; looseN: number;
}) {
  const deltaCls = delta > 0
    ? "text-emerald-600 dark:text-emerald-400"
    : delta < 0
    ? "text-rose-500"
    : "text-zinc-500";
  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-md p-4 space-y-3">
      <div className="text-sm font-medium">{label}</div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Cartons</Label>
          <NumInput value={casesValue} onChange={setCases} />
        </div>
        <div>
          <Label>Loose</Label>
          <NumInput value={looseValue} onChange={setLoose} />
        </div>
      </div>
      <div className="text-[11px] text-zinc-500 pt-2 border-t border-zinc-100 dark:border-zinc-800 space-y-0.5">
        <div>In system: <b className="tnum text-zinc-700 dark:text-zinc-200">{fmtN(oldTotal)}</b> units</div>
        <div>
          New target: <b className="tnum text-zinc-700 dark:text-zinc-200">{fmtN(newTotal)}</b> units
          {cs > 0 && <span className="text-zinc-400"> ({casesN}×{cs} + {looseN})</span>}
        </div>
        <div>
          Delta: <b className={`tnum ${deltaCls}`}>{delta > 0 ? "+" : ""}{fmtN(delta)}</b>
        </div>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-medium mb-1.5">{children}</div>;
}

function NumInput({
  value, onChange, disabled,
}: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <input
      type="number"
      min="0"
      inputMode="numeric"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="w-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-cyan-500 tnum disabled:opacity-50 disabled:cursor-not-allowed"
    />
  );
}
