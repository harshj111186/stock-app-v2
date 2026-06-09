"use client";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Printer, ClipboardCheck, CheckCircle2, AlertCircle,
  RotateCcw, Loader2, Filter, Eye, EyeOff, Users, ShieldCheck,
  UserCircle2, Clock, Lock, LockOpen, CheckCheck, AlertTriangle, UserPlus,
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

  // Refresh drafts on tab visibility regain + every 30s so other users'
  // edits show up without a full page reload. CRITICAL: this merges
  // server rows into local state — it does NOT replace the map. The
  // current user's rows are protected from being clobbered while typing
  // (the 5-second "input resets" bug came from blindly overwriting them).
  //
  // Rules:
  //   - Other users' rows: trust the server completely (replace + drop
  //     missing).
  //   - My own rows with a pending save timer: leave alone — local is
  //     in flight.
  //   - My own rows without a pending save: adopt server value only when
  //     server's updated_at is strictly newer (so a slightly-out-of-date
  //     poll doesn't roll my latest keystroke back).
  //   - My own rows missing from the server (admin committed them):
  //     drop locally unless a pending save is still in flight or the row
  //     is local-only (never persisted yet).
  const refreshDrafts = useCallback(async () => {
    const myId = profile?.id;
    if (!myId) return;
    const { data } = await sb().from("reconciliation_drafts_with_user").select("*");
    const serverByKey = new Map<string, DBDraft>();
    (data || []).forEach((d: any) => serverByKey.set(dkey(d.user_id, d.item_id), d as DBDraft));

    const prev = draftsRef.current;
    const next = new Map(prev);

    // 1) Other users' rows — server is the source of truth, EXCEPT a row the
    //    admin just added for someone (id "local-…") that hasn't persisted yet
    //    (it persists the moment a value is typed into it).
    for (const [k, local] of [...prev]) {
      if (local.user_id !== myId && !serverByKey.has(k) && !local.id.startsWith("local-")) next.delete(k);
    }
    for (const [k, server] of serverByKey) {
      if (server.user_id !== myId) next.set(k, server);
    }

    // 2) My own rows — protect in-flight edits.
    for (const [k, server] of serverByKey) {
      if (server.user_id !== myId) continue;
      if (saveTimers.current.has(k)) continue; // mid-save, don't touch
      const local = next.get(k);
      if (!local || (local.updated_at && server.updated_at > local.updated_at) || !local.updated_at) {
        next.set(k, server);
      }
    }

    // 3) My own rows that no longer exist on the server (admin committed).
    for (const [k, local] of [...next]) {
      if (local.user_id !== myId) continue;
      if (serverByKey.has(k)) continue;
      if (saveTimers.current.has(k)) continue;
      if (local.id.startsWith("local-")) continue; // never persisted, keep
      next.delete(k);
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
      if (!isLocal) {
        await sb().from("reconciliation_drafts").delete().eq("user_id", userId).eq("item_id", itemId);
      }
      return;
    }

    const { data, error } = await sb()
      .from("reconciliation_drafts")
      .upsert(
        {
          user_id: userId,
          item_id: itemId,
          case_size_raw: snap.case_size_raw,
          a_cases_raw: snap.a_cases_raw,
          a_loose_raw: snap.a_loose_raw,
          b_cases_raw: snap.b_cases_raw,
          b_loose_raw: snap.b_loose_raw,
        },
        { onConflict: "user_id,item_id" }
      )
      .select("id, updated_at")
      .single();
    if (error) {
      // Don't toast if component already unmounted — but useState setters
      // are no-ops post-unmount, so calling showToast is safe.
      showToast("bad", `Save failed: ${error.message}`);
      return;
    }
    if (data) {
      const cur = draftsRef.current.get(k);
      if (!cur) return;
      const next = new Map(draftsRef.current);
      next.set(k, { ...cur, id: data.id, updated_at: data.updated_at });
      writeDrafts(next);
    }
  }, [writeDrafts]);

  const deleteDraft = useCallback(async (userId: string, itemId: string) => {
    const k = dkey(userId, itemId);
    const next = new Map(draftsRef.current);
    next.delete(k);
    writeDrafts(next);
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
    const cs = parseExpr(cur.case_size_raw) ?? (itemById.get(itemId)?.case_size || 0);
    if (cs <= 0) return false;
    const next: DBDraft = { ...cur };
    let changed = false;
    for (const [cf, lf] of [["a_cases_raw", "a_loose_raw"], ["b_cases_raw", "b_loose_raw"]] as const) {
      const l = parseExpr(next[lf]);
      if (l === null || l < cs) continue;
      const c = parseExpr(next[cf]) ?? 0;
      next[cf] = String(c + Math.floor(l / cs));
      next[lf] = String(l % cs);
      changed = true;
    }
    if (!changed) return false;
    next.updated_at = new Date().toISOString();
    const m = new Map(draftsRef.current);
    m.set(k, next);
    writeDrafts(m);
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
      const appPieces = pieces(csOld, appSide.cases, appSide.loose);
      const physPieces = pieces(csNew, physCases, physLoose);
      const valid =
        (cRaw.trim() === "" || pc !== null) &&
        (lRaw.trim() === "" || pl !== null);
      const diff = (userTouched || caseSizeChanged) ? physPieces - appPieces : 0;
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
      // Any per-row invalid?
      for (const d of drs) {
        const rd = computeDiff(i, app, d);
        if (rd.invalid) invalid++;
      }
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

  // ─── commit (admin only) ───────────────────────────────────────────────
  const makeAdjustments = async () => {
    if (!canCommit) { showToast("bad", "Only admins can commit reconciliation."); return; }
    if (processing) return;

    // Collect committable items: at least one user has a non-empty draft
    // AND no conflict across users AND all entered values are valid.
    type SideInfo = { godown: Godown; diff: number; physCases: number; physLoose: number; needsWrite: boolean };
    type Job = {
      itemId: string;
      label: string;
      caseSizeNew: number;
      caseSizeChanged: boolean;
      sides: SideInfo[];
      userIdsToWipe: string[];
    };
    const jobs: Job[] = [];
    const skipped: Array<{ itemId: string; label: string; reason: string }> = [];

    for (const i of items) {
      const app = appStock.get(i.id);
      if (!app) continue;
      const drs = draftsByItem.get(i.id) || [];
      const nonEmpty = drs.filter(d => !isDraftEmpty(d));
      if (nonEmpty.length === 0) continue;

      const label = `${i.brand ? i.brand + " · " : ""}${i.model}${i.size ? " " + i.size : ""}`;
      const conflict = computeItemConflict(i, nonEmpty);
      if (conflict.any) {
        skipped.push({ itemId: i.id, label, reason: "conflict between users" });
        continue;
      }

      // Pick the agreed value per field — for each field grab the first
      // non-empty raw across drafts (they all agree, so any non-empty works)
      const agreedRaw = (k: "case_size_raw" | "a_cases_raw" | "a_loose_raw" | "b_cases_raw" | "b_loose_raw") => {
        for (const d of nonEmpty) {
          const v = String(d[k] || "").trim();
          if (v) return v;
        }
        return "";
      };
      const csRaw = agreedRaw("case_size_raw");
      const acRaw = agreedRaw("a_cases_raw");
      const alRaw = agreedRaw("a_loose_raw");
      const bcRaw = agreedRaw("b_cases_raw");
      const blRaw = agreedRaw("b_loose_raw");

      // Build a synthetic draft from the agreed values to reuse computeDiff.
      const merged: DBDraft = {
        ...emptyDraft,
        item_id: i.id,
        case_size_raw: csRaw,
        a_cases_raw: acRaw,
        a_loose_raw: alRaw,
        b_cases_raw: bcRaw,
        b_loose_raw: blRaw,
      };
      const rd = computeDiff(i, app, merged);
      if (rd.invalid) {
        skipped.push({ itemId: i.id, label, reason: "invalid input — fix before committing" });
        continue;
      }
      if (!rd.hasAnyChange) continue;

      const sides: SideInfo[] = (["A", "B"] as Godown[]).map(g => {
        const side = g === "A" ? rd.A : rd.B;
        const needsWrite = side.userTouched || rd.caseSizeChanged;
        return {
          godown: g,
          diff: side.diff,
          physCases: side.physCases,
          physLoose: side.physLoose,
          needsWrite,
        };
      }).filter(s => s.needsWrite);

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
          p_reason:       `Reconciliation ${date}`,
        });
        if (error) {
          newErrors.push({ itemId: j.itemId, godown: s.godown, message: error.message });
          failedItems.add(j.itemId);
        }
        done++; setProgress({ done, total: totalSteps });
      }

      // Delete all users' drafts for this item.
      if (!failedItems.has(j.itemId)) {
        const { error: delErr } = await sb()
          .from("reconciliation_drafts")
          .delete()
          .eq("item_id", j.itemId);
        if (delErr) {
          newErrors.push({ itemId: j.itemId, message: `Draft cleanup failed: ${delErr.message}` });
        }
      }
      done++; setProgress({ done, total: totalSteps });
    }

    setProcessing(false);
    setErrors(newErrors);

    const succeeded = jobs.length - failedItems.size;
    if (failedItems.size === 0 && skipped.length === 0) {
      showToast("ok", `Committed ${succeeded} item${succeeded === 1 ? "" : "s"}.`);
    } else if (failedItems.size === 0) {
      showToast("info", `Committed ${succeeded}. ${skipped.length} item${skipped.length === 1 ? "" : "s"} skipped (conflicts/invalid).`);
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
        if (!(sideRd.userTouched || rd.caseSizeChanged)) continue; // only write what was counted
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
          onCommit={makeAdjustments}
          canCommit={canCommit && stats.anyStaged > 0 && !processing}
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

        {toast && (
          <div className={cn(
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
              <> · <span className="text-rose-600 dark:text-rose-400 font-medium">{fmtN(stats.invalid)} invalid</span></>
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
function MyView({
  items, appStock, drafts, lastRecon, currentUserId, frozen,
  computeDiff, setField, commitRow, resetMyRow, errorsByItem,
  otherUsersByItem, conflictByItem, doneByUser,
}: {
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
}) {
  return (
    <>
      <DesktopTable
        items={items}
        appStock={appStock}
        drafts={drafts}
        lastRecon={lastRecon}
        currentUserId={currentUserId}
        frozen={frozen}
        computeDiff={computeDiff}
        setField={setField}
        commitRow={commitRow}
        resetMyRow={resetMyRow}
        errorsByItem={errorsByItem}
        otherUsersByItem={otherUsersByItem}
        conflictByItem={conflictByItem}
        doneByUser={doneByUser}
      />
      <MobileCards
        items={items}
        appStock={appStock}
        drafts={drafts}
        lastRecon={lastRecon}
        currentUserId={currentUserId}
        frozen={frozen}
        computeDiff={computeDiff}
        setField={setField}
        commitRow={commitRow}
        resetMyRow={resetMyRow}
        errorsByItem={errorsByItem}
        otherUsersByItem={otherUsersByItem}
        conflictByItem={conflictByItem}
        doneByUser={doneByUser}
      />
    </>
  );
}

// ─── DesktopTable (My view) ──────────────────────────────────────────────
function DesktopTable({
  items, appStock, drafts, lastRecon, currentUserId, frozen,
  computeDiff, setField, commitRow, resetMyRow, errorsByItem,
  otherUsersByItem, conflictByItem, doneByUser,
}: {
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
}) {
  return (
    <div className="hidden md:block bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 dark:bg-zinc-900/50 border-b border-zinc-200 dark:border-zinc-800">
          <tr className="text-zinc-500 text-[11px] uppercase tracking-wider">
            <th className="text-left px-3 py-2.5 font-medium w-[300px]">Item</th>
            <th className="text-center px-2 py-2.5 font-medium w-[78px]">Case size</th>
            <th className="text-center px-2 py-2.5 font-medium w-[78px]">A cases</th>
            <th className="text-center px-2 py-2.5 font-medium w-[78px]">A loose</th>
            <th className="text-center px-2 py-2.5 font-medium w-[78px]">B cases</th>
            <th className="text-center px-2 py-2.5 font-medium w-[78px]">B loose</th>
            <th className="text-left px-3 py-2.5 font-medium w-[210px]">Count breakup</th>
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
  const hasOtherDrafts = others.length > 0;
  const inConflict = !!conflict?.any;
  const hasErr = (errors?.length ?? 0) > 0;
  const rowTint = rd.invalid
    ? "bg-rose-500/5"
    : inConflict
      ? "bg-rose-500/5"
      : myTouched
        ? "bg-amber-500/5"
        : hasOtherDrafts
          ? "bg-cyan-500/5"
          : "";
  return (
    <Fragment>
      <tr className={cn("border-t border-zinc-200/50 dark:border-zinc-800/50 align-middle", rowTint)}>
        <td className="px-3 py-2">
          <div className="flex items-center gap-2 min-w-0">
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
              <RowMeta last={last} others={others} conflict={conflict} doneByUser={doneByUser} />
            </div>
          </div>
        </td>
        <td className="px-2 py-2">
          <ExprInput
            value={d.case_size_raw}
            placeholder={String(rd.csOld)}
            onChange={(v) => onChange("case_size", v)}
            onBlur={onBlur}
            disabled={frozen}
            tone={rd.caseSizeChanged ? "amber" : (!rd.caseSizeValid ? "rose" : "neutral")}
            ariaLabel={`Case size for ${i.model}`}
          />
        </td>
        <td className="px-2 py-2">
          <ExprInput value={d.a_cases_raw} placeholder="—"
            onChange={(v) => onChange("a_cases", v)}
            onBlur={onBlur}
            disabled={frozen}
            tone={rd.A.userTouched ? (rd.A.valid ? "amber" : "rose") : "neutral"}
            ariaLabel={`Godown A cases for ${i.model}`} />
        </td>
        <td className="px-2 py-2">
          <ExprInput value={d.a_loose_raw} placeholder="—"
            onChange={(v) => onChange("a_loose", v)}
            onBlur={onBlur}
            disabled={frozen}
            tone={rd.A.userTouched ? (rd.A.valid ? "amber" : "rose") : "neutral"}
            ariaLabel={`Godown A loose for ${i.model}`} />
        </td>
        <td className="px-2 py-2">
          <ExprInput value={d.b_cases_raw} placeholder="—"
            onChange={(v) => onChange("b_cases", v)}
            onBlur={onBlur}
            disabled={frozen}
            tone={rd.B.userTouched ? (rd.B.valid ? "amber" : "rose") : "neutral"}
            ariaLabel={`Godown B cases for ${i.model}`} />
        </td>
        <td className="px-2 py-2">
          <ExprInput value={d.b_loose_raw} placeholder="—"
            onChange={(v) => onChange("b_loose", v)}
            onBlur={onBlur}
            disabled={frozen}
            tone={rd.B.userTouched ? (rd.B.valid ? "amber" : "rose") : "neutral"}
            ariaLabel={`Godown B loose for ${i.model}`} />
        </td>
        <td className="px-3 py-2 align-top">
          <BreakupCell rd={rd} app={app} item={i} others={others} doneByUser={doneByUser} />
        </td>
        <td className="px-2 py-2">
          {myTouched && (
            <button type="button" onClick={onReset} className="text-zinc-400 hover:text-rose-500 p-1" title="Reset row" aria-label="Reset row">
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          )}
        </td>
      </tr>
      {hasErr && (
        <tr className="bg-rose-500/5 border-t border-rose-500/20">
          <td colSpan={8} className="px-3 py-2 text-[11px] text-rose-700 dark:text-rose-300">
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
  if (last) {
    lines.push(
      <span key="last" className="inline-flex items-center gap-1 text-[10px] text-zinc-400">
        <Clock className="w-3 h-3" /> Last: {timeAgo(last.at)}{last.userName ? ` by ${last.userName}` : ""}
      </span>
    );
  }
  if (others.length > 0) {
    const names = others
      .map(o => `${displayUser(o)}${doneByUser.get(o.user_id)?.done ? " (done)" : ""}`)
      .join(", ");
    lines.push(
      <span key="others" className={cn(
        "inline-flex items-center gap-1 text-[10px]",
        conflict?.any ? "text-rose-600 dark:text-rose-400 font-medium" : "text-cyan-600 dark:text-cyan-400"
      )}>
        {conflict?.any ? <AlertCircle className="w-3 h-3" /> : <Users className="w-3 h-3" />}
        {conflict?.any ? "Disagrees with " : "Also counted by "}{names}
      </span>
    );
  }
  if (conflict?.any && conflict.reason) {
    lines.push(
      <span key="reason" className="inline-flex items-center gap-1 text-[10px] text-rose-600/90 dark:text-rose-400/90 tabular-nums">
        <AlertTriangle className="w-3 h-3" /> {conflict.reason}
      </span>
    );
  }
  if (lines.length === 0) return null;
  return <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">{lines}</div>;
}

// Per-godown breakup shown in the My-count desktop table. For each godown:
//   - the user's entered count as "Xc×cs + YL = Z pcs" (only when they
//     touched that side or changed the case size)
//   - the app's current value as a grey "app: …" reference
//   - any other counters' entered totals for that godown
function BreakupCell({
  rd, app, item, others, doneByUser,
}: {
  rd: RowDiffType;
  app: { A: AppStock; B: AppStock };
  item: Item;
  others: DBDraft[];
  doneByUser: DoneMap;
}) {
  const itemCs = item.case_size || 0;
  const row = (g: Godown) => {
    const side = g === "A" ? rd.A : rd.B;
    const appSide = g === "A" ? app.A : app.B;
    const youShown = side.userTouched || rd.caseSizeChanged;
    const myPcs = youShown && side.valid ? side.physPieces : null;
    const othersForG = others
      .map(o => ({ o, name: displayUser(o), s: draftSide(o, g, itemCs) }))
      .filter(x => x.s.touched);
    return (
      <div className="leading-tight">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[10px] font-semibold text-zinc-500 w-3">{g}</span>
          {youShown ? (
            <span className="text-[11px] tabular-nums text-zinc-700 dark:text-zinc-200">
              {breakupStr(rd.csNew, side.physCases, side.physLoose)}
            </span>
          ) : (
            <span className="text-[11px] text-zinc-400">not counted</span>
          )}
          {youShown && side.valid && (
            <span className={cn(
              "text-[10px] tabular-nums font-semibold",
              side.diff === 0 ? "text-zinc-400" : side.diff > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"
            )}>
              ({side.diff > 0 ? "+" : ""}{fmtN(side.diff)})
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-baseline gap-x-2 pl-[18px]">
          <span className="text-[10px] tabular-nums text-zinc-500">
            system {breakupStr(itemCs, appSide.cases, appSide.loose)}
          </span>
          {othersForG.map((x, idx) => {
            const delta = myPcs !== null ? x.s.pcs - myPcs : null;
            const isDone = doneByUser.get(x.o.user_id)?.done;
            return (
              <span key={idx} className={cn(
                "text-[10px] tabular-nums",
                delta !== null && delta !== 0 ? "text-rose-600/90 dark:text-rose-400/90 font-medium" : "text-cyan-600/80 dark:text-cyan-400/80"
              )}>
                {x.name.split(" ")[0]}{isDone ? "✓" : ""} {fmtN(x.s.pcs)}
                {delta !== null && delta !== 0 && <span> ({delta > 0 ? "+" : ""}{fmtN(delta)})</span>}
              </span>
            );
          })}
        </div>
      </div>
    );
  };
  return (
    <div className="space-y-1.5">
      {row("A")}
      {row("B")}
    </div>
  );
}

// ─── ExprInput ───────────────────────────────────────────────────────────
function ExprInput({
  value, placeholder, onChange, onBlur, tone, ariaLabel, compact = false, stepper = false, disabled = false,
}: {
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  tone: "neutral" | "amber" | "rose";
  ariaLabel: string;
  compact?: boolean;
  stepper?: boolean;
  disabled?: boolean;
}) {
  const parsed = parseExpr(value);
  const showsTotal = value.includes("+") && parsed !== null;
  const cls = cn(
    "w-full tabular-nums text-center text-sm border rounded-md focus:outline-none focus:ring-1",
    compact ? "px-1 py-0.5 text-[12px]" : "px-1.5 py-1",
    disabled
      ? "bg-zinc-100 dark:bg-zinc-800/60 text-zinc-500 dark:text-zinc-400 cursor-not-allowed"
      : "bg-white dark:bg-zinc-900",
    tone === "amber" && "border-amber-500/50 focus:ring-amber-500/40 focus:border-amber-500",
    tone === "rose" && "border-rose-500/60 focus:ring-rose-500/40 focus:border-rose-500",
    tone === "neutral" && "border-zinc-200 dark:border-zinc-800 focus:ring-cyan-500/40 focus:border-cyan-500"
  );
  const field = (
    <div className="relative flex-1">
      <input type="text" inputMode="numeric" value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        disabled={disabled}
        className={cls} aria-label={ariaLabel} />
      {showsTotal && (
        <span className="pointer-events-none absolute -bottom-3.5 left-1/2 -translate-x-1/2 text-[9px] text-zinc-500 tabular-nums whitespace-nowrap">
          = {fmtN(parsed!)}
        </span>
      )}
    </div>
  );
  if (!stepper) return field;

  // Stepper: −/+ adjust the running total by one without needing a "+" key
  // (mobile numeric keyboards have none). Collapses any expression to its sum
  // and writes back a plain integer; onBlur flushes the save immediately so a
  // tap survives the tab being backgrounded.
  const bump = (delta: number) => {
    if (disabled) return;
    const next = Math.max(0, (parseExpr(value) ?? 0) + delta);
    onChange(String(next));
    onBlur?.();
  };
  const atZero = (parseExpr(value) ?? 0) <= 0;
  const stepBtn =
    "flex-shrink-0 w-8 rounded-md border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-100 text-lg leading-none font-medium select-none active:bg-zinc-200 dark:active:bg-zinc-700 disabled:opacity-40 flex items-center justify-center";
  return (
    <div className="flex items-stretch gap-1">
      <button type="button" tabIndex={-1} onClick={() => bump(-1)} disabled={atZero || disabled}
        className={stepBtn} aria-label={`Decrease ${ariaLabel}`}>−</button>
      {field}
      <button type="button" tabIndex={-1} onClick={() => bump(1)} disabled={disabled}
        className={stepBtn} aria-label={`Increase ${ariaLabel}`}>+</button>
    </div>
  );
}

// ─── mobile cards (My view) ──────────────────────────────────────────────
function MobileCards({
  items, appStock, drafts, lastRecon, currentUserId, frozen,
  computeDiff, setField, commitRow, resetMyRow, errorsByItem,
  otherUsersByItem, conflictByItem, doneByUser,
}: {
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
}) {
  return (
    <div className="md:hidden space-y-2">
      {items.map(i => {
        const app = appStock.get(i.id);
        if (!app) return null;
        const my = drafts.get(dkey(currentUserId, i.id)) ?? makeEmptyDraft(currentUserId, i.id);
        const rd = computeDiff(i, app, my);
        const others = otherUsersByItem(i.id);
        const conflict = conflictByItem(i.id);
        const last = lastRecon.get(i.id);
        const errs = errorsByItem.get(i.id);
        const tint = rd.invalid || conflict?.any
          ? "border-rose-500/40"
          : rd.hasAnyChange
            ? "border-amber-500/40"
            : others.length > 0
              ? "border-cyan-500/40"
              : "border-zinc-200 dark:border-zinc-800";
        return (
          <div key={i.id} className={cn("bg-white dark:bg-zinc-900 border rounded-xl p-3 shadow-sm", tint)}>
            <div className="flex items-start justify-between gap-2 mb-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-0.5">
                  {i.brand && (
                    <span className="bg-cyan-500/15 text-cyan-600 dark:text-cyan-300 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-medium flex-shrink-0">
                      {i.brand}
                    </span>
                  )}
                  <span className="text-sm font-semibold truncate">{i.model}</span>
                </div>
                <div className="text-[11px] text-zinc-500 truncate">
                  {[i.size, i.colour, i.categoryName].filter(Boolean).join(" · ")}
                </div>
                <RowMeta last={last} others={others} conflict={conflict} doneByUser={doneByUser} />
              </div>
              {rd.hasAnyChange && !frozen && (
                <button onClick={() => resetMyRow(i.id)} className="text-zinc-400 hover:text-rose-500 p-1.5 -mr-1.5" aria-label="Reset row">
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="grid grid-cols-[auto_1fr] gap-2 items-center mb-3">
              <label className="text-[11px] text-zinc-500 uppercase tracking-wider">Case size</label>
              <ExprInput
                value={my.case_size_raw}
                placeholder={String(rd.csOld)}
                onChange={(v) => setField(currentUserId, i.id, "case_size", v)}
                onBlur={() => commitRow(currentUserId, i.id)}
                disabled={frozen}
                tone={rd.caseSizeChanged ? "amber" : (!rd.caseSizeValid ? "rose" : "neutral")}
                ariaLabel={`Case size for ${i.model}`}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <GodownBlock
                label="Godown A"
                appCases={app.A.cases} appLoose={app.A.loose}
                d_cases={my.a_cases_raw} d_loose={my.a_loose_raw}
                side={rd.A}
                touched={rd.A.userTouched || rd.caseSizeChanged}
                csNew={rd.csNew} csOld={rd.csOld}
                frozen={frozen}
                others={others.map(o => ({ o, name: displayUser(o).split(" ")[0], side: draftSide(o, "A", i.case_size || 0) }))
                  .filter(x => x.side.touched)
                  .map(x => ({
                    name: x.name, pcs: x.side.pcs,
                    delta: (rd.A.userTouched && rd.A.valid) ? x.side.pcs - rd.A.physPieces : null,
                    done: !!doneByUser.get(x.o.user_id)?.done,
                  }))}
                onCases={(v) => setField(currentUserId, i.id, "a_cases", v)}
                onLoose={(v) => setField(currentUserId, i.id, "a_loose", v)}
                onBlur={() => commitRow(currentUserId, i.id)}
                modelHint={`${i.model} A`}
              />
              <GodownBlock
                label="Godown B"
                appCases={app.B.cases} appLoose={app.B.loose}
                d_cases={my.b_cases_raw} d_loose={my.b_loose_raw}
                side={rd.B}
                touched={rd.B.userTouched || rd.caseSizeChanged}
                csNew={rd.csNew} csOld={rd.csOld}
                frozen={frozen}
                others={others.map(o => ({ o, name: displayUser(o).split(" ")[0], side: draftSide(o, "B", i.case_size || 0) }))
                  .filter(x => x.side.touched)
                  .map(x => ({
                    name: x.name, pcs: x.side.pcs,
                    delta: (rd.B.userTouched && rd.B.valid) ? x.side.pcs - rd.B.physPieces : null,
                    done: !!doneByUser.get(x.o.user_id)?.done,
                  }))}
                onCases={(v) => setField(currentUserId, i.id, "b_cases", v)}
                onLoose={(v) => setField(currentUserId, i.id, "b_loose", v)}
                onBlur={() => commitRow(currentUserId, i.id)}
                modelHint={`${i.model} B`}
              />
            </div>

            {errs && errs.length > 0 && (
              <div className="mt-2 text-[11px] text-rose-700 dark:text-rose-300 flex items-start gap-1.5">
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

function GodownBlock({
  label, appCases, appLoose, d_cases, d_loose, side, touched,
  csNew, csOld, others, frozen,
  onCases, onLoose, onBlur, modelHint,
}: {
  label: string;
  appCases: number; appLoose: number;
  d_cases: string; d_loose: string;
  side: RowDiffType["A"];
  touched: boolean;
  csNew: number; csOld: number;
  others: { name: string; pcs: number; delta: number | null; done: boolean }[];
  frozen: boolean;
  onCases: (v: string) => void; onLoose: (v: string) => void;
  onBlur: () => void;
  modelHint: string;
}) {
  return (
    <div className="bg-zinc-50 dark:bg-zinc-800/40 rounded-lg p-2">
      <div className="mb-2">
        <span className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-300 uppercase tracking-wider">{label}</span>
      </div>
      <div className="space-y-2">
        {/* Label stacked ABOVE the input so the −/+ steppers get the full block
            width on narrow phones (a side-by-side label would squeeze the
            field to a few px in the 2-up card). */}
        <div>
          <span className="block text-[10px] text-zinc-500 mb-0.5">Cases</span>
          <ExprInput value={d_cases} placeholder="—" onChange={onCases} onBlur={onBlur} stepper disabled={frozen}
            tone={touched ? (side.valid ? "amber" : "rose") : "neutral"} ariaLabel={`${modelHint} cases`} />
        </div>
        <div>
          <span className="block text-[10px] text-zinc-500 mb-0.5">Loose</span>
          <ExprInput value={d_loose} placeholder="—" onChange={onLoose} onBlur={onBlur} stepper disabled={frozen}
            tone={touched ? (side.valid ? "amber" : "rose") : "neutral"} ariaLabel={`${modelHint} loose`} />
        </div>
      </div>

      {/* System vs counted, with the difference — so the counter always sees
          what the system thinks is here and what they're entering. */}
      <div className="mt-2 pt-2 border-t border-zinc-200/70 dark:border-zinc-700/50 space-y-0.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">In system</span>
          <span className="text-[11px] tabular-nums text-zinc-600 dark:text-zinc-300">{breakupStr(csOld, appCases, appLoose)}</span>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">You count</span>
          {touched && side.valid ? (
            <span className="text-[11px] tabular-nums font-medium text-zinc-800 dark:text-zinc-100">{breakupStr(csNew, side.physCases, side.physLoose)}</span>
          ) : (
            <span className="text-[11px] text-zinc-400">not counted</span>
          )}
        </div>
        {touched && side.valid && (
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[10px] uppercase tracking-wide text-zinc-500">Diff</span>
            <span className={cn(
              "text-[11px] tabular-nums font-semibold",
              side.diff === 0 ? "text-zinc-400" : side.diff > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"
            )}>
              {side.diff > 0 ? "+" : ""}{fmtN(side.diff)} pcs
            </span>
          </div>
        )}
        {/* Other counters' totals for THIS godown, with the delta vs your count
            so you can spot and recheck a disagreement before the reviewer. */}
        {others.map((o, idx) => (
          <div key={idx} className={cn(
            "flex items-baseline justify-between gap-2",
            o.delta !== null && o.delta !== 0 ? "text-rose-600/90 dark:text-rose-400/90 font-medium" : "text-cyan-600/80 dark:text-cyan-400/80"
          )}>
            <span className="text-[10px] truncate">{o.name}{o.done ? " ✓" : ""}</span>
            <span className="text-[10px] tabular-nums flex-shrink-0">
              {fmtN(o.pcs)} pcs{o.delta !== null && o.delta !== 0 ? ` (${o.delta > 0 ? "+" : ""}${fmtN(o.delta)})` : ""}
            </span>
          </div>
        ))}
      </div>
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
        const tint = conflict?.any
          ? "border-rose-500/40"
          : nonEmpty.length > 0
            ? "border-emerald-500/40"
            : "border-zinc-200 dark:border-zinc-800";
        const last = lastRecon.get(i.id);
        const errs = errorsByItem.get(i.id);
        return (
          <div key={i.id} className={cn("bg-white dark:bg-zinc-900 border rounded-lg overflow-hidden", tint)}>
            <div className="px-3 py-2 bg-zinc-50 dark:bg-zinc-900/50 flex items-center gap-3">
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
              <div className="text-right text-[10px] text-zinc-500 tabular-nums">
                <div className="font-medium text-zinc-600 dark:text-zinc-300">System · cs {i.case_size || 0}</div>
                <div>A {fmtN(app.A.cases)}c {fmtN(app.A.loose)}L · B {fmtN(app.B.cases)}c {fmtN(app.B.loose)}L</div>
                {last && <div className="hidden sm:block">Last: {timeAgo(last.at)}{last.userName ? ` by ${last.userName}` : ""}</div>}
              </div>
              {conflict?.any ? (
                <span className="bg-rose-500/15 text-rose-700 dark:text-rose-300 px-2 py-0.5 rounded text-[10px] uppercase tracking-wider font-medium flex-shrink-0">
                  Conflict
                </span>
              ) : ready ? (
                <span className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 px-2 py-0.5 rounded text-[10px] uppercase tracking-wider font-medium flex-shrink-0">
                  Ready
                </span>
              ) : null}
            </div>

            {/* Plain-language reason so the reviewer resolves fast without
                decoding the cells. */}
            {conflict?.any && conflict.reason && (
              <div className="px-3 py-1.5 bg-rose-500/5 border-t border-rose-500/15 text-[11px] text-rose-700 dark:text-rose-300 flex items-start gap-1.5 tabular-nums">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <div>{conflict.reason}</div>
              </div>
            )}

            {rows.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-zinc-500 italic">No counts yet — add one for a counter below, or open My count.</div>
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

            {/* Add a count on behalf of a counter who hasn't entered one. */}
            {canAdd.length > 0 && (
              <div className="px-3 py-2 border-t border-zinc-200/60 dark:border-zinc-800/60 flex items-center gap-2 flex-wrap">
                <UserPlus className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />
                <span className="text-[11px] text-zinc-500">Add a count for</span>
                <select
                  value=""
                  onChange={(e) => { if (e.target.value) onAddCounter(i.id, e.target.value); }}
                  className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1 text-[12px] focus:outline-none focus:border-cyan-500"
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
  // Per-godown computed total: what THIS counter says is in A and in B,
  // each next to the system figure + the difference, shown separately so the
  // reviewer reads A and B at a glance without re-doing the case math.
  const sideTotal = (g: Godown) => {
    const s = g === "A" ? rd.A : rd.B;
    if (!s.userTouched) {
      return (
        <span className="text-zinc-400">
          {g}: <span className="italic">—</span> <span className="text-zinc-400/80">(sys {fmtN(s.appPieces)})</span>
        </span>
      );
    }
    return (
      <span className="text-zinc-600 dark:text-zinc-300">
        {g}: <span className="font-medium tabular-nums text-zinc-800 dark:text-zinc-100">{fmtN(s.physPieces)}</span>{" "}
        <span className="text-zinc-400">
          (sys {fmtN(s.appPieces)}
          {s.valid && <span className={cn(s.diff === 0 ? "" : s.diff > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>{`, ${s.diff > 0 ? "+" : ""}${fmtN(s.diff)}`}</span>})
        </span>
      </span>
    );
  };
  return (
    <div className={cn("px-3 py-2 grid grid-cols-[140px_1fr_24px] sm:grid-cols-[160px_1fr_28px] gap-2 items-start", isMe && "bg-cyan-500/5")}>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <UserCircle2 className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
          <span className="text-[12px] font-medium truncate">{name}{isMe && <span className="text-zinc-400 ml-1">(you)</span>}</span>
          {userDone && (
            <span className="inline-flex items-center gap-0.5 px-1 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-[9px] uppercase tracking-wide font-medium flex-shrink-0">
              <Lock className="w-2.5 h-2.5" /> done
            </span>
          )}
        </div>
        <div className="text-[10px] text-zinc-500 truncate">
          {d.user_role || "—"}{d.updated_at ? ` · ${timeAgo(d.updated_at)}` : ""}
        </div>
      </div>

      <div className="min-w-0">
        <div className="grid grid-cols-5 gap-1.5">
          <ReviewerCell label="Case sz" value={d.case_size_raw} placeholder={String(i.case_size || 0)}
            onChange={(v) => onChange("case_size", v)} onBlur={onBlur} conflict={!!conflict?.case_size}
            tone={tonefor(d.case_size_raw, rd.caseSizeValid, rd.caseSizeChanged)} ariaLabel={`Case size by ${name}`} />
          <ReviewerCell label="A c" value={d.a_cases_raw} placeholder={String(app.A.cases)}
            onChange={(v) => onChange("a_cases", v)} onBlur={onBlur} conflict={!!conflict?.a_cases}
            tone={tonefor(d.a_cases_raw, rd.A.valid, rd.A.userTouched)} ariaLabel={`A cases by ${name}`} />
          <ReviewerCell label="A L" value={d.a_loose_raw} placeholder={String(app.A.loose)}
            onChange={(v) => onChange("a_loose", v)} onBlur={onBlur} conflict={!!conflict?.a_loose}
            tone={tonefor(d.a_loose_raw, rd.A.valid, rd.A.userTouched)} ariaLabel={`A loose by ${name}`} />
          <ReviewerCell label="B c" value={d.b_cases_raw} placeholder={String(app.B.cases)}
            onChange={(v) => onChange("b_cases", v)} onBlur={onBlur} conflict={!!conflict?.b_cases}
            tone={tonefor(d.b_cases_raw, rd.B.valid, rd.B.userTouched)} ariaLabel={`B cases by ${name}`} />
          <ReviewerCell label="B L" value={d.b_loose_raw} placeholder={String(app.B.loose)}
            onChange={(v) => onChange("b_loose", v)} onBlur={onBlur} conflict={!!conflict?.b_loose}
            tone={tonefor(d.b_loose_raw, rd.B.valid, rd.B.userTouched)} ariaLabel={`B loose by ${name}`} />
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] tabular-nums">
          {sideTotal("A")}
          {sideTotal("B")}
          {/* Apply just this item to stock using THIS counter's numbers — the
              admin's per-item, pick-the-value adjustment. */}
          {canApply && (
            <button
              type="button"
              onClick={onApply}
              disabled={applying}
              className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium border border-emerald-500/50 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
              title={`Apply ${name}'s count to stock for this item`}
            >
              {applying ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
              Apply this count
            </button>
          )}
        </div>
      </div>

      <button onClick={onClear} disabled={applying} className="text-zinc-400 hover:text-rose-500 p-1 self-center disabled:opacity-40" title={`Clear ${name}'s draft`} aria-label={`Clear ${name}'s draft`}>
        <RotateCcw className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function tonefor(raw: string, valid: boolean, touched: boolean): "neutral" | "amber" | "rose" {
  if (raw.trim() === "") return "neutral";
  if (!valid) return "rose";
  if (touched) return "amber";
  return "neutral";
}

function ReviewerCell({
  label, value, placeholder, onChange, onBlur, conflict, tone, ariaLabel,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  onBlur: () => void;
  conflict: boolean;
  tone: "neutral" | "amber" | "rose";
  ariaLabel: string;
}) {
  const effectiveTone = conflict ? "rose" : tone;
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className={cn("text-[9px] uppercase tracking-wider font-medium", conflict ? "text-rose-500" : "text-zinc-500")}>{label}</span>
      <ExprInput value={value} placeholder={placeholder} onChange={onChange} onBlur={onBlur} tone={effectiveTone} ariaLabel={ariaLabel} compact />
    </div>
  );
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
          <strong>Add a count for</strong> at the bottom of each item lets you enter a count on behalf of a counter who didn't. And <strong>Apply this count</strong> on any row commits <em>just that item</em> to stock using that counter's numbers — your pick-the-value, item-by-item adjustment (overrides a conflict). <strong>Make adjustments</strong> still bulk-commits every agreed item at once.
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
