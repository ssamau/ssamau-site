// Committee CRUD handlers.
//
// Port of the COMMITTEES section from netlify/functions/api.js (lines 399–437).
// `getCommittees` is public; create / update / delete are superadmin-only via
// the SUPERADMIN_ACTIONS allowlist in the dispatcher.

import { sql } from '../_sql.ts';
import {
  shortId,
  type Handler,
} from '../_helpers.ts';

// ─── COMMITTEES ──────────────────────────────────────────────────────
const getCommittees: Handler = async () => sql`
  SELECT c.*,
    (SELECT COUNT(*) FROM members m WHERE m.committee_id = c.committee_id AND m.status='Active') AS member_count
  FROM committees c
  ORDER BY c.committee_id
`;

const createCommittee: Handler = async (body) => {
  const data = (body.data ?? body) as Record<string, unknown>;
  const id = (data.committee_id as string | undefined) || shortId('COM', 4);
  await sql`
    INSERT INTO committees (committee_id, committee_name, committee_description,
                            committee_head_member_id, committee_vice_head_member_id, status)
    VALUES (${id}, ${data.committee_name}, ${data.committee_description || null},
            ${data.committee_head_member_id || null},
            ${data.committee_vice_head_member_id || null},
            ${data.status || 'Active'})
  `;
  return { committee_id: id };
};

const updateCommittee: Handler = async (body) => {
  const id = body.id as string | undefined;
  const data = (body.data ?? {}) as Record<string, unknown>;
  await sql`
    UPDATE committees SET
      committee_name                = COALESCE(${data.committee_name},                committee_name),
      committee_description         = COALESCE(${data.committee_description},         committee_description),
      committee_head_member_id      = COALESCE(${data.committee_head_member_id},      committee_head_member_id),
      committee_vice_head_member_id = COALESCE(${data.committee_vice_head_member_id}, committee_vice_head_member_id),
      status                        = COALESCE(${data.status},                        status)
    WHERE committee_id = ${id}
  `;
  return { committee_id: id };
};

const deleteCommittee: Handler = async (body) => {
  const id = body.id as string | undefined;
  await sql`DELETE FROM committees WHERE committee_id = ${id}`;
  return { committee_id: id };
};

export const committeesActions: Record<string, Handler> = {
  'getCommittees':   getCommittees,
  'createCommittee': createCommittee,
  'updateCommittee': updateCommittee,
  'deleteCommittee': deleteCommittee,
};
