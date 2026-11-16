"use client";
// Categories — rebuilt 2026-11-16 on the shared CategoryTree (manage mode).
// Any depth: Fans › Ceiling › BLDC › … Every row has its actions written out
// (Sub-category, Rename, Move, Delete); typing "A / B / C" in a new-category
// box makes all three levels at once. Delete never loses anything: the
// category's items and sub-categories move to a place you choose first.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ShieldAlert, Eye, EyeOff, AlertCircle, Check, FolderTree, ArrowRight, Undo2 } from "lucide-react";
import { Shell } from "@/components/shell";
import { useAuth } from "@/app/providers";
import { sb, fetchAllRows } from "@/lib/supabase";
import { rollupCounts, toCatRow, type CatRow } from "@/lib/categories";
import { CategoryTree } from "@/components/category-tree";
import { cn, fmtN } from "@/lib/utils";

export default function CategoriesPage() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";
  const [rows, setRows] = useState<CatRow[]>([]);
  const [direct, setDirect] = useState<Map<string, number>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "bad"; text: string; undo?: () => void } | null>(null);
  const timer = useRef<number | null>(null);

  const notify = useCallback((kind: "ok" | "bad", text: string, undo?: () => void) => {
    setToast({ kind, text, undo });
    if (timer.current) clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), undo ? 8000 : 4500);
  }, []);

  const load = useCallback(async () => {
    const c = sb();
    const [cats, items] = await Promise.all([
      c.from("categories").select("*"),
      fetchAllRows<{ id: string; category_id: string | null }>((f, t) => c.from("items").select("id,category_id").eq("archived", false).order("id").range(f, t)),
    ]);
    if (cats.error || items.error) { setLoadError(cats.error?.message || items.error); setLoaded(true); return; }
    setLoadError(null);
    setRows(((cats.data || []) as any[]).map(toCatRow));
    const m = new Map<string, number>();
    for (const i of items.rows) if (i.category_id) m.set(i.category_id, (m.get(i.category_id) ?? 0) + 1);
    setDirect(m);
    setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const counts = useMemo(() => rollupCounts(rows, direct), [rows, direct]);
  const live = rows.filter(r => !r.archived);
  const nested = live.filter(r => r.parent_id).length;
  const archived = rows.length - live.length;

  if (!isAdmin) {
    return (
      <Shell title="Categories">
        <div className="max-w-md mx-auto mt-12 text-center">
          <ShieldAlert className="w-8 h-8 text-amber-500 mx-auto mb-3" />
          <h1 className="text-lg font-semibold mb-1">Admins only</h1>
          <p className="text-sm text-zinc-500">Only an admin can change categories. You can still browse them on the <Link href="/items" className="text-cyan-700 underline">Items</Link> screen.</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title="Categories">
      <div className="max-w-3xl">
        <div className="mb-5">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Categories</h1>
          <p className="text-sm text-zinc-500 mt-1">
            {!loaded ? "Loading…" : loadError ? "Couldn't load categories." : `${fmtN(live.length)} categories · ${fmtN(nested)} of them inside another`}
          </p>
        </div>

        <p className="sm:hidden mb-3 text-[13px] text-zinc-600 dark:text-zinc-300">Tip: type “Fans / Ceiling / BLDC” to make every level at once. Deleting moves what is inside somewhere first.</p>
        <div className="mb-4 hidden sm:grid sm:grid-cols-3 gap-2 text-[13px]">
          <Tip n="1" text="Drag a category onto the top or bottom edge of another to re-order it, onto its middle to put it inside." />
          <Tip n="2" text="Type “Fans / Ceiling / BLDC” to make every level in one go." />
          <Tip n="3" text="Merge into… or Delete moves its items and sub-categories first. Nothing is lost." />
        </div>

        <div className="flex items-center gap-2 mb-3">
          <Link href="/items" className="text-sm text-cyan-700 dark:text-cyan-300 inline-flex items-center gap-1 hover:underline">
            Move items between categories on the Items screen <ArrowRight className="w-3.5 h-3.5" />
          </Link>
          {archived > 0 && (
            <button type="button" onClick={() => setShowArchived(s => !s)}
              className={cn("ml-auto inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm border transition-colors",
                showArchived ? "bg-amber-500/15 border-amber-500/50 text-amber-700 dark:text-amber-300" : "bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300")}>
              {showArchived ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
              {showArchived ? "Hide deleted" : `Show deleted (${archived})`}
            </button>
          )}
        </div>

        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-2">
          {!loaded ? (
            <div className="p-3 space-y-3">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-5 rounded shimmer" style={{ width: `${40 + (i * 11) % 45}%` }} />)}</div>
          ) : loadError ? (
            <div className="p-3">
              <div className="text-sm text-rose-600 dark:text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-md p-2.5 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /><span className="min-w-0 break-words">{loadError}</span>
              </div>
              <button type="button" onClick={() => void load()} className="mt-3 text-sm text-cyan-700 hover:underline">Retry</button>
            </div>
          ) : (
            <>
              {live.length === 0 && !showArchived && (
                <div className="py-8 text-center">
                  <FolderTree className="w-8 h-8 text-zinc-300 mx-auto mb-2" strokeWidth={1.5} />
                  <div className="text-sm text-zinc-500">No categories yet — make the first one below.</div>
                </div>
              )}
              <CategoryTree mode="manage" rows={rows} counts={counts} totalCount={0} uncategorisedCount={0}
                isAdmin onChanged={load} notify={notify} showArchived={showArchived} storageKey="categories.open" />
            </>
          )}
        </div>
      </div>

      {toast && (
        <div role="status" aria-live="polite"
          className="fixed left-1/2 -translate-x-1/2 z-[70] max-w-[92vw] flex items-center gap-2.5 px-4 py-2.5 rounded-xl shadow-lg text-sm bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 animate-slide-up bottom-[calc(5rem_+_env(safe-area-inset-bottom))] md:bottom-6">
          {toast.kind === "ok" ? <Check className="w-4 h-4 text-emerald-400 dark:text-emerald-600" /> : <AlertCircle className="w-4 h-4 text-rose-400 dark:text-rose-600" />}
          <span className="min-w-0">{toast.text}</span>
          {toast.undo && (
            <button type="button" onClick={() => { const u = toast.undo; setToast(null); u?.(); }}
              className="inline-flex items-center gap-1 px-2.5 py-1 -my-1 rounded-md font-medium text-cyan-300 dark:text-cyan-700 hover:bg-white/10">
              <Undo2 className="w-4 h-4" /> Undo
            </button>
          )}
        </div>
      )}
    </Shell>
  );
}

function Tip({ n, text }: { n: string; text: string }) {
  return (
    <div className="flex gap-2 items-start rounded-lg bg-cyan-500/5 border border-cyan-500/15 px-3 py-2 text-zinc-600 dark:text-zinc-300">
      <span className="w-5 h-5 rounded-full bg-cyan-500 text-white text-[11px] font-semibold flex items-center justify-center flex-shrink-0">{n}</span>
      <span>{text}</span>
    </div>
  );
}
