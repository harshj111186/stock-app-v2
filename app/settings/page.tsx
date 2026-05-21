"use client";
import { Shell } from "@/components/shell";
import { useAuth } from "@/app/providers";
import { useState } from "react";
import { sb } from "@/lib/supabase";
import { KeyRound, Loader2, CheckCircle2, AlertCircle, ShieldCheck } from "lucide-react";

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
          <Row
            label="Role"
            value={profile?.is_super_admin ? "super admin" : (profile?.role || "—")}
            icon={profile?.is_super_admin ? <ShieldCheck className="w-3.5 h-3.5 text-cyan-500" /> : undefined}
          />
        </div>

        <ChangePinCard />

        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-5">
          <div className="text-xs text-zinc-500 uppercase tracking-wider mb-3">About</div>
          <Row label="App version" value="v2 — in development" />
          <Row label="Connected to" value="Supabase: zvycuhldwfxpipcaeotc" />
        </div>
      </div>
    </Shell>
  );
}

// ─── Change PIN ────────────────────────────────────────────────────────────
// Old PIN + new PIN + confirm. Calls change_pin RPC, which returns false if
// the old PIN is wrong (we surface a clean error) or raises if the new PIN
// is structurally invalid.
function ChangePinCard() {
  const [oldPin, setOldPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);

  const onlyDigits = (s: string) => s.replace(/\D/g, "").slice(0, 4);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);

    if (!/^\d{4}$/.test(oldPin)) {
      setMsg({ kind: "bad", text: "Current PIN must be 4 digits." });
      return;
    }
    if (!/^\d{4}$/.test(newPin)) {
      setMsg({ kind: "bad", text: "New PIN must be 4 digits." });
      return;
    }
    if (newPin !== confirmPin) {
      setMsg({ kind: "bad", text: "New PIN and confirm don't match." });
      return;
    }
    if (newPin === oldPin) {
      setMsg({ kind: "bad", text: "New PIN must differ from the current one." });
      return;
    }

    setBusy(true);
    try {
      const { data, error } = await sb().rpc("change_pin", { p_old_pin: oldPin, p_new_pin: newPin });
      if (error) {
        setMsg({ kind: "bad", text: error.message || "Couldn't change PIN" });
        return;
      }
      if (data === false) {
        setMsg({ kind: "bad", text: "Current PIN is wrong." });
        return;
      }
      setMsg({ kind: "ok", text: "PIN updated. You'll use the new PIN from now on." });
      setOldPin(""); setNewPin(""); setConfirmPin("");
    } catch (e: any) {
      setMsg({ kind: "bad", text: e?.message || "Something went wrong" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-5">
      <div className="flex items-center gap-2 mb-3">
        <KeyRound className="w-3.5 h-3.5 text-cyan-500" />
        <div className="text-xs text-zinc-500 uppercase tracking-wider">Change PIN</div>
      </div>
      <p className="text-xs text-zinc-500 mb-4 leading-relaxed">
        Need to set a new PIN? Type your current one, then the new one twice. Forgot
        the current PIN? Ask an admin to reset it on the Users page.
      </p>

      <form onSubmit={submit} className="space-y-3">
        <PinField
          label="Current PIN"
          value={oldPin}
          onChange={(v) => setOldPin(onlyDigits(v))}
          autoFocus
        />
        <PinField
          label="New PIN"
          value={newPin}
          onChange={(v) => setNewPin(onlyDigits(v))}
        />
        <PinField
          label="Confirm new PIN"
          value={confirmPin}
          onChange={(v) => setConfirmPin(onlyDigits(v))}
        />

        {msg && (
          <div className={[
            "text-xs rounded px-3 py-2 flex items-start gap-2",
            msg.kind === "ok"
              ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-300"
              : "bg-rose-500/10 border border-rose-500/20 text-rose-500",
          ].join(" ")}>
            {msg.kind === "ok" ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
            <span className="min-w-0 break-words">{msg.text}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={busy || !oldPin || !newPin || !confirmPin}
          className="bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed text-zinc-900 px-4 py-2 rounded-md text-sm font-medium inline-flex items-center gap-2"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
          {busy ? "Updating…" : "Update PIN"}
        </button>
      </form>
    </div>
  );
}

function PinField({
  label, value, onChange, autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-medium mb-1.5">{label}</div>
      <input
        type="password"
        inputMode="numeric"
        pattern="\d{4}"
        maxLength={4}
        minLength={4}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        autoComplete="off"
        className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-cyan-500 tnum tracking-[0.4em] text-center"
      />
    </div>
  );
}

function Row({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="flex justify-between py-1.5 text-sm">
      <span className="text-zinc-500">{label}</span>
      <span className="inline-flex items-center gap-1.5">{icon}{value}</span>
    </div>
  );
}
