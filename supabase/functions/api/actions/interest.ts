// Interest-request handlers.
//
// Port of the INTEREST section from netlify/functions/api.js (lines 761–797).
// All three actions require auth (none are in PUBLIC_ACTIONS) — submit is
// upserted by the (project_id, member_id) unique key so a member can change
// their mind without producing duplicate rows.

import { sql } from '../_sql.ts';
import {
  type Handler,
} from '../_helpers.ts';

// ─── INTEREST ────────────────────────────────────────────────────────
const interestSubmit: Handler = async (body) => {
  const data = (body.data ?? body) as Record<string, unknown>;
  await sql`
    INSERT INTO interest_requests (project_id, member_id, interested, availability_type, comment)
    VALUES (${data.project_id}, ${data.member_id}, ${data.interested},
            ${data.availability_type || null}, ${data.comment || null})
    ON CONFLICT (project_id, member_id) DO UPDATE SET
      interested        = EXCLUDED.interested,
      availability_type = EXCLUDED.availability_type,
      comment           = EXCLUDED.comment,
      submitted_at      = NOW()
  `;
  return { ok: true };
};

const interestList: Handler = async (body) => {
  const project_id = body.project_id as string | undefined;
  return sql`
    SELECT ir.*, m.full_name, m.preferred_name, m.email, p.project_name
    FROM interest_requests ir
    LEFT JOIN members  m ON m.member_id  = ir.member_id
    LEFT JOIN projects p ON p.project_id = ir.project_id
    WHERE ir.project_id = ${project_id}
    ORDER BY ir.submitted_at DESC
  `;
};

const interestListAll: Handler = async () => sql`
  SELECT ir.*, m.full_name, m.preferred_name, m.email, p.project_name
  FROM interest_requests ir
  LEFT JOIN members  m ON m.member_id  = ir.member_id
  LEFT JOIN projects p ON p.project_id = ir.project_id
  ORDER BY ir.submitted_at DESC
`;

export const interestActions: Record<string, Handler> = {
  'interest.submit':  interestSubmit,
  'interest.list':    interestList,
  'interest.listAll': interestListAll,
};
