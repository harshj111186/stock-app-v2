"use client";
import { Search, Sun, Moon, Bell } from "lucide-react";
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
    <div className="h-14 bg-white/70 dark:bg-zinc-900/50 border-b border-zinc-200 dark:border-zinc-800 px-6 flex items-center gap-4 backdrop-blur">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-zinc-500">Home</span>
        <span className="text-zinc-400">›</span>
        <span className="font-medium">{title}</span>
      </div>
      <div className="flex-1" />
      <button className="flex items-center gap-2 bg-zinc-100 dark:bg-zinc-800/60 hover:bg-zinc-200 dark:hover:bg-zinc-800 border border-zinc-200 dark:border-zinc-700/50 px-3 py-1.5 rounded-md text-xs text-zinc-500">
        <Search className="w-3.5 h-3.5" />
        Search…
        <kbd className="ml-6 bg-zinc-200 dark:bg-zinc-700/50 px-1.5 py-0.5 rounded text-[10px] font-mono">⌘K</kbd>
      </button>
      <button onClick={toggle} className="p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md" aria-label="Toggle theme">
        {isDark ? <Sun className="w-4 h-4 text-zinc-400" /> : <Moon className="w-4 h-4 text-zinc-600" />}
      </button>
      <button className="p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md relative" aria-label="Notifications">
        <Bell className="w-4 h-4 text-zinc-400" />
      </button>
    </div>
  );
}
