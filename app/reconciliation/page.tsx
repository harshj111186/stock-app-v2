"use client";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Printer, ClipboardCheck, CheckCircle2, AlertCircle,
  RotateCcw, Loader2, Filter, Eye, Users, ShieldCheck,
  UserCircle2, Clock, Lock, LockOpen, CheckCheck, AlertTriangle, UserPlus,
  Minus, Plus, History, Download, X, Eraser, Equal, Pencil, ChevronDown, ListChecks, Folder,
} from "lucide-react";
import { Shell } from "@/components/shell";
import { sb, fetchAllRows, type Item } from "@/lib/supabase";
import { useAuth } from "@/app/providers";
import { fmtN, cn, matchesQuery, todayISO } from "@/lib/utils";
import { buildCategoryTree, flattenTree, pathById, toCatRow } from "@/lib/categories";
import { useEscape, useMediaQuery } from "@/lib/hooks";
import { useConfirm } from "@/components/confirm-dialog";
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

// My-count quick filters (chips): everything · not counted yet · counted ·
// counted but different from the system · disagrees with another counter.
type MyFilter = "all" | "todo" | "counted" | "differs" | "conflicts";

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
// Local-timezone date (todayISO) — toISOString() is UTC and stamped
// yesterday's date on commits between 00:00 and 05:30 IST.
const TODAY = () => todayISO();
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

// Build the single "agreed" row a conflict-free item commits: each godown
// taken WHOLE from one counter who entered THAT godown (never field-mixed
// across counters — that could pair one person's cases with another's loose
// and commit a number nobody entered), case size from any non-empty entry.
// apply_reconciliation re-normalises the split, so which agreeing counter we
// pick can't change the stored result. Shared by makeAdjustments, the commit
// pre-check, and the Step-2 (system-difference) list so all three agree on
// what "the agreed count" is.
function mergeAgreed(base: DBDraft, nonEmpty: DBDraft[], itemId: string): DBDraft {
  const touchedG = (d: DBDraft, g: Godown) =>
    (g === "A" ? d.a_cases_raw : d.b_cases_raw).trim() !== "" ||
    (g === "A" ? d.a_loose_raw : d.b_loose_raw).trim() !== "";
  const repA = nonEmpty.find(d => touchedG(d, "A"));
  const repB = nonEmpty.find(d => touchedG(d, "B"));
  const csRaw = nonEmpty.find(d => d.case_size_raw.trim() !== "")?.case_size_raw || "";
  return {
    ...base,
    item_id: itemId,
    case_size_raw: csRaw,
    a_cases_raw: repA?.a_cases_raw ?? "",
    a_loose_raw: repA?.a_loose_raw ?? "",
    b_cases_raw: repB?.b_cases_raw ?? "",
    b_loose_raw: repB?.b_loose_raw ?? "",
  };
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

// Media query now comes from lib/hooks — its LAZY initial read fixes the
// one-frame flash where desktop mounted the full mobile card list first.

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
  // Green is reserved for "matches". Extra stock is still a difference to
  // explain (amber); missing stock is the loud one (rose).
  const cls = diff === 0
    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
    : diff > 0
      ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
      : "bg-rose-500/15 text-rose-700 dark:text-rose-300";
  // Plain words — "2 short" / "5 extra" read faster than a signed number.
  const txt = diff === 0 ? "Matches" : `${fmtN(Math.abs(diff))} ${diff > 0 ? "extra" : "short"}`;
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
      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1 min-w-0 justify-end">
        <span className={cn("text-[11px] tabular-nums whitespace-nowrap", tone === "you" ? "font-medium text-zinc-800 dark:text-zinc-100" : "text-zinc-500 dark:text-zinc-400")}>{value}</span>
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
  // Viewers are read-only app-wide; the drafts/done RLS (2026-06-10
  // hardening) rejects their writes, so don't render write affordances.
  const canCount = isAdmin || profile?.role === "staff";
  const { confirm, confirmDialog } = useConfirm();

  const [items, setItems] = useState<Item[]>([]);
  const [appStock, setAppStock] = useState<Map<string, { A: AppStock; B: AppStock }>>(new Map());
  const [catNameById, setCatNameById] = useState<Map<string, string>>(new Map());
  const [catOrder, setCatOrder] = useState<Map<string, number>>(new Map());
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

  // UI mode — persisted per session so the reviewer doesn't land back on
  // "My count" on every visit mid-review-week.
  const [mode, setMode] = useState<"my" | "reviewer">(() => {
    try {
      return sessionStorage.getItem("recon.mode") === "reviewer" ? "reviewer" : "my";
    } catch { return "my"; }
  });
  useEffect(() => {
    if (!isAdmin && mode === "reviewer") setMode("my");
    try { sessionStorage.setItem("recon.mode", mode); } catch {}
  }, [isAdmin, mode]);

  // Reviewer two-step wizard (admin only).
  //   Step 1 "Reconcile staff counts"  — resolve disagreements BETWEEN counters
  //                                        until every staff agrees on each item.
  //   Step 2 "Reconcile with system"   — push the agreed counts to system stock
  //                                        (where they differ). Gated: Step 2 is
  //                                        only reachable once no staff conflict
  //                                        remains. Persisted per session.
  const [reviewerStep, setReviewerStep] = useState<1 | 2>(() => {
    try { return sessionStorage.getItem("recon.reviewerStep") === "2" ? 2 : 1; } catch { return 1; }
  });
  useEffect(() => {
    try { sessionStorage.setItem("recon.reviewerStep", String(reviewerStep)); } catch {}
  }, [reviewerStep]);

  // Filters
  const [q, setQ] = useState("");
  const [brand, setBrand] = useState("");
  const [cat, setCat] = useState("");
  // My-count quick filter (the chips under the search box). The matching item
  // ids are SNAPSHOTTED when a chip is tapped — a live filter would yank a row
  // out from under the counter mid-typing (an item stops being "to count" on
  // its first keystroke). Tapping the same chip again re-takes the snapshot.
  const [myFilter, setMyFilter] = useState<MyFilter>("all");
  const [pinnedIds, setPinnedIds] = useState<Set<string> | null>(null);

  // Commit + toast state
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  // Pre-commit confirmation (Make adjustments) — shows what will move and the
  // census option ("full count → zero what nobody found") before anything writes.
  const [commitConfirm, setCommitConfirm] = useState<null | {
    counted: number; conflicted: number; invalid: number; uncountedItems: number; uncountedSides: number; notDone: string[];
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
      c.from("categories").select("id, name, parent_id, archived, sort_order"),
      c.from("reconciliation_drafts_with_user").select("*"),
      // Latest reconciliation per item — paginated (PostgREST clamps any
      // .limit() to 1,000 server-side) and deduped client-side.
      fetchAllRows<{ item_id: string; created_at: string; created_by: string | null; note: string | null }>(
        (from, to) => c.from("transactions")
          // The audit text lives in `note` (process_transaction maps its reason
          // param to the note column) — the `reason` column is never written.
          .select("item_id, created_at, created_by, note")
          .like("note", "Reconciliation%")
          .order("created_at", { ascending: false }).order("id")
          .range(from, to),
        { maxRows: 5000 }
      ).then(r => ({ data: r.rows })),
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

    // Purge drafts pointing at archived/deleted items — they're invisible on
    // this page, survive every commit, and would resurface as stale "live"
    // counts if the item is ever unarchived. Everyone cleans their own;
    // admins clean all (RLS allows both).
    const itemIds = new Set((rows || []).map((i: any) => i.id));
    const orphans = (draftsData || []).filter((d: any) => !itemIds.has(d.item_id));
    if (orphans.length > 0) {
      const ids = (isAdmin ? orphans : orphans.filter((d: any) => d.user_id === profile?.id))
        .map((d: any) => d.id);
      if (ids.length > 0) void sb().from("reconciliation_drafts").delete().in("id", ids);
    }

    const draftsMap = new Map<DraftKey, DBDraft>();
    (draftsData || []).forEach((d: any) => {
      if (!itemIds.has(d.item_id)) return; // orphan (being purged above)
      draftsMap.set(dkey(d.user_id, d.item_id), d as DBDraft);
    });

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
    // Full path ("Fans › Ceiling › BLDC") + tree position, so the count list
    // walks the shelves category by category and a parent filter includes
    // everything under it (2026-11-16).
    {
      const catRows = (cats || []).map(toCatRow);
      setCatNameById(pathById(catRows));
      setCatOrder(new Map(flattenTree(buildCategoryTree(catRows, true)).map((n, idx) => [n.id, idx])));
    }
    // Same in-flight protection as refreshDrafts: a post-commit load() must
    // not roll back a keystroke typed during the commit whose save hasn't
    // acked yet (the pending persist would then re-save a stale snapshot).
    {
      const inFlight = (k: string) => saveTimers.current.has(k) || dirtyRef.current.has(k) || deletingRef.current.has(k);
      // A pending-delete key may still come back from the server (its delete
      // hasn't committed) — purge it so a post-commit reload can't resurrect it.
      for (const k of deletingRef.current) draftsMap.delete(k);
      for (const [k, local] of draftsRef.current) {
        if (inFlight(k) || local.id.startsWith("local-")) draftsMap.set(k, local);
      }
    }
    writeDrafts(draftsMap);
    setDoneByUser(doneMap);
    setLastRecon(lastMap);
    setLoaded(true);
  }, [writeDrafts, isAdmin, profile?.id]);

  useEffect(() => { void load(); }, [load]);

  // ─── pending saves (debounced upserts) ─────────────────────────────────
  // One timer per (user, item) — we coalesce keystrokes locally and fire a
  // single upsert ~200 ms after the last keystroke for that row. Tracked
  // up here so the polling refresh below can check whether a row is
  // mid-save and skip it.
  const saveTimers = useRef<Map<DraftKey, number>>(new Map());
  // Consecutive failed saves per row — drives exponential retry backoff and
  // keeps the "couldn't save" toast to ONE per failure streak instead of an
  // endless 3-second loop.
  const retryCounts = useRef<Map<DraftKey, number>>(new Map());
  // Keys with an unsaved local edit (set on keystroke, cleared once the server
  // ack confirms the row matches what we sent). The poll never overwrites a
  // key that is "in flight" — either a debounce timer is pending OR it's dirty.
  // This replaces the old client-timestamp comparison, which could clobber a
  // freshly-typed value on a clock-skewed phone (server clock > client clock).
  const dirtyRef = useRef<Set<DraftKey>>(new Set());
  // Keys whose DELETE is in flight. deleteDraft clears the local row + dirty +
  // timers BEFORE the server delete commits, so without this the poll's `select
  // *` can still see the not-yet-deleted row and re-adopt it (resurrecting a
  // just-cleared count). Tracked separately from dirtyRef so refreshDrafts can
  // skip a pending-delete key the same way it skips an in-flight edit.
  const deletingRef = useRef<Set<DraftKey>>(new Set());

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
    // In flight = pending save, dirty edit, OR a delete whose server commit
    // hasn't landed yet (else we'd re-adopt the row we just cleared).
    const inFlight = (k: string) => saveTimers.current.has(k) || dirtyRef.current.has(k) || deletingRef.current.has(k);

    // Drop local rows the server no longer has (e.g. admin committed them),
    // unless in flight or never persisted.
    for (const [k, local] of [...draftsRef.current]) {
      if (inFlight(k) || serverByKey.has(k) || local.id.startsWith("local-")) continue;
      next.delete(k);
    }
    // Adopt every server row that isn't being edited locally right now. A
    // pending-delete key is in flight, so a not-yet-committed delete can't be
    // resurrected by the poll.
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
    // applyingItemId IS a dep: the guard above must re-evaluate when a
    // per-item apply starts, or the existing interval keeps polling mid-apply.
  }, [loaded, processing, applyingItemId, refreshDrafts, refreshAppStock, refreshDone, mode]);

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
      // Exponential backoff (3s → 6s → 12s → … capped 30s); toast only once
      // per failure streak so a permanent error doesn't nag every retry.
      const attempts = retryCounts.current.get(k) ?? 0;
      if (attempts === 0) showToast("bad", `Couldn't save — will keep retrying (${error.message})`);
      retryCounts.current.set(k, attempts + 1);
      if (draftsRef.current.has(k) && dirtyRef.current.has(k) && !saveTimers.current.has(k)) {
        const delay = Math.min(3000 * Math.pow(2, attempts), 30000);
        const t = window.setTimeout(() => { saveTimers.current.delete(k); void persistDraft(userId, itemId); }, delay);
        saveTimers.current.set(k, t);
      }
      return;
    }
    retryCounts.current.delete(k);
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
    // Tombstone the key BEFORE the local removal so the poll/load can't re-adopt
    // the row from the server while its delete is still in flight. Cleared only
    // after the server delete resolves (in finally).
    deletingRef.current.add(k);
    const next = new Map(draftsRef.current);
    next.delete(k);
    writeDrafts(next);
    dirtyRef.current.delete(k);
    const t = saveTimers.current.get(k);
    if (t) { clearTimeout(t); saveTimers.current.delete(k); }
    try {
      await sb().from("reconciliation_drafts").delete().eq("user_id", userId).eq("item_id", itemId);
    } finally {
      deletingRef.current.delete(k);
    }
  }, [writeDrafts]);

  // Wipe EVERY draft row one counter holds — the "start fresh" action (self
  // from My count's Clear all, any counter from the admin's Counters panel).
  // Same tombstone discipline as deleteDraft, applied to all of the user's
  // keys BEFORE the bulk server delete, so neither the poll nor a pending
  // save timer can resurrect a row mid-wipe. If the counter was marked done,
  // the freeze is lifted too — a done user's blanks read as "found none" and
  // a wiped-but-still-done count would fabricate a conflict on every item
  // their teammates counted.
  const clearAllForUser = useCallback(async (userId: string): Promise<boolean> => {
    const keys: DraftKey[] = [];
    for (const [k, d] of draftsRef.current) if (d.user_id === userId) keys.push(k);
    for (const k of keys) {
      deletingRef.current.add(k);
      dirtyRef.current.delete(k);
      const t = saveTimers.current.get(k);
      if (t) { clearTimeout(t); saveTimers.current.delete(k); }
    }
    if (keys.length > 0) {
      const next = new Map(draftsRef.current);
      for (const k of keys) next.delete(k);
      writeDrafts(next);
    }
    let ok = true;
    try {
      const { error } = await sb().from("reconciliation_drafts").delete().eq("user_id", userId);
      if (error) {
        ok = false;
        showToast("bad", `Couldn't clear the count: ${error.message}`);
      }
    } catch (e) {
      ok = false;
      showToast("bad", `Couldn't clear the count: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      // Tombstones off. On failure the next poll re-adopts whatever survived
      // server-side — the same self-heal deleteDraft relies on.
      for (const k of keys) deletingRef.current.delete(k);
    }
    if (ok && doneByUser.get(userId)?.done) {
      const { error } = await sb().from("reconciliation_done")
        .update({ done: false, done_at: null }).eq("user_id", userId);
      if (!error) await refreshDone();
    }
    return ok;
  }, [writeDrafts, doneByUser, refreshDone]);

  // My count's Clear all — every one of MY entries, behind an explicit
  // danger popup (nothing wipes on a stray tap). Hidden while frozen: resume
  // first, then clear.
  const clearMyCount = useCallback(async () => {
    if (!profile?.id || myDone) return;
    const uid = profile.id;
    let rows = 0, itemsN = 0;
    for (const [, d] of draftsRef.current) {
      if (d.user_id !== uid) continue;
      rows++;
      if (!isDraftEmpty(d)) itemsN++;
    }
    if (rows === 0) return;
    const n = itemsN || rows;
    const ok = await confirm({
      title: "Clear your entire count?",
      body: <>Your entries on <strong>{fmtN(n)} item{n === 1 ? "" : "s"}</strong> are deleted so you can start fresh. This can&apos;t be undone.</>,
      danger: true,
      confirmLabel: "Clear all",
    });
    if (!ok) return;
    if (await clearAllForUser(uid)) showToast("ok", "Your count is cleared — start fresh.");
  }, [profile?.id, myDone, confirm, clearAllForUser]);

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

  // Permanently save a staff member's reconciliation work the MOMENT they mark
  // their count done — independent of (and earlier than) the admin commit. Each
  // "done" press snapshots every non-empty draft they currently hold into
  // reconciliation_done_snapshots, so their finished count survives even if a
  // recount overwrites it, a conflict resolution clears it, or the admin never
  // commits. Non-fatal: a failure (e.g. migration not yet run) never blocks the
  // freeze — the done flag is already set; we just warn the snapshot wasn't kept.
  const snapshotDoneCounts = useCallback(async (uid: string, doneIso: string) => {
    const rows: Array<Record<string, unknown>> = [];
    for (const [, d] of draftsRef.current) {
      if (d.user_id !== uid || isDraftEmpty(d)) continue;
      const item = itemById.get(d.item_id);
      if (!item) continue;
      const cs = item.case_size || 0;
      const sA = draftSide(d, "A", cs);
      const sB = draftSide(d, "B", cs);
      rows.push({
        user_id: uid,
        user_name: profile?.name?.trim() || profile?.email?.split("@")[0] || null,
        done_at: doneIso,
        item_id: item.id, item_code: item.item_code, brand: item.brand,
        model: item.model, size: item.size, colour: item.colour,
        case_size: cs,
        case_size_raw: d.case_size_raw,
        a_cases_raw: d.a_cases_raw, a_loose_raw: d.a_loose_raw,
        b_cases_raw: d.b_cases_raw, b_loose_raw: d.b_loose_raw,
        a_pieces: sA.touched ? sA.pcs : null,
        b_pieces: sB.touched ? sB.pcs : null,
      });
    }
    if (rows.length === 0) return;
    const { error } = await sb().from("reconciliation_done_snapshots").insert(rows);
    if (error) {
      showToast("info", `Count frozen, but the saved copy wasn't stored — run db/2026-06-26-staff-done-snapshots.sql. (${error.message})`);
    }
  }, [itemById, profile?.name, profile?.email]);

  const toggleDone = useCallback(async () => {
    if (!profile?.id || doneSaving) return;
    const uid = profile.id;
    const next = !myDone;
    if (next) flushAllPendingSaves(); // capture any in-flight edit before freezing
    setDoneSaving(true);
    const nowIso = new Date().toISOString();
    // Snapshot for an exact rollback — restamping `at` with the new time on
    // failure used to lose the real done-at.
    const prevEntry = doneByUser.get(uid);
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
      // roll back the optimistic flip to the exact previous entry
      setDoneByUser(prev => {
        const m = new Map(prev);
        if (prevEntry) m.set(uid, prevEntry); else m.delete(uid);
        return m;
      });
      showToast("bad", `Couldn't update done state: ${error.message}`);
      return;
    }
    showToast(next ? "ok" : "info", next ? "Count marked done — your entries are frozen and saved." : "Resumed — your entries are editable again.");
    // Persist this counter's finished work as a permanent snapshot.
    if (next) void snapshotDoneCounts(uid, nowIso);
  }, [profile?.id, myDone, doneSaving, flushAllPendingSaves, snapshotDoneCounts]);

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
  const itemsEnriched = useMemo(() => {
    const coll = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
    return items.map(i => ({
      ...i,
      categoryName: i.category_id ? (catNameById.get(i.category_id) ?? i.category ?? null) : (i.category ?? null),
      _ord: i.category_id ? (catOrder.get(i.category_id) ?? 1e6) : 1e7,
    })).sort((a, b) => a._ord - b._ord
      || coll.compare(a.brand || "", b.brand || "") || coll.compare(a.model, b.model)
      || coll.compare(a.size || "", b.size || "") || coll.compare(a.colour || "", b.colour || ""));
  }, [items, catNameById, catOrder]);

  const brands = useMemo(
    () => [...new Set(itemsEnriched.map(i => i.brand || "").filter(Boolean))].sort(),
    [itemsEnriched]
  );
  // Every level that holds items, parents included ("Fans", "Fans › Ceiling").
  const cats = useMemo(() => {
    const out = new Set<string>();
    for (const i of itemsEnriched) {
      const segs = (i.categoryName || "").split(" › ").filter(Boolean);
      for (let k = 1; k <= segs.length; k++) out.add(segs.slice(0, k).join(" › "));
    }
    return [...out].sort((a, b) => a.localeCompare(b));
  }, [itemsEnriched]);

  const filtered = useMemo(() => {
    return itemsEnriched.filter(i => {
      if (brand && i.brand !== brand) return false;
      if (cat && !(i.categoryName === cat || (i.categoryName ?? "").startsWith(cat + " › "))) return false;
      // The chips are My-count only: the Reviewer's two-step wizard drives its
      // own list (its step memos derive from `filtered`), so a chip left on
      // must never silently empty Step 1 / Step 2.
      if (mode === "my" && myFilter !== "all" && pinnedIds && !pinnedIds.has(i.id)) return false;
      const hay = `${i.brand || ""} ${i.model} ${i.size} ${i.colour} ${i.categoryName || ""} ${i.subcategory || ""} ${i.item_code}`;
      if (!matchesQuery(hay, q)) return false;
      return true;
    });
  }, [itemsEnriched, q, brand, cat, mode, myFilter, pinnedIds]);

  // ─── derived: header stats ─────────────────────────────────────────────
  const stats = useMemo(() => {
    let myStaged = 0, anyStaged = 0, conflicts = 0, invalid = 0;
    let myShortPcs = 0, myExtraPcs = 0;
    const usersWithDrafts = new Set<string>();
    // Item ids per My-count chip — the chip counts AND the snapshot a tap pins.
    const ids: Record<Exclude<MyFilter, "all">, Set<string>> = {
      todo: new Set(), counted: new Set(), differs: new Set(), conflicts: new Set(),
    };
    items.forEach(i => {
      const app = appStock.get(i.id);
      if (!app) return;
      const drs = draftsByItem.get(i.id) || [];
      if (drs.length > 0) anyStaged++;
      drs.forEach(d => usersWithDrafts.add(d.user_id));
      const mine = drs.find(d => d.user_id === profile?.id);
      if (mine && !isDraftEmpty(mine)) {
        myStaged++;
        ids.counted.add(i.id);
        const rd = computeDiff(i, app, mine);
        if (!rd.invalid && (rd.A.diff !== 0 || rd.B.diff !== 0)) {
          ids.differs.add(i.id);
          for (const d of [rd.A.diff, rd.B.diff]) { if (d < 0) myShortPcs += -d; else myExtraPcs += d; }
        }
      } else {
        ids.todo.add(i.id);
      }
      // Count invalid PER ITEM (any counter's entry not a valid number → +1),
      // consistent with conflicts/staged which are also per item.
      if (drs.some(d => computeDiff(i, app, d).invalid)) invalid++;
      const c = computeItemConflict(i, drs);
      if (c.any) { conflicts++; ids.conflicts.add(i.id); }
    });
    return { myStaged, anyStaged, conflicts, invalid, usersWithDrafts, ids, myShortPcs, myExtraPcs };
  }, [items, appStock, draftsByItem, computeDiff, computeItemConflict, profile?.id]);

  // ─── Reviewer two-step wizard: the two item lists ───────────────────────
  // Step 1 — items where staff disagree (the staff-vs-staff reconciliation).
  const reviewerStep1Items = useMemo(() => {
    if (!isAdmin) return [];
    return filtered.filter(i => {
      const drs = draftsByItem.get(i.id) || [];
      return computeItemConflict(i, drs).any;
    });
  }, [isAdmin, filtered, draftsByItem, computeItemConflict]);

  // Step 2 — agreed items whose count differs from the system (the discrepancies
  // to push to stock). Excludes conflicts (handled in Step 1) and no-change /
  // invalid items (nothing to adjust). Uses mergeAgreed so the list matches
  // exactly what "Make adjustments" would commit.
  // Ids shown on Step 2 during THIS visit to the step. An item the reviewer
  // edits until it equals the system (or passes through a matching value while
  // typing, e.g. "1" on the way to "12") must stay on screen — a card that
  // vanishes under the cursor is worse than one that now reads "Matches".
  const step2Seen = useRef<Set<string>>(new Set());
  const reviewerStep2 = useMemo(() => {
    if (!isAdmin) return { list: [] as typeof filtered, differ: 0 };
    let differ = 0;
    const list = filtered.filter(i => {
      const app = appStock.get(i.id);
      if (!app) return false;
      const nonEmpty = (draftsByItem.get(i.id) || []).filter(d => !isDraftEmpty(d));
      if (nonEmpty.length === 0) return false;
      if (computeItemConflict(i, nonEmpty).any) return false;
      const rd = computeDiff(i, app, mergeAgreed(emptyDraft, nonEmpty, i.id));
      if (!rd.hasAnyChange || rd.invalid) return false;
      // Only what actually differs. A count that equals the system needs no
      // decision (it used to be listed here under "differs from system");
      // those are summarised in `step2Summary` and still close out on commit.
      if (rd.A.diff !== 0 || rd.B.diff !== 0 || rd.caseSizeChanged) { differ++; return true; }
      return step2Seen.current.has(i.id);
    });
    return { list, differ };
    // mode / reviewerStep are deps so the list is rebuilt (without the kept
    // matches) each time the reviewer comes back to the step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, filtered, appStock, draftsByItem, computeItemConflict, computeDiff, emptyDraft, mode, reviewerStep]);
  const reviewerStep2Items = reviewerStep2.list;
  useEffect(() => {
    if (mode === "reviewer" && reviewerStep === 2) {
      for (const i of reviewerStep2Items) step2Seen.current.add(i.id);
    } else {
      step2Seen.current.clear();
    }
  }, [mode, reviewerStep, reviewerStep2Items]);

  // Step 2 at a glance: how many agreed counts simply match the system, and
  // the total pieces short / extra across the ones that don't.
  const step2Summary = useMemo(() => {
    let matching = 0, shortPcs = 0, extraPcs = 0;
    if (!isAdmin) return { matching, shortPcs, extraPcs };
    for (const i of items) {
      const app = appStock.get(i.id);
      if (!app) continue;
      const nonEmpty = (draftsByItem.get(i.id) || []).filter(d => !isDraftEmpty(d));
      if (nonEmpty.length === 0 || computeItemConflict(i, nonEmpty).any) continue;
      const rd = computeDiff(i, app, mergeAgreed(emptyDraft, nonEmpty, i.id));
      if (rd.invalid || !rd.hasAnyChange) continue;
      if (rd.A.diff === 0 && rd.B.diff === 0 && !rd.caseSizeChanged) { matching++; continue; }
      for (const d of [rd.A.diff, rd.B.diff]) { if (d < 0) shortPcs += -d; else extraPcs += d; }
    }
    return { matching, shortPcs, extraPcs };
  }, [isAdmin, items, appStock, draftsByItem, computeItemConflict, computeDiff, emptyDraft]);

  const reviewerListItems = reviewerStep === 1 ? reviewerStep1Items : reviewerStep2Items;

  // Enforce the wizard invariant: Step 2 is only valid with zero staff conflicts.
  // If one exists — a stale session restored straight to Step 2, or a new
  // disagreement arrived while the admin was reviewing (e.g. a counter marked
  // done and left a blank) — snap back to Step 1, the same gate the Step-2 tab
  // lock enforces for clicks. The rising-conflict toast already says why.
  useEffect(() => {
    if (mode === "reviewer" && reviewerStep === 2 && stats.conflicts > 0) setReviewerStep(1);
  }, [mode, reviewerStep, stats.conflicts]);

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
    if (!canCommit || processing || applyingItemId) return;
    let counted = 0, conflicted = 0, invalid = 0, uncountedItems = 0, uncountedSides = 0;
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
      // Classify with the SAME merged row the commit will build, so the
      // dialog's numbers exactly match what makeAdjustments will do (an
      // invalid-only entry used to show as "counted" and then silently skip).
      const merged = mergeAgreed(emptyDraft, nonEmpty, i.id);
      const rd = computeDiff(i, app, merged);
      if (rd.invalid) { invalid++; continue; }
      counted++;
      // Census only zeroes an uncounted godown when the item had REAL
      // quantities entered — a case-size-only correction means the counter
      // handled the item, so its stock must not be zeroed as "not found".
      if (rd.A.userTouched || rd.B.userTouched) {
        for (const g of ["A", "B"] as Godown[]) {
          const side = g === "A" ? rd.A : rd.B;
          if (!side.userTouched && hasStock(g)) uncountedSides++;
        }
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
    setCommitConfirm({ counted, conflicted, invalid, uncountedItems, uncountedSides, notDone });
  };

  // Reset stale "done" flags: a counter whose drafts were all committed
  // shouldn't carry a frozen/done state into the next stock-take cycle.
  // Shared by BOTH commit paths (bulk used to do this; per-item didn't, so a
  // counter fully committed via "Apply this count" stayed frozen).
  const resetStaleDoneFlags = useCallback(async () => {
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
  }, [doneByUser, refreshDone]);

  // ─── commit (admin only) ───────────────────────────────────────────────
  // zeroUncounted = "this was a FULL count": after committing every agreed
  // count, any item (or godown) that NO counter entered but that still shows
  // stock in the system is set to 0 — the count is the truth, so stock nobody
  // found doesn't exist. Confirmed via the pre-commit dialog (never silent),
  // so a partial count can simply untick it and only counted items move.
  const makeAdjustments = async (zeroUncounted: boolean) => {
    if (!canCommit) { showToast("bad", "Only admins can commit reconciliation."); return; }
    if (processing || applyingItemId) return;

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
    const date = TODAY();
    // Permanent per-counter record of every entry feeding this commit. The
    // entries are SNAPSHOTTED here (drafts still intact) but INSERTED after
    // the stock RPCs run, so each row's `applied` flag is truthful — the log
    // used to assert applied=true before any stock write happened.
    const logRows: Array<Record<string, unknown> & { item_id: string }> = [];

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
      // total. Build the committed row via mergeAgreed (each godown taken WHOLE
      // from one counter who entered THAT godown — never field-mixed).
      const merged = mergeAgreed(emptyDraft, nonEmpty, i.id);
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
      // stock goes to 0 too — same "the count is the truth" rule. EXCEPT
      // when the draft is a case-size-only correction (no quantities): the
      // counter clearly handled the item, so census must not zero stock they
      // never claimed was missing.
      if (zeroUncounted && (rd.A.userTouched || rd.B.userTouched)) {
        for (const g of ["A", "B"] as Godown[]) {
          const side = g === "A" ? rd.A : rd.B;
          if (side.userTouched) continue;
          const z = zeroSide(app, rd.csNew, g);
          if (z) sides.push(z);
        }
      }

      if (!rd.hasAnyChange && sides.length === 0) continue;

      // Snapshot every counter's entries on this item for the count log.
      // Conflict-free ⇒ all entries agree, so each row is marked applied.
      for (const d of nonEmpty) {
        const sA = draftSide(d, "A", i.case_size || 0);
        const sB = draftSide(d, "B", i.case_size || 0);
        logRows.push({
          commit_note: `Reconciliation ${date}`, commit_kind: "bulk", committed_by: profile?.id ?? null,
          user_id: d.user_id, user_name: displayUser(d),
          item_id: i.id, item_code: i.item_code, brand: i.brand, model: i.model, size: i.size, colour: i.colour,
          case_size: i.case_size || 0,
          case_size_raw: d.case_size_raw, a_cases_raw: d.a_cases_raw, a_loose_raw: d.a_loose_raw,
          b_cases_raw: d.b_cases_raw, b_loose_raw: d.b_loose_raw,
          a_pieces: sA.touched ? sA.pcs : null, b_pieces: sB.touched ? sB.pcs : null,
          applied: true,
        });
      }

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

    // Phase order matters: 1) stock RPCs, 2) count log (truthful applied
    // flags), 3) draft wipe. Drafts are wiped LAST so a crash mid-commit
    // never destroys an uncommitted, unlogged count.
    const totalSteps = jobs.reduce((n, j) => n + (j.caseSizeChanged ? 1 : 0) + j.sides.length + 1 /* delete drafts step */, 0);
    setProgress({ done: 0, total: totalSteps });
    let done = 0;
    const newErrors: typeof errors = [];
    const failedItems = new Set<string>();

    for (const j of jobs) {
      if (j.caseSizeChanged) {
        const { error } = await sb().from("items").update({ case_size: j.caseSizeNew }).eq("id", j.itemId);
        done++; setProgress({ done, total: totalSteps });
        if (error) {
          newErrors.push({ itemId: j.itemId, message: `Case size update failed: ${error.message}` });
          failedItems.add(j.itemId);
          // Tick the skipped steps so the bar still completes.
          done += j.sides.length; setProgress({ done, total: totalSteps });
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
    }

    // Phase 2: count log — with TRUTHFUL applied flags (an item whose stock
    // write failed is recorded applied=false; the counts themselves are still
    // preserved). Failure never blocks the commit — it's folded into the
    // final toast so the success toast can't clobber the warning.
    let logFailed = false;
    if (logRows.length > 0) {
      const finalLog = logRows.map(r => (failedItems.has(r.item_id) ? { ...r, applied: false } : r));
      const { error: logErr } = await sb().from("reconciliation_count_log").insert(finalLog);
      if (logErr) logFailed = true;
    }

    // Phase 3: clear the drafts that fed this commit — scoped to exactly
    // those counters (j.userIdsToWipe), NOT every draft on the item. A
    // counter who started entering this item AFTER we snapshotted (e.g.
    // during a long bulk commit) keeps their draft for the next cycle
    // instead of it being silently wiped unapplied. Failed items keep ALL
    // their drafts for retry.
    for (const j of jobs) {
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
    const logNote = logFailed ? " Count log NOT saved — run db/2026-06-10-count-log.sql." : "";
    if (failedItems.size === 0 && skipped.length === 0) {
      showToast(logFailed ? "info" : "ok", `Committed ${succeeded} item${succeeded === 1 ? "" : "s"}${zeroedNote}.${logNote}`);
    } else if (failedItems.size === 0) {
      showToast("info", `Committed ${succeeded}${zeroedNote}. ${skipped.length} item${skipped.length === 1 ? "" : "s"} skipped (conflicts/invalid).${logNote}`);
    } else {
      showToast("bad", `Committed ${succeeded}, ${failedItems.size} failed.${logNote}`);
    }

    await load();
    await resetStaleDoneFlags();
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

    // Snapshot every counter's entries on this item NOW (drafts intact); the
    // log row insert happens AFTER the stock RPCs so `applied` is truthful.
    const snapDrafts = (draftsByItem.get(item.id) || []).filter(d => !isDraftEmpty(d));

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

    // Count log — every counter's entries on this item; the chosen source
    // row is `applied` only when the stock writes actually landed.
    let logFailed = false;
    if (snapDrafts.length > 0) {
      const rows = snapDrafts.map(d => {
        const sA = draftSide(d, "A", item.case_size || 0);
        const sB = draftSide(d, "B", item.case_size || 0);
        return {
          commit_note: `Reconciliation ${date}`, commit_kind: "single", committed_by: profile?.id ?? null,
          user_id: d.user_id, user_name: displayUser(d),
          item_id: item.id, item_code: item.item_code, brand: item.brand, model: item.model, size: item.size, colour: item.colour,
          case_size: item.case_size || 0,
          case_size_raw: d.case_size_raw, a_cases_raw: d.a_cases_raw, a_loose_raw: d.a_loose_raw,
          b_cases_raw: d.b_cases_raw, b_loose_raw: d.b_loose_raw,
          a_pieces: sA.touched ? sA.pcs : null, b_pieces: sB.touched ? sB.pcs : null,
          applied: !failed && d.user_id === source.user_id,
        };
      });
      const { error: logErr } = await sb().from("reconciliation_count_log").insert(rows);
      if (logErr) logFailed = true;
    }

    // Drafts cleared only after the count is committed AND logged — the
    // permanent log is what preserves the other counters' unapplied entries.
    if (!failed) {
      const { error: delErr } = await sb().from("reconciliation_drafts").delete().eq("item_id", item.id);
      if (delErr) newErrors.push({ itemId: item.id, message: `Draft cleanup failed: ${delErr.message}` });
    }

    setErrors(newErrors);
    setApplyingItemId(null);
    const label = `${item.brand ? item.brand + " · " : ""}${item.model}`;
    const logNote = logFailed ? " Count log NOT saved — run db/2026-06-10-count-log.sql." : "";
    if (!failed) showToast(logFailed ? "info" : "ok", `Applied ${label} — ${displayUser(source)}'s count saved to stock.${logNote}`);
    else showToast("bad", `Couldn't apply ${label}. See the error on the card.${logNote}`);
    await load();
    await resetStaleDoneFlags();
  };

  // Reviewer Step 1 resolution: make the staff AGREE on ONE counter's numbers
  // for an item, WITHOUT touching system stock (that's Step 2). The universal
  // resolver that always clears a conflict:
  //   1. delete the disagreeing counters' drafts (admin picks the winner),
  //   2. un-mark any "done misser" — a counter who marked their whole count done
  //      but left THIS item blank, whose blank computeItemConflict reads as
  //      "found none (0)" and which would otherwise keep the conflict (and the
  //      Step-2 lock) alive forever. Setting them back to not-done removes that
  //      veto; their real "found nothing" is preserved in the on-done snapshot.
  //   3. drop stale done flags for any counter now holding no drafts.
  // After this only the kept counter's draft remains → no conflict, no stock
  // write, and the item flows to Step 2 if it differs from the system.
  const keepOnlyCount = useCallback((item: Item, keepUserId: string) => {
    void (async () => {
      const all = draftsByItem.get(item.id) || [];
      if (!all.some(d => d.user_id === keepUserId && !isDraftEmpty(d))) return; // can only keep a real count
      const disagreers = all.filter(d => !isDraftEmpty(d) && d.user_id !== keepUserId);
      const enteredHere = new Set(all.filter(d => !isDraftEmpty(d)).map(d => d.user_id));
      const doneMissers = [...doneByUser.entries()]
        .filter(([uid, info]) => info.done && uid !== keepUserId && !enteredHere.has(uid))
        .map(([uid]) => uid);
      if (disagreers.length === 0 && doneMissers.length === 0) return; // nothing to resolve
      // EVERY done counter who ends up blank on this item must be set back to
      // not-done, else their blank re-reads as found-none(0) and re-raises the
      // conflict. That's the done missers PLUS any done DISAGREER whose draft we
      // delete below (resetStaleDoneFlags spares them — they've counted other
      // items — so they'd otherwise become a fresh misser and need a 2nd click).
      const undoneTargets = [...new Set([
        ...doneMissers,
        ...disagreers.filter(d => doneByUser.get(d.user_id)?.done).map(d => d.user_id),
      ])];

      const keepName = peopleRef.current.get(keepUserId) || "this counter";
      const clearedNames = disagreers.map(d => peopleRef.current.get(d.user_id) || "a counter");
      const misserNames = doneMissers.map(uid => peopleRef.current.get(uid) || "a counter");
      const parts: string[] = [`The staff will agree on ${keepName}'s numbers for this item.`];
      if (clearedNames.length) parts.push(`${clearedNames.join(", ")} ${clearedNames.length === 1 ? "count is" : "counts are"} cleared.`);
      if (misserNames.length) parts.push(`${misserNames.join(", ")} (marked done but didn't count this item) ${misserNames.length === 1 ? "is" : "are"} set back to “not done”, so their blank stops flagging a conflict.`);
      parts.push("This does NOT change system stock — that happens in Step 2. Cleared counts can't be recovered.");
      const ok = await confirm({ title: `Keep ${keepName}'s count?`, body: parts.join(" "), danger: true, confirmLabel: "Keep this count" });
      if (!ok) return;

      for (const d of disagreers) await deleteDraft(d.user_id, item.id);
      if (undoneTargets.length > 0) {
        try {
          await sb().from("reconciliation_done").update({ done: false, done_at: null }).in("user_id", undoneTargets);
          await refreshDone();
        } catch { /* non-fatal: the conflict can still be resolved by recount / per-item apply in Step 2 */ }
      }
      await resetStaleDoneFlags();
    })();
  }, [confirm, deleteDraft, draftsByItem, doneByUser, refreshDone, resetStaleDoneFlags]);

  // ─── count history (admin) ───────────────────────────────────────────────
  type CountLogRow = {
    id: string; commit_note: string; commit_kind: string; created_at: string;
    user_id: string; user_name: string | null;
    item_id: string | null; item_code: string | null; brand: string | null;
    model: string | null; size: string | null; colour: string | null;
    case_size: number; case_size_raw: string;
    a_cases_raw: string; a_loose_raw: string; b_cases_raw: string; b_loose_raw: string;
    a_pieces: number | null; b_pieces: number | null; applied: boolean;
  };
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRows, setHistoryRows] = useState<CountLogRow[] | null>(null);
  useEscape(historyOpen, () => setHistoryOpen(false));
  useEscape(!!commitConfirm, () => setCommitConfirm(null));
  const openHistory = async () => {
    setHistoryOpen(true);
    setHistoryRows(null);
    // Two sources, merged into one timeline: admin COMMITS (count log) and each
    // staff member's MARKED-DONE snapshots. If only the snapshots table is
    // absent (migration not run yet) we still show the commit log, and vice versa.
    // Paginated (PostgREST clamps any .limit() to 1,000 rows server-side, which
    // would silently drop the OLDEST cycles from the viewer + CSV). Stable DESC
    // order + id tiebreaker so pages don't overlap. Each source tolerated alone.
    const [logRes, snapRes] = await Promise.all([
      fetchAllRows<CountLogRow>((f, t) =>
        sb().from("reconciliation_count_log").select("*").order("created_at", { ascending: false }).order("id").range(f, t),
        { maxRows: 20000 }),
      fetchAllRows<Record<string, unknown>>((f, t) =>
        sb().from("reconciliation_done_snapshots").select("*").order("done_at", { ascending: false }).order("id").range(f, t),
        { maxRows: 20000 }),
    ]);
    if (logRes.error && snapRes.error) {
      showToast("bad", `Couldn't load history — has db/2026-06-10-count-log.sql been run? (${logRes.error})`);
      setHistoryRows([]);
      return;
    }
    // A single-source failure must not masquerade as "empty" — warn so the admin
    // can tell "no snapshots yet" from "snapshots failed to load". A missing
    // snapshots table (migration not run) is the benign, expected case.
    if (snapRes.error && !logRes.error) {
      showToast("info", `Showing commits only — the “marked done” snapshots didn't load (run db/2026-06-26-staff-done-snapshots.sql if you haven't). ${snapRes.error}`);
    } else if (logRes.error && !snapRes.error) {
      showToast("info", `Showing “marked done” snapshots only — the commit log didn't load. ${logRes.error}`);
    }
    const logRows = logRes.rows;
    // Normalise each "marked done" snapshot into the same row shape, kind="done".
    const doneRows: CountLogRow[] = (snapRes.rows as Array<Record<string, unknown>>).map(s => ({
      id: s.id as string,
      commit_note: `Marked done — ${(s.user_name as string) || "counter"}`,
      commit_kind: "done",
      created_at: s.done_at as string,
      user_id: s.user_id as string,
      user_name: (s.user_name as string) ?? null,
      item_id: (s.item_id as string) ?? null,
      item_code: (s.item_code as string) ?? null,
      brand: (s.brand as string) ?? null,
      model: (s.model as string) ?? null,
      size: (s.size as string) ?? null,
      colour: (s.colour as string) ?? null,
      case_size: (s.case_size as number) ?? 0,
      case_size_raw: (s.case_size_raw as string) ?? "",
      a_cases_raw: (s.a_cases_raw as string) ?? "",
      a_loose_raw: (s.a_loose_raw as string) ?? "",
      b_cases_raw: (s.b_cases_raw as string) ?? "",
      b_loose_raw: (s.b_loose_raw as string) ?? "",
      a_pieces: (s.a_pieces as number) ?? null,
      b_pieces: (s.b_pieces as number) ?? null,
      applied: false,
    }));
    const all = [...logRows, ...doneRows].sort((a, b) =>
      a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0
    );
    setHistoryRows(all);
  };
  // One batch per commit (all rows of a commit share created_at + note).
  const historyBatches = useMemo(() => {
    if (!historyRows) return [];
    const m = new Map<string, { key: string; note: string; at: string; kind: string; rows: CountLogRow[] }>();
    for (const r of historyRows) {
      // A commit batch groups every counter's rows together; a "done" batch is
      // per-user, so key it by user_id too (two staff marking done at the same
      // instant must not merge).
      const key = `${r.created_at}|${r.commit_note}|${r.commit_kind}${r.commit_kind === "done" ? "|" + r.user_id : ""}`;
      if (!m.has(key)) m.set(key, { key, note: r.commit_note, at: r.created_at, kind: r.commit_kind, rows: [] });
      m.get(key)!.rows.push(r);
    }
    return [...m.values()];
  }, [historyRows]);
  const exportHistoryCsv = () => {
    if (!historyRows || historyRows.length === 0) return;
    const esc = (v: unknown) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ["Committed at", "Commit", "Kind", "Counter", "Brand", "Model", "Size", "Colour", "Item code", "Case size", "Case size entry", "A cases entry", "A loose entry", "A pieces", "B cases entry", "B loose entry", "B pieces", "Applied"];
    const lines = historyRows.map(r => [
      r.created_at, r.commit_note, r.commit_kind, r.user_name || r.user_id,
      r.brand || "", r.model || "", r.size || "", r.colour || "", r.item_code || "",
      r.case_size, r.case_size_raw, r.a_cases_raw, r.a_loose_raw, r.a_pieces ?? "",
      r.b_cases_raw, r.b_loose_raw, r.b_pieces ?? "", r.applied ? "yes" : "",
    ].map(esc).join(","));
    const csv = "﻿" + [header.map(esc).join(","), ...lines].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `count-log-${todayISO()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // ─── counters panel (admin): everyone's progress + per-counter Clear all ──
  // Opened from the "N users counting" chip. Lists every counter with saved
  // entries this cycle; "Clear all" wipes that counter's whole count so they
  // can start fresh. Includes the admin themself — clearing your own count
  // works from the same place.
  const [countersOpen, setCountersOpen] = useState(false);
  useEscape(countersOpen, () => setCountersOpen(false));
  // Per-user busy flag so a slow wipe can't be double-tapped (or two wipes
  // interleaved) while the first one's delete is in flight.
  const [clearingUid, setClearingUid] = useState<string | null>(null);
  const counterSummary = useMemo(() => {
    const m = new Map<string, { name: string; items: number; rows: number }>();
    drafts.forEach(d => {
      const cur = m.get(d.user_id) ?? { name: displayUser(d), items: 0, rows: 0 };
      cur.rows++;
      if (!isDraftEmpty(d)) cur.items++;
      m.set(d.user_id, cur);
    });
    return [...m.entries()]
      .map(([id, v]) => ({ id, ...v, done: doneByUser.get(id)?.done ?? false }))
      .sort((a, b) =>
        (a.id === profile?.id ? 0 : 1) - (b.id === profile?.id ? 0 : 1) ||
        a.name.localeCompare(b.name));
  }, [drafts, doneByUser, profile?.id]);

  const clearCounterAll = useCallback(async (uid: string, name: string, itemsN: number) => {
    // Not while a commit / per-item apply is running — makeAdjustments wipes
    // drafts itself at the end, and racing the two deletes could strand rows.
    if (clearingUid || processing || applyingItemId) return;
    const isMe = uid === profile?.id;
    const wasDone = doneByUser.get(uid)?.done ?? false;
    const who = isMe ? "Your" : `${name}'s`;
    const ok = await confirm({
      title: isMe ? "Clear your entire count?" : `Clear ${name}'s entire count?`,
      body: <>
        {who} entries on <strong>{fmtN(itemsN)} item{itemsN === 1 ? "" : "s"}</strong> are deleted — {isMe ? "you" : "they"}&apos;d have to recount from scratch.
        {wasDone && <> The &ldquo;done&rdquo; freeze is lifted too.</>} This can&apos;t be undone.
      </>,
      danger: true,
      confirmLabel: "Clear all",
    });
    if (!ok) return;
    setClearingUid(uid);
    const success = await clearAllForUser(uid);
    setClearingUid(null);
    if (success) showToast("ok", isMe ? "Your count is cleared." : `${name}'s count is cleared${wasDone ? " and unfrozen" : ""}.`);
  }, [clearingUid, processing, applyingItemId, profile?.id, doneByUser, confirm, clearAllForUser]);

  // ─── My-count chips ─────────────────────────────────────────────────────
  // Tapping a chip pins the items that match RIGHT NOW (see `pinnedIds`).
  const pickMyFilter = (f: MyFilter) => {
    setMyFilter(f);
    setPinnedIds(f === "all" ? null : new Set(stats.ids[f]));
  };
  // The pinned list no longer equals the live one (the counter has typed
  // since) → offer "Refresh list" instead of silently reshuffling rows.
  const listStale = useMemo(() => {
    if (myFilter === "all" || !pinnedIds) return false;
    const live = stats.ids[myFilter];
    if (live.size !== pinnedIds.size) return true;
    for (const id of live) if (!pinnedIds.has(id)) return true;
    return false;
  }, [myFilter, pinnedIds, stats.ids]);

  // Stable identity for the memoised rows (the inline arrow re-created this on
  // every render, which would defeat the memo); the ref keeps it current.
  const resetMyRowImpl = (itemId: string) => {
    if (!profile?.id || !canCount) return;
    void (async () => {
      const ok = await confirm({
        title: "Clear this item's count?",
        body: "Your entered values for this item are deleted. This can't be undone.",
        danger: true,
        confirmLabel: "Clear",
      });
      if (ok && profile?.id) void deleteDraft(profile.id, itemId);
    })();
  };
  const resetMyRowRef = useRef(resetMyRowImpl);
  resetMyRowRef.current = resetMyRowImpl;
  const resetMyRow = useCallback((itemId: string) => resetMyRowRef.current(itemId), []);
  const noopSetField = useCallback(() => {}, []);

  // "How it works" strip — shown until dismissed on this device.
  const [guideHidden, setGuideHidden] = useState<boolean>(() => {
    try { return localStorage.getItem("recon.guideHidden") === "1"; } catch { return false; }
  });
  const hideGuide = () => {
    setGuideHidden(true);
    try { localStorage.setItem("recon.guideHidden", "1"); } catch {}
  };

  // ─── render ────────────────────────────────────────────────────────────
  return (
    <Shell title="Stock count">
      <div className="no-print recon-page">
        <Header
          loaded={loaded}
          totalItems={items.length}
          mode={mode}
          setMode={setMode}
          isAdmin={isAdmin}
          stats={stats}
        />

        <Toolbar
          q={q} setQ={setQ}
          brand={brand} setBrand={setBrand}
          cat={cat} setCat={setCat}
          brands={brands} cats={cats}
          totalItems={items.length}
          myFilter={myFilter} onMyFilter={pickMyFilter}
          counts={{ todo: stats.ids.todo.size, counted: stats.ids.counted.size, differs: stats.ids.differs.size, conflicts: stats.ids.conflicts.size }}
          listStale={listStale}
          shortPcs={stats.myShortPcs} extraPcs={stats.myExtraPcs}
          shownCount={mode === "reviewer" ? reviewerListItems.length : filtered.length}
          mode={mode} isAdmin={isAdmin}
          reviewerStep={reviewerStep}
          usersWithDrafts={stats.usersWithDrafts.size}
          myDone={myDone}
          canCount={canCount}
          onToggleDone={toggleDone}
          doneSaving={doneSaving}
          myStaged={stats.myStaged}
          onClearMine={() => void clearMyCount()}
          onCounters={() => setCountersOpen(true)}
          onPrint={() => window.print()}
          onHistory={() => void openHistory()}
          onCommit={openCommitConfirm}
          // Enabled even with nothing staged: the confirm dialog is the real
          // gate, and a census run ("zero what nobody found") is legitimate
          // with zero drafts — e.g. zeroing leftovers after an earlier commit.
          canCommit={canCommit && !processing}
          processing={processing}
          progress={progress}
        />

        {loaded && !guideHidden && canCount && mode === "my" && (
          <GuideStrip isAdmin={isAdmin} onHide={hideGuide} />
        )}

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

        {mode === "my" && !canCount && (
          <div className="mb-4 flex items-center gap-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-100/70 dark:bg-zinc-900 px-4 py-2.5 text-sm text-zinc-600 dark:text-zinc-300">
            <Eye className="w-4 h-4 flex-shrink-0 text-zinc-400" />
            Your role is view-only — counts are entered by staff and admins. You can watch the live numbers here.
          </div>
        )}

        {/* Reviewer two-step wizard — Step 1 reconcile staff counts, Step 2
            reconcile with system. Step 2 is gated until no staff conflict
            remains. */}
        {mode === "reviewer" && loaded && (
          <ReviewerSteps
            step={reviewerStep}
            setStep={setReviewerStep}
            conflicts={stats.conflicts}
            step2Count={reviewerStep2.differ}
            summary={step2Summary}
          />
        )}

        {!loaded ? (
          <SkeletonBody />
        ) : mode === "my" ? (
          filtered.length === 0 ? (
            <EmptyState
              myFilter={myFilter}
              hasSearch={!!(q || brand || cat)}
              clearFilters={() => { setQ(""); setBrand(""); setCat(""); pickMyFilter("all"); }}
            />
          ) : (
          <MyView
            items={filtered}
            appStock={appStock}
            drafts={drafts}
            lastRecon={lastRecon}
            currentUserId={profile?.id ?? ""}
            // Read-only for viewers too — the drafts RLS rejects their writes,
            // so don't render live inputs that can't save.
            frozen={myDone || !canCount}
            computeDiff={computeDiff}
            setField={canCount ? setField : noopSetField}
            commitRow={commitRow}
            resetMyRow={resetMyRow}
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
          )
        ) : (
          <ReviewerView
            items={reviewerListItems}
            step={reviewerStep}
            totalConflicts={stats.conflicts}
            matchingCount={step2Summary.matching}
            hasActiveFilters={!!(q || brand || cat)}
            clearFilters={() => { setQ(""); setBrand(""); setCat(""); }}
            onGotoStep={setReviewerStep}
            onKeepOnly={keepOnlyCount}
            appStock={appStock}
            draftsByItem={draftsByItem}
            lastRecon={lastRecon}
            computeDiff={computeDiff}
            computeItemConflict={computeItemConflict}
            setField={setField}
            commitRow={commitRow}
            deleteDraft={(uid, iid) => {
              void (async () => {
                const name = peopleRef.current.get(uid) || "this counter";
                const ok = await confirm({
                  title: `Clear ${name}'s count?`,
                  body: "Their saved entries for this item are deleted — they'd have to recount it. This can't be undone.",
                  danger: true,
                  confirmLabel: "Clear count",
                });
                if (ok) void deleteDraft(uid, iid);
              })();
            }}
            currentUserId={profile?.id ?? ""}
            doneByUser={doneByUser}
            people={people}
            onAddCounter={addCounterDraft}
            onApplyItem={commitOne}
            applyingItemId={applyingItemId}
            errorsByItem={errorsByItem(errors)}
          />
        )}

        {/* The "what next" card at the END of the list — on a phone the
            toolbar's Done button has long scrolled away by the time the
            counter reaches the last item. */}
        {loaded && mode === "my" && canCount && filtered.length > 0 && (
          <div className="mt-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 flex flex-wrap items-center gap-3">
            <div className="flex-1 min-w-[200px]">
              <div className="text-sm font-medium">
                {myDone
                  ? "Your count is marked done"
                  : stats.ids.todo.size === 0
                    ? "Every item is counted"
                    : `${fmtN(stats.ids.counted.size)} of ${fmtN(items.length)} items counted · ${fmtN(stats.ids.todo.size)} to go`}
              </div>
              <div className="text-xs text-zinc-500 mt-0.5">
                {myDone
                  ? (isAdmin ? "Open Reviewer to compare the counts and update the stock." : "The admin can now review it. Tap Resume editing if you find more.")
                  : "Finished? Mark your count done so it can be reviewed. Anything you left blank is then read as “none found”."}
              </div>
            </div>
            {!myDone && stats.ids.todo.size > 0 && myFilter !== "todo" && (
              <button type="button" onClick={() => { pickMyFilter("todo"); window.scrollTo({ top: 0 }); document.querySelector("main > div.flex-1")?.scrollTo({ top: 0 }); }}
                className="inline-flex items-center gap-1.5 rounded-md px-3 min-h-10 text-sm border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:border-zinc-300 dark:hover:border-zinc-600">
                <ListChecks className="w-4 h-4" /> Show what&apos;s left
              </button>
            )}
            {myDone && isAdmin ? (
              <button type="button" onClick={() => setMode("reviewer")}
                className="inline-flex items-center gap-1.5 rounded-md px-3.5 min-h-10 text-sm font-medium bg-cyan-500 hover:bg-cyan-400 text-white">
                <ShieldCheck className="w-4 h-4" /> Open Reviewer
              </button>
            ) : (
              <button type="button" onClick={toggleDone} disabled={doneSaving}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-3.5 min-h-10 text-sm font-medium disabled:opacity-60",
                  myDone
                    ? "border border-emerald-500/50 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10"
                    : "bg-emerald-600 hover:bg-emerald-500 text-white"
                )}>
                {doneSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : myDone ? <LockOpen className="w-4 h-4" /> : <CheckCheck className="w-4 h-4" />}
                {myDone ? "Resume editing" : "Mark my count done"}
              </button>
            )}
          </div>
        )}

        <HintCard isAdmin={isAdmin} mode={mode} />

        {/* Count history — the permanent per-counter record of past commits. */}
        {historyOpen && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/50 dark:bg-black/70" role="dialog" aria-modal="true" aria-label="Count history"
            onMouseDown={(e) => { if (e.target === e.currentTarget) setHistoryOpen(false); }}>
            <div className="w-full max-w-2xl max-h-[85vh] flex flex-col bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-xl overflow-hidden">
              <div className="flex items-center gap-2 px-4 sm:px-5 py-3 border-b border-zinc-200 dark:border-zinc-800">
                <History className="w-4 h-4 text-violet-600 dark:text-violet-400 flex-shrink-0" />
                <h2 className="text-base font-semibold flex-1 truncate">Count history</h2>
                {historyRows && historyRows.length > 0 && (
                  <button
                    type="button"
                    onClick={exportHistoryCsv}
                    className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:border-zinc-300 dark:hover:border-zinc-600"
                  >
                    <Download className="w-3.5 h-3.5" /> Export CSV
                  </button>
                )}
                <button type="button" onClick={() => setHistoryOpen(false)} className="min-w-11 min-h-11 -m-2 inline-flex items-center justify-center text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200" aria-label="Close">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="overflow-y-auto p-3 sm:p-4 space-y-3">
                {historyRows === null ? (
                  <div className="py-10 text-center text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading…</div>
                ) : historyRows.length === 0 ? (
                  <div className="py-10 text-center text-sm text-zinc-500 px-6">
                    No counts logged yet. Every counter&apos;s entries are saved here automatically whenever a staff member <strong>marks their count done</strong> (requires <code className="px-1 bg-zinc-100 dark:bg-zinc-800 rounded">db/2026-06-26-staff-done-snapshots.sql</code>), and each time you run <strong>Make adjustments</strong> or <strong>Apply this count</strong> (requires <code className="px-1 bg-zinc-100 dark:bg-zinc-800 rounded">db/2026-06-10-count-log.sql</code>).
                  </div>
                ) : (
                  historyBatches.map(b => {
                    const itemKeys = new Set(b.rows.map(r => r.item_id || r.item_code || ""));
                    const counters = new Set(b.rows.map(r => r.user_id));
                    const byItem = new Map<string, CountLogRow[]>();
                    for (const r of b.rows) {
                      const k = r.item_id || r.item_code || "?";
                      if (!byItem.has(k)) byItem.set(k, []);
                      byItem.get(k)!.push(r);
                    }
                    return (
                      <div key={b.key} className="border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden">
                        <div className="px-3 py-2 bg-zinc-50 dark:bg-zinc-900/50 flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="text-[13px] font-medium">{b.note}</span>
                          <span className={cn(
                            "text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded font-medium",
                            b.kind === "bulk" ? "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300"
                              : b.kind === "done" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                              : "bg-violet-500/15 text-violet-700 dark:text-violet-300"
                          )}>
                            {b.kind === "bulk" ? "Make adjustments" : b.kind === "done" ? "Marked done" : "Apply one"}
                          </span>
                          <span className="text-[11px] text-zinc-500">{new Date(b.at).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                          <span className="ml-auto text-[11px] text-zinc-500 tabular-nums">{itemKeys.size} item{itemKeys.size === 1 ? "" : "s"} · {counters.size} counter{counters.size === 1 ? "" : "s"}</span>
                        </div>
                        <div className="divide-y divide-zinc-200/60 dark:divide-zinc-800/60">
                          {[...byItem.values()].map((rows, gi) => {
                            const f = rows[0];
                            return (
                              <div key={gi} className="px-3 py-2">
                                <div className="text-[12px] font-medium truncate">
                                  {[f.brand, f.model, f.size, f.colour].filter(Boolean).join(" · ")}
                                  <span className="text-zinc-400 font-normal"> · cs {f.case_size}</span>
                                </div>
                                <div className="mt-1 space-y-0.5">
                                  {rows.map(r => (
                                    <div key={r.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] tabular-nums">
                                      <span className="w-28 truncate text-zinc-700 dark:text-zinc-200">{r.user_name || "—"}</span>
                                      <span className={cn(r.a_pieces === null && "text-zinc-400")}>
                                        A {r.a_pieces === null ? "not counted" : `${fmtN(r.a_pieces)} pcs (${r.a_cases_raw || "0"}c + ${r.a_loose_raw || "0"}L)`}
                                      </span>
                                      <span className={cn(r.b_pieces === null && "text-zinc-400")}>
                                        B {r.b_pieces === null ? "not counted" : `${fmtN(r.b_pieces)} pcs (${r.b_cases_raw || "0"}c + ${r.b_loose_raw || "0"}L)`}
                                      </span>
                                      {r.case_size_raw.trim() !== "" && <span className="text-amber-600 dark:text-amber-400">cs→{r.case_size_raw}</span>}
                                      {/* In an Apply-one batch, mark whose count won. */}
                                      {b.kind === "single" && r.applied && (
                                        <span className="px-1 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-[9px] uppercase tracking-wide font-medium">applied</span>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        )}

        {/* Counters panel (admin) — everyone's progress, with a per-counter
            "Clear all" that wipes that counter's whole count. The confirm
            dialog (z-[70]) layers above this modal (z-50). */}
        {countersOpen && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/50 dark:bg-black/70" role="dialog" aria-modal="true" aria-label="Counters"
            onMouseDown={(e) => { if (e.target === e.currentTarget) setCountersOpen(false); }}>
            <div className="w-full max-w-md max-h-[85vh] flex flex-col bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-xl overflow-hidden">
              <div className="flex items-center gap-2 px-4 sm:px-5 py-3 border-b border-zinc-200 dark:border-zinc-800">
                <Users className="w-4 h-4 text-violet-600 dark:text-violet-400 flex-shrink-0" />
                <h2 className="text-base font-semibold flex-1 truncate">Counters</h2>
                <button type="button" onClick={() => setCountersOpen(false)} className="min-w-11 min-h-11 -m-2 inline-flex items-center justify-center text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200" aria-label="Close">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 sm:p-5">
                {counterSummary.length === 0 ? (
                  <div className="py-8 text-center text-sm text-zinc-500">Nobody has entered a count yet.</div>
                ) : (
                  <>
                    <p className="text-xs text-zinc-500 mb-3">
                      Everyone with saved entries this cycle. <strong>Clear all</strong> deletes that counter&apos;s entries on every item so they can start fresh — their past &ldquo;marked done&rdquo; snapshots and committed history stay in Count history.
                    </p>
                    <ul className="space-y-2">
                      {counterSummary.map(c => (
                        <li key={c.id} className="flex items-center gap-3 rounded-lg border border-zinc-200 dark:border-zinc-800 px-3.5 py-2.5">
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium truncate">
                              {c.name}{c.id === profile?.id && <span className="text-zinc-400 font-normal"> (you)</span>}
                            </div>
                            <div className="text-xs text-zinc-500 flex items-center gap-2 tabular-nums">
                              {fmtN(c.items)} item{c.items === 1 ? "" : "s"} entered
                              {c.done && (
                                <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                                  <Lock className="w-3 h-3" /> done
                                </span>
                              )}
                            </div>
                          </div>
                          <button
                            type="button"
                            disabled={clearingUid !== null || processing || applyingItemId !== null}
                            onClick={() => void clearCounterAll(c.id, c.name, c.items)}
                            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium border border-rose-300/60 dark:border-rose-500/30 text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 hover:border-rose-400 disabled:opacity-40 flex-shrink-0"
                            title={`Delete every entry ${c.id === profile?.id ? "you have" : `${c.name} has`} made`}
                          >
                            {clearingUid === c.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eraser className="w-3.5 h-3.5" />}
                            Clear all
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Pre-commit confirmation — nothing writes until Commit is tapped. */}
        {commitConfirm && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/50 dark:bg-black/70" role="dialog" aria-modal="true" aria-label="Confirm make adjustments">
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
                {commitConfirm.invalid > 0 && (
                  <div className="flex justify-between gap-3 text-rose-600 dark:text-rose-400">
                    <span>Skipped — entries that aren&apos;t valid numbers</span>
                    <span className="font-semibold">{fmtN(commitConfirm.invalid)}</span>
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
                      {" "}<strong>Applies to ALL items — any filters on the list are ignored.</strong>
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
                  className="flex-1 min-h-11 rounded-md border border-zinc-200 dark:border-zinc-700 text-sm font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800"
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
                  className="flex-1 min-h-11 rounded-md bg-cyan-500 hover:bg-cyan-400 text-white text-sm font-medium inline-flex items-center justify-center gap-1.5"
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

      {confirmDialog}
      <PrintSheet items={filtered} activeFilters={[
        q && `search “${q}”`,
        brand && `brand ${brand}`,
        cat && `category ${cat}`,
        mode === "my" && myFilter !== "all" && ({ todo: "not counted yet", counted: "counted", differs: "differs from system", conflicts: "conflicts" } as const)[myFilter],
      ].filter(Boolean) as string[]} />
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
  loaded, totalItems, mode, setMode, isAdmin, stats,
}: {
  loaded: boolean;
  totalItems: number;
  mode: "my" | "reviewer";
  setMode: (m: "my" | "reviewer") => void;
  isAdmin: boolean;
  stats: { myStaged: number; anyStaged: number; conflicts: number; invalid: number; usersWithDrafts: Set<string> };
}) {
  const conflicts = stats.conflicts;
  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mb-1.5">
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Stock count</h1>
        {isAdmin ? (
          <div className="inline-flex bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md overflow-hidden">
            <button
              type="button"
              onClick={() => setMode("my")}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 min-h-9 text-sm",
                mode === "my"
                  ? "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 font-medium"
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
                "inline-flex items-center gap-1.5 px-3 py-1.5 min-h-9 text-sm border-l border-zinc-200 dark:border-zinc-800",
                mode === "reviewer"
                  ? "bg-violet-500/15 text-violet-700 dark:text-violet-300 font-medium"
                  : "text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
              )}
              aria-pressed={mode === "reviewer"}
              title="Compare everyone's counts, then update the stock"
            >
              <ShieldCheck className="w-3.5 h-3.5" /> Reviewer
              {conflicts > 0 && (
                <span className="px-1.5 rounded-full bg-rose-500 text-white text-[10px] font-semibold tabular-nums">{conflicts}</span>
              )}
            </button>
          </div>
        ) : (
          <span className="px-2 py-0.5 rounded text-[10px] uppercase tracking-wider font-medium bg-cyan-500/15 text-cyan-700 dark:text-cyan-300">My count</span>
        )}
      </div>
      <p className="text-sm text-zinc-500 tabular-nums">
        {!loaded ? "Loading…" : mode === "my" ? (
          <>
            <span className="hidden sm:inline">Count what is physically on the shelf — the system's number is shown beside every box.</span>
            <span className="sm:hidden">Type what you find on the shelf.</span>
            {stats.invalid > 0 && (
              <> · <span className="text-rose-600 dark:text-rose-400 font-medium" title="an entry isn't a valid number yet">{fmtN(stats.invalid)} need{stats.invalid === 1 ? "s" : ""} fixing</span></>
            )}
          </>
        ) : (
          <>
            {fmtN(totalItems)} items ·{" "}
            <span className={stats.anyStaged ? "text-amber-600 dark:text-amber-400 font-medium" : ""}>
              {fmtN(stats.anyStaged)} counted by {stats.usersWithDrafts.size} {stats.usersWithDrafts.size === 1 ? "person" : "people"}
            </span>
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
// One My-count filter chip. `count` updates live; the LIST only changes when
// a chip is tapped (see the snapshot note beside `pinnedIds`).
function FilterChip({
  label, count, active, tone = "zinc", onClick,
}: {
  label: string; count: number; active: boolean;
  tone?: "zinc" | "emerald" | "amber" | "rose";
  onClick: () => void;
}) {
  const on = {
    zinc: "bg-cyan-500/15 border-cyan-500/50 text-cyan-700 dark:text-cyan-300",
    emerald: "bg-emerald-500/15 border-emerald-500/50 text-emerald-700 dark:text-emerald-300",
    amber: "bg-amber-500/15 border-amber-500/50 text-amber-700 dark:text-amber-300",
    rose: "bg-rose-500/15 border-rose-500/50 text-rose-700 dark:text-rose-300",
  }[tone];
  const dot = { zinc: "bg-zinc-400", emerald: "bg-emerald-500", amber: "bg-amber-500", rose: "bg-rose-500" }[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex-shrink-0 inline-flex items-center gap-1.5 rounded-full border px-3 min-h-9 text-[13px] transition-colors whitespace-nowrap",
        active
          ? on + " font-medium"
          : "bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:border-zinc-300 dark:hover:border-zinc-700"
      )}
    >
      <span className={cn("w-1.5 h-1.5 rounded-full", dot)} />
      {label}
      <span className="tabular-nums font-semibold">{fmtN(count)}</span>
    </button>
  );
}

function Toolbar({
  q, setQ, brand, setBrand, cat, setCat,
  brands, cats, shownCount,
  mode, isAdmin, reviewerStep, usersWithDrafts,
  myDone, canCount, onToggleDone, doneSaving,
  myStaged, onClearMine, onCounters,
  onPrint, onHistory, onCommit, canCommit, processing, progress,
  totalItems, myFilter, onMyFilter, counts, listStale, shortPcs, extraPcs,
}: {
  q: string; setQ: (s: string) => void;
  brand: string; setBrand: (s: string) => void;
  cat: string; setCat: (s: string) => void;
  brands: string[]; cats: string[]; shownCount: number;
  mode: "my" | "reviewer";
  isAdmin: boolean; reviewerStep: 1 | 2; usersWithDrafts: number;
  myDone: boolean; canCount: boolean; onToggleDone: () => void; doneSaving: boolean;
  myStaged: number; onClearMine: () => void; onCounters: () => void;
  onPrint: () => void; onHistory: () => void; onCommit: () => void;
  canCommit: boolean; processing: boolean;
  progress: { done: number; total: number };
  totalItems: number;
  myFilter: MyFilter; onMyFilter: (f: MyFilter) => void;
  counts: { todo: number; counted: number; differs: number; conflicts: number };
  listStale: boolean; shortPcs: number; extraPcs: number;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const pct = totalItems > 0 ? Math.round((counts.counted / totalItems) * 100) : 0;

  const plainBtn = "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 min-h-9 text-sm bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-200 hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors";
  const showClear = mode === "my" && canCount && !myDone && myStaged > 0;
  const countersLabel = `${usersWithDrafts} ${usersWithDrafts === 1 ? "person" : "people"} counting`;

  // Secondary actions: inline on desktop, tucked behind "More" on phones so
  // the count list starts higher up the screen.
  const secondary: { key: string; label: string; icon: typeof Printer; onClick: () => void; show: boolean; danger?: boolean; title?: string }[] = [
    { key: "clear", label: "Clear all", icon: Eraser, onClick: onClearMine, show: showClear, danger: true, title: "Delete all your entered counts and start fresh" },
    { key: "counters", label: countersLabel, icon: Users, onClick: onCounters, show: isAdmin, title: "Every counter's progress — view or clear a counter's entries" },
    { key: "print", label: "Print count sheet", icon: Printer, onClick: onPrint, show: true, title: "Print a blank count sheet for a paper stock-take" },
    { key: "history", label: "Count history", icon: History, onClick: onHistory, show: isAdmin, title: "Every counter's saved entries from past counts" },
  ];

  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      {/* My count: freeze/unfreeze my entries. Marking done turns any item I
          leave blank but a teammate filled into a flagged conflict.
          Hidden for viewers — they can't count, so a done flag from them
          would only turn other counters' items into false conflicts. */}
      {mode === "my" && canCount && (
        <button
          type="button"
          onClick={onToggleDone}
          disabled={doneSaving}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 min-h-9 text-sm border transition-colors disabled:opacity-60",
            myDone
              ? "bg-emerald-500/15 border-emerald-500/50 text-emerald-700 dark:text-emerald-300"
              : "bg-white dark:bg-zinc-900 border-emerald-500/50 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10"
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

      {/* Staff see how many people are counting (admins get the same number
          as a button that opens the Counters panel, in `secondary`). */}
      {!isAdmin && (
        <div className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500 px-2 py-1.5 rounded-md bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-800">
          <Users className="w-3 h-3" />
          {countersLabel}
        </div>
      )}

      {/* Desktop: secondary actions inline */}
      {secondary.filter(a => a.show).map(a => (
        <button key={a.key} type="button" onClick={a.onClick} title={a.title}
          className={cn(plainBtn, "hidden md:inline-flex", a.danger && "hover:border-rose-400 hover:text-rose-600 dark:hover:border-rose-500/40 dark:hover:text-rose-400")}>
          <a.icon className="w-3.5 h-3.5" /> {a.label}
        </button>
      ))}

      {/* Phone: the same actions behind one "More" button */}
      <div className="relative md:hidden">
        <button type="button" onClick={() => setMoreOpen(o => !o)} aria-expanded={moreOpen} aria-haspopup="menu" className={plainBtn}>
          More <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", moreOpen && "rotate-180")} />
        </button>
        {moreOpen && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setMoreOpen(false)} aria-hidden="true" />
            <div role="menu" className="absolute left-0 top-full mt-1 z-40 min-w-[220px] rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-lg p-1">
              {secondary.filter(a => a.show).map(a => (
                <button key={a.key} type="button" role="menuitem"
                  onClick={() => { setMoreOpen(false); a.onClick(); }}
                  className={cn("w-full flex items-center gap-2.5 rounded-lg px-3 min-h-11 text-sm text-left text-zinc-700 dark:text-zinc-200 active:bg-zinc-100 dark:active:bg-zinc-800", a.danger && "text-rose-600 dark:text-rose-400")}>
                  <a.icon className="w-4 h-4 flex-shrink-0" /> {a.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="flex-1 min-w-0" />

      {/* "Make adjustments" pushes counts to system stock — a Step 2 action.
          In Reviewer it only appears on Step 2 (after staff are reconciled);
          in My count an admin can still commit their own count as before. */}
      {isAdmin && (mode === "my" || reviewerStep === 2) && (
        <button
          type="button"
          onClick={onCommit}
          disabled={!canCommit}
          title="Update the system stock to match the counts"
          className="inline-flex items-center gap-2 rounded-md px-3.5 py-1.5 min-h-9 text-sm font-medium bg-cyan-500 hover:bg-cyan-400 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {processing
            ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> {progress.done}/{progress.total}…</>
            : <><CheckCircle2 className="w-3.5 h-3.5" /> Make adjustments</>
          }
        </button>
      )}
    </div>
  );

  return (
    <>
      {/* Phone: the action buttons scroll away with the page so only the
          search + chips stay pinned (the old 5-row sticky toolbar covered a
          third of the screen while counting). */}
      <div className="md:hidden mb-2.5">{actions}</div>

      {/* Sticky so search + filters stay reachable while scrolling the long
          item list. Negative margins let the background span the full content
          width; px puts the padding back. */}
      <div className="space-y-2 mb-4 sticky top-0 z-20 -mx-4 sm:-mx-6 md:-mx-8 px-4 sm:px-6 md:px-8 pt-1 pb-2.5 bg-zinc-50 dark:bg-zinc-950 border-b border-zinc-200/70 dark:border-zinc-800/70">
        <div className="flex flex-wrap gap-2 items-center">
          <SearchBox
            value={q}
            onChange={setQ}
            placeholder="Search — brand, model, colour, size…"
            className="flex-1 min-w-[180px]"
          />

          {/* Mobile: filters live in a sheet */}
          <FilterButton activeCount={(brand ? 1 : 0) + (cat ? 1 : 0)} onClick={() => setFiltersOpen(true)} />

          {/* Desktop: inline filters */}
          <div className="hidden md:flex md:items-center md:gap-2">
            <select value={brand} onChange={(e) => setBrand(e.target.value)} aria-label="Filter by brand"
              className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:border-cyan-500">
              <option value="">All brands</option>
              {brands.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
            <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Filter by category"
              className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:border-cyan-500">
              <option value="">All categories</option>
              {cats.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <span className="text-xs text-zinc-500 self-center tabular-nums ml-auto md:ml-0">{fmtN(shownCount)} shown</span>
        </div>

        {/* My count: progress + one-tap filters */}
        {mode === "my" && (
          <>
            <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar -mx-4 px-4 sm:-mx-6 sm:px-6 md:mx-0 md:px-0">
              <FilterChip label="All" count={totalItems} active={myFilter === "all"} onClick={() => onMyFilter("all")} />
              <FilterChip label="To count" count={counts.todo} active={myFilter === "todo"} onClick={() => onMyFilter("todo")} />
              <FilterChip label="Counted" count={counts.counted} active={myFilter === "counted"} tone="emerald" onClick={() => onMyFilter("counted")} />
              <FilterChip label="Differs from system" count={counts.differs} active={myFilter === "differs"} tone="amber" onClick={() => onMyFilter("differs")} />
              {(counts.conflicts > 0 || myFilter === "conflicts") && (
                <FilterChip label="Conflicts" count={counts.conflicts} active={myFilter === "conflicts"} tone="rose" onClick={() => onMyFilter("conflicts")} />
              )}
              {listStale && (
                <button type="button" onClick={() => onMyFilter(myFilter)}
                  className="flex-shrink-0 inline-flex items-center gap-1 px-2 min-h-9 text-xs text-cyan-600 dark:text-cyan-400 hover:underline whitespace-nowrap"
                  title="Your entries changed which items belong in this list">
                  <RotateCcw className="w-3 h-3" /> Refresh list
                </button>
              )}
            </div>
            <div className="flex items-center gap-3">
              <div className="flex-1 h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={totalItems} aria-valuenow={counts.counted} aria-label="Items counted">
                <div className="h-full rounded-full bg-emerald-500 transition-[width] duration-300" style={{ width: `${pct}%` }} />
              </div>
              <span className="text-[11px] text-zinc-500 tabular-nums whitespace-nowrap">
                <span className="font-semibold text-zinc-700 dark:text-zinc-200">{fmtN(counts.counted)} of {fmtN(totalItems)}</span> counted
                {(shortPcs > 0 || extraPcs > 0) && (
                  <span className="hidden sm:inline">
                    {" · "}
                    {shortPcs > 0 && <span className="text-rose-600 dark:text-rose-400">{fmtN(shortPcs)} pcs short</span>}
                    {shortPcs > 0 && extraPcs > 0 && ", "}
                    {extraPcs > 0 && <span className="text-amber-600 dark:text-amber-400">{fmtN(extraPcs)} pcs extra</span>}
                  </span>
                )}
              </span>
            </div>
          </>
        )}

        {/* Desktop: actions stay pinned with the filters */}
        <div className="hidden md:block">{actions}</div>
      </div>

      {/* Mobile filters sheet */}
      <FilterSheet
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        onClear={() => { setBrand(""); setCat(""); }}
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
      </FilterSheet>
    </>
  );
}

// ─── reviewer two-step wizard header ──────────────────────────────────────
// Step 1 = reconcile disagreements between staff; Step 2 = reconcile the agreed
// count against system stock. Step 2 is locked until no staff conflict remains.
function StepNum({ n, active, done, locked }: { n: number; active: boolean; done?: boolean; locked?: boolean }) {
  return (
    <span className={cn(
      "flex-shrink-0 w-6 h-6 rounded-full inline-flex items-center justify-center text-[12px] font-semibold tabular-nums",
      locked
        ? "bg-zinc-200 dark:bg-zinc-800 text-zinc-400"
        : done
          ? "bg-emerald-500 text-white"
          : active
            ? "bg-violet-600 text-white"
            : "bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-200"
    )}>
      {n}
    </span>
  );
}

function ReviewerSteps({
  step, setStep, conflicts, step2Count, summary,
}: {
  step: 1 | 2;
  setStep: (s: 1 | 2) => void;
  conflicts: number;
  step2Count: number;
  summary: { matching: number; shortPcs: number; extraPcs: number };
}) {
  const step2Locked = conflicts > 0;
  return (
    <div className="mb-4 space-y-2">
      <div className="flex items-stretch gap-2">
        {/* Step 1 — reconcile staff counts */}
        <button
          type="button"
          onClick={() => setStep(1)}
          className={cn(
            "flex-1 text-left rounded-lg border px-3 py-2.5 transition-colors",
            step === 1
              ? "border-violet-500/60 bg-violet-500/10"
              : "border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:border-zinc-300 dark:hover:border-zinc-700"
          )}
          aria-current={step === 1 ? "step" : undefined}
        >
          <div className="flex items-center gap-2">
            <StepNum n={1} active={step === 1} done={conflicts === 0} />
            <div className="min-w-0">
              <div className="text-sm font-medium">Reconcile staff counts</div>
              <div className="text-[11px] text-zinc-500">
                {conflicts > 0
                  ? `${fmtN(conflicts)} item${conflicts === 1 ? "" : "s"} where staff disagree`
                  : "All staff agree"}
              </div>
            </div>
            {conflicts > 0 ? (
              <span className="ml-auto px-1.5 rounded-full bg-rose-500 text-white text-[10px] font-semibold tabular-nums flex-shrink-0">{conflicts}</span>
            ) : (
              <CheckCircle2 className="ml-auto w-4 h-4 text-emerald-500 flex-shrink-0" />
            )}
          </div>
        </button>

        {/* Step 2 — reconcile with system */}
        <button
          type="button"
          onClick={() => { if (!step2Locked) setStep(2); }}
          disabled={step2Locked}
          className={cn(
            "flex-1 text-left rounded-lg border px-3 py-2.5 transition-colors",
            step2Locked
              ? "border-zinc-200 dark:border-zinc-800 bg-zinc-100/60 dark:bg-zinc-900/50 cursor-not-allowed opacity-70"
              : step === 2
                ? "border-violet-500/60 bg-violet-500/10"
                : "border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:border-zinc-300 dark:hover:border-zinc-700"
          )}
          aria-current={step === 2 ? "step" : undefined}
          title={step2Locked ? "Resolve all staff conflicts first" : "Compare the agreed count with system stock"}
        >
          <div className="flex items-center gap-2">
            <StepNum n={2} active={step === 2} locked={step2Locked} />
            <div className="min-w-0">
              <div className="text-sm font-medium flex items-center gap-1.5">
                Reconcile with system {step2Locked && <Lock className="w-3 h-3 text-zinc-400" />}
              </div>
              <div className="text-[11px] text-zinc-500">
                {step2Locked
                  ? "Locked until staff agree"
                  : step2Count > 0
                    ? `${fmtN(step2Count)} differ${step2Count === 1 ? "s" : ""} from system${summary.matching > 0 ? ` · ${fmtN(summary.matching)} match` : ""}`
                    : summary.matching > 0 ? `All ${fmtN(summary.matching)} counted match the system` : "Counts match the system"}
              </div>
            </div>
            {!step2Locked && step2Count > 0 && (
              <span className="ml-auto px-1.5 rounded-full bg-violet-500 text-white text-[10px] font-semibold tabular-nums flex-shrink-0">{step2Count}</span>
            )}
          </div>
        </button>
      </div>

      {/* Contextual nudge between the steps. */}
      {step === 1 && conflicts === 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2.5">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
          <div className="text-sm text-emerald-800 dark:text-emerald-200 flex-1 min-w-0">
            <span className="font-medium">No staff disagreements.</span>{" "}
            <span className="text-emerald-700/80 dark:text-emerald-300/70">Move on to compare the agreed counts against the system.</span>
          </div>
          <button
            type="button"
            onClick={() => setStep(2)}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium bg-cyan-500 hover:bg-cyan-400 text-white flex-shrink-0"
          >
            Continue to Step 2 →
          </button>
        </div>
      )}
      {/* Step 2 summary — the whole stock-take result in one line. */}
      {step === 2 && conflicts === 0 && (step2Count > 0 || summary.matching > 0) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-2.5 text-sm tabular-nums">
          <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="w-4 h-4" /> <strong>{fmtN(summary.matching)}</strong> match the system
          </span>
          <span className={cn("inline-flex items-center gap-1.5", step2Count > 0 ? "text-amber-700 dark:text-amber-300" : "text-zinc-500")}>
            <AlertTriangle className="w-4 h-4" /> <strong>{fmtN(step2Count)}</strong> differ
          </span>
          {summary.shortPcs > 0 && <span className="text-rose-600 dark:text-rose-400"><strong>{fmtN(summary.shortPcs)}</strong> pcs short</span>}
          {summary.extraPcs > 0 && <span className="text-amber-600 dark:text-amber-400"><strong>{fmtN(summary.extraPcs)}</strong> pcs extra</span>}
          <span className="text-xs text-zinc-500 basis-full sm:basis-auto sm:ml-auto">Make adjustments updates the stock and closes this count.</span>
        </div>
      )}
      {/* No "on Step 2 with conflicts" banner needed — the page clamps the step
          back to 1 whenever a staff conflict exists, so Step 2 can't be shown
          while unresolved. */}
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
// Each item is a memoised <MyItem>: a keystroke re-renders only the row being
// typed in, not all ~170 rows (which made typing lag on slower phones).
function MyView(props: MyViewProps) {
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const { items, appStock, drafts, lastRecon, currentUserId, errorsByItem, otherUsersByItem, conflictByItem } = props;
  // A heading row each time the category changes (the list is in tree
  // order), so the counter can walk the godown shelf by shelf.
  let lastCat: string | null | undefined = undefined;
  const rows = items.flatMap(i => {
    const app = appStock.get(i.id);
    if (!app) return [];
    const out: React.ReactNode[] = [];
    if (i.categoryName !== lastCat) {
      lastCat = i.categoryName;
      const segs = (i.categoryName || "No category").split(" › ");
      const label = (
        <span className="flex items-center gap-1.5 min-w-0 text-[12px]">
          <Folder className="w-3.5 h-3.5 text-cyan-500/80 flex-shrink-0" />
          <span className="truncate text-zinc-500">
            {segs.slice(0, -1).map(x => x + " › ")}<b className="font-semibold text-zinc-800 dark:text-zinc-200">{segs[segs.length - 1]}</b>
          </span>
        </span>
      );
      out.push(isDesktop
        ? <tr key={`h-${i.id}`} className="bg-zinc-50 dark:bg-zinc-900/60 border-t border-zinc-200 dark:border-zinc-800"><td colSpan={5} className="px-3 py-1.5">{label}</td></tr>
        : <div key={`h-${i.id}`} className="pt-2 px-1">{label}</div>);
    }
    out.push(
      <MyItem
        key={i.id}
        desktop={isDesktop}
        i={i}
        app={app}
        d={drafts.get(dkey(currentUserId, i.id))}
        others={otherUsersByItem(i.id)}
        conflict={conflictByItem(i.id)}
        last={lastRecon.get(i.id)}
        frozen={props.frozen}
        doneByUser={props.doneByUser}
        currentUserId={currentUserId}
        computeDiff={props.computeDiff}
        setField={props.setField}
        commitRow={props.commitRow}
        resetMyRow={props.resetMyRow}
        errors={errorsByItem.get(i.id)}
      />
    );
    return out;
  });
  if (!isDesktop) return <div className="space-y-3">{rows}</div>;
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
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
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

// Status rail colour shared by every card/row so state reads at a glance:
// rose = needs fixing · amber = counted, differs from system · emerald =
// counted, matches · violet = a teammate has counted it · grey = not counted.
function statusRail(rd: RowDiffType, conflict: ItemConflictType | null, others: number): string {
  if (rd.invalid || conflict?.any) return "border-l-rose-500";
  if (rd.A.diff !== 0 || rd.B.diff !== 0 || rd.caseSizeChanged) return "border-l-amber-500";
  if (rd.hasAnyChange) return "border-l-emerald-500";
  if (others > 0) return "border-l-cyan-500";
  return "border-l-zinc-200 dark:border-l-zinc-800";
}

// The item's state in words (colour alone isn't enough).
function StatusChip({ rd, conflict }: { rd: RowDiffType; conflict: ItemConflictType | null }) {
  const base = "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide font-medium whitespace-nowrap";
  if (rd.invalid) return <span className={cn(base, "bg-rose-500/15 text-rose-700 dark:text-rose-300")}><AlertCircle className="w-3 h-3" /> Fix entry</span>;
  if (conflict?.any) return <span className={cn(base, "bg-rose-500/15 text-rose-700 dark:text-rose-300")}><AlertTriangle className="w-3 h-3" /> Conflict</span>;
  if (!rd.hasAnyChange) return null;
  if (rd.A.diff !== 0 || rd.B.diff !== 0) return <span className={cn(base, "bg-amber-500/15 text-amber-700 dark:text-amber-300")}>Differs from system</span>;
  if (rd.caseSizeChanged && !rd.A.userTouched && !rd.B.userTouched) return <span className={cn(base, "bg-amber-500/15 text-amber-700 dark:text-amber-300")}>Case size changed</span>;
  return <span className={cn(base, "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300")}><CheckCircle2 className="w-3 h-3" /> Matches system</span>;
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
  onCases, onLoose, onBlur, onSame, stepper, compact, frozen, peers, ariaPrefix,
}: {
  g: Godown;
  appSide: AppStock;
  side: RowDiffType["A"];
  csOld: number; csNew: number;
  cRaw: string; lRaw: string;
  onCases: (v: string) => void; onLoose: (v: string) => void; onBlur: () => void;
  // One tap = "what's on the shelf is exactly what the system says".
  onSame?: () => void;
  stepper: boolean; compact: boolean; frozen: boolean;
  peers: { name: string; pcs: number; delta: number | null; done: boolean }[];
  ariaPrefix: string;
}) {
  const touched = side.userTouched;
  // A = brand violet (`cyan-*` is remapped to it), B = teal — the two godowns
  // used to wear two near-identical violets and were easy to mix up.
  const rail = g === "A" ? "border-l-cyan-500/70" : "border-l-teal-500/80";
  const head = g === "A" ? "text-cyan-700 dark:text-cyan-300" : "text-teal-700 dark:text-teal-300";
  const tone: "neutral" | "amber" | "rose" = touched ? (side.valid ? "amber" : "rose") : "neutral";
  // One box filled, sibling blank on a counted godown → make the implied 0 explicit.
  const onlyCases = cRaw.trim() !== "" && lRaw.trim() === "";
  const onlyLoose = lRaw.trim() !== "" && cRaw.trim() === "";
  // The diff (and the commit) compare at the NEW case size — show the system
  // reference re-based the same way, so "System · You · Diff" always reconciles
  // visually when the counter edited the case size.
  const csEdited = csNew !== csOld;
  const sysPcs = csEdited ? pieces(csNew, appSide.cases, appSide.loose) : side.appPieces;
  // No case size (0) → the item counts loose-only; a Cases entry would be
  // ignored by the maths, so don't offer the box (existing text stays
  // editable so it can be cleared).
  const casesDisabled = frozen || (csNew <= 0 && cRaw.trim() === "");
  // "Same as system" needs whole, non-negative system numbers it can type in.
  const canSame = !!onSame && !frozen && !touched
    && appSide.cases >= 0 && appSide.loose >= 0 && (csNew > 0 || appSide.cases === 0);
  const sameBtn = canSame && (
    <button
      type="button"
      onClick={onSame}
      aria-label={`${ariaPrefix} godown ${g}: same as system`}
      className={cn(
        "inline-flex items-center gap-1.5 text-zinc-600 dark:text-zinc-300 transition-colors",
        compact
          ? "text-[12px] rounded-md px-1.5 py-0.5 -mr-1 hover:text-emerald-700 dark:hover:text-emerald-300 hover:bg-emerald-500/10"
          : "w-full justify-center min-h-10 rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 text-[13px] active:bg-emerald-500/10 active:border-emerald-500/60"
      )}
    >
      <Equal className={compact ? "w-3.5 h-3.5" : "w-4 h-4"} /> Same as system
    </button>
  );
  const casesInput = (
    <ExprInput value={cRaw} onChange={onCases} onBlur={onBlur} stepper={stepper && !casesDisabled} compact={compact} disabled={casesDisabled}
      tone={tone} ariaLabel={`${ariaPrefix} godown ${g} cases`} />
  );
  const looseInput = (
    <ExprInput value={lRaw} onChange={onLoose} onBlur={onBlur} stepper={stepper} compact={compact} disabled={frozen}
      tone={tone} ariaLabel={`${ariaPrefix} godown ${g} loose`} />
  );
  // 2026-11-16 redesign: the SYSTEM numbers sit right beside / above the box
  // you type in — cases next to cases, loose next to loose, pieces next to
  // pieces — so a counter compares at a glance instead of reading a grey
  // header line. (The count boxes themselves never pre-fill with system
  // numbers: "Same as system" is the deliberate one-tap way to do that.)
  const noCases = csNew <= 0;
  const sysCases = noCases ? "—" : fmtN(appSide.cases);
  const sysLoose = fmtN(noCases ? sysPcs : appSide.loose);
  const youPcs = touched && side.valid ? fmtN(side.physPieces) : "—";
  const sysNum = "tabular-nums font-semibold text-zinc-800 dark:text-zinc-100";
  const lbl = "text-[11px] text-zinc-500";
  const header = (
    <div className="flex items-center justify-between gap-2 mb-2 min-h-6">
      <span className={cn("text-[11px] font-semibold uppercase tracking-wider flex-shrink-0", head)}>Godown {g}</span>
      {touched && side.valid ? <DiffPill diff={side.diff} /> : compact ? sameBtn : null}
    </div>
  );
  const extras = (
    <>
      {touched && !side.valid && (
        <div className="text-[11px] text-rose-600 dark:text-rose-400">Numbers only — for example 5, or 5+1 to add as you find more.</div>
      )}
      {!touched && frozen && <div className="text-[11px] italic text-zinc-400">not counted</div>}
      {touched && side.valid && (onlyCases || onlyLoose) && (
        <div className="text-[10px] text-zinc-500">{onlyCases ? "loose: 0 — none counted" : "cases: 0 — none counted"}</div>
      )}
      {noCases && !frozen && cRaw.trim() === "" && <div className="text-[10px] text-amber-600 dark:text-amber-400">No case size — count every piece in Loose</div>}
      {csEdited && <div className="text-[10px] text-amber-600 dark:text-amber-400">New case size — system was {fmtN(side.appPieces)} pcs</div>}
      {peers.map((p, idx) => <PeerLine key={idx} {...p} />)}
    </>
  );
  const hasExtras = (touched && (!side.valid || onlyCases || onlyLoose)) || (!touched && frozen) || csEdited || peers.length > 0 || (noCases && !frozen && cRaw.trim() === "");

  if (compact) {
    // Computer: a 3-column mini table. Row 1 = system, row 2 = your boxes.
    return (
      <div className={cn("rounded-xl border-l-4 bg-zinc-50/70 dark:bg-zinc-800/40 p-2.5", rail)}>
        {header}
        <div className="grid grid-cols-[50px_1fr_1fr_44px] items-center gap-x-1.5 gap-y-1">
          <span />
          <span className={cn(lbl, "text-center")}>Cases</span>
          <span className={cn(lbl, "text-center")}>Loose</span>
          <span className={cn(lbl, "text-right")}>Pcs</span>

          <span className={lbl}>System</span>
          <span className={cn(sysNum, "text-center text-[14px]")}>{sysCases}</span>
          <span className={cn(sysNum, "text-center text-[14px]")}>{sysLoose}</span>
          <span className={cn(sysNum, "text-right text-[14px]")}>{fmtN(sysPcs)}</span>

          <span className={cn(lbl, "font-medium text-zinc-700 dark:text-zinc-300")}>You</span>
          <span className="min-w-0">{casesInput}</span>
          <span className="min-w-0">{looseInput}</span>
          <span className={cn("text-right tabular-nums text-[13px]", touched && side.valid ? "font-semibold" : "text-zinc-400")}>{youPcs}</span>
        </div>
        {hasExtras && <div className="mt-1.5 space-y-1">{extras}</div>}
      </div>
    );
  }

  // Phone: each row = label · SYSTEM number · your stepper, so the number to
  // match is right next to the box you are filling.
  return (
    <div className={cn("rounded-xl border-l-4 bg-zinc-50/70 dark:bg-zinc-800/40 p-2.5", rail)}>
      {header}
      <div className="grid grid-cols-[44px_46px_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5">
        <span />
        <span className={cn(lbl, "text-center leading-tight")}>System</span>
        <span className={cn(lbl, "text-center")}>Your count</span>

        <span className={lbl}>Cases</span>
        <span className={cn(sysNum, "text-center text-[17px]")}>{sysCases}</span>
        <div className="min-w-0">{casesInput}</div>

        <span className={lbl}>Loose</span>
        <span className={cn(sysNum, "text-center text-[17px]")}>{sysLoose}</span>
        <div className="min-w-0">{looseInput}</div>

        <span className={lbl}>Pieces</span>
        <span className={cn(sysNum, "text-center text-[15px]")}>{fmtN(sysPcs)}</span>
        <span className={cn("text-center tabular-nums text-[15px]", touched && side.valid ? "font-semibold" : "text-zinc-400")}>{youPcs}</span>
      </div>
      {(canSame || hasExtras) && (
        <div className="mt-2 space-y-1.5">
          {sameBtn}
          {extras}
        </div>
      )}
    </div>
  );
}

// ─── MyItem — one item in My count (desktop table row OR phone card) ──────
type MyItemProps = {
  desktop: boolean;
  i: Item & { categoryName: string | null };
  app: { A: AppStock; B: AppStock };
  d: DBDraft | undefined;
  others: DBDraft[];
  conflict: ItemConflictType | null;
  last?: LastReconciled;
  frozen: boolean;
  doneByUser: DoneMap;
  currentUserId: string;
  computeDiff: (i: Item, app: { A: AppStock; B: AppStock }, d: DBDraft) => RowDiffType;
  setField: (uid: string, iid: string, f: Field, v: string) => void;
  commitRow: (uid: string, iid: string) => void;
  resetMyRow: (itemId: string) => void;
  errors?: string[];
};

// Value-equality for the memo. The poll replaces every draft / stock / done
// object with a fresh copy every few seconds, so identity alone would
// re-render every row each time; compare what a row actually displays.
function sameDraftValues(a: DBDraft | undefined, b: DBDraft | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.user_id === b.user_id
    && a.case_size_raw === b.case_size_raw
    && a.a_cases_raw === b.a_cases_raw && a.a_loose_raw === b.a_loose_raw
    && a.b_cases_raw === b.b_cases_raw && a.b_loose_raw === b.b_loose_raw
    && a.user_name === b.user_name && a.user_email === b.user_email;
}
const sameStockSide = (a: AppStock, b: AppStock) =>
  a.cases === b.cases && a.loose === b.loose && a.hasStockRow === b.hasStockRow;
function myItemPropsEqual(p: MyItemProps, n: MyItemProps): boolean {
  if (p.desktop !== n.desktop || p.i !== n.i || p.frozen !== n.frozen || p.currentUserId !== n.currentUserId) return false;
  if (p.computeDiff !== n.computeDiff || p.setField !== n.setField || p.commitRow !== n.commitRow || p.resetMyRow !== n.resetMyRow) return false;
  if (p.last?.at !== n.last?.at || p.last?.userName !== n.last?.userName) return false;
  if (!sameStockSide(p.app.A, n.app.A) || !sameStockSide(p.app.B, n.app.B)) return false;
  if (!sameDraftValues(p.d, n.d)) return false;
  if (p.others.length !== n.others.length) return false;
  for (let k = 0; k < p.others.length; k++) {
    const a = p.others[k], b = n.others[k];
    if (!sameDraftValues(a, b)) return false;
    if (!!p.doneByUser.get(a.user_id)?.done !== !!n.doneByUser.get(b.user_id)?.done) return false;
  }
  const pc = p.conflict, nc = n.conflict;
  if (!!pc !== !!nc) return false;
  if (pc && nc && (pc.any !== nc.any || pc.a !== nc.a || pc.b !== nc.b || pc.case_size !== nc.case_size || pc.reason !== nc.reason)) return false;
  if ((p.errors ?? []).join("|") !== (n.errors ?? []).join("|")) return false;
  return true;
}

const MyItem = memo(function MyItem({
  desktop, i, app, d, others, conflict, last, frozen, doneByUser,
  currentUserId, computeDiff, setField, commitRow, resetMyRow, errors,
}: MyItemProps) {
  // Phone only: the case-size editor stays folded away until asked for —
  // it rarely changes and used to cost every card a full row.
  const [csOpen, setCsOpen] = useState(false);
  const my = d ?? makeEmptyDraft(currentUserId, i.id);
  const rd = computeDiff(i, app, my);
  const itemCs = i.case_size || 0;
  const rail = statusRail(rd, conflict, others.length);
  const hasErr = (errors?.length ?? 0) > 0;
  const onChange = (field: Field, value: string) => setField(currentUserId, i.id, field, value);
  const onBlur = () => commitRow(currentUserId, i.id);
  // Type the system's own numbers into this godown, then save like a blur.
  const fillSame = (g: Godown) => {
    const s = app[g];
    if (rd.csNew > 0) setField(currentUserId, i.id, g === "A" ? "a_cases" : "b_cases", String(s.cases));
    setField(currentUserId, i.id, g === "A" ? "a_loose" : "b_loose", String(s.loose));
    commitRow(currentUserId, i.id);
  };
  const panel = (g: Godown, phone: boolean) => (
    <GodownPanel g={g} appSide={app[g]} side={rd[g]} csOld={rd.csOld} csNew={rd.csNew}
      cRaw={g === "A" ? my.a_cases_raw : my.b_cases_raw} lRaw={g === "A" ? my.a_loose_raw : my.b_loose_raw}
      onCases={(v) => onChange(g === "A" ? "a_cases" : "b_cases", v)}
      onLoose={(v) => onChange(g === "A" ? "a_loose" : "b_loose", v)}
      onBlur={onBlur} onSame={() => fillSame(g)}
      stepper={phone} compact={!phone} frozen={frozen}
      peers={buildPeers(others, g, itemCs, rd[g], doneByUser)} ariaPrefix={i.model} />
  );

  if (desktop) {
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
                  {[i.size, i.colour].filter(Boolean).join(" · ")}
                </div>
                <div className="mt-1 empty:hidden"><StatusChip rd={rd} conflict={conflict} /></div>
                <RowMeta last={last} others={others} conflict={conflict} doneByUser={doneByUser} />
              </div>
            </div>
          </td>
          <td className="px-2 py-3 align-top">
            <ExprInput
              value={my.case_size_raw}
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
          <td className="px-2 py-3 align-top">{panel("A", false)}</td>
          <td className="px-2 py-3 align-top">{panel("B", false)}</td>
          <td className="px-2 py-3 align-top">
            {rd.hasAnyChange && !frozen && (
              <button type="button" onClick={() => resetMyRow(i.id)} className="text-zinc-400 hover:text-rose-500 p-1.5" title="Clear this item's count" aria-label="Clear this item's count">
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

  const showCsEditor = !frozen && (csOpen || !rd.caseSizeValid);
  return (
    <div className={cn("bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 border-l-4 rounded-2xl p-3.5 shadow-sm", rail)}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-2.5">
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
            {[i.size, i.colour].filter(Boolean).join(" · ")}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {/* Case size — a quiet chip; tap to change it (rare). */}
            <button
              type="button"
              onClick={() => setCsOpen(o => !o)}
              disabled={frozen}
              aria-expanded={showCsEditor}
              aria-label={`Change case size for ${i.model}`}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-2 min-h-7 text-[11px] tabular-nums border",
                rd.caseSizeChanged
                  ? "bg-amber-500/15 border-amber-500/40 text-amber-700 dark:text-amber-300"
                  : "bg-zinc-50 dark:bg-zinc-800/60 border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300"
              )}
            >
              {rd.csNew > 0 ? `Case of ${fmtN(rd.csNew)}` : "No case size"}
              {!frozen && <Pencil className="w-3 h-3 text-zinc-400" />}
            </button>
            {rd.caseSizeChanged && <SysChip label="WAS">{rd.csOld}</SysChip>}
            <StatusChip rd={rd} conflict={conflict} />
          </div>
          <RowMeta last={last} others={others} conflict={conflict} doneByUser={doneByUser} />
        </div>
        {rd.hasAnyChange && !frozen && (
          <button onClick={() => resetMyRow(i.id)} className="text-zinc-400 hover:text-rose-500 min-w-11 min-h-11 -mr-2 -mt-1 inline-flex items-center justify-center flex-shrink-0" aria-label="Clear this item's count">
            <RotateCcw className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Case-size editor — pre-filled with the system value. */}
      {showCsEditor && (
        <div className="grid grid-cols-[1fr_auto] items-center gap-2 mb-2.5 rounded-lg bg-zinc-50/70 dark:bg-zinc-800/40 px-3 py-2">
          <span className="text-[11px] text-zinc-500">Pieces in one case</span>
          <div className="w-[148px]">
            <ExprInput
              value={my.case_size_raw}
              prefill={String(rd.csOld)}
              onChange={(v) => onChange("case_size", v)}
              onBlur={onBlur}
              stepper
              tone={rd.caseSizeChanged ? "amber" : (!rd.caseSizeValid ? "rose" : "neutral")}
              ariaLabel={`Case size for ${i.model}`}
            />
          </div>
        </div>
      )}

      {/* Two full-width godown panels stacked (steppers need the width) */}
      <div className="space-y-2.5">
        {panel("A", true)}
        {panel("B", true)}
      </div>

      {hasErr && (
        <div className="mt-3 text-[11px] text-rose-700 dark:text-rose-300 flex items-start gap-1.5">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <div>{errors!.join(" · ")}</div>
        </div>
      )}
    </div>
  );
}, myItemPropsEqual);

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
        <Clock className="w-3 h-3" /> Last counted {timeAgo(last.at)}{last.userName ? ` by ${last.userName}` : ""}
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
    // cyan-* = the remapped brand violet — keeps the heads-down count boxes
    // on the literal brand colour instead of a near-miss raw violet.
    !disabled && tone === "neutral" && "border-zinc-200 dark:border-zinc-700 focus:ring-cyan-500/40 focus:border-cyan-500"
  );
  // Enter (the "Next" key on a phone's number pad) jumps to the next count
  // box, Shift+Enter to the previous — like moving down a column in Excel.
  // Case-size boxes are skipped as targets: they're pre-filled and rarely change.
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const all = Array.from(document.querySelectorAll<HTMLInputElement>("input[data-expr]:not(:disabled)"));
    const step = e.shiftKey ? -1 : 1;
    let idx = all.indexOf(e.currentTarget) + step;
    while (idx >= 0 && idx < all.length && all[idx].dataset.expr !== "count") idx += step;
    const next = all[idx];
    if (next) { next.focus(); next.select(); } else e.currentTarget.blur();
  };
  const field = (
    <div className="flex-1 flex flex-col gap-0.5 min-w-0">
      <input type="text" inputMode="numeric" enterKeyHint="next" value={displayValue} placeholder={placeholder}
        data-expr={prefill !== undefined ? "case-size" : "count"}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        onFocus={usingPrefill ? (e) => e.currentTarget.select() : undefined}
        disabled={disabled}
        className={cls} aria-label={ariaLabel} />
      {/* Caption for the running-total sum ("5+1" → "= 6") — only rendered
          when there is a sum, so plain numbers don't pay a blank row. */}
      {showsTotal && (
        <span className="min-h-[12px] text-center text-[10px] leading-none text-zinc-500 tabular-nums">
          = {fmtN(parsed!)}
        </span>
      )}
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
    "flex-shrink-0 min-w-11 min-h-11 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-100 select-none active:scale-95 active:bg-zinc-200 dark:active:bg-zinc-700 hover:border-cyan-400 disabled:opacity-40 disabled:active:scale-100 flex items-center justify-center transition";
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

// ─── ReviewerView (admin only) ───────────────────────────────────────────
// Two-step wizard body. Step 1 lists items where staff disagree (resolve via
// inline edit / clear / "keep only this count"); Step 2 lists items whose agreed
// count differs from the system (push to stock). The page decides which item
// list to pass; this view renders the cards + the per-step empty state.
function ReviewerView({
  items, step, totalConflicts, matchingCount, hasActiveFilters, clearFilters, onGotoStep, onKeepOnly,
  appStock, draftsByItem, lastRecon, computeDiff, computeItemConflict,
  setField, commitRow, deleteDraft, currentUserId, doneByUser,
  people, onAddCounter, onApplyItem, applyingItemId, errorsByItem,
}: {
  items: (Item & { categoryName: string | null })[];
  step: 1 | 2;
  totalConflicts: number;
  matchingCount: number;
  hasActiveFilters: boolean;
  clearFilters: () => void;
  onGotoStep: (s: 1 | 2) => void;
  onKeepOnly: (item: Item, keepUserId: string) => void;
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
  if (items.length === 0) {
    return (
      <ReviewerEmpty
        step={step}
        totalConflicts={totalConflicts}
        matchingCount={matchingCount}
        hasActiveFilters={hasActiveFilters}
        clearFilters={clearFilters}
        onGotoStep={onGotoStep}
      />
    );
  }
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
        // Step 2 items all differ from the system (that's why they're listed),
        // so amber = "needs adjustment"; Step 1 keeps the conflict/ready rail.
        // Step 2 only: the single agreed count vs system, for the summary line.
        const agreed = step === 2 && nonEmpty.length > 0
          ? computeDiff(i, app, mergeAgreed(makeEmptyDraft("", i.id), nonEmpty, i.id))
          : null;
        // Listed on Step 2 but edited until it equals the system.
        const nowMatches = !!agreed && agreed.A.diff === 0 && agreed.B.diff === 0 && !agreed.caseSizeChanged;
        const rail = conflict?.any
          ? "border-l-rose-500"
          : step === 2
            ? (nowMatches ? "border-l-emerald-500" : "border-l-amber-500")
            : ready ? "border-l-emerald-500" : "border-l-zinc-200 dark:border-l-zinc-800";
        const cs = i.case_size || 0;
        const last = lastRecon.get(i.id);
        const errs = errorsByItem.get(i.id);
        // "Keep only this count" is offered on any conflicted item — it resolves
        // a disagreement (multiple counters) OR a done-misser to the chosen
        // counter's numbers without touching stock.
        const canKeepOnly = !!conflict?.any;
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
                      {[i.size, i.colour].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                </div>
                {conflict?.any ? (
                  <span className="inline-flex items-center gap-1 bg-rose-500/15 text-rose-700 dark:text-rose-300 px-2 py-0.5 rounded text-[10px] uppercase tracking-wider font-medium flex-shrink-0">
                    <AlertTriangle className="w-3 h-3" /> Conflict
                  </span>
                ) : step === 2 && nowMatches ? (
                  <span className="inline-flex items-center gap-1 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 px-2 py-0.5 rounded text-[10px] uppercase tracking-wider font-medium flex-shrink-0">
                    <CheckCircle2 className="w-3 h-3" /> Matches system
                  </span>
                ) : step === 2 ? (
                  <span className="inline-flex items-center gap-1 bg-amber-500/15 text-amber-700 dark:text-amber-300 px-2 py-0.5 rounded text-[10px] uppercase tracking-wider font-medium flex-shrink-0">
                    Differs from system
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
                <SysChip label="B" className="text-teal-700 dark:text-teal-300">{breakupStr(cs, app.B.cases, app.B.loose)}</SysChip>
                <SysChip label="CS">{cs}</SysChip>
                {last && <span className="text-[10px] text-zinc-400 ml-auto">Last: {timeAgo(last.at)}{last.userName ? ` by ${last.userName}` : ""}</span>}
              </div>
            </div>

            {/* Step 2: the agreed count vs the system — the discrepancy at a glance */}
            {step === 2 && agreed && (
              <div className="px-3 py-2 border-t border-zinc-200/60 dark:border-zinc-800/60 bg-amber-500/5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="text-[9px] uppercase tracking-wider text-amber-600 dark:text-amber-400 font-semibold">Agreed → system</span>
                <span className="inline-flex items-center gap-1.5 text-[11px] tabular-nums">
                  <span className="text-cyan-700 dark:text-cyan-300 font-semibold">A</span>
                  {agreed.A.userTouched && agreed.A.valid
                    ? <><span className="text-zinc-600 dark:text-zinc-300">{fmtN(agreed.A.physPieces)} pcs</span><DiffPill diff={agreed.A.diff} /></>
                    : <span className="text-zinc-400 italic">unchanged</span>}
                </span>
                <span className="inline-flex items-center gap-1.5 text-[11px] tabular-nums">
                  <span className="text-teal-700 dark:text-teal-300 font-semibold">B</span>
                  {agreed.B.userTouched && agreed.B.valid
                    ? <><span className="text-zinc-600 dark:text-zinc-300">{fmtN(agreed.B.physPieces)} pcs</span><DiffPill diff={agreed.B.diff} /></>
                    : <span className="text-zinc-400 italic">unchanged</span>}
                </span>
              </div>
            )}

            {/* Step 1: plain-language reason so the reviewer resolves fast */}
            {step === 1 && conflict?.any && conflict.reason && (
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
                    step={step}
                    conflict={conflict}
                    isMe={d.user_id === currentUserId}
                    userDone={!!doneByUser.get(d.user_id)?.done}
                    computeDiff={computeDiff}
                    canApply={!isDraftEmpty(d)}
                    canKeepOnly={canKeepOnly && !isDraftEmpty(d)}
                    applying={applying}
                    onChange={(field, value) => setField(d.user_id, i.id, field, value)}
                    onBlur={() => commitRow(d.user_id, i.id)}
                    onApply={() => onApplyItem(i, d)}
                    onKeepOnly={() => onKeepOnly(i, d.user_id)}
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

// Per-step empty state for the reviewer wizard.
function ReviewerEmpty({
  step, totalConflicts, matchingCount, hasActiveFilters, clearFilters, onGotoStep,
}: {
  step: 1 | 2;
  totalConflicts: number;
  matchingCount: number;
  hasActiveFilters: boolean;
  clearFilters: () => void;
  onGotoStep: (s: 1 | 2) => void;
}) {
  // Empty because a search/brand/category filter hides the matching items
  // (Step 1: conflicts exist but none match; Step 2: differences may exist).
  if (hasActiveFilters && (step === 2 || totalConflicts > 0)) {
    return (
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg py-12 text-center">
        <ClipboardCheck className="w-7 h-7 text-zinc-400 dark:text-zinc-600 mx-auto mb-3" strokeWidth={1.5} />
        <div className="text-sm text-zinc-500 max-w-sm mx-auto px-4">
          {step === 1
            ? <>{fmtN(totalConflicts)} conflicted item{totalConflicts === 1 ? " is" : "s are"} hidden by your filter — clear it to resolve {totalConflicts === 1 ? "it" : "them"} and unlock Step 2.</>
            : "No differing items match the current filter."}
        </div>
        <button onClick={clearFilters} className="mt-3 text-xs text-cyan-600 dark:text-cyan-400 hover:underline">Clear filters</button>
      </div>
    );
  }
  if (step === 1) {
    return (
      <div className="bg-white dark:bg-zinc-900 border border-emerald-500/30 rounded-lg py-12 text-center">
        <CheckCircle2 className="w-7 h-7 text-emerald-500 mx-auto mb-3" strokeWidth={1.5} />
        <div className="text-sm font-medium text-zinc-700 dark:text-zinc-200">All staff agree</div>
        <div className="text-xs text-zinc-500 mt-1 max-w-sm mx-auto px-4">No disagreements between counters. Continue to compare the agreed counts against the system.</div>
        <button onClick={() => onGotoStep(2)} className="mt-4 inline-flex items-center gap-1.5 rounded-md px-3.5 py-2 text-sm font-medium bg-cyan-500 hover:bg-cyan-400 text-white">
          Continue to Step 2 →
        </button>
      </div>
    );
  }
  if (matchingCount === 0) {
    return (
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg py-12 text-center">
        <ClipboardCheck className="w-7 h-7 text-zinc-400 dark:text-zinc-600 mx-auto mb-3" strokeWidth={1.5} />
        <div className="text-sm font-medium text-zinc-700 dark:text-zinc-200">Nothing counted yet</div>
        <div className="text-xs text-zinc-500 mt-1 max-w-md mx-auto px-4">Items appear here once they have been counted and the counters agree. Enter counts in <strong>My count</strong> first.</div>
      </div>
    );
  }
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg py-12 text-center">
      <CheckCircle2 className="w-7 h-7 text-emerald-500 mx-auto mb-3" strokeWidth={1.5} />
      <div className="text-sm font-medium text-zinc-700 dark:text-zinc-200">Counts match the system</div>
      <div className="text-xs text-zinc-500 mt-1 max-w-md mx-auto px-4">Every agreed count equals what the system already shows. Press <strong>Make adjustments</strong> to close this count — it saves the counts to Count history and clears the entries. Its confirm box also offers “zero what nobody found” for a full stock-take.</div>
    </div>
  );
}

// One godown block inside a reviewer counter row (A or B).
function ReviewerGodown({
  g, side, csOld, csNew, cRaw, lRaw, conflictCell, onCases, onLoose, onBlur, ariaPrefix, appSide,
}: {
  g: Godown;
  side: RowDiffType["A"];
  csOld: number; csNew: number;
  cRaw: string; lRaw: string;
  conflictCell: boolean;
  onCases: (v: string) => void; onLoose: (v: string) => void; onBlur: () => void;
  ariaPrefix: string;
  appSide: AppStock;
}) {
  const touched = side.userTouched;
  const rail = g === "A" ? "border-l-cyan-500/70" : "border-l-teal-500/80";
  const head = g === "A" ? "text-cyan-700 dark:text-cyan-300" : "text-teal-700 dark:text-teal-300";
  const tone: "neutral" | "amber" | "rose" = conflictCell ? "rose" : touched ? (side.valid ? "amber" : "rose") : "neutral";
  // Re-base the system reference at the edited case size (same rule as the
  // My-count panels) so SYS · Counted · Diff reconcile visually.
  const csEdited = csNew !== csOld;
  const sysPcs = csEdited ? pieces(csNew, appSide.cases, appSide.loose) : side.appPieces;
  return (
    <div className={cn("rounded-lg border-l-4 bg-zinc-50/60 dark:bg-zinc-800/30 p-2", rail, conflictCell && "ring-1 ring-rose-500/40")}>
      <div className="flex items-center justify-between gap-1 mb-1.5">
        <span className={cn("text-[10px] font-semibold uppercase tracking-wider", conflictCell ? "text-rose-600 dark:text-rose-400" : head)}>Godown {g}</span>
        <span className="text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
          System <span className="font-semibold text-zinc-700 dark:text-zinc-200">{fmtN(sysPcs)} pcs</span>
          {csEdited && <span className="text-zinc-400"> · was {fmtN(side.appPieces)}</span>}
        </span>
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
  i, app, d, step, conflict, isMe, userDone, computeDiff, canApply, canKeepOnly, applying, onChange, onBlur, onApply, onKeepOnly, onClear,
}: {
  i: Item;
  app: { A: AppStock; B: AppStock };
  d: DBDraft;
  step: 1 | 2;
  conflict: ItemConflictType | null;
  isMe: boolean;
  userDone: boolean;
  computeDiff: (i: Item, app: { A: AppStock; B: AppStock }, d: DBDraft) => RowDiffType;
  canApply: boolean;
  canKeepOnly: boolean;
  applying: boolean;
  onChange: (field: Field, value: string) => void;
  onBlur: () => void;
  onApply: () => void;
  onKeepOnly: () => void;
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
        <ReviewerGodown g="A" side={rd.A} csOld={rd.csOld} csNew={rd.csNew} appSide={app.A} cRaw={d.a_cases_raw} lRaw={d.a_loose_raw}
          conflictCell={!!conflict?.a} onCases={(v) => onChange("a_cases", v)} onLoose={(v) => onChange("a_loose", v)} onBlur={onBlur} ariaPrefix={`${name}`} />
        <ReviewerGodown g="B" side={rd.B} csOld={rd.csOld} csNew={rd.csNew} appSide={app.B} cRaw={d.b_cases_raw} lRaw={d.b_loose_raw}
          conflictCell={!!conflict?.b} onCases={(v) => onChange("b_cases", v)} onLoose={(v) => onChange("b_loose", v)} onBlur={onBlur} ariaPrefix={`${name}`} />
      </div>

      {/* Step 1: resolve a disagreement by keeping THIS counter's numbers and
          clearing the others — staff "agree" without touching system stock. */}
      {step === 1 && canKeepOnly && (
        <button
          type="button"
          onClick={onKeepOnly}
          disabled={applying}
          className="mt-2 w-full min-h-11 inline-flex items-center justify-center gap-1.5 rounded-lg border border-violet-500/50 text-violet-700 dark:text-violet-300 hover:bg-violet-500/10 text-sm font-medium disabled:opacity-50 transition-colors"
          title={`Keep ${name}'s count and clear the others for this item`}
        >
          <CheckCheck className="w-4 h-4" />
          Keep only {name.split(" ")[0]}&apos;s count
        </button>
      )}

      {/* Step 2: push THIS counter's numbers to system stock for this item. */}
      {step === 2 && canApply && (
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
    <details className="group mt-6 bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-800 rounded-lg text-xs text-zinc-600 dark:text-zinc-400">
      <summary className="flex items-center gap-1.5 text-zinc-700 dark:text-zinc-200 font-medium cursor-pointer select-none px-4 min-h-11 list-none [&::-webkit-details-marker]:hidden">
        <Filter className="w-3.5 h-3.5" /> Tips — how counting and reviewing work
        <ChevronDown className="w-3.5 h-3.5 ml-auto transition-transform group-open:rotate-180" />
      </summary>
      <div className="px-4 pb-4 space-y-1.5">
      <div>
        <strong>Same as system:</strong> when the shelf matches the number shown, tap <strong>Same as system</strong> instead of typing it. On a computer, <strong>Enter</strong> jumps to the next box.
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
        <strong>Mark my count done</strong> freezes your entries so they can't change by accident — and <strong>saves a permanent copy</strong> of everything you counted right then (the admin can see it later in <strong>Count history</strong>, even before anything is committed). While you're done, any item you left <em>blank</em> but a teammate filled is read as “found none” and flagged to the reviewer as a conflict. Hit <strong>Resume editing</strong> if you find more.
      </div>
      {!isAdmin && (
        <div>
          <strong>No commit button:</strong> only admin commits. Once your count is done, mark it done and tell admin to review and adjust.
        </div>
      )}
      {isAdmin && (
        <div>
          <strong>Reviewer works in two steps.</strong> <strong>Step 1 — Reconcile staff counts</strong> lists only the items where counters <em>disagree</em> (or a “done” counter missed an item others found), flagged{" "}
          <span className="inline-block px-1 bg-rose-500/15 text-rose-700 dark:text-rose-300 rounded text-[10px]">Conflict</span> with the reason spelled out. Resolve each by editing a row, clearing a wrong count, or <strong>Keep only [name]'s count</strong> (clears the others). None of this touches system stock. Once every disagreement is gone, <strong>Step 2 — Reconcile with system</strong> unlocks.
        </div>
      )}
      {isAdmin && (
        <div>
          <strong>Step 2</strong> lists the agreed items whose count <em>differs from the system</em>, with the <strong>Agreed → system</strong> difference on each. <strong>Make adjustments</strong> pushes every agreed count to stock at once; its confirm box also offers <strong>“Full count — zero the stock nobody found”</strong> so after a complete stock-take the system matches the count exactly (untick for a partial count). <strong>Apply this count</strong> on a single row pushes just that item. <strong>Add a count for</strong> lets you enter a count for a counter who didn't.
        </div>
      )}
      <div>
        <strong>Case size</strong> edits are staged like the rest — nothing applies until <strong>Make adjustments</strong> runs. While editing, the totals on this page use the new case size for the math.
      </div>
      <div>
        <strong>Print count sheet</strong> gives you a blank sheet for a paper stock-take. Type it back into {mode === "my" ? "My count" : "your count"} when done.
      </div>
      </div>
    </details>
  );
}

// ─── guide strip ─────────────────────────────────────────────────────────
// The whole job in three steps, at the TOP where a first-time counter sees it.
function GuideStrip({ isAdmin, onHide }: { isAdmin: boolean; onHide: () => void }) {
  const steps = [
    { t: "Count each item", d: "Type the cases and loose pieces you find — or tap Same as system when it matches." },
    { t: "Mark my count done", d: "It freezes your numbers and saves a copy." },
    isAdmin
      ? { t: "Review and update stock", d: "In Reviewer: settle any disagreements, then Make adjustments." }
      : { t: "Admin reviews", d: "The admin compares the counts and updates the stock." },
  ];
  return (
    <div className="mb-4 rounded-xl border border-cyan-500/25 bg-cyan-500/5 px-3.5 py-3 relative">
      <button type="button" onClick={onHide} aria-label="Hide these steps"
        className="absolute right-1 top-1 min-w-9 min-h-9 inline-flex items-center justify-center text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200">
        <X className="w-4 h-4" />
      </button>
      <ol className="grid gap-2.5 sm:grid-cols-3 pr-7">
        {steps.map((s, idx) => (
          <li key={idx} className="flex items-start gap-2.5">
            <span className="flex-shrink-0 w-5 h-5 mt-0.5 rounded-full bg-cyan-500 text-white text-[11px] font-semibold inline-flex items-center justify-center tabular-nums">{idx + 1}</span>
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{s.t}</span>
              <span className="block text-[11px] text-zinc-500 leading-snug">{s.d}</span>
            </span>
          </li>
        ))}
      </ol>
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
function EmptyState({ clearFilters, myFilter, hasSearch }: { clearFilters: () => void; myFilter: MyFilter; hasSearch: boolean }) {
  const msg = hasSearch || myFilter === "all"
    ? "No items match the current filter."
    : myFilter === "todo" ? "Nothing left to count — every item has an entry."
    : myFilter === "counted" ? "You haven't counted anything yet."
    : myFilter === "differs" ? "None of your counts differ from the system."
    : "No conflicts — nobody's count disagrees with yours.";
  const good = !hasSearch && (myFilter === "todo" || myFilter === "differs" || myFilter === "conflicts");
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg py-12 text-center">
      {good
        ? <CheckCircle2 className="w-7 h-7 text-emerald-500 mx-auto mb-3" strokeWidth={1.5} />
        : <ClipboardCheck className="w-7 h-7 text-zinc-400 dark:text-zinc-600 mx-auto mb-3" strokeWidth={1.5} />}
      <div className="text-sm text-zinc-500 px-4">{msg}</div>
      <button onClick={clearFilters} className="mt-3 text-xs text-cyan-600 dark:text-cyan-400 hover:underline">Show all items</button>
    </div>
  );
}

// ─── print sheet ─────────────────────────────────────────────────────────
function PrintSheet({
  items,
  activeFilters = [],
}: {
  items: (Item & { categoryName: string | null })[];
  // Printed in the header so a partial sheet can't be mistaken for the full
  // catalogue (the sheet prints the FILTERED list).
  activeFilters?: string[];
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
          <div className="ps-subtitle">
            Rye Electricals · {today} · {fmtN(items.length)} items
            {activeFilters.length > 0 && <> · PARTIAL SHEET (filtered: {activeFilters.join(", ")})</>}
          </div>
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
                        <div className="ps-model-sub">{[i.size, i.colour, i.item_code].filter(Boolean).join(" · ")}</div>
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
