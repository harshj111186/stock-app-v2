"use client";
// One item, everything about it: stock in each godown (big, readable),
// where it sits in the categories, its details, and the last movements.
// Side panel on a computer, bottom sheet on a phone.
import { useEffect, useState } from "react";
import { X, Pencil, Copy, FolderInput, ClipboardEdit, ArrowDownLeft, ArrowUpRight, ArrowLeftRight, Loader2 } from "lucide-react";
import { sb } from "@/lib/supabase";
import { cn, fmtN, fmtDate, colourCss } from "@/lib/utils";
import { useEscape } from "@/lib/hooks";

export type DrawerItem = {
  id: string; item_code: string; brand: string | null; model: string; size: string; colour: string;
  case_size: number; hsn_code: string | null; gst_rate: number | null;
  reorder_point_a: number | null; reorder_point_b: number | null; archived: boolean;
  casesA: number; looseA: number; casesB: number; looseB: number; totalA: number; totalB: number;
  categoryPath: string | null;
};

type Move = { id: string; txn_date: string; action: string; godown: string; qty: number; direction: number | null; note: string | null };

export function ItemDrawer({ item, canWrite, isAdmin, onClose, onCorrect, onEdit, onDuplicate, onMove }: {
  item: DrawerItem;
  canWrite: boolean;
  isAdmin: boolean;
  onClose: () => void;
  onCorrect: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onMove: () => void;
}) {
  const [moves, setMoves] = useState<Move[] | null>(null);
  useEscape(true, onClose);

  useEffect(() => {
    let alive = true;
    setMoves(null);
    (async () => {
      const { data } = await sb().from("transactions").select("id,txn_date,action,godown,qty,direction,note")
        .eq("item_id", item.id).order("created_at", { ascending: false }).limit(8);
      if (alive) setMoves((data as Move[]) || []);
    })();
    return () => { alive = false; };
    // Re-read when the stock changes (a count correction adds a movement).
  }, [item.id, item.totalA, item.totalB, item.case_size]);

  const cs = item.case_size || 0;
  const sw = colourCss(item.colour);
  const total = item.totalA + item.totalB;

  const godown = (g: "A" | "B") => {
    const cases = g === "A" ? item.casesA : item.casesB;
    const loose = g === "A" ? item.looseA : item.looseB;
    const t = g === "A" ? item.totalA : item.totalB;
    return (
      <div className={cn("rounded-xl border px-3.5 py-3", g === "A" ? "bg-cyan-500/5 border-cyan-500/20" : "bg-teal-500/5 border-teal-500/20")}>
        <div className={cn("text-[11px] font-semibold uppercase tracking-wider", g === "A" ? "text-cyan-700 dark:text-cyan-300" : "text-teal-700 dark:text-teal-300")}>Godown {g}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{fmtN(t)} <span className="text-sm font-normal text-zinc-500">pcs</span></div>
        <div className="text-[12px] text-zinc-500 tabular-nums">
          {cs > 0 ? `${fmtN(cases)} case${cases === 1 ? "" : "s"} + ${fmtN(loose)} loose` : "sold loose"}
        </div>
      </div>
    );
  };

  const sign = (m: Move) => {
    if (m.direction === 1 || m.direction === -1) return m.direction;
    return m.action === "Purchase" ? 1 : m.action === "Sale" ? -1 : 0;
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end items-end md:items-stretch bg-black/40 dark:bg-black/60 animate-fade-in" role="dialog" aria-modal="true" aria-label={item.model} onClick={onClose}>
      <aside onClick={(e) => e.stopPropagation()}
        className="w-full md:w-[420px] max-h-[90vh] md:max-h-none md:h-full bg-white dark:bg-zinc-900 md:border-l border-zinc-200 dark:border-zinc-800 rounded-t-2xl md:rounded-none shadow-xl flex flex-col animate-slide-up">
        <div className="px-5 pt-4 pb-3 border-b border-zinc-200 dark:border-zinc-800 flex items-start gap-3 flex-shrink-0">
          <span className="mt-1 w-9 h-9 rounded-lg flex-shrink-0 border border-zinc-200 dark:border-zinc-700" style={sw ? { background: sw.bg } : undefined} />
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold leading-tight break-words">{item.model}</h2>
            <p className="text-sm text-zinc-500 mt-0.5">{[item.brand, item.size, item.colour].filter(Boolean).join(" · ") || "—"}</p>
            {item.archived && <span className="inline-block mt-1 text-[11px] text-amber-700 bg-amber-500/15 rounded px-1.5 py-0.5">Archived</span>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="w-9 h-9 -mr-2 flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X className="w-5 h-5" /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          <div className="grid grid-cols-2 gap-2.5">{godown("A")}{godown("B")}</div>
          <div className="flex items-center justify-between rounded-xl border border-zinc-200 dark:border-zinc-800 px-3.5 py-2.5">
            <span className="text-sm text-zinc-500">Total in both godowns</span>
            <span className="text-lg font-semibold tabular-nums">{fmtN(total)} pcs</span>
          </div>

          {(canWrite || isAdmin) && (
            <div className="grid grid-cols-2 gap-2">
              {canWrite && <ActionBtn icon={ClipboardEdit} label="Correct the count" onClick={onCorrect} primary />}
              {isAdmin && <ActionBtn icon={Pencil} label="Edit details" onClick={onEdit} />}
              {isAdmin && <ActionBtn icon={FolderInput} label="Move to category" onClick={onMove} />}
              {isAdmin && <ActionBtn icon={Copy} label="Add similar item" onClick={onDuplicate} />}
            </div>
          )}

          <dl className="text-sm divide-y divide-zinc-100 dark:divide-zinc-800 border-y border-zinc-100 dark:border-zinc-800">
            <Detail k="Category" v={item.categoryPath || "No category"} />
            <Detail k="Pieces in one case" v={cs > 0 ? fmtN(cs) : "Sold loose"} />
            <Detail k="Item code" v={item.item_code} />
            {item.hsn_code && <Detail k="HSN" v={item.hsn_code} />}
            {item.gst_rate != null && <Detail k="GST" v={`${+(item.gst_rate * 100).toFixed(2)}%`} />}
            {(item.reorder_point_a || item.reorder_point_b) ? <Detail k="Low-stock warning" v={`A at ${item.reorder_point_a || 2} · B at ${item.reorder_point_b || 2}`} /> : null}
          </dl>

          <div>
            <h3 className="text-[13px] font-semibold text-zinc-700 dark:text-zinc-300 mb-2">Last movements</h3>
            {moves === null ? (
              <div className="text-sm text-zinc-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
            ) : moves.length === 0 ? (
              <div className="text-sm text-zinc-500">No sales, purchases or counts yet.</div>
            ) : (
              <ul className="space-y-1.5">
                {moves.map(m => {
                  const s = sign(m);
                  const Icon = m.action === "Transfer" ? ArrowLeftRight : s > 0 ? ArrowDownLeft : ArrowUpRight;
                  return (
                    <li key={m.id} className="flex items-center gap-2.5 text-sm">
                      <Icon className={cn("w-4 h-4 flex-shrink-0", s > 0 ? "text-emerald-600" : s < 0 ? "text-rose-500" : "text-zinc-400")} />
                      <span className="flex-1 min-w-0 truncate">{m.action === "Adjustment" && m.note ? m.note : m.action} <span className="text-zinc-400">· {m.godown}</span></span>
                      <span className={cn("tabular-nums font-medium", s > 0 ? "text-emerald-700 dark:text-emerald-400" : s < 0 ? "text-rose-600 dark:text-rose-400" : "")}>{s > 0 ? "+" : s < 0 ? "−" : ""}{fmtN(m.qty)}</span>
                      <span className="text-[11px] text-zinc-400 w-[78px] text-right flex-shrink-0">{fmtDate(m.txn_date)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

function ActionBtn({ icon: Icon, label, onClick, primary }: { icon: typeof Pencil; label: string; onClick: () => void; primary?: boolean }) {
  return (
    <button type="button" onClick={onClick}
      className={cn("h-11 px-3 rounded-lg text-sm font-medium inline-flex items-center justify-center gap-2 border transition-colors",
        primary ? "bg-cyan-500 hover:bg-cyan-400 text-white border-cyan-500" : "border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:border-cyan-500/50 hover:bg-cyan-500/5")}>
      <Icon className="w-4 h-4" /> {label}
    </button>
  );
}

function Detail({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <dt className="text-zinc-500 flex-shrink-0">{k}</dt>
      <dd className="text-right min-w-0 break-words">{v}</dd>
    </div>
  );
}
