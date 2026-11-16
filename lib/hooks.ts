"use client";
import { useEffect, useRef, useState } from "react";

// Close-on-Escape for modals/sheets. Active only while `active` is true.
// Stacked layers: ONLY the most recently opened active layer reacts. Every
// layer listens on window, and stopPropagation can't stop sibling window
// listeners — so before this, Escape in the category picker also closed the
// Add-item form underneath it and lost everything typed (review, 16 Nov 2026).
// The callback lives in a ref so re-renders don't re-register the listener
// (which would re-order the stack and put the parent back on top).
const escStack: number[] = [];
let escSeq = 0;
export function useEscape(active: boolean, onClose: () => void) {
  const cb = useRef(onClose);
  useEffect(() => { cb.current = onClose; });
  useEffect(() => {
    if (!active) return;
    const id = ++escSeq;
    escStack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (escStack[escStack.length - 1] !== id) return;
      e.stopPropagation();
      cb.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const i = escStack.indexOf(id);
      if (i >= 0) escStack.splice(i, 1);
    };
  }, [active]);
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
