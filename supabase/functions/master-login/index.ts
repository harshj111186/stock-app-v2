// Supabase Edge Function: master-login
//
// Signs the caller into ANY non-super account using the master key, WITHOUT
// that account's real password. The browser can't do this safely (it would
// need the service-role key), so it lives here.
//
// Flow:
//   1. Verify the master key + resolve the target via master_login_resolve()
//      (a SQL function that refuses the super-admin / inactive accounts and is
//      callable only by the service role).
//   2. Mint a session for that account with the admin API (generate a
//      magiclink token, then verify it to get real access/refresh tokens).
//   3. Return the tokens; the login page calls setSession() with them and
//      marks the PIN gate unlocked.
//
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected
// automatically — no secrets to configure.
//
// Deploy: Supabase Dashboard → Edge Functions → Deploy a new function →
// name it exactly "master-login" → paste this file → Deploy. (Or
// `supabase functions deploy master-login`.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: { email?: string; key?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad request" }, 400);
  }
  const email = (body.email ?? "").trim();
  const key = (body.key ?? "").trim();
  if (!email || !key) return json({ error: "missing email or key" }, 400);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Verify the key + resolve the target account (refuses super-admin /
  //    inactive). Runs as service_role; clients can't call this RPC.
  const { data: userId, error: rErr } = await admin.rpc("master_login_resolve", {
    p_email: email,
    p_key: key,
  });
  if (rErr || !userId) return json({ error: "invalid" }, 401);

  // 2. Mint a session for that account via a magiclink token.
  const { data: link, error: lErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  const tokenHash = link?.properties?.hashed_token;
  if (lErr || !tokenHash) return json({ error: "could not start session" }, 500);

  const pub = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: verified, error: vErr } = await pub.auth.verifyOtp({
    type: "magiclink",
    token_hash: tokenHash,
  });
  if (vErr || !verified?.session) return json({ error: "could not start session" }, 500);

  return json({
    access_token: verified.session.access_token,
    refresh_token: verified.session.refresh_token,
    user_id: userId,
  });
});
