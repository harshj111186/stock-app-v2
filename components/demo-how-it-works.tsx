"use client";
// Demo-only "How it works" explainer. Plain-language, no jargon — built so a
// non-technical business owner browsing the public demo immediately understands
// what the app does. Auto-opens once per session; re-openable from the demo badge.
import { useEffect, useState } from "react";

const STEPS = [
  { n: "1", t: "One place for every item", d: "Your full catalogue — brands, sizes, prices — lives in one tidy list, instead of scattered registers or Excel sheets." },
  { n: "2", t: "Update as you buy & sell", d: "Staff record purchases and sales in a tap. Stock for each godown updates on its own — no manual tallying." },
  { n: "3", t: "See the real picture, live", d: "Owners see live stock value, what's running low, what isn't selling, and the day's activity — from a phone or computer, anywhere." },
  { n: "4", t: "Catch problems early", d: "Out-of-stock and low-stock alerts, top sellers and slow-moving items surface on their own, so you reorder at the right time." },
];

export function DemoHowItWorks() {
  // Lazy init (computed once) so React Strict Mode's double-mount in dev can't
  // close it: we mark "seen" on close, never on open.
  const [open, setOpen] = useState(() => {
    try { return sessionStorage.getItem("demo_hiw_seen") !== "1"; } catch { return true; }
  });
  useEffect(() => {
    const h = () => setOpen(true);
    window.addEventListener("demo:hiw", h);
    return () => window.removeEventListener("demo:hiw", h);
  }, []);
  const close = () => { try { sessionStorage.setItem("demo_hiw_seen", "1"); } catch {} setOpen(false); };
  if (!open) return null;
  return (
    <div onClick={close} className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-2xl overflow-hidden">
        <div className="px-6 pt-6 pb-4 bg-gradient-to-br from-cyan-500/10 to-violet-500/10 border-b border-zinc-200 dark:border-zinc-800">
          <div className="text-[11px] font-medium tracking-wider uppercase text-cyan-600 dark:text-cyan-400 mb-1">You're viewing a live demo</div>
          <h2 className="text-xl font-semibold tracking-tight">How Stock Manager works</h2>
          <p className="text-sm text-zinc-500 mt-1">A simple, always-live view of your shop's stock — on every device.</p>
        </div>
        <div className="px-6 py-5 space-y-4">
          {STEPS.map((s) => (
            <div key={s.n} className="flex gap-3.5">
              <div className="flex-shrink-0 w-7 h-7 rounded-full bg-cyan-500 text-white text-sm font-semibold flex items-center justify-center">{s.n}</div>
              <div>
                <div className="font-medium text-sm text-zinc-900 dark:text-zinc-100">{s.t}</div>
                <div className="text-sm text-zinc-500 leading-relaxed mt-0.5">{s.d}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="px-6 py-4 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-between gap-3 bg-zinc-50 dark:bg-zinc-900/50">
          <p className="text-xs text-zinc-500">Everything here is sample data — real numbers stay private. <span className="hidden sm:inline">Built by Nexvia.</span></p>
          <button onClick={close} className="flex-shrink-0 bg-cyan-500 hover:bg-cyan-400 text-white text-sm font-medium px-5 py-2 rounded-lg transition-colors">Explore the demo →</button>
        </div>
      </div>
    </div>
  );
}
