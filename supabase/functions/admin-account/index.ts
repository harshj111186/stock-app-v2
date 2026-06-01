// Supabase Edge Function: admin-account
//
// Privileged account actions that need the service-role key (so they can't
// live in the browser): an admin RESETS another user's password (sets a new
// one), or DELETES an account entirely (frees the email for a fresh signup).
//
// Security: the CALLER's JWT (sent automatically by functions.invoke when
// signed in) is verified, and the same rules as the in-app admin RPCs are
// enforced server-side — caller must be an active admin, the target can't be
// the super-admin, an admin target requires a super-admin caller, and you
// can't delete yourself.
//
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected
// automatically — nothing to configure.
//
// Deploy: Supabase Dashboard → Edge Functions → Deploy a new function →
// name it exactly "admin-account" → paste this file → Deploy.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Always 200 with { ok, error? } so the client reads a clean message instead
// of having to dig through HTTP error bodies.
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ ok: false, error: "not signed in" });

  let body: { action?: string; target_user_id?: string; new_password?: string };
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad request" }); }
  const action = body.action;
  const targetId = body.target_user_id;
  if (!action || !targetId) return json({ ok: false, error: "missing action or target" });

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  // Who is calling? Verify their JWT.
  const callerClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: callerData } = await callerClient.auth.getUser();
  const caller = callerData?.user;
  if (!caller) return json({ ok: false, error: "not signed in" });

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // Caller + target profiles (service role bypasses RLS).
  const { data: profs } = await admin
    .from("user_profiles")
    .select("id, role, active, is_super_admin")
    .in("id", [caller.id, targetId]);
  const me = profs?.find((p: any) => p.id === caller.id);
  const target = profs?.find((p: any) => p.id === targetId);

  if (!me || me.role !== "admin" || !me.active) return json({ ok: false, error: "admin only" });
  if (!target) return json({ ok: false, error: "user not found" });
  if (target.is_super_admin) return json({ ok: false, error: "can't modify the main master account" });
  if (target.role === "admin" && !me.is_super_admin) {
    return json({ ok: false, error: "only the super-admin can manage admin accounts" });
  }

  if (action === "reset_password") {
    const pw = String(body.new_password ?? "");
    if (pw.length < 6) return json({ ok: false, error: "password must be at least 6 characters" });
    const { error } = await admin.auth.admin.updateUserById(targetId, { password: pw });
    if (error) return json({ ok: false, error: error.message });
    return json({ ok: true });
  }

  if (action === "delete") {
    if (targetId === caller.id) return json({ ok: false, error: "you can't delete your own account" });
    const { error } = await admin.auth.admin.deleteUser(targetId);
    if (error) {
      return json({
        ok: false,
        error: error.message +
          " — an account with transaction history can't be fully deleted; deactivate it instead.",
      });
    }
    // Best-effort: drop the profile row too, in case it didn't cascade from
    // auth.users (avoids a ghost row in the Users list).
    await admin.from("user_profiles").delete().eq("id", targetId);
    return json({ ok: true });
  }

  return json({ ok: false, error: "unknown action" });
});
