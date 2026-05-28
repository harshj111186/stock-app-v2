"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  LayoutDashboard, Boxes, Warehouse, ArrowLeftRight, ClipboardCheck, Receipt,
  BarChart3, TrendingUp, AlertOctagon, ShieldCheck, Users, Settings,
  Search, Plus, CornerDownLeft, Command,
} from "lucide-react";
import { useAuth } from "@/app/providers";
import { cn } from "@/lib/utils";

// ─── Command palette (⌘K / Ctrl+K) ────────────────────────────────────────
// Replaces the old dead "Search" button in the topbar with a real navigator.
// Mounted once inside <Shell>. Opens on ⌘K, on Escape closes, and on a
// `open-command-palette` window event (dispatched by the topbar button).
// Keyboard-first: type to filter, ↑/↓ to move, Enter to run.
//
// Kept deliberately lightweight — pure client navigation + a couple of quick
// actions. No data fetching, so it adds ~nothing to the initial payload.

type Cmd = {
  id: string;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  href: string;
  keywords?: string;
  adminOnly?: boolean;
  group: "Go to" | "Actions";
};

const COMMANDS: Cmd[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, href: "/", group: "Go to", keywords: "home overview" },
  { id: "items", label: "Items", icon: Boxes, href: "/items", group: "Go to", keywords: "catalogue products skus" },
  { id: "godown-a", label: "Godown A", icon: Warehouse, href: "/godown-a", group: "Go to", keywords: "warehouse stock" },
  { id: "godown-b", label: "Godown B", icon: Warehouse, href: "/godown-b", group: "Go to", keywords: "warehouse stock" },
  { id: "transactions", label: "Transactions", icon: ArrowLeftRight, href: "/transactions", group: "Go to", keywords: "purchase sale transfer adjustment return log" },
  { id: "reconciliation", label: "Reconciliation", icon: ClipboardCheck, href: "/reconciliation", group: "Go to", keywords: "stock take count physical" },
  { id: "pricing", label: "Pricing", icon: Receipt, href: "/pricing", group: "Go to", keywords: "lp discount gst rate" },
  { id: "sales", label: "Sales register", icon: BarChart3, href: "/reports/sales", group: "Go to", keywords: "report revenue" },
  { id: "abc", label: "ABC analysis", icon: TrendingUp, href: "/reports/abc", group: "Go to", keywords: "report pareto" },
  { id: "dead-stock", label: "Dead stock", icon: AlertOctagon, href: "/reports/dead-stock", group: "Go to", keywords: "report idle no movement" },
  { id: "audit", label: "Audit log", icon: ShieldCheck, href: "/audit", group: "Go to", keywords: "history changes", adminOnly: true },
  { id: "users", label: "Users", icon: Users, href: "/users", group: "Go to", keywords: "accounts roles approve", adminOnly: true },
  { id: "settings", label: "Settings", icon: Settings, href: "/settings", group: "Go to", keywords: "account pin install categories" },
  // Quick actions
  { id: "new-item", label: "Add a new item", hint: "Items", icon: Plus, href: "/items?new=1", group: "Actions", keywords: "create product sku" },
  { id: "new-txn", label: "Log a transaction", hint: "Transactions", icon: Plus, href: "/transactions", group: "Actions", keywords: "purchase sale entry" },
  { id: "start-recon", label: "Start a stock count", hint: "Reconciliation", icon: Plus, href: "/reconciliation", group: "Actions", keywords: "reconcile physical" },
];

export function CommandPalette() {
  const router = useRouter();
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Open via ⌘K / Ctrl+K (and the topbar button's window event); close on Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("open-command-palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("open-command-palette", onOpen);
    };
  }, []);

  // Reset + focus whenever it opens.
  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
      // Focus after paint so the input is mounted.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const results = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return COMMANDS.filter((c) => {
      if (c.adminOnly && !isAdmin) return false;
      if (!ql) return true;
      return (c.label + " " + (c.hint || "") + " " + (c.keywords || "")).toLowerCase().includes(ql);
    });
  }, [q, isAdmin]);

  // Keep the active index in range as results shrink.
  useEffect(() => { setActive((a) => Math.min(a, Math.max(0, results.length - 1))); }, [results.length]);

  const run = (c: Cmd) => {
    setOpen(false);
    router.push(c.href);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const c = results[active]; if (c) run(c); }
  };

  // Scroll the active row into view.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  if (!open) return null;

  let lastGroup = "";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[12vh] bg-black/50 dark:bg-black/70 backdrop-blur-sm animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-lg overflow-hidden animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-4 border-b border-zinc-200 dark:border-zinc-800">
          <Search className="w-4 h-4 text-zinc-400 flex-shrink-0" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setActive(0); }}
            onKeyDown={onKeyDown}
            placeholder="Jump to a page or action…"
            className="flex-1 bg-transparent py-3.5 text-sm focus:outline-none placeholder:text-zinc-400"
          />
          <kbd className="hidden sm:inline-flex items-center gap-1 text-[10px] font-mono text-zinc-400 bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">esc</kbd>
        </div>

        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-2">
          {results.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-zinc-500">No matches for “{q}”.</div>
          ) : (
            results.map((c, idx) => {
              const Icon = c.icon;
              const showGroup = c.group !== lastGroup;
              lastGroup = c.group;
              return (
                <div key={c.id}>
                  {showGroup && (
                    <div className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-wider text-zinc-400 font-semibold">{c.group}</div>
                  )}
                  <button
                    type="button"
                    data-idx={idx}
                    onMouseMove={() => setActive(idx)}
                    onClick={() => run(c)}
                    className={cn(
                      "w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors",
                      idx === active
                        ? "bg-cyan-500/10 text-cyan-700 dark:text-cyan-300"
                        : "text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
                    )}
                  >
                    <Icon className={cn("w-4 h-4 flex-shrink-0", idx === active ? "text-cyan-600 dark:text-cyan-400" : "text-zinc-400")} />
                    <span className="flex-1 min-w-0 truncate">{c.label}</span>
                    {c.hint && <span className="text-[11px] text-zinc-400 flex-shrink-0">{c.hint}</span>}
                    {idx === active && <CornerDownLeft className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />}
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-3 px-4 py-2 border-t border-zinc-200 dark:border-zinc-800 text-[10px] text-zinc-400">
          <span className="inline-flex items-center gap-1"><Command className="w-3 h-3" />K to toggle</span>
          <span className="inline-flex items-center gap-1">↑↓ navigate</span>
          <span className="inline-flex items-center gap-1"><CornerDownLeft className="w-3 h-3" /> open</span>
        </div>
      </div>
    </div>
  );
}
