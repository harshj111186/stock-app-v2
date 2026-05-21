"use client";
import { Shell } from "@/components/shell";
import { useCallback, useEffect, useMemo, useState } from "react";
import { sb, type Profile, PROFILE_COLUMNS } from "@/lib/supabase";
import { useAuth } from "@/app/providers";
import {
  Shield, CheckCircle2, KeyRound, UserMinus, UserCheck, Pencil,
  Loader2, AlertCircle, ShieldCheck, Clock, Users,
} from "lucide-react";

type Action = "approve" | "reset" | "deactivate" | "reactivate" | "role" | "name";
type Busy = { id: string; action: Action } | null;

export default function UsersPage() {
  const { profile: me } = useAuth();
  const [users, setUsers] = useState<Profile[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);

  const showToast = (kind: "ok" | "bad", text: string) => {
    setToast({ kind, text });
    setTimeout(() => setToast(null), 3500);
  };

  const load = useCallback(async () => {
    // Explicit column list (no "*") because pin_hash is column-revoked. See
    // PROFILE_COLUMNS in lib/supabase.ts. "SELECT *" would fail outright.
    const { data, error } = await sb()
      .from("user_profiles")
      .select(PROFILE_COLUMNS)
      .order("created_at", { ascending: false });
    if (error) {
      showToast("bad", error.message);
      setLoaded(true);
      return;
    }
    setUsers((data || []) as Profile[]);
    setLoaded(true);
  }, []);
  useEffect(() => { load(); }, [load]);

  // ─── Action handlers ────────────────────────────────────────────────────
  const runRpc = async (
    name: string,
    args: Record<string, unknown>,
    okMsg: string,
    rowId: string,
    action: Action,
  ) => {
    setBusy({ id: rowId, action });
    try {
      const { error } = await sb().rpc(name, args);
      if (error) throw error;
      showToast("ok", okMsg);
      await load();
    } catch (e: any) {
      showToast("bad", e?.message || "Action failed.");
    } finally {
      setBusy(null);
    }
  };

  const approve = (u: Profile) =>
    runRpc("admin_approve_user", { p_user_id: u.id }, `Approved ${u.email}`, u.id, "approve");

  const resetPin = (u: Profile) => {
    if (!confirm(`Reset PIN for ${u.email}? They'll set a new PIN on their next sign-in.`)) return;
    runRpc("admin_reset_pin", { p_user_id: u.id }, `PIN cleared for ${u.email}`, u.id, "reset");
  };

  const deactivate = (u: Profile) => {
    if (!confirm(`Deactivate ${u.email}? They won't be able to sign in until reactivated.`)) return;
    runRpc("admin_set_active", { p_user_id: u.id, p_active: false }, `Deactivated ${u.email}`, u.id, "deactivate");
  };

  const reactivate = (u: Profile) =>
    runRpc("admin_set_active", { p_user_id: u.id, p_active: true }, `Reactivated ${u.email}`, u.id, "reactivate");

  const setRole = (u: Profile, role: Profile["role"]) =>
    runRpc("admin_set_role", { p_user_id: u.id, p_new_role: role }, `Set ${u.email} to ${role}`, u.id, "role");

  const setName = async (u: Profile) => {
    const input = prompt(`Display name for ${u.email}:`, u.name || "");
    if (input === null) return;
    const next = input.trim();
    if (next === (u.name || "")) return;
    runRpc("admin_set_name", { p_user_id: u.id, p_name: next || null }, `Name updated`, u.id, "name");
  };

  // ─── Derived buckets ────────────────────────────────────────────────────
  const pending = useMemo(() => users.filter(u => !u.approved_at), [users]);
  const active = useMemo(() => users.filter(u => u.approved_at && u.active), [users]);
  const deactivated = useMemo(() => users.filter(u => u.approved_at && !u.active), [users]);

  // ─── Access check ───────────────────────────────────────────────────────
  if (me?.role !== "admin") {
    return (
      <Shell title="Users">
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-6">
          <div className="flex items-center gap-3">
            <Shield className="w-5 h-5 text-amber-500" />
            <div>
              <div className="font-medium">Admin-only page</div>
              <div className="text-sm text-zinc-500">Ask Harsh or Bhavik if you need user-admin access.</div>
            </div>
          </div>
        </div>
      </Shell>
    );
  }

  const meIsSuper = !!me?.is_super_admin;
  const rowProps = (u: Profile) => ({
    u,
    isMe: u.id === me.id,
    meIsSuper,
    busy,
    onSetRole: setRole,
    onResetPin: resetPin,
    onDeactivate: deactivate,
    onSetName: setName,
  });

  return (
    <Shell title="Users">
      <div className="mb-6">
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">Users</h1>
        <p className="text-sm text-zinc-500 mt-1 tabular-nums">
          {loaded
            ? <>{users.length} total · {pending.length} pending · {active.length} active · {deactivated.length} deactivated</>
            : "Loading…"}
        </p>
      </div>

      {/* ── Pending bucket ──────────────────────────────────────────────── */}
      {pending.length > 0 && (
        <section className="mb-6">
          <div className="flex items-center gap-2 mb-2">
            <Clock className="w-4 h-4 text-amber-500" />
            <h2 className="text-sm font-medium">Pending approval ({pending.length})</h2>
          </div>

          {/* Desktop */}
          <div className="hidden md:block bg-white dark:bg-zinc-900 border border-amber-500/30 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-amber-500/5 border-b border-amber-500/20">
                <tr className="text-zinc-500 text-[11px] uppercase tracking-wider">
                  <th className="text-left px-5 py-2.5 font-medium">Email</th>
                  <th className="text-left px-3 py-2.5 font-medium">Signed up</th>
                  <th className="text-right px-5 py-2.5 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {pending.map(u => (
                  <tr key={u.id} className="border-t border-zinc-200/50 dark:border-zinc-800/50">
                    <td className="px-5 py-2.5">{u.email}</td>
                    <td className="px-3 py-2.5 text-zinc-500 tnum text-xs">
                      {u.created_at ? new Date(u.created_at).toLocaleDateString("en-IN") : "—"}
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => approve(u)}
                        disabled={busy?.id === u.id}
                        className="bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-zinc-900 px-3 py-1.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5"
                      >
                        {busy?.id === u.id && busy.action === "approve"
                          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          : <CheckCircle2 className="w-3.5 h-3.5" />}
                        Approve
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile */}
          <ul className="md:hidden bg-white dark:bg-zinc-900 border border-amber-500/30 rounded-2xl overflow-hidden shadow-sm divide-y divide-zinc-200/60 dark:divide-zinc-800/60">
            {pending.map(u => (
              <li key={u.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <span className="text-sm font-medium truncate">{u.email}</span>
                </div>
                <button
                  type="button"
                  onClick={() => approve(u)}
                  disabled={busy?.id === u.id}
                  className="w-full bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-zinc-900 px-3 py-2 rounded-md text-xs font-medium inline-flex items-center justify-center gap-1.5"
                >
                  {busy?.id === u.id && busy.action === "approve"
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <CheckCircle2 className="w-3.5 h-3.5" />}
                  Approve {u.email}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── Active users ────────────────────────────────────────────────── */}
      <section className="mb-6">
        <div className="flex items-center gap-2 mb-2">
          <Users className="w-4 h-4 text-cyan-500" />
          <h2 className="text-sm font-medium">Active ({active.length})</h2>
        </div>

        {/* Desktop */}
        <div className="hidden md:block bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900/50 border-b border-zinc-200 dark:border-zinc-800">
              <tr className="text-zinc-500 text-[11px] uppercase tracking-wider">
                <th className="text-left px-5 py-2.5 font-medium">Email</th>
                <th className="text-left px-3 py-2.5 font-medium">Name</th>
                <th className="text-left px-3 py-2.5 font-medium">Role</th>
                <th className="text-left px-3 py-2.5 font-medium">PIN</th>
                <th className="text-right px-5 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {!loaded && (
                <tr><td colSpan={5} className="py-10 text-center text-sm text-zinc-500">Loading…</td></tr>
              )}
              {loaded && active.length === 0 && (
                <tr><td colSpan={5} className="py-10 text-center text-sm text-zinc-500">No active users.</td></tr>
              )}
              {loaded && active.map(u => <UserDesktopRow key={u.id} {...rowProps(u)} />)}
            </tbody>
          </table>
        </div>

        {/* Mobile */}
        <ul className="md:hidden bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden shadow-sm divide-y divide-zinc-200/60 dark:divide-zinc-800/60">
          {loaded && active.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-zinc-500">No active users.</li>
          )}
          {loaded && active.map(u => <UserMobileCard key={u.id} {...rowProps(u)} />)}
        </ul>
      </section>

      {/* ── Deactivated bucket ──────────────────────────────────────────── */}
      {deactivated.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-2">
            <UserMinus className="w-4 h-4 text-zinc-500" />
            <h2 className="text-sm font-medium text-zinc-500">Deactivated ({deactivated.length})</h2>
          </div>

          {/* Desktop */}
          <div className="hidden md:block bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 dark:bg-zinc-900/50 border-b border-zinc-200 dark:border-zinc-800">
                <tr className="text-zinc-500 text-[11px] uppercase tracking-wider">
                  <th className="text-left px-5 py-2.5 font-medium">Email</th>
                  <th className="text-left px-3 py-2.5 font-medium">Role</th>
                  <th className="text-right px-5 py-2.5 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {deactivated.map(u => {
                  const protectedRow = u.is_super_admin && !meIsSuper;
                  return (
                    <tr key={u.id} className="border-t border-zinc-200/50 dark:border-zinc-800/50">
                      <td className="px-5 py-2.5 text-zinc-500">{u.email}</td>
                      <td className="px-3 py-2.5"><RoleBadge role={u.role} super={u.is_super_admin} /></td>
                      <td className="px-5 py-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => reactivate(u)}
                          disabled={busy?.id === u.id || protectedRow}
                          className="bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed text-zinc-900 px-3 py-1.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5"
                        >
                          {busy?.id === u.id && busy.action === "reactivate"
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <UserCheck className="w-3.5 h-3.5" />}
                          Reactivate
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile */}
          <ul className="md:hidden bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl overflow-hidden shadow-sm divide-y divide-zinc-200/60 dark:divide-zinc-800/60">
            {deactivated.map(u => {
              const protectedRow = u.is_super_admin && !meIsSuper;
              return (
                <li key={u.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <span className="text-sm text-zinc-500 truncate">{u.email}</span>
                    <RoleBadge role={u.role} super={u.is_super_admin} />
                  </div>
                  <button
                    type="button"
                    onClick={() => reactivate(u)}
                    disabled={busy?.id === u.id || protectedRow}
                    className="w-full bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed text-zinc-900 px-3 py-2 rounded-md text-xs font-medium inline-flex items-center justify-center gap-1.5"
                  >
                    {busy?.id === u.id && busy.action === "reactivate"
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : <UserCheck className="w-3.5 h-3.5" />}
                    Reactivate
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* ── Toast ──────────────────────────────────────────────────────── */}
      {toast && (
        <div className={[
          "fixed bottom-4 right-4 z-30 px-4 py-2 rounded-md text-sm shadow-lg flex items-center gap-2 max-w-md",
          toast.kind === "ok" ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-300 border border-emerald-500/30"
                              : "bg-rose-500/20 text-rose-600 dark:text-rose-300 border border-rose-500/30",
        ].join(" ")}>
          {toast.kind === "ok" ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          {toast.text}
        </div>
      )}
    </Shell>
  );
}

// Permissions derived from the relationship between the current user (me) and
// a target row (u). Centralised so desktop + mobile renderers stay in lockstep.
function useRowPerms(u: Profile, isMe: boolean, meIsSuper: boolean) {
  const isSuperRow = u.is_super_admin;
  const isAdminRow = u.role === "admin";
  const lockedToMe = isSuperRow && !meIsSuper;            // can't touch super-admin
  const lockedAdmin = isAdminRow && !meIsSuper;           // regular admin can't modify another admin

  return {
    isSuperRow,
    canChangeRole:  !lockedToMe && !lockedAdmin && !isSuperRow,
    canResetPin:    !lockedToMe,
    canDeactivate:  !lockedToMe && !lockedAdmin && !isMe, // can't deactivate yourself
    canEditName:    !lockedToMe,
    roleOpts:       (meIsSuper ? ["admin", "staff", "viewer"] : ["staff", "viewer"]) as Profile["role"][],
  };
}

type RowProps = {
  u: Profile;
  isMe: boolean;
  meIsSuper: boolean;
  busy: Busy;
  onSetRole: (u: Profile, r: Profile["role"]) => void;
  onResetPin: (u: Profile) => void;
  onDeactivate: (u: Profile) => void;
  onSetName: (u: Profile) => void;
};

// ─── Desktop row ───────────────────────────────────────────────────────────
function UserDesktopRow({ u, isMe, meIsSuper, busy, onSetRole, onResetPin, onDeactivate, onSetName }: RowProps) {
  const perms = useRowPerms(u, isMe, meIsSuper);
  const rowBusy = busy?.id === u.id;
  const busyFor = (a: Action) => rowBusy && busy?.action === a;

  return (
    <tr className="border-t border-zinc-200/50 dark:border-zinc-800/50 hover:bg-zinc-50 dark:hover:bg-zinc-800/30">
      <td className="px-5 py-2.5">
        <div className="flex items-center gap-2">
          <span>{u.email}</span>
          {isMe && <span className="text-[10px] bg-zinc-200 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 px-1.5 py-0.5 rounded">you</span>}
          {perms.isSuperRow && <ShieldCheck className="w-3.5 h-3.5 text-cyan-500" aria-label="Super admin" />}
        </div>
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className={u.name ? "" : "text-zinc-400 italic text-xs"}>{u.name || "—"}</span>
          {perms.canEditName && (
            <button
              type="button"
              onClick={() => onSetName(u)}
              disabled={rowBusy}
              className="text-zinc-400 hover:text-cyan-500 disabled:opacity-40"
              title="Edit name"
              aria-label="Edit name"
            >
              <Pencil className="w-3 h-3" />
            </button>
          )}
        </div>
      </td>
      <td className="px-3 py-2.5">
        {perms.canChangeRole ? (
          <select
            value={u.role}
            onChange={(e) => onSetRole(u, e.target.value as Profile["role"])}
            disabled={rowBusy}
            className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1 text-xs disabled:opacity-50"
          >
            {!perms.roleOpts.includes(u.role) && <option value={u.role}>{u.role}</option>}
            {perms.roleOpts.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        ) : (
          <RoleBadge role={u.role} super={perms.isSuperRow} />
        )}
      </td>
      <td className="px-3 py-2.5 text-xs">
        <PinStatus u={u} />
      </td>
      <td className="px-5 py-2.5 text-right">
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => onResetPin(u)}
            disabled={!perms.canResetPin || rowBusy}
            className="text-xs text-zinc-500 hover:text-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
            title="Clear this user's PIN so they set a new one"
          >
            {busyFor("reset") ? <Loader2 className="w-3 h-3 animate-spin" /> : <KeyRound className="w-3 h-3" />}
            Reset PIN
          </button>
          <span className="text-zinc-300 dark:text-zinc-700">·</span>
          <button
            type="button"
            onClick={() => onDeactivate(u)}
            disabled={!perms.canDeactivate || rowBusy}
            className="text-xs text-zinc-500 hover:text-rose-500 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
            title={isMe ? "You can't deactivate your own account" : "Block this user from signing in"}
          >
            {busyFor("deactivate") ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserMinus className="w-3 h-3" />}
            Deactivate
          </button>
        </div>
      </td>
    </tr>
  );
}

// ─── Mobile card ───────────────────────────────────────────────────────────
function UserMobileCard({ u, isMe, meIsSuper, busy, onSetRole, onResetPin, onDeactivate, onSetName }: RowProps) {
  const perms = useRowPerms(u, isMe, meIsSuper);
  const rowBusy = busy?.id === u.id;
  const busyFor = (a: Action) => rowBusy && busy?.action === a;

  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium truncate">{u.email}</span>
            {isMe && <span className="text-[10px] bg-zinc-200 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 px-1.5 py-0.5 rounded shrink-0">you</span>}
            {perms.isSuperRow && <ShieldCheck className="w-3.5 h-3.5 text-cyan-500 shrink-0" aria-label="Super admin" />}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5 text-xs text-zinc-500">
            <span className={u.name ? "" : "italic"}>{u.name || "no name"}</span>
            {perms.canEditName && (
              <button
                type="button"
                onClick={() => onSetName(u)}
                disabled={rowBusy}
                className="text-zinc-400 hover:text-cyan-500 disabled:opacity-40"
                aria-label="Edit name"
              >
                <Pencil className="w-2.5 h-2.5" />
              </button>
            )}
          </div>
        </div>
        <RoleBadge role={u.role} super={perms.isSuperRow} />
      </div>

      <div className="flex items-center justify-between text-xs mt-2 pt-2 border-t border-zinc-100 dark:border-zinc-800/60">
        <PinStatus u={u} />
        <div className="flex items-center gap-2">
          {perms.canChangeRole && (
            <select
              value={u.role}
              onChange={(e) => onSetRole(u, e.target.value as Profile["role"])}
              disabled={rowBusy}
              className="bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-2 py-1 text-xs disabled:opacity-50"
            >
              {!perms.roleOpts.includes(u.role) && <option value={u.role}>{u.role}</option>}
              {perms.roleOpts.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 mt-2">
        <button
          type="button"
          onClick={() => onResetPin(u)}
          disabled={!perms.canResetPin || rowBusy}
          className="flex-1 text-xs text-zinc-700 dark:text-zinc-200 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed px-3 py-2 rounded-md inline-flex items-center justify-center gap-1.5"
        >
          {busyFor("reset") ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
          Reset PIN
        </button>
        <button
          type="button"
          onClick={() => onDeactivate(u)}
          disabled={!perms.canDeactivate || rowBusy}
          className="flex-1 text-xs text-rose-600 dark:text-rose-400 bg-rose-500/10 hover:bg-rose-500/20 disabled:opacity-40 disabled:cursor-not-allowed px-3 py-2 rounded-md inline-flex items-center justify-center gap-1.5"
        >
          {busyFor("deactivate") ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserMinus className="w-3.5 h-3.5" />}
          Deactivate
        </button>
      </div>
    </li>
  );
}

// ─── Shared bits ───────────────────────────────────────────────────────────
function PinStatus({ u }: { u: Profile }) {
  const locked = !!u.pin_locked_until && new Date(u.pin_locked_until) > new Date();
  if (!u.pin_set_at) return <span className="text-amber-500">● PIN not set</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-emerald-600 dark:text-emerald-400">● PIN set</span>
      {locked && <span className="text-rose-500">locked</span>}
    </span>
  );
}

function RoleBadge({ role, super: isSuper }: { role: Profile["role"]; super?: boolean }) {
  if (isSuper) {
    return (
      <span className="bg-cyan-500/15 text-cyan-600 dark:text-cyan-300 px-2 py-0.5 rounded text-[11px] inline-flex items-center gap-1">
        <ShieldCheck className="w-3 h-3" /> Super admin
      </span>
    );
  }
  const tone =
    role === "admin" ? "bg-cyan-500/15 text-cyan-600 dark:text-cyan-300" :
    role === "staff" ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300" :
    "bg-zinc-500/15 text-zinc-600 dark:text-zinc-300";
  return <span className={`${tone} px-2 py-0.5 rounded text-[11px]`}>{role}</span>;
}
