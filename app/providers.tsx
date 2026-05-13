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
    const stored = localStorage.getItem("theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (stored === "light" || (!stored && !prefersDark)) {
      document.documentElement.classList.remove("dark");
    } else {
      document.documentElement.classList.add("dark");
    }

    let cancelled = false;
    const c = sb();

    const failsafe = setTimeout(() => {
      if (!cancelled) {
        console.warn("[Providers] auth bootstrap timed out; falling back");
        setLoading(false);
      }
    }, 4000);

    const { data: sub } = c.auth.onAuthStateChange(async (_event, session) => {
      if (cancelled) return;
      if (!session) { setProfile(null); setLoading(false); clearTimeout(failsafe); return; }
      const prof = await fetchProfile(session.user.id);
      if (cancelled) return;
      setProfile(prof); setLoading(false); clearTimeout(failsafe);
    });

    c.auth.getSession().then(async ({ data: { session } }) => {
      if (cancelled) return;
      if (!session) { setLoading(false); clearTimeout(failsafe); return; }
      const prof = await fetchProfile(session.user.id);
      if (cancelled) return;
      setProfile(prof); setLoading(false); clearTimeout(failsafe);
    }).catch((e) => {
      console.warn("[Providers] getSession failed", e);
      if (!cancelled) { setLoading(false); clearTimeout(failsafe); }
    });

    return () => {
      cancelled = true;
      clearTimeout(failsafe);
      sub.subscription.unsubscribe();
    };
  }, []);

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
