"use client";
import { X, Filter } from "lucide-react";
import { cn } from "@/lib/utils";

// Mobile-only bottom sheet that holds the filter controls a page would
// otherwise cram into the toolbar. Desktop keeps its inline toolbar; on phones
// the page shows just [search] + a "Filters" button that opens this. Each page
// passes its own controls as children (stacked, full-width via <SheetField>).

export function FilterSheet({
  open, onClose, onClear, title = "Filters", children,
}: {
  open: boolean;
  onClose: () => void;
  onClear?: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      className="md:hidden fixed inset-0 z-50 bg-black/50 dark:bg-black/70 flex items-end animate-fade-in"
      role="dialog" aria-modal="true" aria-label={title}
      onClick={onClose}
    >
      <div
        className="w-full bg-white dark:bg-zinc-900 rounded-t-2xl border-t border-zinc-200 dark:border-zinc-800 max-h-[82vh] flex flex-col animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex-shrink-0">
          <div className="flex items-center gap-2 text-sm font-medium"><Filter className="w-4 h-4 text-cyan-500" />{title}</div>
          <div className="flex items-center gap-3">
            {onClear && <button type="button" onClick={onClear} className="text-xs text-zinc-500 hover:text-rose-500">Clear all</button>}
            <button type="button" onClick={onClose} aria-label="Close" className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 p-1"><X className="w-5 h-5" /></button>
          </div>
        </div>
        <div className="p-4 space-y-4 overflow-y-auto">{children}</div>
        <div className="p-4 pt-2 border-t border-zinc-200 dark:border-zinc-800 flex-shrink-0" style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}>
          <button type="button" onClick={onClose} className="w-full bg-cyan-500 hover:bg-cyan-400 text-white rounded-md py-2.5 text-sm font-medium">Show results</button>
        </div>
      </div>
    </div>
  );
}

export function SheetField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-medium mb-1.5">{label}</div>
      {children}
    </div>
  );
}

// "Filters" trigger button for the mobile toolbar. Shows a count badge when
// any filter is active so it's obvious the list is narrowed.
export function FilterButton({ activeCount, onClick }: { activeCount: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "md:hidden inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm border transition-colors flex-shrink-0",
        activeCount > 0
          ? "bg-cyan-500/15 border-cyan-500/50 text-cyan-700 dark:text-cyan-300"
          : "bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300"
      )}
      aria-label="Filters"
    >
      <Filter className="w-4 h-4" />
      Filters
      {activeCount > 0 && (
        <span className="bg-cyan-500 text-white rounded-full text-[10px] min-w-[16px] h-4 px-1 inline-flex items-center justify-center tabular-nums">{activeCount}</span>
      )}
    </button>
  );
}
