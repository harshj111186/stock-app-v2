"use client";
import { useState } from "react";
import { Package, KeyRound, AlertCircle, Loader2 } from "lucide-react";
import { sb } from "@/lib/supabase";
import { markPinUnlocked } from "@/app/providers";
import { enterDemo } from "@/lib/demo";

// Sign-in / sign-up.
//
// Sign-in: email + password → if a session lands, redirect via hard nav so
// providers bootstraps fresh and runs its gate state machine (pending
// approval → set PIN → enter PIN → app).
//
// Sign-up: email + password + 4-digit PIN + confirm PIN. Two paths after
// the Supabase signUp call resolves:
//
//   (a) session returned   — email confirmation is off (Supabase default for
//                            our project). We immediately call set_pin so the
//                            user has a PIN tied to their account, mark this
//                            browser session as unlocked, and hard-nav home.
//                            Non-seed users land on the PendingApproval
//                            screen; harsh/bhavik flow straight into the app.
//
//   (b) no session         — email confirmation is on, user has to click a
//                            link first. We CAN'T save the PIN yet (no auth
//                            context) — show a message, switch to sign-in.
//                            The user will set their PIN after confirming
//                            email + signing in; the set-PIN gate catches it.

type Mode = "signin" | "signup";

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const reset = () => { setErr(""); setMsg(""); };

  // Public demo: enter mock mode (no real DB) and open the app.
  const viewDemo = () => {
    enterDemo();
    window.location.assign(process.env.NODE_ENV === "production" ? "/stock-app-v2/" : "/");
  };

  const validateSignup = (): string | null => {
    if (!/^\d{4}$/.test(pin)) return "PIN must be exactly 4 digits.";
    if (pin !== pin2) return "PIN and confirm PIN don't match.";
    return null;
  };

  // Master-password login. Supabase rejects the master password as a normal
  // password (it isn't the account's real one), so on a failed sign-in we ask
  // the `master-login` Edge Function to mint a session for that account. Works
  // for any non-super account; on success it also marks the PIN gate unlocked,
  // then hard-navigates home. Returns true if it took over the flow.
  const tryMasterLogin = async (loginEmail: string, key: string): Promise<boolean> => {
    try {
      const c = sb();
      const { data: isSet } = await c.rpc("master_key_is_set");
      if (isSet !== true) return false;
      const { data, error } = await c.functions.invoke<{
        access_token?: string; refresh_token?: string; user_id?: string;
      }>("master-login", { body: { email: loginEmail, key } });
      if (error || !data?.access_token || !data?.refresh_token) return false;
      const { error: sErr } = await c.auth.setSession({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
      });
      if (sErr) return false;
      if (data.user_id) markPinUnlocked(data.user_id);
      const target = process.env.NODE_ENV === "production" ? "/stock-app-v2/" : "/";
      window.location.assign(target);
      return true;
    } catch {
      return false;
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    reset();

    if (mode === "signup") {
      const v = validateSignup();
      if (v) { setErr(v); return; }
    }

    setBusy(true);
    try {
      const c = sb();

      const authPromise = mode === "signin"
        ? c.auth.signInWithPassword({ email, password })
        : c.auth.signUp({ email, password });

      // 12s safety so a wedged auth call doesn't hold the button forever.
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Sign in took too long. Try again or refresh the page.")), 12000)
      );

      const res = (await Promise.race([authPromise, timeout])) as Awaited<typeof authPromise>;
      if (res.error) {
        // The entered password might be the MASTER password — try a master
        // login before surfacing the error (sign-in only).
        if (mode === "signin" && (await tryMasterLogin(email, password))) return;
        setErr(res.error.message);
        return;
      }

      // ── Sign-up branch ─────────────────────────────────────────────
      if (mode === "signup") {
        if (!res.data.session) {
          // Email confirmation required by the project. Defer PIN to after
          // they confirm + sign in (set-PIN gate handles it).
          setMsg("Check your email for a confirmation link, then sign in to set things up.");
          setMode("signin");
          setPin("");
          setPin2("");
          return;
        }

        // We have a session. Save the PIN immediately.
        const userId = res.data.session.user.id;
        const { error: pinErr } = await c.rpc("set_pin", { p_pin: pin });
        if (pinErr) {
          // Edge case: the user is signed in but the profile row hasn't been
          // created by the trigger yet. Tiny delay + retry once.
          await new Promise(r => setTimeout(r, 400));
          const { error: retryErr } = await c.rpc("set_pin", { p_pin: pin });
          if (retryErr) {
            setErr(`Account created but PIN didn't save: ${retryErr.message}. Sign in to try again.`);
            return;
          }
        }
        // Mark this browser session as PIN-unlocked so providers skips the
        // PIN gate on the next bootstrap — we literally just set the PIN.
        markPinUnlocked(userId);
      }

      // Hard navigation so providers bootstraps fresh with the new session
      // in localStorage. Sidesteps the auth-listener redirect race.
      const target = process.env.NODE_ENV === "production" ? "/stock-app-v2/" : "/";
      window.location.assign(target);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Sign in failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-zinc-50 dark:bg-zinc-950">
      <button
        type="button" onClick={viewDemo}
        className="fixed top-4 right-4 z-50 inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 rounded-full border border-cyan-500/40 text-cyan-600 dark:text-cyan-300 bg-white/80 dark:bg-zinc-900/70 backdrop-blur hover:bg-cyan-500 hover:text-white hover:border-cyan-500 transition-colors shadow-sm"
        title="Explore the app with sample data — no login needed"
      >
        View demo <span aria-hidden>→</span>
      </button>
      <div className="w-full max-w-sm bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-8 shadow-lg shadow-zinc-200/30 dark:shadow-black/40">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-9 h-9 bg-cyan-500 rounded-lg flex items-center justify-center">
            <Package className="w-5 h-5 text-white" strokeWidth={2.5} />
          </div>
          <div>
            <h1 className="font-semibold">Stock Manager</h1>
            <p className="text-xs text-zinc-500">
              {mode === "signin" ? "Sign in to continue" : "Create your account"}
            </p>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <input
            type="email" required autoFocus placeholder="Email"
            value={email} onChange={(e) => setEmail(e.target.value)}
            className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-cyan-500"
            autoComplete="email"
          />
          <input
            type="password" required placeholder="Password" minLength={6}
            value={password} onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-cyan-500"
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
          />

          {mode === "signup" && (
            <>
              <div className="pt-2 mt-1 border-t border-zinc-200 dark:border-zinc-800" />
              <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                <KeyRound className="w-3.5 h-3.5" />
                Set a 4-digit PIN. You'll type it every time you open the app.
              </div>
              <input
                type="password" required placeholder="4-digit PIN"
                inputMode="numeric" pattern="\d{4}" maxLength={4} minLength={4}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-cyan-500 tnum tracking-[0.4em] text-center"
                autoComplete="off"
              />
              <input
                type="password" required placeholder="Confirm PIN"
                inputMode="numeric" pattern="\d{4}" maxLength={4} minLength={4}
                value={pin2}
                onChange={(e) => setPin2(e.target.value.replace(/\D/g, "").slice(0, 4))}
                className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-cyan-500 tnum tracking-[0.4em] text-center"
                autoComplete="off"
              />
              <div className="text-[11px] text-zinc-500 leading-relaxed bg-zinc-50 dark:bg-zinc-800/40 border border-zinc-200 dark:border-zinc-700/50 rounded px-2.5 py-2">
                New accounts need admin approval before you can sign in.
                Harsh and Bhavik are auto-approved; everyone else waits for
                them to OK it.
              </div>
            </>
          )}

          {err && (
            <div className="text-xs text-rose-500 bg-rose-500/10 border border-rose-500/20 rounded px-3 py-2 flex items-start gap-2">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">{err}</span>
            </div>
          )}
          {msg && (
            <div className="text-xs text-emerald-500 bg-emerald-500/10 border border-emerald-500/20 rounded px-3 py-2">
              {msg}
            </div>
          )}

          <button
            type="submit" disabled={busy}
            className="w-full bg-cyan-500 hover:bg-cyan-400 text-white font-medium rounded-md py-2 text-sm disabled:opacity-50 transition-colors flex items-center justify-center gap-1.5"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}
          </button>
        </form>

        <div className="text-xs text-center text-zinc-500 mt-4">
          {mode === "signin" ? (
            <>No account? <button onClick={() => { setMode("signup"); reset(); }} className="text-cyan-500 hover:underline">Sign up</button></>
          ) : (
            <>Have an account? <button onClick={() => { setMode("signin"); reset(); setPin(""); setPin2(""); }} className="text-cyan-500 hover:underline">Sign in</button></>
          )}
        </div>
      </div>
    </div>
  );
}
