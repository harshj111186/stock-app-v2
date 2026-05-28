"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FolderTree, FolderPlus, Plus, Pencil, Archive, ArchiveRestore, ChevronRight, ChevronDown,
  Loader2, Check, X, MoveRight, AlertCircle, ShieldAlert, Eye, EyeOff,
} from "lucide-react";
import { Shell } from "@/components/shell";
import { useAuth } from "@/app/providers";
import { sb } from "@/lib/supabase";
import { buildCategoryTree, type CatNode, type CatRow } from "@/lib/categories";
import { CategoryTreePicker } from "@/components/category-tree-picker";
import { cn } from "@/lib/utils";

export default function CategoriesPage() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";

  const [rows, setRows] = useState<CatRow[]>([]);
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const toastTimer = useRef<number | null>(null);

  // Inline editing state
  const [addingUnder, setAddingUnder] = useState<string | null | "root">(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [movingNode, setMovingNode] = useState<CatNode | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const showToast = (kind: "ok" | "bad", text: string) => {
    setToast({ kind, text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  };

  const load = useCallback(async () => {
    const c = sb();
    const [{ data: cats }, { data: items }] = await Promise.all([
      c.from("categories").select("*"),
      c.from("items").select("category_id").eq("archived", false),
    ]);
    setRows(((cats || []) as any[]).map(x => ({
      id: x.id, name: x.name, parent_id: x.parent_id ?? null,
      sort_order: x.sort_order ?? 0, archived: x.archived ?? false,
    })));
    const cmap = new Map<string, number>();
    (items || []).forEach((i: any) => {
      if (i.category_id) cmap.set(i.category_id, (cmap.get(i.category_id) || 0) + 1);
    });
    setCounts(cmap);
    setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const tree = useMemo(() => buildCategoryTree(rows, showArchived), [rows, showArchived]);

  const toggle = (id: string) => setExpanded(prev => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n;
  });

  // ── RPC actions ──────────────────────────────────────────────────────────
  const runRpc = async (fn: string, args: Record<string, unknown>, okMsg: string) => {
    setBusy(true);
    try {
      const { error } = await sb().rpc(fn, args);
      if (error) throw error;
      await load();
      showToast("ok", okMsg);
      return true;
    } catch (e: any) {
      showToast("bad", e?.message || "Action failed.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addCategory = async (parentId: string | null) => {
    const name = draftName.trim();
    if (!name) { setAddingUnder(null); return; }
    const ok = await runRpc("category_create", { p_name: name, p_parent_id: parentId }, `Added “${name}”.`);
    if (ok) { if (parentId) setExpanded(p => new Set(p).add(parentId)); }
    setAddingUnder(null); setDraftName("");
  };
  const rename = async (id: string) => {
    const name = draftName.trim();
    if (!name) { setRenamingId(null); return; }
    await runRpc("category_rename", { p_id: id, p_name: name }, "Renamed.");
    setRenamingId(null); setDraftName("");
  };
  const archive = async (n: CatNode) => {
    if (!confirm(`Archive “${n.name}”? Items keep their history; the category leaves the picker.`)) return;
    await runRpc("category_archive", { p_id: n.id, p_archived: true }, "Archived.");
  };
  const move = async (id: string, parentId: string | null) => {
    const ok = await runRpc("category_move", { p_id: id, p_parent_id: parentId }, "Moved.");
    if (ok) setMovingNode(null);
  };
  const restore = async (n: CatNode) => {
    await runRpc("category_archive", { p_id: n.id, p_archived: false }, `Restored “${n.name}”.`);
  };

  if (!isAdmin) {
    return (
      <Shell title="Categories">
        <div className="max-w-md mx-auto mt-12 text-center">
          <ShieldAlert className="w-8 h-8 text-amber-500 mx-auto mb-3" />
          <h1 className="text-lg font-semibold mb-1">Admins only</h1>
          <p className="text-sm text-zinc-500">Category management is restricted to admins. Ask an admin to set up the catalogue structure.</p>
        </div>
      </Shell>
    );
  }

  const totalActive = rows.filter(r => !r.archived).length;
  const nested = rows.filter(r => r.parent_id && !r.archived).length;

  return (
    <Shell title="Categories">
      <div className="mb-5">
        <div className="flex items-center gap-3 mb-1">
          <FolderTree className="w-5 h-5 text-cyan-600 dark:text-cyan-400" />
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Categories</h1>
        </div>
        <p className="text-sm text-zinc-500">
          {loaded ? <>{totalActive} categories · {nested} nested. Build any depth — Company › Category › Sub › …</> : "Loading…"}
        </p>
      </div>

      <div className="flex items-center gap-2 mb-4">
        <button
          type="button"
          onClick={() => { setAddingUnder("root"); setDraftName(""); }}
          className="bg-cyan-500 hover:bg-cyan-400 text-white px-3 py-1.5 rounded-md text-sm font-medium inline-flex items-center gap-1.5"
        >
          <FolderPlus className="w-4 h-4" /> Add top-level category
        </button>
        {busy && <Loader2 className="w-4 h-4 animate-spin text-zinc-400" />}
        <button
          type="button"
          onClick={() => setShowArchived(s => !s)}
          className={cn(
            "ml-auto inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm border transition-colors",
            showArchived
              ? "bg-amber-500/15 border-amber-500/50 text-amber-700 dark:text-amber-300"
              : "bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300"
          )}
        >
          {showArchived ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
          {showArchived ? "Showing archived" : "Show archived"}
        </button>
      </div>

      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden">
        {!loaded ? (
          <div className="p-5 space-y-3">
            {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-5 rounded shimmer" style={{ width: `${40 + (i * 11) % 45}%` }} />)}
          </div>
        ) : tree.length === 0 && addingUnder !== "root" ? (
          <div className="py-14 text-center">
            <FolderTree className="w-8 h-8 text-zinc-400 dark:text-zinc-600 mx-auto mb-3" strokeWidth={1.5} />
            <div className="text-sm text-zinc-500 mb-3">No categories yet.</div>
            <button onClick={() => { setAddingUnder("root"); setDraftName(""); }} className="text-sm text-cyan-600 dark:text-cyan-400 hover:underline">Add your first category</button>
          </div>
        ) : (
          <div className="py-1.5">
            {addingUnder === "root" && (
              <InlineAdd depth={0} value={draftName} onChange={setDraftName}
                onSave={() => addCategory(null)} onCancel={() => { setAddingUnder(null); setDraftName(""); }} />
            )}
            {tree.map(node => (
              <TreeRow
                key={node.id} node={node} expanded={expanded} toggle={toggle}
                counts={counts}
                addingUnder={addingUnder} setAddingUnder={setAddingUnder}
                renamingId={renamingId} setRenamingId={setRenamingId}
                draftName={draftName} setDraftName={setDraftName}
                onAdd={addCategory} onRename={rename} onArchive={archive} onMove={setMovingNode}
                onRestore={restore} busy={busy}
              />
            ))}
          </div>
        )}
      </div>

      <p className="text-xs text-zinc-500 mt-3">
        Tip: assign an item to any category (at any depth) from the item's <b>Edit details</b> screen. Archiving a category needs its subcategories handled first.
      </p>

      {movingNode && (
        <MoveModal node={movingNode} rows={rows} onClose={() => setMovingNode(null)} onMove={move} busy={busy} />
      )}

      {toast && (
        <div className={cn(
          "fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg shadow-lg text-sm font-medium",
          toast.kind === "ok" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/40",
          toast.kind === "bad" && "bg-rose-500/15 text-rose-700 dark:text-rose-300 border border-rose-500/40",
        )}>
          {toast.text}
        </div>
      )}
    </Shell>
  );
}

// ── one node + its subtree ───────────────────────────────────────────────
function TreeRow({
  node, expanded, toggle, counts,
  addingUnder, setAddingUnder, renamingId, setRenamingId, draftName, setDraftName,
  onAdd, onRename, onArchive, onMove, onRestore, busy,
}: {
  node: CatNode;
  expanded: Set<string>;
  toggle: (id: string) => void;
  counts: Map<string, number>;
  addingUnder: string | null | "root";
  setAddingUnder: (v: string | null | "root") => void;
  renamingId: string | null;
  setRenamingId: (v: string | null) => void;
  draftName: string;
  setDraftName: (v: string) => void;
  onAdd: (parentId: string | null) => void;
  onRename: (id: string) => void;
  onArchive: (n: CatNode) => void;
  onMove: (n: CatNode) => void;
  onRestore: (n: CatNode) => void;
  busy: boolean;
}) {
  const hasChildren = node.children.length > 0;
  const open = expanded.has(node.id);
  const count = counts.get(node.id) || 0;
  const isRenaming = renamingId === node.id;

  return (
    <div>
      <div
        className="group flex items-center gap-1.5 pr-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 rounded-md"
        style={{ paddingLeft: `${node.depth * 18 + 8}px` }}
      >
        <button
          type="button"
          onClick={() => hasChildren && toggle(node.id)}
          className={cn("p-0.5 rounded text-zinc-400 flex-shrink-0", hasChildren ? "hover:text-zinc-700 dark:hover:text-zinc-200" : "opacity-0 pointer-events-none")}
          aria-label={open ? "Collapse" : "Expand"}
        >
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>

        {isRenaming ? (
          <InlineEditField
            value={draftName} onChange={setDraftName}
            onSave={() => onRename(node.id)} onCancel={() => { setRenamingId(null); setDraftName(""); }}
          />
        ) : (
          <>
            <span className={cn("text-sm font-medium truncate", node.archived && "text-zinc-400 dark:text-zinc-600 line-through")}>{node.name}</span>
            {node.archived && <span className="text-[10px] text-amber-600 dark:text-amber-400 flex-shrink-0">archived</span>}
            {count > 0 && (
              <span className="text-[10px] bg-zinc-200/70 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 px-1.5 py-0.5 rounded tabular-nums flex-shrink-0">{count}</span>
            )}
            <div className="flex-1" />
            <div className="flex items-center gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
              {node.archived ? (
                <IconBtn title="Restore" onClick={() => onRestore(node)} disabled={busy}><ArchiveRestore className="w-3.5 h-3.5 text-emerald-500" /></IconBtn>
              ) : (
                <>
                  <IconBtn title="Add subcategory" onClick={() => { setAddingUnder(node.id); setDraftName(""); }} disabled={busy}><Plus className="w-3.5 h-3.5" /></IconBtn>
                  <IconBtn title="Rename" onClick={() => { setRenamingId(node.id); setDraftName(node.name); }} disabled={busy}><Pencil className="w-3.5 h-3.5" /></IconBtn>
                  <IconBtn title="Move" onClick={() => onMove(node)} disabled={busy}><MoveRight className="w-3.5 h-3.5" /></IconBtn>
                  <IconBtn title="Archive" onClick={() => onArchive(node)} disabled={busy} danger><Archive className="w-3.5 h-3.5" /></IconBtn>
                </>
              )}
            </div>
          </>
        )}
      </div>

      {addingUnder === node.id && (
        <InlineAdd depth={node.depth + 1} value={draftName} onChange={setDraftName}
          onSave={() => onAdd(node.id)} onCancel={() => { setAddingUnder(null); setDraftName(""); }} />
      )}

      {open && node.children.map(child => (
        <TreeRow
          key={child.id} node={child} expanded={expanded} toggle={toggle} counts={counts}
          addingUnder={addingUnder} setAddingUnder={setAddingUnder}
          renamingId={renamingId} setRenamingId={setRenamingId}
          draftName={draftName} setDraftName={setDraftName}
          onAdd={onAdd} onRename={onRename} onArchive={onArchive} onMove={onMove} onRestore={onRestore} busy={busy}
        />
      ))}
    </div>
  );
}

function InlineAdd({ depth, value, onChange, onSave, onCancel }: {
  depth: number; value: string; onChange: (v: string) => void; onSave: () => void; onCancel: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5 pr-3 py-1.5" style={{ paddingLeft: `${depth * 18 + 30}px` }}>
      <FolderPlus className="w-3.5 h-3.5 text-cyan-500 flex-shrink-0" />
      <InlineEditField value={value} onChange={onChange} onSave={onSave} onCancel={onCancel} placeholder="New category name…" autoFocus />
    </div>
  );
}

function InlineEditField({ value, onChange, onSave, onCancel, placeholder, autoFocus }: {
  value: string; onChange: (v: string) => void; onSave: () => void; onCancel: () => void; placeholder?: string; autoFocus?: boolean;
}) {
  return (
    <div className="flex items-center gap-1 flex-1 min-w-0">
      <input
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") onSave(); else if (e.key === "Escape") onCancel(); }}
        placeholder={placeholder}
        className="flex-1 min-w-0 bg-white dark:bg-zinc-800 border border-cyan-500/50 rounded-md px-2 py-1 text-sm focus:outline-none focus:border-cyan-500"
      />
      <IconBtn title="Save" onClick={onSave}><Check className="w-3.5 h-3.5 text-emerald-500" /></IconBtn>
      <IconBtn title="Cancel" onClick={onCancel}><X className="w-3.5 h-3.5" /></IconBtn>
    </div>
  );
}

function IconBtn({ children, onClick, title, disabled, danger }: {
  children: React.ReactNode; onClick: () => void; title: string; disabled?: boolean; danger?: boolean;
}) {
  return (
    <button
      type="button" onClick={onClick} disabled={disabled} title={title} aria-label={title}
      className={cn(
        "p-1.5 rounded-md transition-colors disabled:opacity-40",
        danger ? "text-zinc-400 hover:text-rose-500 hover:bg-rose-500/10" : "text-zinc-400 hover:text-cyan-600 dark:hover:text-cyan-300 hover:bg-cyan-500/10"
      )}
    >
      {children}
    </button>
  );
}

function MoveModal({ node, rows, onClose, onMove, busy }: {
  node: CatNode; rows: CatRow[]; onClose: () => void; onMove: (id: string, parentId: string | null) => void; busy: boolean;
}) {
  const [parentId, setParentId] = useState<string>(node.parent_id ?? "");
  // Exclude the node itself + its descendants from valid parents (no cycles).
  const descendantIds = useMemo(() => {
    const ids = new Set<string>([node.id]);
    const walk = (n: CatNode) => { for (const c of n.children) { ids.add(c.id); walk(c); } };
    walk(node);
    return ids;
  }, [node]);
  const validRows = rows.filter(r => !r.archived && !descendantIds.has(r.id));

  return (
    <div className="fixed inset-0 z-50 bg-black/50 dark:bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-900 rounded-t-2xl sm:rounded-2xl w-full max-w-md shadow-lg border border-zinc-200 dark:border-zinc-800 animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
          <h2 className="text-base font-semibold truncate">Move “{node.name}”</h2>
          <button onClick={onClose} aria-label="Close" className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 p-1"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-3">
          <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-medium">New parent</div>
          <CategoryTreePicker rows={validRows} value={parentId} onChange={setParentId}
            className="w-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-cyan-500" />
          <p className="text-xs text-zinc-500">Choose “— none —” to make it a top-level category. Its own subcategories aren't shown (a category can't move inside itself).</p>
        </div>
        <div className="px-5 py-3 border-t border-zinc-200 dark:border-zinc-800 flex justify-end gap-2 bg-zinc-50 dark:bg-zinc-900/50" style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}>
          <button onClick={onClose} className="px-3 py-2 text-sm text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded-md">Cancel</button>
          <button onClick={() => onMove(node.id, parentId || null)} disabled={busy}
            className="bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 text-white px-3.5 py-2 rounded-md text-sm font-medium inline-flex items-center gap-1.5">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MoveRight className="w-3.5 h-3.5" />} Move
          </button>
        </div>
      </div>
    </div>
  );
}
