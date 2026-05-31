"use client";
import { useEffect, useRef, useState } from "react";
import { Lock, Loader2, AlertCircle, Shield, LogOut, KeyRound } from "lucide-react";
import { sb } from "@/lib/supabase";

// 4-digit PIN gate.
//
// Two modes:
//   "enter" — user has a PIN; verify it via verify_pin RPC. Returns true on
//             success so the caller can flip its sessionStorage flag.
//   "set"   — user has no PIN; collect a new PIN + confirm, then set_pin RPC.
//             Same success contract.
//
// The component owns its 4-digit input behaviour (auto-advance, backspace,
// paste-a-4-digit-string-anywhere). It does NOT remember anything in
// localStorage / sessionStorage — that's the caller's job, because the gate
// is reused for both "set" (after which the caller should mark verified for
// this session) and "enter" (same thing). Keeping the unlock-tracking out
// of here makes it easier to audit.

type Mode = "enter" | "set";

export function PinGate({
  mode,
  email,
  onUnlocked,
  onSignOut,
  isSuperAdmin = false,
}: {
  mode: Mode;
  email: string;
  onUnlocked: () => void;
  onSignOut: () => void;
  // The super-admin's own gate never offers the master key (it can't unlock
  // the main master account anyway — enforced server-side too).
  isSuperAdmin?: boolean;
}) {
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [step, setStep] = useState<"first" | "confirm">("first");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Master-key unlock (enter mode, non-super accounts only).
  const [masterMode, setMasterMode] = useState(false);
  const [masterKey, setMasterKey] = useState("");
  const [masterKeySet, setMasterKeySet] = useState(false);

  // Reset state when mode flips (e.g. user finished setting, now we re-render
  // to a different gate state and unmount this — but be safe).
  useEffect(() => {
    setPin("");
    setConfirmPin("");
    setStep("first");
    setErr(null);
    setMasterMode(false);
    setMasterKey("");
  }, [mode]);

  // Offer the master-key option only when one exists AND this isn't the
  // super-admin's own gate.
  useEffect(() => {
    if (mode !== "enter" || isSuperAdmin) { setMasterKeySet(false); return; }
    let cancelled = false;
    sb().rpc("master_key_is_set").then(
      ({ data }) => { if (!cancelled) setMasterKeySet(data === true); },
      () => {},
    );
    return () => { cancelled = true; };
  }, [mode, isSuperAdmin]);

  const submit = async (finalPin: string) => {
    setErr(null);
    setBusy(true);
    try {
      if (mode === "enter") {
        const { data, error } = await sb().rpc("verify_pin", { p_pin: finalPin });
        if (error) {
          // RPC threw — typically locked, or PIN not set. Surface the message.
          setErr(error.message || "PIN check failed");
          setPin("");
          return;
        }
        if (data === true) {
          onUnlocked();
        } else {
          setErr("Wrong PIN. Try again.");
          setPin("");
        }
      } else {
        // mode === "set"
        const { error } = await sb().rpc("set_pin", { p_pin: finalPin });
        if (error) {
          setErr(error.message || "Couldn't save PIN");
          setPin("");
          setConfirmPin("");
          setStep("first");
          return;
        }
        onUnlocked();
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
      setPin("");
      if (mode === "set") {
        setConfirmPin("");
        setStep("first");
      }
    } finally {
      setBusy(false);
    }
  };

  // Master-key unlock — verifies the shared key (server refuses it for the
  // super-admin's own account) and clears any lockout on success.
  const submitMaster = async () => {
    const key = masterKey.trim();
    if (!key) { setErr("Enter the master key."); return; }
    setErr(null);
    setBusy(true);
    try {
      const { data, error } = await sb().rpc("verify_master_key", { p_key: key });
      if (error) { setErr(error.message || "Master key check failed"); return; }
      if (data === true) { onUnlocked(); }
      else { setErr("Master key incorrect."); setMasterKey(""); }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  // Called by PinInput when 4 digits are filled.
  const handleComplete = async (value: string) => {
    if (mode === "enter") {
      await submit(value);
      return;
    }
    // Set-PIN mode: two-step.
    if (step === "first") {
      setPin(value);
      setStep("confirm");
      setErr(null);
      return;
    }
    // step === "confirm"
    if (value !== pin) {
      setErr("PINs don't match. Start over.");
      setPin("");
      setConfirmPin("");
      setStep("first");
      return;
    }
    setConfirmPin(value);
    await submit(value);
  };

  const title = mode === "set"
    ? (step === "first" ? "Set a 4-digit PIN" : "Confirm your PIN")
    : masterMode ? "Enter master key" : "Enter your PIN";

  const sub = mode === "set"
    ? (step === "first"
        ? "You'll use this PIN every time you open the app. Pick something you'll remember — admin can reset it but won't see it."
        : "Type it again to confirm.")
    : masterMode
      ? "Unlock this account with the shared master key."
      : "Type the 4-digit PIN you set when you signed up.";

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-zinc-50 dark:bg-zinc-950">
      <div className="w-full max-w-sm bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-8 shadow-lg shadow-zinc-200/30 dark:shadow-black/40">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-9 h-9 bg-cyan-500/15 rounded-lg flex items-center justify-center">
            {mode === "enter"
              ? <Lock className="w-5 h-5 text-cyan-500" strokeWidth={2.2} />
              : <KeyRound className="w-5 h-5 text-cyan-500" strokeWidth={2.2} />}
          </div>
          <div className="min-w-0">
            <h1 className="font-semibold text-sm">{title}</h1>
            <p className="text-xs text-zinc-500 truncate" title={email}>{email}</p>
          </div>
        </div>

        <p className="text-xs text-zinc-500 mb-5 leading-relaxed">{sub}</p>

        {mode === "enter" && masterMode ? (
          <form onSubmit={(e) => { e.preventDefault(); void submitMaster(); }}>
            <input
              type="password"
              autoFocus
              value={masterKey}
              onChange={(e) => setMasterKey(e.target.value)}
              placeholder="Master key"
              disabled={busy}
              autoComplete="off"
              className="w-full bg-zinc-50 dark:bg-zinc-800 border-2 border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-cyan-500 disabled:opacity-50"
              aria-label="Master key"
            />
            <button
              type="submit"
              disabled={busy || !masterKey.trim()}
              className="mt-3 w-full bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-md py-2 text-sm font-medium inline-flex items-center justify-center gap-1.5"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
              Unlock
            </button>
          </form>
        ) : (
          <PinInput
            key={`${mode}-${step}`}            // remount → fresh blank inputs on step change
            onComplete={handleComplete}
            disabled={busy}
          />
        )}

        {err && (
          <div className="mt-3 text-xs text-rose-500 bg-rose-500/10 border border-rose-500/20 rounded px-3 py-2 flex items-start gap-2">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{err}</span>
          </div>
        )}
        {busy && !masterMode && (
          <div className="mt-3 text-xs text-zinc-500 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            {mode === "enter" ? "Checking…" : "Saving PIN…"}
          </div>
        )}

        {mode === "enter" && !masterMode && (
          <div className="mt-5 text-[11px] text-zinc-500 text-center leading-relaxed">
            Forgot your PIN? Ask an admin to reset it — they can clear it for you on the Users page.
          </div>
        )}

        {mode === "enter" && masterKeySet && (
          <button
            type="button"
            onClick={() => { setErr(null); setMasterKey(""); setMasterMode(m => !m); }}
            className="mt-3 w-full text-[11px] text-cyan-600 dark:text-cyan-400 hover:underline inline-flex items-center justify-center gap-1.5"
          >
            <KeyRound className="w-3 h-3" />
            {masterMode ? "Use my PIN instead" : "Unlock with master key"}
          </button>
        )}

        <button
          type="button"
          onClick={onSignOut}
          className="mt-5 w-full text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 inline-flex items-center justify-center gap-1.5"
        >
          <LogOut className="w-3.5 h-3.5" />
          Sign out
        </button>
      </div>
    </div>
  );
}

// ─── 4-digit pad ──────────────────────────────────────────────────────────
// Four input boxes, auto-advance on digit, backspace to previous, paste a
// 4-digit string anywhere fills all four. Fires onComplete when all four
// boxes have a digit.
export function PinInput({
  onComplete,
  disabled,
  autoFocus = true,
}: {
  onComplete: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [digits, setDigits] = useState<string[]>(["", "", "", ""]);
  const refs = useRef<Array<HTMLInputElement | null>>([null, null, null, null]);

  useEffect(() => {
    if (autoFocus && refs.current[0]) refs.current[0]?.focus();
  }, [autoFocus]);

  const fireIfComplete = (next: string[]) => {
    if (next.every(d => /^\d$/.test(d))) {
      // Defer slightly so the last keystroke renders before the parent
      // potentially unmounts us.
      window.setTimeout(() => onComplete(next.join("")), 10);
    }
  };

  const onChangeAt = (idx: number, raw: string) => {
    // Accept only digits; if the user types/pastes more than 1, distribute.
    const clean = raw.replace(/\D/g, "");
    if (!clean) {
      // Clearing the box
      const next = [...digits];
      next[idx] = "";
      setDigits(next);
      return;
    }
    const next = [...digits];
    let pos = idx;
    for (const ch of clean) {
      if (pos > 3) break;
      next[pos] = ch;
      pos++;
    }
    setDigits(next);
    // Focus the next empty box, or the last filled if all are done.
    const nextFocus = Math.min(pos, 3);
    refs.current[nextFocus]?.focus();
    refs.current[nextFocus]?.select();
    fireIfComplete(next);
  };

  const onKeyDownAt = (idx: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace") {
      if (digits[idx]) {
        // Clear this box; stay on it.
        const next = [...digits];
        next[idx] = "";
        setDigits(next);
        return;
      }
      // Already empty — move back.
      if (idx > 0) {
        e.preventDefault();
        refs.current[idx - 1]?.focus();
        const next = [...digits];
        next[idx - 1] = "";
        setDigits(next);
      }
    } else if (e.key === "ArrowLeft" && idx > 0) {
      e.preventDefault();
      refs.current[idx - 1]?.focus();
    } else if (e.key === "ArrowRight" && idx < 3) {
      e.preventDefault();
      refs.current[idx + 1]?.focus();
    }
  };

  return (
    <div className="flex justify-center gap-3">
      {digits.map((d, idx) => (
        <input
          key={idx}
          ref={(el) => { refs.current[idx] = el; }}
          type="password"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={1}
          value={d}
          disabled={disabled}
          onChange={(e) => onChangeAt(idx, e.target.value)}
          onKeyDown={(e) => onKeyDownAt(idx, e)}
          onFocus={(e) => e.target.select()}
          className="w-12 h-14 text-center text-2xl tnum bg-zinc-50 dark:bg-zinc-800 border-2 border-zinc-200 dark:border-zinc-700 rounded-lg focus:outline-none focus:border-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed"
          aria-label={`PIN digit ${idx + 1}`}
        />
      ))}
    </div>
  );
}
