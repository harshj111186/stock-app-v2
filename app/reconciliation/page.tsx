"use client";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Printer, ClipboardCheck, CheckCircle2, AlertCircle,
  RotateCcw, Loader2, Eraser, Filter, Eye, EyeOff, Users, ShieldCheck,
  UserCircle2, Clock,
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
  const [lastRecon, setLastRecon] = useState<Map<string, LastReconciled>>(new Map());
  const [loaded, setLoaded] = useState(false);

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
      c.from("user_profiles").select("id, name, email"),
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

    // 1) Other users' rows — server is the source of truth.
    for (const [k, local] of [...prev]) {
      if (local.user_id !== myId && !serverByKey.has(k)) next.delete(k);
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

  useEffect(() => {
    // Pause polling during a commit — makeAdjustments mutates godown_stock one
    // row at a time, and a mid-commit refreshAppStock would flicker the diff
    // column as rows land. The post-commit load() is the authoritative refresh.
    if (!loaded || processing) return;
    const onVis = () => { if (document.visibilityState === "visible") { void refreshDrafts(); void refreshAppStock(); } };
    document.addEventListener("visibilitychange", onVis);
    // Admin actively reviewing — refresh fast (3s) so staff typing shows up
    // near-live. Otherwise (My count for everyone) drop to 30s; the user
    // doesn't need to see other counters' updates while they're entering
    // their own count.
    const intervalMs = mode === "reviewer" ? 3000 : 30000;
    const id = window.setInterval(() => { void refreshDrafts(); void refreshAppStock(); }, intervalMs);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.clearInterval(id);
    };
  }, [loaded, processing, refreshDrafts, refreshAppStock, mode]);

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
      const physCases = pc ?? appSide.cases;
      const physLoose = pl ?? appSide.loose;
      const appPieces = pieces(csOld, appSide.cases, appSide.loose);
      const physPieces = pieces(csNew, physCases, physLoose);
      const valid =
        (cRaw.trim() === "" || pc !== null) &&
        (lRaw.trim() === "" || pl !== null);
      const userTouched = cRaw.trim() !== "" || lRaw.trim() !== "";
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

  // Item-level conflict: across the drafts for this item, is there any
  // field where two users entered different non-empty values?
  type ItemConflict = {
    case_size: boolean;
    a_cases: boolean;
    a_loose: boolean;
    b_cases: boolean;
    b_loose: boolean;
    any: boolean;
  };
  const computeItemConflict = (drs: DBDraft[]): ItemConflict => {
    const distinct = (key: keyof DBDraft) => {
      const s = new Set<number>();
      for (const d of drs) {
        const raw = String(d[key] || "");
        if (!raw.trim()) continue;
        const p = parseExpr(raw);
        if (p === null) continue; // invalid → not counted as a value
        s.add(p);
      }
      return s.size > 1;
    };
    const cs = distinct("case_size_raw");
    const ac = distinct("a_cases_raw");
    const al = distinct("a_loose_raw");
    const bc = distinct("b_cases_raw");
    const bl = distinct("b_loose_raw");
    return { case_size: cs, a_cases: ac, a_loose: al, b_cases: bc, b_loose: bl, any: cs || ac || al || bc || bl };
  };

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
      const hay = `${i.brand || ""} ${i.model} ${i.size} ${i.colour} ${i.categoryName || ""} ${i.subcategory || ""} ${i.item_code}`;
      if (!matchesQuery(hay, q)) return false;
      return true;
    });
  }, [itemsEnriched, q, brand, cat, showOnlyChanged, draftsByItem, mode, profile?.id]);

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
      const c = computeItemConflict(drs);
      if (c.any) conflicts++;
    });
    return { myStaged, anyStaged, conflicts, invalid, usersWithDrafts };
  }, [items, appStock, draftsByItem, computeDiff, profile?.id]);

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
      const conflict = computeItemConflict(nonEmpty);
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
  };

  // ─── render ────────────────────────────────────────────────────────────
  return (
    <Shell title="Reconciliation">
      <div className="no-print">
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
          brands={brands} cats={cats}
          shownCount={filtered.length}
          mode={mode} setMode={setMode} isAdmin={isAdmin}
          usersWithDrafts={stats.usersWithDrafts.size}
          onPrint={() => window.print()}
          onCommit={makeAdjustments}
          canCommit={canCommit && stats.anyStaged > 0 && !processing}
          processing={processing}
          progress={progress}
        />

        {!loaded ? (
          <SkeletonBody />
        ) : filtered.length === 0 ? (
          <EmptyState clearFilters={() => { setQ(""); setBrand(""); setCat(""); setShowOnlyChanged(false); }} />
        ) : mode === "my" ? (
          <MyView
            items={filtered}
            appStock={appStock}
            drafts={drafts}
            lastRecon={lastRecon}
            currentUserId={profile?.id ?? ""}
            computeDiff={computeDiff}
            setField={setField}
            flushSaves={flushAllPendingSaves}
            resetMyRow={(itemId) => { if (profile?.id) void deleteDraft(profile.id, itemId); }}
            errorsByItem={errorsByItem(errors)}
            otherUsersByItem={(itemId) => {
              const drs = draftsByItem.get(itemId) || [];
              return drs.filter(d => d.user_id !== profile?.id && !isDraftEmpty(d));
            }}
            conflictByItem={(itemId) => {
              const drs = (draftsByItem.get(itemId) || []).filter(d => !isDraftEmpty(d));
              return drs.length > 1 ? computeItemConflict(drs) : null;
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
            flushSaves={flushAllPendingSaves}
            deleteDraft={deleteDraft}
            currentUserId={profile?.id ?? ""}
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
  brands, cats, shownCount,
  mode, setMode, isAdmin, usersWithDrafts,
  onPrint, onCommit, canCommit, processing, progress,
}: {
  q: string; setQ: (s: string) => void;
  brand: string; setBrand: (s: string) => void;
  cat: string; setCat: (s: string) => void;
  showOnlyChanged: boolean; setShowOnlyChanged: (b: boolean) => void;
  brands: string[]; cats: string[]; shownCount: number;
  mode: "my" | "reviewer"; setMode: (m: "my" | "reviewer") => void;
  isAdmin: boolean; usersWithDrafts: number;
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
  any: boolean;
};

// ─── MyView (default for everyone) ───────────────────────────────────────
function MyView({
  items, appStock, drafts, lastRecon, currentUserId,
  computeDiff, setField, flushSaves, resetMyRow, errorsByItem,
  otherUsersByItem, conflictByItem,
}: {
  items: (Item & { categoryName: string | null })[];
  appStock: Map<string, { A: AppStock; B: AppStock }>;
  drafts: Map<DraftKey, DBDraft>;
  lastRecon: Map<string, LastReconciled>;
  currentUserId: string;
  computeDiff: (i: Item, app: { A: AppStock; B: AppStock }, d: DBDraft) => RowDiffType;
  setField: (uid: string, iid: string, f: Field, v: string) => void;
  flushSaves: () => void;
  resetMyRow: (itemId: string) => void;
  errorsByItem: Map<string, string[]>;
  otherUsersByItem: (itemId: string) => DBDraft[];
  conflictByItem: (itemId: string) => ItemConflictType | null;
}) {
  return (
    <>
      <DesktopTable
        items={items}
        appStock={appStock}
        drafts={drafts}
        lastRecon={lastRecon}
        currentUserId={currentUserId}
        computeDiff={computeDiff}
        setField={setField}
        flushSaves={flushSaves}
        resetMyRow={resetMyRow}
        errorsByItem={errorsByItem}
        otherUsersByItem={otherUsersByItem}
        conflictByItem={conflictByItem}
      />
      <MobileCards
        items={items}
        appStock={appStock}
        drafts={drafts}
        lastRecon={lastRecon}
        currentUserId={currentUserId}
        computeDiff={computeDiff}
        setField={setField}
        flushSaves={flushSaves}
        resetMyRow={resetMyRow}
        errorsByItem={errorsByItem}
        otherUsersByItem={otherUsersByItem}
        conflictByItem={conflictByItem}
      />
    </>
  );
}

// ─── DesktopTable (My view) ──────────────────────────────────────────────
function DesktopTable({
  items, appStock, drafts, lastRecon, currentUserId,
  computeDiff, setField, flushSaves, resetMyRow, errorsByItem,
  otherUsersByItem, conflictByItem,
}: {
  items: (Item & { categoryName: string | null })[];
  appStock: Map<string, { A: AppStock; B: AppStock }>;
  drafts: Map<DraftKey, DBDraft>;
  lastRecon: Map<string, LastReconciled>;
  currentUserId: string;
  computeDiff: (i: Item, app: { A: AppStock; B: AppStock }, d: DBDraft) => RowDiffType;
  setField: (uid: string, iid: string, f: Field, v: string) => void;
  flushSaves: () => void;
  resetMyRow: (itemId: string) => void;
  errorsByItem: Map<string, string[]>;
  otherUsersByItem: (itemId: string) => DBDraft[];
  conflictByItem: (itemId: string) => ItemConflictType | null;
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
                onChange={(field, value) => setField(currentUserId, i.id, field, value)}
                onBlur={flushSaves}
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
  i, app, d, rd, others, conflict, last, onChange, onBlur, onReset, errors,
}: {
  i: Item & { categoryName: string | null };
  app: { A: AppStock; B: AppStock };
  d: DBDraft;
  rd: RowDiffType;
  others: DBDraft[];
  conflict: ItemConflictType | null;
  last?: LastReconciled;
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
              <RowMeta last={last} others={others} conflict={conflict} />
            </div>
          </div>
        </td>
        <td className="px-2 py-2">
          <ExprInput
            value={d.case_size_raw}
            placeholder={String(rd.csOld)}
            onChange={(v) => onChange("case_size", v)}
            onBlur={onBlur}
            tone={rd.caseSizeChanged ? "amber" : (!rd.caseSizeValid ? "rose" : "neutral")}
            ariaLabel={`Case size for ${i.model}`}
          />
        </td>
        <td className="px-2 py-2">
          <ExprInput value={d.a_cases_raw} placeholder={String(app.A.cases)}
            onChange={(v) => onChange("a_cases", v)}
            onBlur={onBlur}
            tone={rd.A.userTouched ? (rd.A.valid ? "amber" : "rose") : "neutral"}
            ariaLabel={`Godown A cases for ${i.model}`} />
        </td>
        <td className="px-2 py-2">
          <ExprInput value={d.a_loose_raw} placeholder={String(app.A.loose)}
            onChange={(v) => onChange("a_loose", v)}
            onBlur={onBlur}
            tone={rd.A.userTouched ? (rd.A.valid ? "amber" : "rose") : "neutral"}
            ariaLabel={`Godown A loose for ${i.model}`} />
        </td>
        <td className="px-2 py-2">
          <ExprInput value={d.b_cases_raw} placeholder={String(app.B.cases)}
            onChange={(v) => onChange("b_cases", v)}
            onBlur={onBlur}
            tone={rd.B.userTouched ? (rd.B.valid ? "amber" : "rose") : "neutral"}
            ariaLabel={`Godown B cases for ${i.model}`} />
        </td>
        <td className="px-2 py-2">
          <ExprInput value={d.b_loose_raw} placeholder={String(app.B.loose)}
            onChange={(v) => onChange("b_loose", v)}
            onBlur={onBlur}
            tone={rd.B.userTouched ? (rd.B.valid ? "amber" : "rose") : "neutral"}
            ariaLabel={`Godown B loose for ${i.model}`} />
        </td>
        <td className="px-3 py-2 align-top">
          <BreakupCell rd={rd} app={app} item={i} others={others} />
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

function RowMeta({ last, others, conflict }: { last?: LastReconciled; others: DBDraft[]; conflict: ItemConflictType | null }) {
  const lines: React.ReactNode[] = [];
  if (last) {
    lines.push(
      <span key="last" className="inline-flex items-center gap-1 text-[10px] text-zinc-400">
        <Clock className="w-3 h-3" /> Last: {timeAgo(last.at)}{last.userName ? ` by ${last.userName}` : ""}
      </span>
    );
  }
  if (others.length > 0) {
    const names = others.map(displayUser).join(", ");
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
  if (lines.length === 0) return null;
  return <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">{lines}</div>;
}

// Per-godown breakup shown in the My-count desktop table. For each godown:
//   - the user's entered count as "Xc×cs + YL = Z pcs" (only when they
//     touched that side or changed the case size)
//   - the app's current value as a grey "app: …" reference
//   - any other counters' entered totals for that godown
function BreakupCell({
  rd, app, item, others,
}: {
  rd: RowDiffType;
  app: { A: AppStock; B: AppStock };
  item: Item;
  others: DBDraft[];
}) {
  const itemCs = item.case_size || 0;
  const row = (g: Godown) => {
    const side = g === "A" ? rd.A : rd.B;
    const appSide = g === "A" ? app.A : app.B;
    const youShown = side.userTouched || rd.caseSizeChanged;
    const othersForG = others
      .map(o => ({ name: displayUser(o), s: draftSide(o, g, itemCs) }))
      .filter(o => o.s.touched);
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
          {othersForG.map((o, idx) => (
            <span key={idx} className="text-[10px] tabular-nums text-cyan-600/80 dark:text-cyan-400/80">
              {o.name.split(" ")[0]} {fmtN(o.s.pcs)}
            </span>
          ))}
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
  value, placeholder, onChange, onBlur, tone, ariaLabel, compact = false, stepper = false,
}: {
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  tone: "neutral" | "amber" | "rose";
  ariaLabel: string;
  compact?: boolean;
  stepper?: boolean;
}) {
  const parsed = parseExpr(value);
  const showsTotal = value.includes("+") && parsed !== null;
  const cls = cn(
    "w-full tabular-nums text-center text-sm bg-white dark:bg-zinc-900 border rounded-md focus:outline-none focus:ring-1",
    compact ? "px-1 py-0.5 text-[12px]" : "px-1.5 py-1",
    tone === "amber" && "border-amber-500/50 focus:ring-amber-500/40 focus:border-amber-500",
    tone === "rose" && "border-rose-500/60 focus:ring-rose-500/40 focus:border-rose-500",
    tone === "neutral" && "border-zinc-200 dark:border-zinc-800 focus:ring-cyan-500/40 focus:border-cyan-500"
  );
  const field = (
    <div className="relative flex-1">
      <input type="text" inputMode="numeric" value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
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
    const next = Math.max(0, (parseExpr(value) ?? 0) + delta);
    onChange(String(next));
    onBlur?.();
  };
  const atZero = (parseExpr(value) ?? 0) <= 0;
  const stepBtn =
    "flex-shrink-0 w-8 rounded-md border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-100 text-lg leading-none font-medium select-none active:bg-zinc-200 dark:active:bg-zinc-700 disabled:opacity-40 flex items-center justify-center";
  return (
    <div className="flex items-stretch gap-1">
      <button type="button" tabIndex={-1} onClick={() => bump(-1)} disabled={atZero}
        className={stepBtn} aria-label={`Decrease ${ariaLabel}`}>−</button>
      {field}
      <button type="button" tabIndex={-1} onClick={() => bump(1)}
        className={stepBtn} aria-label={`Increase ${ariaLabel}`}>+</button>
    </div>
  );
}

// ─── mobile cards (My view) ──────────────────────────────────────────────
function MobileCards({
  items, appStock, drafts, lastRecon, currentUserId,
  computeDiff, setField, flushSaves, resetMyRow, errorsByItem,
  otherUsersByItem, conflictByItem,
}: {
  items: (Item & { categoryName: string | null })[];
  appStock: Map<string, { A: AppStock; B: AppStock }>;
  drafts: Map<DraftKey, DBDraft>;
  lastRecon: Map<string, LastReconciled>;
  currentUserId: string;
  computeDiff: (i: Item, app: { A: AppStock; B: AppStock }, d: DBDraft) => RowDiffType;
  setField: (uid: string, iid: string, f: Field, v: string) => void;
  flushSaves: () => void;
  resetMyRow: (itemId: string) => void;
  errorsByItem: Map<string, string[]>;
  otherUsersByItem: (itemId: string) => DBDraft[];
  conflictByItem: (itemId: string) => ItemConflictType | null;
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
                <RowMeta last={last} others={others} conflict={conflict} />
              </div>
              {rd.hasAnyChange && (
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
                onBlur={flushSaves}
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
                others={others.map(o => ({ name: displayUser(o).split(" ")[0], side: draftSide(o, "A", i.case_size || 0) }))
                  .filter(o => o.side.touched).map(o => ({ name: o.name, pcs: o.side.pcs }))}
                onCases={(v) => setField(currentUserId, i.id, "a_cases", v)}
                onLoose={(v) => setField(currentUserId, i.id, "a_loose", v)}
                onBlur={flushSaves}
                modelHint={`${i.model} A`}
              />
              <GodownBlock
                label="Godown B"
                appCases={app.B.cases} appLoose={app.B.loose}
                d_cases={my.b_cases_raw} d_loose={my.b_loose_raw}
                side={rd.B}
                touched={rd.B.userTouched || rd.caseSizeChanged}
                csNew={rd.csNew} csOld={rd.csOld}
                others={others.map(o => ({ name: displayUser(o).split(" ")[0], side: draftSide(o, "B", i.case_size || 0) }))
                  .filter(o => o.side.touched).map(o => ({ name: o.name, pcs: o.side.pcs }))}
                onCases={(v) => setField(currentUserId, i.id, "b_cases", v)}
                onLoose={(v) => setField(currentUserId, i.id, "b_loose", v)}
                onBlur={flushSaves}
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
  csNew, csOld, others,
  onCases, onLoose, onBlur, modelHint,
}: {
  label: string;
  appCases: number; appLoose: number;
  d_cases: string; d_loose: string;
  side: RowDiffType["A"];
  touched: boolean;
  csNew: number; csOld: number;
  others: { name: string; pcs: number }[];
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
          <ExprInput value={d_cases} placeholder={String(appCases)} onChange={onCases} onBlur={onBlur} stepper
            tone={touched ? (side.valid ? "amber" : "rose") : "neutral"} ariaLabel={`${modelHint} cases`} />
        </div>
        <div>
          <span className="block text-[10px] text-zinc-500 mb-0.5">Loose</span>
          <ExprInput value={d_loose} placeholder={String(appLoose)} onChange={onLoose} onBlur={onBlur} stepper
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
        {others.map((o, idx) => (
          <div key={idx} className="flex items-baseline justify-between gap-2 text-cyan-600/80 dark:text-cyan-400/80">
            <span className="text-[10px] truncate">{o.name}</span>
            <span className="text-[10px] tabular-nums flex-shrink-0">{fmtN(o.pcs)} pcs</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── ReviewerView (admin only) ───────────────────────────────────────────
function ReviewerView({
  items, appStock, draftsByItem, lastRecon, computeDiff, computeItemConflict,
  setField, flushSaves, deleteDraft, currentUserId, errorsByItem,
}: {
  items: (Item & { categoryName: string | null })[];
  appStock: Map<string, { A: AppStock; B: AppStock }>;
  draftsByItem: Map<string, DBDraft[]>;
  lastRecon: Map<string, LastReconciled>;
  computeDiff: (i: Item, app: { A: AppStock; B: AppStock }, d: DBDraft) => RowDiffType;
  computeItemConflict: (drs: DBDraft[]) => ItemConflictType;
  setField: (uid: string, iid: string, f: Field, v: string) => void;
  flushSaves: () => void;
  deleteDraft: (uid: string, iid: string) => void;
  currentUserId: string;
  errorsByItem: Map<string, string[]>;
}) {
  return (
    <div className="space-y-3">
      {items.map(i => {
        const app = appStock.get(i.id);
        if (!app) return null;
        const drs = draftsByItem.get(i.id) || [];
        const nonEmpty = drs.filter(d => !isDraftEmpty(d));
        const conflict = nonEmpty.length > 1 ? computeItemConflict(nonEmpty) : null;
        const tint = conflict?.any
          ? "border-rose-500/40"
          : nonEmpty.length > 0
            ? "border-amber-500/40"
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
              {conflict?.any && (
                <span className="bg-rose-500/15 text-rose-700 dark:text-rose-300 px-2 py-0.5 rounded text-[10px] uppercase tracking-wider font-medium flex-shrink-0">
                  Conflict
                </span>
              )}
            </div>

            {nonEmpty.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-zinc-500 italic">No drafts yet — open My count to add yours.</div>
            ) : (
              <div className="divide-y divide-zinc-200/60 dark:divide-zinc-800/60">
                {drs.map(d => (
                  <ReviewerUserRow
                    key={d.user_id}
                    i={i}
                    app={app}
                    d={d}
                    conflict={conflict}
                    isMe={d.user_id === currentUserId}
                    computeDiff={computeDiff}
                    onChange={(field, value) => setField(d.user_id, i.id, field, value)}
                    onBlur={flushSaves}
                    onClear={() => deleteDraft(d.user_id, i.id)}
                  />
                ))}
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
  i, app, d, conflict, isMe, computeDiff, onChange, onBlur, onClear,
}: {
  i: Item;
  app: { A: AppStock; B: AppStock };
  d: DBDraft;
  conflict: ItemConflictType | null;
  isMe: boolean;
  computeDiff: (i: Item, app: { A: AppStock; B: AppStock }, d: DBDraft) => RowDiffType;
  onChange: (field: Field, value: string) => void;
  onBlur: () => void;
  onClear: () => void;
}) {
  const rd = computeDiff(i, app, d);
  const name = displayUser(d);
  return (
    <div className={cn("px-3 py-2 grid grid-cols-[140px_1fr_24px] sm:grid-cols-[160px_1fr_28px] gap-2 items-start", isMe && "bg-cyan-500/5")}>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <UserCircle2 className="w-3.5 h-3.5 text-zinc-500" />
          <span className="text-[12px] font-medium truncate">{name}{isMe && <span className="text-zinc-400 ml-1">(you)</span>}</span>
        </div>
        <div className="text-[10px] text-zinc-500 truncate">
          {d.user_role || "—"}{d.updated_at ? ` · ${timeAgo(d.updated_at)}` : ""}
        </div>
      </div>

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

      <button onClick={onClear} className="text-zinc-400 hover:text-rose-500 p-1 self-center" title={`Clear ${name}'s draft`} aria-label={`Clear ${name}'s draft`}>
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
        <strong>Per-user drafts:</strong> each counter has their own list. Your numbers don't overwrite anyone else's. Drafts autosave to the server, so closing the tab is safe.
      </div>
      {!isAdmin && (
        <div>
          <strong>No commit button:</strong> only admin commits. Once your count is done, tell admin to review and adjust.
        </div>
      )}
      {isAdmin && (
        <div>
          <strong>Reviewer mode</strong> shows every user's draft for each item. If two users disagree, the item is flagged{" "}
          <span className="inline-block px-1 bg-rose-500/15 text-rose-700 dark:text-rose-300 rounded text-[10px]">Conflict</span> and skipped from commit. Edit anyone's row inline to resolve, or ask them to recount.
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
