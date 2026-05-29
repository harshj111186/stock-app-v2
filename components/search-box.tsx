"use client";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

// Reusable search input used across the app. Search icon on the left,
// a clear (X) button on the right that shows only when there's text.
// Pair the `value` with the shared matchesQuery() helper for forgiving,
// bracket-insensitive, multi-term filtering.
export function SearchBox({
  value, onChange, placeholder, className, autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className={cn("relative", className)}>
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 pointer-events-none" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus={autoFocus}
        className="w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md pl-9 pr-9 py-1.5 text-sm focus:outline-none focus:border-cyan-500"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 p-0.5 rounded"
          aria-label="Clear search"
          title="Clear search"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
