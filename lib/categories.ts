// Shared helpers for the nested category tree (see db/2026-05-29-category-tree.sql).
// Used by the /categories manager and the item-form tree picker. Pure +
// defensive: tolerates rows whose parent is missing/archived (they surface as
// roots, never vanish) and guards against accidental cycles.

export type CatRow = {
  id: string;
  name: string;
  parent_id?: string | null;
  sort_order?: number | null;
  archived?: boolean | null;
};

export type CatNode = CatRow & {
  depth: number;
  path: string[];      // root → … → this node (names, inclusive)
  children: CatNode[];
};

export function buildCategoryTree(rows: CatRow[], includeArchived = false): CatNode[] {
  const visible = rows.filter((r) => includeArchived || !r.archived);
  const visibleIds = new Set(visible.map((r) => r.id));

  // A row whose parent isn't visible (null, archived, or dangling) is treated
  // as a root so it never disappears from the tree.
  const effParent = (r: CatRow): string | null =>
    r.parent_id && visibleIds.has(r.parent_id) ? r.parent_id : null;

  const byParent = new Map<string | null, CatRow[]>();
  for (const r of visible) {
    const k = effParent(r);
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k)!.push(r);
  }

  const sortFn = (a: CatRow, b: CatRow) =>
    (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name);

  const build = (parent: string | null, depth: number, parentPath: string[], seen: Set<string>): CatNode[] => {
    const kids = (byParent.get(parent) ?? []).slice().sort(sortFn);
    return kids
      .filter((r) => !seen.has(r.id))
      .map((r) => {
        const path = [...parentPath, r.name];
        const nextSeen = new Set(seen).add(r.id);
        return { ...r, depth, path, children: build(r.id, depth + 1, path, nextSeen) };
      });
  };

  const roots = build(null, 0, [], new Set());

  // Rows caught in a true parent-id cycle (A→B→…→A) are reachable from no
  // root, so the walk above never visits them — they'd silently vanish,
  // breaking the "rows never vanish" contract. Surface each cycle once as a
  // root; the seen-guard inside build() stops the loop from recursing forever.
  const visited = new Set<string>();
  const mark = (ns: CatNode[]) => { for (const n of ns) { visited.add(n.id); mark(n.children); } };
  mark(roots);
  for (const r of visible.slice().sort(sortFn)) {
    if (visited.has(r.id)) continue;
    const path = [r.name];
    const node: CatNode = { ...r, depth: 0, path, children: build(r.id, 1, path, new Set([r.id])) };
    mark([node]);
    roots.push(node);
  }

  return roots;
}

// Pre-order flatten — handy for indented <select> options and search.
export function flattenTree(nodes: CatNode[]): CatNode[] {
  const out: CatNode[] = [];
  const walk = (ns: CatNode[]) => { for (const n of ns) { out.push(n); walk(n.children); } };
  walk(nodes);
  return out;
}

// Map of id → full path string ("Fans › Ceiling › Premium"), for display.
export function pathById(rows: CatRow[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const n of flattenTree(buildCategoryTree(rows, true))) {
    m.set(n.id, n.path.join(" › "));
  }
  return m;
}
