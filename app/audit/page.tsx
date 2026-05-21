"use client";
import { Shell } from "@/components/shell";
import { useEffect, useState } from "react";
import { sb } from "@/lib/supabase";
import { useAuth } from "@/app/providers";

type AuditRow = {
  id: number;
  user_id: string | null;
  occurred_at: string;
  table_name: string;
  row_id: string;
  operation: "INSERT" | "UPDATE" | "DELETE";
};

export default function AuditPage() {
  const { profile } = useAuth();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await sb()
        .from("audit_log")
        .select("id,user_id,occurred_at,table_name,row_id,operation")
        .order("occurred_at", { ascending: false })
        .limit(300);
      setRows((data || []) as AuditRow[]);
      setLoaded(true);
    })();
  }, []);

  if (profile?.role !== "admin") {
    return (
      <Shell title="Audit log">
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-6">
          Admin-only page.
        </div>
      </Shell>
    );
  }

  const opColour = (op: AuditRow["operation"]) =>
    op === "DELETE" ? "bg-rose-500/15 text-rose-500"
      : op === "INSERT" ? "bg-emerald-500/15 text-emerald-500"
      : "bg-cyan-500/15 text-cyan-500";

  return (
    <Shell title="Audit log">
      <div className="mb-6">
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="text-sm text-zinc-500 mt-1">
          {loaded ? `${rows.length} most recent changes` : "Loading…"} — auto-recorded by the database.
        </p>
      </div>
      {/* Desktop table */}
      <div className="hidden md:block bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 dark:bg-zinc-900/50 border-b border-zinc-200 dark:border-zinc-800">
            <tr className="text-zinc-500 text-[11px] uppercase tracking-wider">
              <th className="text-left px-5 py-2.5 font-medium">When</th>
              <th className="text-left px-3 py-2.5 font-medium">Table</th>
              <th className="text-left px-3 py-2.5 font-medium">Op</th>
              <th className="text-left px-3 py-2.5 font-medium">Row</th>
              <th className="text-left px-5 py-2.5 font-medium">User</th>
            </tr>
          </thead>
          <tbody>
            {!loaded && Array.from({ length: 6 }).map((_, i) => (
              <tr key={i} className="border-t border-zinc-200/50 dark:border-zinc-800/50">
                {Array.from({ length: 5 }).map((__, j) => (
                  <td key={j} className="px-3 py-3"><div className="h-3 rounded shimmer" /></td>
                ))}
              </tr>
            ))}
            {loaded && rows.map(r => (
              <tr key={r.id} className="border-t border-zinc-200/50 dark:border-zinc-800/50 hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                <td className="px-5 py-2.5 text-zinc-500 tnum">{new Date(r.occurred_at).toLocaleString("en-IN")}</td>
                <td className="px-3 py-2.5">{r.table_name}</td>
                <td className="px-3 py-2.5">
                  <span className={`px-2 py-0.5 rounded text-[11px] ${opColour(r.operation)}`}>{r.operation}</span>
                </td>
                <td className="px-3 py-2.5"><code className="text-[11px] text-zinc-500">{(r.row_id || "").slice(0, 8)}</code></td>
                <td className="px-5 py-2.5 text-[11px] text-zinc-500">{r.user_id ? r.user_id.slice(0, 8) + "…" : "—"}</td>
              </tr>
            ))}
            {loaded && rows.length === 0 && (
              <tr><td colSpan={5} className="py-12 text-center text-sm text-zinc-500">No audit entries yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {/* Mobile cards */}
      <div className="md:hidden bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden shadow-sm">
        {!loaded && (
          <div className="p-4 space-y-3">
            {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-3 rounded shimmer" />)}
          </div>
        )}
        {loaded && rows.length === 0 && (
          <div className="py-12 text-center text-sm text-zinc-500">No audit entries yet.</div>
        )}
        <ul className="divide-y divide-zinc-200/60 dark:divide-zinc-800/60">
          {loaded && rows.map(r => (
            <li key={r.id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className={`px-2 py-0.5 rounded text-[11px] ${opColour(r.operation)}`}>{r.operation}</span>
                <span className="text-[11px] text-zinc-500 tnum">{new Date(r.occurred_at).toLocaleString("en-IN")}</span>
              </div>
              <div className="text-sm">{r.table_name}</div>
              <div className="flex items-center justify-between text-[11px] text-zinc-500 mt-0.5">
                <span>Row <code className="text-zinc-500">{(r.row_id || "").slice(0, 8)}</code></span>
                <span>User {r.user_id ? r.user_id.slice(0, 8) + "…" : "—"}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Shell>
  );
}
