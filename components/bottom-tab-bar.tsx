"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard, Boxes, ArrowLeftRight, BarChart3, MoreHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";

// Fixed bottom navigation, mobile-only. Five tabs covers most-used routes;
// secondary routes (Godown A/B, Pricing, Audit, Users, Settings) live behind
// the "More" tab as a list.
const TABS = [
  {
    href: "/",
    label: "Home",
    icon: LayoutDashboard,
    match: (p: string) => p === "/" || p === "",
  },
  {
    href: "/items",
    label: "Items",
    icon: Boxes,
    match: (p: string) => p.startsWith("/items"),
  },
  {
    href: "/transactions",
    label: "Txn",
    icon: ArrowLeftRight,
    match: (p: string) => p.startsWith("/transactions"),
  },
  {
    href: "/reports/sales",
    label: "Reports",
    icon: BarChart3,
    match: (p: string) => p.startsWith("/reports"),
  },
  {
    href: "/more",
    label: "More",
    icon: MoreHorizontal,
    match: (p: string) =>
      p.startsWith("/more") ||
      p.startsWith("/godown") ||
      p.startsWith("/reconciliation") ||
      p.startsWith("/pricing") ||
      p.startsWith("/audit") ||
      p.startsWith("/users") ||
      p.startsWith("/settings"),
  },
];

export function BottomTabBar() {
  const pathname = usePathname() ?? "";

  return (
    <nav
      aria-label="Primary"
      className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-white/95 dark:bg-zinc-950/95 backdrop-blur-lg border-t border-zinc-200 dark:border-zinc-800 print:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="flex">
        {TABS.map((t) => {
          const active = t.match(pathname);
          const Icon = t.icon;
          return (
            <li key={t.href} className="flex-1">
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex flex-col items-center justify-center gap-0.5 py-2.5 active:bg-zinc-100 dark:active:bg-zinc-800 transition-colors min-h-[56px]",
                  active
                    ? "text-cyan-600 dark:text-cyan-400"
                    : "text-zinc-500 dark:text-zinc-400"
                )}
              >
                <span
                  className={cn(
                    "rounded-full p-1.5 transition-colors",
                    active ? "bg-cyan-500/15" : ""
                  )}
                >
                  <Icon className="w-5 h-5" strokeWidth={active ? 2.5 : 2} />
                </span>
                <span
                  className={cn(
                    "text-[11px] leading-none",
                    active ? "font-semibold" : ""
                  )}
                >
                  {t.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
