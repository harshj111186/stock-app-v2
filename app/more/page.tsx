"use client";
import Link from "next/link";
import {
  Warehouse, Receipt, ShieldCheck, Users, Settings, LogOut,
  ChevronRight, Download, ClipboardCheck,
} from "lucide-react";
import { Shell } from "@/components/shell";
import { useAuth } from "@/app/providers";
import { useInstall } from "@/components/install-provider";

// Mobile "More" hub. Lists every route that isn't on the bottom tab bar.
// Admin-only rows render only for admin users. Desktop sidebar still shows
// these directly, so this page is primarily a phone experience.
type Row = {
  href: string;
  label: string;
  sub?: string;
  icon: typeof Warehouse;
  adminOnly?: boolean;
};

const ROWS: Row[] = [
  { href: "/godown-a", label: "Godown A", sub: "Stock at warehouse A", icon: Warehouse },
  { href: "/godown-b", label: "Godown B", sub: "Stock at warehouse B", icon: Warehouse },
  { href: "/reconciliation", label: "Reconciliation", sub: "Physical stock-take + paper count sheet", icon: ClipboardCheck },
  { href: "/pricing",  label: "Pricing",  sub: "LP, stacked discounts, GST", icon: Receipt },
  { href: "/audit",    label: "Audit log", sub: "Every DB change, auto-logged", icon: ShieldCheck, adminOnly: true },
  { href: "/users",    label: "Users",    sub: "Manage staff and roles", icon: Users, adminOnly: true },
  { href: "/settings", label: "Settings", sub: "Account and preferences", icon: Settings },
];

export default function MorePage() {
  const { profile, signOut } = useAuth();
  const { canInstall, install, isStandalone } = useInstall();
  const isAdmin = profile?.role === "admin";

  return (
    <Shell title="More">
      <div className="max-w-2xl mx-auto space-y-5">
        {/* Profile card */}
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-5 flex items-center gap-4 shadow-sm">
          <div className="w-12 h-12 bg-cyan-600 rounded-full flex items-center justify-center text-base font-semibold text-white flex-shrink-0">
            {profile?.email?.[0]?.toUpperCase() ?? "?"}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{profile?.name || profile?.email}</div>
            <div className="text-xs text-zinc-500 mt-0.5">
              <span className="inline-block bg-cyan-500/15 text-cyan-600 dark:text-cyan-300 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-medium mr-2">{profile?.role}</span>
              {profile?.email}
            </div>
          </div>
        </div>

        {/* Install banner — only when the browser will accept the prompt and
            the app isn't already running standalone. iOS Safari / desktop
            Firefox don't fire beforeinstallprompt, so this stays hidden for
            them; Settings page has the manual instructions for those cases. */}
        {canInstall && !isStandalone && (
          <button
            type="button"
            onClick={() => { void install(); }}
            className="w-full bg-cyan-500 hover:bg-cyan-400 active:bg-cyan-600 text-white rounded-2xl px-4 py-4 flex items-center gap-4 shadow-sm"
          >
            <span className="w-10 h-10 bg-white/15 rounded-xl flex items-center justify-center flex-shrink-0">
              <Download className="w-5 h-5" />
            </span>
            <span className="flex-1 text-left">
              <span className="block text-sm font-semibold">Install Stock Manager</span>
              <span className="block text-xs text-white/75 mt-0.5">Faster launch, opens in its own window</span>
            </span>
            <ChevronRight className="w-4 h-4 text-white/70 flex-shrink-0" />
          </button>
        )}

        {/* Nav list */}
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden shadow-sm">
          <ul className="divide-y divide-zinc-200/60 dark:divide-zinc-800/60">
            {ROWS.filter(r => !r.adminOnly || isAdmin).map(r => {
              const Icon = r.icon;
              return (
                <li key={r.href}>
                  <Link
                    href={r.href}
                    className="flex items-center gap-4 px-4 py-4 active:bg-zinc-100 dark:active:bg-zinc-800 transition-colors"
                  >
                    <span className="w-10 h-10 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 rounded-xl flex items-center justify-center flex-shrink-0">
                      <Icon className="w-5 h-5" />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium">{r.label}</span>
                      {r.sub && <span className="block text-xs text-zinc-500 mt-0.5 truncate">{r.sub}</span>}
                    </span>
                    <ChevronRight className="w-4 h-4 text-zinc-400 flex-shrink-0" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Sign-out */}
        <button
          type="button"
          onClick={signOut}
          className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl px-4 py-4 flex items-center gap-4 text-rose-600 dark:text-rose-400 active:bg-rose-50 dark:active:bg-rose-500/10 transition-colors shadow-sm"
        >
          <span className="w-10 h-10 bg-rose-500/10 rounded-xl flex items-center justify-center flex-shrink-0">
            <LogOut className="w-5 h-5" />
          </span>
          <span className="flex-1 text-left text-sm font-medium">Sign out</span>
        </button>

        <div className="text-[11px] text-zinc-500 text-center pt-2">
          Stock Manager v2 · Rye Electricals
        </div>
      </div>
    </Shell>
  );
}
