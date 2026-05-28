"use client";
import { useMemo } from "react";
import { buildCategoryTree, flattenTree, type CatRow } from "@/lib/categories";

// Assign an item to ANY node in the category tree. A native <select> with
// depth-indented options — accessible, mobile-friendly, and degrades to a flat
// list before the tree migration runs (rows are all roots until then).

export function CategoryTreePicker({
  rows, value, onChange, className, id,
}: {
  rows: CatRow[];
  value: string;
  onChange: (id: string) => void;
  className?: string;
  id?: string;
}) {
  const flat = useMemo(() => flattenTree(buildCategoryTree(rows)), [rows]);
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={className}>
      <option value="">— none —</option>
      {flat.map((n) => (
        <option key={n.id} value={n.id}>
          {"   ".repeat(n.depth) + (n.depth > 0 ? "└ " : "") + n.name}
        </option>
      ))}
    </select>
  );
}
