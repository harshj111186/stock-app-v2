"use client";
// Browse by BRAND (2026-11-16, Harsh: "if we select by brand then brand name
// should show, when clicked on them the categories in which fans are there for
// that brand should show … the nesting can go as deep as we want").
//
//   All items
//   ▸ Goldmedal            160
//     ▸ ceiling fan          16      ← only categories that hold Goldmedal items,
//       ▸ Havells bldc fan    1        at every depth, counted for Goldmedal
//   ▸ Havells                1
//   ▸ No brand               …
//
// Tap a brand → its items; tap a category under it → that brand's items in that
// category and everything below it. Drag (computer, admins):
//   • items onto a BRAND → they get that brand (fixes "oriental" vs "orient")
//   • items onto a category under a brand → they move into that category AND
//     get that brand
// ⋯ on a brand → Rename / merge (typing an existing brand's name merges them).
// Re-ordering and nesting categories themselves happens in "By category".
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen, Tag, Layers, Inbox, MoreHorizontal, Pencil, Check, X, Loader2 } from "lucide-react";
import { buildCategoryTree, rollupCounts, type CatNode, type CatRow } from "@/lib/categories";
import { ALL, NONE, ITEM_DRAG } from "@/components/category-tree";
import { useEscape } from "@/lib/hooks";
import { cn, fmtN } from "@/lib/utils";

export const NO_BRAND = "__nobrand";

export type BrandStat = { total: number; none: number; direct: Map<string, number> };

export function BrandTree({
  rows, stats, totalCount, selBrand, selCat, onSelect, isAdmin, onDropItems, onRenameBrand, storageKey,
}: {
  rows: CatRow[];
  /** Per brand (NO_BRAND for items without one): items in total, items with no live category, items per category id. */
  stats: Map<string, BrandStat>;
  totalCount: number;
  selBrand: string | null;
  selCat: string;
  onSelect: (brand: string | null, cat: string) => void;
  isAdmin: boolean;
  /** cat: undefined = only set the brand, null = no category, id = that category. */
  onDropItems: (brand: string, cat: string | null | undefined, ids: string[]) => void;
  onRenameBrand: (oldBrand: string, next: string) => Promise<boolean>;
  storageKey: string;
}) {
  const tree = useMemo(() => buildCategoryTree(rows), [rows]);
  const brands = useMemo(() => [...stats.keys()].sort((a, b) =>
    a === NO_BRAND ? 1 : b === NO_BRAND ? -1 : a.localeCompare(b, "en", { sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0)), [stats]);
  const rollups = useMemo(() => {
    const m = new Map<string, Map<string, number>>();
    for (const [b, s] of stats) m.set(b, rollupCounts(rows, s.direct));
    return m;
  }, [stats, rows]);

  const [open, setOpen] = useState<Set<string>>(new Set());
  const [drop, setDrop] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const hover = useRef<{ key: string; t: number } | null>(null);
  const loaded = useRef(false);
  useEffect(() => {
    try { const raw = localStorage.getItem(storageKey); if (raw) setOpen(new Set(JSON.parse(raw))); } catch { /* ignore */ }
    loaded.current = true;
  }, [storageKey]);
  useEffect(() => { if (loaded.current) try { localStorage.setItem(storageKey, JSON.stringify([...open])); } catch { /* ignore */ } }, [open, storageKey]);
  // The selected brand (and the path to the selected category under it) stays open.
  useEffect(() => {
    if (!selBrand) return;
    const add = [selBrand];
    if (selCat !== ALL && selCat !== NONE) {
      const byId = new Map(rows.map(r => [r.id, r]));
      let cur = byId.get(selCat)?.parent_id;
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) { seen.add(cur); add.push(`${selBrand}::${cur}`); cur = byId.get(cur)?.parent_id ?? null; }
    }
    setOpen(prev => { const n = new Set(prev); add.forEach(a => n.add(a)); return n; });
  }, [selBrand, selCat, rows]);

  const toggle = (k: string) => setOpen(p => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const label = (b: string) => (b === NO_BRAND ? "No brand" : b);

  // ── drag & drop: items only ──────────────────────────────────────────
  const over = (e: React.DragEvent, key: string, expandKey?: string) => {
    if (!isAdmin || !Array.from(e.dataTransfer.types).includes(ITEM_DRAG)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (drop !== key) setDrop(key);
    if (expandKey && !open.has(expandKey)) {
      if (hover.current?.key !== expandKey) hover.current = { key: expandKey, t: Date.now() };
      else if (Date.now() - hover.current.t > 650) setOpen(p => new Set(p).add(expandKey));
    }
  };
  const dropOn = (e: React.DragEvent, brand: string, cat: string | null | undefined) => {
    if (!isAdmin) return;
    e.preventDefault();
    setDrop(null); hover.current = null;
    try {
      const ids = JSON.parse(e.dataTransfer.getData(ITEM_DRAG) || "[]") as string[];
      if (ids.length) onDropItems(brand, cat, ids);
    } catch { /* ignore */ }
  };
  const leave = (e: React.DragEvent, key: string) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(d => (d === key ? null : d)); };

  async function saveRename(b: string) {
    const next = draft.trim();
    if (!next || next === b) { setRenaming(null); return; }
    setBusy(true);
    const ok = await onRenameBrand(b, next);
    setBusy(false);
    if (ok) { setRenaming(null); setDraft(""); }
  }

  const rowCls = (selected: boolean, key: string) => cn(
    "group relative flex items-center gap-1 rounded-lg pr-1 min-h-9 transition-colors",
    selected ? "bg-cyan-500/10 text-cyan-800 dark:text-cyan-200" : "hover:bg-zinc-100 dark:hover:bg-zinc-800/60",
    drop === key && "ring-2 ring-cyan-500 bg-cyan-500/10",
  );

  const renderCat = (brand: string, node: CatNode, depth: number, roll: Map<string, number>): React.ReactNode => {
    const n = roll.get(node.id) ?? 0;
    if (n === 0) return null;
    const kids = node.children.filter(c => (roll.get(c.id) ?? 0) > 0);
    const key = `${brand}::${node.id}`;
    const isOpen = open.has(key);
    const sel = selBrand === brand && selCat === node.id;
    return (
      <Fragment key={key}>
        <div className={rowCls(sel, key)} style={{ paddingLeft: depth * 16 }}
          onDragOver={(e) => over(e, key, kids.length ? key : undefined)} onDragLeave={(e) => leave(e, key)} onDrop={(e) => dropOn(e, brand, node.id)}>
          <button type="button" onClick={() => kids.length && toggle(key)} tabIndex={kids.length ? 0 : -1}
            aria-label={kids.length ? (isOpen ? `Close ${node.name}` : `Open ${node.name}`) : undefined}
            className={cn("w-7 h-9 flex items-center justify-center flex-shrink-0 text-zinc-400 hover:text-zinc-700", !kids.length && "invisible")}>
            {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
          <button type="button" onClick={() => { onSelect(brand, node.id); if (kids.length) setOpen(p => new Set(p).add(key)); }}
            className="flex-1 min-w-0 flex items-center gap-2 h-9 text-left text-sm">
            {isOpen && kids.length ? <FolderOpen className="w-4 h-4 text-cyan-500 flex-shrink-0" /> : <Folder className="w-4 h-4 text-cyan-500/80 flex-shrink-0" />}
            <span className={cn("truncate", sel && "font-semibold")}>{node.name}</span>
          </button>
          <span className="text-[11px] tabular-nums text-zinc-400 px-1 flex-shrink-0">{fmtN(n)}</span>
        </div>
        {isOpen && kids.map(c => renderCat(brand, c, depth + 1, roll))}
      </Fragment>
    );
  };

  return (
    <div>
      <div className={rowCls(selBrand === null && selCat === ALL, ALL)} >
        <button type="button" onClick={() => onSelect(null, ALL)} className="flex-1 min-w-0 flex items-center gap-2 h-9 pl-2 text-left text-sm">
          <Layers className="w-4 h-4 flex-shrink-0 text-zinc-500" /><span className={cn("truncate", selBrand === null && selCat === ALL && "font-semibold")}>All items</span>
        </button>
        <span className="text-[11px] tabular-nums text-zinc-400 px-1">{fmtN(totalCount)}</span>
      </div>
      {brands.map(b => {
        const st = stats.get(b)!;
        const roll = rollups.get(b) ?? new Map();
        const topCats = tree.filter(c => (roll.get(c.id) ?? 0) > 0);
        const hasKids = topCats.length > 0 || st.none > 0;
        const isOpen = open.has(b);
        const sel = selBrand === b && selCat === ALL;
        return (
          <Fragment key={b}>
            <div className={rowCls(sel, b)}
              onDragOver={(e) => over(e, b, hasKids ? b : undefined)} onDragLeave={(e) => leave(e, b)} onDrop={(e) => dropOn(e, b, undefined)}>
              <button type="button" onClick={() => hasKids && toggle(b)} tabIndex={hasKids ? 0 : -1}
                aria-label={hasKids ? (isOpen ? `Close ${label(b)}` : `Open ${label(b)}`) : undefined}
                className={cn("w-7 h-9 flex items-center justify-center flex-shrink-0 text-zinc-400 hover:text-zinc-700", !hasKids && "invisible")}>
                {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </button>
              {renaming === b ? (
                <div className="flex items-center gap-1 flex-1 min-w-0">
                  <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={`New name for ${b}`}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void saveRename(b); } else if (e.key === "Escape") { e.stopPropagation(); setRenaming(null); } }}
                    className="flex-1 min-w-0 bg-white dark:bg-zinc-800 border border-cyan-500/60 rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-cyan-500" />
                  <button type="button" onClick={() => void saveRename(b)} disabled={busy} aria-label="Save" className="w-9 h-9 flex items-center justify-center text-emerald-600">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}</button>
                  <button type="button" onClick={() => setRenaming(null)} aria-label="Cancel" className="w-9 h-9 flex items-center justify-center text-zinc-400"><X className="w-4 h-4" /></button>
                </div>
              ) : (
                <>
                  <button type="button" onClick={() => { onSelect(b, ALL); if (hasKids) setOpen(p => new Set(p).add(b)); }}
                    className="flex-1 min-w-0 flex items-center gap-2 h-9 text-left text-sm">
                    <Tag className={cn("w-4 h-4 flex-shrink-0", b === NO_BRAND ? "text-zinc-400" : "text-cyan-500/80")} />
                    <span className={cn("truncate", sel && "font-semibold", b === NO_BRAND && "italic")}>{label(b)}</span>
                  </button>
                  <span className="text-[11px] tabular-nums text-zinc-400 px-1 flex-shrink-0">{fmtN(st.total)}</span>
                  {isAdmin && b !== NO_BRAND && (
                    <div className="relative flex-shrink-0">
                      <button type="button" onClick={() => setMenuFor(m => (m === b ? null : b))} aria-label={`Options for ${b}`} title={`Options for ${b}`}
                        className={cn("w-9 h-9 flex items-center justify-center rounded-md text-zinc-400 hover:text-cyan-700 hover:bg-cyan-500/10 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100", menuFor === b && "md:opacity-100")}>
                        <MoreHorizontal className="w-4 h-4" />
                      </button>
                      {menuFor === b && (
                        <BrandMenu onClose={() => setMenuFor(null)} onRename={() => { setRenaming(b); setDraft(b); setMenuFor(null); }} />
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
            {isOpen && (
              <>
                {topCats.map(c => renderCat(b, c, 1, roll))}
                {st.none > 0 && (
                  <div className={rowCls(selBrand === b && selCat === NONE, `${b}::none`)} style={{ paddingLeft: 16 }}
                    onDragOver={(e) => over(e, `${b}::none`)} onDragLeave={(e) => leave(e, `${b}::none`)} onDrop={(e) => dropOn(e, b, null)}>
                    <span className="w-7 h-9 flex-shrink-0" />
                    <button type="button" onClick={() => onSelect(b, NONE)} className="flex-1 min-w-0 flex items-center gap-2 h-9 text-left text-sm">
                      <Inbox className="w-4 h-4 text-zinc-400 flex-shrink-0" /><span className="truncate italic">No category</span>
                    </button>
                    <span className="text-[11px] tabular-nums text-zinc-400 px-1">{fmtN(st.none)}</span>
                  </div>
                )}
              </>
            )}
          </Fragment>
        );
      })}
      {isAdmin && (
        <p className="hidden lg:block mt-3 px-2 text-[11px] leading-relaxed text-zinc-400">
          Drag items onto a brand to give them that brand, or onto a category under a brand to move them there. ⋯ on a brand renames it — type another brand's name to merge the two.
        </p>
      )}
    </div>
  );
}

function BrandMenu({ onClose, onRename }: { onClose: () => void; onRename: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEscape(true, onClose);
  useEffect(() => {
    const onDown = (e: MouseEvent | TouchEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("touchstart", onDown); };
  }, [onClose]);
  return (
    <div ref={ref} role="menu" className="absolute right-0 top-full mt-1 z-30 w-52 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg py-1 animate-fade-in">
      <button type="button" role="menuitem" onClick={onRename} className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-zinc-100 dark:hover:bg-zinc-800">
        <Pencil className="w-4 h-4" /> Rename / merge brand
      </button>
    </div>
  );
}
