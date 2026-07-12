"use client";
import { useEffect, useMemo, useState } from "react";
import {
  Package, KeyRound, AlertCircle, Loader2, ArrowLeft, ShieldCheck,
  UserPlus, Mail, ChevronRight, Crown,
} from "lucide-react";
import { sb } from "@/lib/supabase";
import { markPinUnlocked } from "@/app/providers";
import { enterDemo } from "@/lib/demo";

// ─── Profile-picker sign-in ────────────────────────────────────────────
//
// The login screen lists every sign-in-able profile (from the anon-readable
// `login_directory` view) as a tappable card — pick your NAME, no email
// typing. Supabase still authenticates with email under the hood; the picker
// carries each profile's email so it can call signInWithPassword.
//
// Flow:
//   • Tap your own account (you already have a live session on this device,
//     reached via "Switch account" → /login?switch=1) → straight in; the
//     PIN gate in providers handles the rest. "Comeback = just PIN" also
//     works on its own: a persisted session lands you on the PIN gate at "/".
//   • Tap a different account (or a fresh sign-in) → password → PIN.
//   • Master password (owner): a toggle on the password panel signs into any
//     non-super account AND bypasses its PIN (via the master-login function).
//
// Fallbacks kept: a manual email+password form (for an account not yet in the
// directory — e.g. awaiting approval), and signup (name + email + password +
// PIN). Signup passes the name in user_metadata so the picker shows it.

type DirEntry = { id: string; name: string; email: string; role: string; is_super_admin: boolean };
type View = "picker" | "password" | "email" | "signup";

const HOME = () => (process.env.NODE_ENV === "production" ? "/stock-app-v2/" : "/");

// Deterministic avatar background from a seed (name/email) — stable per user.
function avatarStyle(seed: string): React.CSSProperties {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) | 0;
  const hue = Math.abs(h) % 360;
  return { background: `linear-gradient(135deg, hsl(${hue} 70% 52%), hsl(${(hue + 38) % 360} 68% 44%))` };
}
const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
const roleLabel = (p: DirEntry) =>
  p.is_super_admin ? "Owner" : p.role.charAt(0).toUpperCase() + p.role.slice(1);

export default function LoginPage() {
  const [view, setView] = useState<View>("picker");
  const [dir, setDir] = useState<DirEntry[]>([]);
  const [dirLoaded, setDirLoaded] = useState(false);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  const [selected, setSelected] = useState<DirEntry | null>(null);
  const [useMaster, setUseMaster] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const reset = () => { setErr(""); setMsg(""); };
  const goHome = () => window.location.assign(HOME());
  const viewDemo = () => { enterDemo(); goHome(); };

  useEffect(() => {
    try { setSwitching(new URLSearchParams(window.location.search).has("switch")); } catch {}
    let cancelled = false;
    (async () => {
      const c = sb();
      try {
        const { data: s } = await c.auth.getSession();
        if (!cancelled) setSessionUserId(s.session?.user?.id ?? null);
      } catch { /* ignore */ }
      try {
        const { data, error } = await c
          .from("login_directory")
          .select("id, name, email, role, is_super_admin")
          .order("name");
        if (!cancelled) {
          if (!error && data) setDir(data as DirEntry[]);
          setDirLoaded(true);
        }
      } catch {
        if (!cancelled) setDirLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Owner first, then admins, then everyone by name.
  const ordered = useMemo(() => {
    const rank = (p: DirEntry) => (p.is_super_admin ? 0 : p.role === "admin" ? 1 : p.role === "staff" ? 2 : 3);
    return [...dir].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [dir]);

  // Master-password login. Supabase rejects the master password as a normal
  // password, so we ask the master-login Edge Function to mint a session for
  // that account; on success it also marks the PIN gate unlocked, then
  // hard-navigates home. Returns true if it took over the flow.
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
      goHome();
      return true;
    } catch {
      return false;
    }
  };

  // Tap a profile card.
  const pick = (p: DirEntry) => {
    reset();
    if (sessionUserId && p.id === sessionUserId) { goHome(); return; } // your account → PIN gate handles it
    setSelected(p);
    setPassword("");
    setUseMaster(false);
    setView("password");
  };

  const withTimeout = <T,>(p: PromiseLike<T>): Promise<T> =>
    Promise.race([
      p as Promise<T>,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Sign in took too long. Try again or refresh the page.")), 12000)
      ),
    ]);

  // Sign into the chosen profile (password, or master password if toggled).
  const signInSelected = async (e: React.FormEvent) => {
    e.preventDefault();
    reset();
    if (!selected) return;
    setBusy(true);
    try {
      if (useMaster) {
        if (await tryMasterLogin(selected.email, password)) return; // navigates on success
        setErr("That master password didn't work for this account.");
        return;
      }
      const c = sb();
      const res = await withTimeout(c.auth.signInWithPassword({ email: selected.email, password }));
      if (res.error) {
        // The entered password might be the master password — try that before erroring.
        if (await tryMasterLogin(selected.email, password)) return;
        setErr(res.error.message);
        return;
      }
      goHome();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Sign in failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  // Manual email + password (fallback for accounts not yet in the directory).
  const signInEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    reset();
    setBusy(true);
    try {
      const c = sb();
      const res = await withTimeout(c.auth.signInWithPassword({ email, password }));
      if (res.error) {
        if (await tryMasterLogin(email, password)) return;
        setErr(res.error.message);
        return;
      }
      goHome();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Sign in failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  // Create account: name + email + password + PIN.
  const signUp = async (e: React.FormEvent) => {
    e.preventDefault();
    reset();
    if (!name.trim()) { setErr("Enter your name."); return; }
    if (!/^\d{4}$/.test(pin)) { setErr("PIN must be exactly 4 digits."); return; }
    if (pin !== pin2) { setErr("PIN and confirm PIN don't match."); return; }
    setBusy(true);
    try {
      const c = sb();
      const res = await withTimeout(
        c.auth.signUp({ email, password, options: { data: { name: name.trim() } } })
      );
      if (res.error) { setErr(res.error.message); return; }
      if (!res.data.session) {
        // Email confirmation on — defer PIN until after they confirm + sign in.
        setMsg("Check your email for a confirmation link, then sign in to set your PIN.");
        setView("email");
        setPin(""); setPin2("");
        return;
      }
      const userId = res.data.session.user.id;
      const { error: pinErr } = await c.rpc("set_pin", { p_pin: pin });
      if (pinErr) {
        await new Promise((r) => setTimeout(r, 400));
        const { error: retryErr } = await c.rpc("set_pin", { p_pin: pin });
        if (retryErr) {
          setErr(`Account created but PIN didn't save: ${retryErr.message}. Sign in to try again.`);
          return;
        }
      }
      markPinUnlocked(userId);
      goHome();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Sign up failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    "w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-cyan-500";

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10 bg-zinc-50 dark:bg-zinc-950">
      <button
        type="button" onClick={viewDemo}
        className="fixed top-4 right-4 z-50 inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-2 rounded-full border border-cyan-500/40 text-cyan-600 dark:text-cyan-300 bg-white/80 dark:bg-zinc-900/70 backdrop-blur hover:bg-cyan-500 hover:text-white hover:border-cyan-500 transition-colors shadow-sm"
        title="Explore the app with sample data — no login needed"
      >
        View demo <span aria-hidden>→</span>
      </button>

      <div className="w-full max-w-sm bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 sm:p-8 shadow-lg shadow-zinc-200/30 dark:shadow-black/40">
        {/* Brand */}
        <div className="flex items-center gap-3 mb-6">
          <div className="w-9 h-9 bg-cyan-500 rounded-lg flex items-center justify-center shrink-0">
            <Package className="w-5 h-5 text-white" strokeWidth={2.5} />
          </div>
          <div className="min-w-0">
            <h1 className="font-semibold leading-tight">Stock Manager</h1>
            <p className="text-xs text-zinc-500 truncate">
              {view === "picker" ? (switching ? "Switch account" : "Who's signing in?")
                : view === "signup" ? "Create your account"
                : view === "email" ? "Sign in with email"
                : selected ? `Signing in as ${selected.name}` : "Sign in"}
            </p>
          </div>
        </div>

        {/* ── Picker ─────────────────────────────────────────────────── */}
        {view === "picker" && (
          <>
            {!dirLoaded ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => <div key={i} className="h-14 rounded-xl shimmer" />)}
              </div>
            ) : ordered.length === 0 ? (
              <div className="text-center py-6">
                <p className="text-sm text-zinc-500 mb-3">No accounts yet.</p>
                <button onClick={() => { setView("signup"); reset(); }} className="text-cyan-600 dark:text-cyan-400 text-sm hover:underline">
                  Create the first account
                </button>
              </div>
            ) : (
              <ul className="space-y-1.5">
                {ordered.map((p) => {
                  const isMe = sessionUserId && p.id === sessionUserId;
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => pick(p)}
                        className="w-full flex items-center gap-3 p-2.5 rounded-xl border border-zinc-200 dark:border-zinc-800 hover:border-cyan-500/60 hover:bg-cyan-500/5 transition-colors text-left min-h-[56px] group"
                      >
                        <span
                          className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold text-white shrink-0"
                          style={avatarStyle(p.name + p.id)}
                        >
                          {initials(p.name)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="font-medium text-sm truncate">{p.name}</span>
                            {p.is_super_admin && <Crown className="w-3.5 h-3.5 text-amber-500 shrink-0" />}
                          </span>
                          <span className="text-[11px] text-zinc-500 flex items-center gap-1.5">
                            {roleLabel(p)}
                            {isMe && <span className="inline-flex items-center rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 px-1.5 py-0.5 text-[9px] uppercase tracking-wide font-medium">Signed in</span>}
                          </span>
                        </span>
                        <ChevronRight className="w-4 h-4 text-zinc-300 dark:text-zinc-600 group-hover:text-cyan-500 transition-colors shrink-0" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="mt-5 pt-4 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-between text-xs">
              <button onClick={() => { setView("email"); reset(); }} className="inline-flex items-center gap-1.5 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
                <Mail className="w-3.5 h-3.5" /> Use email
              </button>
              <button onClick={() => { setView("signup"); reset(); }} className="inline-flex items-center gap-1.5 text-cyan-600 dark:text-cyan-400 hover:underline">
                <UserPlus className="w-3.5 h-3.5" /> Create account
              </button>
            </div>
          </>
        )}

        {/* ── Password (for a chosen profile) ───────────────────────────── */}
        {view === "password" && selected && (
          <form onSubmit={signInSelected} className="space-y-3">
            <div className="flex items-center gap-3 p-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-800">
              <span className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold text-white shrink-0" style={avatarStyle(selected.name + selected.id)}>
                {initials(selected.name)}
              </span>
              <div className="min-w-0">
                <div className="font-medium text-sm truncate flex items-center gap-1.5">
                  {selected.name}
                  {selected.is_super_admin && <Crown className="w-3.5 h-3.5 text-amber-500 shrink-0" />}
                </div>
                <div className="text-[11px] text-zinc-500">{roleLabel(selected)}</div>
              </div>
            </div>

            <input
              type="password" required autoFocus
              placeholder={useMaster ? "Master password" : "Password"}
              value={password} onChange={(e) => setPassword(e.target.value)}
              className={inputCls} autoComplete="current-password"
            />

            <label className="flex items-start gap-2 text-[11px] text-zinc-500 cursor-pointer select-none">
              <input
                type="checkbox" checked={useMaster}
                onChange={(e) => { setUseMaster(e.target.checked); reset(); }}
                className="mt-0.5 accent-cyan-500"
                disabled={selected.is_super_admin}
              />
              <span className="inline-flex items-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5" />
                {selected.is_super_admin
                  ? "The owner account always uses its own password + PIN."
                  : "Use the owner's master password (opens this account without its PIN)."}
              </span>
            </label>

            {err && (
              <div className="text-xs text-rose-500 bg-rose-500/10 border border-rose-500/20 rounded px-3 py-2 flex items-start gap-2">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span className="min-w-0 break-words">{err}</span>
              </div>
            )}

            <button
              type="submit" disabled={busy}
              className="w-full bg-cyan-500 hover:bg-cyan-400 text-white font-medium rounded-md py-2 text-sm disabled:opacity-50 transition-colors flex items-center justify-center gap-1.5"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              {busy ? "Please wait…" : useMaster ? "Unlock with master password" : "Sign in"}
            </button>

            <button type="button" onClick={() => { setView("picker"); reset(); }} className="w-full inline-flex items-center justify-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
              <ArrowLeft className="w-3.5 h-3.5" /> Back to accounts
            </button>
          </form>
        )}

        {/* ── Email fallback ────────────────────────────────────────────── */}
        {view === "email" && (
          <form onSubmit={signInEmail} className="space-y-3">
            <input type="email" required autoFocus placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} autoComplete="email" />
            <input type="password" required placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls} autoComplete="current-password" />
            <p className="text-[11px] text-zinc-500">For an account that isn&apos;t in the list yet (e.g. waiting for approval), or the owner&apos;s master password.</p>
            {err && (
              <div className="text-xs text-rose-500 bg-rose-500/10 border border-rose-500/20 rounded px-3 py-2 flex items-start gap-2">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span className="min-w-0 break-words">{err}</span>
              </div>
            )}
            {msg && <div className="text-xs text-emerald-500 bg-emerald-500/10 border border-emerald-500/20 rounded px-3 py-2">{msg}</div>}
            <button type="submit" disabled={busy} className="w-full bg-cyan-500 hover:bg-cyan-400 text-white font-medium rounded-md py-2 text-sm disabled:opacity-50 transition-colors flex items-center justify-center gap-1.5">
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}{busy ? "Please wait…" : "Sign in"}
            </button>
            <button type="button" onClick={() => { setView("picker"); reset(); }} className="w-full inline-flex items-center justify-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
              <ArrowLeft className="w-3.5 h-3.5" /> Back to accounts
            </button>
          </form>
        )}

        {/* ── Sign up ───────────────────────────────────────────────────── */}
        {view === "signup" && (
          <form onSubmit={signUp} className="space-y-3">
            <input type="text" required autoFocus placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} autoComplete="name" />
            <input type="email" required placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} autoComplete="email" />
            <input type="password" required placeholder="Password" minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls} autoComplete="new-password" />
            <div className="pt-2 mt-1 border-t border-zinc-200 dark:border-zinc-800" />
            <div className="flex items-center gap-2 text-[11px] text-zinc-500">
              <KeyRound className="w-3.5 h-3.5" /> Set a 4-digit PIN. You&apos;ll type it each time you open the app.
            </div>
            <input type="password" required placeholder="4-digit PIN" inputMode="numeric" pattern="\d{4}" maxLength={4} minLength={4}
              value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
              className={inputCls + " tnum tracking-[0.4em] text-center"} autoComplete="off" />
            <input type="password" required placeholder="Confirm PIN" inputMode="numeric" pattern="\d{4}" maxLength={4} minLength={4}
              value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, "").slice(0, 4))}
              className={inputCls + " tnum tracking-[0.4em] text-center"} autoComplete="off" />
            <div className="text-[11px] text-zinc-500 leading-relaxed bg-zinc-50 dark:bg-zinc-800/40 border border-zinc-200 dark:border-zinc-700/50 rounded px-2.5 py-2">
              New accounts need admin approval before you can sign in. Harsh and Bhavik are auto-approved; everyone else waits for them to OK it.
            </div>
            {err && (
              <div className="text-xs text-rose-500 bg-rose-500/10 border border-rose-500/20 rounded px-3 py-2 flex items-start gap-2">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span className="min-w-0 break-words">{err}</span>
              </div>
            )}
            {msg && <div className="text-xs text-emerald-500 bg-emerald-500/10 border border-emerald-500/20 rounded px-3 py-2">{msg}</div>}
            <button type="submit" disabled={busy} className="w-full bg-cyan-500 hover:bg-cyan-400 text-white font-medium rounded-md py-2 text-sm disabled:opacity-50 transition-colors flex items-center justify-center gap-1.5">
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}{busy ? "Please wait…" : "Create account"}
            </button>
            <button type="button" onClick={() => { setView("picker"); reset(); setPin(""); setPin2(""); }} className="w-full inline-flex items-center justify-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
              <ArrowLeft className="w-3.5 h-3.5" /> Back to accounts
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
