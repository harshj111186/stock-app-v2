"use client";
import { Shell } from "@/components/shell";
import { useAuth } from "@/app/providers";

export default function SettingsPage() {
  const { profile } = useAuth();
  return (
    <Shell title="Settings">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-zinc-500 mt-1">Account + app preferences.</p>
      </div>
      <div className="grid gap-4 max-w-xl">
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-5">
          <div className="text-xs text-zinc-500 uppercase tracking-wider mb-3">Account</div>
          <Row label="Email" value={profile?.email || "—"} />
          <Row label="Name" value={profile?.name || "—"} />
          <Row label="Role" value={profile?.role || "—"} />
        </div>
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-5">
          <div className="text-xs text-zinc-500 uppercase tracking-wider mb-3">About</div>
          <Row label="App version" value="v2 — in development" />
          <Row label="Connected to" value="Supabase: zvycuhldwfxpipcaeotc" />
        </div>
      </div>
    </Shell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-1.5 text-sm">
      <span className="text-zinc-500">{label}</span>
      <span>{value}</span>
    </div>
  );
}
