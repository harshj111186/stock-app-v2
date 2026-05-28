"use client";
import { Search, Sun, Moon } from "lucide-react";
import { useEffect, useState } from "react";

export function Topbar({ title }: { title: string }) {
  const [isDark, setIsDark] = useState(true);
  useEffect(() => setIsDark(document.documentElement.classList.contains("dark")), []);

  const toggle = () => {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
    setIsDark(next);
  };

  return (
    <header
      className="bg-white/80 dark:bg-zinc-900/60 border-b border-zinc-200 dark:border-zinc-800 px-4 md:px-6 flex items-center gap-3 backdrop-blur-md print:hidden h-14 md:h-14"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      {/* Title — large + prominent on mobile (this IS the page header on
          phones), smaller breadcrumb-style on desktop. */}
      <div className="flex items-center gap-2 text-base md:text-sm min-w-0">
        <span className="text-zinc-500 hidden md:inline">Home</span>
        <span className="text-zinc-400 hidden md:inline">›</span>
        <span className="font-semibold md:font-medium truncate">{title}</span>
      </div>

      <div className="flex-1" />

      {/* Global command palette launcher — desktop. Opens the ⌘K palette. */}
      <button
        type="button"
        onClick={() => window.dispatchEvent(new Event("open-command-palette"))}
        className="hidden md:flex items-center gap-2 bg-zinc-100 dark:bg-zinc-800/60 hover:bg-zinc-200 dark:hover:bg-zinc-800 border border-zinc-200 dark:border-zinc-700/50 px-3 py-1.5 rounded-md text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors"
        aria-label="Open command palette"
      >
        <Search className="w-3.5 h-3.5" />
        Search…
        <kbd className="ml-6 bg-zinc-200 dark:bg-zinc-700/50 px-1.5 py-0.5 rounded text-[10px] font-mono">⌘K</kbd>
      </button>

      <button
        onClick={toggle}
        className="p-2.5 -m-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-full"
        aria-label="Toggle theme"
      >
        {isDark ? <Sun className="w-4 h-4 text-zinc-400" /> : <Moon className="w-4 h-4 text-zinc-600" />}
      </button>
    </header>
  );
}
