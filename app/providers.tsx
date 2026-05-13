"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import { sb, type Profile } from "@/lib/supabase";

type AuthState = { loading: boolean; profile: Profile | null; signOut: () => Promise<void> };
const AuthContext = createContext<AuthState>({ loading: true, profile: null, signOut: async () => {} });
export const useAuth = () => useContext(AuthContext);

export function Providers({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    // Theme: read stored preference or system
    const stored = localStorage.getItem("theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (stored === "light" || (!stored && !prefersDark)) {
      document.documentElement.classList.remove("dark");
    } else {
      document.documentElement.classList.add("dark");
    }

    // Auth: load session + listen for changes
    const c = sb();
    (async () => {
      const { data: { session } } = await c.auth.getSession();
      if (!session) { setLoading(false); return; }
      const { data: prof } = await c.from("user_profiles").select("*").eq("id", session.user.id).single();
      setProfile(prof as Profile | null);
      setLoading(false);
    })();

    const { data: sub } = c.auth.onAuthStateChange(async (_event, session) => {
      if (!session) { setProfile(null); return; }
      const { data: prof } = await c.from("user_profiles").select("*").eq("id", session.user.id).single();
      setProfile(prof as Profile | null);
    });
    return () => sub.subscription.unsubscribe();
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
