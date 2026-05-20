"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import { sb, type Profile } from "@/lib/supabase";

type AuthState = { loading: boolean; profile: Profile | null; signOut: () => Promise<void> };
const AuthContext = createContext<AuthState>({ loading: true, profile: null, signOut: async () => {} });
export const useAuth = () => useContext(AuthContext);

async function fetchProfile(userId: string): Promise<Profile | null> {
  try {
    const { data, error } = await sb()
      .from("user_profiles")
      .select("*")
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
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    // ---- Theme ----
    const stored = localStorage.getItem("theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (stored === "light" || (!stored && !prefersDark)) {
      document.documentElement.classList.remove("dark");
    } else {
      document.documentElement.classList.add("dark");
    }

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

    // CRITICAL: this listener must be synchronous (returns undefined immediately).
    // supabase-js' _notifyAllSubscribers runs during the auth client's _initialize()
    // *while still holding the internal auth lock*. If the listener returns a Promise
    // that awaits any SDK call (fetchProfile uses sb().from('user_profiles')...),
    // that SDK call queues behind the still-running init → INIT NEVER COMPLETES →
    // listener never returns → deadlock. Symptom on the live site: loading spinner
    // hangs for 10s, failsafe fires, dashboard bounces to /login.
    //
    // Fix: capture the session synchronously, defer the profile fetch into a separate
    // task via setTimeout(0). By the time the deferred task runs, the SDK's init has
    // finished, the lock has been released, and fetchProfile can complete normally.
    const { data: sub } = c.auth.onAuthStateChange((_event, session) => {
      if (cancelled) return;

      if (!session) {
        bootstrapped = true;
        setProfile(null);
        setLoading(false);
        clearTimeout(failsafe);
        return;
      }

      // Background profile resolution — does NOT block the SDK's notify loop.
      const userId = session.user.id;
      setTimeout(async () => {
        if (cancelled) return;
        try {
          if (bootstrapped) {
            // Post-bootstrap event (TOKEN_REFRESHED, USER_UPDATED): refresh silently.
            // Don't re-show the spinner; don't clobber a known-good profile with null.
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

  // Redirect: must be logged in to see anything except /login
  useEffect(() => {
    if (loading) return;
    const onLogin = pathname?.endsWith("/login") || pathname?.endsWith("/login/");
    if (!profile && !onLogin) router.replace("/login");
    if (profile && onLogin) router.replace("/");
  }, [loading, profile, pathname, router]);

  const signOut = async () => {
    await sb().auth.signOut();
    setProfile(null);
    router.replace("/login");
  };

  return <AuthContext.Provider value={{ loading, profile, signOut }}>{children}</AuthContext.Provider>;
}
