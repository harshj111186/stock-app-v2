"use client";
import { Fragment, useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine, ArrowUpFromLine, ArrowLeftRight, Wrench, Undo2,
  Search, RotateCcw, Loader2, CheckCircle2, AlertCircle, Lock,
} from "lucide-react";
import { Shell } from "@/components/shell";
import { useAuth } from "@/app/providers";
import { sb, type Item, type Stock, type Txn } from "@/lib/supabase";
import { fmtN, fmtMoney } from "@/lib/utils";

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
  date: string;
};

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
  date: TODAY(),
});

const LIVE_ACTIONS: ActionKind[] = ["Purchase", "Sale", "Transfer"];
const LOCKED_NOTE = "Stored function will be extended next session; UI is here so you can see the layout.";

// ─── page ─────────────────────────────────────────────────────────────────
export default function TransactionsPage() {
  const { profile } = useAuth();
  const canWrite = profile?.role === "admin" || profile?.role === "staff";

  const [items, setItems] = useState<Item[]>([]);
  const [stock, setStock] = useState<StockMap>({});
  const [txns, setTxns] = useState<Txn[]>([]);
  const [loaded, setLoaded] = useState(false);

  const [f, setF] = useState<FormState>(initialForm());
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);

  const [logFilter, setLogFilter] = useState<ActionKind | "">("");
  const [logQuery, setLogQuery] = useState("");
  const [reversingId, setReversingId] = useState<string | null>(null);

  useEffect(() => {
    try {
      const last = localStorage.getItem("txn.lastAction");
      if (last && (LIVE_ACTIONS as string[]).includes(last)) {
        setF((x) => ({ ...x, action: last as ActionKind }));
      }
    } catch { /* ignore */ }
  }, []);

  const reload = async () => {
    const c = sb();
    const [{ data: rows }, { data: st }, { data: t }] = await Promise.all([
      c.from("items").select("*").eq("archived", false).order("model"),
      c.from("godown_stock").select("*"),
      c.from("transactions").select("*").order("created_at", { ascending: false }).limit(200),
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

  const sourceStock = selectedItem ? stock[selectedItem.id]?.[f.godown] : null;
  const sourceTotal = sourceStock
    ? (selectedItem!.case_size || 0) > 0
      ? sourceStock.cases * (selectedItem!.case_size || 1) + sourceStock.loose
      : sourceStock.loose
    : 0;

  const showToast = (kind: "ok" | "bad", text: string) => {
    setToast({ kind, text });
    setTimeout(() => setToast(null), 4000);
  };

  const submit = async () => {
    if (!canWrite) { showToast("bad", "Read-only role can't log transactions."); return; }
    if (!selectedItem) { showToast("bad", "Pick an item first."); return; }
    if (totalQty <= 0) { showToast("bad", "Quantity must be greater than zero."); return; }
    if (!LIVE_ACTIONS.includes(f.action)) { showToast("bad", `${f.action} not wired up yet.`); return; }
    if (f.action === "Transfer" && f.godown === f.to_godown) {
      showToast("bad", "From and To godowns must differ."); return;
    }
    if (f.action === "Sale" && totalQty > sourceTotal) {
      showToast("bad", `Insufficient stock at Godown ${f.godown} (have ${sourceTotal}).`); return;
    }

    setSubmitting(true);
    try {
      const note = [
        f.reason && `reason: ${f.reason}`,
        f.invoice_no && `inv: ${f.invoice_no}`,
        f.party_name && `party: ${f.party_name}`,
        f.rate && `rate: ${f.rate}`,
      ].filter(Boolean).join(" • ") || null;

      const { data, error } = await sb().rpc("process_transaction", {
        p_item_id: selectedItem.id,
        p_action: f.action,
        p_godown: f.godown,
        p_qty: totalQty,
        p_date: f.date,
        p_note: note,
      });
      if (error) throw error;

      try { localStorage.setItem("txn.lastAction", f.action); } catch {}

      setF((x) => ({ ...x, cartons: "", loose: "", rate: "", invoice_no: "", party_name: "", reason: "" }));
      showToast("ok", `${f.action} saved (#${(data ?? "").toString().slice(0, 8)}).`);
      await reload();
    } catch (e: any) {
      showToast("bad", e.message || "Failed to save transaction.");
    } finally {
      setSubmitting(false);
    }
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
      const q = logQuery.toLowerCase();
      list = list.filter((t) => {
        const it = itemById.get(t.item_id);
        const hay = `${it?.model || ""} ${it?.size || ""} ${it?.colour || ""} ${it?.brand || ""} ${t.invoice_no || ""} ${t.reason || ""}`.toLowerCase();
        return hay.includes(q);
      });
    }
    return list;
  }, [txns, logFilter, logQuery, itemById]);

  return (
    <Shell title="Transactions">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Transactions</h1>
          <p className="text-sm text-zinc-500 mt-1">
            {loaded ? `${txns.length} recent entries` : "Loading…"} — every stock change runs through <code className="text-[11px]">process_transaction()</code> atomically.
          </p>
        </div>
      </div>

      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden mb-8">
        <div className="flex border-b border-zinc-200 dark:border-zinc-800">
          {(["Purchase", "Sale", "Transfer", "Adjustment", "Return"] as ActionKind[]).map((a) => {
            const live = LIVE_ACTIONS.includes(a);
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
                disabled={!live}
                onClick={() => live && setF((x) => ({ ...x, action: a }))}
                className={[
                  "flex-1 flex items-center justify-center gap-2 py-3 text-sm border-b-2 transition-colors",
                  active
                    ? "text-cyan-600 dark:text-cyan-400 border-cyan-500 bg-cyan-500/5"
                    : "text-zinc-600 dark:text-zinc-400 border-transparent hover:bg-zinc-50 dark:hover:bg-zinc-800/40",
                  !live ? "opacity-40 cursor-not-allowed" : "",
                ].filter(Boolean).join(" ")}
                title={live ? a : LOCKED_NOTE}
              >
                <Icon className="w-4 h-4" />
                <span>{a}</span>
                {!live && <Lock className="w-3 h-3 ml-1" />}
              </button>
            );
          })}
        </div>

        <div className="p-6 grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <Label>Item</Label>
            <ItemPicker
              items={items}
              value={f.item_id}
              onChange={(id) => setF((x) => ({ ...x, item_id: id }))}
            />
            {selectedItem && (
              <div className="mt-2 text-xs text-zinc-500 flex flex-wrap gap-3">
                <Badge>{selectedItem.item_code}</Badge>
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
                <option value="damage">Damage</option>
                <option value="lost">Lost</option>
                <option value="found">Found</option>
                <option value="count correction">Count correction</option>
              </select>
            </div>
          )}

          <div className="md:col-span-2 flex items-center justify-between pt-2 border-t border-zinc-100 dark:border-zinc-800">
            <div className="text-xs text-zinc-500">
              {!LIVE_ACTIONS.includes(f.action)
                ? <span className="text-amber-500">⚠ {f.action} action arrives next session.</span>
                : !canWrite
                ? <span className="text-amber-500">Your role is read-only.</span>
                : "All stock math runs in Postgres atomically."}
            </div>
            <button
              type="button"
              disabled={submitting || !LIVE_ACTIONS.includes(f.action) || !canWrite}
              onClick={submit}
              className="bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed text-zinc-900 px-4 py-2 rounded-md text-sm font-medium flex items-center gap-2"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              {submitting ? "Saving…" : `Save ${f.action}`}
            </button>
          </div>
        </div>
      </div>

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

      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-zinc-200 dark:border-zinc-800">
          <div className="text-sm font-medium">Transaction log</div>
          <div className="flex-1" />
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
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
            <input
              value={logQuery}
              onChange={(e) => setLogQuery(e.target.value)}
              placeholder="Search…"
              className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md pl-8 pr-3 py-1 text-xs"
            />
          </div>
        </div>

        <table className="w-full text-sm">
          <thead className="bg-zinc-50 dark:bg-zinc-900/50">
            <tr className="text-zinc-500 text-[11px] uppercase tracking-wider">
              <th className="text-left px-5 py-2 font-medium">Date</th>
              <th className="text-left px-3 py-2 font-medium">Action</th>
              <th className="text-left px-3 py-2 font-medium">Item</th>
              <th className="text-left px-3 py-2 font-medium">Godown</th>
              <th className="text-right px-3 py-2 font-medium">Qty</th>
              <th className="text-left px-3 py-2 font-medium">Note</th>
              <th className="text-right px-5 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {!loaded && (
              <tr><td colSpan={7} className="py-10 text-center text-sm text-zinc-500">Loading…</td></tr>
            )}
            {loaded && visibleTxns.length === 0 && (
              <tr><td colSpan={7} className="py-10 text-center text-sm text-zinc-500">No transactions match these filters.</td></tr>
            )}
            {loaded && visibleTxns.map((t) => {
              const it = itemById.get(t.item_id);
              const isReversal = !!t.reverses_id;
              const alreadyReversed = txns.some((x) => x.reverses_id === t.id);
              return (
                <tr key={t.id} className="border-t border-zinc-100 dark:border-zinc-800/60 hover:bg-zinc-50 dark:hover:bg-zinc-800/30">
                  <td className="px-5 py-2.5 text-zinc-500 tnum">{(t.txn_date || "").slice(0, 10)}</td>
                  <td className="px-3 py-2.5"><ActionBadge action={t.action} reversal={isReversal} /></td>
                  <td className="px-3 py-2.5">
                    {it ? <span>{it.model} <span className="text-zinc-500">· {it.size} · {it.colour}</span></span> : <span className="text-zinc-500">?</span>}
                  </td>
                  <td className="px-3 py-2.5 text-zinc-500">{t.godown}</td>
                  <td className="px-3 py-2.5 text-right tnum">{fmtN(t.qty)}</td>
                  <td className="px-3 py-2.5 text-xs text-zinc-500 truncate max-w-[260px]">{t.reason || t.invoice_no || t.status || ""}</td>
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
    <div className="inline-flex bg-zinc-100 dark:bg-zinc-800 rounded-md p-0.5 gap-0.5">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className={[
            "px-4 py-1.5 rounded text-sm font-medium transition-colors",
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
    const ql = q.toLowerCase();
    return items.filter((i) =>
      `${i.brand || ""} ${i.model} ${i.size} ${i.colour} ${i.item_code}`.toLowerCase().includes(ql)
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
                <div className="text-[11px] text-zinc-500 truncate">{i.size} · {i.colour} · {i.item_code}</div>
              </div>
              {i.case_size > 0 && (
                <span className="text-[10px] text-zinc-400 tnum whitespace-nowrap">case×{i.case_size}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
