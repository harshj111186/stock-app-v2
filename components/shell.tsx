"use client";
import type { ReactNode } from "react";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { BottomTabBar } from "./bottom-tab-bar";
import { useAuth } from "@/app/providers";

// Mobile uses a bottom tab bar (5 primary routes; rest behind /more).
// Desktop keeps the inline sidebar. The mobile drawer pattern was replaced
// because hamburger nav adds a tap to every page change.
export function Shell({ title, children }: { title: string; children: ReactNode }) {
  const { loading, profile } = useAuth();

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center text-zinc-500">
        <div className="w-6 h-6 rounded-full border-2 border-cyan-500 border-t-transparent animate-spin" />
      </div>
    );
  }
  if (!profile) return null;
  return (
    <div className="flex min-h-screen md:h-screen md:overflow-hidden">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0">
        <Topbar title={title} />
        {/* pb-24 on mobile clears the 56px tab bar + safe-area; md+ no extra */}
        <div className="flex-1 md:overflow-auto p-4 sm:p-6 md:p-8 pb-24 md:pb-8">
          {children}
        </div>
      </main>
      <BottomTabBar />
    </div>
  );
}
