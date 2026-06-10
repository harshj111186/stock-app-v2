"use client";
import { useEffect, useState } from "react";

// Close-on-Escape for modals/sheets. Active only while `active` is true so
// stacked dialogs don't all close at once (mount the hook in the top one).
export function useEscape(active: boolean, onClose: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onClose]);
}

// Reactive dark-mode flag for places that can't use Tailwind classes
// (Recharts inline styles). Tracks the `dark` class on <html> live, so
// charts re-skin the moment the theme toggle flips (they used to read the
// class once and keep stale tooltip colours).
export function useIsDark(): boolean {
  const [dark, setDark] = useState(true);
  useEffect(() => {
    const el = document.documentElement;
    const update = () => setDark(el.classList.contains("dark"));
    update();
    const obs = new MutationObserver(update);
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

// Media-query hook with a LAZY initial read — initialising to `false` and
// correcting in an effect makes desktop briefly mount the mobile tree on
// first paint (visible flash on heavy pages like Reconciliation).
export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatch(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return match;
}
