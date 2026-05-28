"use client";
import { Clock, LogOut, RefreshCw } from "lucide-react";

// Shown after sign-up (or sign-in) when the user's profile has approved_at
// IS NULL — i.e. waiting for an admin to flip them active.
//
// No automatic polling. Users hit Refresh when an admin tells them to.
// Sign-out is the only way out. The admin Users page handles the approval
// side; this is the user-facing waiting room.

export function PendingApproval({
  email,
  onSignOut,
  onRefresh,
}: {
  email: string;
  onSignOut: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-zinc-50 dark:bg-zinc-950">
      <div className="w-full max-w-md bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-8 shadow-lg shadow-zinc-200/30 dark:shadow-black/40 text-center">
        <div className="w-12 h-12 bg-amber-500/15 rounded-full flex items-center justify-center mx-auto mb-4">
          <Clock className="w-6 h-6 text-amber-500" strokeWidth={2} />
        </div>
        <h1 className="text-lg font-semibold tracking-tight mb-2">Waiting for admin approval</h1>
        <p className="text-sm text-zinc-500 leading-relaxed">
          You're signed up — but an admin needs to approve your account before you can
          access the stock manager. Ping{" "}
          <span className="text-zinc-700 dark:text-zinc-200 font-medium">Harsh</span> or{" "}
          <span className="text-zinc-700 dark:text-zinc-200 font-medium">Bhavik</span>,
          then hit Refresh below.
        </p>

        <div className="mt-5 text-xs text-zinc-400 bg-zinc-50 dark:bg-zinc-800/40 border border-zinc-200 dark:border-zinc-700/50 rounded p-2.5 inline-block">
          Signed in as <span className="text-zinc-600 dark:text-zinc-300">{email}</span>
        </div>

        <div className="mt-6 flex flex-col gap-2">
          <button
            type="button"
            onClick={onRefresh}
            className="bg-cyan-500 hover:bg-cyan-400 text-white px-4 py-2 rounded-md text-sm font-medium inline-flex items-center justify-center gap-2"
          >
            <RefreshCw className="w-4 h-4" />
            Check again
          </button>
          <button
            type="button"
            onClick={onSignOut}
            className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 inline-flex items-center justify-center gap-1.5 mt-1"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
