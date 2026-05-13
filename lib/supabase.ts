"use client";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

let _client: SupabaseClient | null = null;
export function sb(): SupabaseClient {
  if (!_client) _client = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } });
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
export type Pricing = { item_id: string; lp: number; discount: number; gst_rate: number; effective_from: string };
export type Txn = {
  id: string;
  item_id: string;
  txn_date: string;
  action: "Purchase" | "Sale" | "Transfer" | "Adjustment" | "Return";
  godown: "A" | "B";
  qty: number;
  status: string;
  reverses_id: string | null;
  party_id: string | null;
  invoice_no: string | null;
  reason: string | null;
  rate: number | null;
  created_by: string | null;
  created_at: string;
};
export type Profile = { id: string; email: string; name: string | null; role: "admin" | "staff" | "viewer"; active: boolean };
