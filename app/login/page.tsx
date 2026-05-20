"use client";
import { useState } from "react";
import { Package } from "lucide-react";
import { sb } from "@/lib/supabase";

export default function LoginPage() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(""); setMsg(""); setBusy(true);
    try {
      const c = sb();

      // 12s safety timeout. If signInWithPassword hangs (browser navigator-lock
      // contention, dead network), release the button with a clear error rather
      // than leaving "..." forever.
      const authPromise = mode === "signin"
        ? c.auth.signInWithPassword({ email, password })
        : c.auth.signUp({ email, password });

      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Sign in took too long. Try again or refresh the page.")), 12000)
      );

      const res = (await Promise.race([authPromise, timeout])) as Awaited<typeof authPromise>;

      if (res.error) { setErr(res.error.message); return; }
      if (mode === "signup" && !res.data.session) {
        setMsg("Check your email for a confirmation link, then sign in.");
        setMode("signin");
        return;
      }

      // Hard navigation instead of router.replace to sidestep the auth-listener
      // redirect race in providers.tsx — Providers will bootstrap fresh with the
      // new session already in localStorage.
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
      <div className="w-full max-w-sm bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-8 shadow-lg shadow-zinc-200/30 dark:shadow-black/40">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-9 h-9 bg-cyan-500 rounded-lg flex items-center justify-center">
            <Package className="w-5 h-5 text-zinc-900" strokeWidth={2.5} />
          </div>
          <div>
            <h1 className="font-semibold">Stock Manager</h1>
            <p className="text-xs text-zinc-500">{mode === "signin" ? "Sign in to continue" : "Create your account"}</p>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <input type="email" required autoFocus placeholder="Email"
            value={email} onChange={(e) => setEmail(e.target.value)}
            className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-cyan-500" />
          <input type="password" required placeholder="Password" minLength={6}
            value={password} onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-cyan-500" />
          {err && <div className="text-xs text-rose-500 bg-rose-500/10 border border-rose-500/20 rounded px-3 py-2">{err}</div>}
          {msg && <div className="text-xs text-emerald-500 bg-emerald-500/10 border border-emerald-500/20 rounded px-3 py-2">{msg}</div>}
          <button type="submit" disabled={busy}
            className="w-full bg-cyan-500 hover:bg-cyan-400 text-zinc-900 font-medium rounded-md py-2 text-sm disabled:opacity-50 transition-colors">
            {busy ? "..." : mode === "signin" ? "Sign in" : "Sign up"}
          </button>
        </form>

        <div className="text-xs text-center text-zinc-500 mt-4">
          {mode === "signin" ? (
            <>No account? <button onClick={() => setMode("signup")} className="text-cyan-500 hover:underline">Sign up</button></>
          ) : (
            <>Have an account? <button onClick={() => setMode("signin")} className="text-cyan-500 hover:underline">Sign in</button></>
          )}
        </div>
      </div>
    </div>
  );
}
