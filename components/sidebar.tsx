"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard, Boxes, Warehouse, ArrowLeftRight, Receipt,
  BarChart3, TrendingUp, AlertOctagon, ShieldCheck, Users, Settings, LogOut,
  Package, Download, ClipboardCheck, FolderTree,
} from "lucide-react";
import { useAuth } from "@/app/providers";
import { useInstall } from "@/components/install-provider";
import { cn } from "@/lib/utils";

type NavItem = { href: string; label: string; icon: typeof LayoutDashboard; adminOnly?: boolean };

const NAV: { group: string; items: NavItem[] }[] = [
  { group: "Daily", items: [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/items", label: "Items", icon: Boxes },
    { href: "/godown-a", label: "Godown A", icon: Warehouse },
    { href: "/godown-b", label: "Godown B", icon: Warehouse },
    { href: "/transactions", label: "Transactions", icon: ArrowLeftRight },
    { href: "/reconciliation", label: "Reconciliation", icon: ClipboardCheck },
    { href: "/pricing", label: "Pricing", icon: Receipt },
  ]},
  { group: "Reports", items: [
    { href: "/reports/sales", label: "Sales register", icon: BarChart3 },
    { href: "/reports/abc", label: "ABC analysis", icon: TrendingUp },
    { href: "/reports/dead-stock", label: "Dead stock", icon: AlertOctagon },
  ]},
  { group: "System", items: [
    // Admin-gated page — hidden for non-admins here, same as mobile More + ⌘K.
    { href: "/categories", label: "Categories", icon: FolderTree, adminOnly: true },
    { href: "/audit", label: "Audit log", icon: ShieldCheck },
    { href: "/users", label: "Users", icon: Users },
    { href: "/settings", label: "Settings", icon: Settings },
  ]},
];

// Desktop-only sidebar (md+). Mobile uses BottomTabBar instead.
export function Sidebar() {
  const pathname = usePathname();
  const { profile, signOut } = useAuth();
  const { canInstall, install, isStandalone } = useInstall();
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" || pathname === "" : pathname?.startsWith(href);

  return (
    <aside className="hidden md:flex w-60 flex-shrink-0 bg-zinc-50 dark:bg-zinc-900 border-r border-zinc-200 dark:border-zinc-800 flex-col">
      {/* Brand */}
      <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-2.5">
        <div className="w-7 h-7 bg-cyan-500 rounded-md flex items-center justify-center">
          <Package className="w-4 h-4 text-white" strokeWidth={2.5} />
        </div>
        <div>
          <div className="font-semibold text-sm">Stock Manager</div>
          <div className="text-[10px] text-zinc-500">Rye Electricals</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {NAV.map((sec) => (
          <div key={sec.group}>
            <div className="pt-3 pb-1 px-3 text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">{sec.group}</div>
            {sec.items.filter((item) => !item.adminOnly || profile?.role === "admin").map((item) => {
              const Icon = item.icon;
              return (
                <Link key={item.href} href={item.href}
                  className={cn(
                    "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors",
                    isActive(item.href)
                      ? "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-l-2 border-cyan-500 -ml-[2px]"
                      : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100"
                  )}>
                  <Icon className="w-4 h-4" />
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Install banner — only shows when Chrome/Edge fired
          beforeinstallprompt AND the app isn't already in standalone mode.
          Silent when the browser doesn't support PWA install (Safari etc).
          Sidebar is wide enough to carry one extra row; Settings page has
          the full explanation if the user clicks through. */}
      {canInstall && !isStandalone && (
        <button
          type="button"
          onClick={() => { void install(); }}
          className="mx-3 mb-2 px-3 py-2 rounded-md bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-700 dark:text-cyan-300 text-xs font-medium inline-flex items-center gap-2 border border-cyan-500/20"
        >
          <Download className="w-3.5 h-3.5" />
          Install as app
        </button>
      )}

      {/* User */}
      <div className="border-t border-zinc-200 dark:border-zinc-800 p-3 flex items-center gap-3">
        <div className="w-8 h-8 bg-cyan-600 rounded-full flex items-center justify-center text-xs font-semibold text-white">
          {profile?.email?.[0]?.toUpperCase() ?? "?"}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium truncate">{profile?.name || profile?.email}</div>
          <div className="text-[10px] text-zinc-500">{profile?.role}</div>
        </div>
        <button onClick={signOut} className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300" aria-label="Sign out">
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </aside>
  );
}
