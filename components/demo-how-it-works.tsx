"use client";
// Demo-only "How it works" explainer. Plain-language, no jargon — built so a
// non-technical business owner browsing the public demo immediately understands
// what the app does, what each role can do, and the owner-only controls.
// Auto-opens once per session; re-openable from the demo badge.
import { useEffect, useState } from "react";

const STEPS = [
  { t: "Everything in one catalogue", d: "Brands, sizes, prices and live stock for every godown sit in one place — no more scattered registers or Excel sheets." },
  { t: "Record as you buy & sell", d: "Staff log purchases and sales in a tap; stock for each godown updates on its own — no manual tallying." },
  { t: "Owners see the whole picture", d: "Live stock value, low-stock and out-of-stock alerts, top sellers, dead stock and the day's activity — on any device." },
  { t: "Every change is logged", d: "An audit trail records who changed what and when, so month-end is never a guessing game. Only the owner can open it." },
  { t: "People join only when you allow it", d: "A new team member stays locked out until an owner approves them and picks their role — and a 4-digit PIN guards the app on every device." },
];
const ROLES = [
  { who: "Owner / Admin", what: "approves new users, sets each person's role, manages pricing & categories, and sees the full audit log." },
  { who: "Staff vs Viewer", what: "Staff record stock, sales and purchases; Viewers are look-only, with editing switched off." },
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
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg max-h-[88vh] overflow-y-auto bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-2xl">
        <div className="px-6 pt-6 pb-4 bg-gradient-to-br from-cyan-500/10 to-violet-500/10 border-b border-zinc-200 dark:border-zinc-800">
          <div className="text-[11px] font-medium tracking-wider uppercase text-cyan-600 dark:text-cyan-400 mb-1">You're viewing a live demo</div>
          <h2 className="text-xl font-semibold tracking-tight">How Stock Manager works</h2>
          <p className="text-sm text-zinc-500 mt-1">One always-live view of your shop's stock — with the right access for each person.</p>
        </div>
        <div className="px-6 py-5 space-y-4">
          {STEPS.map((s, i) => (
            <div key={i} className="flex gap-3.5">
              <div className="flex-shrink-0 w-7 h-7 rounded-full bg-cyan-500 text-white text-sm font-semibold flex items-center justify-center">{i + 1}</div>
              <div>
                <div className="font-medium text-sm text-zinc-900 dark:text-zinc-100">{s.t}</div>
                <div className="text-sm text-zinc-500 leading-relaxed mt-0.5">{s.d}</div>
              </div>
            </div>
          ))}
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/40 p-4 space-y-2">
            <div className="text-[11px] font-medium tracking-wider uppercase text-zinc-400">Who can do what</div>
            {ROLES.map((r, i) => (
              <div key={i} className="text-sm text-zinc-500 leading-relaxed"><span className="font-medium text-zinc-900 dark:text-zinc-100">{r.who}</span> — {r.what}</div>
            ))}
          </div>
        </div>
        <div className="px-6 py-4 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-between gap-3 bg-zinc-50 dark:bg-zinc-900/50">
          <p className="text-xs text-zinc-500">Everything here is sample data — real numbers stay private. <span className="hidden sm:inline">Built by Nexvia.</span></p>
          <button onClick={close} className="flex-shrink-0 bg-cyan-500 hover:bg-cyan-400 text-white text-sm font-medium px-3.5 py-2 rounded-md transition-colors">Explore the demo →</button>
        </div>
      </div>
    </div>
  );
}
