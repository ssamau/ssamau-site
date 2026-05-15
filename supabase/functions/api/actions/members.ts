// Member CRUD handlers.
//
// Port of the MEMBERS section from netlify/functions/api.js (lines 294–358).
// Behaviour is identical — same SQL, same role-gating, same response shapes.
// The `getMembers` action is public (PUBLIC_ACTIONS allowlist); the others
// require auth + admin-scope checks.

import { sql } from '../_sql.ts';
import {
  httpErr, shortId,
  requireAuth, requireAdminScope,
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
      WHEN 'Deputy Vice Head' THEN 3
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
  if (!existing) throw httpErr('err.notfound.member', 404);
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

// ─── SELF-SERVICE (member portal — Phase 5 of Branch 4) ──────────────
// These two actions are authenticated (any tier) but scoped to the
// caller's OWN member row via user.member_id. They are intentionally
// NOT in ADMIN_ACTIONS — a regular member must be able to call them
// for their own portal. A head or admin calling them gets their own
// row too (which is correct; they're members too and should be able
// to keep their profile up to date without going through the admin UI).
//
// Dev account (no member_id) → 404 from getOwn / updateOwn. The dev
// shouldn't be using the member portal; this is the right failure mode.

const membersGetOwn: Handler = async (_body, user) => {
  requireAuth(user);
  if (!user.member_id) throw httpErr('err.auth.no_member_link', 404);
  const rows = await sql`
    SELECT m.*, c.committee_name
    FROM members m
    LEFT JOIN committees c ON c.committee_id = m.committee_id
    WHERE m.member_id = ${user.member_id}
    LIMIT 1
  ` as Array<Record<string, unknown>>;
  if (!rows[0]) throw httpErr('err.notfound.member', 404);
  return rows[0];
};

// Self-update whitelist. Fields NOT in this list are admin-managed:
//   member_id, full_name, name_en, national_id (immutable identity)
//   committee_id, club_role, status, join_date, total_hours (admin domain)
//   created_at, updated_at (timestamps)
const membersUpdateOwn: Handler = async (body, user) => {
  requireAuth(user);
  if (!user.member_id) throw httpErr('err.auth.no_member_link', 404);
  const data = (body.data ?? body) as Record<string, unknown>;
  await sql`
    UPDATE members SET
      preferred_name             = COALESCE(${data.preferred_name             ?? null}, preferred_name),
      email                      = COALESCE(${data.email                      ?? null}, email),
      phone                      = COALESCE(${data.phone                      ?? null}, phone),
      whatsapp                   = COALESCE(${data.whatsapp                   ?? null}, whatsapp),
      gender                     = COALESCE(${data.gender                     ?? null}, gender),
      date_of_birth              = COALESCE(${data.date_of_birth              ?? null}, date_of_birth),
      profile_photo_url          = COALESCE(${data.profile_photo_url          ?? null}, profile_photo_url),
      address_melbourne          = COALESCE(${data.address_melbourne          ?? null}, address_melbourne),
      linkedin_url               = COALESCE(${data.linkedin_url               ?? null}, linkedin_url),
      cv_url                     = COALESCE(${data.cv_url                     ?? null}, cv_url),
      skills_hobbies             = COALESCE(${data.skills_hobbies             ?? null}, skills_hobbies),
      about_self                 = COALESCE(${data.about_self                 ?? null}, about_self),
      scholarship_entity         = COALESCE(${data.scholarship_entity         ?? null}, scholarship_entity),
      scholarship_entity_other   = COALESCE(${data.scholarship_entity_other   ?? null}, scholarship_entity_other),
      study_level                = COALESCE(${data.study_level                ?? null}, study_level),
      degree_field               = COALESCE(${data.degree_field               ?? null}, degree_field),
      university                 = COALESCE(${data.university                 ?? null}, university),
      university_other           = COALESCE(${data.university_other           ?? null}, university_other),
      study_started_window       = COALESCE(${data.study_started_window       ?? null}, study_started_window),
      expected_graduation_window = COALESCE(${data.expected_graduation_window ?? null}, expected_graduation_window),
      updated_at                 = NOW()
    WHERE member_id = ${user.member_id}
  `;
  return { member_id: user.member_id };
};

export const membersActions: Record<string, Handler> = {
  'getMembers':       getMembers,
  'createMember':     createMember,
  'updateMember':     updateMember,
  'deleteMember':     deleteMember,
  'members.getOwn':   membersGetOwn,
  'members.updateOwn': membersUpdateOwn,
};
