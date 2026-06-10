"use client";
// Public "View demo" mode. When active, sb() returns this mock client which
// resolves every query from local demo data and makes ZERO network calls — the
// real Supabase database is never contacted. Reads come from the seed tables in
// lib/demo-data.ts; interactive writes (reconciliation drafts/done flags/count
// log, the transaction queue) land in per-tab in-memory stores so those flows
// demo end-to-end without ever touching a real DB.
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEMO_TABLES } from "./demo-data";

export const DEMO_FLAG = "sa2_demo";
export const DEMO_USER_ID = "demo-user";

// Per-tab flag (sessionStorage). The old localStorage flag was sticky — a real
// user who once opened ?demo=1 stayed trapped in mock mode on every later
// visit. Now the demo ends when the tab closes; exitDemo also clears the
// legacy localStorage key so previously-trapped users are freed.
export function isDemo(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (new URLSearchParams(window.location.search).get("demo") === "1") {
      sessionStorage.setItem(DEMO_FLAG, "1");
    }
    return sessionStorage.getItem(DEMO_FLAG) === "1";
  } catch {
    return false;
  }
}
export function enterDemo() { try { sessionStorage.setItem(DEMO_FLAG, "1"); } catch {} }
export function exitDemo() {
  try { sessionStorage.removeItem(DEMO_FLAG); } catch {}
  try { localStorage.removeItem(DEMO_FLAG); } catch {} // legacy flag cleanup
}

export function demoProfile() {
  return {
    id: DEMO_USER_ID, email: "demo@nexvia.example", name: "Demo Admin",
    role: "admin", active: true, is_super_admin: false,
    approved_at: "2026-01-01T00:00:00Z", approved_by: null,
    pin_set_at: "2026-01-01T00:00:00Z", pin_attempts: 0, pin_locked_until: null,
    created_at: "2026-01-01T00:00:00Z", rejected_at: null, rejected_by: null,
  };
}
function demoSession() {
  return {
    access_token: "demo", refresh_token: "demo", token_type: "bearer",
    expires_in: 3600, expires_at: 9999999999,
    user: {
      id: DEMO_USER_ID, email: "demo@nexvia.example", aud: "authenticated",
      app_metadata: {}, user_metadata: { name: "Demo Admin" },
      created_at: "2026-01-01T00:00:00Z",
    },
  };
}

type Row = Record<string, any>;
function buildResult(rows: Row[], single: boolean) {
  const data = single ? (rows.length ? rows[0] : null) : rows;
  return { data, error: null, count: rows.length, status: 200, statusText: "OK" };
}

const genId = () => "demo-" + Math.random().toString(36).slice(2);

// ── In-memory writable stores ────────────────────────────────────────────────
// Live for the tab only — still zero real-DB calls. Without these, a saved
// reconciliation draft vanished on the next poll (upsert used to ack with an
// unrelated seed row) and the demo transaction queue never round-tripped.
const draftStore = new Map<string, Row>();   // reconciliation_drafts · key user_id::item_id
const doneStore = new Map<string, Row>();    // reconciliation_done · key user_id
const countLogStore: Row[] = [];             // reconciliation_count_log
const queueStore: Row[] = [];                // transaction_queue

const draftKey = (r: Row) => `${r.user_id}::${r.item_id}`;

function demoUserBits(userId: string) {
  const p = (DEMO_TABLES["user_profiles"] || []).find((u: Row) => u.id === userId);
  return { user_email: p?.email ?? null, user_name: p?.name ?? null, user_role: p?.role ?? null };
}

// Tables answered from the in-memory stores (or derived views) instead of the
// static seeds in DEMO_TABLES.
function sourceRows(table: string): Row[] {
  switch (table) {
    case "reconciliation_drafts": return [...draftStore.values()];
    case "reconciliation_drafts_with_user":
      // Mirrors the DB view: draft columns + the counter's profile fields.
      return [...draftStore.values()].map(d => ({ ...d, ...demoUserBits(d.user_id) }));
    case "reconciliation_done": return [...doneStore.values()];
    case "reconciliation_count_log": return countLogStore.slice();
    case "transaction_queue": return queueStore.slice();
    case "user_names":
      return (DEMO_TABLES["user_profiles"] || []).map((p: Row) => ({ id: p.id, name: p.name, email: p.email }));
    default: return (DEMO_TABLES[table] || []).slice();
  }
}

// Remove matched rows from whichever in-memory store backs the table.
// Static seed tables ignore deletes (read-only demo data).
function applyDelete(table: string, matched: Row[]) {
  if (table === "reconciliation_drafts") {
    for (const r of matched) draftStore.delete(draftKey(r));
  } else if (table === "reconciliation_done") {
    for (const r of matched) doneStore.delete(String(r.user_id));
  } else if (table === "transaction_queue" || table === "reconciliation_count_log") {
    const store = table === "transaction_queue" ? queueStore : countLogStore;
    const ids = new Set(matched.map(r => r.id));
    for (let i = store.length - 1; i >= 0; i--) if (ids.has(store[i].id)) store.splice(i, 1);
  }
}

// SQL LIKE pattern → predicate ("Reconciliation%" → startsWith, "%x" →
// endsWith, "%x%" → includes). % and _ are the only wildcards.
function likeToRegExp(pattern: string): RegExp {
  const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${esc.replace(/%/g, ".*").replace(/_/g, ".")}$`);
}

function makeBuilder(table: string) {
  let rows: Row[] = sourceRows(table);
  let single = false;
  // insert/upsert write to the stores immediately and echo the written rows;
  // update/delete settle lazily (like the real builder, which only fires when
  // awaited) so chained .eq()/.in() filters scope them first.
  let mode: "select" | "write" | "update" | "delete" = "select";
  let written: Row[] = [];
  let patch: Row | null = null;
  let settled: ReturnType<typeof buildResult> | null = null;

  const settle = () => {
    if (settled) return settled;
    if (mode === "update" && patch) { for (const r of rows) Object.assign(r, patch); written = rows; }
    if (mode === "delete") { applyDelete(table, rows); written = rows; }
    settled = buildResult(mode === "select" ? rows : written, single);
    return settled;
  };

  const api: any = {
    select: () => proxy,
    eq: (c: string, v: any) => { rows = rows.filter(r => r[c] === v); return proxy; },
    neq: (c: string, v: any) => { rows = rows.filter(r => r[c] !== v); return proxy; },
    in: (c: string, vs: any[]) => { const s = new Set(vs); rows = rows.filter(r => s.has(r[c])); return proxy; },
    is: (c: string, v: any) => { rows = rows.filter(r => (v === null ? r[c] == null : r[c] === v)); return proxy; },
    gte: (c: string, v: any) => { rows = rows.filter(r => r[c] >= v); return proxy; },
    lte: (c: string, v: any) => { rows = rows.filter(r => r[c] <= v); return proxy; },
    gt: (c: string, v: any) => { rows = rows.filter(r => r[c] > v); return proxy; },
    lt: (c: string, v: any) => { rows = rows.filter(r => r[c] < v); return proxy; },
    like: (c: string, pattern: string) => {
      const re = likeToRegExp(String(pattern));
      rows = rows.filter(r => typeof r[c] === "string" && re.test(r[c]));
      return proxy;
    },
    order: (c: string, opts?: { ascending?: boolean }) => {
      const asc = !opts || opts.ascending !== false;
      rows = rows.slice().sort((a, b) => {
        const x = a[c], y = b[c];
        if (x === y) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        return (x < y ? -1 : 1) * (asc ? 1 : -1);
      });
      return proxy;
    },
    limit: (n: number) => { rows = rows.slice(0, n); return proxy; },
    // Return ONLY the slice — fetchAllRows' pagination loop relies on a short
    // page (length < pageSize) to terminate.
    range: (a: number, b: number) => { rows = rows.slice(a, b + 1); return proxy; },
    single: () => { single = true; return proxy; },
    maybeSingle: () => { single = true; return proxy; },
    // ── Writes: kept entirely in this mock — never reach a real DB. ──
    insert: (payload: Row | Row[]) => {
      mode = "write";
      const list = Array.isArray(payload) ? payload : [payload];
      written = list.map(p => ({ id: genId(), created_at: new Date().toISOString(), ...p }));
      if (table === "reconciliation_count_log") countLogStore.push(...written);
      else if (table === "transaction_queue") queueStore.push(...written);
      return proxy;
    },
    update: (p: Row) => { mode = "update"; patch = p; return proxy; },
    upsert: (payload: Row | Row[]) => {
      mode = "write";
      const list = Array.isArray(payload) ? payload : [payload];
      const now = new Date().toISOString();
      written = list.map(p => {
        if (table === "reconciliation_drafts") {
          const key = `${p.user_id}::${p.item_id}`;
          const prev = draftStore.get(key);
          const row = { id: genId(), created_at: now, ...prev, ...p, updated_at: now };
          draftStore.set(key, row);
          return row;
        }
        if (table === "reconciliation_done") {
          const key = String(p.user_id);
          const prev = doneStore.get(key);
          const row = { id: genId(), ...prev, ...p, updated_at: now };
          doneStore.set(key, row);
          return row;
        }
        // Echo the payload back with a generated id — acking with an
        // unrelated seed row made saved data "vanish" on the next read.
        return { id: genId(), updated_at: now, ...p };
      });
      return proxy;
    },
    delete: () => { mode = "delete"; return proxy; },
    then: (res: any, rej?: any) => Promise.resolve(settle()).then(res, rej),
    catch: (rej: any) => Promise.resolve(settle()).catch(rej),
    finally: (f: any) => Promise.resolve(settle()).finally(f),
  };
  // Any unrecognised chained method returns the builder — airtight, no crash, no network.
  const proxy: any = new Proxy(api, {
    get(t, p) {
      if (p in t) return t[p as any];
      return () => proxy;
    },
  });
  return proxy;
}

export function createDemoClient(): SupabaseClient {
  const client: any = {
    from: (table: string) => makeBuilder(table),
    rpc: async () => ({ data: null, error: null }),
    auth: {
      getSession: async () => ({ data: { session: demoSession() }, error: null }),
      getUser: async () => ({ data: { user: demoSession().user }, error: null }),
      onAuthStateChange: (cb: any) => {
        try { setTimeout(() => cb("SIGNED_IN", demoSession()), 0); } catch {}
        return { data: { subscription: { unsubscribe() {} } } };
      },
      signInWithPassword: async () => ({ data: { session: demoSession(), user: demoSession().user }, error: null }),
      signUp: async () => ({ data: { session: null, user: null }, error: { message: "Demo mode — sign-up disabled." } }),
      setSession: async () => ({ data: { session: demoSession() }, error: null }),
      signOut: async () => { exitDemo(); return { error: null }; },
    },
    // Edge actions "succeed" in demo — pages check data.ok before celebrating.
    functions: { invoke: async () => ({ data: { ok: true }, error: null }) },
    channel: () => { const ch: any = { on: () => ch, subscribe: () => ch, unsubscribe: () => {} }; return ch; },
    removeChannel: () => {},
    removeAllChannels: () => {},
  };
  return client as SupabaseClient;
}
