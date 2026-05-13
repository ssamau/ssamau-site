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
const getMembers: Handler = async () => sql`
  SELECT * FROM members
  ORDER BY
    CASE club_role
      WHEN 'President' THEN 1
      WHEN 'Vice President' THEN 2
      WHEN 'Deputy Vice President' THEN 3
      WHEN 'Committee Head' THEN 4
      WHEN 'Committee Vice Head' THEN 5
      ELSE 9
    END,
    full_name
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
