"use client";
import { useEffect, useState, useMemo } from "react";
import { X, Save, Loader2, AlertCircle, Plus, Archive, ArchiveRestore, FolderPlus } from "lucide-react";
import { sb, type Item } from "@/lib/supabase";
import { fmtN } from "@/lib/utils";
import { useEscape } from "@/lib/hooks";
import { useConfirm } from "@/components/confirm-dialog";
import { CategoryTreePicker } from "@/components/category-tree-picker";
import { pathById, type CatRow } from "@/lib/categories";

// Create / edit an item's catalogue attributes. Stock quantity is NOT handled
// here — that stays in the dedicated stock-override flow and process_transaction.
// Writes go through the create_item / update_item RPCs (admin-gated). A new
// item is global, so it appears in both Godown A and B immediately.

export function ItemFormModal({
  mode, item, categories, brands, stockTotal, onClose, onSaved,
}: {
  mode: "create" | "edit";
  item?: Item | null;
  categories: CatRow[];
  brands: string[];
  /** Item's current total units (A+B) — powers the archive warning. */
  stockTotal?: number;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [model, setModel] = useState(item?.model ?? "");
  const [brand, setBrand] = useState(item?.brand ?? "");
  const [categoryId, setCategoryId] = useState(item?.category_id ?? "");
  // Local copy of the tree so a newly-created (sub)category shows up instantly.
  const [cats, setCats] = useState<CatRow[]>(categories);
  // The page may pass [] before its async load lands — adopt the prop when it
  // arrives (the local fork only exists to inject newly-created nodes).
  useEffect(() => { setCats(categories); }, [categories]);
  const [showNewCat, setShowNewCat] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const [newCatParent, setNewCatParent] = useState<string>("");
  const [creatingCat, setCreatingCat] = useState(false);
  const [size, setSize] = useState(item?.size ?? "");
  const [colour, setColour] = useState(item?.colour ?? "");
  const [caseSize, setCaseSize] = useState(String(item?.case_size ?? ""));
  const [reorderA, setReorderA] = useState(String(item?.reorder_point_a ?? ""));
  const [reorderB, setReorderB] = useState(String(item?.reorder_point_b ?? ""));
  const [hsn, setHsn] = useState(item?.hsn_code ?? "");
  // items.gst_rate is stored as a fraction (0.18); the field shows a percent.
  // Decimals allowed — fractional legal rates (0.25%, 1.5%) must survive a
  // re-save instead of rounding to a whole percent.
  const [gstPct, setGstPct] = useState(
    item?.gst_rate != null ? String(+(item.gst_rate * 100).toFixed(2)) : ""
  );
  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onlyDigits = (s: string) => s.replace(/[^\d]/g, "");
  // Digits + a single decimal point (for fractional GST rates).
  const onlyDecimal = (s: string) => {
    const cleaned = s.replace(/[^\d.]/g, "");
    const dot = cleaned.indexOf(".");
    return dot === -1 ? cleaned : cleaned.slice(0, dot + 1) + cleaned.slice(dot + 1).replace(/\./g, "");
  };

  const { confirm, confirmDialog } = useConfirm();
  // Escape closes the modal — guarded while saving/archiving, and while the
  // confirm dialog is up (so one Escape doesn't close both layers).
  useEscape(!saving && !archiving && !confirmDialog, onClose);

  async function archive() {
    if (!item) return;
    const units = stockTotal ?? 0;
    const ok = await confirm({
      title: `Archive “${item.model}”?`,
      body: (
        <>
          It leaves the catalogue but its history is kept. You can restore it later.
          {units > 0 && (
            <>
              {" "}This item still shows <b>{fmtN(units)}</b> unit{units === 1 ? "" : "s"} in stock —
              archiving hides it from every list but keeps the stock rows.
            </>
          )}
        </>
      ),
      danger: true,
      confirmLabel: "Archive",
    });
    if (!ok) return;
    setError(null);
    setArchiving(true);
    try {
      const { error: e } = await sb().rpc("set_item_archived", { p_item_id: item.id, p_archived: true });
      if (e) throw e;
      await onSaved();
    } catch (e: any) {
      setError(e?.message || "Failed to archive item.");
    } finally {
      setArchiving(false);
    }
  }

  async function restore() {
    if (!item) return;
    setError(null);
    setArchiving(true);
    try {
      const { error: e } = await sb().rpc("set_item_archived", { p_item_id: item.id, p_archived: false });
      if (e) throw e;
      await onSaved();
    } catch (e: any) {
      setError(e?.message || "Failed to restore item.");
    } finally {
      setArchiving(false);
    }
  }

  async function save() {
    if (!model.trim()) { setError("Model is required."); return; }
    setError(null);
    setSaving(true);
    try {
      const c = sb();
      const gstFraction = gstPct.trim() === "" ? null : Math.max(0, parseFloat(gstPct) || 0) / 100;
      const common = {
        p_model: model.trim(),
        p_brand: brand.trim() || null,
        p_category_id: categoryId || null,
        p_size: size.trim() || null,
        p_colour: colour.trim() || null,
        p_case_size: Number(caseSize || 0) | 0,
        p_hsn_code: hsn.trim() || null,
        p_gst_rate: gstFraction,
        p_reorder_point_a: Number(reorderA || 0) | 0,
        p_reorder_point_b: Number(reorderB || 0) | 0,
      };
      if (mode === "create") {
        const { error: e } = await c.rpc("create_item", { ...common, p_item_code: null });
        if (e) throw e;
      } else {
        const { error: e } = await c.rpc("update_item", { p_item_id: item!.id, ...common });
        if (e) throw e;
      }
      await onSaved();
    } catch (e: any) {
      setError(e?.message || "Failed to save item.");
    } finally {
      setSaving(false);
    }
  }

  const pathOf = useMemo(() => pathById(cats), [cats]);

  async function createCategory() {
    const name = newCatName.trim();
    if (!name) return;
    setCreatingCat(true);
    setError(null);
    try {
      const { data, error: e } = await sb().rpc("category_create", {
        p_name: name, p_parent_id: newCatParent || null,
      });
      if (e) throw e;
      const newId = data as string;
      // Re-pull the tree so the picker shows the new (or reused) node.
      const { data: fresh, error: freshErr } = await sb().from("categories").select("*");
      if (!freshErr && fresh) {
        const rows: CatRow[] = (fresh as any[]).map((x) => ({
          id: x.id, name: x.name, parent_id: x.parent_id ?? null,
          sort_order: x.sort_order ?? 0, archived: x.archived ?? false,
        }));
        setCats(rows);
      } else {
        // Refresh failed — keep the current list and just append the created
        // node locally so the picker isn't wiped.
        setCats(prev => prev.some(r => r.id === newId)
          ? prev
          : [...prev, { id: newId, name, parent_id: newCatParent || null, sort_order: 0, archived: false }]);
      }
      setCategoryId(newId);
      setShowNewCat(false);
      setNewCatName("");
    } catch (e: any) {
      setError(e?.message || "Couldn't create the category.");
    } finally {
      setCreatingCat(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 dark:bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4"
      role="dialog" aria-modal="true" aria-label={mode === "create" ? "Add item" : "Edit item"}
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-zinc-900 rounded-t-2xl sm:rounded-2xl w-full max-w-2xl shadow-lg border border-zinc-200 dark:border-zinc-800 flex flex-col max-h-[95vh] sm:max-h-[90vh] animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800 flex items-start justify-between gap-4 flex-shrink-0">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{mode === "create" ? "Add a new item" : "Edit item details"}</h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              {mode === "create"
                ? "Creates the item for both godowns. Add stock afterwards via Transactions."
                : "Catalogue details only — stock quantity is changed elsewhere."}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 -mr-1.5 p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          {item?.archived && (
            <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-md p-2.5 text-[12px] text-amber-800 dark:text-amber-200">
              This item is <b>archived</b> — hidden from the catalogue. Restore it to bring it back.
            </div>
          )}
          <Field label="Model / name" required>
            <input value={model} onChange={(e) => setModel(e.target.value)} autoFocus
              placeholder="e.g. Renesa 1200mm" className={inputCls} />
          </Field>

          <Field label="Brand">
            <input list="brand-list" value={brand} onChange={(e) => setBrand(e.target.value)}
              placeholder="e.g. Goldmedal" className={inputCls} />
            <datalist id="brand-list">{brands.map(b => <option key={b} value={b} />)}</datalist>
          </Field>
          {mode === "create" ? (
            <p className="text-[11px] text-zinc-500 -mt-1">The item code is generated automatically.</p>
          ) : item?.item_code ? (
            <p className="text-[11px] text-zinc-500 -mt-1">
              Item code <span className="tnum text-zinc-600 dark:text-zinc-300">{item.item_code}</span> · auto-assigned, can’t be changed.
            </p>
          ) : null}

          <Field label="Category" hint="pick any level — this is where the item lives in the tree">
            <CategoryTreePicker rows={cats} value={categoryId} onChange={setCategoryId} className={inputCls} archivedValueId={item?.category_id ?? null} />
            {categoryId && (
              <div className="text-[11px] text-zinc-500 mt-1 truncate">{pathOf.get(categoryId) || ""}</div>
            )}
            {!showNewCat ? (
              <button
                type="button"
                onClick={() => { setNewCatParent(categoryId); setNewCatName(""); setShowNewCat(true); }}
                className="mt-2 inline-flex items-center gap-1 text-[12px] text-cyan-600 dark:text-cyan-400 hover:underline"
              >
                <FolderPlus className="w-3.5 h-3.5" /> New category / subcategory
              </button>
            ) : (
              <div className="mt-2 border border-cyan-500/30 bg-cyan-500/[0.04] rounded-md p-3 space-y-2">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium mb-1">Parent</div>
                  <CategoryTreePicker rows={cats} value={newCatParent} onChange={setNewCatParent} className={inputCls} />
                  <div className="text-[11px] text-zinc-500 mt-1 truncate">
                    {newCatParent ? `Under ${pathOf.get(newCatParent) || "…"}` : "Creates a top-level category"}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-medium mb-1">New name</div>
                  <input
                    value={newCatName}
                    autoFocus
                    onChange={(e) => setNewCatName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void createCategory(); } }}
                    placeholder="e.g. Modular, Premium, Ceiling…"
                    className={inputCls}
                  />
                </div>
                <div className="flex items-center gap-2 pt-0.5">
                  <button
                    type="button" onClick={() => void createCategory()} disabled={creatingCat || !newCatName.trim()}
                    className="bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 text-white px-3 py-1.5 rounded-md text-[13px] font-medium inline-flex items-center gap-1.5"
                  >
                    {creatingCat ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                    Add &amp; select
                  </button>
                  <button
                    type="button" onClick={() => { setShowNewCat(false); setNewCatName(""); }}
                    className="px-3 py-1.5 text-[13px] text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded-md"
                  >
                    Cancel
                  </button>
                </div>
                <p className="text-[11px] text-zinc-500">Reuses the existing one if that name already exists under the parent — no duplicates.</p>
              </div>
            )}
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Size"><input value={size} onChange={(e) => setSize(e.target.value)} placeholder="e.g. 1200mm" className={inputCls} /></Field>
            <Field label="Colour"><input value={colour} onChange={(e) => setColour(e.target.value)} placeholder="e.g. Brown" className={inputCls} /></Field>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Field label="Case size" hint="units / carton">
              <input inputMode="numeric" value={caseSize} onChange={(e) => setCaseSize(onlyDigits(e.target.value))} placeholder="0" className={`${inputCls} tnum`} />
            </Field>
            <Field label="GST %">
              <input inputMode="decimal" value={gstPct} onChange={(e) => setGstPct(onlyDecimal(e.target.value))} placeholder="18" className={`${inputCls} tnum`} />
              <p className="text-[10px] text-zinc-400 mt-1 leading-snug">Used until a pricing row exists — the Pricing page then takes over.</p>
            </Field>
            <Field label="Reorder A"><input inputMode="numeric" value={reorderA} onChange={(e) => setReorderA(onlyDigits(e.target.value))} placeholder="0" className={`${inputCls} tnum`} /></Field>
            <Field label="Reorder B"><input inputMode="numeric" value={reorderB} onChange={(e) => setReorderB(onlyDigits(e.target.value))} placeholder="0" className={`${inputCls} tnum`} /></Field>
          </div>
          <p className="text-[11px] text-zinc-500 -mt-1">Low-stock alerts trigger at max(A+B, 2) on Items / per godown on Godown pages.</p>

          <Field label="HSN code" hint="optional">
            <input value={hsn} onChange={(e) => setHsn(e.target.value)} placeholder="e.g. 8414" className={`${inputCls} tnum`} />
          </Field>

          {error && (
            <div className="text-sm text-rose-600 dark:text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-md p-2.5 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </div>
          )}
        </div>

        <div
          className="px-5 py-3 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-end gap-2 bg-zinc-50 dark:bg-zinc-900/50 flex-shrink-0"
          style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
        >
          {mode === "edit" && (item?.archived ? (
            <button type="button" onClick={restore} disabled={archiving || saving}
              className="mr-auto px-3 py-2 text-sm text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 rounded-md inline-flex items-center gap-1.5 disabled:opacity-40">
              {archiving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArchiveRestore className="w-3.5 h-3.5" />}
              Restore
            </button>
          ) : (
            <button type="button" onClick={archive} disabled={archiving || saving}
              className="mr-auto px-3 py-2 text-sm text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 rounded-md inline-flex items-center gap-1.5 disabled:opacity-40">
              {archiving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Archive className="w-3.5 h-3.5" />}
              Archive
            </button>
          ))}
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded-md">Cancel</button>
          <button type="button" onClick={save} disabled={saving || !model.trim()}
            className="bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed text-white px-3.5 py-2 rounded-md text-sm font-medium flex items-center gap-1.5">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : mode === "create" ? <Plus className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
            {saving ? "Saving…" : mode === "create" ? "Create item" : "Save changes"}
          </button>
        </div>
        {/* Inside the card so its clicks don't bubble to the overlay's onClose */}
        {confirmDialog}
      </div>
    </div>
  );
}

const inputCls =
  "w-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-cyan-500";

function Field({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-[11px] uppercase tracking-wider text-zinc-500 font-medium">{label}</span>
        {required && <span className="text-rose-500 text-[11px]">*</span>}
        {hint && <span className="text-[10px] text-zinc-400 normal-case tracking-normal">· {hint}</span>}
      </div>
      {children}
    </div>
  );
}
