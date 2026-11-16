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

// ─── 2026-11-16 redesign helpers ─────────────────────────────────────────

// Normalise a CatRow-ish DB row (the select("*") shape) into a CatRow.
export function toCatRow(x: any): CatRow {
  return {
    id: x.id, name: x.name, parent_id: x.parent_id ?? null,
    sort_order: x.sort_order ?? 0, archived: x.archived ?? false,
  };
}

// Every id at or under `id`, walking the RAW parent links (archived rows
// included) — so a real descendant under an archived middle node still
// counts as a descendant (the move RPC would reject it as a cycle).
export function descendantIds(rows: CatRow[], id: string): Set<string> {
  const byParent = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.parent_id) continue;
    const list = byParent.get(r.parent_id) ?? [];
    list.push(r.id);
    byParent.set(r.parent_id, list);
  }
  const ids = new Set<string>([id]);
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const kid of byParent.get(cur) ?? []) {
      if (!ids.has(kid)) { ids.add(kid); stack.push(kid); }
    }
  }
  return ids;
}

// Items per category INCLUDING everything below it ("Fans" counts the items
// in Fans › Ceiling › BLDC too). `direct` = item count per category id.
export function rollupCounts(rows: CatRow[], direct: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  const nodes = flattenTree(buildCategoryTree(rows, true));
  const byId = new Map(rows.map(r => [r.id, r]));
  for (const n of nodes) out.set(n.id, 0);
  for (const [catId, n] of direct) {
    // Walk up the parent chain, adding n to every ancestor (cycle-guarded).
    let cur: string | null | undefined = catId;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      out.set(cur, (out.get(cur) ?? 0) + n);
      cur = byId.get(cur)?.parent_id ?? null;
    }
  }
  return out;
}

// Path ids root → … → id (inclusive), for breadcrumbs.
export function ancestorChain(rows: CatRow[], id: string | null): CatRow[] {
  if (!id) return [];
  const byId = new Map(rows.map(r => [r.id, r]));
  const chain: CatRow[] = [];
  const seen = new Set<string>();
  let cur: CatRow | undefined = byId.get(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return chain;
}

// A live (non-archived) sibling with the same name (case-insensitive) under
// `parentId` — the database refuses that pair, so check it first and say so
// in plain words instead of a raw "duplicate key" error.
export function siblingWithName(rows: CatRow[], parentId: string | null, name: string, exceptId?: string): CatRow | undefined {
  const n = name.trim().toLowerCase();
  return rows.find(r => !r.archived && (r.parent_id ?? null) === (parentId ?? null) && r.id !== exceptId && r.name.trim().toLowerCase() === n);
}

// Split "Fans / Ceiling / Premium" (also › > \) into clean segments.
export function splitPath(text: string): string[] {
  return text.split(/\s*(?:\/|›|>|\\)\s*/).map(s => s.trim()).filter(Boolean);
}

// Turn database errors into words a shop counter understands.
export function friendlyCatError(e: any): string {
  const msg: string = e?.message || String(e || "");
  if (/duplicate key|categories_parent_name_uq|unique/i.test(msg)) {
    return "A category with that name is already there. Pick another name, or use the existing one.";
  }
  if (/only an active admin/i.test(msg)) return "Only an admin can change categories.";
  return msg || "That didn't work. Please try again.";
}
