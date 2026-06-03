"use client";
// Public "View demo" mode. When active, sb() returns this mock client which
// resolves every query from local demo data and makes ZERO network calls — the
// real Supabase database is never contacted. Writes are no-ops.
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEMO_TABLES } from "./demo-data";

export const DEMO_FLAG = "sa2_demo";
export const DEMO_USER_ID = "demo-user";

export function isDemo(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (new URLSearchParams(window.location.search).get("demo") === "1") {
      localStorage.setItem(DEMO_FLAG, "1");
    }
    return localStorage.getItem(DEMO_FLAG) === "1";
  } catch {
    return false;
  }
}
export function enterDemo() { try { localStorage.setItem(DEMO_FLAG, "1"); } catch {} }
export function exitDemo() { try { localStorage.removeItem(DEMO_FLAG); } catch {} }

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

function makeBuilder(table: string) {
  let rows: Row[] = (DEMO_TABLES[table] || []).slice();
  let single = false;
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
    range: (a: number, b: number) => { rows = rows.slice(a, b + 1); return proxy; },
    single: () => { single = true; return proxy; },
    maybeSingle: () => { single = true; return proxy; },
    // Writes are no-ops in demo — never reach a real DB.
    insert: () => proxy, update: () => proxy, delete: () => proxy, upsert: () => proxy,
    then: (res: any, rej?: any) => Promise.resolve(buildResult(rows, single)).then(res, rej),
    catch: (rej: any) => Promise.resolve(buildResult(rows, single)).catch(rej),
    finally: (f: any) => Promise.resolve(buildResult(rows, single)).finally(f),
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
    functions: { invoke: async () => ({ data: null, error: null }) },
    channel: () => { const ch: any = { on: () => ch, subscribe: () => ch, unsubscribe: () => {} }; return ch; },
    removeChannel: () => {},
    removeAllChannels: () => {},
  };
  return client as SupabaseClient;
}
