"use client";
import { Shell } from "@/components/shell";
import { useEffect, useState } from "react";
import { sb, type Profile } from "@/lib/supabase";
import { useAuth } from "@/app/providers";

export default function UsersPage() {
  const { profile: me } = useAuth();
  const [users, setUsers] = useState<Profile[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await sb().from("user_profiles").select("*").order("created_at", { ascending: false });
      setUsers((data || []) as Profile[]);
      setLoaded(true);
    })();
  }, []);

  if (me?.role !== "admin") {
    return (
      <Shell title="Users">
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-6">
          Admin-only page.
        </div>
      </Shell>
    );
  }

  return (
    <Shell title="Users">
      <div className="mb-6">
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Users</h1>
        <p className="text-sm text-zinc-500 mt-1">{loaded ? `${users.length} users` : "Loading…"}</p>
      </div>
      {/* Desktop table */}
      <div className="hidden md:block bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 dark:bg-zinc-900/50 border-b border-zinc-200 dark:border-zinc-800">
            <tr className="text-zinc-500 text-[11px] uppercase tracking-wider">
              <th className="text-left px-5 py-2.5 font-medium">Email</th>
              <th className="text-left px-3 py-2.5 font-medium">Name</th>
              <th className="text-left px-3 py-2.5 font-medium">Role</th>
              <th className="text-left px-3 py-2.5 font-medium">Active</th>
            </tr>
          </thead>
          <tbody>
            {loaded && users.map(u => (
              <tr key={u.id} className="border-t border-zinc-200/50 dark:border-zinc-800/50">
                <td className="px-5 py-2.5">{u.email}</td>
                <td className="px-3 py-2.5">{u.name || "—"}</td>
                <td className="px-3 py-2.5">
                  <span className="bg-cyan-500/15 text-cyan-600 dark:text-cyan-300 px-2 py-0.5 rounded text-[11px]">{u.role}</span>
                </td>
                <td className="px-3 py-2.5">{u.active ? "✓" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Mobile cards */}
      <ul className="md:hidden bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden shadow-sm divide-y divide-zinc-200/60 dark:divide-zinc-800/60">
        {loaded && users.map(u => (
          <li key={u.id} className="px-4 py-3">
            <div className="flex items-start justify-between gap-2 mb-1">
              <span className="text-sm font-medium truncate">{u.email}</span>
              <span className="bg-cyan-500/15 text-cyan-600 dark:text-cyan-300 px-2 py-0.5 rounded text-[11px] flex-shrink-0">{u.role}</span>
            </div>
            <div className="flex items-center justify-between text-xs text-zinc-500">
              <span>{u.name || "—"}</span>
              <span>{u.active ? "✓ active" : "inactive"}</span>
            </div>
          </li>
        ))}
      </ul>
      <p className="text-xs text-zinc-500 mt-3">Invite, role-change, and deactivate UI coming in a later session.</p>
    </Shell>
  );
}
