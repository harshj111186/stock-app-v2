"use client";
// Category picker — replaces the old indented <select>.
//
// A searchable tree in a sheet (phone) / dialog (desktop):
//   • tap a category to choose it; the chevron opens its sub-categories
//   • search matches anywhere in the full path ("ceil bldc")
//   • admins can make a new category right where it belongs: the "+" on any
//     row adds a sub-category under it, and typing a path such as
//     "Fans / Ceiling / BLDC" creates every missing level in one go
//     (existing levels are reused — category_create is get-or-create).
//
// `CategoryPicker` = the trigger button + sheet (forms). `CategoryPickerSheet`
// = just the sheet, controlled (bulk "Move to…" flows).
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Check, FolderPlus, Folder, FolderOpen, Plus, Search, X, Loader2, CornerDownRight, Ban } from "lucide-react";
import { sb } from "@/lib/supabase";
import {
  buildCategoryTree, flattenTree, pathById, ancestorChain, splitPath, toCatRow, friendlyCatError,
  type CatRow, type CatNode,
} from "@/lib/categories";
import { useEscape } from "@/lib/hooks";
import { cn, normalizeText } from "@/lib/utils";

export const TOP_LEVEL = "__top__";

type SheetProps = {
  open: boolean;
  onClose: () => void;
  rows: CatRow[];
  value: string | null;
  /** id, null for "No category", or TOP_LEVEL when `topLevelLabel` is set. */
  onPick: (id: string | null) => void;
  title?: string;
  /** Offer a "no category" row (items). */
  noneLabel?: string;
  /** Offer a "top level" row (moving a category). */
  topLevelLabel?: string;
  /** Ids that can't be chosen (a category and everything under it). */
  excludeIds?: Set<string>;
  counts?: Map<string, number>;
  canCreate?: boolean;
  /** Called with fresh rows after a category was created here. */
  onRowsChange?: (rows: CatRow[]) => void;
};

// Get-or-create every level of `segs` under `parentId`. Returns the last id.
export async function createCategoryPath(segs: string[], parentId: string | null): Promise<string | null> {
  let parent = parentId;
  for (const name of segs) {
    const { data, error } = await sb().rpc("category_create", { p_name: name, p_parent_id: parent });
    if (error) throw error;
    parent = (data as string) ?? parent;
  }
  return parent;
}

export async function reloadCategories(): Promise<CatRow[] | null> {
  const { data, error } = await sb().from("categories").select("*");
  if (error || !data) return null;
  return (data as any[]).map(toCatRow);
}

export function CategoryPickerSheet({
  open, onClose, rows, value, onPick, title = "Choose a category", noneLabel, topLevelLabel,
  excludeIds, counts, canCreate, onRowsChange,
}: SheetProps) {
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [addUnder, setAddUnder] = useState<string | null | undefined>(undefined); // undefined = closed, null = top level
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEscape(open && !busy, onClose);

  // Opening: clear the search, open the branch that holds the current value.
  useEffect(() => {
    if (!open) return;
    setQ(""); setErr(null); setAddUnder(undefined); setNewName("");
    const chain = value && value !== TOP_LEVEL ? ancestorChain(rows, value) : [];
    setExpanded(new Set(chain.slice(0, -1).map(c => c.id)));
    // Keyboard users get the cursor in search; phones don't (it would pop the keyboard over the list).
    if (typeof window !== "undefined" && window.matchMedia("(pointer:fine)").matches) {
      setTimeout(() => searchRef.current?.focus(), 30);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const live = useMemo(() => rows.filter(r => !r.archived), [rows]);
  const tree = useMemo(() => buildCategoryTree(live), [live]);
  const flat = useMemo(() => flattenTree(tree), [tree]);
  const paths = useMemo(() => pathById(rows), [rows]);

  const query = q.trim();
  const segs = splitPath(query);
  const matches = useMemo(() => {
    if (!query) return [];
    const nq = normalizeText(query.replace(/[\/›>\\]/g, " "));
    const terms = nq.split(" ").filter(Boolean);
    return flat.filter(n => {
      const hay = normalizeText(n.path.join(" "));
      return terms.every(t => hay.includes(t));
    });
  }, [flat, query]);
  // Exact path match → no "create" offer (it already exists).
  const exact = useMemo(() => {
    if (!segs.length) return null;
    const want = segs.map(s => s.toLowerCase()).join("\u0000");
    return flat.find(n => n.path.map(p => p.toLowerCase()).join("\u0000") === want) ?? null;
  }, [flat, segs]);

  const pick = (id: string | null) => { onPick(id); onClose(); };

  async function create(segments: string[], parentId: string | null) {
    if (!segments.length) return;
    setBusy(true); setErr(null);
    try {
      const id = await createCategoryPath(segments, parentId);
      const fresh = await reloadCategories();
      if (fresh) onRowsChange?.(fresh);
      if (id) pick(id);
    } catch (e) {
      setErr(friendlyCatError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  const isExcluded = (id: string) => !!excludeIds?.has(id);
  const toggle = (id: string) => setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // A render function, not a component: a component declared in here would
  // remount on every keystroke (the new-category box would lose its caret).
  const renderRow = (node: CatNode): React.ReactNode => {
    const hasKids = node.children.length > 0;
    const open_ = expanded.has(node.id);
    const selected = value === node.id;
    const disabled = isExcluded(node.id);
    const n = counts?.get(node.id);
    return (
      <Fragment key={node.id}>
        <div className={cn("group flex items-center gap-1 rounded-lg pr-1", selected ? "bg-cyan-500/10" : "hover:bg-zinc-100 dark:hover:bg-zinc-800/60")}
          style={{ paddingLeft: node.depth * 18 }}>
          <button type="button" onClick={() => hasKids && toggle(node.id)} aria-label={open_ ? `Close ${node.name}` : `Open ${node.name}`}
            className={cn("w-9 h-10 flex items-center justify-center flex-shrink-0 text-zinc-400", !hasKids && "invisible")}>
            {open_ ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
          <button type="button" disabled={disabled} onClick={() => pick(node.id)}
            className={cn("flex-1 min-w-0 flex items-center gap-2 h-10 text-left text-[15px] sm:text-sm", disabled && "opacity-40 cursor-not-allowed")}>
            {open_ && hasKids ? <FolderOpen className="w-4 h-4 text-cyan-500 flex-shrink-0" /> : <Folder className="w-4 h-4 text-cyan-500/80 flex-shrink-0" />}
            <span className={cn("truncate", selected && "font-semibold text-cyan-700 dark:text-cyan-300")}>{node.name}</span>
            {n !== undefined && n > 0 && <span className="text-[11px] text-zinc-400 tabular-nums flex-shrink-0">{n}</span>}
            {selected && <Check className="w-4 h-4 text-cyan-600 dark:text-cyan-300 flex-shrink-0 ml-auto" />}
          </button>
          {canCreate && (
            <button type="button" onClick={() => { setAddUnder(node.id); setNewName(""); setExpanded(p => new Set(p).add(node.id)); }}
              title={`Add a sub-category in ${node.name}`} aria-label={`Add a sub-category in ${node.name}`}
              className="w-9 h-9 flex items-center justify-center rounded-md text-zinc-400 hover:text-cyan-600 hover:bg-cyan-500/10 flex-shrink-0">
              <Plus className="w-4 h-4" />
            </button>
          )}
        </div>
        {addUnder === node.id && (
          <NewRow depth={node.depth + 1} value={newName} onChange={setNewName} busy={busy}
            placeholder={`New in ${node.name}…`}
            onSave={() => create(splitPath(newName), node.id)} onCancel={() => setAddUnder(undefined)} />
        )}
        {open_ && node.children.map(c => renderRow(c))}
      </Fragment>
    );
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 dark:bg-black/70 flex items-end sm:items-center justify-center sm:p-4 animate-fade-in"
      role="dialog" aria-modal="true" aria-label={title} onClick={() => !busy && onClose()}>
      <div className="bg-white dark:bg-zinc-900 w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl shadow-lg border border-zinc-200 dark:border-zinc-800 flex flex-col max-h-[88vh] sm:max-h-[75vh] animate-slide-up"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-4 pt-3.5 pb-3 border-b border-zinc-200 dark:border-zinc-800 flex-shrink-0">
          <div className="flex items-center justify-between gap-3 mb-2.5">
            <h2 className="text-base font-semibold">{title}</h2>
            <button type="button" onClick={onClose} aria-label="Close" className="w-9 h-9 -mr-2 flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X className="w-5 h-5" /></button>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400 pointer-events-none" />
            <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (matches.length === 1 && !isExcluded(matches[0].id)) pick(matches[0].id);
                else if (exact && !isExcluded(exact.id)) pick(exact.id);
                else if (canCreate && segs.length && !exact) void create(segs, null);
              }}
              placeholder={canCreate ? "Search, or type a new one (Fans / Ceiling)" : "Search categories"}
              aria-label="Search categories"
              className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg pl-9 pr-3 py-2.5 text-[15px] sm:text-sm focus:outline-none focus:border-cyan-500" />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {err && <div className="mx-1 mb-2 text-sm text-rose-700 dark:text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-md px-3 py-2">{err}</div>}

          {!query && (topLevelLabel || noneLabel) && (
            <button type="button" onClick={() => pick(topLevelLabel ? TOP_LEVEL : null)}
              className={cn("w-full flex items-center gap-2 h-10 px-3 rounded-lg text-left text-[15px] sm:text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800/60",
                (topLevelLabel ? value === TOP_LEVEL : value === null) && "bg-cyan-500/10 font-semibold text-cyan-700 dark:text-cyan-300")}>
              {topLevelLabel ? <CornerDownRight className="w-4 h-4 text-zinc-400" /> : <Ban className="w-4 h-4 text-zinc-400" />}
              {topLevelLabel ?? noneLabel}
            </button>
          )}

          {query ? (
            <>
              {canCreate && segs.length > 0 && !exact && (
                <button type="button" disabled={busy} onClick={() => void create(segs, null)}
                  className="w-full flex items-start gap-2 px-3 py-2.5 rounded-lg text-left hover:bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 mb-1">
                  {busy ? <Loader2 className="w-4 h-4 mt-0.5 animate-spin" /> : <FolderPlus className="w-4 h-4 mt-0.5 flex-shrink-0" />}
                  <span className="text-[15px] sm:text-sm min-w-0">
                    Create <b className="break-words">{segs.join(" › ")}</b>
                    {segs.length > 1 && <span className="block text-[11px] text-zinc-500 font-normal">Makes each level that doesn't exist yet; reuses the ones that do.</span>}
                  </span>
                </button>
              )}
              {matches.length === 0 && !canCreate && <div className="py-8 text-center text-sm text-zinc-500">No category matches “{query}”.</div>}
              {matches.map(n => {
                const disabled = isExcluded(n.id);
                const sel = value === n.id;
                return (
                  <button key={n.id} type="button" disabled={disabled} onClick={() => pick(n.id)}
                    className={cn("w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left hover:bg-zinc-100 dark:hover:bg-zinc-800/60", sel && "bg-cyan-500/10", disabled && "opacity-40 cursor-not-allowed")}>
                    <Folder className="w-4 h-4 text-cyan-500/80 flex-shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] sm:text-sm truncate font-medium">{n.name}</span>
                      {n.path.length > 1 && <span className="block text-[11px] text-zinc-500 truncate">{n.path.slice(0, -1).join(" › ")}</span>}
                    </span>
                    {sel && <Check className="w-4 h-4 text-cyan-600 flex-shrink-0" />}
                  </button>
                );
              })}
            </>
          ) : tree.length === 0 ? (
            <div className="py-8 text-center text-sm text-zinc-500">No categories yet.{canCreate && " Type a name above to make the first one."}</div>
          ) : (
            tree.map(n => renderRow(n))
          )}

          {!query && canCreate && (
            addUnder === null ? (
              <NewRow depth={0} value={newName} onChange={setNewName} busy={busy} placeholder="New main category…"
                onSave={() => create(splitPath(newName), null)} onCancel={() => setAddUnder(undefined)} />
            ) : (
              <button type="button" onClick={() => { setAddUnder(null); setNewName(""); }}
                className="mt-1 w-full flex items-center gap-2 h-10 px-3 rounded-lg text-left text-sm text-cyan-700 dark:text-cyan-300 hover:bg-cyan-500/10">
                <FolderPlus className="w-4 h-4" /> New main category
              </button>
            )
          )}
        </div>
        {value && value !== TOP_LEVEL && paths.get(value) && (
          <div className="px-4 py-2.5 border-t border-zinc-200 dark:border-zinc-800 text-[12px] text-zinc-500 truncate flex-shrink-0"
            style={{ paddingBottom: "calc(0.625rem + env(safe-area-inset-bottom))" }}>
            Now: <span className="text-zinc-700 dark:text-zinc-200">{paths.get(value)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function NewRow({ depth, value, onChange, onSave, onCancel, busy, placeholder }: {
  depth: number; value: string; onChange: (v: string) => void; onSave: () => void; onCancel: () => void; busy: boolean; placeholder: string;
}) {
  return (
    <div className="flex items-center gap-1.5 py-1 pr-1" style={{ paddingLeft: depth * 18 + 10 }}>
      <FolderPlus className="w-4 h-4 text-cyan-500 flex-shrink-0" />
      <input autoFocus value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (value.trim()) onSave(); } else if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }}
        aria-label="New category name"
        className="flex-1 min-w-0 bg-white dark:bg-zinc-800 border border-cyan-500/50 rounded-md px-2.5 py-2 text-[15px] sm:text-sm focus:outline-none focus:border-cyan-500" />
      <button type="button" onClick={onSave} disabled={busy || !value.trim()}
        className="h-9 px-3 rounded-md bg-cyan-500 text-white text-sm font-medium disabled:opacity-40 inline-flex items-center gap-1">
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Add
      </button>
      <button type="button" onClick={onCancel} aria-label="Cancel" className="w-9 h-9 flex items-center justify-center text-zinc-400 hover:text-zinc-700"><X className="w-4 h-4" /></button>
    </div>
  );
}

// Trigger + sheet, for forms. Shows the chosen category's full path.
export function CategoryPicker({
  rows, value, onChange, placeholder = "Choose a category", className, id, ...rest
}: Omit<SheetProps, "open" | "onClose" | "onPick" | "value"> & {
  value: string | null;
  onChange: (id: string | null) => void;
  placeholder?: string;
  className?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const paths = useMemo(() => pathById(rows), [rows]);
  const label = value ? paths.get(value) ?? "Unknown category" : null;
  const archived = value ? rows.find(r => r.id === value)?.archived : false;
  return (
    <>
      <button type="button" id={id} onClick={() => setOpen(true)}
        className={cn("w-full flex items-center gap-2 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-2.5 sm:py-2 text-left text-[15px] sm:text-sm hover:border-cyan-500/60 focus:outline-none focus:border-cyan-500", className)}>
        <Folder className="w-4 h-4 text-cyan-500 flex-shrink-0" />
        <span className={cn("flex-1 min-w-0 truncate", !label && "text-zinc-400")}>
          {label ?? (rest.noneLabel && value === null ? rest.noneLabel : placeholder)}
          {archived && <span className="text-amber-600 text-xs"> (deleted)</span>}
        </span>
        <ChevronDown className="w-4 h-4 text-zinc-400 flex-shrink-0" />
      </button>
      <CategoryPickerSheet {...rest} rows={rows} open={open} onClose={() => setOpen(false)} value={value} onPick={(v) => onChange(v === TOP_LEVEL ? null : v)} />
    </>
  );
}
