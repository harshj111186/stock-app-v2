"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, TrendingUp, AlertOctagon } from "lucide-react";
import { cn } from "@/lib/utils";

// Segment-control style sub-nav for the three reports. Shown at the top of
// each /reports/* page so a user can switch reports in one tap without
// going back to a hub. Scrolls horizontally on very narrow screens.
const TABS = [
  { href: "/reports/sales",      label: "Sales register", short: "Sales",     icon: BarChart3 },
  { href: "/reports/abc",        label: "ABC analysis",   short: "ABC",       icon: TrendingUp },
  { href: "/reports/dead-stock", label: "Dead stock",     short: "Dead stock", icon: AlertOctagon },
];

export function ReportsSubnav() {
  const pathname = usePathname() ?? "";
  return (
    <div className="mb-5 -mx-4 sm:mx-0 overflow-x-auto no-scrollbar">
      <div className="inline-flex bg-zinc-100 dark:bg-zinc-800/60 rounded-xl p-1 mx-4 sm:mx-0 gap-1 min-w-max">
        {TABS.map((t) => {
          const active = pathname.startsWith(t.href);
          const Icon = t.icon;
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-1.5 px-3 sm:px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap",
                active
                  ? "bg-white dark:bg-zinc-900 text-cyan-600 dark:text-cyan-400 shadow-sm"
                  : "text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100"
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              <span className="sm:hidden">{t.short}</span>
              <span className="hidden sm:inline">{t.label}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
