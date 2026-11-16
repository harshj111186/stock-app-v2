"use client";
// Add / edit an item (2026-11-16 redesign).
//
// Made for speed at the counter:
//   • only the name is required; the rest is in the order you'd read a box
//     (category → brand → name → size → colours → pieces per case)
//   • several colours at once: "Brown, White, Black" makes three items
//   • optional stock you have right now (one colour only), saved as an
//     "Opening stock" count through the same apply_reconciliation call the
//     count-correction screen uses — so it is logged like any adjustment
//   • "Save & add another" keeps category / brand / size / case size
//   • a warning when the same item already exists
// GST, HSN and reorder levels sit under "More details".
// Writes: create_item / update_item / set_item_archived (admin-gated RPCs).
import { useEffect, useMemo, useRef, useState } from "react";
import { X, Save, Loader2, AlertCircle, Plus, Archive, ArchiveRestore, ChevronDown, CheckCircle2 } from "lucide-react";
import { sb, type Item } from "@/lib/supabase";
import { cn, fmtN, normalizeText } from "@/lib/utils";
import { useEscape } from "@/lib/hooks";
import { useConfirm } from "@/components/confirm-dialog";
import { CategoryPicker } from "@/components/category-picker";
import { type CatRow } from "@/lib/categories";

export type ItemPreset = Partial<Pick<Item, "category_id" | "brand" | "model" | "size" | "colour" | "case_size" | "hsn_code" | "gst_rate" | "reorder_point_a" | "reorder_point_b">>;
type ExistingLite = { id: string; brand: string | null; model: string; size: string | null; colour: string | null; archived?: boolean };

export function ItemFormModal({
  mode, item, categories, brands, stockTotal, onClose, onSaved, preset, existing, onCategoriesChange,
}: {
  mode: "create" | "edit";
  item?: Item | null;
  categories: CatRow[];
  /** Brands, most used first (the first few become one-tap chips). */
  brands: string[];
  /** Item's current total units (A+B) — powers the archive warning. */
  stockTotal?: number;
  onClose: () => void;
  /** After a save. `ids` = the items created (create mode). */
  onSaved: (ids?: string[], opts?: { keepOpen?: boolean }) => void | Promise<void>;
  /** Pre-filled values for a new item (current category, "Add similar"). */
  preset?: ItemPreset;
  /** Every item, to warn about duplicates. */
  existing?: ExistingLite[];
  onCategoriesChange?: (rows: CatRow[]) => void;
}) {
  const src: ItemPreset = (mode === "edit" ? item : preset) ?? {};
  const [cats, setCats] = useState<CatRow[]>(categories);
  useEffect(() => { setCats(categories); }, [categories]);
  const [categoryId, setCategoryId] = useState<string | null>(src.category_id ?? null);
  const [brand, setBrand] = useState(src.brand ?? "");
  const [model, setModel] = useState(src.model ?? "");
  const [size, setSize] = useState(src.size ?? "");
  // Edit: one colour box. Create: a list of colours (chips) + the box being typed.
  const [colour, setColour] = useState(mode === "edit" ? (src.colour ?? "") : "");
  const [colours, setColours] = useState<string[]>(mode === "create" && src.colour ? [] : []);
  const [caseSize, setCaseSize] = useState(src.case_size ? String(src.case_size) : "");
  const [open, setOpen] = useState({ aC: "", aL: "", bC: "", bL: "" });
  const [reorderA, setReorderA] = useState(src.reorder_point_a ? String(src.reorder_point_a) : "");
  const [reorderB, setReorderB] = useState(src.reorder_point_b ? String(src.reorder_point_b) : "");
  const [hsn, setHsn] = useState(src.hsn_code ?? "");
  const [gstPct, setGstPct] = useState(src.gst_rate != null ? String(+(Number(src.gst_rate) * 100).toFixed(2)) : "");
  const [moreOpen, setMoreOpen] = useState(mode === "edit" && !!(src.hsn_code || src.reorder_point_a || src.reorder_point_b || src.gst_rate != null));
  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const modelRef = useRef<HTMLInputElement>(null);

  const onlyDigits = (s: string) => s.replace(/[^\d]/g, "");
  const onlyDecimal = (s: string) => {
    const cleaned = s.replace(/[^\d.]/g, "");
    const dot = cleaned.indexOf(".");
    return dot === -1 ? cleaned : cleaned.slice(0, dot + 1) + cleaned.slice(dot + 1).replace(/\./g, "");
  };

  const { confirm, confirmDialog } = useConfirm();
  useEscape(!saving && !archiving && !confirmDialog, onClose);

  // All colours this save will create (chips + whatever is still in the box).
  const allColours = useMemo(() => {
    if (mode === "edit") return [colour.trim()];
    const list = [...colours];
    for (const c of colour.split(",").map(s => s.trim()).filter(Boolean)) if (!list.some(x => x.toLowerCase() === c.toLowerCase())) list.push(c);
    return list.length ? list : [""];
  }, [mode, colour, colours]);
  const many = allColours.length > 1;

  const addColourChip = () => {
    const parts = colour.split(",").map(s => s.trim()).filter(Boolean);
    if (!parts.length) return;
    setColours(prev => {
      const next = [...prev];
      for (const p of parts) if (!next.some(x => x.toLowerCase() === p.toLowerCase())) next.push(p);
      return next;
    });
    setColour("");
  };

  // Duplicate check (same brand + name + size + colour).
  const dupes = useMemo(() => {
    if (!existing || !model.trim()) return [];
    const k = (b: string | null | undefined, m: string, s: string | null | undefined, c: string | null | undefined) =>
      [b, m, s, c].map(v => normalizeText(v || "")).join("|");
    const mine = new Set(allColours.map(c => k(brand, model, size, c)));
    return existing.filter(e => e.id !== item?.id && mine.has(k(e.brand, e.model, e.size, e.colour)));
  }, [existing, brand, model, size, allColours, item?.id]);

  const cs = Number(caseSize || 0) | 0;
  const openN = { aC: Number(open.aC || 0) | 0, aL: Number(open.aL || 0) | 0, bC: Number(open.bC || 0) | 0, bL: Number(open.bL || 0) | 0 };
  const openA = cs > 0 ? openN.aC * cs + openN.aL : openN.aL;
  const openB = cs > 0 ? openN.bC * cs + openN.bL : openN.bL;
  const hasOpening = mode === "create" && !many && (openN.aC + openN.aL + openN.bC + openN.bL) > 0;

  async function archive() {
    if (!item) return;
    const units = stockTotal ?? 0;
    const ok = await confirm({
      title: `Archive “${item.model}”?`,
      body: (
        <>
          It leaves the item list but its history is kept. You can restore it later.
          {units > 0 && <> This item still shows <b>{fmtN(units)}</b> piece{units === 1 ? "" : "s"} in stock — archiving hides it but keeps the stock.</>}
        </>
      ),
      danger: true,
      confirmLabel: "Archive",
    });
    if (!ok) return;
    setError(null); setArchiving(true);
    try {
      const { error: e } = await sb().rpc("set_item_archived", { p_item_id: item.id, p_archived: true });
      if (e) throw e;
      await onSaved();
    } catch (e: any) {
      setError(e?.message || "Could not archive the item.");
    } finally { setArchiving(false); }
  }
  async function restore() {
    if (!item) return;
    setError(null); setArchiving(true);
    try {
      const { error: e } = await sb().rpc("set_item_archived", { p_item_id: item.id, p_archived: false });
      if (e) throw e;
      await onSaved();
    } catch (e: any) {
      setError(e?.message || "Could not restore the item.");
    } finally { setArchiving(false); }
  }

  async function save(addAnother: boolean) {
    if (!model.trim()) { setError("Type the item's name."); modelRef.current?.focus(); return; }
    setError(null); setSaving(true);
    const created: string[] = [];
    const doneColours: string[] = [];
    try {
      const c = sb();
      const gstFraction = gstPct.trim() === "" ? null : Math.max(0, parseFloat(gstPct) || 0) / 100;
      const common = {
        p_model: model.trim(),
        p_brand: brand.trim() || null,
        p_category_id: categoryId || null,
        p_size: size.trim() || null,
        p_case_size: cs,
        p_hsn_code: hsn.trim() || null,
        p_gst_rate: gstFraction,
        p_reorder_point_a: Number(reorderA || 0) | 0,
        p_reorder_point_b: Number(reorderB || 0) | 0,
      };
      if (mode === "edit") {
        const { error: e } = await c.rpc("update_item", { p_item_id: item!.id, ...common, p_colour: colour.trim() || null });
        if (e) throw e;
        await onSaved();
        return;
      }
      for (const col of allColours) {
        const { data, error: e } = await c.rpc("create_item", { ...common, p_colour: col || null, p_item_code: null });
        if (e) throw e;
        if (data) created.push(data as string);
        doneColours.push(col);
      }
      if (hasOpening && created[0]) {
        for (const [g, cases, loose, pcs] of [["A", openN.aC, openN.aL, openA], ["B", openN.bC, openN.bL, openB]] as const) {
          if (pcs <= 0 && cases <= 0 && loose <= 0) continue;
          const { error: e } = await c.rpc("apply_reconciliation", {
            p_item_id: created[0], p_godown: g, p_target_cases: cs > 0 ? cases : 0, p_target_loose: loose, p_reason: "Opening stock",
          });
          if (e) throw new Error(`The item was added, but its Godown ${g} stock was not saved (${e.message}). Use “Correct the count” on it.`);
        }
      }
      const name = `${model.trim()}${size.trim() ? " " + size.trim() : ""}`;
      await onSaved(created, { keepOpen: addAnother });
      if (addAnother) {
        setAdded(many ? `Added ${name} in ${allColours.length} colours.` : `Added ${name}.`);
        setModel(""); setColour(""); setColours([]); setOpen({ aC: "", aL: "", bC: "", bL: "" });
        setTimeout(() => modelRef.current?.focus(), 30);
      }
    } catch (e: any) {
      const msg = e?.message || "Could not save the item.";
      setError(created.length && mode === "create" && !/was added/.test(msg)
        ? `${created.length} of ${allColours.length} were added before this stopped: ${msg}`
        : msg);
      if (mode === "create" && doneColours.length) {
        // A retry must never add the same item twice: keep only the colours
        // that did NOT go in; if every one went in (the opening stock failed),
        // clear the name so the button can't be pressed again by mistake.
        const left = allColours.filter(c => !doneColours.includes(c));
        if (left.length && left.some(Boolean)) { setColours(left.filter(Boolean)); setColour(""); }
        else { setModel(""); setColour(""); setColours([]); setOpen({ aC: "", aL: "", bC: "", bL: "" }); }
      }
      if (created.length) await onSaved(created, { keepOpen: true });
    } finally {
      setSaving(false);
    }
  }

  const topBrands = brands.slice(0, 6);
  const title = mode === "create" ? (preset?.model ? "Add a similar item" : "Add an item") : "Edit item";

  return (
    <div className="fixed inset-0 z-50 bg-black/50 dark:bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4 animate-fade-in"
      role="dialog" aria-modal="true" aria-label={title} onClick={() => !saving && onClose()}>
      <div className="bg-white dark:bg-zinc-900 rounded-t-2xl sm:rounded-2xl w-full max-w-xl shadow-lg border border-zinc-200 dark:border-zinc-800 flex flex-col max-h-[94vh] sm:max-h-[90vh] animate-slide-up"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3.5 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between gap-4 flex-shrink-0">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{title}</h2>
            {mode === "edit" && item?.item_code && <p className="text-xs text-zinc-500 mt-0.5">Code {item.item_code} · stock is changed with “Correct the count”</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="w-9 h-9 -mr-2 flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          {added && (
            <div className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2">
              <CheckCircle2 className="w-4 h-4 flex-shrink-0" /> {added} Next one:
            </div>
          )}
          {item?.archived && (
            <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg p-2.5 text-[13px] text-amber-800 dark:text-amber-200">
              This item is <b>archived</b> — hidden from the list. Restore it to bring it back.
            </div>
          )}

          <Field label="Category">
            <CategoryPicker rows={cats} value={categoryId} onChange={setCategoryId} noneLabel="No category" canCreate
              onRowsChange={(r) => { setCats(r); onCategoriesChange?.(r); }} placeholder="Choose where it belongs" />
          </Field>

          <Field label="Brand">
            <input list="brand-list" value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="e.g. Goldmedal" className={inputCls} />
            <datalist id="brand-list">{brands.map(b => <option key={b} value={b} />)}</datalist>
            {topBrands.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {topBrands.map(b => (
                  <button key={b} type="button" onClick={() => setBrand(b)}
                    className={cn("px-2.5 py-1 rounded-full text-xs border transition-colors",
                      brand.trim().toLowerCase() === b.toLowerCase()
                        ? "bg-cyan-500/15 border-cyan-500/50 text-cyan-700 dark:text-cyan-300"
                        : "border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:border-cyan-500/40")}>
                    {b}
                  </button>
                ))}
              </div>
            )}
          </Field>

          <Field label="Name / model" required>
            <input ref={modelRef} value={model} onChange={(e) => setModel(e.target.value)} autoFocus={mode === "create"}
              placeholder="e.g. Enzo, Hero Prime (BLDC)" className={inputCls} />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Size">
              <input value={size} onChange={(e) => setSize(e.target.value)} placeholder="e.g. 1200mm" className={inputCls} />
            </Field>
            <Field label="Pieces in one case" hint="0 = sold loose">
              <input inputMode="numeric" value={caseSize} onChange={(e) => setCaseSize(onlyDigits(e.target.value))} placeholder="e.g. 4" className={cn(inputCls, "tabular-nums")} />
            </Field>
          </div>

          {mode === "edit" ? (
            <Field label="Colour">
              <input value={colour} onChange={(e) => setColour(e.target.value)} placeholder="e.g. Brown" className={inputCls} />
            </Field>
          ) : (
            <Field label="Colour" hint="add several to make one item per colour">
              {colours.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {colours.map(c => (
                    <span key={c} className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full text-xs bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">
                      {c}
                      <button type="button" onClick={() => setColours(p => p.filter(x => x !== c))} aria-label={`Remove ${c}`} className="w-5 h-5 flex items-center justify-center rounded-full text-zinc-400 hover:text-rose-600"><X className="w-3 h-3" /></button>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <input value={colour} onChange={(e) => setColour(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addColourChip(); } }}
                  placeholder={colours.length ? "Another colour…" : "e.g. Brown (press Enter to add more)"} className={inputCls} />
                <button type="button" onClick={addColourChip} disabled={!colour.trim()}
                  className="px-3 rounded-lg border border-zinc-200 dark:border-zinc-700 text-sm text-zinc-600 dark:text-zinc-300 hover:border-cyan-500/50 disabled:opacity-40 inline-flex items-center gap-1 flex-shrink-0">
                  <Plus className="w-4 h-4" /> Add
                </button>
              </div>
              {many && <p className="text-[12px] text-cyan-700 dark:text-cyan-300 mt-1.5">This will add <b>{allColours.length} items</b>, one for each colour.</p>}
            </Field>
          )}

          {mode === "create" && !many && (
            <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-3.5">
              <div className="text-sm font-medium">Stock you have now <span className="text-zinc-400 font-normal">· optional</span></div>
              <p className="text-[12px] text-zinc-500 mt-0.5 mb-3">Saved as an opening count. Leave empty and add stock later with a purchase.</p>
              <div className="grid grid-cols-2 gap-3">
                {(["A", "B"] as const).map(g => (
                  <div key={g}>
                    <div className={cn("text-[11px] font-semibold uppercase tracking-wider mb-1.5", g === "A" ? "text-cyan-700 dark:text-cyan-300" : "text-teal-700 dark:text-teal-300")}>Godown {g}</div>
                    <div className="flex gap-1.5">
                      {cs > 0 && (
                        <input inputMode="numeric" aria-label={`Godown ${g} cases`} placeholder="Cases" value={g === "A" ? open.aC : open.bC}
                          onChange={(e) => setOpen(o => ({ ...o, [g === "A" ? "aC" : "bC"]: onlyDigits(e.target.value) }))}
                          className={cn(inputCls, "tabular-nums px-2")} />
                      )}
                      <input inputMode="numeric" aria-label={`Godown ${g} loose pieces`} placeholder={cs > 0 ? "Loose" : "Pieces"} value={g === "A" ? open.aL : open.bL}
                        onChange={(e) => setOpen(o => ({ ...o, [g === "A" ? "aL" : "bL"]: onlyDigits(e.target.value) }))}
                        className={cn(inputCls, "tabular-nums px-2")} />
                    </div>
                    <div className="text-[11px] text-zinc-500 mt-1 tabular-nums">= {fmtN(g === "A" ? openA : openB)} pcs</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800">
            <button type="button" onClick={() => setMoreOpen(o => !o)} aria-expanded={moreOpen}
              className="w-full flex items-center justify-between px-3.5 py-3 text-sm text-left">
              <span><span className="font-medium">More details</span> <span className="text-zinc-400">· GST, HSN, low-stock warning</span></span>
              <ChevronDown className={cn("w-4 h-4 text-zinc-400 transition-transform", moreOpen && "rotate-180")} />
            </button>
            {moreOpen && (
              <div className="px-3.5 pb-3.5 grid grid-cols-2 gap-3">
                <Field label="GST %">
                  <input inputMode="decimal" value={gstPct} onChange={(e) => setGstPct(onlyDecimal(e.target.value))} placeholder="18" className={cn(inputCls, "tabular-nums")} />
                </Field>
                <Field label="HSN code">
                  <input value={hsn} onChange={(e) => setHsn(e.target.value)} placeholder="e.g. 8414" className={cn(inputCls, "tabular-nums")} />
                </Field>
                <Field label="Warn when A is at">
                  <input inputMode="numeric" value={reorderA} onChange={(e) => setReorderA(onlyDigits(e.target.value))} placeholder="2" className={cn(inputCls, "tabular-nums")} />
                </Field>
                <Field label="Warn when B is at">
                  <input inputMode="numeric" value={reorderB} onChange={(e) => setReorderB(onlyDigits(e.target.value))} placeholder="2" className={cn(inputCls, "tabular-nums")} />
                </Field>
                <p className="col-span-2 text-[11px] text-zinc-500 -mt-1">Pieces at or below this show as “Low”. Empty = 2. The GST here is used until the item gets a price on the Pricing page.</p>
              </div>
            )}
          </div>

          {dupes.length > 0 && (
            <div className="text-[13px] text-amber-800 dark:text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded-lg p-2.5 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>Already in the list: {dupes.slice(0, 3).map(d => [d.brand, d.model, d.size, d.colour].filter(Boolean).join(" · ") + (d.archived ? " (archived)" : "")).join("; ")}. You can still save if this is a different item.</span>
            </div>
          )}
          {error && (
            <div className="text-sm text-rose-600 dark:text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg p-2.5 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-zinc-200 dark:border-zinc-800 flex items-center gap-2 bg-zinc-50 dark:bg-zinc-900/50 flex-shrink-0 rounded-b-2xl"
          style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}>
          {mode === "edit" && (item?.archived ? (
            <button type="button" onClick={restore} disabled={archiving || saving}
              className="px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/10 rounded-md inline-flex items-center gap-1.5 disabled:opacity-40">
              {archiving ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArchiveRestore className="w-4 h-4" />} Restore
            </button>
          ) : (
            <button type="button" onClick={archive} disabled={archiving || saving}
              className="px-3 py-2 text-sm text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 rounded-md inline-flex items-center gap-1.5 disabled:opacity-40">
              {archiving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Archive className="w-4 h-4" />} Archive
            </button>
          ))}
          <div className="flex-1" />
          {mode === "create" ? (
            <>
              <button type="button" onClick={() => save(true)} disabled={saving || !model.trim()}
                className="px-3 py-2 text-sm font-medium text-cyan-700 dark:text-cyan-300 hover:bg-cyan-500/10 rounded-md disabled:opacity-40">
                Save &amp; add another
              </button>
              <button type="button" onClick={() => save(false)} disabled={saving || !model.trim()}
                className="bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed text-white px-4 py-2 rounded-md text-sm font-medium inline-flex items-center gap-1.5">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                {saving ? "Saving…" : many ? `Add ${allColours.length} items` : "Add item"}
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={onClose} className="px-3 py-2 text-sm text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded-md">Cancel</button>
              <button type="button" onClick={() => save(false)} disabled={saving || !model.trim()}
                className="bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed text-white px-4 py-2 rounded-md text-sm font-medium inline-flex items-center gap-1.5">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {saving ? "Saving…" : "Save changes"}
              </button>
            </>
          )}
        </div>
        {confirmDialog}
      </div>
    </div>
  );
}

const inputCls =
  "w-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-2.5 sm:py-2 text-[15px] sm:text-sm focus:outline-none focus:border-cyan-500";

function Field({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-baseline gap-1.5 mb-1.5">
        <span className="text-[13px] font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
        {required && <span className="text-rose-500 text-xs">*</span>}
        {hint && <span className="text-[11px] text-zinc-400">· {hint}</span>}
      </div>
      {children}
    </div>
  );
}
