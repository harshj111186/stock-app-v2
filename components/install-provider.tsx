"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// PWA install + service-worker registration.
//
// Two things bundled together because they're both "browser-feature
// bootstrap" — neither needs UI on its own, both run once at app start:
//
//   1. Registers /sw.js so Chrome/Edge desktop will consider the app
//      installable. Without a SW with a fetch handler, the omnibox install
//      button never appears on desktop.
//
//   2. Captures the `beforeinstallprompt` event into React state. Chrome
//      fires this once per browsing session when the site meets the install
//      criteria. We park the deferred prompt so any UI can call .prompt()
//      via the useInstall() hook later — typically a sidebar/topbar button.
//
// Mobile gets covered by the manifest alone (Add to Home Screen). This
// provider is mostly about desktop.

type Outcome = "accepted" | "dismissed" | "unavailable";

type InstallState = {
  // True once Chrome/Edge has fired beforeinstallprompt. Stays true until
  // the user accepts or we manually clear it on `appinstalled`.
  canInstall: boolean;
  // Calls the deferred prompt and returns the outcome. Returns "unavailable"
  // if there's no prompt to fire (Safari, Firefox, already-installed, or
  // before Chrome decides the site is installable yet).
  install: () => Promise<Outcome>;
  // True if the app is currently running in standalone mode (installed PWA
  // window, or iOS home-screen launcher). Used to hide the Install button
  // when there's nothing to install.
  isStandalone: boolean;
};

const InstallContext = createContext<InstallState>({
  canInstall: false,
  install: async () => "unavailable",
  isStandalone: false,
});

export const useInstall = () => useContext(InstallContext);

// Chrome's beforeinstallprompt isn't in standard lib.dom types yet. Local
// minimal interface to avoid `any`.
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

export function InstallProvider({ children }: { children: ReactNode }) {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    // ── Service-worker registration ────────────────────────────────────
    // Only in production: dev mode runs without basePath, and `next dev`
    // doesn't serve files from `public/` at predictable URLs during HMR.
    // Trying to register in dev produces noisy 404s with no upside.
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      const swPath = "/stock-app-v2/sw.js";
      const scope  = "/stock-app-v2/";
      navigator.serviceWorker
        .register(swPath, { scope })
        .catch((e) => console.warn("[SW] register failed", e));
    }

    // ── Standalone detection ───────────────────────────────────────────
    // display-mode: standalone is the modern signal. navigator.standalone
    // covers older iOS Safari which doesn't support the media query.
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      // @ts-expect-error iOS-only property, not in TS lib
      window.navigator.standalone === true;
    setIsStandalone(standalone);

    // ── Install prompt capture ────────────────────────────────────────
    const onBeforeInstall = (e: Event) => {
      // Stops Chrome's default mini-infobar; we'll surface our own UI.
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      // After install, the event won't fire again until uninstall + meet
      // criteria again. Hide the button.
      setDeferred(null);
      setIsStandalone(true);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = async (): Promise<Outcome> => {
    if (!deferred) return "unavailable";
    try {
      await deferred.prompt();
      const choice = await deferred.userChoice;
      setDeferred(null); // event is one-shot; clear regardless of outcome
      return choice.outcome;
    } catch (e) {
      console.warn("[install] prompt failed", e);
      return "unavailable";
    }
  };

  return (
    <InstallContext.Provider value={{ canInstall: !!deferred, install, isStandalone }}>
      {children}
    </InstallContext.Provider>
  );
}
