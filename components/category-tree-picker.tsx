"use client";
import { useMemo } from "react";
import { buildCategoryTree, flattenTree, type CatRow } from "@/lib/categories";

// Assign an item to ANY node in the category tree. A native <select> with
// depth-indented options — accessible, mobile-friendly, and degrades to a flat
// list before the tree migration runs (rows are all roots until then).
//
// `archivedValueId`: an item can be assigned to a category that has since been
// archived — archived nodes aren't offered as options, so the select would
// otherwise render BLANK (value matches no option). Pass the item's current
// category id here and, if it isn't among the rendered options, it's appended
// as a "(archived)" option so the assignment stays visible and submittable.

export function CategoryTreePicker({
  rows, value, onChange, className, id, archivedValueId,
}: {
  rows: CatRow[];
  value: string;
  onChange: (id: string) => void;
  className?: string;
  id?: string;
  archivedValueId?: string | null;
}) {
  // buildCategoryTree drops archived rows itself, so callers may pass the
  // full rows (archived included) — we resolve the archived name from them.
  const flat = useMemo(() => flattenTree(buildCategoryTree(rows)), [rows]);
  const archivedOption = useMemo(() => {
    if (!archivedValueId) return null;
    if (flat.some((n) => n.id === archivedValueId)) return null;
    const row = rows.find((r) => r.id === archivedValueId);
    return { id: archivedValueId, name: row?.name ?? "Unknown" };
  }, [archivedValueId, flat, rows]);
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={className}>
      <option value="">— none —</option>
      {flat.map((n) => (
        <option key={n.id} value={n.id}>
          {/* Indent with NBSP (U+00A0) chars - browsers collapse plain
              spaces in <option> text, flattening the hierarchy. */}
          {"   ".repeat(n.depth) + (n.depth > 0 ? "└ " : "") + n.name}
        </option>
      ))}
      {archivedOption && (
        <option value={archivedOption.id}>{archivedOption.name} (archived)</option>
      )}
    </select>
  );
}
