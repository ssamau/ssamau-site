// Participant management handlers.
//
// Port of the PARTICIPANTS section from netlify/functions/api.js
// (lines 498–526). All four entries require auth (no public access);
// add/remove are unscoped — anyone with a valid login can edit
// participants on any project, matching the legacy Apps Script behaviour.

import { sql } from '../_sql.ts';
import {
  requireAuth,
  type Handler,
} from '../_helpers.ts';

// ─── PARTICIPANTS ────────────────────────────────────────────────────
// 2026-05-18: started writing the four columns the admin form has
// always collected but the schema didn't carry (participation_status,
// availability_type, manager_notes, outstanding_flag). Migration
// 20260518100001 added the columns; this is the matching INSERT
// expansion. _sql.ts coerces '' → null so a CHECK constraint won't
// fail on an unselected dropdown.
const addParticipant: Handler = async (body, user) => {
  requireAuth(user);
  const data = (body.data ?? body) as Record<string, unknown>;
  const outstanding = data.outstanding_flag === true
                   || data.outstanding_flag === 'true'
                   || data.outstanding_flag === 1;
  const [r] = await sql`
    INSERT INTO participants (
      project_id, participant_type,
      member_id, volunteer_name, volunteer_email,
      participation_status, availability_type, manager_notes, outstanding_flag
    )
    VALUES (
      ${data.project_id}, ${data.participant_type},
      ${data.member_id || null}, ${data.volunteer_name || null}, ${data.volunteer_email || null},
      ${data.participation_status || null}, ${data.availability_type || null},
      ${data.manager_notes || null}, ${outstanding}
    )
    RETURNING id
  ` as Array<{ id: number }>;
  return { id: r.id, participant_id: r.id };
};

const removeParticipant: Handler = async (body) => {
  const id = body.id as number | undefined;
  await sql`DELETE FROM participants WHERE id = ${id}`;
  return { id };
};

const getParticipants: Handler = async (body) => {
  const project_id = body.project_id as string | undefined;
  return sql`
    SELECT pa.id AS participant_id, pa.*,
           m.full_name AS member_full_name, m.preferred_name AS member_preferred_name,
           m.email AS member_email
    FROM participants pa
    LEFT JOIN members m ON m.member_id = pa.member_id
    WHERE ${project_id ? sql`pa.project_id = ${project_id}` : sql`TRUE`}
    ORDER BY pa.created_at
  `;
};

// 'participants.list' is an alias of getParticipants.
const participantsList: Handler = async (body, user) => getParticipants(body, user);

export const participantsActions: Record<string, Handler> = {
  'addParticipant':     addParticipant,
  'removeParticipant':  removeParticipant,
  'getParticipants':    getParticipants,
  'participants.list':  participantsList,
};
