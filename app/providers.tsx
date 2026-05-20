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
    // ---- Theme: read stored preference or system ----
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

    // 10s failsafe: only fires if the listener never resolves at all (Supabase outage).
    // Generous because slow networks on real devices can take >4s. If it fires, we
    // give up and fall through to /login.
    const failsafe = setTimeout(() => {
      if (!cancelled && !bootstrapped) {
        console.warn("[Providers] auth bootstrap timed out; falling back to logged-out");
        bootstrapped = true;
        setLoading(false);
      }
    }, 10000);

    // onAuthStateChange fires INITIAL_SESSION on subscribe AND every subsequent
    // SIGNED_IN / SIGNED_OUT / TOKEN_REFRESHED / USER_UPDATED. INITIAL_SESSION
    // makes a separate getSession() redundant — and having both running caused a
    // race where the second path would re-flash loading=true and, on a failed
    // refetch, clobber the valid profile with null → bouncing the user to /login
    // mid-session. So: one path, with explicit bootstrap-vs-refresh handling.
    const { data: sub } = c.auth.onAuthStateChange(async (_event, session) => {
      if (cancelled) return;

      if (!session) {
        bootstrapped = true;
        setProfile(null);
        setLoading(false);
        clearTimeout(failsafe);
        return;
      }

      // Post-bootstrap events (TOKEN_REFRESHED, USER_UPDATED) — refresh the
      // profile in the background, but DON'T re-show the spinner and DON'T
      // overwrite a known-good profile with null on a transient fetch failure.
      if (bootstrapped) {
        const prof = await fetchProfile(session.user.id);
        if (cancelled) return;
        if (prof) setProfile(prof);
        return;
      }

      // First bootstrap: keep loading=true while we resolve the profile so the
      // redirect effect can't bounce to /login during the fetch.
      const prof = await fetchProfile(session.user.id);
      if (cancelled) return;
      bootstrapped = true;
      setProfile(prof);
      setLoading(false);
      clearTimeout(failsafe);
    });

    return () => {
      cancelled = true;
      clearTimeout(failsafe);
      sub.subscription.unsubscribe();
    };
  }, []);

  // Redirect logic: must be logged in to see anything except /login
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
