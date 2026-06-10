"use client";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isDemo, createDemoClient } from "./demo";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// supabase-js uses navigator.locks to serialize auth-token operations across
// tabs. The v1 app at /stock-app/ and v2 app at /stock-app-v2/ share the
// harshj111186.github.io origin and the same storageKey, so they fight for
// the same lock. When the lock gets wedged (verified live with
// navigator.locks.query() — "held" with no pending requesters), every auth
// call hangs: sign-in succeeds but fetchProfile in providers.tsx times out
// at 10s, profile stays null, redirect bounces to /login.
//
// Bypassing the lock makes auth calls fire immediately. The trade-off is
// that two open tabs might both refresh the token at the same time, which
// Supabase handles fine — duplicate refreshes resolve to the same token.
type LockFn = <R>(name: string, acquireTimeout: number, fn: () => Promise<R>) => Promise<R>;
const lockNoop: LockFn = async (_name, _acquireTimeout, fn) => fn();

let _client: SupabaseClient | null = null;
let _demoClient: SupabaseClient | null = null;
export function sb(): SupabaseClient {
  // Public demo mode: a fully mock client. Never contacts the real database.
  if (isDemo()) {
    if (!_demoClient) _demoClient = createDemoClient();
    return _demoClient;
  }
  if (!_client) {
    _client = createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        lock: lockNoop,
      },
    });
  }
  return _client;
}

// ---- Types matching our public.* tables ----
export type Item = {
  id: string;
  item_code: string;
  brand: string | null;
  category_id: string | null;
  category: string | null;
  subcategory: string | null;
  model: string;
  size: string;
  colour: string;
  case_size: number;
  hsn_code: string | null;
  gst_rate: number | null;
  reorder_point_a: number;
  reorder_point_b: number;
  image_url: string | null;
  archived: boolean;
  archived_at: string | null;
  created_at: string;
};
export type Stock = { item_id: string; godown: "A" | "B"; cases: number; loose: number };
export type Pricing = {
  item_id: string;
  lp: number;
  // Combined effective discount fraction (1 - product(1 - d_i)). Kept in
  // sync with `discounts` by the app on save so existing readers (e.g. the
  // dashboard's stock-value formula) keep working without joining the array.
  discount: number;
  // Breakdown of the discount stack. Each entry is a fraction applied to
  // the price AFTER the preceding entry. e.g. [0.40, 0.05] = 40% off, then
  // a further 5% off the discounted price. May be empty.
  discounts: number[];
  gst_rate: number;
  effective_from: string;
};
export type Txn = {
  id: string;
  item_id: string;
  txn_date: string;
  action: "Purchase" | "Sale" | "Transfer" | "Adjustment" | "Return";
  godown: "A" | "B";
  qty: number;
  // +1 = stock added at this godown, -1 = stock removed.
  // Added in phase2-adjustment-return.sql. Always populated by process_transaction.
  direction: 1 | -1;
  status: string;
  reverses_id: string | null;
  party_id: string | null;
  invoice_no: string | null;
  // Vestigial — never written. process_transaction stores its reason param in
  // `note`; read that instead.
  reason: string | null;
  note: string | null;
  rate: number | null;
  created_by: string | null;
  created_at: string;
};
// User profile.
//
// pin_hash is intentionally absent from this type — the column has had its
// SELECT grant revoked in db/2026-05-22-pin-auth-and-approval.sql, so it
// never reaches the client. PIN operations go through SECURITY DEFINER RPCs
// (set_pin / verify_pin / change_pin / admin_reset_pin).
//
// Gate states the app reads off this row:
//   - approved_at IS NULL                    → pending admin approval
//   - active = false (but approved_at set)   → deactivated by admin
//   - pin_set_at IS NULL                     → user must set a PIN first
//   - pin_locked_until > now()               → 15-min lockout after 5 misses
//   - is_super_admin = true                  → harsh; immune to other admins
export type Profile = {
  id: string;
  email: string;
  name: string | null;
  role: "admin" | "staff" | "viewer";
  active: boolean;
  is_super_admin: boolean;
  approved_at: string | null;
  approved_by: string | null;
  pin_set_at: string | null;
  pin_attempts: number;
  pin_locked_until: string | null;
  created_at: string;
  // A rejected pending signup: rejected_at set, approved_at still null →
  // hidden from Pending, blocked from signing in (reversible by an admin).
  rejected_at: string | null;
  rejected_by: string | null;
};

// Use this with .select(...) instead of .select("*") on user_profiles.
//
// Why not "*"? Because the 2026-05-22 migration revokes column-level SELECT
// on pin_hash for the `authenticated` role. PostgreSQL rejects `SELECT *`
// outright when the caller can't read every column ("permission denied for
// table user_profiles"), even if the missing column is one we never wanted
// the client to see. Explicit column list = pin_hash isn't requested =
// query succeeds with everything we actually need.
export const PROFILE_COLUMNS =
  "id, email, name, role, active, is_super_admin, approved_at, approved_by, pin_set_at, pin_attempts, pin_locked_until, created_at, rejected_at, rejected_by";
