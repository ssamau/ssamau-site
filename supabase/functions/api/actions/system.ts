// System / handover actions (2026-07-27).
//
// The handover lock freezes every write across the whole API so club
// data can't change during a committee handover. Enforcement lives in
// the dispatcher (index.ts): when locked, any action not on the
// read/session/management allowlist returns err.locked.handover (423) —
// for ALL clients, web and iOS.
//
// Lock + unlock are admin/superadmin only and require a GitHub-style
// typed confirmation phrase (same phrase for both, per the handover
// spec). The phrase includes the current year so it's obviously tied to
// this handover.

import { sql } from '../_sql.ts';
import { httpErr, requireAdmin, type Handler } from '../_helpers.ts';

const HANDOVER_KEY = 'handover_lock';

// Same phrase gates lock AND unlock. Computed from the current year so
// the client can show it and the server can verify it without storing it.
export function handoverConfirmPhrase(): string {
  return `SSAM-HANDOVER${new Date().getFullYear()}`;
}

// Read the lock flag. FAIL-OPEN on any error: a transient DB hiccup must
// never freeze production — a deliberate lock persists in the row, a read
// failure just means "treat as unlocked for this request".
export async function isHandoverLocked(): Promise<boolean> {
  try {
    const rows = await sql`
      SELECT value FROM public.app_settings WHERE key = ${HANDOVER_KEY}
    ` as Array<{ value: { locked?: boolean } }>;
    return rows[0]?.value?.locked === true;
  } catch (_e) {
    return false;
  }
}

const systemGetLockState: Handler = async () => {
  const rows = await sql`
    SELECT value, updated_at FROM public.app_settings WHERE key = ${HANDOVER_KEY}
  ` as Array<{ value: Record<string, unknown>; updated_at: string }>;
  const v = (rows[0]?.value ?? {}) as Record<string, unknown>;
  const locked = v.locked === true;
  return {
    locked,
    locked_at:      locked ? (v.locked_at ?? rows[0]?.updated_at ?? null) : null,
    locked_by_name: locked ? (v.locked_by_name ?? null) : null,
    reason:         locked ? (v.reason ?? null) : null,
    confirm_phrase: handoverConfirmPhrase(),
  };
};

const systemLock: Handler = async (body, user) => {
  requireAdmin(user);
  const confirm = typeof body.confirm === 'string' ? body.confirm.trim() : '';
  if (confirm !== handoverConfirmPhrase()) throw httpErr('err.locked.bad_confirm', 400);
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : null;
  const value = {
    locked: true,
    locked_at: new Date().toISOString(),
    locked_by_name: user!.email || user!.username || String(user!.id),
    reason,
  };
  await sql`
    INSERT INTO public.app_settings (key, value, updated_by, updated_at)
    VALUES (${HANDOVER_KEY}, ${JSON.stringify(value)}::jsonb, ${user!.id}, now())
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `;
  return { locked: true };
};

const systemUnlock: Handler = async (body, user) => {
  requireAdmin(user);
  const confirm = typeof body.confirm === 'string' ? body.confirm.trim() : '';
  if (confirm !== handoverConfirmPhrase()) throw httpErr('err.locked.bad_confirm', 400);
  const value = {
    locked: false,
    unlocked_at: new Date().toISOString(),
    unlocked_by_name: user!.email || user!.username || String(user!.id),
  };
  await sql`
    INSERT INTO public.app_settings (key, value, updated_by, updated_at)
    VALUES (${HANDOVER_KEY}, ${JSON.stringify(value)}::jsonb, ${user!.id}, now())
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `;
  return { locked: false };
};

// Full read-only data dump for handover. Admin/superadmin only. Excludes
// secrets (users.password_hash + signup tokens) and the private schema.
// The client turns this into a multi-sheet .xlsx.
const systemExportAll: Handler = async (_body, user) => {
  requireAdmin(user);
  const [
    members, hours, attendance, certificates, projects, opportunities,
    opportunity_roles, assignments, participants, interest_requests,
    committees, advisors, membership_applications, thanks_emails, users,
  ] = await Promise.all([
    sql`SELECT * FROM public.members ORDER BY member_id`,
    sql`SELECT * FROM public.hours ORDER BY id`,
    sql`SELECT * FROM public.attendance ORDER BY id`,
    sql`SELECT * FROM public.certificates ORDER BY id`,
    sql`SELECT * FROM public.projects ORDER BY project_id`,
    sql`SELECT * FROM public.opportunities ORDER BY opportunity_id`,
    sql`SELECT * FROM public.opportunity_roles ORDER BY id`,
    sql`SELECT * FROM public.assignments ORDER BY assignment_id`,
    sql`SELECT * FROM public.participants ORDER BY id`,
    sql`SELECT * FROM public.interest_requests ORDER BY id`,
    sql`SELECT * FROM public.committees ORDER BY committee_id`,
    sql`SELECT * FROM public.advisors ORDER BY id`,
    sql`SELECT * FROM public.membership_applications ORDER BY application_id`,
    sql`SELECT * FROM public.thanks_emails ORDER BY id`,
    sql`SELECT id, username, member_id, access_level, created_at, last_login_at FROM public.users ORDER BY id`,
  ]);
  return {
    exported_at: new Date().toISOString(),
    tables: {
      members, hours, attendance, certificates, projects, opportunities,
      opportunity_roles, assignments, participants, interest_requests,
      committees, advisors, membership_applications, thanks_emails, users,
    },
  };
};

export const systemActions: Record<string, Handler> = {
  'system.getLockState': systemGetLockState,
  'system.lock':         systemLock,
  'system.unlock':       systemUnlock,
  'system.exportAll':    systemExportAll,
};
