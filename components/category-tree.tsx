"use client";
// The category tree — one component for both places it lives:
//   • "browse" (left side of Items): tap a category to see its items; admins
//     get a ⋯ menu per row, can drag items onto a category to move them, and
//     drag a category onto another to nest it.
//   • "manage" (the Categories page): the same tree, full width, with the
//     actions written out as buttons instead of hidden behind ⋯.
//
// Every change goes through the existing admin-gated RPCs
// (category_create / _rename / _move / _archive, set_items_category). Name
// clashes are checked first and explained in words — the database would
// otherwise answer "duplicate key value violates unique constraint".
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown, ChevronRight, Folder, FolderOpen, FolderPlus, MoreHorizontal, Pencil, MoveRight,
  Trash2, ArchiveRestore, Check, X, Loader2, Layers, Inbox, AlertCircle,
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
  /** Say what happened ("Moved 3 items to Fans"). */
  notify: (kind: "ok" | "bad", text: string) => void;
  storageKey?: string;
};

type Editor = { kind: "add"; parentId: string | null } | { kind: "rename"; id: string } | null;

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
  const [deleting, setDeleting] = useState<CatNode | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // A category just made or moved: once the reloaded rows contain it, open
  // every level above it so it is on screen (a new "A / B / C" path used to
  // stay folded away under A).
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
  // The selected category's branch is always open.
  useEffect(() => {
    if (!selected || selected === ALL || selected === NONE) return;
    const byId = new Map(rows.map(r => [r.id, r]));
    const add: string[] = [];
    let cur = byId.get(selected)?.parent_id;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) { seen.add(cur); add.push(cur); cur = byId.get(cur)?.parent_id ?? null; }
    if (add.length) setExpanded(prev => { const n = new Set(prev); add.forEach(a => n.add(a)); return n; });
  }, [selected, rows]);

  useEffect(() => {
    if (!reveal) return;
    const byId = new Map(rows.map(r => [r.id, r]));
    if (!byId.has(reveal)) return;
    const add: string[] = [];
    let cur = byId.get(reveal)?.parent_id;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) { seen.add(cur); add.push(cur); cur = byId.get(cur)?.parent_id ?? null; }
    setExpanded(prev => { const n = new Set(prev); add.forEach(a => n.add(a)); return n; });
    setReveal(null);
  }, [reveal, rows]);

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
  const doMove = async (node: CatNode, target: string | null) => {
    const parentId = target === TOP_LEVEL ? null : target;
    if ((node.parent_id ?? null) === parentId) return;
    if (siblingWithName(rows, parentId, node.name, node.id)) {
      notify("bad", `There is already a “${node.name}” there. Rename one of them first.`);
      return;
    }
    const dest = parentId ? pathById(rows).get(parentId) : "the top level";
    const ok = await run(() => rpc("category_move", { p_id: node.id, p_parent_id: parentId }), `Moved ${node.name} into ${dest}.`);
    if (ok) setReveal(node.id);
  };
  const restore = async (node: CatNode) => {
    if (siblingWithName(rows, node.parent_id ?? null, node.name, node.id)) {
      notify("bad", `A live “${node.name}” already exists there. Rename that one first.`);
      return;
    }
    await run(() => rpc("category_archive", { p_id: node.id, p_archived: false }), `Restored ${node.name}.`);
  };

  // ── drag & drop (desktop) ────────────────────────────────────────────
  const canDnD = isAdmin && mode === "browse";
  const onDragOver = (e: React.DragEvent, target: string) => {
    if (!canDnD) return;
    const types = Array.from(e.dataTransfer.types);
    if (!types.includes(ITEM_DRAG) && !types.includes(CAT_DRAG)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dropTarget !== target) setDropTarget(target);
  };
  const onDrop = (e: React.DragEvent, target: string) => {
    if (!canDnD) return;
    e.preventDefault();
    setDropTarget(null);
    const items = e.dataTransfer.getData(ITEM_DRAG);
    if (items) {
      try {
        const ids = JSON.parse(items) as string[];
        if (ids.length && target !== ALL) onDropItems?.(target === NONE ? null : target, ids);
      } catch { /* ignore */ }
      return;
    }
    const catId = e.dataTransfer.getData(CAT_DRAG);
    if (catId) {
      const node = findNode(tree, catId);
      if (!node || target === NONE) return;
      const parent = target === ALL ? TOP_LEVEL : target;
      if (parent !== TOP_LEVEL && descendantIds(rows, catId).has(parent)) {
        notify("bad", "A category can't go inside itself.");
        return;
      }
      void doMove(node, parent);
    }
  };

  // ── rendering ────────────────────────────────────────────────────────
  const manage = mode === "manage";
  const rowPad = manage ? 20 : 16;

  const renderNode = (node: CatNode): React.ReactNode => {
    const hasKids = node.children.length > 0;
    const open = expanded.has(node.id);
    const isSel = selected === node.id;
    const count = counts.get(node.id) ?? 0;
    const renaming = editor?.kind === "rename" && editor.id === node.id;
    const addingHere = editor?.kind === "add" && editor.parentId === node.id;
    const isDrop = dropTarget === node.id;
    return (
      <Fragment key={node.id}>
        <div
          className={cn(
            "group relative flex items-center gap-1 rounded-lg pr-1 transition-colors",
            manage ? "min-h-11" : "min-h-9",
            isSel ? "bg-cyan-500/10 text-cyan-800 dark:text-cyan-200" : "hover:bg-zinc-100 dark:hover:bg-zinc-800/60",
            isDrop && "ring-2 ring-cyan-500 bg-cyan-500/10",
          )}
          style={{ paddingLeft: node.depth * rowPad }}
          draggable={canDnD && !renaming && !node.archived}
          onDragStart={(e) => { e.dataTransfer.setData(CAT_DRAG, node.id); e.dataTransfer.effectAllowed = "move"; }}
          onDragOver={(e) => onDragOver(e, node.id)}
          onDragLeave={() => setDropTarget(t => (t === node.id ? null : t))}
          onDrop={(e) => onDrop(e, node.id)}
        >
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
                onClick={() => (onSelect ? onSelect(node.id) : hasKids && toggle(node.id))}
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
                    {/* Computer: every action as a button. Phone: a ⋯ menu, so names keep their room. */}
                    <span className="hidden sm:contents">
                      <IconBtn label={`Rename ${node.name}`} onClick={() => { setEditor({ kind: "rename", id: node.id }); setDraft(node.name); }} disabled={busy}><Pencil className="w-4 h-4" /></IconBtn>
                      <IconBtn label={`Move ${node.name}`} onClick={() => setMoving(node)} disabled={busy}><MoveRight className="w-4 h-4" /></IconBtn>
                      <IconBtn label={`Delete ${node.name}`} onClick={() => setDeleting(node)} disabled={busy} danger><Trash2 className="w-4 h-4" /></IconBtn>
                    </span>
                    <span className="relative sm:hidden">
                      <IconBtn label={`Options for ${node.name}`} onClick={() => setMenuFor(m => (m === node.id ? null : node.id))} disabled={busy}><MoreHorizontal className="w-4 h-4" /></IconBtn>
                      {menuFor === node.id && (
                        <RowMenu onClose={() => setMenuFor(null)} items={[
                          { icon: Pencil, label: "Rename", onClick: () => { setEditor({ kind: "rename", id: node.id }); setDraft(node.name); } },
                          { icon: MoveRight, label: "Move into…", onClick: () => setMoving(node) },
                          { icon: Trash2, label: "Delete", onClick: () => setDeleting(node), danger: true },
                        ]} />
                      )}
                    </span>
                  </div>
                ) : (
                  <div className="relative flex-shrink-0">
                    <IconBtn label={`Options for ${node.name}`} onClick={() => setMenuFor(m => (m === node.id ? null : node.id))} disabled={busy}
                      className={cn("md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100", menuFor === node.id && "md:opacity-100")}>
                      <MoreHorizontal className="w-4 h-4" />
                    </IconBtn>
                    {menuFor === node.id && (
                      <RowMenu onClose={() => setMenuFor(null)} items={[
                        { icon: FolderPlus, label: "Add sub-category", onClick: () => { setEditor({ kind: "add", parentId: node.id }); setDraft(""); setExpanded(p => new Set(p).add(node.id)); } },
                        { icon: Pencil, label: "Rename", onClick: () => { setEditor({ kind: "rename", id: node.id }); setDraft(node.name); } },
                        { icon: MoveRight, label: "Move into…", onClick: () => setMoving(node) },
                        { icon: Trash2, label: "Delete", onClick: () => setDeleting(node), danger: true },
                      ]} />
                    )}
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
        dropTarget === id && "ring-2 ring-cyan-500 bg-cyan-500/10",
      )}
      onDragOver={(e) => onDragOver(e, id)}
      onDragLeave={() => setDropTarget(t => (t === id ? null : t))}
      onDrop={(e) => onDrop(e, id)}
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
          Tip: drag items (or a category) onto a category to move them.
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
        onPick={(target) => { const n = moving; setMoving(null); if (n) void doMove(n, target); }}
      />
      {deleting && (
        <DeleteCategoryDialog node={deleting} rows={rows} counts={counts}
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

// ─── delete = move its contents somewhere, then archive ──────────────────
// Nothing is ever lost: the category's own items and its direct
// sub-categories move to the chosen place (its parent by default), then the
// empty category is archived (restorable from "Show archived").
function DeleteCategoryDialog({ node, rows, counts, onClose, onDone, onError }: {
  node: CatNode; rows: CatRow[]; counts: Map<string, number>;
  onClose: () => void; onDone: (msg: string) => void | Promise<void>; onError: (m: string) => void;
}) {
  const [dest, setDest] = useState<string | null>(node.parent_id ?? null);
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
      await onDone(empty ? `Deleted ${node.name}.` : `Deleted ${node.name}; its contents are now in ${destLabel ?? (kids.length ? "the top level" : "No category")}.`);
    } catch (e) {
      const m = friendlyCatError(e);
      setErr(m); onError(m);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 dark:bg-black/70 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in"
      role="dialog" aria-modal="true" aria-label={`Delete ${node.name}`} onClick={() => !busy && onClose()}>
      <div className="bg-white dark:bg-zinc-900 w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-lg border border-zinc-200 dark:border-zinc-800 animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 pt-5 pb-4">
          <h2 className="text-base font-semibold">Delete “{node.name}”?</h2>
          {directItems === null ? (
            !err && <p className="mt-2 text-sm text-zinc-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Checking what is inside…</p>
          ) : empty ? (
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">It is empty. It will be removed from the list (you can bring it back from “Show archived”).</p>
          ) : (
            <>
              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
                Nothing is lost. Its{" "}
                {nItems > 0 && <b>{fmtN(nItems)} item{nItems === 1 ? "" : "s"}</b>}
                {nItems > 0 && kids.length > 0 && " and "}
                {kids.length > 0 && <b>{kids.length} sub-categor{kids.length === 1 ? "y" : "ies"}</b>}
                {" "}move to:
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
            className="bg-rose-600 hover:bg-rose-500 disabled:opacity-40 text-white px-3.5 py-2 rounded-md text-sm font-medium inline-flex items-center gap-1.5">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Delete category
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
