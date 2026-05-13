"use client";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { useAuth } from "@/app/providers";
import type { ReactNode } from "react";

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
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0">
        <Topbar title={title} />
        <div className="flex-1 overflow-auto p-8">{children}</div>
      </main>
    </div>
  );
}
