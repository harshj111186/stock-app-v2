"use client";
import { Fragment, useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine, ArrowUpFromLine, ArrowLeftRight, Wrench, Undo2,
  Search, RotateCcw, Loader2, CheckCircle2, AlertCircle,
  ArrowDown, ArrowUp, Plus, Play, Trash2, X, ListChecks, Boxes,
} from "lucide-react";
import { Shell } from "@/components/shell";
import { useAuth } from "@/app/providers";
import { sb, type Item, type Stock, type Txn } from "@/lib/supabase";
import { fmtN, fmtMoney, matchesQuery } from "@/lib/utils";
import { SearchBox } from "@/components/search-box";

// ─── types ────────────────────────────────────────────────────────────────
type ActionKind = "Purchase" | "Sale" | "Transfer" | "Adjustment" | "Return";
type StockMap = Record<string, { A: Stock; B: Stock }>;

type FormState = {
  action: ActionKind;
  item_id: string;
  godown: "A" | "B";
  to_godown: "A" | "B";
  cartons: string;
  loose: string;
  rate: string;
  invoice_no: string;
  party_name: string;
  reason: string;
  return_dir: 1 | -1;
  date: string;
};

// A row queued for batch processing. Captures all user-entered fields plus
// the computed total_qty and resolved direction so the queue table can render
// and the processor can fire RPCs without re-doing form math.
type QueuedTxn = {
  uid: string;
  action: ActionKind;
  item_id: string;
  godown: "A" | "B";
  to_godown: "A" | "B";
  cartons: number;
  loose: number;
  total_qty: number;
  rate: string;
  invoice_no: string;
  party_name: string;
  reason: string;
  return_dir: 1 | -1;
  direction: number | null; // null for Purchase/Sale/Transfer (SQL resolves); ±1 for Adj/Return
  date: string;
};

type ProcessError = { rowUid: string; message: string };

const TODAY = () => new Date().toISOString().slice(0, 10);

const initialForm = (): FormState => ({
  action: "Purchase",
  item_id: "",
  godown: "A",
  to_godown: "B",
  cartons: "",
  loose: "",
  rate: "",
  invoice_no: "",
  party_name: "",
  reason: "",
  return_dir: 1,
  date: TODAY(),
});

const ALL_ACTIONS: ActionKind[] = ["Purchase", "Sale", "Transfer", "Adjustment", "Return"];

// Adjustment Reason → direction. Slugs map to ±1; SQL never parses these
// strings, it trusts the p_direction we pass alongside.
const ADJ_DIRECTION: Record<string, 1 | -1> = {
  found: 1,
  count_up: 1,
  customer_return_to_shelf: 1,
  damage: -1,
  lost: -1,
  count_down: -1,
};

// ─── queue helpers ────────────────────────────────────────────────────────
// Processing priority — LOWER runs first. The whole point of the queue is
// to maximise stock at every godown before any outbound move is attempted,
// so the order is:
//   1 = Purchase                 (+ stock at chosen godown)
//   2 = Adjustment going up      (+ stock at chosen godown)
//   3 = Customer return          (+ stock at chosen godown)
//   4 = Transfer                 (move between A and B)
//   5 = Adjustment going down    (- stock at chosen godown)
//   6 = Sale                     (- stock at chosen godown)
//   7 = Supplier return          (- stock at chosen godown)
function priorityOf(t: QueuedTxn): number {
  if (t.action === "Purchase") return 1;
  if (t.action === "Adjustment") return t.direction === 1 ? 2 : 5;
  if (t.action === "Return")     return t.return_dir === 1 ? 3 : 7;
  if (t.action === "Transfer")   return 4;
  if (t.action === "Sale")       return 6;
  return 99;
}

const PRIORITY_LABEL: Record<number, string> = {
  1: "1 · Purchase",
  2: "2 · Adj UP",
  3: "3 · Cust return",
  4: "4 · Transfer",
  5: "5 · Adj DOWN",
  6: "6 · Sale",
  7: "7 · Supp return",
};

// Effect on stock per (item, godown). Transfer affects two godowns at once.
type StockDelta = { godown: "A" | "B"; delta: number; transferTo?: { godown: "A" | "B"; delta: number } };
function deltaOf(t: QueuedTxn): StockDelta {
  const q = t.total_qty;
  if (t.action === "Purchase") return { godown: t.godown, delta: +q };
  if (t.action === "Sale")     return { godown: t.godown, delta: -q };
  if (t.action === "Transfer") return { godown: t.godown, delta: -q, transferTo: { godown: t.to_godown, delta: +q } };
  if (t.action === "Adjustment") return { godown: t.godown, delta: (t.direction || 0) * q };
  if (t.action === "Return")     return { godown: t.godown, delta: (t.return_dir || 0) * q };
  return { godown: t.godown, delta: 0 };
}

function makeUid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// True for transport-layer failures (offline, connection reset, tab suspended
// mid-request) — Safari throws a TypeError "Load failed", Chrome "Failed to
// fetch". These are transient and worth retrying. A real DB rejection (a stock
// check, a constraint) is a PostgrestError with a code/hint — deterministic, so
// retrying it is pointless and it should fail straight away.
function isNetworkError(e: any): boolean {
  if (e instanceof TypeError) return true;
  const msg = (e?.message || "").toLowerCase();
  return (
    msg.includes("load failed") ||
    msg.includes("failed to fetch") ||
    msg.includes("networkerror") ||
    msg.includes("network request failed") ||
    msg.includes("network error")
  );
}

// ─── page ─────────────────────────────────────────────────────────────────
export default function TransactionsPage() {
  const { profile } = useAuth();
  const canWrite = profile?.role === "admin" || profile?.role === "staff";

  const [items, setItems] = useState<Item[]>([]);
  const [stock, setStock] = useState<StockMap>({});
  const [txns, setTxns] = useState<Txn[]>([]);
  const [loaded, setLoaded] = useState(false);

  const [f, setF] = useState<FormState>(initialForm());
  const [toast, setToast] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);

  const [logFilter, setLogFilter] = useState<ActionKind | "">("");
  const [logQuery, setLogQuery] = useState("");
  const [reversingId, setReversingId] = useState<string | null>(null);

  // ── batch queue state ──────────────────────────────────────────────────
  const [queue, setQueue] = useState<QueuedTxn[]>([]);
  const [nameById, setNameById] = useState<Map<string, string>>(new Map());
  const [processing, setProcessing] = useState(false);
  const [processIdx, setProcessIdx] = useState<number>(0);
  const [processErrors, setProcessErrors] = useState<ProcessError[]>([]);

  // ── case-size gate: if the user is adding a row for an item with no
  // case_size, intercept and prompt for one before the row hits the queue.
  // Admin can save the new case_size to items; staff can only skip-as-loose.
  const [pendingCaseSize, setPendingCaseSize] = useState<{ itemId: string; rowToAdd: QueuedTxn } | null>(null);
  const [savingCaseSize, setSavingCaseSize] = useState(false);
  const isAdmin = profile?.role === "admin";

  useEffect(() => {
    try {
      const last = localStorage.getItem("txn.lastAction");
      if (last && (ALL_ACTIONS as string[]).includes(last)) {
        setF((x) => ({ ...x, action: last as ActionKind }));
      }
    } catch { /* ignore */ }
  }, []);

  const reload = async () => {
    const c = sb();
    const [{ data: rows }, { data: st }, { data: t }, { data: profs }, { data: qd }] = await Promise.all([
      c.from("items").select("*").eq("archived", false).order("model"),
      c.from("godown_stock").select("*"),
      c.from("transactions").select("*").order("created_at", { ascending: false }).limit(200),
      c.from("user_profiles").select("id, name, email"),
      c.from("transaction_queue").select("*").order("created_at"),  // RLS → only my rows
    ]);
    setItems((rows || []) as Item[]);
    const sMap: StockMap = {};
    (st || []).forEach((s: any) => {
      sMap[s.item_id] = sMap[s.item_id] || {
        A: { item_id: s.item_id, godown: "A", cases: 0, loose: 0 },
        B: { item_id: s.item_id, godown: "B", cases: 0, loose: 0 },
      };
      sMap[s.item_id][s.godown as "A" | "B"] = s as Stock;
    });
    setStock(sMap);
    setTxns((t || []) as Txn[]);
    const nm = new Map<string, string>();
    (profs || []).forEach((p: any) => nm.set(p.id, p.name?.trim() || p.email?.split("@")[0] || ""));
    setNameById(nm);
    // Hydrate the queue from the user's persisted rows so it survives leaving
    // the app / refresh / switching device.
    setQueue((qd || []).map((r: any): QueuedTxn => ({
      uid: r.id, action: r.action, item_id: r.item_id, godown: r.godown,
      to_godown: r.to_godown ?? r.godown, cartons: r.cartons ?? 0, loose: r.loose ?? 0,
      total_qty: r.total_qty ?? 0, rate: r.rate ?? "", invoice_no: r.invoice_no ?? "",
      party_name: r.party_name ?? "", reason: r.reason ?? "", return_dir: (r.return_dir ?? 1) as 1 | -1,
      direction: r.direction ?? null, date: r.txn_date,
    })));
    setLoaded(true);
  };
  useEffect(() => { reload(); }, []);

  const itemById = useMemo(() => {
    const m = new Map<string, Item>();
    items.forEach((i) => m.set(i.id, i));
    return m;
  }, [items]);

  const selectedItem = f.item_id ? itemById.get(f.item_id) : null;
  const cs = selectedItem?.case_size || 0;
  const cartonsN = Number(f.cartons || 0);
  const looseN = Number(f.loose || 0);
  const totalQty = cs > 0 ? cartonsN * cs + looseN : looseN;

  const showToast = (kind: "ok" | "bad", text: string) => {
    setToast({ kind, text });
    setTimeout(() => setToast(null), 4000);
  };

  // created_by → display name (— for unknown / removed users).
  const nameOf = (id: string | null | undefined) => (id ? nameById.get(id) || "—" : "—");

  // Direction the current form will produce (-1, +1, or null for actions where
  // the SQL resolves it).
  const formDirection: 1 | -1 | null = (() => {
    if (f.action === "Purchase") return 1;
    if (f.action === "Sale") return -1;
    if (f.action === "Transfer") return -1;
    if (f.action === "Adjustment") return f.reason ? (ADJ_DIRECTION[f.reason] ?? null) : null;
    if (f.action === "Return") return f.return_dir;
    return null;
  })();

  // Queue sorted by processing priority — this IS the order rows will run in.
  const sortedQueue = useMemo(() => {
    return [...queue].sort((a, b) => {
      const dp = priorityOf(a) - priorityOf(b);
      if (dp !== 0) return dp;
      return a.uid.localeCompare(b.uid); // stable tiebreak by insertion
    });
  }, [queue]);

  // ── Pre-flight: simulate the stock walk for the queue ─────────────────
  // For every item touched by the queue, start from its current godown
  // balance and apply each row's delta in priority order. If any step would
  // take a godown below zero, flag that row.
  type RowSnapshot = { uid: string; A: number; B: number; warning?: string };
  const preflight = useMemo<{ ok: boolean; snapshots: RowSnapshot[]; firstError: string | null }>(() => {
    if (sortedQueue.length === 0) return { ok: true, snapshots: [], firstError: null };

    const sim: Record<string, { A: number; B: number }> = {};
    const getOrInit = (itemId: string) => {
      if (sim[itemId]) return sim[itemId];
      const s = stock[itemId];
      const item = itemById.get(itemId);
      const cs = item?.case_size || 0;
      const aTotal = s?.A ? (cs > 0 ? s.A.cases * cs + s.A.loose : s.A.loose) : 0;
      const bTotal = s?.B ? (cs > 0 ? s.B.cases * cs + s.B.loose : s.B.loose) : 0;
      sim[itemId] = { A: aTotal, B: bTotal };
      return sim[itemId];
    };

    const snapshots: RowSnapshot[] = [];
    let firstError: string | null = null;

    for (const t of sortedQueue) {
      const cur = getOrInit(t.item_id);
      const d = deltaOf(t);
      const next = { A: cur.A, B: cur.B };
      next[d.godown] += d.delta;
      if (d.transferTo) next[d.transferTo.godown] += d.transferTo.delta;

      let warning: string | undefined;
      if (next.A < 0 || next.B < 0) {
        const failG: "A" | "B" = next.A < 0 ? "A" : "B";
        const item = itemById.get(t.item_id);
        const label = item ? `${item.brand ? item.brand + " · " : ""}${item.model} ${item.size}` : "item";
        warning = `Godown ${failG} would go to ${next[failG]} (have ${cur[failG]}, need ${Math.abs(d.delta + (d.transferTo?.godown === failG ? d.transferTo.delta : 0))})`;
        if (!firstError) firstError = `${label}: ${warning}`;
      }

      sim[t.item_id] = next;
      snapshots.push({ uid: t.uid, A: next.A, B: next.B, warning });
    }

    return { ok: firstError === null, snapshots, firstError };
  }, [sortedQueue, stock, itemById]);

  // ── Add the current form to the queue (does NOT hit the DB) ───────────
  const addToQueue = () => {
    if (!canWrite) { showToast("bad", "Read-only role can't log transactions."); return; }
    if (!selectedItem) { showToast("bad", "Pick an item first."); return; }
    if (totalQty <= 0) { showToast("bad", "Quantity must be greater than zero."); return; }
    if (f.action === "Transfer" && f.godown === f.to_godown) {
      showToast("bad", "From and To godowns must differ."); return;
    }

    let direction: number | null = null;
    if (f.action === "Adjustment") {
      if (!f.reason) { showToast("bad", "Pick a reason for the adjustment."); return; }
      const d = ADJ_DIRECTION[f.reason];
      if (d !== 1 && d !== -1) { showToast("bad", "Pick a valid reason."); return; }
      direction = d;
    } else if (f.action === "Return") {
      direction = f.return_dir;
    }

    const row: QueuedTxn = {
      uid: makeUid(),
      action: f.action,
      item_id: selectedItem.id,
      godown: f.godown,
      to_godown: f.to_godown,
      cartons: cartonsN,
      loose: looseN,
      total_qty: totalQty,
      rate: f.rate,
      invoice_no: f.invoice_no,
      party_name: f.party_name,
      reason: f.reason,
      return_dir: f.return_dir,
      direction,
      date: f.date,
    };

    // Gate: if the selected item has no case_size yet, intercept the add
    // and ask the user to set one (or skip and accept loose-only) before
    // anything goes into the queue. The pending row is parked in state;
    // saveCaseSizeAndAdd / skipCaseSizeAndAdd resume the add.
    if (selectedItem.case_size === 0) {
      setPendingCaseSize({ itemId: selectedItem.id, rowToAdd: row });
      return;
    }

    void doAddToQueue(row);
  };

  // The actual queue-push, separated so the case-size modal can call it
  // after either Save-and-continue or Skip-as-loose.
  const doAddToQueue = async (row: QueuedTxn) => {
    // Persist the queued row so it survives leaving the app / refresh / device
    // switch. The DB id becomes the row's uid. If the queue table isn't there
    // yet (migration not run), fall back to an in-memory row so the feature
    // still works — it just won't persist until the SQL is applied.
    let uid = row.uid;
    try {
      const { data, error } = await sb().from("transaction_queue").insert({
        user_id: profile?.id,
        item_id: row.item_id, action: row.action, godown: row.godown, to_godown: row.to_godown,
        cartons: row.cartons, loose: row.loose, total_qty: row.total_qty,
        rate: row.rate || null, invoice_no: row.invoice_no || null, party_name: row.party_name || null,
        reason: row.reason || null, return_dir: row.return_dir, direction: row.direction,
        txn_date: row.date,
      }).select("id").single();
      if (!error && data) uid = data.id;
    } catch { /* keep the in-memory uid */ }
    setQueue((q) => [...q, { ...row, uid }]);
    try { localStorage.setItem("txn.lastAction", row.action); } catch {}
    // Keep item + godown + action + date for fast repeat entry; clear the rest.
    setF((x) => ({ ...x, cartons: "", loose: "", rate: "", invoice_no: "", party_name: "", reason: "" }));
    showToast("ok", `Queued ${row.action} of ${fmtN(row.total_qty)} unit${row.total_qty === 1 ? "" : "s"}.`);
  };

  // Admin path from the modal: writes the new case_size to items, reloads,
  // re-splits the pending row's loose-only qty into cartons + loose for the
  // queue display, then completes the add.
  const saveCaseSizeAndAdd = async (newSize: number) => {
    if (!pendingCaseSize) return;
    if (!isAdmin) { showToast("bad", "Only admins can set case size."); return; }
    if (!Number.isInteger(newSize) || newSize < 1) { showToast("bad", "Case size must be a whole number ≥ 1."); return; }

    setSavingCaseSize(true);
    try {
      const { error } = await sb()
        .from("items")
        .update({ case_size: newSize })
        .eq("id", pendingCaseSize.itemId);
      if (error) throw error;

      // Refresh items so the form (and pre-flight, and any future picker
      // selection of this item) sees the new case size.
      await reload();

      // Re-split the row's loose-only quantity into cartons + loose so the
      // queue table reads naturally. total_qty is unchanged → the RPC still
      // gets the same number.
      const total = pendingCaseSize.rowToAdd.total_qty;
      const cartons = Math.floor(total / newSize);
      const loose = total - cartons * newSize;
      const updatedRow: QueuedTxn = { ...pendingCaseSize.rowToAdd, cartons, loose };

      await doAddToQueue(updatedRow);
      setPendingCaseSize(null);
      showToast("ok", `Case size set to ${newSize}; queued ${updatedRow.action}.`);
    } catch (e: any) {
      showToast("bad", e?.message || "Failed to update case size.");
    } finally {
      setSavingCaseSize(false);
    }
  };

  // Staff (or anyone) escape hatch: queue the row as-is, item.case_size stays 0.
  // process_transaction handles cs=0 items as loose-only on the DB side.
  const skipCaseSizeAndAdd = () => {
    if (!pendingCaseSize) return;
    void doAddToQueue(pendingCaseSize.rowToAdd);
    setPendingCaseSize(null);
  };

  const cancelCaseSize = () => {
    setPendingCaseSize(null);
  };

  const removeFromQueue = async (uid: string) => {
    const removed = queue.find((t) => t.uid === uid);
    // Optimistic: drop it from the UI right away…
    setQueue((q) => q.filter((t) => t.uid !== uid));
    setProcessErrors((errs) => errs.filter((e) => e.rowUid !== uid));
    // …then actually delete the persisted row. The `await` is essential — a
    // Supabase query builder is lazy and only fires its request inside .then()/
    // await, so a fire-and-forget `void` call never reached the server and the
    // row came back on the next reload. If the delete fails (e.g. offline), put
    // the row back so the UI doesn't lie about what's saved.
    const { error } = await sb().from("transaction_queue").delete().eq("id", uid);
    if (error && removed) {
      setQueue((q) => (q.some((t) => t.uid === uid) ? q : [...q, removed]));
      showToast("bad", "Couldn't remove that entry — check your connection and try again.");
    }
  };

  const clearQueue = async () => {
    if (queue.length === 0) return;
    if (!confirm(`Clear all ${queue.length} queued ${queue.length === 1 ? "entry" : "entries"}?`)) return;
    const snapshot = queue;
    const ids = snapshot.map((t) => t.uid);
    setQueue([]);
    setProcessErrors([]);
    if (ids.length) {
      const { error } = await sb().from("transaction_queue").delete().in("id", ids);
      if (error) {
        setQueue(snapshot); // restore — the delete didn't go through
        showToast("bad", "Couldn't clear the queue — check your connection and try again.");
      }
    }
  };

  // ── Run the entire queue in safe order ────────────────────────────────
  const processQueue = async () => {
    if (queue.length === 0) return;
    if (!canWrite) { showToast("bad", "Read-only role can't process."); return; }
    if (!preflight.ok) {
      showToast("bad", "Fix the pre-flight error before processing.");
      return;
    }

    setProcessing(true);
    setProcessErrors([]);
    setProcessIdx(0);

    const failures: ProcessError[] = [];
    const succeeded: string[] = [];
    let processed = 0;

    for (let i = 0; i < sortedQueue.length; i++) {
      setProcessIdx(i);
      const t = sortedQueue[i];
      const note = [
        t.reason && `reason: ${t.reason}`,
        t.invoice_no && `inv: ${t.invoice_no}`,
        t.party_name && `party: ${t.party_name}`,
        t.rate && `rate: ${t.rate}`,
      ].filter(Boolean).join(" • ") || null;

      // Up to 3 attempts, but ONLY for transient network failures — a real DB
      // rejection (stock check, constraint…) breaks out immediately with its
      // own message. process_transaction is a POST, which postgrest-js does not
      // auto-retry, so flaky mobile data otherwise surfaced as a raw
      // "TypeError: Load failed" against an entry that was actually fine.
      let lastErr: any = null;
      let ok = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await sleep(attempt === 1 ? 500 : 1500); // back off, then retry
        try {
          const { error } = await sb().rpc("process_transaction", {
            p_item_id: t.item_id,
            p_action: t.action,
            p_godown: t.godown,
            p_qty: t.total_qty,
            p_date: t.date,
            p_note: note,
            p_direction: t.direction,
          });
          if (error) throw error;
          ok = true;
          break;
        } catch (e: any) {
          lastErr = e;
          if (!isNetworkError(e)) break; // deterministic failure — retrying won't help
        }
      }

      if (ok) {
        processed++;
        succeeded.push(t.uid);
      } else {
        const message = isNetworkError(lastErr)
          ? "Network error — couldn't reach the server. Check your connection and tap Process queue again."
          : (lastErr?.message || "Unknown error");
        failures.push({ rowUid: t.uid, message });
      }
    }

    // Drop processed rows from the persisted queue; failures stay for retry.
    if (succeeded.length) {
      try { await sb().from("transaction_queue").delete().in("id", succeeded); } catch { /* reload reconciles */ }
    }

    setProcessIdx(sortedQueue.length);
    setProcessing(false);

    if (failures.length === 0) {
      setQueue([]);
      showToast("ok", `Processed ${processed} transaction${processed === 1 ? "" : "s"}.`);
    } else {
      // Keep only the failed rows so the user can fix and retry.
      const failedUids = new Set(failures.map((f) => f.rowUid));
      setQueue((q) => q.filter((t) => failedUids.has(t.uid)));
      setProcessErrors(failures);
      showToast("bad", `Processed ${processed}, ${failures.length} failed — see queue.`);
    }

    await reload();
  };

  const reverseRow = async (id: string) => {
    if (!confirm("Reverse this transaction? A reversing entry will be added; the original stays for the audit trail.")) return;
    setReversingId(id);
    try {
      const { error } = await sb().rpc("reverse_transaction", { p_txn_id: id });
      if (error) throw error;
      showToast("ok", "Reversal recorded.");
      await reload();
    } catch (e: any) {
      showToast("bad", e.message || "Failed to reverse.");
    } finally {
      setReversingId(null);
    }
  };

  const visibleTxns = useMemo(() => {
    let list = txns;
    if (logFilter) list = list.filter((t) => t.action === logFilter);
    if (logQuery) {
      list = list.filter((t) => {
        const it = itemById.get(t.item_id);
        const hay = `${it?.model || ""} ${it?.size || ""} ${it?.colour || ""} ${it?.brand || ""} ${t.invoice_no || ""} ${t.reason || ""}`;
        return matchesQuery(hay, logQuery);
      });
    }
    return list;
  }, [txns, logFilter, logQuery, itemById]);

  const queueCount = queue.length;
  const errorMap = useMemo(() => {
    const m = new Map<string, string>();
    processErrors.forEach((e) => m.set(e.rowUid, e.message));
    return m;
  }, [processErrors]);

  return (
    <Shell title="Transactions">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Transactions</h1>
          <p className="text-sm text-zinc-500 mt-1">
            {loaded ? `${txns.length} recent entries` : "Loading…"} — batch entry: queue first, then process in safe order so a Sale never fails before its Purchase has landed.
          </p>
        </div>
      </div>

      {/* ── Entry form ─────────────────────────────────────────────────── */}
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl md:rounded-lg shadow-sm md:shadow-none overflow-hidden mb-6 md:mb-8">
        <div className="flex border-b border-zinc-200 dark:border-zinc-800">
          {ALL_ACTIONS.map((a) => {
            const active = f.action === a;
            const Icon = a === "Purchase" ? ArrowDownToLine
              : a === "Sale" ? ArrowUpFromLine
              : a === "Transfer" ? ArrowLeftRight
              : a === "Adjustment" ? Wrench
              : Undo2;
            return (
              <button
                key={a}
                type="button"
                onClick={() => setF((x) => ({ ...x, action: a }))}
                title={a}
                aria-label={a}
                className={[
                  "flex-1 flex items-center justify-center gap-1.5 sm:gap-2 py-3 text-xs sm:text-sm border-b-2 transition-colors",
                  active
                    ? "text-cyan-600 dark:text-cyan-400 border-cyan-500 bg-cyan-500/5"
                    : "text-zinc-600 dark:text-zinc-400 border-transparent hover:bg-zinc-50 dark:hover:bg-zinc-800/40",
                ].join(" ")}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                <span className="truncate">{a}</span>
              </button>
            );
          })}
        </div>

        <div className="p-4 sm:p-6 grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <Label>Item</Label>
            <ItemPicker
              items={items}
              value={f.item_id}
              onChange={(id) => setF((x) => ({ ...x, item_id: id }))}
            />
            {selectedItem && (
              <div className="mt-2 text-xs text-zinc-500 flex flex-wrap gap-3">
                {selectedItem.brand && <Badge>{selectedItem.brand}</Badge>}
                <span>case size: <b className="tnum">{selectedItem.case_size || "—"}</b></span>
                <span>Stock A: <b className="tnum">{stockTotalFor(selectedItem, stock, "A")}</b></span>
                <span>Stock B: <b className="tnum">{stockTotalFor(selectedItem, stock, "B")}</b></span>
              </div>
            )}
          </div>

          {f.action !== "Transfer" ? (
            <div>
              <Label>Godown</Label>
              <SegBtn
                value={f.godown}
                onChange={(v) => setF((x) => ({ ...x, godown: v as "A" | "B" }))}
                options={[{ v: "A", l: "A" }, { v: "B", l: "B" }]}
              />
            </div>
          ) : (
            <Fragment>
              <div>
                <Label>From</Label>
                <SegBtn
                  value={f.godown}
                  onChange={(v) => setF((x) => ({ ...x, godown: v as "A" | "B", to_godown: v === "A" ? "B" : "A" }))}
                  options={[{ v: "A", l: "A" }, { v: "B", l: "B" }]}
                />
              </div>
              <div>
                <Label>To</Label>
                <SegBtn
                  value={f.to_godown}
                  onChange={(v) => setF((x) => ({ ...x, to_godown: v as "A" | "B" }))}
                  options={[{ v: "A", l: "A" }, { v: "B", l: "B" }]}
                />
              </div>
            </Fragment>
          )}

          <div>
            <Label>Date</Label>
            <Input type="date" value={f.date} onChange={(v) => setF((x) => ({ ...x, date: v }))} />
          </div>

          {cs > 0 ? (
            <Fragment>
              <div>
                <Label>Cartons</Label>
                <Input
                  type="number" min="0" inputMode="numeric"
                  value={f.cartons}
                  onChange={(v) => setF((x) => ({ ...x, cartons: v.replace(/[^\d]/g, "") }))}
                  placeholder="0"
                />
              </div>
              <div>
                <Label>Loose</Label>
                <Input
                  type="number" min="0" inputMode="numeric"
                  value={f.loose}
                  onChange={(v) => setF((x) => ({ ...x, loose: v.replace(/[^\d]/g, "") }))}
                  placeholder="0"
                />
              </div>
              <div className="md:col-span-2 text-xs text-zinc-500">
                Total: <b className="tnum text-zinc-700 dark:text-zinc-200">{fmtN(totalQty)}</b> units
                {cs > 0 && <span> ({cartonsN}×{cs} + {looseN})</span>}
              </div>
            </Fragment>
          ) : (
            <div className="md:col-span-2">
              <Label>Quantity</Label>
              <Input
                type="number" min="0" inputMode="numeric"
                value={f.loose}
                onChange={(v) => setF((x) => ({ ...x, loose: v.replace(/[^\d]/g, "") }))}
                placeholder="0"
              />
              <div className="text-xs text-zinc-500 mt-1">
                Item sold loose only — no case size set.
              </div>
            </div>
          )}

          {(f.action === "Purchase" || f.action === "Sale") && (
            <Fragment>
              <div>
                <Label>{f.action === "Purchase" ? "Supplier" : "Customer"} (optional)</Label>
                <Input
                  value={f.party_name}
                  onChange={(v) => setF((x) => ({ ...x, party_name: v }))}
                  placeholder={f.action === "Purchase" ? "e.g. Goldmedal Distributor" : "e.g. retail customer"}
                />
              </div>
              <div>
                <Label>Invoice no. (optional)</Label>
                <Input
                  value={f.invoice_no}
                  onChange={(v) => setF((x) => ({ ...x, invoice_no: v }))}
                  placeholder="—"
                />
              </div>
              <div className="md:col-span-2">
                <Label>{f.action === "Purchase" ? "Cost rate per unit" : "Sale rate per unit"} (optional)</Label>
                <Input
                  type="number" min="0" step="0.01"
                  value={f.rate}
                  onChange={(v) => setF((x) => ({ ...x, rate: v }))}
                  placeholder="₹"
                />
                {f.rate && totalQty > 0 && (
                  <div className="text-xs text-zinc-500 mt-1">
                    Line total: <b className="tnum">{fmtMoney(Number(f.rate) * totalQty)}</b>
                  </div>
                )}
              </div>
            </Fragment>
          )}

          {f.action === "Adjustment" && (
            <div className="md:col-span-2">
              <Label>Reason (required)</Label>
              <select
                value={f.reason}
                onChange={(e) => setF((x) => ({ ...x, reason: e.target.value }))}
                className="w-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm"
              >
                <option value="">— pick a reason —</option>
                <optgroup label="Stock goes UP (+)">
                  <option value="found">Found</option>
                  <option value="count_up">Count up (physical &gt; system)</option>
                  <option value="customer_return_to_shelf">Customer return → back on shelf</option>
                </optgroup>
                <optgroup label="Stock goes DOWN (−)">
                  <option value="damage">Damage</option>
                  <option value="lost">Lost</option>
                  <option value="count_down">Count down (physical &lt; system)</option>
                </optgroup>
              </select>
              {f.reason && (
                <div className="text-xs text-zinc-500 mt-1.5 flex items-center gap-1.5">
                  {ADJ_DIRECTION[f.reason] === 1 ? (
                    <>
                      <ArrowUp className="w-3 h-3 text-emerald-500" />
                      <span>Will <b className="text-emerald-600 dark:text-emerald-400">add</b> {fmtN(totalQty)} unit{totalQty === 1 ? "" : "s"} to Godown {f.godown}</span>
                    </>
                  ) : (
                    <>
                      <ArrowDown className="w-3 h-3 text-rose-500" />
                      <span>Will <b className="text-rose-600 dark:text-rose-400">remove</b> {fmtN(totalQty)} unit{totalQty === 1 ? "" : "s"} from Godown {f.godown}</span>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {f.action === "Return" && (
            <Fragment>
              <div className="md:col-span-2">
                <Label>Direction</Label>
                <SegBtn
                  value={String(f.return_dir)}
                  onChange={(v) => setF((x) => ({ ...x, return_dir: (Number(v) as 1 | -1) }))}
                  options={[
                    { v: "1", l: "Customer return (into godown)" },
                    { v: "-1", l: "Supplier return (out of godown)" },
                  ]}
                />
                <div className="text-xs text-zinc-500 mt-1.5 flex items-center gap-1.5">
                  {f.return_dir === 1 ? (
                    <>
                      <ArrowUp className="w-3 h-3 text-emerald-500" />
                      <span>Customer is sending stock back to us → goes <b className="text-emerald-600 dark:text-emerald-400">into</b> Godown {f.godown}.</span>
                    </>
                  ) : (
                    <>
                      <ArrowDown className="w-3 h-3 text-rose-500" />
                      <span>We are sending stock back to the supplier → leaves <b className="text-rose-600 dark:text-rose-400">out of</b> Godown {f.godown}.</span>
                    </>
                  )}
                </div>
              </div>
              <div>
                <Label>{f.return_dir === 1 ? "Customer (returning)" : "Supplier (returning to)"} (optional)</Label>
                <Input
                  value={f.party_name}
                  onChange={(v) => setF((x) => ({ ...x, party_name: v }))}
                  placeholder={f.return_dir === 1 ? "e.g. retail customer" : "e.g. Goldmedal Distributor"}
                />
              </div>
              <div>
                <Label>Invoice / RMA no. (optional)</Label>
                <Input
                  value={f.invoice_no}
                  onChange={(v) => setF((x) => ({ ...x, invoice_no: v }))}
                  placeholder="—"
                />
              </div>
            </Fragment>
          )}

          <div className="md:col-span-2 flex items-center justify-between pt-2 border-t border-zinc-100 dark:border-zinc-800">
            <div className="text-xs text-zinc-500">
              {!canWrite
                ? <span className="text-amber-500">Your role is read-only.</span>
                : formDirection
                ? <>All stock math runs in Postgres atomically. <span className="text-zinc-400">Direction:</span> <b className={formDirection === 1 ? "text-emerald-500" : "text-rose-500"}>{formDirection === 1 ? "+1 (in)" : "−1 (out)"}</b></>
                : "Pick a reason / direction to see the direction."}
            </div>
            <button
              type="button"
              disabled={processing || !canWrite}
              onClick={addToQueue}
              className="bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed text-white px-4 py-2 rounded-md text-sm font-medium flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              Add {f.action} to queue
            </button>
          </div>
        </div>
      </div>

      {/* ── Queue panel ────────────────────────────────────────────────── */}
      {queueCount > 0 && (
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl md:rounded-lg shadow-sm md:shadow-none overflow-hidden mb-6 md:mb-8">
          <div className="flex flex-wrap items-center gap-3 px-5 py-3 border-b border-zinc-200 dark:border-zinc-800">
            <ListChecks className="w-4 h-4 text-cyan-500" />
            <div className="flex-1 min-w-[140px]">
              <div className="text-sm font-medium">Queue · {queueCount} {queueCount === 1 ? "entry" : "entries"}</div>
              <div className="text-[11px] text-zinc-500 hidden md:block">
                Order: <b>Purchase → Adj UP → Customer return → Transfer → Adj DOWN → Sale → Supplier return.</b>
              </div>
            </div>
            <button
              type="button"
              onClick={clearQueue}
              disabled={processing}
              className="text-xs text-zinc-500 hover:text-rose-500 disabled:opacity-40 flex items-center gap-1"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clear all
            </button>
            <button
              type="button"
              onClick={processQueue}
              disabled={processing || !preflight.ok || !canWrite}
              className="bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed text-white px-4 py-2 rounded-md text-sm font-medium flex items-center gap-2"
              title={!preflight.ok ? "Fix pre-flight error first" : "Process all queued entries"}
            >
              {processing
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Processing {processIdx + 1}/{queueCount}…</>
                : <><Play className="w-4 h-4" /> Process queue ({queueCount})</>}
            </button>
          </div>

          {/* pre-flight banner */}
          {!preflight.ok && !processing && (
            <div className="px-5 py-2 bg-rose-500/10 text-rose-700 dark:text-rose-300 text-xs flex items-center gap-2 border-b border-rose-500/20">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              <span><b>Stock check failed:</b> {preflight.firstError}. Add more stock above this row in the queue, or remove the offending entry.</span>
            </div>
          )}
          {preflight.ok && !processing && processErrors.length === 0 && (
            <div className="px-5 py-2 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 text-xs flex items-center gap-2 border-b border-emerald-500/20">
              <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
              <span>All clear. Process will run {queueCount} {queueCount === 1 ? "entry" : "entries"} in the order shown below.</span>
            </div>
          )}
          {processErrors.length > 0 && !processing && (
            <div className="px-5 py-2 bg-rose-500/10 text-rose-700 dark:text-rose-300 text-xs flex items-center gap-2 border-b border-rose-500/20">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              <span><b>{processErrors.length} {processErrors.length === 1 ? "entry" : "entries"} failed.</b> Survivors stay in the queue with the error attached — fix and click Process queue again.</span>
            </div>
          )}

          {/* Desktop / tablet table */}
          <table className="w-full text-sm hidden md:table">
            <thead className="bg-zinc-50 dark:bg-zinc-900/50">
              <tr className="text-zinc-500 text-[11px] uppercase tracking-wider">
                <th className="text-left px-5 py-2 font-medium">#</th>
                <th className="text-left px-3 py-2 font-medium">Action</th>
                <th className="text-left px-3 py-2 font-medium">Item</th>
                <th className="text-left px-3 py-2 font-medium">Godown</th>
                <th className="text-right px-3 py-2 font-medium">Qty</th>
                <th className="text-right px-3 py-2 font-medium">A after</th>
                <th className="text-right px-3 py-2 font-medium">B after</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                <th className="text-right px-5 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {sortedQueue.map((t, i) => {
                const it = itemById.get(t.item_id);
                const snap = preflight.snapshots[i];
                const procErr = errorMap.get(t.uid);
                const dir = t.action === "Purchase" ? 1
                  : t.action === "Sale" ? -1
                  : t.action === "Transfer" ? -1
                  : t.direction;
                return (
                  <tr key={t.uid} className={[
                    "border-t border-zinc-100 dark:border-zinc-800/60",
                    snap?.warning ? "bg-rose-500/5"
                    : procErr ? "bg-rose-500/10"
                    : "hover:bg-zinc-50 dark:hover:bg-zinc-800/30",
                  ].join(" ")}>
                    <td className="px-5 py-2.5 text-zinc-500 tnum">
                      <span className="text-[10px] text-zinc-400">{PRIORITY_LABEL[priorityOf(t)]}</span>
                    </td>
                    <td className="px-3 py-2.5"><ActionBadge action={t.action} /></td>
                    <td className="px-3 py-2.5">
                      {it
                        ? <span>{it.brand && <span className="text-zinc-400">{it.brand} · </span>}{it.model} <span className="text-zinc-500">· {it.size} · {it.colour}</span></span>
                        : <span className="text-zinc-500">?</span>}
                    </td>
                    <td className="px-3 py-2.5 text-zinc-500">
                      {t.godown}{t.action === "Transfer" && <span className="text-zinc-400"> → {t.to_godown}</span>}
                    </td>
                    <td className="px-3 py-2.5 text-right tnum">
                      <span className="inline-flex items-center gap-1 justify-end">
                        {dir === 1
                          ? <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">+ in</span>
                          : <span className="text-[10px] text-rose-600 dark:text-rose-400 font-medium">− out</span>}
                        <span>{fmtN(t.total_qty)}</span>
                      </span>
                    </td>
                    <td className={`px-3 py-2.5 text-right tnum ${snap && snap.A < 0 ? "text-rose-500 font-medium" : "text-zinc-500"}`}>{snap ? fmtN(snap.A) : "—"}</td>
                    <td className={`px-3 py-2.5 text-right tnum ${snap && snap.B < 0 ? "text-rose-500 font-medium" : "text-zinc-500"}`}>{snap ? fmtN(snap.B) : "—"}</td>
                    <td className="px-3 py-2.5 text-xs">
                      {procErr
                        ? <span className="text-rose-600 dark:text-rose-300 inline-flex items-center gap-1"><AlertCircle className="w-3 h-3" /> {procErr}</span>
                        : snap?.warning
                        ? <span className="text-rose-600 dark:text-rose-300 inline-flex items-center gap-1"><AlertCircle className="w-3 h-3" /> {snap.warning}</span>
                        : processing && i < processIdx
                        ? <span className="text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> done</span>
                        : processing && i === processIdx
                        ? <span className="text-cyan-600 dark:text-cyan-400 inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> running</span>
                        : <span className="text-zinc-400">queued</span>}
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => removeFromQueue(t.uid)}
                        disabled={processing}
                        className="text-zinc-400 hover:text-rose-500 disabled:opacity-40 p-1 -m-1"
                        title="Remove from queue"
                        aria-label="Remove from queue"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {/* Mobile cards */}
          <ul className="md:hidden divide-y divide-zinc-200/60 dark:divide-zinc-800/60">
            {sortedQueue.map((t, i) => {
              const it = itemById.get(t.item_id);
              const snap = preflight.snapshots[i];
              const procErr = errorMap.get(t.uid);
              const dir = t.action === "Purchase" ? 1
                : t.action === "Sale" ? -1
                : t.action === "Transfer" ? -1
                : t.direction;
              const status = procErr
                ? <span className="text-rose-600 dark:text-rose-300 inline-flex items-center gap-1"><AlertCircle className="w-3 h-3 flex-shrink-0" /> <span className="truncate">{procErr}</span></span>
                : snap?.warning
                ? <span className="text-rose-600 dark:text-rose-300 inline-flex items-center gap-1"><AlertCircle className="w-3 h-3 flex-shrink-0" /> <span className="truncate">{snap.warning}</span></span>
                : processing && i < processIdx
                ? <span className="text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> done</span>
                : processing && i === processIdx
                ? <span className="text-cyan-600 dark:text-cyan-400 inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> running</span>
                : <span className="text-zinc-400">queued</span>;
              return (
                <li key={t.uid} className={[
                  "px-4 py-3",
                  snap?.warning ? "bg-rose-500/5" : procErr ? "bg-rose-500/10" : "",
                ].join(" ")}>
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <span className="text-[10px] text-zinc-400 tnum truncate">{PRIORITY_LABEL[priorityOf(t)]}</span>
                    <button
                      type="button"
                      onClick={() => removeFromQueue(t.uid)}
                      disabled={processing}
                      className="text-zinc-400 hover:text-rose-500 disabled:opacity-40 p-1 -m-1 flex-shrink-0"
                      aria-label="Remove from queue"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                    <ActionBadge action={t.action} />
                    <span className="inline-flex items-center gap-1 tnum text-sm">
                      {dir === 1
                        ? <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">+ in</span>
                        : <span className="text-[10px] text-rose-600 dark:text-rose-400 font-medium">− out</span>}
                      <span className="font-medium">{fmtN(t.total_qty)}</span>
                    </span>
                    <span className="text-xs text-zinc-500 ml-auto">
                      {t.godown}{t.action === "Transfer" && <span className="text-zinc-400"> → {t.to_godown}</span>}
                    </span>
                  </div>
                  <div className="text-sm truncate mb-1.5">
                    {it
                      ? <>{it.brand && <span className="text-zinc-400">{it.brand} · </span>}{it.model} <span className="text-zinc-500">· {it.size} · {it.colour}</span></>
                      : <span className="text-zinc-500">?</span>}
                  </div>
                  <div className="flex items-center justify-between gap-2 text-xs tnum">
                    <div className="flex gap-3 text-zinc-500">
                      <span>A: <b className={snap && snap.A < 0 ? "text-rose-500 font-medium" : "text-zinc-700 dark:text-zinc-200"}>{snap ? fmtN(snap.A) : "—"}</b></span>
                      <span>B: <b className={snap && snap.B < 0 ? "text-rose-500 font-medium" : "text-zinc-700 dark:text-zinc-200"}>{snap ? fmtN(snap.B) : "—"}</b></span>
                    </div>
                    <div className="text-xs min-w-0">{status}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {pendingCaseSize && itemById.get(pendingCaseSize.itemId) && (
        <CaseSizeModal
          item={itemById.get(pendingCaseSize.itemId)!}
          pendingQty={pendingCaseSize.rowToAdd.total_qty}
          pendingAction={pendingCaseSize.rowToAdd.action}
          isAdmin={isAdmin}
          saving={savingCaseSize}
          onSave={saveCaseSizeAndAdd}
          onSkip={skipCaseSizeAndAdd}
          onCancel={cancelCaseSize}
        />
      )}

      {toast && (
        <div className={[
          "fixed bottom-4 right-4 z-30 px-4 py-2 rounded-md text-sm shadow-lg flex items-center gap-2 max-w-md",
          toast.kind === "ok" ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-300 border border-emerald-500/30"
                              : "bg-rose-500/20 text-rose-600 dark:text-rose-300 border border-rose-500/30",
        ].join(" ")}>
          {toast.kind === "ok" ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          {toast.text}
        </div>
      )}

      {/* ── Transaction log ────────────────────────────────────────────── */}
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl md:rounded-lg shadow-sm md:shadow-none overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 px-4 sm:px-5 py-3 border-b border-zinc-200 dark:border-zinc-800">
          <div className="text-sm font-medium w-full sm:w-auto">Transaction log</div>
          <div className="hidden sm:block flex-1" />
          <select
            value={logFilter}
            onChange={(e) => setLogFilter(e.target.value as ActionKind | "")}
            className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1 text-xs"
          >
            <option value="">All actions</option>
            <option value="Purchase">Purchases</option>
            <option value="Sale">Sales</option>
            <option value="Transfer">Transfers</option>
            <option value="Adjustment">Adjustments</option>
            <option value="Return">Returns</option>
          </select>
          <SearchBox
            value={logQuery}
            onChange={setLogQuery}
            placeholder="Search log…"
            className="flex-1 sm:flex-none sm:w-56"
          />
        </div>

        {/* Desktop / tablet table */}
        <table className="w-full text-sm hidden md:table">
          <thead className="bg-zinc-50 dark:bg-zinc-900/50">
            <tr className="text-zinc-500 text-[11px] uppercase tracking-wider">
              <th className="text-left px-5 py-2 font-medium">Date</th>
              <th className="text-left px-3 py-2 font-medium">Action</th>
              <th className="text-left px-3 py-2 font-medium">Item</th>
              <th className="text-left px-3 py-2 font-medium">Godown</th>
              <th className="text-right px-3 py-2 font-medium">Qty</th>
              <th className="text-left px-3 py-2 font-medium">Note</th>
              <th className="text-left px-3 py-2 font-medium">By</th>
              <th className="text-right px-5 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {!loaded && (
              <tr><td colSpan={8} className="py-10 text-center text-sm text-zinc-500">Loading…</td></tr>
            )}
            {loaded && visibleTxns.length === 0 && (
              <tr><td colSpan={8} className="py-10 text-center text-sm text-zinc-500">No transactions match these filters.</td></tr>
            )}
            {loaded && visibleTxns.map((t) => {
              const it = itemById.get(t.item_id);
              const isReversal = !!t.reverses_id;
              const alreadyReversed = txns.some((x) => x.reverses_id === t.id);
              const showDirHint = t.action === "Adjustment" || t.action === "Return";
              return (
                <tr key={t.id} className="border-t border-zinc-100 dark:border-zinc-800/60 hover:bg-zinc-50 dark:hover:bg-zinc-800/30">
                  <td className="px-5 py-2.5 text-zinc-500 tnum">{(t.txn_date || "").slice(0, 10)}</td>
                  <td className="px-3 py-2.5"><ActionBadge action={t.action} reversal={isReversal} /></td>
                  <td className="px-3 py-2.5">
                    {it ? <span>{it.model} <span className="text-zinc-500">· {it.size} · {it.colour}</span></span> : <span className="text-zinc-500">?</span>}
                  </td>
                  <td className="px-3 py-2.5 text-zinc-500">{t.godown}</td>
                  <td className="px-3 py-2.5 text-right tnum">
                    <span className="inline-flex items-center gap-1 justify-end">
                      {showDirHint && (
                        t.direction === 1
                          ? <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">+ in</span>
                          : <span className="text-[10px] text-rose-600 dark:text-rose-400 font-medium">− out</span>
                      )}
                      <span>{fmtN(t.qty)}</span>
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-zinc-500 truncate max-w-[260px]">{t.reason || t.invoice_no || t.status || ""}</td>
                  <td className="px-3 py-2.5 text-xs text-zinc-600 dark:text-zinc-300">{nameOf(t.created_by)}</td>
                  <td className="px-5 py-2.5 text-right">
                    {canWrite && !isReversal && !alreadyReversed ? (
                      <button
                        onClick={() => reverseRow(t.id)}
                        disabled={reversingId === t.id}
                        className="text-xs text-zinc-500 hover:text-rose-500 inline-flex items-center gap-1 disabled:opacity-50"
                        title="Add a reversing entry"
                      >
                        {reversingId === t.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                        Reverse
                      </button>
                    ) : alreadyReversed ? (
                      <span className="text-[11px] text-zinc-400">reversed</span>
                    ) : isReversal ? (
                      <span className="text-[11px] text-zinc-400">reversal of {(t.reverses_id || "").slice(0, 6)}…</span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {/* Mobile cards */}
        <div className="md:hidden">
          {!loaded && <div className="py-10 text-center text-sm text-zinc-500">Loading…</div>}
          {loaded && visibleTxns.length === 0 && (
            <div className="py-10 text-center text-sm text-zinc-500">No transactions match these filters.</div>
          )}
          <ul className="divide-y divide-zinc-200/60 dark:divide-zinc-800/60">
            {loaded && visibleTxns.map((t) => {
              const it = itemById.get(t.item_id);
              const isReversal = !!t.reverses_id;
              const alreadyReversed = txns.some((x) => x.reverses_id === t.id);
              const showDirHint = t.action === "Adjustment" || t.action === "Return";
              const note = t.reason || t.invoice_no || t.status || "";
              return (
                <li key={t.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <ActionBadge action={t.action} reversal={isReversal} />
                    <span className="text-[11px] text-zinc-500 tnum">{(t.txn_date || "").slice(0, 10)}</span>
                  </div>
                  <div className="text-sm truncate mb-1">
                    {it ? <>{it.model} <span className="text-zinc-500">· {it.size} · {it.colour}</span></> : "?"}
                  </div>
                  <div className="flex items-center justify-between gap-2 text-xs text-zinc-500">
                    <span>Godown {t.godown}</span>
                    <span className="inline-flex items-center gap-1 tnum">
                      {showDirHint && (
                        t.direction === 1
                          ? <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">+ in</span>
                          : <span className="text-[10px] text-rose-600 dark:text-rose-400 font-medium">− out</span>
                      )}
                      <span className="text-zinc-700 dark:text-zinc-200 font-medium">{fmtN(t.qty)}</span>
                    </span>
                  </div>
                  {note && (
                    <div className="text-[11px] text-zinc-500 mt-1.5 truncate">{note}</div>
                  )}
                  <div className="text-[11px] text-zinc-400 mt-1">by {nameOf(t.created_by)}</div>
                  {(canWrite && !isReversal && !alreadyReversed) || alreadyReversed || isReversal ? (
                    <div className="mt-1.5 text-[11px]">
                      {canWrite && !isReversal && !alreadyReversed ? (
                        <button
                          onClick={() => reverseRow(t.id)}
                          disabled={reversingId === t.id}
                          className="text-zinc-500 hover:text-rose-500 inline-flex items-center gap-1 disabled:opacity-50"
                        >
                          {reversingId === t.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                          Reverse
                        </button>
                      ) : alreadyReversed ? (
                        <span className="text-zinc-400">reversed</span>
                      ) : (
                        <span className="text-zinc-400">reversal of {(t.reverses_id || "").slice(0, 6)}…</span>
                      )}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </Shell>
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────
function stockTotalFor(item: Item, stock: StockMap, gd: "A" | "B"): number {
  const s = stock[item.id]?.[gd];
  if (!s) return 0;
  const cs = item.case_size || 0;
  return cs > 0 ? s.cases * cs + s.loose : s.loose;
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-medium mb-1.5">{children}</div>;
}

function Input({
  value, onChange, type = "text", placeholder, step, min, inputMode,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  step?: string;
  min?: string;
  inputMode?: "numeric" | "decimal" | "text";
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      step={step}
      min={min}
      inputMode={inputMode}
      className="w-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-cyan-500 tnum"
    />
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 px-2 py-0.5 rounded text-[11px] tnum">
      {children}
    </span>
  );
}

function SegBtn({
  value, onChange, options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { v: string; l: string }[];
}) {
  return (
    <div className="flex flex-wrap bg-zinc-100 dark:bg-zinc-800 rounded-md p-0.5 gap-0.5 w-full sm:w-auto sm:inline-flex">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className={[
            "flex-1 sm:flex-none px-4 py-1.5 rounded text-sm font-medium transition-colors",
            value === o.v
              ? "bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-sm"
              : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300",
          ].join(" ")}
        >
          {o.l}
        </button>
      ))}
    </div>
  );
}

function ActionBadge({ action, reversal }: { action: string; reversal?: boolean }) {
  const colour =
    action === "Purchase" ? "bg-cyan-500/15 text-cyan-600 dark:text-cyan-300"
    : action === "Sale" ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"
    : action === "Transfer" ? "bg-amber-500/15 text-amber-600 dark:text-amber-300"
    : action === "Adjustment" ? "bg-violet-500/15 text-violet-600 dark:text-violet-300"
    : action === "Return" ? "bg-rose-500/15 text-rose-600 dark:text-rose-300"
    : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-300";
  return (
    <span className={`px-2 py-0.5 rounded text-[11px] inline-flex items-center gap-1 ${colour}`}>
      {action}
      {reversal && <span className="opacity-60">↺</span>}
    </span>
  );
}

function ItemPicker({
  items, value, onChange,
}: {
  items: Item[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const selected = items.find((i) => i.id === value);

  const matches = useMemo(() => {
    if (!q.trim()) return items.slice(0, 30);
    return items.filter((i) =>
      matchesQuery(`${i.brand || ""} ${i.model} ${i.size} ${i.colour} ${i.item_code}`, q)
    ).slice(0, 30);
  }, [items, q]);

  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
      <input
        value={selected && !open ? `${selected.brand ? selected.brand + " · " : ""}${selected.model} · ${selected.size} · ${selected.colour}` : q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search model / colour / item code…"
        className="w-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-cyan-500"
      />
      {open && (
        <div className="absolute z-20 mt-1 left-0 right-0 max-h-80 overflow-y-auto bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-md shadow-lg">
          {matches.length === 0 && (
            <div className="py-6 px-3 text-center text-xs text-zinc-500">No matches.</div>
          )}
          {matches.map((i) => (
            <button
              key={i.id}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); onChange(i.id); setQ(""); setOpen(false); }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/60 flex items-center justify-between gap-3 border-b border-zinc-100 dark:border-zinc-800/60 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate">{i.brand && <span className="text-zinc-400">{i.brand} · </span>}{i.model}</div>
                <div className="text-[11px] text-zinc-500 truncate">{[i.size, i.colour].filter(Boolean).join(" · ")}</div>
              </div>
              {i.case_size > 0
                ? <span className="text-[10px] text-zinc-400 tnum whitespace-nowrap">case×{i.case_size}</span>
                : <span className="text-[10px] text-amber-500 tnum whitespace-nowrap" title="No case size set yet">no case</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── case-size modal ──────────────────────────────────────────────────────
// Shown when the user clicks Add-to-queue with an item that has case_size=0.
// Admin: set a new case size on items + queue the row split into cartons/loose.
// Staff: only the "skip — add as loose" path is available (items table is
// admin-write-only). Pre-flight stock simulation in the page uses the same
// item.case_size, so once admin sets it, future queue rows for this item
// see the right total math too.
function CaseSizeModal({
  item, pendingQty, pendingAction, isAdmin, saving, onSave, onSkip, onCancel,
}: {
  item: Item;
  pendingQty: number;
  pendingAction: string;
  isAdmin: boolean;
  saving: boolean;
  onSave: (size: number) => void;
  onSkip: () => void;
  onCancel: () => void;
}) {
  const [sizeStr, setSizeStr] = useState("");
  const n = Number(sizeStr || 0);
  const valid = Number.isInteger(n) && n >= 1;
  const cartons = valid ? Math.floor(pendingQty / n) : 0;
  const loose = valid ? pendingQty - cartons * n : pendingQty;
  const itemLabel = `${item.brand ? item.brand + " · " : ""}${item.model} · ${item.size} · ${item.colour}`;

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape" && !saving) onCancel(); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onCancel, saving]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4"
      onClick={() => { if (!saving) onCancel(); }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-t-2xl sm:rounded-lg shadow-xl overflow-hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800 flex items-start gap-3">
          <div className="w-9 h-9 bg-amber-500/15 rounded-lg flex items-center justify-center flex-shrink-0">
            <Boxes className="w-5 h-5 text-amber-600 dark:text-amber-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold">Case size not set</h3>
            <p className="text-xs text-zinc-500 mt-0.5 truncate" title={itemLabel}>{itemLabel}</p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 disabled:opacity-40"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="bg-zinc-50 dark:bg-zinc-800/40 rounded p-3 border border-zinc-200 dark:border-zinc-700/50">
            <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">Pending {pendingAction.toLowerCase()}</div>
            <div className="text-2xl font-semibold tnum text-zinc-900 dark:text-zinc-100">
              {fmtN(pendingQty)} <span className="text-xs font-normal text-zinc-500">unit{pendingQty === 1 ? "" : "s"}</span>
            </div>
            <div className="text-[11px] text-zinc-500 mt-1">
              Currently entered as loose-only. Set a case size to split into cartons + loose.
            </div>
          </div>

          {isAdmin ? (
            <div>
              <Label>Case size (units per carton)</Label>
              <Input
                type="number" min="1" inputMode="numeric"
                value={sizeStr}
                onChange={(v) => setSizeStr(v.replace(/[^\d]/g, ""))}
                placeholder="e.g. 12"
              />
              {valid && (
                <div className="text-xs text-zinc-500 mt-1.5">
                  Will split as <b className="tnum text-zinc-700 dark:text-zinc-200">{cartons}</b> carton{cartons === 1 ? "" : "s"} + <b className="tnum text-zinc-700 dark:text-zinc-200">{loose}</b> loose = {fmtN(pendingQty)} units.
                </div>
              )}
              {sizeStr && !valid && (
                <div className="text-xs text-rose-500 mt-1.5">Enter a whole number ≥ 1.</div>
              )}
            </div>
          ) : (
            <div className="text-xs text-amber-700 dark:text-amber-300 bg-amber-500/10 rounded p-2.5 border border-amber-500/20 leading-relaxed">
              <b>Admin only.</b> Ask an admin to set the case size for this item, or skip and add as loose-only for now. The transaction still processes correctly either way — you just can't enter cartons until case size is set.
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-zinc-200 dark:border-zinc-800 flex flex-wrap items-center justify-end gap-2 bg-zinc-50/50 dark:bg-zinc-900/40">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 px-3 py-1.5 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSkip}
            disabled={saving}
            className="text-xs text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 px-3 py-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 disabled:opacity-40"
          >
            Skip — add as loose
          </button>
          {isAdmin && (
            <button
              type="button"
              onClick={() => onSave(n)}
              disabled={!valid || saving}
              className="bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed text-white px-4 py-1.5 rounded-md text-xs font-medium flex items-center gap-2"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
              Set case size &amp; add
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
