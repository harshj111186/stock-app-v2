"use client";
// The category tree — one component for both places it lives:
//   • "browse" (left side of Items): tap a category to see its items; admins
//     get a ⋯ menu per row and can drag items onto a category to move them.
//   • "manage" (the Categories page): the same tree, full width, with the
//     actions written out as buttons instead of hidden behind ⋯.
//
// Drag and drop (computer, admins — 2026-11-16 second pass, Harsh: "hold and
// drop them properly … all the option to shuffle them with drag drop"):
//   • drop a category on the TOP or BOTTOM edge of another → it goes just
//     above / below it (same level, saved order via category_reorder)
//   • drop it in the MIDDLE of another → it goes inside it
//   • drop it on "Drop here to make it a main category" → top level
//   • hovering over a closed category for a moment opens it, so you can
//     drop deep; every move has Undo.
// Phones get the same moves from the ⋯ menu (Move up / Move down / Move
// into… / Merge into…).
//
// Every change goes through admin-gated RPCs (category_create / _rename /
// _move / _archive / _reorder, set_items_category). Name clashes are checked
// first and explained in words — the database would otherwise answer
// "duplicate key value violates unique constraint".
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown, ChevronRight, Folder, FolderOpen, FolderPlus, MoreHorizontal, Pencil, MoveRight,
  Trash2, ArchiveRestore, Check, X, Loader2, Layers, Inbox, AlertCircle, ArrowUp, ArrowDown, Merge, GripVertical, CornerLeftUp,
} from "lucide-react";
import { sb } from "@/lib/supabase";
import {
  buildCategoryTree, descendantIds, siblingWithName, splitPath, friendlyCatError, pathById,
  type CatNode, type CatRow,
} from "@/lib/categories";
import { CategoryPickerSheet, TOP_LEVEL, createCategoryPath } from "@/components/category-picker";
import { useEscape } from "@/lib/hooks";
import { cn, fmtN } from "@/lib/utils";

export const ALL = "__all";
export const NONE = "__none";

export const ITEM_DRAG = "application/x-stock-items";
const CAT_DRAG = "application/x-stock-category";

export type Notify = (kind: "ok" | "bad", text: string, undo?: () => void) => void;
type DropPos = "before" | "inside" | "after";

type Props = {
  mode: "browse" | "manage";
  rows: CatRow[];
  /** Items per category including everything below it. */
  counts: Map<string, number>;
  totalCount: number;
  uncategorisedCount: number;
  selected?: string;
  onSelect?: (id: string) => void;
  isAdmin: boolean;
  /** Reload categories + items after any change. */
  onChanged: () => Promise<void> | void;
  /** Items dropped on a category (browse mode, desktop). */
  onDropItems?: (categoryId: string | null, itemIds: string[]) => void;
  showArchived?: boolean;
  /** Say what happened ("Moved 3 items to Fans"), optionally with Undo. */
  notify: Notify;
  storageKey?: string;
};

type Editor = { kind: "add"; parentId: string | null } | { kind: "rename"; id: string } | null;

// Children of `parent` (null = main categories) in the order the tree shows them.
export function liveKids(rows: CatRow[], parent: string | null): CatRow[] {
  return rows
    .filter(r => !r.archived && (r.parent_id ?? null) === parent)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name));
}

export function CategoryTree({
  mode, rows, counts, totalCount, uncategorisedCount, selected, onSelect, isAdmin, onChanged,
  onDropItems, showArchived = false, notify, storageKey = "cattree.open",
}: Props) {
  const tree = useMemo(() => buildCategoryTree(rows, showArchived), [rows, showArchived]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<Editor>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [moving, setMoving] = useState<CatNode | null>(null);
  const [merging, setMerging] = useState<CatNode | null>(null);
  const [deleting, setDeleting] = useState<{ node: CatNode; mergeInto?: string } | null>(null);
  const [drop, setDrop] = useState<{ id: string; pos: DropPos } | null>(null);
  const [dragCat, setDragCat] = useState<string | null>(null);
  const hover = useRef<{ id: string; t: number } | null>(null);
  // A category just made or moved: once the reloaded rows contain it, open
  // every level above it so it is on screen.
  const [reveal, setReveal] = useState<string | null>(null);
  const loadedOpen = useRef(false);

  // Remember which branches are open on this device.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) setExpanded(new Set(JSON.parse(raw)));
    } catch { /* ignore */ }
    loadedOpen.current = true;
  }, [storageKey]);
  useEffect(() => {
    if (!loadedOpen.current) return;
    try { localStorage.setItem(storageKey, JSON.stringify([...expanded])); } catch { /* ignore */ }
  }, [expanded, storageKey]);
  const openAbove = useCallback((id: string, includeSelf = false) => {
    const byId = new Map(rows.map(r => [r.id, r]));
    const add: string[] = includeSelf ? [id] : [];
    let cur = byId.get(id)?.parent_id;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) { seen.add(cur); add.push(cur); cur = byId.get(cur)?.parent_id ?? null; }
    if (add.length) setExpanded(prev => { const n = new Set(prev); add.forEach(a => n.add(a)); return n; });
  }, [rows]);
  // The selected category's branch is always open.
  useEffect(() => {
    if (!selected || selected === ALL || selected === NONE) return;
    openAbove(selected);
  }, [selected, openAbove]);
  useEffect(() => {
    if (!reveal || !rows.some(r => r.id === reveal)) return;
    openAbove(reveal);
    setReveal(null);
  }, [reveal, rows, openAbove]);

  const toggle = (id: string) => setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const run = useCallback(async (fn: () => Promise<void>, okText: string) => {
    setBusy(true);
    try {
      await fn();
      await onChanged();
      notify("ok", okText);
      return true;
    } catch (e) {
      notify("bad", friendlyCatError(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, [onChanged, notify]);

  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { error } = await sb().rpc(fn, args);
    if (error) throw error;
  };

  // ── actions ──────────────────────────────────────────────────────────
  const saveAdd = async (parentId: string | null) => {
    const segs = splitPath(draft);
    if (!segs.length) { setEditor(null); return; }
    let newId: string | null = null;
    const ok = await run(async () => { newId = await createCategoryPath(segs, parentId); }, `Added ${segs.join(" › ")}.`);
    if (ok) {
      if (newId) setReveal(newId);
      setEditor(null); setDraft("");
    }
  };
  const saveRename = async (node: CatNode) => {
    const name = draft.trim();
    if (!name || name === node.name) { setEditor(null); return; }
    if (siblingWithName(rows, node.parent_id ?? null, name, node.id)) {
      notify("bad", `There is already a “${name}” next to it. Pick another name.`);
      return;
    }
    const ok = await run(() => rpc("category_rename", { p_id: node.id, p_name: name }), `Renamed to ${name}.`);
    if (ok) { setEditor(null); setDraft(""); }
  };

  // Put `node` under `parent` (null = main categories), just before
  // `beforeId` (null = at the end). One function for every kind of move —
  // drag, Move into…, Move up / down — so they all get the same checks + Undo.
  const place = async (node: CatNode, parent: string | null, beforeId: string | null) => {
    if (parent !== null && descendantIds(rows, node.id).has(parent)) { notify("bad", "A category can't go inside itself."); return; }
    const prevParent = node.parent_id ?? null;
    const prevOrder = liveKids(rows, prevParent).map(r => r.id);
    if (parent !== prevParent && siblingWithName(rows, parent, node.name, node.id)) {
      notify("bad", `There is already a “${node.name}” there. Rename one of them first, or use Merge into….`);
      return;
    }
    const sibs = liveKids(rows, parent).map(r => r.id).filter(id => id !== node.id);
    const at = beforeId ? sibs.indexOf(beforeId) : -1;
    const order = at >= 0 ? [...sibs.slice(0, at), node.id, ...sibs.slice(at)] : [...sibs, node.id];
    if (parent === prevParent && order.join() === prevOrder.join()) return; // dropped where it already is
    const where = parent ? `into ${pathById(rows).get(parent)}` : "to the main categories";
    setBusy(true);
    try {
      if (parent !== prevParent) await rpc("category_move", { p_id: node.id, p_parent_id: parent });
      await rpc("category_reorder", { p_parent_id: parent, p_ids: order });
      await onChanged();
      setReveal(node.id);
      notify("ok", parent !== prevParent ? `Moved ${node.name} ${where}.` : `Moved ${node.name}.`, async () => {
        try {
          if (parent !== prevParent) await rpc("category_move", { p_id: node.id, p_parent_id: prevParent });
          await rpc("category_reorder", { p_parent_id: prevParent, p_ids: prevOrder });
          await onChanged();
          setReveal(node.id);
          notify("ok", "Put back.");
        } catch (e) { await onChanged(); notify("bad", friendlyCatError(e)); }
      });
    } catch (e) {
      await onChanged();
      notify("bad", friendlyCatError(e));
    } finally {
      setBusy(false);
    }
  };
  const nudge = (node: CatNode, dir: -1 | 1) => {
    const parent = node.parent_id ?? null;
    const sibs = liveKids(rows, parent).map(r => r.id);
    const i = sibs.indexOf(node.id);
    if (i < 0 || i + dir < 0 || i + dir >= sibs.length) return;
    void place(node, parent, dir < 0 ? sibs[i - 1] : sibs[i + 2] ?? null);
  };
  const restore = async (node: CatNode) => {
    if (siblingWithName(rows, node.parent_id ?? null, node.name, node.id)) {
      notify("bad", `A live “${node.name}” already exists there. Rename that one first.`);
      return;
    }
    await run(() => rpc("category_archive", { p_id: node.id, p_archived: false }), `Restored ${node.name}.`);
  };

  // ── drag & drop (computer — phones never fire HTML drag events) ──────
  const canDnD = isAdmin;
  const kinds = (e: React.DragEvent) => {
    const t = Array.from(e.dataTransfer.types);
    return { cat: t.includes(CAT_DRAG), items: t.includes(ITEM_DRAG) && mode === "browse" };
  };
  const endDrag = () => { setDragCat(null); setDrop(null); hover.current = null; };
  const onRowDragOver = (e: React.DragEvent, node: CatNode) => {
    if (!canDnD || node.archived) return;
    const k = kinds(e);
    if (!k.cat && !k.items) return;
    let pos: DropPos = "inside";
    if (k.cat) {
      if (!dragCat || dragCat === node.id || descendantIds(rows, dragCat).has(node.id)) return; // not into itself
      const r = e.currentTarget.getBoundingClientRect();
      const y = e.clientY - r.top;
      pos = y < r.height * 0.3 ? "before" : y > r.height * 0.7 ? "after" : "inside";
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (drop?.id !== node.id || drop.pos !== pos) setDrop({ id: node.id, pos });
    // Hold over a closed category for a moment → it opens, so you can go deeper.
    if (pos === "inside" && node.children.length && !expanded.has(node.id)) {
      if (hover.current?.id !== node.id) hover.current = { id: node.id, t: Date.now() };
      else if (Date.now() - hover.current.t > 650) setExpanded(p => new Set(p).add(node.id));
    } else if (hover.current?.id === node.id) hover.current = null;
  };
  const onRowDrop = (e: React.DragEvent, node: CatNode) => {
    if (!canDnD) return;
    e.preventDefault();
    const d = drop;
    endDrag();
    const items = e.dataTransfer.getData(ITEM_DRAG);
    if (items) {
      try { const ids = JSON.parse(items) as string[]; if (ids.length) onDropItems?.(node.id, ids); } catch { /* ignore */ }
      return;
    }
    const catId = e.dataTransfer.getData(CAT_DRAG);
    const dragged = catId ? findNode(tree, catId) : null;
    if (!dragged || dragged.id === node.id) return;
    const pos = d?.id === node.id ? d.pos : "inside";
    const parent = node.parent_id ?? null;
    // The bottom edge of an OPEN category sits right above its first
    // sub-category, so that is where the line is drawn — and where it lands.
    const openKids = expanded.has(node.id) ? liveKids(rows, node.id).map(r => r.id).filter(id => id !== dragged.id) : [];
    if (pos === "after" && openKids.length) { void place(dragged, node.id, openKids[0]); return; }
    if (pos === "inside") void place(dragged, node.id, null);
    else if (pos === "before") void place(dragged, parent, node.id);
    else {
      const sibs = liveKids(rows, parent).map(r => r.id).filter(id => id !== dragged.id);
      void place(dragged, parent, sibs[sibs.indexOf(node.id) + 1] ?? null);
    }
  };
  const onSpecialDragOver = (e: React.DragEvent, id: string) => {
    if (!canDnD) return;
    const k = kinds(e);
    const ok = (id === NONE && k.items) || (id === TOP_LEVEL && k.cat);
    if (!ok) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (drop?.id !== id) setDrop({ id, pos: "inside" });
  };
  const onSpecialDrop = (e: React.DragEvent, id: string) => {
    if (!canDnD) return;
    e.preventDefault();
    endDrag();
    const items = e.dataTransfer.getData(ITEM_DRAG);
    if (items && id === NONE) {
      try { const ids = JSON.parse(items) as string[]; if (ids.length) onDropItems?.(null, ids); } catch { /* ignore */ }
      return;
    }
    const catId = e.dataTransfer.getData(CAT_DRAG);
    const dragged = catId ? findNode(tree, catId) : null;
    if (dragged && id === TOP_LEVEL) void place(dragged, null, null);
  };

  // ── rendering ────────────────────────────────────────────────────────
  const manage = mode === "manage";
  const rowPad = manage ? 20 : 16;

  const menuItems = (node: CatNode) => {
    const sibs = liveKids(rows, node.parent_id ?? null);
    const i = sibs.findIndex(r => r.id === node.id);
    return [
      ...(manage ? [] : [{ icon: FolderPlus, label: "Add sub-category", onClick: () => { setEditor({ kind: "add", parentId: node.id }); setDraft(""); setExpanded(p => new Set(p).add(node.id)); } }]),
      { icon: Pencil, label: "Rename", onClick: () => { setEditor({ kind: "rename", id: node.id }); setDraft(node.name); } },
      ...(i > 0 ? [{ icon: ArrowUp, label: "Move up", onClick: () => nudge(node, -1) }] : []),
      ...(i >= 0 && i < sibs.length - 1 ? [{ icon: ArrowDown, label: "Move down", onClick: () => nudge(node, 1) }] : []),
      { icon: MoveRight, label: "Move into…", onClick: () => setMoving(node) },
      ...(node.parent_id ? [{ icon: CornerLeftUp, label: "Make it a main category", onClick: () => void place(node, null, null) }] : []),
      { icon: Merge, label: "Merge into…", onClick: () => setMerging(node) },
      { icon: Trash2, label: "Delete", onClick: () => setDeleting({ node }), danger: true },
    ];
  };

  const renderNode = (node: CatNode): React.ReactNode => {
    const hasKids = node.children.length > 0;
    const open = expanded.has(node.id);
    const isSel = selected === node.id;
    const count = counts.get(node.id) ?? 0;
    const renaming = editor?.kind === "rename" && editor.id === node.id;
    const addingHere = editor?.kind === "add" && editor.parentId === node.id;
    const isDrop = drop?.id === node.id;
    const draggable = canDnD && !renaming && !node.archived;
    return (
      <Fragment key={node.id}>
        <div
          className={cn(
            "group relative flex items-center gap-1 rounded-lg pr-1 transition-colors",
            manage ? "min-h-11" : "min-h-9",
            isSel ? "bg-cyan-500/10 text-cyan-800 dark:text-cyan-200" : "hover:bg-zinc-100 dark:hover:bg-zinc-800/60",
            isDrop && drop!.pos === "inside" && "ring-2 ring-cyan-500 bg-cyan-500/10",
            dragCat === node.id && "opacity-40",
            draggable && "lg:cursor-grab lg:active:cursor-grabbing",
          )}
          style={{ paddingLeft: node.depth * rowPad }}
          draggable={draggable}
          onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData(CAT_DRAG, node.id); e.dataTransfer.effectAllowed = "move"; setDragCat(node.id); setMenuFor(null); }}
          onDragEnd={endDrag}
          onDragOver={(e) => onRowDragOver(e, node)}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(t => (t?.id === node.id ? null : t)); }}
          onDrop={(e) => onRowDrop(e, node)}
        >
          {isDrop && drop!.pos !== "inside" && (
            <span aria-hidden className={cn("pointer-events-none absolute right-1 h-[3px] rounded-full bg-cyan-500 z-10", drop!.pos === "before" ? "-top-[2px]" : "-bottom-[2px]")}
              style={{ left: (drop!.pos === "after" && open && hasKids ? node.depth + 1 : node.depth) * rowPad + 6 }} />
          )}
          {draggable && (
            <GripVertical aria-hidden className={cn("hidden lg:block w-3.5 h-3.5 -mr-1.5 flex-shrink-0 text-zinc-300 dark:text-zinc-600", !manage && "opacity-0 group-hover:opacity-100")} />
          )}
          <button type="button" onClick={() => hasKids && toggle(node.id)}
            aria-label={hasKids ? (open ? `Close ${node.name}` : `Open ${node.name}`) : undefined}
            tabIndex={hasKids ? 0 : -1}
            className={cn("w-7 h-9 flex items-center justify-center flex-shrink-0 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200", !hasKids && "invisible")}>
            {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
          {renaming ? (
            <InlineInput value={draft} onChange={setDraft} busy={busy} onSave={() => saveRename(node)} onCancel={() => { setEditor(null); setDraft(""); }} />
          ) : (
            <>
              <button type="button"
                onClick={() => {
                  // Tapping a category shows what is inside it — in the list AND in the tree.
                  if (onSelect) { onSelect(node.id); if (hasKids) setExpanded(p => new Set(p).add(node.id)); }
                  else if (hasKids) toggle(node.id);
                }}
                className={cn("flex-1 min-w-0 flex items-center gap-2 text-left", manage ? "h-11 text-[15px]" : "h-9 text-sm")}>
                {open && hasKids
                  ? <FolderOpen className={cn("w-4 h-4 flex-shrink-0", node.archived ? "text-zinc-400" : "text-cyan-500")} />
                  : <Folder className={cn("w-4 h-4 flex-shrink-0", node.archived ? "text-zinc-400" : "text-cyan-500/80")} />}
                <span className={cn("truncate", isSel && "font-semibold", node.archived && "line-through text-zinc-400")}>{node.name}</span>
                {node.archived && <span className="text-[10px] text-amber-600 dark:text-amber-400 flex-shrink-0">deleted</span>}
              </button>
              <span className={cn("text-[11px] tabular-nums flex-shrink-0 px-1", isSel ? "text-cyan-700 dark:text-cyan-300" : "text-zinc-400")}>{fmtN(count)}</span>
              {isAdmin && (
                node.archived ? (
                  <IconBtn label={`Restore ${node.name}`} onClick={() => restore(node)} disabled={busy}><ArchiveRestore className="w-4 h-4 text-emerald-600" /></IconBtn>
                ) : manage ? (
                  <div className="flex items-center gap-0.5 flex-shrink-0">
                    <TextBtn label={`Add a sub-category in ${node.name}`} onClick={() => { setEditor({ kind: "add", parentId: node.id }); setDraft(""); setExpanded(p => new Set(p).add(node.id)); }} disabled={busy}><FolderPlus className="w-4 h-4" /><span className="hidden sm:inline">Sub-category</span></TextBtn>
                    {/* Computer: the common actions as buttons + ⋯ for the rest. Phone: everything in ⋯. */}
                    <span className="hidden sm:contents">
                      <IconBtn label={`Rename ${node.name}`} onClick={() => { setEditor({ kind: "rename", id: node.id }); setDraft(node.name); }} disabled={busy}><Pencil className="w-4 h-4" /></IconBtn>
                      <IconBtn label={`Move ${node.name}`} onClick={() => setMoving(node)} disabled={busy}><MoveRight className="w-4 h-4" /></IconBtn>
                      <IconBtn label={`Delete ${node.name}`} onClick={() => setDeleting({ node })} disabled={busy} danger><Trash2 className="w-4 h-4" /></IconBtn>
                    </span>
                    <span className="relative">
                      <IconBtn label={`Options for ${node.name}`} onClick={() => setMenuFor(m => (m === node.id ? null : node.id))} disabled={busy}><MoreHorizontal className="w-4 h-4" /></IconBtn>
                      {menuFor === node.id && <RowMenu onClose={() => setMenuFor(null)} items={menuItems(node)} />}
                    </span>
                  </div>
                ) : (
                  <div className="relative flex-shrink-0">
                    <IconBtn label={`Options for ${node.name}`} onClick={() => setMenuFor(m => (m === node.id ? null : node.id))} disabled={busy}
                      className={cn("md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100", menuFor === node.id && "md:opacity-100")}>
                      <MoreHorizontal className="w-4 h-4" />
                    </IconBtn>
                    {menuFor === node.id && <RowMenu onClose={() => setMenuFor(null)} items={menuItems(node)} />}
                  </div>
                )
              )}
            </>
          )}
        </div>
        {addingHere && (
          <div style={{ paddingLeft: (node.depth + 1) * rowPad + 28 }} className="py-1">
            <InlineInput value={draft} onChange={setDraft} busy={busy} placeholder={`New in ${node.name} (or A / B for deeper)`}
              onSave={() => saveAdd(node.id)} onCancel={() => { setEditor(null); setDraft(""); }} />
          </div>
        )}
        {open && node.children.map(renderNode)}
      </Fragment>
    );
  };

  const specialRow = (id: string, label: string, n: number, Icon: typeof Layers) => (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg px-2 transition-colors",
        manage ? "min-h-11" : "min-h-9",
        selected === id ? "bg-cyan-500/10 text-cyan-800 dark:text-cyan-200 font-semibold" : "hover:bg-zinc-100 dark:hover:bg-zinc-800/60",
        drop?.id === id && "ring-2 ring-cyan-500 bg-cyan-500/10",
      )}
      onDragOver={(e) => onSpecialDragOver(e, id)}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(t => (t?.id === id ? null : t)); }}
      onDrop={(e) => onSpecialDrop(e, id)}
    >
      <button type="button" onClick={() => onSelect?.(id)} className="flex-1 min-w-0 flex items-center gap-2 h-9 text-left text-sm">
        <Icon className="w-4 h-4 flex-shrink-0 text-zinc-500" />
        <span className="truncate">{label}</span>
      </button>
      <span className="text-[11px] tabular-nums text-zinc-400 px-1">{fmtN(n)}</span>
    </div>
  );

  return (
    <div>
      {mode === "browse" && specialRow(ALL, "All items", totalCount, Layers)}
      {tree.map(renderNode)}
      {mode === "browse" && uncategorisedCount > 0 && specialRow(NONE, "No category", uncategorisedCount, Inbox)}
      {/* While a category is being dragged: a clear place to make it a main category. */}
      {dragCat && rows.find(r => r.id === dragCat)?.parent_id && (
        <div
          onDragOver={(e) => onSpecialDragOver(e, TOP_LEVEL)}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(t => (t?.id === TOP_LEVEL ? null : t)); }}
          onDrop={(e) => onSpecialDrop(e, TOP_LEVEL)}
          className={cn("mt-2 flex items-center justify-center gap-2 h-11 rounded-lg border-2 border-dashed text-sm transition-colors",
            drop?.id === TOP_LEVEL ? "border-cyan-500 bg-cyan-500/10 text-cyan-800 dark:text-cyan-200" : "border-zinc-300 dark:border-zinc-700 text-zinc-500")}>
          <CornerLeftUp className="w-4 h-4" /> Drop here to make it a main category
        </div>
      )}
      {isAdmin && (
        editor?.kind === "add" && editor.parentId === null ? (
          <div className="py-1 pl-2">
            <InlineInput value={draft} onChange={setDraft} busy={busy} placeholder="New main category (or Fans / Ceiling)"
              onSave={() => saveAdd(null)} onCancel={() => { setEditor(null); setDraft(""); }} />
          </div>
        ) : (
          <button type="button" onClick={() => { setEditor({ kind: "add", parentId: null }); setDraft(""); }}
            className={cn("mt-1 w-full flex items-center gap-2 px-2 rounded-lg text-left text-cyan-700 dark:text-cyan-300 hover:bg-cyan-500/10", manage ? "h-11 text-[15px]" : "h-9 text-sm")}>
            <FolderPlus className="w-4 h-4" /> New main category
          </button>
        )
      )}
      {canDnD && (
        <p className="hidden lg:block mt-3 px-2 text-[11px] leading-relaxed text-zinc-400">
          {mode === "browse"
            ? "Drag items onto a category to move them. Drag a category onto the top or bottom edge of another to re-order, onto its middle to put it inside."
            : "Drag a category onto the top or bottom edge of another to re-order it, onto its middle to put it inside. Hold over a closed one to open it."}
        </p>
      )}

      <CategoryPickerSheet
        open={!!moving}
        onClose={() => setMoving(null)}
        rows={rows}
        value={moving ? (moving.parent_id ?? TOP_LEVEL) : null}
        title={moving ? `Move “${moving.name}” into…` : ""}
        topLevelLabel="Top level (a main category)"
        excludeIds={moving ? descendantIds(rows, moving.id) : undefined}
        counts={counts}
        onPick={(target) => { const n = moving; setMoving(null); if (n) void place(n, target === TOP_LEVEL ? null : target, null); }}
      />
      <CategoryPickerSheet
        open={!!merging}
        onClose={() => setMerging(null)}
        rows={rows}
        value={null}
        title={merging ? `Merge “${merging.name}” into…` : ""}
        excludeIds={merging ? descendantIds(rows, merging.id) : undefined}
        counts={counts}
        onPick={(target) => { const n = merging; setMerging(null); if (n && target && target !== TOP_LEVEL) setDeleting({ node: n, mergeInto: target }); }}
      />
      {deleting && (
        <DeleteCategoryDialog node={deleting.node} mergeInto={deleting.mergeInto} rows={rows} counts={counts}
          onClose={() => setDeleting(null)}
          onDone={async (msg) => { setDeleting(null); await onChanged(); notify("ok", msg); }}
          onError={(m) => { notify("bad", m); void onChanged(); }} />
      )}
    </div>
  );
}

function findNode(nodes: CatNode[], id: string): CatNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const f = findNode(n.children, id);
    if (f) return f;
  }
  return null;
}

// ─── delete / merge = move its contents somewhere, then archive ───────────
// Nothing is ever lost: the category's own items and its direct
// sub-categories move to the chosen place (its parent by default, or the
// category picked in "Merge into…"), then the empty category is archived
// (restorable from "Show deleted").
function DeleteCategoryDialog({ node, mergeInto, rows, counts, onClose, onDone, onError }: {
  node: CatNode; mergeInto?: string; rows: CatRow[]; counts: Map<string, number>;
  onClose: () => void; onDone: (msg: string) => void | Promise<void>; onError: (m: string) => void;
}) {
  const merge = !!mergeInto;
  const [dest, setDest] = useState<string | null>(mergeInto ?? node.parent_id ?? null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [directItems, setDirectItems] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEscape(!busy && !picking, onClose);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data, error } = await sb().from("items").select("id").eq("category_id", node.id);
      if (!alive) return;
      // Unknown contents must never read as "empty" — keep it null so Delete stays off.
      if (error) { setErr(`Couldn't check what is inside (${error.message}). Close and try again.`); return; }
      setDirectItems((data || []).map((r: any) => r.id));
    })();
    return () => { alive = false; };
  }, [node.id]);

  const kids = rows.filter(r => !r.archived && r.parent_id === node.id);
  const paths = pathById(rows);
  const destLabel = dest ? paths.get(dest) ?? "…" : null;
  const nItems = directItems?.length ?? 0;
  const empty = nItems === 0 && kids.length === 0;
  const clashes = kids.filter(k => siblingWithName(rows, dest, k.name, k.id));
  const excluded = useMemo(() => descendantIds(rows, node.id), [rows, node.id]);

  async function go() {
    if (clashes.length) return;
    setBusy(true); setErr(null);
    try {
      const c = sb();
      if (nItems > 0) {
        const { error } = await c.rpc("set_items_category", { p_item_ids: directItems, p_category_id: dest });
        if (error) throw error;
      }
      for (const k of kids) {
        const { error } = await c.rpc("category_move", { p_id: k.id, p_parent_id: dest });
        if (error) throw error;
      }
      const { error } = await c.rpc("category_archive", { p_id: node.id, p_archived: true });
      if (error) throw error;
      await onDone(merge
        ? `Merged ${node.name} into ${destLabel}.`
        : empty ? `Deleted ${node.name}.` : `Deleted ${node.name}; its contents are now in ${destLabel ?? (kids.length ? "the top level" : "No category")}.`);
    } catch (e) {
      const m = friendlyCatError(e);
      setErr(m); onError(m);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 dark:bg-black/70 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in"
      role="dialog" aria-modal="true" aria-label={merge ? `Merge ${node.name}` : `Delete ${node.name}`} onClick={() => !busy && onClose()}>
      <div className="bg-white dark:bg-zinc-900 w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-lg border border-zinc-200 dark:border-zinc-800 animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 pt-5 pb-4">
          <h2 className="text-base font-semibold">{merge ? <>Merge “{node.name}” into “{destLabel?.split(" › ").pop()}”?</> : <>Delete “{node.name}”?</>}</h2>
          {directItems === null ? (
            !err && <p className="mt-2 text-sm text-zinc-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Checking what is inside…</p>
          ) : empty && !merge ? (
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">It is empty. It will be removed from the list (you can bring it back from “Show deleted” on the Categories page).</p>
          ) : empty ? (
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">It is empty, so nothing moves. “{node.name}” will be removed from the list.</p>
          ) : (
            <>
              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
                Nothing is lost. Its{" "}
                {nItems > 0 && <b>{fmtN(nItems)} item{nItems === 1 ? "" : "s"}</b>}
                {nItems > 0 && kids.length > 0 && " and "}
                {kids.length > 0 && <b>{kids.length} sub-categor{kids.length === 1 ? "y" : "ies"}</b>}
                {" "}move {merge ? "into" : "to"}:
              </p>
              <button type="button" onClick={() => setPicking(true)}
                className="mt-3 w-full flex items-center gap-2 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-2.5 text-left text-sm hover:border-cyan-500/60">
                <Folder className="w-4 h-4 text-cyan-500" />
                <span className="flex-1 truncate">{destLabel ?? (kids.length ? "Top level / No category" : "No category")}</span>
                <span className="text-xs text-cyan-700 dark:text-cyan-300">Change</span>
              </button>
              {(counts.get(node.id) ?? 0) > nItems && (
                <p className="mt-2 text-[12px] text-zinc-500">Items inside its sub-categories stay where they are, and go along with them.</p>
              )}
              {clashes.length > 0 && (
                <p className="mt-2 text-[12px] text-rose-600 dark:text-rose-400 flex gap-1.5"><AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  {clashes.map(c => `“${c.name}”`).join(", ")} already exist{clashes.length === 1 ? "s" : ""} there. Rename {clashes.length === 1 ? "it" : "them"} first, or pick another place.
                </p>
              )}
            </>
          )}
          {err && <p className="mt-2 text-[12px] text-rose-600 dark:text-rose-400">{err}</p>}
        </div>
        <div className="px-5 py-3 border-t border-zinc-200 dark:border-zinc-800 flex justify-end gap-2 bg-zinc-50 dark:bg-zinc-900/50 rounded-b-2xl"
          style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}>
          <button type="button" onClick={onClose} disabled={busy} className="px-3 py-2 text-sm text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded-md">Cancel</button>
          <button type="button" onClick={go} disabled={busy || directItems === null || clashes.length > 0}
            className={cn("disabled:opacity-40 text-white px-3.5 py-2 rounded-md text-sm font-medium inline-flex items-center gap-1.5", merge ? "bg-cyan-500 hover:bg-cyan-400" : "bg-rose-600 hover:bg-rose-500")}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : merge ? <Merge className="w-4 h-4" /> : <Trash2 className="w-4 h-4" />} {merge ? "Merge" : "Delete category"}
          </button>
        </div>
      </div>
      <CategoryPickerSheet open={picking} onClose={() => setPicking(false)} rows={rows} value={dest ?? TOP_LEVEL}
        title="Move its contents to…" topLevelLabel={kids.length ? "Top level / No category" : "No category"}
        excludeIds={excluded} counts={counts}
        onPick={(v) => setDest(v === TOP_LEVEL ? null : v)} />
    </div>
  );
}

function RowMenu({ items, onClose }: { items: { icon: typeof Pencil; label: string; onClick: () => void; danger?: boolean }[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEscape(true, onClose);
  useEffect(() => {
    const onDown = (e: MouseEvent | TouchEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("touchstart", onDown); };
  }, [onClose]);
  return (
    <div ref={ref} role="menu" className="absolute right-0 top-full mt-1 z-30 w-48 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg py-1 animate-fade-in">
      {items.map(it => (
        <button key={it.label} type="button" role="menuitem" onClick={() => { onClose(); it.onClick(); }}
          className={cn("w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-zinc-100 dark:hover:bg-zinc-800", it.danger && "text-rose-600 dark:text-rose-400")}>
          <it.icon className="w-4 h-4" /> {it.label}
        </button>
      ))}
    </div>
  );
}

function InlineInput({ value, onChange, onSave, onCancel, busy, placeholder }: {
  value: string; onChange: (v: string) => void; onSave: () => void; onCancel: () => void; busy: boolean; placeholder?: string;
}) {
  return (
    <div className="flex items-center gap-1 flex-1 min-w-0">
      <input autoFocus value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder ?? "Category name"}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onSave(); } else if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }}
        className="flex-1 min-w-0 bg-white dark:bg-zinc-800 border border-cyan-500/60 rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:border-cyan-500" />
      <IconBtn label="Save" onClick={onSave} disabled={busy}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4 text-emerald-600" />}</IconBtn>
      <IconBtn label="Cancel" onClick={onCancel} disabled={busy}><X className="w-4 h-4" /></IconBtn>
    </div>
  );
}

function IconBtn({ children, onClick, label, disabled, danger, className }: {
  children: React.ReactNode; onClick: () => void; label: string; disabled?: boolean; danger?: boolean; className?: string;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={label} aria-label={label}
      className={cn("w-9 h-9 flex items-center justify-center rounded-md flex-shrink-0 transition-colors disabled:opacity-40",
        danger ? "text-zinc-400 hover:text-rose-600 hover:bg-rose-500/10" : "text-zinc-400 hover:text-cyan-700 dark:hover:text-cyan-300 hover:bg-cyan-500/10",
        className)}>
      {children}
    </button>
  );
}

function TextBtn({ children, onClick, disabled, label }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; label?: string }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={label} aria-label={label}
      className="h-9 px-2 inline-flex items-center gap-1.5 rounded-md text-[13px] text-zinc-500 hover:text-cyan-700 dark:hover:text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-40">
      {children}
    </button>
  );
}
