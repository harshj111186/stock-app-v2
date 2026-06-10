// Demo/mock dataset for the public "View demo" mode. Pure client-side data —
// NEVER touches the real Supabase database. Shapes mirror lib/supabase.ts types.
// Numbers are illustrative for a fictional electricals distributor ("Demo Traders").

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}
function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function tsAgo(n: number, hour = 11): string {
  const d = daysAgo(n);
  d.setHours(hour, (n * 7) % 60, 0, 0);
  return d.toISOString();
}

// ── Categories ─────────────────────────────────────────────────────────────
// Shape mirrors public.categories (parent_id + sort_order, see lib/categories).
// The Fans branch nests two levels deep so the unlimited-depth tree demos.
export const CATEGORIES: { id: string; name: string; parent_id: string | null; archived: boolean; sort_order: number }[] = [
  { id: "cat-wires", name: "Wires & Cables", parent_id: null, archived: false, sort_order: 1 },
  { id: "cat-switches", name: "Switches & Plates", parent_id: null, archived: false, sort_order: 2 },
  { id: "cat-mcb", name: "MCBs & Distribution", parent_id: null, archived: false, sort_order: 3 },
  { id: "cat-light", name: "LED Lighting", parent_id: null, archived: false, sort_order: 4 },
  { id: "cat-fans", name: "Fans", parent_id: null, archived: false, sort_order: 5 },
  { id: "cat-fans-ceiling", name: "Ceiling", parent_id: "cat-fans", archived: false, sort_order: 1 },
  { id: "cat-fans-ceiling-bldc", name: "BLDC", parent_id: "cat-fans-ceiling", archived: false, sort_order: 1 },
  { id: "cat-fans-exhaust", name: "Exhaust", parent_id: "cat-fans", archived: false, sort_order: 2 },
  { id: "cat-sockets", name: "Sockets & Plugs", parent_id: null, archived: false, sort_order: 6 },
];

// ── Items (24, four per category) ────────────────────────────────────────────
type Seed = [brand: string, cat: string, model: string, size: string, colour: string, caseSize: number, lp: number, disc: number];
const SEED: Seed[] = [
  ["Havells", "cat-wires", "Life Line Plus FR", "1.0 sqmm", "Red", 1, 1320, 0.40],
  ["Polycab", "cat-wires", "Greenwire FR-LSH", "1.5 sqmm", "Black", 1, 1890, 0.42],
  ["Finolex", "cat-wires", "Flame Retardant", "2.5 sqmm", "Blue", 1, 3120, 0.38],
  ["Havells", "cat-wires", "Multicore Flex", "3 core 1.5", "Grey", 1, 5450, 0.36],
  ["Anchor", "cat-switches", "Roma Classic 1-Way", "6 A", "White", 20, 72, 0.30],
  ["Legrand", "cat-switches", "Myrius 2-Way", "16 A", "White", 10, 165, 0.34],
  ["Anchor", "cat-switches", "Penta Modular Plate", "4 Module", "Ivory", 10, 96, 0.28],
  ["GM", "cat-switches", "Fireball Bell Push", "6 A", "White", 20, 58, 0.30],
  ["Havells", "cat-mcb", "Euro-II SP MCB", "16 A C-curve", "—", 12, 245, 0.45],
  ["Legrand", "cat-mcb", "DX3 DP MCB", "32 A C-curve", "—", 6, 690, 0.44],
  ["Schneider", "cat-mcb", "Acti9 RCCB", "40 A 30mA", "—", 4, 2150, 0.40],
  ["Havells", "cat-mcb", "Double Door DB", "8-Way", "Grey", 1, 1480, 0.38],
  ["Philips", "cat-light", "Astra Max LED Batten", "20 W", "CDL", 10, 410, 0.46],
  ["Wipro", "cat-light", "Garnet LED Panel", "12 W Round", "CDL", 8, 365, 0.44],
  ["Syska", "cat-light", "R> LED Bulb", "9 W", "CW", 24, 95, 0.40],
  ["Havells", "cat-light", "Adore Cove Strip", "5 m", "Warm", 6, 760, 0.42],
  ["Crompton", "cat-fans", "Hill Briz Ceiling", "1200 mm", "Brown", 1, 2390, 0.30],
  ["Orient", "cat-fans", "Aeroquiet Ceiling", "1200 mm", "Pearl White", 1, 3150, 0.32],
  ["Havells", "cat-fans", "Swing Wall Fan", "400 mm", "White", 1, 2680, 0.28],
  ["Usha", "cat-fans", "Striker Exhaust", "150 mm", "White", 1, 1490, 0.26],
  ["Anchor", "cat-sockets", "Penta 6A Socket", "6 A", "White", 20, 64, 0.30],
  ["Legrand", "cat-sockets", "Lyncus 16A Socket", "16 A", "White", 10, 210, 0.34],
  ["GM", "cat-sockets", "3-Pin Plug Top", "16 A", "Black", 25, 78, 0.30],
  ["Anchor", "cat-sockets", "Spike Guard 4-Way", "6 A", "White", 6, 540, 0.24],
];

export const ITEMS = SEED.map((s, i) => {
  const [brand, category_id, model, size, colour, case_size, , disc] = s;
  const cat = CATEGORIES.find(c => c.id === category_id)!;
  return {
    id: `it-${String(i + 1).padStart(3, "0")}`,
    item_code: `${brand.slice(0, 3).toUpperCase()}-${String(i + 1).padStart(3, "0")}`,
    brand,
    category_id,
    category: cat.name,
    subcategory: null as string | null,
    model,
    size,
    colour,
    case_size,
    hsn_code: ["8544", "8536", "8536", "9405", "8414", "8536"][i % 6],
    gst_rate: 0.18,
    reorder_point_a: 8 + (i % 5) * 2,
    reorder_point_b: 6 + (i % 4) * 2,
    image_url: null as string | null,
    archived: false,
    archived_at: null as string | null,
    created_at: tsAgo(120 + i),
    _disc: disc,
  };
});

// ── Stock per item, split across Godown A and B ──────────────────────────────
export const STOCK = ITEMS.flatMap((it, i) => {
  // Vary so dashboard shows healthy / low / out-of-stock variety.
  const baseA = (i * 37) % 19;          // 0..18 cases
  const baseB = (i * 23) % 11;          // 0..10 cases
  const looseA = (i * 13) % (it.case_size > 1 ? it.case_size : 7);
  const looseB = (i * 5) % (it.case_size > 1 ? it.case_size : 5);
  // Force a couple of out-of-stock and low-stock items for the KPIs.
  const out = i % 11 === 0;
  return [
    { item_id: it.id, godown: "A" as const, cases: out ? 0 : baseA, loose: out ? 0 : looseA },
    { item_id: it.id, godown: "B" as const, cases: out ? 0 : baseB, loose: out ? 0 : looseB },
  ];
});

// ── Pricing per item ─────────────────────────────────────────────────────────
export const PRICING = ITEMS.map((it) => ({
  item_id: it.id,
  lp: SEED[ITEMS.indexOf(it)][6],
  discount: it._disc,
  discounts: [it._disc],
  gst_rate: 0.18,
  effective_from: tsAgo(60),
}));

// ── Transactions over the last ~28 days (sales + purchases + returns) ────────
const ACTIONS = ["Sale", "Sale", "Sale", "Purchase", "Sale", "Transfer", "Sale", "Adjustment"] as const;
export const TRANSACTIONS = Array.from({ length: 46 }).map((_, k) => {
  const it = ITEMS[(k * 7) % ITEMS.length];
  // A couple of customer returns (direction +1) so the reports' netting demos.
  const action: (typeof ACTIONS)[number] | "Return" =
    k === 10 || k === 26 ? "Return" : ACTIONS[k % ACTIONS.length];
  const day = (k * 3) % 28;             // spread across 28 days
  const godown = (k % 2 === 0 ? "A" : "B") as "A" | "B";
  const qty = action === "Return" ? 1 + (k % 3) : 2 + ((k * 11) % 40);
  // Direction follows the action: stock IN (+1) for Purchase and customer
  // Return, OUT (−1) for Sale / Transfer-out; Adjustments swing both ways.
  const dir: 1 | -1 =
    action === "Purchase" || action === "Return" ? 1 :
    action === "Adjustment" ? (k % 16 === 7 ? 1 : -1) : -1;
  return {
    id: `txn-${String(k + 1).padStart(3, "0")}`,
    item_id: it.id,
    txn_date: isoDate(daysAgo(day)),
    action,
    godown,
    qty,
    direction: dir,
    status: "active",
    reverses_id: null as string | null,
    party_id: null as string | null,
    invoice_no: action === "Sale" ? `INV/${2026}/${1200 + k}` : action === "Purchase" ? `PO/${800 + k}` : null,
    // `reason` is vestigial in the real schema — process_transaction writes its
    // reason into `note`. Adjustment rows carry "Reconciliation <date>" notes so
    // the reconciliation page's "Last reconciled" line (note LIKE
    // 'Reconciliation%') demos correctly.
    reason: null as string | null,
    note: action === "Adjustment" ? `Reconciliation ${isoDate(daysAgo(day))}` : null,
    rate: null as number | null,
    created_by: "demo-user",
    created_at: tsAgo(day, 9 + (k % 9)),
  };
});

// ── Users (for the Users admin page) ─────────────────────────────────────────
export const USER_PROFILES = [
  { id: "demo-user", email: "demo@nexvia.example", name: "Demo Admin", role: "admin", active: true, is_super_admin: false, approved_at: tsAgo(200), approved_by: null, pin_set_at: tsAgo(200), pin_attempts: 0, pin_locked_until: null, created_at: tsAgo(200), rejected_at: null, rejected_by: null },
  { id: "demo-staff", email: "counter@nexvia.example", name: "Counter Staff", role: "staff", active: true, is_super_admin: false, approved_at: tsAgo(120), approved_by: "demo-user", pin_set_at: tsAgo(120), pin_attempts: 0, pin_locked_until: null, created_at: tsAgo(120), rejected_at: null, rejected_by: null },
  { id: "demo-view", email: "owner@nexvia.example", name: "Owner (view)", role: "viewer", active: true, is_super_admin: false, approved_at: tsAgo(90), approved_by: "demo-user", pin_set_at: tsAgo(90), pin_attempts: 0, pin_locked_until: null, created_at: tsAgo(90), rejected_at: null, rejected_by: null },
];

// ── Audit log (a few representative entries) ─────────────────────────────────
// Shape mirrors public.audit_log exactly as app/audit/page.tsx reads it:
// { id, user_id, occurred_at, table_name, row_id, operation }. user_id values
// match USER_PROFILES ids so the page resolves display names.
export const AUDIT_LOG = TRANSACTIONS.slice(0, 12).map((t, i) => ({
  id: i + 1,
  user_id: i % 2 ? "demo-staff" : "demo-user",
  occurred_at: t.created_at,
  table_name: t.action === "Adjustment" ? "godown_stock" : "transactions",
  row_id: t.id,
  operation: (i === 11 ? "DELETE" : t.action === "Adjustment" ? "UPDATE" : "INSERT") as "INSERT" | "UPDATE" | "DELETE",
}));

// Map a table name → its mock rows. Reconciliation drafts/done/count-log and
// the transaction queue are NOT seeded here — lib/demo.ts answers those from
// per-tab in-memory stores so demo writes round-trip.
export const DEMO_TABLES: Record<string, any[]> = {
  items: ITEMS,
  godown_stock: STOCK,
  pricing: PRICING,
  transactions: TRANSACTIONS,
  categories: CATEGORIES,
  user_profiles: USER_PROFILES,
  audit_log: AUDIT_LOG,
};
