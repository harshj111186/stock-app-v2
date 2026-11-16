"use client";
// Items — the stock list, rebuilt 2026-11-16.
//
// One screen for /items, /godown-a and /godown-b:
//   • left (computer): the category tree — tap a category to see what is in
//     it and everything below it; admins add / rename / move / delete
//     categories right there and drag items onto a category to move them.
//     On a phone the same tree opens from the "Categories" button, and the
//     sub-categories of where you are show as one-tap chips.
//   • right: one clean row per item — name, then brand · size · colour, then
//     the pieces in Godown A, Godown B and the total. No cards, no banners.
//     Tap a row for everything about the item (stock, details, last movements,
//     correct the count, edit, move, add a similar one).
//   • "Select" picks several items to move to another category in one go
//     (with Undo).
// Stock is only ever written by the count-correction modal (unchanged
// apply_reconciliation calls) and the add-item form's optional opening count.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Plus, AlertCircle, ListChecks, X, FolderTree, ChevronRight, Folder, FolderInput, Search, Check, Package, SlidersHorizontal, Undo2,
} from "lucide-react";
import { Shell } from "@/components/shell";
import { useAuth } from "@/app/providers";
import { sb, fetchAllRows, type Item, type Stock } from "@/lib/supabase";
import { cn, colourCss, fmtN, matchesQuery, lowThresholdCombined, lowThresholdGodown, stockStatus } from "@/lib/utils";
import {
  buildCategoryTree, flattenTree, pathById, descendantIds, rollupCounts, ancestorChain, toCatRow, type CatRow,
} from "@/lib/categories";
import { CategoryTree, ALL, NONE, ITEM_DRAG } from "@/components/category-tree";
import { CategoryPickerSheet } from "@/components/category-picker";
import { ItemFormModal, type ItemPreset } from "@/components/item-form-modal";
import { EditStockModal } from "@/components/edit-stock-modal";
import { ItemDrawer } from "@/components/item-drawer";
import { useEscape, useMediaQuery } from "@/lib/hooks";

type Godown = "A" | "B";
type GView = "both" | Godown;
type Status = "" | "stock" | "low" | "out" | "archived";
type Row = Item & {
  casesA: number; looseA: number; casesB: number; looseB: number;
  totalA: number; totalB: number; hasA: boolean; hasB: boolean;
  catPath: string | null; catLive: boolean; order: number;
};

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function ItemsView({ godown: fixedGodown }: { godown?: Godown }) {
  const { profile } = useAuth();
  const canWrite = profile?.role === "admin" || profile?.role === "staff";
  const isAdmin = profile?.role === "admin";
  const wide = useMediaQuery("(min-width: 1024px)");
  const pageKey = fixedGodown ? `godown-${fixedGodown.toLowerCase()}` : "items";

  const [rows, setRows] = useState<Row[]>([]);
  const [cats, setCats] = useState<CatRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selCat, setSelCat] = useState<string>(ALL);
  const [q, setQ] = useState("");
  const [brand, setBrand] = useState("");
  const [status, setStatus] = useState<Status>("");
  const [gview, setGview] = useState<GView>(fixedGodown ?? "both");

  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState<ItemPreset | null>(null);
  const [moveIds, setMoveIds] = useState<string[] | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "bad"; text: string; undo?: () => void } | null>(null);
  const [justAdded, setJustAdded] = useState<Set<string>>(new Set());
  const toastTimer = useRef<number | null>(null);

  const notify = useCallback((kind: "ok" | "bad", text: string, undo?: () => void) => {
    setToast({ kind, text, undo });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), undo ? 8000 : 4500);
  }, []);

  // ─── remembered + deep-linked state ───────────────────────────────────
  const restored = useRef(false);
  useEffect(() => {
    try {
      const p = new URLSearchParams(window.location.search);
      const s = p.get("status");
      const query = p.get("q");
      const c = p.get("cat");
      if (s && ["stock", "out", "low"].includes(s)) setStatus(s as Status);
      if (query) setQ(query);
      if (c) setSelCat(c);
      else if (!s && !query) {
        const saved = localStorage.getItem(`${pageKey}.cat`);
        if (saved) setSelCat(saved);
      }
      if (!fixedGodown) {
        const g = localStorage.getItem("items.gview");
        if (g === "A" || g === "B" || g === "both") setGview(g);
      }
    } catch { /* ignore */ }
    restored.current = true;
  }, [pageKey, fixedGodown]);
  useEffect(() => { if (restored.current) try { localStorage.setItem(`${pageKey}.cat`, selCat); } catch { /* ignore */ } }, [selCat, pageKey]);
  useEffect(() => { if (restored.current && !fixedGodown) try { localStorage.setItem("items.gview", gview); } catch { /* ignore */ } }, [gview, fixedGodown]);
  useEffect(() => {
    try { if (new URLSearchParams(window.location.search).get("new") === "1" && isAdmin) setCreating({}); } catch { /* ignore */ }
  }, [isAdmin]);

  // ─── load ─────────────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    const c = sb();
    const [itemsRes, stockRes, catsRes] = await Promise.all([
      fetchAllRows<Item>((f, t) => c.from("items").select("*").order("item_code").order("id").range(f, t)),
      fetchAllRows<Stock>((f, t) => c.from("godown_stock").select("*").order("item_id").order("godown").range(f, t)),
      c.from("categories").select("*"),
    ]);
    const err = itemsRes.error || stockRes.error || catsRes.error?.message || null;
    if (err) { setLoadError(err); setLoaded(true); return; }
    setLoadError(null);
    const catRows = ((catsRes.data || []) as any[]).map(toCatRow);
    setCats(catRows);
    const paths = pathById(catRows);
    const live = new Set(catRows.filter(r => !r.archived).map(r => r.id));
    const order = new Map(flattenTree(buildCategoryTree(catRows, true)).map((n, i) => [n.id, i]));
    const sMap = new Map<string, { A?: Stock; B?: Stock }>();
    for (const s of stockRes.rows) {
      const e = sMap.get(s.item_id) ?? {};
      e[s.godown as Godown] = s;
      sMap.set(s.item_id, e);
    }
    setRows(itemsRes.rows.map((i) => {
      const cs = i.case_size || 0;
      const a = sMap.get(i.id)?.A, b = sMap.get(i.id)?.B;
      const ca = a?.cases ?? 0, la = a?.loose ?? 0, cb = b?.cases ?? 0, lb = b?.loose ?? 0;
      return {
        ...i,
        casesA: ca, looseA: la, casesB: cb, looseB: lb,
        totalA: cs > 0 ? ca * cs + la : la,
        totalB: cs > 0 ? cb * cs + lb : lb,
        hasA: !!a, hasB: !!b,
        catPath: i.category_id ? paths.get(i.category_id) ?? i.category ?? null : i.category ?? null,
        catLive: !!i.category_id && live.has(i.category_id),
        // Items in a deleted (archived) category count as "No category" and sort
        // with it — one heading, not several scattered through the list.
        order: i.category_id && live.has(i.category_id) ? order.get(i.category_id) ?? 1e6 : 1e7,
      };
    }));
    setLoaded(true);
  }, []);
  useEffect(() => { void loadData(); }, [loadData]);

  // A remembered category that no longer exists falls back to All items.
  useEffect(() => {
    if (!loaded || loadError || selCat === ALL || selCat === NONE) return;
    if (!cats.some(c => c.id === selCat && !c.archived)) setSelCat(ALL);
  }, [loaded, loadError, cats, selCat]);

  // ─── status (the ONE shared rule — lib/utils) ─────────────────────────
  const totalOf = useCallback((r: Row) => gview === "A" ? r.totalA : gview === "B" ? r.totalB : r.totalA + r.totalB, [gview]);
  const statusOf = useCallback((r: Row): "never" | "out" | "low" | "ok" => {
    const has = gview === "A" ? r.hasA : gview === "B" ? r.hasB : r.hasA || r.hasB;
    const t = totalOf(r);
    if (!has && t === 0) return "never";
    const thr = gview === "both" ? lowThresholdCombined(r) : lowThresholdGodown(r, gview);
    return stockStatus(t, thr);
  }, [gview, totalOf]);

  // ─── filters ─────────────────────────────────────────────────────────
  const brands = useMemo(() => {
    const n = new Map<string, number>();
    for (const r of rows) if (!r.archived && r.brand) n.set(r.brand, (n.get(r.brand) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([b]) => b);
  }, [rows]);

  // Everything except the category filter — drives the tree's counts.
  const preCat = useMemo(() => rows.filter(r => {
    if (status === "archived" ? !r.archived : r.archived) return false;
    if (brand && r.brand !== brand) return false;
    if (status === "stock" && totalOf(r) <= 0) return false;
    if (status === "low" && statusOf(r) !== "low") return false;
    if (status === "out" && statusOf(r) !== "out") return false;
    if (q && !matchesQuery(`${r.brand || ""} ${r.model} ${r.size} ${r.colour} ${r.catPath || ""} ${r.item_code}`, q)) return false;
    return true;
  }), [rows, status, brand, q, totalOf, statusOf]);

  const inCat = useMemo(() => {
    if (selCat === ALL) return null;
    if (selCat === NONE) return "none" as const;
    return descendantIds(cats, selCat);
  }, [selCat, cats]);

  const visible = useMemo(() => {
    const list = preCat.filter(r => inCat === null ? true : inCat === "none" ? !r.catLive : r.catLive && inCat.has(r.category_id!));
    return list.sort((a, b) =>
      a.order - b.order
      || collator.compare(a.brand || "", b.brand || "")
      || collator.compare(a.model, b.model)
      || collator.compare(a.size || "", b.size || "")
      || collator.compare(a.colour || "", b.colour || ""));
  }, [preCat, inCat]);

  const directCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of preCat) if (r.catLive && r.category_id) m.set(r.category_id, (m.get(r.category_id) ?? 0) + 1);
    return m;
  }, [preCat]);
  const counts = useMemo(() => rollupCounts(cats, directCounts), [cats, directCounts]);
  const uncategorised = useMemo(() => preCat.filter(r => !r.catLive).length, [preCat]);

  const statusCounts = useMemo(() => {
    const base = rows.filter(r => !r.archived && (!brand || r.brand === brand)
      && (inCat === null ? true : inCat === "none" ? !r.catLive : r.catLive && inCat.has(r.category_id!)));
    return {
      all: base.length,
      stock: base.filter(r => totalOf(r) > 0).length,
      low: base.filter(r => statusOf(r) === "low").length,
      out: base.filter(r => statusOf(r) === "out").length,
      archived: rows.filter(r => r.archived).length,
    };
  }, [rows, brand, inCat, totalOf, statusOf]);

  // Selections never outlive the list that showed them.
  useEffect(() => {
    setSelected(prev => {
      if (!prev.size) return prev;
      const ids = new Set(visible.map(r => r.id));
      const next = new Set([...prev].filter(id => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [visible]);

  // ─── sections: one per category, in tree order ────────────────────────
  const selChain = useMemo(() => (selCat !== ALL && selCat !== NONE ? ancestorChain(cats, selCat) : []), [cats, selCat]);
  const sections = useMemo(() => {
    const out: { key: string; label: string[]; rows: Row[] }[] = [];
    const depth = selChain.length;
    for (const r of visible) {
      const key = r.catLive ? r.category_id! : "__none";
      let sec = out[out.length - 1];
      if (!sec || sec.key !== key) {
        const segs = r.catLive && r.catPath ? r.catPath.split(" › ") : ["No category"];
        sec = { key, label: depth && r.catLive ? segs.slice(depth - 1) : segs, rows: [] };
        out.push(sec);
      }
      sec.rows.push(r);
    }
    return out;
  }, [visible, selChain]);

  const children = useMemo(() => {
    const parent = selCat === ALL ? null : selCat === NONE ? undefined : selCat;
    if (parent === undefined) return [];
    return cats.filter(c => !c.archived && (c.parent_id ?? null) === parent)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || collator.compare(a.name, b.name));
  }, [cats, selCat]);

  const headline = useMemo(() => {
    const live = rows.filter(r => !r.archived);
    const pcsA = live.reduce((s, r) => s + r.totalA, 0), pcsB = live.reduce((s, r) => s + r.totalB, 0);
    return { items: live.length, pcsA, pcsB, inStock: live.filter(r => totalOf(r) > 0).length };
  }, [rows, totalOf]);

  // ─── actions ─────────────────────────────────────────────────────────
  const byId = useMemo(() => new Map(rows.map(r => [r.id, r])), [rows]);
  const paths = useMemo(() => pathById(cats), [cats]);

  const moveItems = useCallback(async (ids: string[], target: string | null) => {
    const before = new Map<string | null, string[]>();
    for (const id of ids) {
      const r = byId.get(id);
      const k = r?.category_id ?? null;
      before.set(k, [...(before.get(k) ?? []), id]);
    }
    const { error } = await sb().rpc("set_items_category", { p_item_ids: ids, p_category_id: target });
    if (error) { notify("bad", error.message || "Could not move the items."); return; }
    await loadData();
    setSelected(new Set());
    const where = target ? paths.get(target) ?? "the category" : "No category";
    notify("ok", `Moved ${ids.length} item${ids.length === 1 ? "" : "s"} to ${where}.`, async () => {
      for (const [cat, list] of before) {
        const { error: e } = await sb().rpc("set_items_category", { p_item_ids: list, p_category_id: cat });
        if (e) { await loadData(); notify("bad", `Could not move them all back: ${e.message}`); return; }
      }
      await loadData();
      notify("ok", "Moved back.");
    });
  }, [byId, loadData, notify, paths]);

  const toggleSel = (id: string) => setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const exitSelect = () => { setSelectMode(false); setSelected(new Set()); };
  const pickCat = (id: string) => { setSelCat(id); setTreeOpen(false); };
  const clearFilters = () => { setQ(""); setBrand(""); setStatus(""); };

  const drawerRow = drawerId ? byId.get(drawerId) : undefined;
  const correctingRow = correctingId ? byId.get(correctingId) : undefined;
  const editingRow = editingId ? byId.get(editingId) : undefined;
  const presetCat = selCat !== ALL && selCat !== NONE ? selCat : null;

  const title = fixedGodown ? `Godown ${fixedGodown}` : "Items";
  const filterCount = (brand ? 1 : 0) + (status ? 1 : 0) + (!fixedGodown && gview !== "both" ? 1 : 0);
  const crumbs = selChain;
  const here = selCat === ALL ? "All items" : selCat === NONE ? "No category" : crumbs[crumbs.length - 1]?.name ?? "…";

  const tree = (
    <CategoryTree mode="browse" rows={cats} counts={counts} totalCount={preCat.length} uncategorisedCount={uncategorised}
      selected={selCat} onSelect={pickCat} isAdmin={isAdmin} onChanged={loadData} notify={notify}
      onDropItems={(cat, ids) => void moveItems(ids, cat)} storageKey={`${pageKey}.tree`} />
  );

  // ─── render ───────────────────────────────────────────────────────────
  return (
    <Shell title={title}>
      <div className="lg:grid lg:grid-cols-[264px_minmax(0,1fr)] lg:gap-7">
        {/* Category tree (computer) */}
        <aside className="hidden lg:block sticky top-0 self-start max-h-[calc(100vh-7rem)] overflow-y-auto -ml-2 pr-1 pb-6">
          <div className="flex items-center justify-between px-2 pb-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Categories</h2>
          </div>
          {loaded ? tree : <TreeSkeleton />}
        </aside>

        <div className="min-w-0">
          {/* Header */}
          <div className="flex items-start justify-between gap-3 mb-4">
            <div className="min-w-0">
              <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">{title}</h1>
              <p className="text-sm text-zinc-500 mt-0.5 tabular-nums">
                {!loaded ? "Loading…" : fixedGodown
                  ? `${fmtN(headline.inStock)} items in stock · ${fmtN(fixedGodown === "A" ? headline.pcsA : headline.pcsB)} pcs`
                  : `${fmtN(headline.items)} items · ${fmtN(headline.pcsA + headline.pcsB)} pcs (A ${fmtN(headline.pcsA)} · B ${fmtN(headline.pcsB)})`}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {isAdmin && (
                <button type="button" onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
                  className={cn("h-9 px-3 rounded-md text-sm border inline-flex items-center gap-1.5 transition-colors",
                    selectMode ? "bg-cyan-500/15 border-cyan-500/50 text-cyan-700 dark:text-cyan-300" : "bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:border-cyan-500/40")}>
                  <ListChecks className="w-4 h-4" /> <span className="hidden sm:inline">{selectMode ? "Cancel" : "Select"}</span>
                </button>
              )}
              {isAdmin && (
                <button type="button" onClick={() => setCreating({ category_id: presetCat })}
                  className="hidden sm:inline-flex h-9 px-3.5 rounded-md bg-cyan-500 hover:bg-cyan-400 text-white text-sm font-medium items-center gap-1.5">
                  <Plus className="w-4 h-4" /> Add item
                </button>
              )}
            </div>
          </div>

          {loadError && (
            <div className="text-sm text-rose-600 dark:text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-md p-2.5 mb-4 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">Couldn’t load items — {loadError}</span>
              <button type="button" onClick={() => loadData()} className="ml-auto shrink-0 underline underline-offset-2 font-medium">Retry</button>
            </div>
          )}

          {/* Toolbar — sticks while scrolling */}
          <div className="sticky top-0 z-20 -mx-4 sm:-mx-6 md:-mx-8 lg:mx-0 px-4 sm:px-6 md:px-8 lg:px-0 pt-1 pb-3 bg-zinc-50 dark:bg-zinc-950">
            <div className="flex gap-2 items-center">
              <div className="relative flex-1 min-w-0">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400 pointer-events-none" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, colour, size, code…" aria-label="Search items"
                  className="w-full h-10 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg pl-9 pr-9 text-[15px] sm:text-sm focus:outline-none focus:border-cyan-500" />
                {q && (
                  <button type="button" onClick={() => setQ("")} aria-label="Clear search" className="absolute right-1.5 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center text-zinc-400 hover:text-zinc-700"><X className="w-4 h-4" /></button>
                )}
              </div>
              {/* Desktop filters */}
              <select value={brand} onChange={(e) => setBrand(e.target.value)} aria-label="Brand"
                className="hidden md:block h-10 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg px-3 text-sm focus:outline-none focus:border-cyan-500 max-w-[180px]">
                <option value="">All brands</option>
                {brands.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
              {!fixedGodown && (
                <Segmented className="hidden md:inline-flex" value={gview} onChange={(v) => setGview(v as GView)}
                  options={[{ v: "both", l: "Both" }, { v: "A", l: "Godown A" }, { v: "B", l: "Godown B" }]} />
              )}
              <button type="button" onClick={() => setFiltersOpen(true)} aria-label="Filters"
                className={cn("md:hidden h-10 px-3 rounded-lg border inline-flex items-center gap-1.5 text-sm flex-shrink-0",
                  filterCount ? "bg-cyan-500/15 border-cyan-500/50 text-cyan-700 dark:text-cyan-300" : "bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300")}>
                <SlidersHorizontal className="w-4 h-4" />
                {filterCount > 0 && <span className="tabular-nums">{filterCount}</span>}
              </button>
            </div>

            <div className="mt-2.5 flex items-center gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1">
              {([["", "All", statusCounts.all], ["stock", "In stock", statusCounts.stock], ["low", "Low", statusCounts.low], ["out", "Out", statusCounts.out]] as [Status, string, number][]).map(([v, l, n]) => (
                <Chip key={l} active={status === v} onClick={() => setStatus(v)} tone={v === "low" ? "amber" : v === "out" ? "rose" : undefined}>
                  {l} <span className="tabular-nums opacity-70">{fmtN(n)}</span>
                </Chip>
              ))}
              {statusCounts.archived > 0 && (
                <Chip active={status === "archived"} onClick={() => setStatus(status === "archived" ? "" : "archived")}>Archived <span className="tabular-nums opacity-70">{statusCounts.archived}</span></Chip>
              )}
            </div>
          </div>

          {/* Where am I (phone/tablet): breadcrumb + sub-category chips */}
          <div className="lg:hidden mb-3">
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setTreeOpen(true)}
                className="h-9 px-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-sm inline-flex items-center gap-1.5 flex-shrink-0">
                <FolderTree className="w-4 h-4 text-cyan-600" /> Categories
              </button>
              <nav aria-label="Category path" className="flex items-center gap-1 min-w-0 overflow-x-auto no-scrollbar text-sm">
                <button type="button" onClick={() => setSelCat(ALL)} className={cn("flex-shrink-0 px-1 py-1", selCat === ALL ? "font-semibold" : "text-cyan-700 dark:text-cyan-300")}>All</button>
                {selCat === NONE && <><ChevronRight className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" /><span className="font-semibold flex-shrink-0">No category</span></>}
                {crumbs.map((c, i) => (
                  <Fragment key={c.id}>
                    <ChevronRight className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />
                    <button type="button" onClick={() => setSelCat(c.id)} className={cn("flex-shrink-0 px-1 py-1 whitespace-nowrap", i === crumbs.length - 1 ? "font-semibold" : "text-cyan-700 dark:text-cyan-300")}>{c.name}</button>
                  </Fragment>
                ))}
              </nav>
            </div>
            {children.length > 0 && (
              <div className="mt-2.5 flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1 pb-0.5">
                {children.map(c => (
                  <button key={c.id} type="button" onClick={() => setSelCat(c.id)}
                    className="flex-shrink-0 h-9 pl-2.5 pr-3 rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-sm inline-flex items-center gap-1.5">
                    <Folder className="w-4 h-4 text-cyan-500/80" /> {c.name} <span className="text-[11px] text-zinc-400 tabular-nums">{fmtN(counts.get(c.id) ?? 0)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Where am I (computer) */}
          <div className="hidden lg:flex items-baseline gap-2 mb-3 min-w-0">
            <h2 className="text-base font-semibold truncate">{here}</h2>
            {crumbs.length > 1 && <span className="text-xs text-zinc-500 truncate">in {crumbs.slice(0, -1).map(c => c.name).join(" › ")}</span>}
            <span className="text-xs text-zinc-400 tabular-nums flex-shrink-0">· {fmtN(visible.length)} shown</span>
          </div>

          {q && selCat !== ALL && (
            <div className="mb-3 text-[13px] text-zinc-600 dark:text-zinc-300 bg-cyan-500/5 border border-cyan-500/20 rounded-lg px-3 py-2 flex items-center gap-2">
              <Search className="w-4 h-4 text-cyan-600 flex-shrink-0" />
              <span className="flex-1 min-w-0">Searching only in <b>{here}</b>.</span>
              <button type="button" onClick={() => setSelCat(ALL)} className="text-cyan-700 dark:text-cyan-300 font-medium flex-shrink-0">Search all items</button>
            </div>
          )}

          {/* List */}
          {!loaded ? (
            <ListSkeleton />
          ) : visible.length === 0 ? (
            <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl py-14 px-6 text-center">
              <Package className="w-8 h-8 text-zinc-300 dark:text-zinc-600 mx-auto mb-3" strokeWidth={1.5} />
              <div className="text-sm text-zinc-600 dark:text-zinc-300">{q || brand || status ? "Nothing matches these filters." : selCat === ALL ? "No items yet." : `Nothing in ${here} yet.`}</div>
              <div className="mt-3 flex items-center justify-center gap-4 text-sm">
                {(q || brand || status) && <button type="button" onClick={clearFilters} className="text-cyan-700 dark:text-cyan-300 font-medium">Clear filters</button>}
                {isAdmin && !(q || brand || status) && <button type="button" onClick={() => setCreating({ category_id: presetCat })} className="text-cyan-700 dark:text-cyan-300 font-medium inline-flex items-center gap-1"><Plus className="w-4 h-4" /> Add an item here</button>}
              </div>
            </div>
          ) : (
            <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden">
              <ColumnHead gview={gview} selectMode={selectMode} allSelected={visible.length > 0 && visible.every(r => selected.has(r.id))}
                onSelectAll={() => setSelected(prev => visible.every(r => prev.has(r.id)) ? new Set() : new Set(visible.map(r => r.id)))} />
              {sections.map((sec) => (
                <section key={sec.key} aria-label={sec.label.join(" › ")}>
                  {(sections.length > 1 || selCat === ALL || sec.key !== selCat) && (
                    <div className="flex items-center gap-2 px-4 py-2 bg-zinc-50 dark:bg-zinc-900/60 border-t first:border-t-0 border-zinc-200 dark:border-zinc-800 text-[12px]">
                      <Folder className="w-3.5 h-3.5 text-cyan-500/80 flex-shrink-0" />
                      <span className="truncate text-zinc-500">
                        {sec.label.slice(0, -1).map(s => s + " › ")}
                        <b className="text-zinc-800 dark:text-zinc-200 font-semibold">{sec.label[sec.label.length - 1]}</b>
                      </span>
                      <span className="text-zinc-400 tabular-nums">{sec.rows.length}</span>
                    </div>
                  )}
                  {sec.rows.map(r => (
                    <ItemRow key={r.id} r={r} gview={gview} status={statusOf(r)} selectMode={selectMode} selected={selected.has(r.id)}
                      flash={justAdded.has(r.id)} draggable={isAdmin && wide}
                      onOpen={() => (selectMode ? toggleSel(r.id) : setDrawerId(r.id))}
                      onDragStart={(e) => {
                        const ids = selected.has(r.id) ? [...selected] : [r.id];
                        e.dataTransfer.setData(ITEM_DRAG, JSON.stringify(ids));
                        e.dataTransfer.effectAllowed = "move";
                      }} />
                  ))}
                </section>
              ))}
            </div>
          )}
          {loaded && visible.length > 0 && (
            <p className="mt-3 text-center text-xs text-zinc-400 tabular-nums">{fmtN(visible.length)} item{visible.length === 1 ? "" : "s"}</p>
          )}
          {isAdmin && <div className="h-16 sm:hidden" aria-hidden />}
        </div>
      </div>

      {/* Phone: add button */}
      {isAdmin && !selectMode && (
        <button type="button" onClick={() => setCreating({ category_id: presetCat })} aria-label="Add item"
          className="sm:hidden fixed right-4 z-30 h-12 pl-4 pr-5 rounded-full bg-cyan-500 active:bg-cyan-600 text-white shadow-lg inline-flex items-center gap-1.5 text-sm font-semibold"
          style={{ bottom: "calc(4.75rem + env(safe-area-inset-bottom))" }}>
          <Plus className="w-5 h-5" /> Add item
        </button>
      )}

      {/* Select bar */}
      {selectMode && (
        <div className="fixed inset-x-0 z-40 flex justify-center px-3 pointer-events-none bottom-[calc(4.5rem_+_env(safe-area-inset-bottom))] md:bottom-6">
          <div className="pointer-events-auto flex items-center gap-1.5 bg-zinc-900 dark:bg-zinc-800 text-white rounded-full shadow-xl border border-white/10 pl-4 pr-1.5 py-1.5">
            <span className="text-sm tabular-nums whitespace-nowrap mr-1">{selected.size} selected</span>
            <button type="button" onClick={() => setSelected(new Set(visible.map(r => r.id)))} className="px-2.5 py-1.5 text-sm text-zinc-300 hover:text-white rounded-full whitespace-nowrap">All {visible.length}</button>
            <button type="button" disabled={!selected.size} onClick={() => setMoveIds([...selected])}
              className="inline-flex items-center gap-1.5 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 text-white px-3.5 py-1.5 rounded-full text-sm font-medium whitespace-nowrap">
              <FolderInput className="w-4 h-4" /> Move to…
            </button>
            <button type="button" onClick={exitSelect} aria-label="Stop selecting" className="w-8 h-8 flex items-center justify-center text-zinc-300 hover:text-white rounded-full"><X className="w-4 h-4" /></button>
          </div>
        </div>
      )}

      {/* Phone: category tree sheet */}
      {treeOpen && (
        <Sheet title="Categories" onClose={() => setTreeOpen(false)}>{tree}</Sheet>
      )}

      {/* Phone: filters sheet */}
      {filtersOpen && (
        <Sheet title="Filters" onClose={() => setFiltersOpen(false)}
          footer={<button type="button" onClick={() => setFiltersOpen(false)} className="w-full h-11 rounded-lg bg-cyan-500 text-white text-sm font-medium">Show {fmtN(visible.length)} items</button>}>
          <div className="space-y-5 p-1">
            <div>
              <div className="text-[13px] font-medium mb-2">Brand</div>
              <div className="flex flex-wrap gap-1.5">
                <Chip active={!brand} onClick={() => setBrand("")}>All brands</Chip>
                {brands.map(b => <Chip key={b} active={brand === b} onClick={() => setBrand(b)}>{b}</Chip>)}
              </div>
            </div>
            {!fixedGodown && (
              <div>
                <div className="text-[13px] font-medium mb-2">Show stock of</div>
                <Segmented value={gview} onChange={(v) => setGview(v as GView)} options={[{ v: "both", l: "Both" }, { v: "A", l: "Godown A" }, { v: "B", l: "Godown B" }]} />
              </div>
            )}
            {filterCount > 0 && <button type="button" onClick={() => { setBrand(""); setStatus(""); if (!fixedGodown) setGview("both"); }} className="text-sm text-rose-600">Clear filters</button>}
          </div>
        </Sheet>
      )}

      {/* Item panel + its actions */}
      {drawerRow && (
        <ItemDrawer
          item={{ ...drawerRow, categoryPath: drawerRow.catPath }}
          canWrite={canWrite} isAdmin={isAdmin}
          onClose={() => setDrawerId(null)}
          onCorrect={() => setCorrectingId(drawerRow.id)}
          onEdit={() => setEditingId(drawerRow.id)}
          onMove={() => setMoveIds([drawerRow.id])}
          onDuplicate={() => setCreating({
            category_id: drawerRow.category_id, brand: drawerRow.brand, model: drawerRow.model, size: drawerRow.size,
            case_size: drawerRow.case_size, hsn_code: drawerRow.hsn_code, gst_rate: drawerRow.gst_rate,
            reorder_point_a: drawerRow.reorder_point_a, reorder_point_b: drawerRow.reorder_point_b,
          })}
        />
      )}
      {correctingRow && (
        <EditStockModal item={correctingRow} isAdmin={isAdmin} onClose={() => setCorrectingId(null)} onPartial={() => void loadData()}
          onSaved={async () => { await loadData(); setCorrectingId(null); notify("ok", "Count saved."); }} />
      )}
      {editingRow && (
        <ItemFormModal mode="edit" item={editingRow} stockTotal={editingRow.totalA + editingRow.totalB}
          categories={cats} brands={brands} existing={rows} onCategoriesChange={setCats}
          onClose={() => setEditingId(null)}
          onSaved={async () => { await loadData(); setEditingId(null); notify("ok", "Saved."); }} />
      )}
      {creating && (
        <ItemFormModal mode="create" preset={creating} categories={cats} brands={brands} existing={rows} onCategoriesChange={setCats}
          onClose={() => setCreating(null)}
          onSaved={async (ids, opts) => {
            await loadData();
            if (ids?.length) {
              setJustAdded(new Set(ids));
              setTimeout(() => setJustAdded(new Set()), 4000);
              notify("ok", ids.length === 1 ? "Item added." : `${ids.length} items added.`);
            }
            if (!opts?.keepOpen) setCreating(null);
          }} />
      )}
      <CategoryPickerSheet open={!!moveIds} onClose={() => setMoveIds(null)} rows={cats}
        value={moveIds && moveIds.length === 1 ? byId.get(moveIds[0])?.category_id ?? null : null}
        title={moveIds ? `Move ${moveIds.length === 1 ? `“${byId.get(moveIds[0])?.model ?? "item"}”` : `${moveIds.length} items`} to…` : ""}
        noneLabel="No category" counts={counts} canCreate={isAdmin} onRowsChange={setCats}
        onPick={(target) => { const ids = moveIds; setMoveIds(null); if (ids) void moveItems(ids, target); }} />

      {toast && (
        <div role="status" aria-live="polite"
          className="fixed left-1/2 -translate-x-1/2 z-[70] max-w-[92vw] flex items-center gap-3 pl-4 pr-2 py-2 rounded-xl shadow-lg text-sm bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 animate-slide-up bottom-[calc(5rem_+_env(safe-area-inset-bottom))] md:bottom-6">
          {toast.kind === "ok" ? <Check className="w-4 h-4 text-emerald-400 dark:text-emerald-600 flex-shrink-0" /> : <AlertCircle className="w-4 h-4 text-rose-400 dark:text-rose-600 flex-shrink-0" />}
          <span className="min-w-0">{toast.text}</span>
          {toast.undo && (
            <button type="button" onClick={() => { const u = toast.undo; setToast(null); u?.(); }} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md font-medium text-cyan-300 dark:text-cyan-700 hover:bg-white/10">
              <Undo2 className="w-4 h-4" /> Undo
            </button>
          )}
          <button type="button" onClick={() => setToast(null)} aria-label="Dismiss" className="w-7 h-7 flex items-center justify-center opacity-60 hover:opacity-100"><X className="w-4 h-4" /></button>
        </div>
      )}
    </Shell>
  );
}

// ─── pieces ──────────────────────────────────────────────────────────────
const COLS_BOTH = "grid-cols-[minmax(0,1fr)_96px_96px_96px]";
const COLS_ONE = "grid-cols-[minmax(0,1fr)_84px_84px_96px]";

function ColumnHead({ gview, selectMode, allSelected, onSelectAll }: { gview: GView; selectMode: boolean; allSelected: boolean; onSelectAll: () => void }) {
  return (
    <div className={cn("hidden sm:grid items-center gap-2 px-4 h-9 text-[11px] font-medium uppercase tracking-wider text-zinc-500 border-b border-zinc-200 dark:border-zinc-800", gview === "both" ? COLS_BOTH : COLS_ONE)}>
      <div className="flex items-center gap-3">
        {selectMode && <Box checked={allSelected} onClick={onSelectAll} label="Select all shown" />}
        Item
      </div>
      {gview === "both" ? (
        <>
          <div className="text-right text-cyan-700 dark:text-cyan-300">Godown A</div>
          <div className="text-right text-teal-700 dark:text-teal-300">Godown B</div>
          <div className="text-right">Total</div>
        </>
      ) : (
        <>
          <div className="text-right">Cases</div>
          <div className="text-right">Loose</div>
          <div className={cn("text-right", gview === "A" ? "text-cyan-700 dark:text-cyan-300" : "text-teal-700 dark:text-teal-300")}>Pieces</div>
        </>
      )}
    </div>
  );
}

function ItemRow({ r, gview, status, selectMode, selected, flash, draggable, onOpen, onDragStart }: {
  r: Row; gview: GView; status: "never" | "out" | "low" | "ok"; selectMode: boolean; selected: boolean; flash: boolean;
  draggable: boolean; onOpen: () => void; onDragStart: (e: React.DragEvent) => void;
}) {
  const sw = colourCss(r.colour);
  const cs = r.case_size || 0;
  const tone = status === "out" ? "text-rose-600 dark:text-rose-400" : status === "low" ? "text-amber-600 dark:text-amber-400" : status === "never" ? "text-zinc-400" : "";
  const split = (cases: number, loose: number) => (cs > 0 && cases > 0 ? `${fmtN(cases)}×${cs}${loose ? ` + ${fmtN(loose)}` : ""}` : "");
  const total = gview === "A" ? r.totalA : gview === "B" ? r.totalB : r.totalA + r.totalB;
  const name = (
    <div className="min-w-0">
      <div className="text-[15px] sm:text-sm font-medium leading-snug line-clamp-2 sm:truncate">{r.model}</div>
      <div className="text-[12px] text-zinc-500 truncate">
        {[r.brand, r.size, r.colour].filter(Boolean).join(" · ") || "—"}
        {status === "low" && <span className="ml-1.5 text-amber-600 dark:text-amber-400 font-medium">· Low</span>}
        {status === "out" && <span className="ml-1.5 text-rose-600 dark:text-rose-400 font-medium">· Out</span>}
        {r.archived && <span className="ml-1.5 text-amber-600">· Archived</span>}
      </div>
    </div>
  );
  const swatch = <span className="w-2.5 h-9 rounded-full flex-shrink-0 border border-black/5 dark:border-white/10" style={{ background: sw?.bg ?? "transparent" }} aria-hidden />;
  const gCases = gview === "A" ? r.casesA : r.casesB, gLoose = gview === "A" ? r.looseA : r.looseB;
  return (
    <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      draggable={draggable} onDragStart={onDragStart}
      className={cn("px-4 py-2.5 border-t border-zinc-100 dark:border-zinc-800/70 cursor-pointer transition-colors",
        selected ? "bg-cyan-500/10" : "hover:bg-zinc-50 dark:hover:bg-zinc-800/40 active:bg-zinc-100 dark:active:bg-zinc-800/60",
        flash && "bg-emerald-500/10")}>
      {/* Phone: name on the left (two lines allowed), stock on the right */}
      <div className="flex items-center gap-3 sm:hidden">
        {selectMode && <Box checked={selected} label={`Select ${r.model}`} />}
        {swatch}
        <div className="flex-1 min-w-0">{name}</div>
        <div className="text-right flex-shrink-0 tabular-nums">
          <div className={cn("text-[17px] font-semibold leading-tight", tone)}>{fmtN(total)}</div>
          <div className="text-[12px] text-zinc-500 whitespace-nowrap">
            {gview === "both"
              ? <><span className="text-cyan-700 dark:text-cyan-300">A</span> {fmtN(r.totalA)} · <span className="text-teal-700 dark:text-teal-300">B</span> {fmtN(r.totalB)}</>
              : cs > 0 ? `${fmtN(gCases)} cs + ${fmtN(gLoose)}` : "pcs"}
          </div>
        </div>
      </div>
      {/* Computer / tablet: columns */}
      <div className={cn("hidden sm:grid items-center gap-2", gview === "both" ? COLS_BOTH : COLS_ONE)}>
        <div className="flex items-center gap-3 min-w-0">
          {selectMode && <Box checked={selected} label={`Select ${r.model}`} />}
          {swatch}
          {name}
        </div>
        {gview === "both" ? (
          <>
            <Num value={r.totalA} sub={split(r.casesA, r.looseA)} dim={!r.hasA} />
            <Num value={r.totalB} sub={split(r.casesB, r.looseB)} dim={!r.hasB} />
            <div className={cn("text-right tabular-nums font-semibold text-sm", tone)}>{fmtN(total)}</div>
          </>
        ) : (
          <>
            <Num value={gCases} dim={cs === 0} />
            <Num value={gLoose} />
            <div className={cn("text-right tabular-nums font-semibold text-sm", tone)}>{fmtN(total)}</div>
          </>
        )}
      </div>
    </div>
  );
}

function Num({ value, sub, dim }: { value: number; sub?: string; dim?: boolean }) {
  return (
    <div className="text-right tabular-nums leading-tight">
      <div className={cn("text-sm", dim ? "text-zinc-400" : "text-zinc-800 dark:text-zinc-200")}>{fmtN(value)}</div>
      {sub ? <div className="text-[11px] text-zinc-400">{sub}</div> : null}
    </div>
  );
}

function Box({ checked, onClick, label }: { checked: boolean; onClick?: () => void; label: string }) {
  return (
    <span role="checkbox" aria-checked={checked} aria-label={label} tabIndex={onClick ? 0 : -1}
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
      className={cn("w-5 h-5 rounded-md border flex items-center justify-center flex-shrink-0",
        checked ? "bg-cyan-500 border-cyan-500 text-white" : "bg-white dark:bg-zinc-900 border-zinc-300 dark:border-zinc-600")}>
      {checked && <Check className="w-3.5 h-3.5" />}
    </span>
  );
}

function Chip({ active, onClick, children, tone }: { active: boolean; onClick: () => void; children: React.ReactNode; tone?: "amber" | "rose" }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={cn("h-8 px-3 rounded-full text-[13px] border whitespace-nowrap flex-shrink-0 transition-colors",
        active
          ? tone === "amber" ? "bg-amber-500/15 border-amber-500/50 text-amber-800 dark:text-amber-300"
            : tone === "rose" ? "bg-rose-500/15 border-rose-500/50 text-rose-700 dark:text-rose-300"
            : "bg-cyan-500/15 border-cyan-500/50 text-cyan-800 dark:text-cyan-300"
          : "bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:border-zinc-300")}>
      {children}
    </button>
  );
}

function Segmented({ value, onChange, options, className }: { value: string; onChange: (v: string) => void; options: { v: string; l: string }[]; className?: string }) {
  return (
    <div className={cn("inline-flex h-10 p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 flex-shrink-0", className)} role="radiogroup">
      {options.map(o => (
        <button key={o.v} type="button" role="radio" aria-checked={value === o.v} onClick={() => onChange(o.v)}
          className={cn("px-3 rounded-md text-sm whitespace-nowrap transition-colors",
            value === o.v ? "bg-white dark:bg-zinc-950 shadow-sm font-medium text-zinc-900 dark:text-zinc-100" : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200")}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

function Sheet({ title, onClose, children, footer }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode }) {
  useEscape(true, onClose);
  return (
    <div className="fixed inset-0 z-50 bg-black/50 dark:bg-black/70 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="bg-white dark:bg-zinc-900 w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-zinc-200 dark:border-zinc-800 shadow-lg max-h-[86vh] flex flex-col animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex-shrink-0">
          <h2 className="text-base font-semibold">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="w-9 h-9 -mr-2 flex items-center justify-center text-zinc-400 hover:text-zinc-700"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">{children}</div>
        {footer && <div className="p-3 border-t border-zinc-200 dark:border-zinc-800 flex-shrink-0" style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}>{footer}</div>}
      </div>
    </div>
  );
}

function TreeSkeleton() {
  return <div className="space-y-2 px-2">{Array.from({ length: 7 }).map((_, i) => <div key={i} className="h-5 rounded shimmer" style={{ width: `${55 + (i * 13) % 40}%` }} />)}</div>;
}
function ListSkeleton() {
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 space-y-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="w-2.5 h-9 rounded-full shimmer" />
          <div className="flex-1 space-y-1.5"><div className="h-3.5 rounded shimmer w-1/3" /><div className="h-3 rounded shimmer w-1/4" /></div>
          <div className="h-4 w-16 rounded shimmer" />
        </div>
      ))}
    </div>
  );
}
