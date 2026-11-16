"use client";
// Count correction — sets each godown's ABSOLUTE physical count. Moved out of
// the old Items page unchanged (2026-11-16 redesign); the stock maths and the
// apply_reconciliation calls are exactly as before.
import { useState } from "react";
import { Pencil, X, Save, Loader2, AlertCircle } from "lucide-react";
import { sb } from "@/lib/supabase";
import { fmtN } from "@/lib/utils";
import { useEscape } from "@/lib/hooks";

export type StockItem = {
  id: string; item_code: string; brand: string | null; model: string; size: string; colour: string;
  case_size: number; casesA: number; looseA: number; casesB: number; looseB: number;
};

// ─── count-correction modal ───────────────────────────────────────────────
// Sets each godown's ABSOLUTE physical count (cases/loose) — the entered
// values become the new stock, not a delta on top. One apply_reconciliation
// call per godown sets the value and logs an Adjustment when the total moved.
// Case size (on items, not godown_stock) is updated separately via a plain
// UPDATE — admin only, because of items-table RLS.
export function EditStockModal({
  item, isAdmin, onClose, onSaved, onEditDetails, onPartial,
}: {
  item: StockItem;
  isAdmin: boolean;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onEditDetails?: () => void;
  /** Something was saved before an error — refresh what the page shows. */
  onPartial?: () => void;
}) {
  const oldCs = item.case_size || 0;
  const [cs, setCs] = useState(String(oldCs));
  const [aCases, setACases] = useState(String(item.casesA));
  const [aLoose, setALoose] = useState(String(item.looseA));
  const [bCases, setBCases] = useState(String(item.casesB));
  const [bLoose, setBLoose] = useState(String(item.looseB));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // numeric parsings (default 0 on empty / NaN)
  const csN = Math.max(0, Number(cs || 0) | 0);
  const aCN = Math.max(0, Number(aCases || 0) | 0);
  const aLN = Math.max(0, Number(aLoose || 0) | 0);
  const bCN = Math.max(0, Number(bCases || 0) | 0);
  const bLN = Math.max(0, Number(bLoose || 0) | 0);

  // Total physical units, before and after
  const oldATotal = oldCs > 0 ? item.casesA * oldCs + item.looseA : item.looseA;
  const oldBTotal = oldCs > 0 ? item.casesB * oldCs + item.looseB : item.looseB;
  const newATotal = csN > 0 ? aCN * csN + aLN : aLN;
  const newBTotal = csN > 0 ? bCN * csN + bLN : bLN;
  const deltaA = newATotal - oldATotal;
  const deltaB = newBTotal - oldBTotal;
  const csChanged = csN !== oldCs;
  const nothingChanged = !csChanged && deltaA === 0 && deltaB === 0;

  const onlyDigits = (s: string) => s.replace(/[^\d]/g, "");

  // Escape + overlay-click are blocked mid-save so the in-flight result
  // (success or error) isn't hidden behind a closed modal.
  useEscape(!saving, onClose);

  async function save() {
    if (nothingChanged) { setError("Nothing to save — change at least one value."); return; }
    if (csChanged && !isAdmin) {
      setError("Only admins can change case size. Ask an admin, or untouch the case size field.");
      return;
    }

    setError(null);
    setSaving(true);
    let wrote = false; // something reached the database before an error
    try {
      const c = sb();

      // 1) Update case_size on items if it changed. Done first so the
      //    apply_reconciliation calls below read the new case size when
      //    they compute piece counts.
      if (csChanged) {
        const { error: e1 } = await c.from("items").update({ case_size: csN }).eq("id", item.id);
        if (e1) throw e1;
        wrote = true;
      }

      // 2) Set absolute physical values per godown via apply_reconciliation.
      //    The RPC row-locks the godown_stock row, computes the delta from
      //    the CURRENT db value (not whatever the items page loaded), logs
      //    an Adjustment audit row when the piece total moved, and forces
      //    cases/loose to exactly what the user typed. This replaces the
      //    older process_transaction + reconcile_stock_split dance — single
      //    atomic call, no stale-state races on retry.
      const aTouched = aCN !== item.casesA || aLN !== item.looseA || csChanged;
      const bTouched = bCN !== item.casesB || bLN !== item.looseB || csChanged;

      if (aTouched) {
        const { error: eA } = await c.rpc("apply_reconciliation", {
          p_item_id:      item.id,
          p_godown:       "A",
          p_target_cases: aCN,
          p_target_loose: aLN,
          p_reason:       "Count correction",
        });
        if (eA) throw eA;
        wrote = true;
      }
      if (bTouched) {
        const { error: eB } = await c.rpc("apply_reconciliation", {
          p_item_id:      item.id,
          p_godown:       "B",
          p_target_cases: bCN,
          p_target_loose: bLN,
          p_reason:       "Count correction",
        });
        if (eB) throw eB;
      }

      await onSaved();
    } catch (e: any) {
      setError(e?.message || "Could not save the count.");
      // Part of it was saved (e.g. Godown A but not B): show the true numbers
      // behind the modal. Retrying is safe — the counts are absolute.
      if (wrote) onPartial?.();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 dark:bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Correct the count"
      onClick={() => { if (!saving) onClose(); }}
    >
      <div
        className="bg-white dark:bg-zinc-900 rounded-t-2xl sm:rounded-2xl w-full max-w-2xl shadow-lg border border-zinc-200 dark:border-zinc-800 flex flex-col max-h-[95vh] sm:max-h-[90vh] animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800 flex items-start justify-between gap-4 flex-shrink-0">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">Correct the count</h2>
            <p className="text-xs text-zinc-500 mt-0.5 truncate">
              {item.brand && <span>{item.brand} · </span>}{item.model} · {item.size} · {item.colour}
              <span className="text-zinc-400"> · {item.item_code}</span>
            </p>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {onEditDetails && (
              <button
                type="button"
                onClick={onEditDetails}
                className="text-xs text-cyan-600 dark:text-cyan-400 hover:bg-cyan-500/10 rounded-md px-2 py-1 inline-flex items-center gap-1 whitespace-nowrap"
              >
                <Pencil className="w-3.5 h-3.5" /> Edit details
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 p-1"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body — scrolls within the modal so header+footer stay anchored */}
        <div className="p-5 space-y-5 overflow-y-auto flex-1">
          <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-md p-3 text-[12px] text-amber-800 dark:text-amber-200 leading-relaxed">
            Type the <b>actual physical count</b> for each godown — these are the <b>final</b> values the stock is set to, not added on top.
            For everyday Purchase / Sale / Transfer, use the Transactions page. Each change is logged as a correction.
          </div>

          {/* Case size */}
          <div>
            <Label>Case size (units per carton)</Label>
            <NumInput value={cs} onChange={(v) => setCs(onlyDigits(v))} disabled={!isAdmin} />
            {!isAdmin && (
              <div className="text-[11px] text-zinc-500 mt-1">Admin only — sign in as admin to edit.</div>
            )}
            {csChanged && isAdmin && (
              <div className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">
                Changing case size from <b>{oldCs}</b> to <b>{csN}</b>. The carton counts below are interpreted with the <b>new</b> value.
              </div>
            )}
          </div>

          {/* Godown A + B */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <GodownBlock
              label="Godown A"
              casesValue={aCases} setCases={(v) => setACases(onlyDigits(v))}
              looseValue={aLoose} setLoose={(v) => setALoose(onlyDigits(v))}
              oldTotal={oldATotal} newTotal={newATotal} delta={deltaA} cs={csN}
              casesN={aCN} looseN={aLN}
            />
            <GodownBlock
              label="Godown B"
              casesValue={bCases} setCases={(v) => setBCases(onlyDigits(v))}
              looseValue={bLoose} setLoose={(v) => setBLoose(onlyDigits(v))}
              oldTotal={oldBTotal} newTotal={newBTotal} delta={deltaB} cs={csN}
              casesN={bCN} looseN={bLN}
            />
          </div>

          {error && (
            <div className="text-sm text-rose-600 dark:text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-md p-2.5 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="px-5 py-3 border-t border-zinc-200 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-3 bg-zinc-50 dark:bg-zinc-900/50 flex-shrink-0"
          style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
        >
          <div className="text-[11px] text-zinc-500 w-full sm:w-auto sm:flex-1 min-w-0">
            {nothingChanged
              ? "No changes yet."
              : `Will set ${[csChanged && "case size", deltaA !== 0 && "Godown A", deltaB !== 0 && "Godown B"].filter(Boolean).join(" + ")}.`}
          </div>
          <div className="flex gap-2 ml-auto">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 text-sm text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded-md"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving || nothingChanged}
              className="bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed text-white px-3.5 py-2 rounded-md text-sm font-medium flex items-center gap-1.5"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {saving ? "Saving…" : "Save count"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function GodownBlock({
  label, casesValue, setCases, looseValue, setLoose,
  oldTotal, newTotal, delta, cs, casesN, looseN,
}: {
  label: string;
  casesValue: string; setCases: (v: string) => void;
  looseValue: string; setLoose: (v: string) => void;
  oldTotal: number; newTotal: number; delta: number; cs: number;
  casesN: number; looseN: number;
}) {
  const deltaCls = delta > 0
    ? "text-emerald-600 dark:text-emerald-400"
    : delta < 0
    ? "text-rose-500"
    : "text-zinc-500";
  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-md p-4 space-y-3">
      <div className="text-sm font-medium">{label}</div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Cartons</Label>
          <NumInput value={casesValue} onChange={setCases} />
        </div>
        <div>
          <Label>Loose</Label>
          <NumInput value={looseValue} onChange={setLoose} />
        </div>
      </div>
      <div className="text-[11px] text-zinc-500 pt-2 border-t border-zinc-100 dark:border-zinc-800 space-y-0.5">
        <div>In system: <b className="tnum text-zinc-700 dark:text-zinc-200">{fmtN(oldTotal)}</b> units</div>
        <div>
          New target: <b className="tnum text-zinc-700 dark:text-zinc-200">{fmtN(newTotal)}</b> units
          {cs > 0 && <span className="text-zinc-400"> ({casesN}×{cs} + {looseN})</span>}
        </div>
        <div>
          Delta: <b className={`tnum ${deltaCls}`}>{delta > 0 ? "+" : ""}{fmtN(delta)}</b>
        </div>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-medium mb-1.5">{children}</div>;
}

function NumInput({
  value, onChange, disabled,
}: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <input
      type="number"
      min="0"
      inputMode="numeric"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="w-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-cyan-500 tnum disabled:opacity-50 disabled:cursor-not-allowed"
    />
  );
}

