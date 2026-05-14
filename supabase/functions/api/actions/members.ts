// Member CRUD handlers.
//
// Port of the MEMBERS section from netlify/functions/api.js (lines 294–358).
// Behaviour is identical — same SQL, same role-gating, same response shapes.
// The `getMembers` action is public (PUBLIC_ACTIONS allowlist); the others
// require auth + admin-scope checks.

import { sql } from '../_sql.ts';
import {
  httpErr, shortId,
  requireAdminScope,
  type Handler,
} from '../_helpers.ts';

// ─── MEMBERS ─────────────────────────────────────────────────────────
// LEFT JOIN public.users so the Members tab can render per-row portal-
// account status (no account, pending invite, joined) without a second
// round-trip. The joined columns are namespaced `account_*` so they
// don't collide with members.* fields:
//   account_id              — public.users.id (NULL = no account row)
//   account_signup_token_set — TRUE if a pending email-link invite exists
//   account_signup_pin_set  — TRUE if a pending PIN invite exists
//   account_signup_completed_at — non-NULL = signup finished (joined)
//   account_auth_user_id    — non-NULL = linked to a Supabase Auth row
//
// We deliberately do NOT expose signup_token / signup_pin_hash plaintext
// to the client — those are server-only secrets. The boolean flags are
// enough for the UI to pick the right action label ("Invite" / "Resend"
// / "Revoke" / "Joined").
const getMembers: Handler = async () => sql`
  SELECT
    m.*,
    u.id                              AS account_id,
    (u.signup_token IS NOT NULL)      AS account_signup_token_set,
    (u.signup_pin_hash IS NOT NULL)   AS account_signup_pin_set,
    u.signup_completed_at             AS account_signup_completed_at,
    u.auth_user_id                    AS account_auth_user_id
  FROM members m
  LEFT JOIN public.users u ON u.member_id = m.member_id
  ORDER BY
    CASE m.club_role
      WHEN 'President' THEN 1
      WHEN 'Vice President' THEN 2
      WHEN 'Deputy Vice President' THEN 3
      WHEN 'Committee Head' THEN 4
      WHEN 'Committee Vice Head' THEN 5
      ELSE 9
    END,
    m.full_name
`;

const createMember: Handler = async (body, user) => {
  const data = (body.data ?? body) as Record<string, unknown>;
  requireAdminScope(user, data.committee_id as string | null | undefined);
  const id = (data.member_id as string | undefined) || shortId('MBR');
  await sql`
    INSERT INTO members (member_id, full_name, preferred_name, national_id,
                         email, phone, whatsapp, gender, date_of_birth,
                         profile_photo_url, committee_id, club_role, status, join_date, total_hours)
    VALUES (${id}, ${data.full_name}, ${data.preferred_name || null}, ${data.national_id || null},
            ${data.email || null},
            ${data.phone || null}, ${data.whatsapp || null}, ${data.gender || null},
            ${data.date_of_birth || null},
            ${data.profile_photo_url || null},
            ${data.committee_id || null}, ${data.club_role || 'Member'},
            ${data.status || 'Active'}, ${data.join_date || null}, ${data.total_hours || 0})
  `;
  return { member_id: id };
};

const updateMember: Handler = async (body, user) => {
  const id = body.id as string | undefined;
  const data = (body.data ?? {}) as Record<string, unknown>;
  const [existing] = await sql`SELECT committee_id FROM members WHERE member_id = ${id}` as Array<{ committee_id: string | null }>;
  if (!existing) throw httpErr('Member not found', 404);
  requireAdminScope(user, existing.committee_id);
  if (data.committee_id && data.committee_id !== existing.committee_id) {
    requireAdminScope(user, data.committee_id as string | null | undefined);
  }
  await sql`
    UPDATE members SET
      full_name         = COALESCE(${data.full_name},         full_name),
      preferred_name    = COALESCE(${data.preferred_name},    preferred_name),
      national_id       = COALESCE(${data.national_id},       national_id),
      email             = COALESCE(${data.email},             email),
      phone             = COALESCE(${data.phone},             phone),
      whatsapp          = COALESCE(${data.whatsapp},          whatsapp),
      gender            = COALESCE(${data.gender},            gender),
      date_of_birth     = COALESCE(${data.date_of_birth},     date_of_birth),
      profile_photo_url = COALESCE(${data.profile_photo_url}, profile_photo_url),
      committee_id      = COALESCE(${data.committee_id},      committee_id),
      club_role         = COALESCE(${data.club_role},         club_role),
      status            = COALESCE(${data.status},            status),
      join_date         = COALESCE(${data.join_date},         join_date)
    WHERE member_id = ${id}
  `;
  return { member_id: id };
};

const deleteMember: Handler = async (body) => {
  const id = body.id as string | undefined;
  await sql`DELETE FROM members WHERE member_id = ${id}`;
  return { member_id: id };
};

export const membersActions: Record<string, Handler> = {
  'getMembers':   getMembers,
  'createMember': createMember,
  'updateMember': updateMember,
  'deleteMember': deleteMember,
};
