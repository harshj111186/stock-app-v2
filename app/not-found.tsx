"use client";
import Link from "next/link";
import { Home } from "lucide-react";

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-zinc-50 dark:bg-zinc-950">
      <div className="text-center max-w-md">
        <div className="text-7xl font-bold text-zinc-300 dark:text-zinc-700 tracking-tight mb-3">404</div>
        <h1 className="text-xl font-semibold tracking-tight mb-2">Page not found</h1>
        <p className="text-sm text-zinc-500 mb-6">
          We couldn&apos;t find what you were looking for. It may be a page that hasn&apos;t been built yet.
        </p>
        <Link href="/" className="inline-flex items-center gap-2 bg-cyan-500 hover:bg-cyan-400 text-zinc-900 px-4 py-2 rounded-md text-sm font-medium transition-colors">
          <Home className="w-4 h-4" />
          Back to Dashboard
        </Link>
      </div>
    </div>
  );
}
