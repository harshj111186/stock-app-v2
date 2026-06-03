"use client";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import { sb, type Profile, PROFILE_COLUMNS } from "@/lib/supabase";
import { isDemo, demoProfile, exitDemo } from "@/lib/demo";
import { DemoHowItWorks } from "@/components/demo-how-it-works";
import { PinGate } from "@/components/pin-gate";
import { PendingApproval } from "@/components/pending-approval";

// ─── Auth + gate state machine ───────────────────────────────────────────
//
// After Supabase auth resolves a session, every page is wrapped in this
// order of gates:
//
//   1. session === null            → redirect to /login (unchanged from v1 v2)
//   2. profile.approved_at == null → <PendingApproval/>       (waiting room)
//   3. profile.active === false    → <PendingApproval/>       (deactivated; same UI)
//   4. profile.pin_set_at == null  → <PinGate mode="set"/>    (set up a PIN)
//   5. !sessionStorage.pinUnlocked → <PinGate mode="enter"/>  (lock until PIN)
//   6. all clear                   → render children (the app)
//
// Why sessionStorage and not localStorage:
//   sessionStorage clears when the tab/browser closes, which is exactly the
//   "once per browser session" cadence Harsh asked for. localStorage would
//   persist across launches and defeat the point of the gate.
//
// The flag is keyed by userId so switching accounts in the same browser
// can't carry over the previous user's unlock.

type AuthState = {
  loading: boolean;
  profile: Profile | null;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
};
const AuthContext = createContext<AuthState>({
  loading: true,
  profile: null,
  signOut: async () => {},
  refreshProfile: async () => {},
});
export const useAuth = () => useContext(AuthContext);

const PIN_FLAG_PREFIX = "pinUnlocked:";
const pinFlagKey = (userId: string) => `${PIN_FLAG_PREFIX}${userId}`;

export function isPinUnlocked(userId: string | undefined | null): boolean {
  if (!userId) return false;
  try {
    return sessionStorage.getItem(pinFlagKey(userId)) === "1";
  } catch {
    return false;
  }
}

export function markPinUnlocked(userId: string) {
  try { sessionStorage.setItem(pinFlagKey(userId), "1"); } catch {}
}

export function clearPinUnlocked(userId?: string) {
  try {
    if (userId) {
      sessionStorage.removeItem(pinFlagKey(userId));
    } else {
      // Best-effort: clear any stale flags from this prefix.
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const k = sessionStorage.key(i);
        if (k && k.startsWith(PIN_FLAG_PREFIX)) sessionStorage.removeItem(k);
      }
    }
  } catch {}
}

async function fetchProfile(userId: string): Promise<Profile | null> {
  try {
    // Explicit column list, NOT "*" — see PROFILE_COLUMNS doc-comment in
    // lib/supabase.ts for why. Using "*" here was the cause of a redirect-
    // bounce-to-login regression after the PIN migration shipped: the
    // pin_hash column-revoke made "SELECT *" fail with "permission denied
    // for table user_profiles", fetchProfile returned null, providers'
    // redirect effect punted to /login.
    const { data, error } = await sb()
      .from("user_profiles")
      .select(PROFILE_COLUMNS)
      .eq("id", userId)
      .single();
    if (error) console.warn("[fetchProfile] error", error);
    return (data as Profile) ?? null;
  } catch (e) {
    console.warn("[fetchProfile] exception", e);
    return null;
  }
}

export function Providers({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);
  // Forces a re-render after sessionStorage flips (sessionStorage isn't a
  // React state source). Toggle this any time we mark / unmark the flag.
  const [pinTick, setPinTick] = useState(0);
  const router = useRouter();
  const pathname = usePathname();

  // ─── Theme + auth bootstrap (preserves the deadlock fix from PR #5) ───
  useEffect(() => {
    // Theme
    const stored = localStorage.getItem("theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (stored === "light" || (!stored && !prefersDark)) {
      document.documentElement.classList.remove("dark");
    } else {
      document.documentElement.classList.add("dark");
    }

    // Public demo mode: skip real auth entirely (no Supabase auth listener).
    if (isDemo()) { setLoading(false); return; }

    let cancelled = false;
    let bootstrapped = false;
    const c = sb();

    const failsafe = setTimeout(() => {
      if (!cancelled && !bootstrapped) {
        console.warn("[Providers] auth bootstrap timed out; falling back to logged-out");
        bootstrapped = true;
        setLoading(false);
      }
    }, 10000);

    // CRITICAL: must be synchronous (see PR #5 deadlock notes). Defers any
    // SDK call behind setTimeout(0).
    const { data: sub } = c.auth.onAuthStateChange((_event, session) => {
      if (cancelled) return;

      if (!session) {
        bootstrapped = true;
        setProfile(null);
        setLoading(false);
        clearTimeout(failsafe);
        return;
      }

      const userId = session.user.id;
      setTimeout(async () => {
        if (cancelled) return;
        try {
          if (bootstrapped) {
            const prof = await fetchProfile(userId);
            if (cancelled) return;
            if (prof) setProfile(prof);
            return;
          }
          const prof = await fetchProfile(userId);
          if (cancelled) return;
          bootstrapped = true;
          setProfile(prof);
          setLoading(false);
          clearTimeout(failsafe);
        } catch (e) {
          if (cancelled) return;
          console.warn("[Providers] deferred profile fetch failed", e);
          bootstrapped = true;
          setLoading(false);
          clearTimeout(failsafe);
        }
      }, 0);
    });

    return () => {
      cancelled = true;
      clearTimeout(failsafe);
      sub.subscription.unsubscribe();
    };
  }, []);

  // ─── Redirect: must be signed in to see anything except /login ────────
  useEffect(() => {
    if (loading) return;
    if (isDemo()) return; // demo bypasses the auth redirect
    const onLogin = pathname?.endsWith("/login") || pathname?.endsWith("/login/");
    if (!profile && !onLogin) router.replace("/login");
    if (profile && onLogin) router.replace("/");
  }, [loading, profile, pathname, router]);

  // ─── Actions exposed via context ──────────────────────────────────────
  const signOut = useCallback(async () => {
    clearPinUnlocked(profile?.id);
    await sb().auth.signOut();
    setProfile(null);
    router.replace("/login");
  }, [profile?.id, router]);

  const refreshProfile = useCallback(async () => {
    if (!profile?.id) return;
    const prof = await fetchProfile(profile.id);
    if (prof) setProfile(prof);
  }, [profile?.id]);

  // ─── Render ───────────────────────────────────────────────────────────
  const onLogin = pathname?.endsWith("/login") || pathname?.endsWith("/login/");

  // Public demo mode: render the app directly with a mock admin profile, past
  // all auth/PIN gates. Data comes from the mock client (no real DB).
  if (isDemo()) {
    const demoSignOut = async () => {
      exitDemo();
      window.location.assign(process.env.NODE_ENV === "production" ? "/stock-app-v2/login" : "/login");
    };
    return (
      <AuthContext.Provider value={{ loading: false, profile: demoProfile() as Profile, signOut: demoSignOut, refreshProfile: async () => {} }}>
        {children}
        <DemoHowItWorks />
        <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-[9999] flex items-center gap-2.5 rounded-full border border-amber-400/50 bg-amber-500/15 backdrop-blur px-3.5 py-1.5 text-xs text-amber-700 dark:text-amber-200 shadow-lg">
          <span className="inline-flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-amber-500" />Demo mode · sample data</span>
          <button onClick={() => { try { window.dispatchEvent(new Event("demo:hiw")); } catch {} }} className="font-medium underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-100">How it works</button>
          <button onClick={demoSignOut} className="font-medium underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-100">Exit</button>
        </div>
      </AuthContext.Provider>
    );
  }

  // Login page always renders directly — it has its own auth UI. (Shell + the
  // gates only matter for in-app pages.)
  if (onLogin) {
    return (
      <AuthContext.Provider value={{ loading, profile, signOut, refreshProfile }}>
        {children}
      </AuthContext.Provider>
    );
  }

  // Loading state — let children render. Each page's <Shell> shows its own
  // spinner so we don't need a global one here.
  if (loading || !profile) {
    return (
      <AuthContext.Provider value={{ loading, profile, signOut, refreshProfile }}>
        {children}
      </AuthContext.Provider>
    );
  }

  // Gate 1: pending admin approval OR explicitly deactivated.
  // Both states are blocking — we use the same screen because from the
  // user's perspective the experience is the same ("you can't get in;
  // talk to an admin").
  const isPending = !profile.approved_at;
  const isDeactivated = profile.approved_at && !profile.active;
  if (isPending || isDeactivated) {
    return (
      <AuthContext.Provider value={{ loading, profile, signOut, refreshProfile }}>
        <PendingApproval
          email={profile.email}
          onSignOut={signOut}
          onRefresh={refreshProfile}
        />
      </AuthContext.Provider>
    );
  }

  // Gate 2: must set a PIN before continuing. This catches:
  //   - users who somehow got an active profile without a PIN
  //   - users whose PIN an admin reset
  if (!profile.pin_set_at) {
    return (
      <AuthContext.Provider value={{ loading, profile, signOut, refreshProfile }}>
        <PinGate
          mode="set"
          email={profile.email}
          onUnlocked={() => {
            markPinUnlocked(profile.id);
            setPinTick(t => t + 1);
            // Re-fetch so pin_set_at flips to non-null and we stop showing this.
            void refreshProfile();
          }}
          onSignOut={signOut}
        />
      </AuthContext.Provider>
    );
  }

  // Gate 3: PIN set but this browser session hasn't unlocked yet.
  void pinTick;  // referenced so the dep is tracked even though we read off sessionStorage
  if (!isPinUnlocked(profile.id)) {
    return (
      <AuthContext.Provider value={{ loading, profile, signOut, refreshProfile }}>
        <PinGate
          mode="enter"
          email={profile.email}
          isSuperAdmin={profile.is_super_admin}
          onUnlocked={() => {
            markPinUnlocked(profile.id);
            setPinTick(t => t + 1);
          }}
          onSignOut={signOut}
        />
      </AuthContext.Provider>
    );
  }

  // All gates clear.
  return (
    <AuthContext.Provider value={{ loading, profile, signOut, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  );
}
