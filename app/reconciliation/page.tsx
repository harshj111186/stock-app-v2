"use client";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Printer, ClipboardCheck, CheckCircle2, AlertCircle,
  RotateCcw, Loader2, Filter, Eye, EyeOff, Users, ShieldCheck,
  UserCircle2, Clock, Lock, LockOpen, CheckCheck, AlertTriangle, UserPlus,
  Minus, Plus,
} from "lucide-react";
import { Shell } from "@/components/shell";
import { sb, type Item } from "@/lib/supabase";
import { useAuth } from "@/app/providers";
import { fmtN, cn, matchesQuery } from "@/lib/utils";
import { FilterSheet, SheetField, FilterButton } from "@/components/filter-sheet";
import { SearchBox } from "@/components/search-box";

// ─── Reconciliation page ─────────────────────────────────────────────────
//
// Physical stock-take workflow. Each user gets their own draft scope via
// the `reconciliation_drafts` table (see db/2026-05-24-…sql). The page
// has two modes:
//
//   "My count" — every user sees & edits only their own drafts.
//   "Reviewer" — admin-only. Shows every user's drafts grouped by item,
//                flags rows where two users disagree, lets admin edit
//                anyone's draft inline, and is where "Make adjustments"
//                lives.
//
// Staff never see a commit button — admin is the only one who turns
// drafts into actual stock changes. Conflicts (different users entering
// different values for the same item) block that item from being
// committed; admin must edit until drafts agree (or ask the staff to
// recount), then commit.
//
// Each input accepts arithmetic-sum expressions ("5+1+2" = 8) so you
// can append "+1" when you find another piece without retyping a
// running total.

// ─── types ───────────────────────────────────────────────────────────────
type Godown = "A" | "B";
type AppStock = { cases: number; loose: number; hasStockRow: boolean };

// One row out of reconciliation_drafts_with_user
type DBDraft = {
  id: string;
  user_id: string;
  item_id: string;
  case_size_raw: string;
  a_cases_raw: string;
  a_loose_raw: string;
  b_cases_raw: string;
  b_loose_raw: string;
  updated_at: string;
  user_email: string | null;
  user_name: string | null;
  user_role: string | null;
  // Owner's "I have finished my whole count" flag (joined from
  // reconciliation_done). When true, this counter's entries are frozen and a
  // BLANK on an item someone else filled counts as "found nothing" (= 0).
  user_done?: boolean;
  user_done_at?: string | null;
};

// Local mirror, keyed by `${user_id}::${item_id}` so writes can be
// debounced per-row without colliding.
type DraftKey = string;
const dkey = (uid: string, iid: string): DraftKey => `${uid}::${iid}`;

// Each input field name (used by setField etc.)
type Field = "case_size" | "a_cases" | "a_loose" | "b_cases" | "b_loose";
const FIELDS_RAW: Record<Field, keyof Pick<DBDraft, "case_size_raw" | "a_cases_raw" | "a_loose_raw" | "b_cases_raw" | "b_loose_raw">> = {
  case_size: "case_size_raw",
  a_cases: "a_cases_raw",
  a_loose: "a_loose_raw",
  b_cases: "b_cases_raw",
  b_loose: "b_loose_raw",
};

type LastReconciled = { at: string; userName: string | null };

// ─── helpers ─────────────────────────────────────────────────────────────
function parseExpr(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (!/^[\d+\s]+$/.test(s)) return null;
  const parts = s.split("+").map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  let total = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    total += parseInt(p, 10);
  }
  return total;
}
const TODAY = () => new Date().toISOString().slice(0, 10);
const pieces = (cs: number, cases: number, loose: number) =>
  cs > 0 ? cases * cs + loose : loose;

// "4×4 + 2 = 18" style breakup. When case size is 0, items are loose-only
// so we just show the loose count.
function breakupStr(cs: number, cases: number, loose: number): string {
  if (cs > 0) return `${fmtN(cases)}×${cs} + ${fmtN(loose)} = ${fmtN(cases * cs + loose)} pcs`;
  return `${fmtN(loose)} pcs (loose)`;
}

// Pull one user's entered values for a single godown out of their draft.
// Uses their own case-size entry if present, else the item's current one.
function draftSide(d: DBDraft, g: Godown, itemCs: number) {
  const cs = parseExpr(d.case_size_raw) ?? itemCs;
  const cRaw = g === "A" ? d.a_cases_raw : d.b_cases_raw;
  const lRaw = g === "A" ? d.a_loose_raw : d.b_loose_raw;
  const touched = cRaw.trim() !== "" || lRaw.trim() !== "";
  const cases = parseExpr(cRaw) ?? 0;
  const loose = parseExpr(lRaw) ?? 0;
  return { touched, cases, loose, cs, pcs: pieces(cs, cases, loose) };
}

function timeAgo(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const sec = Math.max(0, Math.round((now - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d}d ago`;
  const mo = Math.round(d / 30);
  return `${mo}mo ago`;
}

const displayUser = (d: DBDraft) =>
  d.user_name?.trim() || d.user_email?.split("@")[0] || "Unknown";

// ─── design-system primitives ─────────────────────────────────────────────
// One visual grammar reused on every surface so a non-technical user learns it
// once:  system reference = quiet zinc, always labelled, NEVER inside a box ·
// the count input is the only white/bordered element (shows "—" when empty) ·
// the diff is the single saturated signal (emerald = surplus, rose = shortage).

// SSR-safe media query so we mount EITHER the desktop table OR the mobile
// cards — never both (halves the DOM/handlers on the heaviest screen).
function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(false);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return match;
}

// Labelled system-reference chip (quiet; never an input).
function SysChip({ label = "SYS", children, className }: { label?: string; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800/80 text-[11px] tabular-nums text-zinc-600 dark:text-zinc-300", className)}>
      <span className="text-[9px] font-semibold tracking-wider text-zinc-400 dark:text-zinc-500">{label}</span>
      {children}
    </span>
  );
}

// The single coloured signal — render ONLY when a side was counted & valid.
function DiffPill({ diff }: { diff: number }) {
  const cls = diff === 0
    ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400"
    : diff > 0
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : "bg-rose-500/15 text-rose-700 dark:text-rose-300";
  const txt = diff === 0 ? "In balance" : `${diff > 0 ? "+" : "−"}${fmtN(Math.abs(diff))} pcs`;
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums whitespace-nowrap", cls)}>{txt}</span>;
}

// Labelled "done" badge (accessible — replaces bare ✓ glyphs).
function DoneBadge() {
  return (
    <span className="inline-flex items-center gap-0.5 px-1 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-[9px] uppercase tracking-wide font-medium">
      <Lock className="w-2.5 h-2.5" /> done
    </span>
  );
}

// One "label … value (+ optional trailing pill)" reference line.
function LedgerRow({ label, value, tone = "ref", trailing }: { label: string; value: React.ReactNode; tone?: "ref" | "you"; trailing?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[10px] uppercase tracking-wide text-zinc-500 flex-shrink-0">{label}</span>
      <span className="flex items-baseline gap-2 min-w-0 justify-end">
        <span className={cn("text-[11px] tabular-nums", tone === "you" ? "font-medium text-zinc-800 dark:text-zinc-100" : "text-zinc-500 dark:text-zinc-400")}>{value}</span>
        {trailing}
      </span>
    </div>
  );
}

// Cross-staff delta line (subordinate to your own DiffPill). The word
// over/under/match carries the meaning so it isn't colour-only.
function PeerLine({ name, pcs, delta, done }: { name: string; pcs: number; delta: number | null; done: boolean }) {
  const off = delta !== null && delta !== 0;
  const txt = delta === null
    ? `${fmtN(pcs)} pcs`
    : delta === 0
      ? `${fmtN(pcs)} pcs (match)`
      : `${fmtN(pcs)} pcs (${delta > 0 ? "+" : "−"}${fmtN(Math.abs(delta))} ${delta > 0 ? "over" : "under"})`;
  return (
    <div className={cn("flex items-baseline justify-between gap-2 text-[10px] tabular-nums", off ? "text-rose-600/90 dark:text-rose-400/90 font-medium" : "text-cyan-700/80 dark:text-cyan-400/80")}>
      <span className="truncate inline-flex items-center gap-1">{name}{done && <Lock className="w-2.5 h-2.5 flex-shrink-0" />}</span>
      <span className="flex-shrink-0">{txt}</span>
    </div>
  );
}

// ─── component ───────────────────────────────────────────────────────────
export default function ReconciliationPage() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";
  const canCommit = isAdmin;

  const [items, setItems] = useState<Item[]>([]);
  const [appStock, setAppStock] = useState<Map<string, { A: AppStock; B: AppStock }>>(new Map());
  const [catNameById, setCatNameById] = useState<Map<string, string>>(new Map());
  const [drafts, setDrafts] = useState<Map<DraftKey, DBDraft>>(new Map());
  // Mirror of `drafts` that survives component unmount. persistDraft reads
  // from this ref so a pending save fired by a timer (or by the
  // unmount-flush below) still sees the latest input even after the user
  // navigated away and React state went stale. Helper writeDrafts() keeps
  // both in sync — call it everywhere drafts changes (load, refresh,
  // setField, deleteDraft, etc.) instead of bare setDrafts.
  const draftsRef = useRef<Map<DraftKey, DBDraft>>(new Map());
  const writeDrafts = useCallback((next: Map<DraftKey, DBDraft>) => {
    draftsRef.current = next;
    setDrafts(next);
  }, []);
  // Display-name lookup (user_id → friendly name), populated by load(). Used by
  // refreshDone (which doesn't re-fetch profiles) to name done-but-no-draft
  // counters in the reviewer's conflict reasons.
  const peopleRef = useRef<Map<string, string>>(new Map());
  const [lastRecon, setLastRecon] = useState<Map<string, LastReconciled>>(new Map());
  // Per-user "count finished" flags (reconciliation_done), keyed by user_id.
  // Includes users who marked done even if they have zero draft rows.
  const [doneByUser, setDoneByUser] = useState<Map<string, { done: boolean; at: string | null; name: string | null }>>(new Map());
  const [loaded, setLoaded] = useState(false);

  const itemById = useMemo(() => new Map(items.map(i => [i.id, i])), [items]);
  const myDone = profile?.id ? (doneByUser.get(profile.id)?.done ?? false) : false;
  // Selectable counters (active admin/staff) — used by the reviewer's
  // "add a count for …" picker.
  const [people, setPeople] = useState<{ id: string; name: string; role: string }[]>([]);
  const peopleListRef = useRef<{ id: string; name: string; role: string }[]>([]);
  // Which item is mid per-item apply (disables that card's apply buttons).
  const [applyingItemId, setApplyingItemId] = useState<string | null>(null);

  // UI mode
  const [mode, setMode] = useState<"my" | "reviewer">("my");
  useEffect(() => {
    if (!isAdmin && mode === "reviewer") setMode("my");
  }, [isAdmin, mode]);

  // Filters
  const [q, setQ] = useState("");
  const [brand, setBrand] = useState("");
  const [cat, setCat] = useState("");
  const [showOnlyChanged, setShowOnlyChanged] = useState(false);
  // Reviewer-only: collapse the list to items that currently have a conflict.
  const [conflictsOnly, setConflictsOnly] = useState(false);

  // Commit + toast state
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  // Pre-commit confirmation (Make adjustments) — shows what will move and the
  // census option ("full count → zero what nobody found") before anything writes.
  const [commitConfirm, setCommitConfirm] = useState<null | {
    counted: number; conflicted: number; uncountedItems: number; uncountedSides: number; notDone: string[];
  }>(null);
  const [censusZero, setCensusZero] = useState(true);
  const [errors, setErrors] = useState<Array<{ itemId: string; godown?: Godown; message: string }>>([]);
  const [toast, setToast] = useState<{ kind: "ok" | "bad" | "info"; text: string } | null>(null);
  const toastTimer = useRef<number | null>(null);
  const showToast = (kind: "ok" | "bad" | "info", text: string) => {
    setToast({ kind, text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 5000);
  };

  // ─── load ──────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    const c = sb();
    const [
      { data: rows },
      { data: stock },
      { data: cats },
      { data: draftsData },
      { data: txns },
      { data: profiles },
      { data: doneRows },
    ] = await Promise.all([
      c.from("items").select("*").eq("archived", false).order("item_code"),
      c.from("godown_stock").select("*"),
      c.from("categories").select("id, name"),
      c.from("reconciliation_drafts_with_user").select("*"),
      // Latest reconciliation per item — pull plenty and dedupe client-side.
      c.from("transactions")
        .select("item_id, created_at, created_by, reason")
        .like("reason", "Reconciliation%")
        .order("created_at", { ascending: false })
        .limit(2000),
      c.from("user_profiles").select("id, name, email, role, active"),
      c.from("reconciliation_done").select("user_id, done, done_at"),
    ]);

    const blank: AppStock = { cases: 0, loose: 0, hasStockRow: false };
    const stockMap = new Map<string, { A: AppStock; B: AppStock }>();
    (rows || []).forEach((i: any) => stockMap.set(i.id, { A: { ...blank }, B: { ...blank } }));
    (stock || []).forEach((s: any) => {
      const cur = stockMap.get(s.item_id);
      if (!cur) return;
      cur[s.godown as Godown] = { cases: s.cases ?? 0, loose: s.loose ?? 0, hasStockRow: true };
    });

    const draftsMap = new Map<DraftKey, DBDraft>();
    (draftsData || []).forEach((d: any) => draftsMap.set(dkey(d.user_id, d.item_id), d as DBDraft));

    const profileById = new Map<string, { name: string | null; email: string | null }>();
    (profiles || []).forEach((p: any) => profileById.set(p.id, { name: p.name ?? null, email: p.email ?? null }));
    peopleRef.current = new Map(
      (profiles || []).map((p: any) => [p.id, (p.name?.trim() || p.email?.split("@")[0] || "Counter") as string])
    );
    const counters = (profiles || [])
      .filter((p: any) => p.active && (p.role === "admin" || p.role === "staff"))
      .map((p: any) => ({ id: p.id, name: (p.name?.trim() || p.email?.split("@")[0] || "Counter") as string, role: p.role as string }))
      .sort((a, b) => a.name.localeCompare(b.name));
    peopleListRef.current = counters;
    setPeople(counters);

    const doneMap = new Map<string, { done: boolean; at: string | null; name: string | null }>();
    (doneRows || []).forEach((r: any) => {
      const prof = profileById.get(r.user_id);
      doneMap.set(r.user_id, {
        done: !!r.done,
        at: r.done_at ?? null,
        name: prof?.name?.trim() || prof?.email?.split("@")[0] || null,
      });
    });

    const lastMap = new Map<string, LastReconciled>();
    (txns || []).forEach((t: any) => {
      if (lastMap.has(t.item_id)) return; // already have the latest (ordered desc)
      const prof = t.created_by ? profileById.get(t.created_by) : null;
      lastMap.set(t.item_id, {
        at: t.created_at,
        userName: prof?.name?.trim() || prof?.email?.split("@")[0] || null,
      });
    });

    setItems((rows || []) as Item[]);
    setAppStock(stockMap);
    setCatNameById(new Map((cats || []).map((c: any) => [c.id, c.name])));
    writeDrafts(draftsMap);
    setDoneByUser(doneMap);
    setLastRecon(lastMap);
    setLoaded(true);
  }, [writeDrafts]);

  useEffect(() => { void load(); }, [load]);

  // ─── pending saves (debounced upserts) ─────────────────────────────────
  // One timer per (user, item) — we coalesce keystrokes locally and fire a
  // single upsert ~200 ms after the last keystroke for that row. Tracked
  // up here so the polling refresh below can check whether a row is
  // mid-save and skip it.
  const saveTimers = useRef<Map<DraftKey, number>>(new Map());
  // Keys with an unsaved local edit (set on keystroke, cleared once the server
  // ack confirms the row matches what we sent). The poll never overwrites a
  // key that is "in flight" — either a debounce timer is pending OR it's dirty.
  // This replaces the old client-timestamp comparison, which could clobber a
  // freshly-typed value on a clock-skewed phone (server clock > client clock).
  const dirtyRef = useRef<Set<DraftKey>>(new Set());

  // Refresh drafts on visibility regain + on the poll so other counters' edits
  // (and admin actions) show up without a full reload. The server is the
  // source of truth for every row EXCEPT one that is in flight (pending
  // debounce save or dirty) or a never-persisted local row (e.g. an
  // admin-added "Add a count for…" row awaiting its first keystroke). This
  // single in-flight guard protects whoever is editing — your own row, an
  // admin editing a staffer's row, or an admin-added row mid-entry — so no
  // poll can roll a keystroke back.
  const refreshDrafts = useCallback(async () => {
    if (!profile?.id) return;
    const { data } = await sb().from("reconciliation_drafts_with_user").select("*");
    const serverByKey = new Map<string, DBDraft>();
    (data || []).forEach((d: any) => serverByKey.set(dkey(d.user_id, d.item_id), d as DBDraft));

    const next = new Map(draftsRef.current);
    const inFlight = (k: string) => saveTimers.current.has(k) || dirtyRef.current.has(k);

    // Drop local rows the server no longer has (e.g. admin committed them),
    // unless in flight or never persisted.
    for (const [k, local] of [...draftsRef.current]) {
      if (inFlight(k) || serverByKey.has(k) || local.id.startsWith("local-")) continue;
      next.delete(k);
    }
    // Adopt every server row that isn't being edited locally right now.
    for (const [k, server] of serverByKey) {
      if (inFlight(k)) continue;
      next.set(k, server);
    }

    writeDrafts(next);
  }, [profile?.id, writeDrafts]);
  // Keep the system-stock baseline fresh too — it's now shown prominently next
  // to each count, and an admin may adjust stock elsewhere mid-count.
  const refreshAppStock = useCallback(async () => {
    const { data: stock } = await sb().from("godown_stock").select("*");
    if (!stock) return;
    setAppStock((prev) => {
      const blank: AppStock = { cases: 0, loose: 0, hasStockRow: false };
      const next = new Map<string, { A: AppStock; B: AppStock }>();
      for (const id of prev.keys()) next.set(id, { A: { ...blank }, B: { ...blank } });
      (stock as any[]).forEach((s) => {
        const cur = next.get(s.item_id);
        if (!cur) return;
        cur[s.godown as Godown] = { cases: s.cases ?? 0, loose: s.loose ?? 0, hasStockRow: true };
      });
      return next;
    });
  }, []);
  // Keep the per-user Done flags fresh so a counter sees when a teammate
  // finishes (which can flip "pending" rows into conflicts) and the reviewer
  // sees done state live. Preserves my own optimistic flag if a write is
  // racing the poll by trusting the server value (single-writer per row).
  const refreshDone = useCallback(async () => {
    const { data } = await sb().from("reconciliation_done").select("user_id, done, done_at");
    if (!data) return;
    setDoneByUser((prev) => {
      const next = new Map(prev);
      const seen = new Set<string>();
      (data as any[]).forEach((r) => {
        seen.add(r.user_id);
        const old = prev.get(r.user_id);
        next.set(r.user_id, { done: !!r.done, at: r.done_at ?? null, name: old?.name ?? peopleRef.current.get(r.user_id) ?? null });
      });
      // Drop rows that no longer exist server-side (admin reset after commit).
      for (const k of [...next.keys()]) if (!seen.has(k)) next.delete(k);
      return next;
    });
  }, []);

  useEffect(() => {
    // Pause polling during a commit — makeAdjustments mutates godown_stock one
    // row at a time, and a mid-commit refreshAppStock would flicker the diff
    // column as rows land. The post-commit load() is the authoritative refresh.
    if (!loaded || processing || applyingItemId) return;
    const onVis = () => { if (document.visibilityState === "visible") { void refreshDrafts(); void refreshAppStock(); void refreshDone(); } };
    document.addEventListener("visibilitychange", onVis);
    // Admin actively reviewing — refresh fast (3s) so staff typing shows up
    // near-live. In My count we now also surface other counters' deltas, so
    // refresh at a calm 12s (was 30s) to keep peer numbers reasonably live
    // without thrashing while someone is entering their own count.
    const intervalMs = mode === "reviewer" ? 3000 : 12000;
    const id = window.setInterval(() => { void refreshDrafts(); void refreshAppStock(); void refreshDone(); }, intervalMs);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.clearInterval(id);
    };
  }, [loaded, processing, refreshDrafts, refreshAppStock, refreshDone, mode]);

  // Optimistic local mutation; the actual DB write happens debounced below.
  const setField = useCallback((userId: string, itemId: string, field: Field, value: string) => {
    const k = dkey(userId, itemId);
    dirtyRef.current.add(k); // unsaved edit — the poll must not overwrite this row
    const cur = draftsRef.current.get(k);
    const merged: DBDraft = cur
      ? { ...cur, [FIELDS_RAW[field]]: value, updated_at: new Date().toISOString() }
      : {
        id: "local-" + k,
        user_id: userId,
        item_id: itemId,
        case_size_raw: "",
        a_cases_raw: "",
        a_loose_raw: "",
        b_cases_raw: "",
        b_loose_raw: "",
        updated_at: new Date().toISOString(),
        user_email: profile?.email ?? null,
        user_name: profile?.name ?? null,
        user_role: profile?.role ?? null,
        [FIELDS_RAW[field]]: value,
      } as DBDraft;
    const next = new Map(draftsRef.current);
    next.set(k, merged);
    writeDrafts(next);

    // Debounced DB write — 200 ms after the last keystroke for this row.
    const existing = saveTimers.current.get(k);
    if (existing) clearTimeout(existing);
    const timer = window.setTimeout(() => {
      saveTimers.current.delete(k);
      void persistDraft(userId, itemId);
    }, 200);
    saveTimers.current.set(k, timer);
  }, [profile?.email, profile?.name, profile?.role, writeDrafts]);

  // Immediate flush — called on input blur so a value can't be lost if the
  // user closes the tab or switches away inside the debounce window. Fires
  // every pending save (usually 0 or 1 at any moment); simpler than
  // threading per-row callbacks through every component level.
  const flushAllPendingSaves = useCallback(() => {
    for (const [k, timer] of saveTimers.current) {
      clearTimeout(timer);
      saveTimers.current.delete(k);
      const [userId, itemId] = k.split("::");
      void persistDraft(userId, itemId);
    }
  }, []);

  // Read the latest local draft for (user, item) and either upsert (if any
  // field non-empty) or delete (if all empty). Reads from `draftsRef`
  // rather than React state so a timer that fires AFTER the component has
  // unmounted (during a route transition) still sees the user's latest
  // keystrokes and can persist them.
  const persistDraft = useCallback(async (userId: string, itemId: string) => {
    const k = dkey(userId, itemId);
    const snap = draftsRef.current.get(k);
    if (!snap) return;

    const allEmpty =
      !snap.case_size_raw.trim() && !snap.a_cases_raw.trim() && !snap.a_loose_raw.trim() &&
      !snap.b_cases_raw.trim() && !snap.b_loose_raw.trim();

    if (allEmpty) {
      const isLocal = snap.id.startsWith("local-");
      const next = new Map(draftsRef.current);
      next.delete(k);
      writeDrafts(next);
      dirtyRef.current.delete(k); // nothing left to save
      if (!isLocal) {
        await sb().from("reconciliation_drafts").delete().eq("user_id", userId).eq("item_id", itemId);
      }
      return;
    }

    // Snapshot exactly what we send, so on ack we can tell whether the user
    // typed more in the meantime (in which case a newer save is already queued
    // and we must stay dirty).
    const payload = {
      case_size_raw: snap.case_size_raw,
      a_cases_raw: snap.a_cases_raw,
      a_loose_raw: snap.a_loose_raw,
      b_cases_raw: snap.b_cases_raw,
      b_loose_raw: snap.b_loose_raw,
    };
    const { data, error } = await sb()
      .from("reconciliation_drafts")
      .upsert({ user_id: userId, item_id: itemId, ...payload }, { onConflict: "user_id,item_id" })
      .select("id, updated_at")
      .single();
    if (error) {
      // CRITICAL: the row is still dirty (protected from the poll). If we just
      // returned, dirtyRef would stay set with NO pending save → the poll would
      // skip this key forever (never re-sync, never drop after a commit). So
      // re-arm a backoff retry, which keeps the local value protected AND keeps
      // trying until the save lands (self-heals on reconnect / token refresh).
      // Skip the retry only if the row was deleted in the meantime.
      showToast("bad", `Couldn't save — retrying… (${error.message})`);
      if (draftsRef.current.has(k) && dirtyRef.current.has(k) && !saveTimers.current.has(k)) {
        const t = window.setTimeout(() => { saveTimers.current.delete(k); void persistDraft(userId, itemId); }, 3000);
        saveTimers.current.set(k, t);
      }
      return;
    }
    if (data) {
      const cur = draftsRef.current.get(k);
      if (!cur) return;
      const unchanged =
        cur.case_size_raw === payload.case_size_raw && cur.a_cases_raw === payload.a_cases_raw &&
        cur.a_loose_raw === payload.a_loose_raw && cur.b_cases_raw === payload.b_cases_raw &&
        cur.b_loose_raw === payload.b_loose_raw;
      const next = new Map(draftsRef.current);
      // Always clear the "local-" id (it's persisted now); only adopt the
      // server updated_at + clear dirty when the row still matches what we sent.
      next.set(k, unchanged ? { ...cur, id: data.id, updated_at: data.updated_at } : { ...cur, id: data.id });
      writeDrafts(next);
      if (unchanged) {
        dirtyRef.current.delete(k);
      } else if (!saveTimers.current.has(k)) {
        // Row changed mid-flight but somehow no save is queued — re-arm one so
        // the still-dirty key can't get stuck (keeps the dirty⇔pending invariant).
        const t = window.setTimeout(() => { saveTimers.current.delete(k); void persistDraft(userId, itemId); }, 200);
        saveTimers.current.set(k, t);
      }
    }
  }, [writeDrafts]);

  const deleteDraft = useCallback(async (userId: string, itemId: string) => {
    const k = dkey(userId, itemId);
    const next = new Map(draftsRef.current);
    next.delete(k);
    writeDrafts(next);
    dirtyRef.current.delete(k);
    const t = saveTimers.current.get(k);
    if (t) { clearTimeout(t); saveTimers.current.delete(k); }
    await sb().from("reconciliation_drafts").delete().eq("user_id", userId).eq("item_id", itemId);
  }, [writeDrafts]);

  // ─── case-size rollover normalization ────────────────────────────────────
  // If loose >= the effective case size, roll the excess up into cases:
  //   case size 2, "3 loose"  → 1 case + 1 loose
  //   case size 4, 2c + "9 L" → 4 cases + 1 loose
  // Uses the row's own case_size entry if present, else the item's. Only
  // rewrites a godown when a rollover actually happens (so a sub-case running
  // total like "2+1" on a case size of 10 keeps its expression intact).
  // Returns true if anything changed. Persists immediately.
  const normalizeRow = useCallback((userId: string, itemId: string): boolean => {
    const k = dkey(userId, itemId);
    const cur = draftsRef.current.get(k);
    if (!cur) return false;
    const itemCs = itemById.get(itemId)?.case_size || 0;
    const next: DBDraft = { ...cur };
    let changed = false;
    // Collapse a case size that just equals the system value (the pre-filled
    // default) back to empty — it isn't a real change, so it shouldn't make the
    // draft count as "staged" or create a phantom row. A genuinely different
    // case size stays and flows through the normal change/conflict/commit logic.
    if (next.case_size_raw.trim() !== "" && parseExpr(next.case_size_raw) === itemCs) {
      next.case_size_raw = "";
      changed = true;
    }
    const cs = parseExpr(next.case_size_raw) ?? itemCs;
    if (cs > 0) {
      for (const [cf, lf] of [["a_cases_raw", "a_loose_raw"], ["b_cases_raw", "b_loose_raw"]] as const) {
        const l = parseExpr(next[lf]);
        if (l === null || l < cs) continue;
        const c = parseExpr(next[cf]) ?? 0;
        next[cf] = String(c + Math.floor(l / cs));
        next[lf] = String(l % cs);
        changed = true;
      }
    }
    if (!changed) return false;
    next.updated_at = new Date().toISOString();
    const m = new Map(draftsRef.current);
    m.set(k, next);
    writeDrafts(m);
    dirtyRef.current.add(k); // protect the rolled value until the ack lands
    // Supersede any in-flight debounced save for this row — we persist the
    // normalized values right here, so the pending timer would only re-write
    // the same thing.
    const pending = saveTimers.current.get(k);
    if (pending) { clearTimeout(pending); saveTimers.current.delete(k); }
    void persistDraft(userId, itemId);
    return true;
  }, [itemById, writeDrafts, persistDraft]);

  // onBlur for a My-count field: roll over loose→cases, then flush the save.
  const commitRow = useCallback((userId: string, itemId: string) => {
    const rolled = normalizeRow(userId, itemId);
    if (!rolled) flushAllPendingSaves(); // normalizeRow already persisted if it rolled
  }, [normalizeRow, flushAllPendingSaves]);

  // One-time pass: tidy the CURRENT user's pre-existing drafts so any loose
  // that already exceeds the case size shows normalized (#10). Runs once per
  // load; new edits self-normalize on blur.
  const normalizedOnce = useRef(false);
  useEffect(() => {
    if (!loaded || normalizedOnce.current || !profile?.id || items.length === 0) return;
    normalizedOnce.current = true;
    for (const [, d] of [...draftsRef.current]) {
      if (d.user_id === profile.id) normalizeRow(d.user_id, d.item_id);
    }
  }, [loaded, items.length, profile?.id, normalizeRow]);

  // ─── "count done" toggle (freeze / resume) ───────────────────────────────
  const [doneSaving, setDoneSaving] = useState(false);
  const toggleDone = useCallback(async () => {
    if (!profile?.id || doneSaving) return;
    const uid = profile.id;
    const next = !myDone;
    if (next) flushAllPendingSaves(); // capture any in-flight edit before freezing
    setDoneSaving(true);
    const nowIso = new Date().toISOString();
    setDoneByUser(prev => {
      const m = new Map(prev);
      m.set(uid, { done: next, at: next ? nowIso : null, name: prev.get(uid)?.name ?? peopleRef.current.get(uid) ?? null });
      return m;
    });
    const { error } = await sb().from("reconciliation_done").upsert(
      { user_id: uid, done: next, done_at: next ? nowIso : null },
      { onConflict: "user_id" }
    );
    setDoneSaving(false);
    if (error) {
      // roll back the optimistic flip
      setDoneByUser(prev => { const m = new Map(prev); m.set(uid, { done: !next, at: !next ? nowIso : null, name: prev.get(uid)?.name ?? null }); return m; });
      showToast("bad", `Couldn't update done state: ${error.message}`);
      return;
    }
    showToast(next ? "ok" : "info", next ? "Count marked done — your entries are frozen." : "Resumed — your entries are editable again.");
  }, [profile?.id, myDone, doneSaving, flushAllPendingSaves]);

  // Reviewer: add an editable (empty) row for a counter who has no draft yet,
  // so the admin can enter a count on their behalf. It's a local "local-add-…"
  // row (protected from the poll); it persists the moment a value is typed.
  const addCounterDraft = useCallback((itemId: string, userId: string) => {
    const k = dkey(userId, itemId);
    if (draftsRef.current.has(k)) return; // already has a row
    const p = peopleListRef.current.find(x => x.id === userId);
    const row: DBDraft = {
      ...makeEmptyDraft(userId, itemId),
      id: `local-add-${k}`,
      user_name: p?.name ?? null,
      user_role: p?.role ?? null,
    };
    const m = new Map(draftsRef.current);
    m.set(k, row);
    writeDrafts(m);
  }, [writeDrafts]);

  // Unmount cleanup — fire every pending save BEFORE the route transition
  // tears React state down. persistDraft reads from the ref, so the actual
  // upsert request still goes out cleanly even after the component is gone
  // (the network request survives unmount on its own).
  useEffect(() => {
    return () => {
      for (const [k, timer] of saveTimers.current) {
        clearTimeout(timer);
        saveTimers.current.delete(k);
        const [userId, itemId] = k.split("::");
        void persistDraft(userId, itemId);
      }
    };
  }, [persistDraft]);

  // ─── derived: drafts grouped by item ───────────────────────────────────
  const draftsByItem = useMemo(() => {
    const m = new Map<string, DBDraft[]>();
    drafts.forEach(d => {
      const arr = m.get(d.item_id) ?? [];
      arr.push(d);
      m.set(d.item_id, arr);
    });
    // Stable order: current user first, then by name.
    m.forEach((arr, k) => {
      arr.sort((a, b) => {
        const meA = a.user_id === profile?.id ? 0 : 1;
        const meB = b.user_id === profile?.id ? 0 : 1;
        if (meA !== meB) return meA - meB;
        return displayUser(a).localeCompare(displayUser(b));
      });
      m.set(k, arr);
    });
    return m;
  }, [drafts, profile?.id]);

  // ─── derived: conflict + diff per item ─────────────────────────────────
  // A row diff is computed using a *single* draft (or none). The
  // reviewer-mode item diff additionally considers conflicts across users.
  type SideDiff = {
    diff: number;
    valid: boolean;
    userTouched: boolean;
    physCases: number;
    physLoose: number;
    appPieces: number;
    physPieces: number;
  };
  type RowDiff = {
    A: SideDiff;
    B: SideDiff;
    csOld: number;
    csNew: number;
    caseSizeChanged: boolean;
    caseSizeValid: boolean;
    hasAnyChange: boolean;
    invalid: boolean;
  };
  const emptyDraft = useMemo<DBDraft>(() => ({
    id: "local-empty", user_id: profile?.id ?? "",
    item_id: "", case_size_raw: "", a_cases_raw: "", a_loose_raw: "",
    b_cases_raw: "", b_loose_raw: "", updated_at: "",
    user_email: profile?.email ?? null, user_name: profile?.name ?? null,
    user_role: profile?.role ?? null,
  }), [profile?.id, profile?.email, profile?.name, profile?.role]);

  const computeDiff = useCallback((i: Item, app: { A: AppStock; B: AppStock }, d: DBDraft): RowDiff => {
    const csOld = i.case_size || 0;
    const csParsed = parseExpr(d.case_size_raw);
    const csValid = d.case_size_raw.trim() === "" || csParsed !== null;
    const csNew = csParsed ?? csOld;
    const caseSizeChanged = csParsed !== null && csParsed !== csOld;

    const side = (cRaw: string, lRaw: string, appSide: AppStock): SideDiff => {
      const pc = parseExpr(cRaw);
      const pl = parseExpr(lRaw);
      const userTouched = cRaw.trim() !== "" || lRaw.trim() !== "";
      // CRITICAL: a blank field on a godown you've STARTED counting means 0
      // (found none) — NOT the system value. Falling back to the system number
      // for the empty sibling silently inflated "You count" (e.g. enter 1 case,
      // leave loose blank → it added the system's loose). Only a wholly
      // untouched godown falls back to system, so its diff stays 0. This now
      // matches the other-counter path (draftSide) and conflict detection,
      // which already treat blanks as 0.
      const physCases = pc ?? (userTouched ? 0 : appSide.cases);
      const physLoose = pl ?? (userTouched ? 0 : appSide.loose);
      // "In system" display = current stock at its CURRENT case size.
      const appPieces = pieces(csOld, appSide.cases, appSide.loose);
      const physPieces = pieces(csNew, physCases, physLoose);
      const valid =
        (cRaw.trim() === "" || pc !== null) &&
        (lRaw.trim() === "" || pl !== null);
      // The committed change re-reads the OLD stock at the NEW case size (that's
      // what apply_reconciliation does once items.case_size is updated), so the
      // diff must compare both sides under csNew — otherwise a case-size edit
      // shows a phantom delta that won't actually be committed.
      const appPiecesAtNew = pieces(csNew, appSide.cases, appSide.loose);
      const diff = (userTouched || caseSizeChanged) ? physPieces - appPiecesAtNew : 0;
      return { diff, valid, userTouched, physCases, physLoose, appPieces, physPieces };
    };

    const A = side(d.a_cases_raw, d.a_loose_raw, app.A);
    const B = side(d.b_cases_raw, d.b_loose_raw, app.B);
    const invalid = !A.valid || !B.valid || !csValid;
    const hasAnyChange =
      caseSizeChanged || A.userTouched || B.userTouched;
    return { A, B, csOld, csNew, caseSizeChanged, caseSizeValid: csValid, hasAnyChange, invalid };
  }, []);

  // Item-level conflict — computed at the PIECE level per godown so a
  // different cases/loose split of the same total isn't a false conflict
  // (and the normalizer keeps splits canonical anyway). Two rules raise a
  // conflict for a godown:
  //   1. two counters who entered it disagree on the piece total, OR
  //   2. at least one counter entered it AND a counter who has marked their
  //      whole count DONE recorded nothing there (a finished counter's blank
  //      = "found none" = 0, which disagrees with a non-zero entry).
  // Rule 2 is gated on "done" so an item another counter simply hasn't
  // reached yet stays pending, not conflicting.
  type ItemConflict = {
    case_size: boolean;
    a_cases: boolean;
    a_loose: boolean;
    b_cases: boolean;
    b_loose: boolean;
    a: boolean;      // godown A piece-level conflict
    b: boolean;      // godown B piece-level conflict
    any: boolean;
    reason: string | null;          // concise, human-readable
    missingDoneNames: string[];     // done counters who found none where others did
  };
  const computeItemConflict = useCallback((item: Item, drs: DBDraft[]): ItemConflict => {
    const itemCs = item.case_size || 0;
    const nonEmpty = drs.filter(d => !isDraftEmpty(d));

    const csSet = new Set<number>();
    for (const d of nonEmpty) {
      const raw = d.case_size_raw.trim();
      if (!raw) continue;
      const p = parseExpr(raw);
      if (p !== null) csSet.add(p);
    }
    const csConflict = csSet.size > 1;

    const evalSide = (g: Godown) => {
      const entries: { name: string; pcs: number }[] = [];
      const enteredUserIds = new Set<string>();
      for (const d of nonEmpty) {
        const cRaw = (g === "A" ? d.a_cases_raw : d.b_cases_raw) || "";
        const lRaw = (g === "A" ? d.a_loose_raw : d.b_loose_raw) || "";
        if (cRaw.trim() === "" && lRaw.trim() === "") continue;
        const pc = parseExpr(cRaw);
        const pl = parseExpr(lRaw);
        const valid = (cRaw.trim() === "" || pc !== null) && (lRaw.trim() === "" || pl !== null);
        if (!valid) continue; // invalid input isn't a countable opinion
        const cs = parseExpr(d.case_size_raw) ?? itemCs;
        entries.push({ name: displayUser(d), pcs: pieces(cs, pc ?? 0, pl ?? 0) });
        enteredUserIds.add(d.user_id);
      }
      const missers: string[] = [];
      if (entries.length > 0) {
        for (const [uid, info] of doneByUser) {
          if (!info.done || enteredUserIds.has(uid)) continue;
          missers.push(info.name || peopleRef.current.get(uid) || "a counter");
        }
      }
      const valSet = new Set<number>(entries.map(e => e.pcs));
      if (entries.length > 0 && missers.length > 0) valSet.add(0);
      return { conflict: valSet.size > 1, entries, missers };
    };

    const A = evalSide("A");
    const B = evalSide("B");

    const sideReason = (g: string, s: { entries: { name: string; pcs: number }[]; missers: string[] }) => {
      const bits = s.entries.map(e => `${e.name.split(" ")[0]} ${fmtN(e.pcs)}`);
      for (const m of s.missers) bits.push(`${m.split(" ")[0]} none (done)`);
      return `${g}: ${bits.join(" vs ")}`;
    };
    const parts: string[] = [];
    if (A.conflict) parts.push(sideReason("A", A));
    if (B.conflict) parts.push(sideReason("B", B));
    if (csConflict) parts.push(`case size ${[...csSet].join(" vs ")}`);

    const missingDoneNames = [...new Set([
      ...(A.conflict ? A.missers : []),
      ...(B.conflict ? B.missers : []),
    ])];

    return {
      case_size: csConflict,
      a_cases: A.conflict, a_loose: A.conflict,
      b_cases: B.conflict, b_loose: B.conflict,
      a: A.conflict, b: B.conflict,
      any: A.conflict || B.conflict || csConflict,
      reason: parts.length ? parts.join("  ·  ") : null,
      missingDoneNames,
    };
  }, [doneByUser]);

  // ─── derived: enriched items + filter list ─────────────────────────────
  const itemsEnriched = useMemo(() => items.map(i => ({
    ...i,
    categoryName: i.category_id ? (catNameById.get(i.category_id) ?? i.category ?? null) : (i.category ?? null),
  })), [items, catNameById]);

  const brands = useMemo(
    () => [...new Set(itemsEnriched.map(i => i.brand || "").filter(Boolean))].sort(),
    [itemsEnriched]
  );
  const cats = useMemo(
    () => [...new Set(itemsEnriched.map(i => i.categoryName || "").filter(Boolean))].sort(),
    [itemsEnriched]
  );

  const filtered = useMemo(() => {
    return itemsEnriched.filter(i => {
      if (brand && i.brand !== brand) return false;
      if (cat && i.categoryName !== cat) return false;
      if (showOnlyChanged) {
        const drs = draftsByItem.get(i.id) || [];
        if (mode === "my") {
          // Only my drafts on this item
          const mine = drs.find(d => d.user_id === profile?.id);
          if (!mine || isDraftEmpty(mine)) return false;
        } else {
          if (drs.length === 0) return false;
        }
      }
      // "Conflicts only" — collapse to flagged items (My count + Reviewer).
      if (conflictsOnly) {
        const drs = draftsByItem.get(i.id) || [];
        if (!computeItemConflict(i, drs).any) return false;
      }
      const hay = `${i.brand || ""} ${i.model} ${i.size} ${i.colour} ${i.categoryName || ""} ${i.subcategory || ""} ${i.item_code}`;
      if (!matchesQuery(hay, q)) return false;
      return true;
    });
  }, [itemsEnriched, q, brand, cat, showOnlyChanged, conflictsOnly, draftsByItem, mode, profile?.id, computeItemConflict]);

  // ─── derived: header stats ─────────────────────────────────────────────
  const stats = useMemo(() => {
    let myStaged = 0, anyStaged = 0, conflicts = 0, invalid = 0;
    const usersWithDrafts = new Set<string>();
    items.forEach(i => {
      const app = appStock.get(i.id);
      if (!app) return;
      const drs = draftsByItem.get(i.id) || [];
      if (drs.length > 0) anyStaged++;
      drs.forEach(d => usersWithDrafts.add(d.user_id));
      const mine = drs.find(d => d.user_id === profile?.id);
      if (mine && !isDraftEmpty(mine)) myStaged++;
      // Count invalid PER ITEM (any counter's entry not a valid number → +1),
      // consistent with conflicts/staged which are also per item.
      if (drs.some(d => computeDiff(i, app, d).invalid)) invalid++;
      const c = computeItemConflict(i, drs);
      if (c.any) conflicts++;
    });
    return { myStaged, anyStaged, conflicts, invalid, usersWithDrafts };
  }, [items, appStock, draftsByItem, computeDiff, computeItemConflict, profile?.id]);

  // Surface new conflicts to the reviewer without them having to watch the
  // screen — a toast fires when the conflict count rises (e.g. a counter just
  // marked done and left an item blank that another filled).
  const prevConflicts = useRef(0);
  useEffect(() => {
    if (!loaded) return;
    if (mode === "reviewer" && stats.conflicts > prevConflicts.current && stats.conflicts > 0) {
      showToast("bad", `${stats.conflicts} ${stats.conflicts === 1 ? "item needs" : "items need"} review (conflict).`);
    }
    prevConflicts.current = stats.conflicts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats.conflicts, mode, loaded]);

  // Pre-commit summary for the confirm dialog: how many items have an agreed
  // count, how many are blocked by conflicts, how much UNCOUNTED stock would
  // be zeroed by a census commit, and which counters haven't marked done.
  const openCommitConfirm = () => {
    if (!canCommit || processing) return;
    let counted = 0, conflicted = 0, uncountedItems = 0, uncountedSides = 0;
    const participants = new Set<string>();
    for (const i of items) {
      const app = appStock.get(i.id);
      if (!app) continue;
      const drs = draftsByItem.get(i.id) || [];
      const nonEmpty = drs.filter(d => !isDraftEmpty(d));
      nonEmpty.forEach(d => participants.add(d.user_id));
      const hasStock = (g: Godown) => app[g].cases !== 0 || app[g].loose !== 0;
      if (nonEmpty.length === 0) {
        if (hasStock("A") || hasStock("B")) uncountedItems++;
        continue;
      }
      if (computeItemConflict(i, nonEmpty).any) { conflicted++; continue; }
      counted++;
      const touchedG = (g: Godown) => nonEmpty.some(d =>
        (g === "A" ? d.a_cases_raw : d.b_cases_raw).trim() !== "" ||
        (g === "A" ? d.a_loose_raw : d.b_loose_raw).trim() !== "");
      for (const g of ["A", "B"] as Godown[]) {
        if (!touchedG(g) && hasStock(g)) uncountedSides++;
      }
    }
    const notDone = [...participants]
      .filter(uid => !doneByUser.get(uid)?.done)
      .map(uid => peopleRef.current.get(uid) || "a counter");
    // Census default: ON only when there ARE counters and every one of them
    // has marked done (their blanks are final = full count). OFF while someone
    // is still counting — and OFF with zero participants, so an idle click can
    // never two-tap the whole inventory to zero; ticking it is then deliberate.
    setCensusZero(participants.size > 0 && notDone.length === 0);
    setCommitConfirm({ counted, conflicted, uncountedItems, uncountedSides, notDone });
  };

  // ─── commit (admin only) ───────────────────────────────────────────────
  // zeroUncounted = "this was a FULL count": after committing every agreed
  // count, any item (or godown) that NO counter entered but that still shows
  // stock in the system is set to 0 — the count is the truth, so stock nobody
  // found doesn't exist. Confirmed via the pre-commit dialog (never silent),
  // so a partial count can simply untick it and only counted items move.
  const makeAdjustments = async (zeroUncounted: boolean) => {
    if (!canCommit) { showToast("bad", "Only admins can commit reconciliation."); return; }
    if (processing) return;

    // Collect committable items: at least one user has a non-empty draft
    // AND no conflict across users AND all entered values are valid.
    type SideInfo = { godown: Godown; diff: number; physCases: number; physLoose: number; needsWrite: boolean; uncounted?: boolean };
    type Job = {
      itemId: string;
      label: string;
      caseSizeNew: number;
      caseSizeChanged: boolean;
      sides: SideInfo[];
      userIdsToWipe: string[];
      zeroedItem?: boolean; // census job: nobody counted this item, zeroing it
    };
    const jobs: Job[] = [];
    const skipped: Array<{ itemId: string; label: string; reason: string }> = [];

    // A census zero-side for a godown that still shows stock but nobody counted.
    const zeroSide = (app: { A: AppStock; B: AppStock }, cs: number, g: Godown): SideInfo | null => {
      const s = app[g];
      if (s.cases === 0 && s.loose === 0) return null; // already 0 — nothing to do
      return { godown: g, diff: -pieces(cs, s.cases, s.loose), physCases: 0, physLoose: 0, needsWrite: true, uncounted: true };
    };

    for (const i of items) {
      const app = appStock.get(i.id);
      if (!app) continue;
      const drs = draftsByItem.get(i.id) || [];
      const nonEmpty = drs.filter(d => !isDraftEmpty(d));
      const label = `${i.brand ? i.brand + " · " : ""}${i.model}${i.size ? " " + i.size : ""}`;

      // Nobody counted this item. In census mode, stock nobody found goes to 0.
      if (nonEmpty.length === 0) {
        if (!zeroUncounted) continue;
        const sides = (["A", "B"] as Godown[])
          .map(g => zeroSide(app, i.case_size || 0, g))
          .filter((s): s is SideInfo => s !== null);
        if (sides.length === 0) continue; // already 0/0 everywhere
        jobs.push({ itemId: i.id, label, caseSizeNew: i.case_size || 0, caseSizeChanged: false, sides, userIdsToWipe: [], zeroedItem: true });
        continue;
      }

      const conflict = computeItemConflict(i, nonEmpty);
      if (conflict.any) {
        skipped.push({ itemId: i.id, label, reason: "conflict between users" });
        continue;
      }

      // Conflict-free ⇒ everyone who entered a given godown agrees on its piece
      // total. Build the committed row by taking EACH godown WHOLE from one
      // counter who actually entered THAT godown — never assemble it field by
      // field across counters (that could pair one person's cases with
      // another's loose and commit a number nobody entered). case size from any
      // non-empty entry. apply_reconciliation re-normalises the split, so which
      // agreeing counter we pick can't change the stored result.
      const touchedG = (d: DBDraft, g: Godown) =>
        (g === "A" ? d.a_cases_raw : d.b_cases_raw).trim() !== "" ||
        (g === "A" ? d.a_loose_raw : d.b_loose_raw).trim() !== "";
      const repA = nonEmpty.find(d => touchedG(d, "A"));
      const repB = nonEmpty.find(d => touchedG(d, "B"));
      const csRaw = nonEmpty.find(d => d.case_size_raw.trim() !== "")?.case_size_raw || "";

      const merged: DBDraft = {
        ...emptyDraft,
        item_id: i.id,
        case_size_raw: csRaw,
        a_cases_raw: repA?.a_cases_raw ?? "",
        a_loose_raw: repA?.a_loose_raw ?? "",
        b_cases_raw: repB?.b_cases_raw ?? "",
        b_loose_raw: repB?.b_loose_raw ?? "",
      };
      const rd = computeDiff(i, app, merged);
      if (rd.invalid) {
        skipped.push({ itemId: i.id, label, reason: "invalid input — fix before committing" });
        continue;
      }

      // Write every godown that was actually counted. A case-size-only change
      // updates items.case_size (below) WITHOUT re-stamping untouched godowns —
      // physical cases/loose don't change, only how pieces are computed.
      const sides: SideInfo[] = (["A", "B"] as Godown[]).map(g => {
        const side = g === "A" ? rd.A : rd.B;
        return {
          godown: g,
          diff: side.diff,
          physCases: side.physCases,
          physLoose: side.physLoose,
          needsWrite: side.userTouched,
        };
      }).filter(s => s.needsWrite);

      // Census: a godown NOBODY counted on this item but that still shows
      // stock goes to 0 too — same "the count is the truth" rule.
      if (zeroUncounted) {
        for (const g of ["A", "B"] as Godown[]) {
          const side = g === "A" ? rd.A : rd.B;
          if (side.userTouched) continue;
          const z = zeroSide(app, rd.csNew, g);
          if (z) sides.push(z);
        }
      }

      if (!rd.hasAnyChange && sides.length === 0) continue;

      jobs.push({
        itemId: i.id,
        label,
        caseSizeNew: rd.csNew,
        caseSizeChanged: rd.caseSizeChanged,
        sides,
        userIdsToWipe: nonEmpty.map(d => d.user_id),
      });
    }

    if (jobs.length === 0) {
      if (skipped.length > 0) {
        showToast("bad", `Nothing to commit — ${skipped.length} item${skipped.length === 1 ? "" : "s"} skipped (conflicts/invalid). Resolve first.`);
      } else {
        showToast("bad", "No changes to commit.");
      }
      return;
    }

    setProcessing(true);
    setErrors([]);
    const totalSteps = jobs.reduce((n, j) => n + (j.caseSizeChanged ? 1 : 0) + j.sides.length + 1 /* delete drafts step */, 0);
    setProgress({ done: 0, total: totalSteps });
    let done = 0;
    const newErrors: typeof errors = [];
    const failedItems = new Set<string>();
    const date = TODAY();

    for (const j of jobs) {
      if (j.caseSizeChanged) {
        const { error } = await sb().from("items").update({ case_size: j.caseSizeNew }).eq("id", j.itemId);
        done++; setProgress({ done, total: totalSteps });
        if (error) {
          newErrors.push({ itemId: j.itemId, message: `Case size update failed: ${error.message}` });
          failedItems.add(j.itemId);
          continue;
        }
      }
      for (const s of j.sides) {
        // apply_reconciliation: single atomic call that row-locks the
        // godown_stock row, computes the delta from the CURRENT db
        // value (so retries don't double-count if the page is stale),
        // logs an Adjustment when the piece total moved, and forces
        // the cases/loose split to the absolute values the user typed.
        // s.diff / s.physCases / s.physLoose come from the page state
        // for display only; the server is the source of truth.
        const { error } = await sb().rpc("apply_reconciliation", {
          p_item_id:      j.itemId,
          p_godown:       s.godown,
          p_target_cases: s.physCases,
          p_target_loose: s.physLoose,
          // Distinct reason for census zeroes so the audit log shows WHY a
          // godown went to 0 (still matches the "Reconciliation%" last-recon filter).
          p_reason:       s.uncounted ? `Reconciliation ${date} — not counted, set to 0` : `Reconciliation ${date}`,
        });
        if (error) {
          newErrors.push({ itemId: j.itemId, godown: s.godown, message: error.message });
          failedItems.add(j.itemId);
        }
        done++; setProgress({ done, total: totalSteps });
      }

      // Clear the drafts that fed this commit — scoped to exactly those
      // counters (j.userIdsToWipe), NOT every draft on the item. A counter who
      // started entering this item AFTER we snapshotted (e.g. during a long
      // bulk commit) keeps their draft for the next cycle instead of it being
      // silently wiped unapplied.
      if (!failedItems.has(j.itemId) && j.userIdsToWipe.length > 0) {
        const { error: delErr } = await sb()
          .from("reconciliation_drafts")
          .delete()
          .eq("item_id", j.itemId)
          .in("user_id", j.userIdsToWipe);
        if (delErr) {
          newErrors.push({ itemId: j.itemId, message: `Draft cleanup failed: ${delErr.message}` });
        }
      }
      done++; setProgress({ done, total: totalSteps });
    }

    setProcessing(false);
    setErrors(newErrors);

    const succeeded = jobs.length - failedItems.size;
    const zeroed = jobs.filter(j => j.zeroedItem && !failedItems.has(j.itemId)).length;
    const zeroedNote = zeroed > 0 ? ` (${zeroed} uncounted set to 0)` : "";
    if (failedItems.size === 0 && skipped.length === 0) {
      showToast("ok", `Committed ${succeeded} item${succeeded === 1 ? "" : "s"}${zeroedNote}.`);
    } else if (failedItems.size === 0) {
      showToast("info", `Committed ${succeeded}${zeroedNote}. ${skipped.length} item${skipped.length === 1 ? "" : "s"} skipped (conflicts/invalid).`);
    } else {
      showToast("bad", `Committed ${succeeded}, ${failedItems.size} failed.`);
    }

    await load();

    // Reset stale "done" flags: a counter whose drafts were all committed
    // shouldn't carry a frozen/done state into the next stock-take cycle.
    try {
      const stillCounting = new Set<string>();
      for (const [, d] of draftsRef.current) if (!isDraftEmpty(d)) stillCounting.add(d.user_id);
      const toReset: string[] = [];
      for (const [uid, info] of doneByUser) if (info.done && !stillCounting.has(uid)) toReset.push(uid);
      if (toReset.length > 0) {
        await sb().from("reconciliation_done").update({ done: false, done_at: null }).in("user_id", toReset);
        await refreshDone();
      }
    } catch { /* non-fatal: a stale flag self-resolves when the counter resumes */ }
  };

  // ─── per-item apply (admin picks a counter's value and commits just that
  //     one item to stock) ──────────────────────────────────────────────────
  // Mirrors makeAdjustments' per-job logic but for ONE item using ONE chosen
  // draft — so the admin can accept a specific counter's count (overriding a
  // conflict / a count nobody else entered). Writes godown_stock + logs an
  // Adjustment via apply_reconciliation, then clears that item's drafts.
  const commitOne = async (item: Item, source: DBDraft) => {
    if (!canCommit) { showToast("bad", "Only admins can apply reconciliation."); return; }
    if (applyingItemId || processing) return;
    const app = appStock.get(item.id);
    if (!app) return;
    const rd = computeDiff(item, app, source);
    if (rd.invalid) { showToast("bad", "Fix the invalid entry before applying."); return; }
    if (!rd.hasAnyChange) { showToast("info", "That count matches the system — nothing to apply."); return; }

    setApplyingItemId(item.id);
    const date = TODAY();
    const newErrors: typeof errors = [];
    let failed = false;

    if (rd.caseSizeChanged) {
      const { error } = await sb().from("items").update({ case_size: rd.csNew }).eq("id", item.id);
      if (error) { newErrors.push({ itemId: item.id, message: `Case size update failed: ${error.message}` }); failed = true; }
    }
    if (!failed) {
      for (const g of ["A", "B"] as Godown[]) {
        const sideRd = g === "A" ? rd.A : rd.B;
        if (!sideRd.userTouched) continue; // only write a godown that was actually counted (case-size change alone never re-stamps stock)
        const { error } = await sb().rpc("apply_reconciliation", {
          p_item_id: item.id,
          p_godown: g,
          p_target_cases: sideRd.physCases,
          p_target_loose: sideRd.physLoose,
          p_reason: `Reconciliation ${date}`,
        });
        if (error) { newErrors.push({ itemId: item.id, godown: g, message: error.message }); failed = true; }
      }
    }
    if (!failed) {
      const { error: delErr } = await sb().from("reconciliation_drafts").delete().eq("item_id", item.id);
      if (delErr) newErrors.push({ itemId: item.id, message: `Draft cleanup failed: ${delErr.message}` });
    }

    setErrors(newErrors);
    setApplyingItemId(null);
    const label = `${item.brand ? item.brand + " · " : ""}${item.model}`;
    if (!failed) showToast("ok", `Applied ${label} — ${displayUser(source)}'s count saved to stock.`);
    else showToast("bad", `Couldn't apply ${label}. See the error on the card.`);
    await load();
  };

  // ─── render ────────────────────────────────────────────────────────────
  return (
    <Shell title="Reconciliation">
      <div className="no-print recon-page">
        <Header
          loaded={loaded}
          totalItems={items.length}
          mode={mode}
          isAdmin={isAdmin}
          stats={stats}
        />

        <Toolbar
          q={q} setQ={setQ}
          brand={brand} setBrand={setBrand}
          cat={cat} setCat={setCat}
          showOnlyChanged={showOnlyChanged} setShowOnlyChanged={setShowOnlyChanged}
          conflictsOnly={conflictsOnly} setConflictsOnly={setConflictsOnly}
          conflictCount={stats.conflicts}
          brands={brands} cats={cats}
          shownCount={filtered.length}
          mode={mode} setMode={setMode} isAdmin={isAdmin}
          usersWithDrafts={stats.usersWithDrafts.size}
          myDone={myDone}
          onToggleDone={toggleDone}
          doneSaving={doneSaving}
          onPrint={() => window.print()}
          onCommit={openCommitConfirm}
          // Enabled even with nothing staged: the confirm dialog is the real
          // gate, and a census run ("zero what nobody found") is legitimate
          // with zero drafts — e.g. zeroing leftovers after an earlier commit.
          canCommit={canCommit && !processing}
          processing={processing}
          progress={progress}
        />

        {mode === "my" && myDone && (
          <div className="mb-4 flex items-center gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2.5">
            <Lock className="w-4 h-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
            <div className="text-sm text-emerald-800 dark:text-emerald-200 flex-1 min-w-0">
              <span className="font-medium">Your count is marked done and frozen.</span>{" "}
              <span className="text-emerald-700/80 dark:text-emerald-300/70">Any item you left blank now counts as “found none” for the reviewer. Resume to edit.</span>
            </div>
            <button
              type="button"
              onClick={toggleDone}
              disabled={doneSaving}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium border border-emerald-500/50 bg-white dark:bg-zinc-900 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 disabled:opacity-60 flex-shrink-0"
            >
              <LockOpen className="w-3.5 h-3.5" /> Resume editing
            </button>
          </div>
        )}

        {!loaded ? (
          <SkeletonBody />
        ) : filtered.length === 0 ? (
          <EmptyState clearFilters={() => { setQ(""); setBrand(""); setCat(""); setShowOnlyChanged(false); setConflictsOnly(false); }} />
        ) : mode === "my" ? (
          <MyView
            items={filtered}
            appStock={appStock}
            drafts={drafts}
            lastRecon={lastRecon}
            currentUserId={profile?.id ?? ""}
            frozen={myDone}
            computeDiff={computeDiff}
            setField={setField}
            commitRow={commitRow}
            resetMyRow={(itemId) => { if (profile?.id) void deleteDraft(profile.id, itemId); }}
            errorsByItem={errorsByItem(errors)}
            otherUsersByItem={(itemId) => {
              const drs = draftsByItem.get(itemId) || [];
              return drs.filter(d => d.user_id !== profile?.id && !isDraftEmpty(d));
            }}
            doneByUser={doneByUser}
            conflictByItem={(itemId) => {
              const item = itemById.get(itemId);
              if (!item) return null;
              const drs = draftsByItem.get(itemId) || [];
              return computeItemConflict(item, drs);
            }}
          />
        ) : (
          <ReviewerView
            items={filtered}
            appStock={appStock}
            draftsByItem={draftsByItem}
            lastRecon={lastRecon}
            computeDiff={computeDiff}
            computeItemConflict={computeItemConflict}
            setField={setField}
            commitRow={commitRow}
            deleteDraft={deleteDraft}
            currentUserId={profile?.id ?? ""}
            doneByUser={doneByUser}
            people={people}
            onAddCounter={addCounterDraft}
            onApplyItem={commitOne}
            applyingItemId={applyingItemId}
            errorsByItem={errorsByItem(errors)}
          />
        )}

        <HintCard isAdmin={isAdmin} mode={mode} />

        {/* Pre-commit confirmation — nothing writes until Commit is tapped. */}
        {commitConfirm && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/40" role="dialog" aria-modal="true" aria-label="Confirm make adjustments">
            <div className="w-full max-w-md bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-xl p-5 space-y-4">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-cyan-600 dark:text-cyan-400" />
                <h2 className="text-base font-semibold">Make adjustments?</h2>
              </div>

              <div className="space-y-1.5 text-sm text-zinc-600 dark:text-zinc-300 tabular-nums">
                <div className="flex justify-between gap-3">
                  <span>Items with an agreed count → set to that count</span>
                  <span className="font-semibold text-zinc-900 dark:text-zinc-100">{fmtN(commitConfirm.counted)}</span>
                </div>
                {commitConfirm.conflicted > 0 && (
                  <div className="flex justify-between gap-3 text-rose-600 dark:text-rose-400">
                    <span>Skipped — conflicts still to resolve</span>
                    <span className="font-semibold">{fmtN(commitConfirm.conflicted)}</span>
                  </div>
                )}
              </div>

              {(commitConfirm.uncountedItems > 0 || commitConfirm.uncountedSides > 0) && (
                <label className={cn(
                  "flex items-start gap-3 rounded-xl border p-3 cursor-pointer transition-colors",
                  censusZero
                    ? "border-violet-500/50 bg-violet-500/5"
                    : "border-zinc-200 dark:border-zinc-700"
                )}>
                  <input
                    type="checkbox"
                    checked={censusZero}
                    onChange={(e) => setCensusZero(e.target.checked)}
                    className="mt-0.5 w-5 h-5 accent-violet-600 flex-shrink-0"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-100">
                      Full count — zero the stock nobody found
                    </span>
                    <span className="block text-xs text-zinc-500 mt-0.5 tabular-nums">
                      {commitConfirm.uncountedItems > 0 && <>{fmtN(commitConfirm.uncountedItems)} item{commitConfirm.uncountedItems === 1 ? "" : "s"} no one counted</>}
                      {commitConfirm.uncountedItems > 0 && commitConfirm.uncountedSides > 0 && " + "}
                      {commitConfirm.uncountedSides > 0 && <>{fmtN(commitConfirm.uncountedSides)} uncounted godown side{commitConfirm.uncountedSides === 1 ? "" : "s"}</>}
                      {" "}still show stock in the system — ticking this sets them to <strong>0</strong>. Untick for a partial count.
                    </span>
                  </span>
                </label>
              )}

              {commitConfirm.notDone.length > 0 && (
                <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <span>{commitConfirm.notDone.join(", ")} {commitConfirm.notDone.length === 1 ? "hasn't" : "haven't"} marked their count done yet — their blanks may not be final.</span>
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setCommitConfirm(null)}
                  className="flex-1 min-h-11 rounded-lg border border-zinc-200 dark:border-zinc-700 text-sm font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const census = censusZero && (commitConfirm.uncountedItems > 0 || commitConfirm.uncountedSides > 0);
                    setCommitConfirm(null);
                    void makeAdjustments(census);
                  }}
                  className="flex-1 min-h-11 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-white text-sm font-medium inline-flex items-center justify-center gap-1.5"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  {censusZero && (commitConfirm.uncountedItems > 0 || commitConfirm.uncountedSides > 0) ? "Commit + zero uncounted" : "Commit"}
                </button>
              </div>
            </div>
          </div>
        )}

        {toast && (
          <div
            role="status"
            aria-live={toast.kind === "bad" ? "assertive" : "polite"}
            className={cn(
              "fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg shadow-lg text-sm font-medium",
              toast.kind === "ok" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/40",
              toast.kind === "bad" && "bg-rose-500/15 text-rose-700 dark:text-rose-300 border border-rose-500/40",
              toast.kind === "info" && "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border border-cyan-500/40",
            )}>
            {toast.text}
          </div>
        )}
      </div>

      <PrintSheet items={filtered} />
    </Shell>
  );
}

// ─── helpers used by render ─────────────────────────────────────────────
function isDraftEmpty(d: DBDraft): boolean {
  return !d.case_size_raw.trim() && !d.a_cases_raw.trim() && !d.a_loose_raw.trim() && !d.b_cases_raw.trim() && !d.b_loose_raw.trim();
}
function errorsByItem(errors: Array<{ itemId: string; godown?: "A" | "B"; message: string }>): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const e of errors) {
    const arr = m.get(e.itemId) ?? [];
    arr.push(e.godown ? `${e.godown}: ${e.message}` : e.message);
    m.set(e.itemId, arr);
  }
  return m;
}

// ─── header ──────────────────────────────────────────────────────────────
function Header({
  loaded, totalItems, mode, isAdmin, stats,
}: {
  loaded: boolean;
  totalItems: number;
  mode: "my" | "reviewer";
  isAdmin: boolean;
  stats: { myStaged: number; anyStaged: number; conflicts: number; invalid: number; usersWithDrafts: Set<string> };
}) {
  return (
    <div className="mb-5">
      <div className="flex items-center gap-3 mb-1">
        <ClipboardCheck className="w-5 h-5 text-cyan-600 dark:text-cyan-400" />
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Reconciliation</h1>
        <span className={cn(
          "px-2 py-0.5 rounded text-[10px] uppercase tracking-wider font-medium",
          isAdmin && mode === "reviewer"
            ? "bg-violet-500/15 text-violet-700 dark:text-violet-300"
            : "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300"
        )}>
          {isAdmin && mode === "reviewer" ? "Reviewer" : "My count"}
        </span>
      </div>
      <p className="text-sm text-zinc-500 tabular-nums">
        {!loaded ? "Loading…" : (
          <>
            {fmtN(totalItems)} items ·{" "}
            {mode === "my" ? (
              <>
                <span className={stats.myStaged ? "text-amber-600 dark:text-amber-400 font-medium" : ""}>
                  {fmtN(stats.myStaged)} in my draft
                </span>
              </>
            ) : (
              <>
                <span className={stats.anyStaged ? "text-amber-600 dark:text-amber-400 font-medium" : ""}>
                  {fmtN(stats.anyStaged)} item{stats.anyStaged === 1 ? "" : "s"} staged across {stats.usersWithDrafts.size} user{stats.usersWithDrafts.size === 1 ? "" : "s"}
                </span>
              </>
            )}
            {stats.conflicts > 0 && (
              <> · <span className="text-rose-600 dark:text-rose-400 font-medium">{fmtN(stats.conflicts)} conflict{stats.conflicts === 1 ? "" : "s"}</span></>
            )}
            {stats.invalid > 0 && (
              <> · <span className="text-rose-600 dark:text-rose-400 font-medium" title="an entry isn't a valid number yet">{fmtN(stats.invalid)} need{stats.invalid === 1 ? "s" : ""} fixing</span></>
            )}
          </>
        )}
      </p>
    </div>
  );
}

// ─── toolbar ─────────────────────────────────────────────────────────────
function Toolbar({
  q, setQ, brand, setBrand, cat, setCat,
  showOnlyChanged, setShowOnlyChanged,
  conflictsOnly, setConflictsOnly, conflictCount,
  brands, cats, shownCount,
  mode, setMode, isAdmin, usersWithDrafts,
  myDone, onToggleDone, doneSaving,
  onPrint, onCommit, canCommit, processing, progress,
}: {
  q: string; setQ: (s: string) => void;
  brand: string; setBrand: (s: string) => void;
  cat: string; setCat: (s: string) => void;
  showOnlyChanged: boolean; setShowOnlyChanged: (b: boolean) => void;
  conflictsOnly: boolean; setConflictsOnly: (b: boolean) => void;
  conflictCount: number;
  brands: string[]; cats: string[]; shownCount: number;
  mode: "my" | "reviewer"; setMode: (m: "my" | "reviewer") => void;
  isAdmin: boolean; usersWithDrafts: number;
  myDone: boolean; onToggleDone: () => void; doneSaving: boolean;
  onPrint: () => void; onCommit: () => void;
  canCommit: boolean; processing: boolean;
  progress: { done: number; total: number };
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  return (
    // Sticky so the search + filters stay reachable while scrolling the
    // long item list. Negative margins let the background span the full
    // content width; px puts the padding back.
    <div className="space-y-2 mb-4 sticky top-0 z-20 -mx-4 sm:-mx-6 md:-mx-8 px-4 sm:px-6 md:px-8 pt-1 pb-2.5 bg-zinc-50 dark:bg-zinc-950 border-b border-zinc-200/70 dark:border-zinc-800/70">
      <div className="flex flex-wrap gap-2 items-center">
        <SearchBox
          value={q}
          onChange={setQ}
          placeholder="Search — brand, model, colour, size…"
          className="flex-1 min-w-[180px]"
        />

        {/* Mobile: filters live in a sheet */}
        <FilterButton activeCount={(brand ? 1 : 0) + (cat ? 1 : 0) + (showOnlyChanged ? 1 : 0)} onClick={() => setFiltersOpen(true)} />

        {/* Desktop: inline filters */}
        <div className="hidden md:flex md:items-center md:gap-2">
          <select value={brand} onChange={(e) => setBrand(e.target.value)}
            className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md px-3 py-1.5 text-sm">
            <option value="">All brands</option>
            {brands.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
          <select value={cat} onChange={(e) => setCat(e.target.value)}
            className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md px-3 py-1.5 text-sm">
            <option value="">All categories</option>
            {cats.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <button
            type="button"
            onClick={() => setShowOnlyChanged(!showOnlyChanged)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm border transition-colors",
              showOnlyChanged
                ? "bg-amber-500/15 border-amber-500/50 text-amber-700 dark:text-amber-300"
                : "bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:border-zinc-300 dark:hover:border-zinc-700"
            )}
            aria-pressed={showOnlyChanged}
          >
            {showOnlyChanged ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            {showOnlyChanged ? (mode === "my" ? "Only mine" : "Only staged") : "All items"}
          </button>
        </div>
        <span className="text-xs text-zinc-500 self-center tabular-nums ml-auto md:ml-0">{fmtN(shownCount)} shown</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {isAdmin && (
          <div className="inline-flex bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md overflow-hidden">
            <button
              type="button"
              onClick={() => setMode("my")}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 text-sm",
                mode === "my"
                  ? "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300"
                  : "text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
              )}
              aria-pressed={mode === "my"}
            >
              <UserCircle2 className="w-3.5 h-3.5" /> My count
            </button>
            <button
              type="button"
              onClick={() => setMode("reviewer")}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border-l border-zinc-200 dark:border-zinc-800",
                mode === "reviewer"
                  ? "bg-violet-500/15 text-violet-700 dark:text-violet-300"
                  : "text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
              )}
              aria-pressed={mode === "reviewer"}
            >
              <ShieldCheck className="w-3.5 h-3.5" /> Reviewer
            </button>
          </div>
        )}

        {/* Jump straight to the items that need a decision/recheck. Available
            in both My count (so a counter can spot where they disagree with a
            teammate) and Reviewer. */}
        <button
          type="button"
          onClick={() => setConflictsOnly(!conflictsOnly)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm border transition-colors",
            conflictsOnly
              ? "bg-rose-500/15 border-rose-500/50 text-rose-700 dark:text-rose-300"
              : conflictCount > 0
                ? "bg-white dark:bg-zinc-900 border-rose-300/60 dark:border-rose-500/30 text-rose-600 dark:text-rose-300 hover:border-rose-400"
                : "bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-500 hover:border-zinc-300 dark:hover:border-zinc-700"
          )}
          aria-pressed={conflictsOnly}
          title={mode === "my" ? "Show only items where a count disagrees" : "Show only items with a conflict"}
        >
          <AlertTriangle className="w-3.5 h-3.5" />
          {conflictsOnly ? "Conflicts only" : "Conflicts"}
          {conflictCount > 0 && (
            <span className="ml-0.5 px-1.5 rounded-full bg-rose-500 text-white text-[10px] font-semibold tabular-nums">{conflictCount}</span>
          )}
        </button>

        {/* My count: freeze/unfreeze my entries. Marking done turns any item I
            leave blank but a teammate filled into a flagged conflict. */}
        {mode === "my" && (
          <button
            type="button"
            onClick={onToggleDone}
            disabled={doneSaving}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm border transition-colors disabled:opacity-60",
              myDone
                ? "bg-emerald-500/15 border-emerald-500/50 text-emerald-700 dark:text-emerald-300"
                : "bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-200 hover:border-emerald-400 dark:hover:border-emerald-500/40"
            )}
            aria-pressed={myDone}
            title={myDone ? "Resume editing your count" : "Freeze my count as done"}
          >
            {doneSaving
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : myDone ? <Lock className="w-3.5 h-3.5" /> : <CheckCheck className="w-3.5 h-3.5" />}
            {myDone ? "Done (frozen)" : "Mark my count done"}
          </button>
        )}

        <div className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500 px-2 py-1.5 rounded-md bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-800">
          <Users className="w-3 h-3" />
          {usersWithDrafts} {usersWithDrafts === 1 ? "user counting" : "users counting"}
        </div>

        <button
          type="button"
          onClick={onPrint}
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-200 hover:border-zinc-300 dark:hover:border-zinc-700"
          title="Print a blank count sheet"
        >
          <Printer className="w-3.5 h-3.5" /> Print PDF
        </button>

        <div className="flex-1 min-w-0" />

        {isAdmin && (
          <button
            type="button"
            onClick={onCommit}
            disabled={!canCommit}
            className={cn(
              "inline-flex items-center gap-2 rounded-md px-4 py-1.5 text-sm font-medium border transition-colors",
              canCommit
                ? "bg-cyan-500 hover:bg-cyan-400 text-white border-cyan-500"
                : "bg-zinc-200 dark:bg-zinc-800 text-zinc-500 border-zinc-200 dark:border-zinc-800 cursor-not-allowed"
            )}
          >
            {processing
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> {progress.done}/{progress.total}…</>
              : <><CheckCircle2 className="w-3.5 h-3.5" /> Make adjustments</>
            }
          </button>
        )}
      </div>

      {/* Mobile filters sheet */}
      <FilterSheet
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        onClear={() => { setBrand(""); setCat(""); setShowOnlyChanged(false); }}
      >
        <SheetField label="Brand">
          <select value={brand} onChange={(e) => setBrand(e.target.value)} className="w-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-cyan-500">
            <option value="">All brands</option>
            {brands.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </SheetField>
        <SheetField label="Category">
          <select value={cat} onChange={(e) => setCat(e.target.value)} className="w-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-cyan-500">
            <option value="">All categories</option>
            {cats.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </SheetField>
        <button
          type="button"
          onClick={() => setShowOnlyChanged(!showOnlyChanged)}
          className={cn(
            "w-full inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-2.5 text-sm border transition-colors",
            showOnlyChanged
              ? "bg-amber-500/15 border-amber-500/50 text-amber-700 dark:text-amber-300"
              : "bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300"
          )}
          aria-pressed={showOnlyChanged}
        >
          {showOnlyChanged ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
          {showOnlyChanged ? (mode === "my" ? "Showing only mine" : "Showing only staged") : "Show all items"}
        </button>
      </FilterSheet>
    </div>
  );
}

// ─── shared types for sub-views ─────────────────────────────────────────
type RowDiffType = {
  A: { diff: number; valid: boolean; userTouched: boolean; physCases: number; physLoose: number; appPieces: number; physPieces: number };
  B: { diff: number; valid: boolean; userTouched: boolean; physCases: number; physLoose: number; appPieces: number; physPieces: number };
  csOld: number;
  csNew: number;
  caseSizeChanged: boolean;
  caseSizeValid: boolean;
  hasAnyChange: boolean;
  invalid: boolean;
};
type ItemConflictType = {
  case_size: boolean;
  a_cases: boolean;
  a_loose: boolean;
  b_cases: boolean;
  b_loose: boolean;
  a: boolean;
  b: boolean;
  any: boolean;
  reason: string | null;
  missingDoneNames: string[];
};
type DoneMap = Map<string, { done: boolean; at: string | null; name: string | null }>;

// ─── MyView (default for everyone) ───────────────────────────────────────
// Shared prop shape for the My-count views.
type MyViewProps = {
  items: (Item & { categoryName: string | null })[];
  appStock: Map<string, { A: AppStock; B: AppStock }>;
  drafts: Map<DraftKey, DBDraft>;
  lastRecon: Map<string, LastReconciled>;
  currentUserId: string;
  frozen: boolean;
  computeDiff: (i: Item, app: { A: AppStock; B: AppStock }, d: DBDraft) => RowDiffType;
  setField: (uid: string, iid: string, f: Field, v: string) => void;
  commitRow: (uid: string, iid: string) => void;
  resetMyRow: (itemId: string) => void;
  errorsByItem: Map<string, string[]>;
  otherUsersByItem: (itemId: string) => DBDraft[];
  conflictByItem: (itemId: string) => ItemConflictType | null;
  doneByUser: DoneMap;
};

// Render EXACTLY ONE of the two layouts (never both mounted + CSS-hidden).
function MyView(props: MyViewProps) {
  const isDesktop = useMediaQuery("(min-width: 768px)");
  return isDesktop ? <DesktopTable {...props} /> : <MobileCards {...props} />;
}

function makeEmptyDraft(uid: string, iid: string): DBDraft {
  return {
    id: `local-${uid}::${iid}`,
    user_id: uid, item_id: iid,
    case_size_raw: "", a_cases_raw: "", a_loose_raw: "",
    b_cases_raw: "", b_loose_raw: "",
    updated_at: "",
    user_email: null, user_name: null, user_role: null,
  };
}

// Status rail colour shared by every card/row so state reads at a glance.
function statusRail(rd: RowDiffType, conflict: ItemConflictType | null, others: number, frozen: boolean): string {
  if (frozen) return "border-l-emerald-500";
  if (rd.invalid || conflict?.any) return "border-l-rose-500";
  if (rd.hasAnyChange) return "border-l-amber-500";
  if (others > 0) return "border-l-cyan-500";
  return "border-l-zinc-200 dark:border-l-zinc-800";
}

// Build the per-godown peer rows (other counters' totals + delta vs mine).
function buildPeers(others: DBDraft[], g: Godown, itemCs: number, mySide: RowDiffType["A"], doneByUser: DoneMap) {
  const myPcs = mySide.userTouched && mySide.valid ? mySide.physPieces : null;
  return others
    .map(o => ({ o, s: draftSide(o, g, itemCs) }))
    .filter(x => x.s.touched)
    .map(x => ({
      name: displayUser(x.o).split(" ")[0],
      pcs: x.s.pcs,
      delta: myPcs !== null ? x.s.pcs - myPcs : null,
      done: !!doneByUser.get(x.o.user_id)?.done,
    }));
}

// ─── GodownPanel — the System→You→Diff atom, reused on every surface ──────
function GodownPanel({
  g, appSide, side, csOld, csNew, cRaw, lRaw,
  onCases, onLoose, onBlur, stepper, compact, frozen, peers, ariaPrefix,
}: {
  g: Godown;
  appSide: AppStock;
  side: RowDiffType["A"];
  csOld: number; csNew: number;
  cRaw: string; lRaw: string;
  onCases: (v: string) => void; onLoose: (v: string) => void; onBlur: () => void;
  stepper: boolean; compact: boolean; frozen: boolean;
  peers: { name: string; pcs: number; delta: number | null; done: boolean }[];
  ariaPrefix: string;
}) {
  const touched = side.userTouched;
  const rail = g === "A" ? "border-l-cyan-500/70" : "border-l-violet-500/70";
  const head = g === "A" ? "text-cyan-700 dark:text-cyan-300" : "text-violet-700 dark:text-violet-300";
  const tone: "neutral" | "amber" | "rose" = touched ? (side.valid ? "amber" : "rose") : "neutral";
  // One box filled, sibling blank on a counted godown → make the implied 0 explicit.
  const onlyCases = cRaw.trim() !== "" && lRaw.trim() === "";
  const onlyLoose = lRaw.trim() !== "" && cRaw.trim() === "";
  return (
    <div className={cn("rounded-xl border-l-4 bg-zinc-50/70 dark:bg-zinc-800/40 p-2.5", rail)}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className={cn("text-[11px] font-semibold uppercase tracking-wider", head)}>Godown {g}</span>
        <SysChip label="SYS">{fmtN(side.appPieces)} pcs</SysChip>
      </div>
      <div className={cn(compact ? "grid grid-cols-2 gap-2" : "space-y-2")}>
        <div>
          <span className="block text-[10px] uppercase tracking-wide text-zinc-500 mb-0.5">Cases</span>
          <ExprInput value={cRaw} onChange={onCases} onBlur={onBlur} stepper={stepper} compact={compact} disabled={frozen}
            tone={tone} ariaLabel={`${ariaPrefix} godown ${g} cases`} />
        </div>
        <div>
          <span className="block text-[10px] uppercase tracking-wide text-zinc-500 mb-0.5">Loose</span>
          <ExprInput value={lRaw} onChange={onLoose} onBlur={onBlur} stepper={stepper} compact={compact} disabled={frozen}
            tone={tone} ariaLabel={`${ariaPrefix} godown ${g} loose`} />
        </div>
      </div>
      <div className="mt-2 pt-2 border-t border-zinc-200/70 dark:border-zinc-700/50 space-y-1">
        <LedgerRow label="In system" value={breakupStr(csOld, appSide.cases, appSide.loose)} />
        <LedgerRow
          label="You count"
          tone="you"
          value={touched && side.valid ? breakupStr(csNew, side.physCases, side.physLoose) : <span className="italic text-zinc-400">not counted</span>}
          trailing={touched && side.valid ? <DiffPill diff={side.diff} /> : undefined}
        />
        {touched && side.valid && (onlyCases || onlyLoose) && (
          <div className="text-[10px] text-zinc-500">{onlyCases ? "loose: 0 — none counted" : "cases: 0 — none counted"}</div>
        )}
        {peers.map((p, idx) => <PeerLine key={idx} {...p} />)}
      </div>
    </div>
  );
}

// ─── DesktopTable (My view) ──────────────────────────────────────────────
function DesktopTable({
  items, appStock, drafts, lastRecon, currentUserId, frozen,
  computeDiff, setField, commitRow, resetMyRow, errorsByItem,
  otherUsersByItem, conflictByItem, doneByUser,
}: MyViewProps) {
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-x-auto">
      <table className="w-full text-sm min-w-[860px]">
        <thead className="bg-zinc-50 dark:bg-zinc-900/50 border-b border-zinc-200 dark:border-zinc-800">
          <tr className="text-zinc-500 text-[11px] uppercase tracking-wider">
            <th className="text-left px-3 py-2.5 font-medium">Item</th>
            <th className="text-center px-2 py-2.5 font-medium w-[110px]">Case size</th>
            <th className="text-left px-2 py-2.5 font-medium w-[300px]">Godown A</th>
            <th className="text-left px-2 py-2.5 font-medium w-[300px]">Godown B</th>
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {items.map(i => {
            const app = appStock.get(i.id);
            if (!app) return null;
            const my = drafts.get(dkey(currentUserId, i.id)) ?? makeEmptyDraft(currentUserId, i.id);
            const rd = computeDiff(i, app, my);
            const others = otherUsersByItem(i.id);
            const conflict = conflictByItem(i.id);
            const last = lastRecon.get(i.id);
            return (
              <MyDesktopRow
                key={i.id}
                i={i} app={app} d={my} rd={rd}
                others={others}
                conflict={conflict}
                last={last}
                frozen={frozen}
                doneByUser={doneByUser}
                onChange={(field, value) => setField(currentUserId, i.id, field, value)}
                onBlur={() => commitRow(currentUserId, i.id)}
                onReset={() => resetMyRow(i.id)}
                errors={errorsByItem.get(i.id)}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MyDesktopRow({
  i, app, d, rd, others, conflict, last, frozen, doneByUser, onChange, onBlur, onReset, errors,
}: {
  i: Item & { categoryName: string | null };
  app: { A: AppStock; B: AppStock };
  d: DBDraft;
  rd: RowDiffType;
  others: DBDraft[];
  conflict: ItemConflictType | null;
  last?: LastReconciled;
  frozen: boolean;
  doneByUser: DoneMap;
  onChange: (field: Field, value: string) => void;
  onBlur: () => void;
  onReset: () => void;
  errors?: string[];
}) {
  const myTouched = rd.hasAnyChange;
  const hasErr = (errors?.length ?? 0) > 0;
  const itemCs = i.case_size || 0;
  const rail = statusRail(rd, conflict, others.length, frozen);
  return (
    <Fragment>
      <tr className="border-t border-zinc-200/50 dark:border-zinc-800/50 align-top">
        <td className={cn("px-3 py-3 border-l-4", rail)}>
          <div className="flex items-start gap-2 min-w-0">
            {i.brand && (
              <span className="bg-cyan-500/15 text-cyan-600 dark:text-cyan-300 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-medium flex-shrink-0 mt-0.5">
                {i.brand}
              </span>
            )}
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{i.model}</div>
              <div className="text-[11px] text-zinc-500 truncate">
                {[i.size, i.colour, i.categoryName].filter(Boolean).join(" · ")}
              </div>
              <RowMeta last={last} others={others} conflict={conflict} doneByUser={doneByUser} />
            </div>
          </div>
        </td>
        <td className="px-2 py-3 align-top">
          <ExprInput
            value={d.case_size_raw}
            prefill={String(rd.csOld)}
            onChange={(v) => onChange("case_size", v)}
            onBlur={onBlur}
            disabled={frozen}
            compact
            tone={rd.caseSizeChanged ? "amber" : (!rd.caseSizeValid ? "rose" : "neutral")}
            ariaLabel={`Case size for ${i.model}`}
          />
          {rd.caseSizeChanged && <div className="mt-1 flex justify-center"><SysChip label="WAS">{rd.csOld}</SysChip></div>}
        </td>
        <td className="px-2 py-3 align-top">
          <GodownPanel g="A" appSide={app.A} side={rd.A} csOld={rd.csOld} csNew={rd.csNew}
            cRaw={d.a_cases_raw} lRaw={d.a_loose_raw}
            onCases={(v) => onChange("a_cases", v)} onLoose={(v) => onChange("a_loose", v)} onBlur={onBlur}
            stepper={false} compact frozen={frozen}
            peers={buildPeers(others, "A", itemCs, rd.A, doneByUser)} ariaPrefix={i.model} />
        </td>
        <td className="px-2 py-3 align-top">
          <GodownPanel g="B" appSide={app.B} side={rd.B} csOld={rd.csOld} csNew={rd.csNew}
            cRaw={d.b_cases_raw} lRaw={d.b_loose_raw}
            onCases={(v) => onChange("b_cases", v)} onLoose={(v) => onChange("b_loose", v)} onBlur={onBlur}
            stepper={false} compact frozen={frozen}
            peers={buildPeers(others, "B", itemCs, rd.B, doneByUser)} ariaPrefix={i.model} />
        </td>
        <td className="px-2 py-3 align-top">
          {myTouched && !frozen && (
            <button type="button" onClick={onReset} className="text-zinc-400 hover:text-rose-500 p-1.5" title="Reset row" aria-label="Reset row">
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          )}
        </td>
      </tr>
      {hasErr && (
        <tr className="bg-rose-500/5">
          <td colSpan={5} className="px-3 py-2 text-[11px] text-rose-700 dark:text-rose-300 border-l-4 border-l-rose-500">
            <div className="flex items-start gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <div>{errors!.join(" · ")}</div>
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function RowMeta({ last, others, conflict, doneByUser }: { last?: LastReconciled; others: DBDraft[]; conflict: ItemConflictType | null; doneByUser: DoneMap }) {
  const lines: React.ReactNode[] = [];
  if (others.length > 0) {
    lines.push(
      <span key="others" className={cn(
        "inline-flex items-center gap-1 text-[10px]",
        conflict?.any ? "text-rose-600 dark:text-rose-400 font-medium" : "text-cyan-600 dark:text-cyan-400"
      )}>
        {conflict?.any ? <AlertCircle className="w-3 h-3" /> : <Users className="w-3 h-3" />}
        {conflict?.any ? "Disagrees with " : "Also counted by "}
        {others.map((o, idx) => (
          <span key={o.user_id} className="inline-flex items-center gap-0.5">
            {idx > 0 && ", "}{displayUser(o)}{doneByUser.get(o.user_id)?.done && <Lock className="w-2.5 h-2.5" />}
          </span>
        ))}
      </span>
    );
  }
  if (conflict?.any && conflict.reason) {
    lines.push(
      <span key="reason" className="inline-flex items-center gap-1 text-[10px] text-rose-600/90 dark:text-rose-400/90 tabular-nums">
        <AlertTriangle className="w-3 h-3 flex-shrink-0" /> {conflict.reason}
      </span>
    );
  }
  if (last) {
    lines.push(
      <span key="last" className="inline-flex items-center gap-1 text-[10px] text-zinc-400">
        <Clock className="w-3 h-3" /> Last: {timeAgo(last.at)}{last.userName ? ` by ${last.userName}` : ""}
      </span>
    );
  }
  if (lines.length === 0) return null;
  return <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">{lines}</div>;
}

// ─── ExprInput ───────────────────────────────────────────────────────────
function ExprInput({
  value, placeholder = "—", onChange, onBlur, tone, ariaLabel, compact = false, stepper = false, disabled = false, prefill,
}: {
  value: string;
  placeholder?: string;          // defaults to "—" — NEVER pass a system value here
  onChange: (v: string) => void;
  onBlur?: () => void;
  tone: "neutral" | "amber" | "rose";
  ariaLabel: string;
  compact?: boolean;
  stepper?: boolean;
  disabled?: boolean;
  // When set AND the value is empty, show this as the box's real (editable)
  // value, and select-all on focus so the first keystroke replaces it cleanly.
  // Used ONLY for case size (a pre-filled default), never for count boxes.
  prefill?: string;
}) {
  const parsed = parseExpr(value);
  const showsTotal = value.includes("+") && parsed !== null;
  const usingPrefill = value === "" && prefill !== undefined && prefill !== "";
  const displayValue = usingPrefill ? prefill! : value;
  const cls = cn(
    "w-full tabular-nums text-center border rounded-md focus:outline-none focus:ring-2 transition-colors",
    compact ? "min-h-9 text-[13px] px-1.5" : "min-h-11 text-base font-semibold px-2.5",
    disabled
      ? "bg-zinc-100 dark:bg-zinc-800/60 text-zinc-400 dark:text-zinc-500 cursor-not-allowed border-zinc-200 dark:border-zinc-800"
      : "bg-white dark:bg-zinc-900 placeholder:text-zinc-300 dark:placeholder:text-zinc-600 placeholder:font-normal",
    !disabled && tone === "amber" && "border-amber-500/60 focus:ring-amber-500/30 focus:border-amber-500",
    !disabled && tone === "rose" && "border-rose-500/70 focus:ring-rose-500/30 focus:border-rose-500",
    !disabled && tone === "neutral" && "border-zinc-200 dark:border-zinc-700 focus:ring-violet-500/40 focus:border-violet-500"
  );
  const field = (
    <div className="flex-1 flex flex-col gap-0.5 min-w-0">
      <input type="text" inputMode="numeric" value={displayValue} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        onFocus={usingPrefill ? (e) => e.currentTarget.select() : undefined}
        disabled={disabled}
        className={cls} aria-label={ariaLabel} />
      {/* Reserved caption slot for the running-total sum — fixed height so it
          can never clip or shift the row (the old absolute overlay did both). */}
      <span className="min-h-[12px] text-center text-[10px] leading-none text-zinc-500 tabular-nums">
        {showsTotal ? `= ${fmtN(parsed!)}` : ""}
      </span>
    </div>
  );
  if (!stepper) return field;

  // Stepper: −/+ adjust the running total by one without needing a "+" key
  // (mobile numeric keyboards have none). Collapses any expression to its sum
  // and writes back a plain integer; onBlur flushes the save immediately so a
  // tap survives the tab being backgrounded. tabIndex={-1} keeps box-to-box
  // typing flow (intentional — not a focus target).
  const bump = (delta: number) => {
    if (disabled) return;
    // Bump from the SHOWN number (so a pre-filled case size steps 6→7, not 0→1).
    const next = Math.max(0, (parseExpr(displayValue) ?? 0) + delta);
    onChange(String(next));
    onBlur?.();
  };
  const atZero = (parseExpr(displayValue) ?? 0) <= 0;
  const stepBtn =
    "flex-shrink-0 min-w-11 min-h-11 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-100 select-none active:scale-95 active:bg-zinc-200 dark:active:bg-zinc-700 hover:border-violet-400 disabled:opacity-40 disabled:active:scale-100 flex items-center justify-center transition";
  return (
    <div className="flex items-start gap-1.5">
      <button type="button" tabIndex={-1} onClick={() => bump(-1)} disabled={atZero || disabled}
        className={stepBtn} aria-label={`Decrease ${ariaLabel}`}><Minus className="w-4 h-4" /></button>
      {field}
      <button type="button" tabIndex={-1} onClick={() => bump(1)} disabled={disabled}
        className={stepBtn} aria-label={`Increase ${ariaLabel}`}><Plus className="w-4 h-4" /></button>
    </div>
  );
}

// ─── mobile cards (My view) ──────────────────────────────────────────────
function MobileCards({
  items, appStock, drafts, lastRecon, currentUserId, frozen,
  computeDiff, setField, commitRow, resetMyRow, errorsByItem,
  otherUsersByItem, conflictByItem, doneByUser,
}: MyViewProps) {
  return (
    <div className="space-y-3">
      {items.map(i => {
        const app = appStock.get(i.id);
        if (!app) return null;
        const my = drafts.get(dkey(currentUserId, i.id)) ?? makeEmptyDraft(currentUserId, i.id);
        const rd = computeDiff(i, app, my);
        const others = otherUsersByItem(i.id);
        const conflict = conflictByItem(i.id);
        const last = lastRecon.get(i.id);
        const errs = errorsByItem.get(i.id);
        const itemCs = i.case_size || 0;
        const rail = statusRail(rd, conflict, others.length, frozen);
        return (
          <div key={i.id} className={cn("bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 border-l-4 rounded-2xl p-4 shadow-sm", rail)}>
            {/* Header */}
            <div className="flex items-start justify-between gap-2 mb-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                  {i.brand && (
                    <span className="bg-cyan-500/15 text-cyan-600 dark:text-cyan-300 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-medium flex-shrink-0">
                      {i.brand}
                    </span>
                  )}
                  <span className="text-base font-semibold truncate">{i.model}</span>
                  {frozen && <DoneBadge />}
                </div>
                <div className="text-xs text-zinc-500 truncate">
                  {[i.size, i.colour, i.categoryName].filter(Boolean).join(" · ")}
                </div>
                <RowMeta last={last} others={others} conflict={conflict} doneByUser={doneByUser} />
              </div>
              {rd.hasAnyChange && !frozen && (
                <button onClick={() => resetMyRow(i.id)} className="text-zinc-400 hover:text-rose-500 min-w-11 min-h-11 -mr-2 -mt-1 inline-flex items-center justify-center flex-shrink-0" aria-label="Reset this item">
                  <RotateCcw className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Case-size strip — pre-filled with the system value (it rarely
                changes); only the "was N" reference appears once it's changed. */}
            <div className="grid grid-cols-[1fr_auto] items-center gap-2 mb-3 rounded-lg bg-zinc-50/70 dark:bg-zinc-800/40 px-3 py-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[10px] uppercase tracking-wider text-zinc-500">Case size</span>
                {rd.caseSizeChanged && <SysChip label="WAS">{rd.csOld}</SysChip>}
              </div>
              <div className="w-[148px]">
                <ExprInput
                  value={my.case_size_raw}
                  prefill={String(rd.csOld)}
                  onChange={(v) => setField(currentUserId, i.id, "case_size", v)}
                  onBlur={() => commitRow(currentUserId, i.id)}
                  disabled={frozen}
                  stepper
                  tone={rd.caseSizeChanged ? "amber" : (!rd.caseSizeValid ? "rose" : "neutral")}
                  ariaLabel={`Case size for ${i.model}`}
                />
              </div>
            </div>

            {/* Two full-width godown panels stacked (steppers need the width) */}
            <div className="space-y-3">
              <GodownPanel g="A" appSide={app.A} side={rd.A} csOld={rd.csOld} csNew={rd.csNew}
                cRaw={my.a_cases_raw} lRaw={my.a_loose_raw}
                onCases={(v) => setField(currentUserId, i.id, "a_cases", v)} onLoose={(v) => setField(currentUserId, i.id, "a_loose", v)}
                onBlur={() => commitRow(currentUserId, i.id)}
                stepper compact={false} frozen={frozen}
                peers={buildPeers(others, "A", itemCs, rd.A, doneByUser)} ariaPrefix={i.model} />
              <GodownPanel g="B" appSide={app.B} side={rd.B} csOld={rd.csOld} csNew={rd.csNew}
                cRaw={my.b_cases_raw} lRaw={my.b_loose_raw}
                onCases={(v) => setField(currentUserId, i.id, "b_cases", v)} onLoose={(v) => setField(currentUserId, i.id, "b_loose", v)}
                onBlur={() => commitRow(currentUserId, i.id)}
                stepper compact={false} frozen={frozen}
                peers={buildPeers(others, "B", itemCs, rd.B, doneByUser)} ariaPrefix={i.model} />
            </div>

            {errs && errs.length > 0 && (
              <div className="mt-3 text-[11px] text-rose-700 dark:text-rose-300 flex items-start gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <div>{errs.join(" · ")}</div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── ReviewerView (admin only) ───────────────────────────────────────────
function ReviewerView({
  items, appStock, draftsByItem, lastRecon, computeDiff, computeItemConflict,
  setField, commitRow, deleteDraft, currentUserId, doneByUser,
  people, onAddCounter, onApplyItem, applyingItemId, errorsByItem,
}: {
  items: (Item & { categoryName: string | null })[];
  appStock: Map<string, { A: AppStock; B: AppStock }>;
  draftsByItem: Map<string, DBDraft[]>;
  lastRecon: Map<string, LastReconciled>;
  computeDiff: (i: Item, app: { A: AppStock; B: AppStock }, d: DBDraft) => RowDiffType;
  computeItemConflict: (i: Item, drs: DBDraft[]) => ItemConflictType;
  setField: (uid: string, iid: string, f: Field, v: string) => void;
  commitRow: (uid: string, iid: string) => void;
  deleteDraft: (uid: string, iid: string) => void;
  currentUserId: string;
  doneByUser: DoneMap;
  people: { id: string; name: string; role: string }[];
  onAddCounter: (itemId: string, userId: string) => void;
  onApplyItem: (item: Item, source: DBDraft) => void;
  applyingItemId: string | null;
  errorsByItem: Map<string, string[]>;
}) {
  return (
    <div className="space-y-3">
      {items.map(i => {
        const app = appStock.get(i.id);
        if (!app) return null;
        const drs = draftsByItem.get(i.id) || [];
        const nonEmpty = drs.filter(d => !isDraftEmpty(d));
        // Rows to render: real counts + any admin-added empty rows awaiting entry.
        const rows = drs.filter(d => !isDraftEmpty(d) || d.id.startsWith("local-add-"));
        const rowUserIds = new Set(rows.map(r => r.user_id));
        const canAdd = people.filter(p => !rowUserIds.has(p.id));
        const applying = applyingItemId === i.id;
        const conflict = nonEmpty.length > 0 ? computeItemConflict(i, nonEmpty) : null;
        const ready = nonEmpty.length > 0 && !conflict?.any;
        const rail = conflict?.any ? "border-l-rose-500" : ready ? "border-l-emerald-500" : "border-l-zinc-200 dark:border-l-zinc-800";
        const cs = i.case_size || 0;
        const last = lastRecon.get(i.id);
        const errs = errorsByItem.get(i.id);
        return (
          <div key={i.id} className={cn("bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 border-l-4 rounded-lg overflow-hidden", rail)}>
            {/* Verdict header — system reference lives in labelled chips, never inside a box */}
            <div className="px-3 py-2.5 bg-zinc-50 dark:bg-zinc-900/50">
              <div className="flex items-start gap-2">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  {i.brand && (
                    <span className="bg-cyan-500/15 text-cyan-600 dark:text-cyan-300 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-medium flex-shrink-0">
                      {i.brand}
                    </span>
                  )}
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{i.model}</div>
                    <div className="text-[11px] text-zinc-500 truncate">
                      {[i.size, i.colour, i.categoryName].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                </div>
                {conflict?.any ? (
                  <span className="inline-flex items-center gap-1 bg-rose-500/15 text-rose-700 dark:text-rose-300 px-2 py-0.5 rounded text-[10px] uppercase tracking-wider font-medium flex-shrink-0">
                    <AlertTriangle className="w-3 h-3" /> Conflict
                  </span>
                ) : ready ? (
                  <span className="inline-flex items-center gap-1 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 px-2 py-0.5 rounded text-[10px] uppercase tracking-wider font-medium flex-shrink-0">
                    <CheckCheck className="w-3 h-3" /> Ready
                  </span>
                ) : null}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-[9px] uppercase tracking-wider text-zinc-400 font-semibold">In system</span>
                <SysChip label="A" className="text-cyan-700 dark:text-cyan-300">{breakupStr(cs, app.A.cases, app.A.loose)}</SysChip>
                <SysChip label="B" className="text-violet-700 dark:text-violet-300">{breakupStr(cs, app.B.cases, app.B.loose)}</SysChip>
                <SysChip label="CS">{cs}</SysChip>
                {last && <span className="text-[10px] text-zinc-400 ml-auto">Last: {timeAgo(last.at)}{last.userName ? ` by ${last.userName}` : ""}</span>}
              </div>
            </div>

            {/* Plain-language reason so the reviewer resolves fast without decoding cells */}
            {conflict?.any && conflict.reason && (
              <div className="px-3 py-1.5 bg-rose-500/5 border-t border-rose-500/15 text-[11px] text-rose-700 dark:text-rose-300 flex items-start gap-1.5 tabular-nums">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <div>{conflict.reason}</div>
              </div>
            )}

            {rows.length === 0 ? (
              <div className="px-3 py-3 text-[11px] text-zinc-500 italic">No counts yet — add one for a counter below, or open My count.</div>
            ) : (
              <div className="divide-y divide-zinc-200/60 dark:divide-zinc-800/60">
                {rows.map(d => (
                  <ReviewerUserRow
                    key={d.user_id}
                    i={i}
                    app={app}
                    d={d}
                    conflict={conflict}
                    isMe={d.user_id === currentUserId}
                    userDone={!!doneByUser.get(d.user_id)?.done}
                    computeDiff={computeDiff}
                    canApply={!isDraftEmpty(d)}
                    applying={applying}
                    onChange={(field, value) => setField(d.user_id, i.id, field, value)}
                    onBlur={() => commitRow(d.user_id, i.id)}
                    onApply={() => onApplyItem(i, d)}
                    onClear={() => deleteDraft(d.user_id, i.id)}
                  />
                ))}
              </div>
            )}

            {/* Add a count on behalf of a counter who hasn't entered one */}
            {canAdd.length > 0 && (
              <div className="px-3 py-2.5 border-t border-zinc-200/60 dark:border-zinc-800/60 flex items-center gap-2 flex-wrap">
                <UserPlus className="w-4 h-4 text-zinc-400 flex-shrink-0" />
                <span className="text-[11px] text-zinc-500">Enter a count for someone who didn't count:</span>
                <select
                  value=""
                  onChange={(e) => { if (e.target.value) onAddCounter(i.id, e.target.value); }}
                  className="min-h-11 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1 text-[13px] focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
                  aria-label={`Add a count for ${i.model}`}
                >
                  <option value="">Select counter…</option>
                  {canAdd.map(p => <option key={p.id} value={p.id}>{p.name}{p.role === "admin" ? " (admin)" : ""}</option>)}
                </select>
              </div>
            )}

            {errs && errs.length > 0 && (
              <div className="px-3 py-2 bg-rose-500/5 border-t border-rose-500/20 text-[11px] text-rose-700 dark:text-rose-300 flex items-start gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <div>{errs.join(" · ")}</div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// One godown block inside a reviewer counter row (A or B).
function ReviewerGodown({
  g, side, csNew, cRaw, lRaw, conflictCell, onCases, onLoose, onBlur, ariaPrefix,
}: {
  g: Godown;
  side: RowDiffType["A"];
  csNew: number;
  cRaw: string; lRaw: string;
  conflictCell: boolean;
  onCases: (v: string) => void; onLoose: (v: string) => void; onBlur: () => void;
  ariaPrefix: string;
}) {
  const touched = side.userTouched;
  const rail = g === "A" ? "border-l-cyan-500/70" : "border-l-violet-500/70";
  const head = g === "A" ? "text-cyan-700 dark:text-cyan-300" : "text-violet-700 dark:text-violet-300";
  const tone: "neutral" | "amber" | "rose" = conflictCell ? "rose" : touched ? (side.valid ? "amber" : "rose") : "neutral";
  return (
    <div className={cn("rounded-lg border-l-4 bg-zinc-50/60 dark:bg-zinc-800/30 p-2", rail, conflictCell && "ring-1 ring-rose-500/40")}>
      <div className="flex items-center justify-between gap-1 mb-1.5">
        <span className={cn("text-[10px] font-semibold uppercase tracking-wider", conflictCell ? "text-rose-600 dark:text-rose-400" : head)}>Godown {g}</span>
        <SysChip label="SYS">{fmtN(side.appPieces)} pcs</SysChip>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <div>
          <span className="block text-[9px] uppercase tracking-wide text-zinc-500 mb-0.5">Cases</span>
          <ExprInput value={cRaw} onChange={onCases} onBlur={onBlur} compact tone={tone} ariaLabel={`${ariaPrefix} godown ${g} cases`} />
        </div>
        <div>
          <span className="block text-[9px] uppercase tracking-wide text-zinc-500 mb-0.5">Loose</span>
          <ExprInput value={lRaw} onChange={onLoose} onBlur={onBlur} compact tone={tone} ariaLabel={`${ariaPrefix} godown ${g} loose`} />
        </div>
      </div>
      <div className="mt-1.5">
        <LedgerRow
          label="Counted"
          tone="you"
          value={touched && side.valid ? `${fmtN(side.physPieces)} pcs` : <span className="italic text-zinc-400">not counted</span>}
          trailing={touched && side.valid ? <DiffPill diff={side.diff} /> : undefined}
        />
      </div>
    </div>
  );
}

function ReviewerUserRow({
  i, app, d, conflict, isMe, userDone, computeDiff, canApply, applying, onChange, onBlur, onApply, onClear,
}: {
  i: Item;
  app: { A: AppStock; B: AppStock };
  d: DBDraft;
  conflict: ItemConflictType | null;
  isMe: boolean;
  userDone: boolean;
  computeDiff: (i: Item, app: { A: AppStock; B: AppStock }, d: DBDraft) => RowDiffType;
  canApply: boolean;
  applying: boolean;
  onChange: (field: Field, value: string) => void;
  onBlur: () => void;
  onApply: () => void;
  onClear: () => void;
}) {
  const rd = computeDiff(i, app, d);
  const name = displayUser(d);
  const csTone: "neutral" | "amber" | "rose" = conflict?.case_size ? "rose" : tonefor(d.case_size_raw, rd.caseSizeValid, rd.caseSizeChanged);
  return (
    <div className={cn("p-3", isMe && "bg-cyan-500/5")}>
      {/* Who + clear */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
          <UserCircle2 className="w-4 h-4 text-zinc-500 flex-shrink-0" />
          <span className="text-[13px] font-medium truncate">{name}{isMe && <span className="text-zinc-400 ml-1">(you)</span>}</span>
          {userDone && <DoneBadge />}
          <span className="text-[10px] text-zinc-500">{d.user_role || "—"}{d.updated_at ? ` · ${timeAgo(d.updated_at)}` : ""}</span>
        </div>
        <button onClick={onClear} disabled={applying} className="text-zinc-400 hover:text-rose-500 min-w-11 min-h-11 -m-1 inline-flex items-center justify-center flex-shrink-0 disabled:opacity-40" title={`Clear ${name}'s count`} aria-label={`Clear ${name}'s count`}>
          <RotateCcw className="w-4 h-4" />
        </button>
      </div>

      {/* Case size — pre-filled with the system value; "was N" shows if changed */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] uppercase tracking-wide text-zinc-500">Case size</span>
        {rd.caseSizeChanged && <SysChip label="WAS">{i.case_size || 0}</SysChip>}
        <div className="w-[120px]">
          <ExprInput value={d.case_size_raw} prefill={String(i.case_size || 0)} onChange={(v) => onChange("case_size", v)} onBlur={onBlur} compact
            tone={csTone} ariaLabel={`Case size by ${name}`} />
        </div>
      </div>

      {/* Godown A + B */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <ReviewerGodown g="A" side={rd.A} csNew={rd.csNew} cRaw={d.a_cases_raw} lRaw={d.a_loose_raw}
          conflictCell={!!conflict?.a} onCases={(v) => onChange("a_cases", v)} onLoose={(v) => onChange("a_loose", v)} onBlur={onBlur} ariaPrefix={`${name}`} />
        <ReviewerGodown g="B" side={rd.B} csNew={rd.csNew} cRaw={d.b_cases_raw} lRaw={d.b_loose_raw}
          conflictCell={!!conflict?.b} onCases={(v) => onChange("b_cases", v)} onLoose={(v) => onChange("b_loose", v)} onBlur={onBlur} ariaPrefix={`${name}`} />
      </div>

      {/* Apply just this item to stock using THIS counter's numbers */}
      {canApply && (
        <button
          type="button"
          onClick={onApply}
          disabled={applying}
          className="mt-2 w-full min-h-11 inline-flex items-center justify-center gap-1.5 rounded-lg border border-emerald-500/50 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10 text-sm font-medium disabled:opacity-50 transition-colors"
          title={`Apply ${name}'s count to stock for this item`}
        >
          {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
          Apply {name.split(" ")[0]}&apos;s count to stock
        </button>
      )}
    </div>
  );
}

function tonefor(raw: string, valid: boolean, touched: boolean): "neutral" | "amber" | "rose" {
  if (raw.trim() === "") return "neutral";
  if (!valid) return "rose";
  if (touched) return "amber";
  return "neutral";
}

// ─── hint card ───────────────────────────────────────────────────────────
function HintCard({ isAdmin, mode }: { isAdmin: boolean; mode: "my" | "reviewer" }) {
  return (
    <div className="mt-6 bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 text-xs text-zinc-600 dark:text-zinc-400 space-y-1.5">
      <div className="flex items-center gap-1.5 text-zinc-700 dark:text-zinc-200 font-medium">
        <Filter className="w-3.5 h-3.5" /> Tips
      </div>
      <div>
        <strong>Quick adds:</strong> on a phone, tap the <strong>−</strong>/<strong>+</strong> buttons beside each box to add or remove pieces as you find them — or type{" "}
        <code className="px-1 bg-zinc-200 dark:bg-zinc-800 rounded">5+1</code> to keep a running total. Each box shows what's <strong>in system</strong> vs what <strong>you count</strong>, with the difference.
      </div>
      <div>
        <strong>Per-user drafts:</strong> each counter has their own list — your numbers never overwrite anyone else's. You can see other counters' totals under each godown with the <strong>difference vs your count</strong> in red, so you can recheck before the reviewer does.
      </div>
      <div>
        <strong>Loose auto-packs:</strong> if you enter more loose than the case size (e.g. 3 loose on a case of 2), it rolls up to 1 case + 1 loose automatically when you leave the box.
      </div>
      <div>
        <strong>Mark my count done</strong> freezes your entries so they can't change by accident. While you're done, any item you left <em>blank</em> but a teammate filled is read as “found none” and flagged to the reviewer as a conflict. Hit <strong>Resume editing</strong> if you find more.
      </div>
      {!isAdmin && (
        <div>
          <strong>No commit button:</strong> only admin commits. Once your count is done, mark it done and tell admin to review and adjust.
        </div>
      )}
      {isAdmin && (
        <div>
          <strong>Reviewer mode</strong> shows every counter's draft per item with each one's A/B totals. Disagreements (or a “done” counter who missed an item others found) are flagged{" "}
          <span className="inline-block px-1 bg-rose-500/15 text-rose-700 dark:text-rose-300 rounded text-[10px]">Conflict</span> with the reason spelled out and skipped from the bulk commit. Use <strong>Conflicts</strong> to see only those. Agreed items show{" "}
          <span className="inline-block px-1 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 rounded text-[10px]">Ready</span>. Edit anyone's row inline to resolve, or ask them to recount.
        </div>
      )}
      {isAdmin && (
        <div>
          <strong>Add a count for</strong> at the bottom of each item lets you enter a count on behalf of a counter who didn't. And <strong>Apply this count</strong> on any row commits <em>just that item</em> to stock using that counter's numbers — your pick-the-value, item-by-item adjustment (overrides a conflict). <strong>Make adjustments</strong> bulk-commits every agreed item; its confirm box also offers <strong>“Full count — zero the stock nobody found”</strong> so after a complete stock-take the system matches the count exactly (untick it for a partial count).
        </div>
      )}
      <div>
        <strong>Case size</strong> edits are staged like the rest — nothing applies until <strong>Make adjustments</strong> runs. While editing, the totals on this page use the new case size for the math.
      </div>
      <div>
        <strong>Print PDF</strong> gives you a blank count sheet for paper-based stocktake. Transcribe back to {mode === "my" ? "My count" : "your count"} when done.
      </div>
    </div>
  );
}

// ─── empty / loading ─────────────────────────────────────────────────────
function SkeletonBody() {
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-5 space-y-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-6 rounded shimmer" style={{ width: `${50 + (i * 9) % 50}%` }} />
      ))}
    </div>
  );
}
function EmptyState({ clearFilters }: { clearFilters: () => void }) {
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg py-12 text-center">
      <ClipboardCheck className="w-7 h-7 text-zinc-400 dark:text-zinc-600 mx-auto mb-3" strokeWidth={1.5} />
      <div className="text-sm text-zinc-500">No items match the current filter.</div>
      <button onClick={clearFilters} className="mt-3 text-xs text-cyan-600 dark:text-cyan-400 hover:underline">Clear filters</button>
    </div>
  );
}

// ─── print sheet ─────────────────────────────────────────────────────────
function PrintSheet({
  items,
}: {
  items: (Item & { categoryName: string | null })[];
}) {
  type Group = { brand: string; cats: Array<{ cat: string; rows: typeof items }> };
  const grouped: Group[] = useMemo(() => {
    const byBrand = new Map<string, Map<string, typeof items>>();
    for (const i of items) {
      const b = i.brand || "(No brand)";
      const c = i.categoryName || "(No category)";
      if (!byBrand.has(b)) byBrand.set(b, new Map());
      const inner = byBrand.get(b)!;
      if (!inner.has(c)) inner.set(c, []);
      inner.get(c)!.push(i);
    }
    return [...byBrand.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([brand, inner]) => ({
        brand,
        cats: [...inner.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([cat, rows]) => ({ cat, rows })),
      }));
  }, [items]);

  const today = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  return (
    <div className="print-sheet hidden">
      <div className="ps-header">
        <div>
          <div className="ps-title">Stock Reconciliation — Count Sheet</div>
          <div className="ps-subtitle">Rye Electricals · {today}</div>
        </div>
        <div className="ps-meta">
          <div>Counted by: ______________________</div>
          <div>Signed: ______________________</div>
        </div>
      </div>
      {grouped.map((g) => (
        <div key={g.brand} className="ps-brand">
          <div className="ps-brand-h">{g.brand}</div>
          {g.cats.map(({ cat, rows }) => (
            <div key={cat}>
              <div className="ps-cat-h">{cat}</div>
              <table className="ps-table">
                <thead>
                  <tr>
                    <th className="ps-model">Model · size · colour</th>
                    <th className="ps-cs">Case<br/>size</th>
                    <th className="ps-cell">A cases</th>
                    <th className="ps-cell">A loose</th>
                    <th className="ps-cell">B cases</th>
                    <th className="ps-cell">B loose</th>
                    <th className="ps-notes">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(i => (
                    <tr key={i.id}>
                      <td className="ps-model">
                        <div className="ps-model-name">{i.model}</div>
                        <div className="ps-model-sub">{[i.size, i.colour].filter(Boolean).join(" · ")}</div>
                      </td>
                      <td className="ps-cs"><div className="ps-blank-line"></div></td>
                      <td className="ps-cell"><div className="ps-blank-line"></div></td>
                      <td className="ps-cell"><div className="ps-blank-line"></div></td>
                      <td className="ps-cell"><div className="ps-blank-line"></div></td>
                      <td className="ps-cell"><div className="ps-blank-line"></div></td>
                      <td className="ps-notes"></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      ))}
      <div className="ps-footer">
        Write the physical count on the line in each cell. Transcribe back to /reconciliation when done.
      </div>
    </div>
  );
}
