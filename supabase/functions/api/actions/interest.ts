// Interest-request handlers.
//
// Port of the INTEREST section from netlify/functions/api.js (lines 761–797).
// All three actions require auth (none are in PUBLIC_ACTIONS) — submit is
// upserted by the (project_id, member_id) unique key so a member can change
// their mind without producing duplicate rows.

import { sql } from '../_sql.ts';
import {
  httpErr, requireAuth, requireAdmin,
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
  ORDER BY ir.reviewed_at NULLS FIRST, ir.submitted_at DESC
`;

// Admin triage — flip the reviewed_at timestamp on an interest row so it
// fades to the bottom of the admin tab list. Body: { id, reviewed }.
// reviewed=true sets reviewed_at=NOW(); reviewed=false clears it (admin
// wants to reconsider). Admin-tier only — heads + members shouldn't be
// triaging requests they can't act on.
const interestMarkReviewed: Handler = async (body, user) => {
  requireAdmin(user);
  const id       = body.id as number | undefined;
  const reviewed = body.reviewed !== false;  // default true
  if (!id) throw httpErr('id is required', 400);
  await sql`
    UPDATE interest_requests
    SET    reviewed_at = ${reviewed ? sql`NOW()` : null}
    WHERE  id = ${id}
  `;
  return { id, reviewed };
};

// Member-portal self-scoped listing — returns only the caller's interest
// rows so the opportunities tab can pre-mark "✓ مُسجّل" on rows the
// member already expressed interest in. Without this, the button state
// is in-memory only and resets on every reload — members would re-click,
// see the same state-flip again, and assume the site is broken.
// Returns the minimal shape needed for the client-side set lookup.
const interestListOwn: Handler = async (_body, user) => {
  requireAuth(user);
  if (!user.member_id) return [];     // dev account: no member_id → no interests
  return sql`
    SELECT id, project_id, interested, comment, submitted_at, reviewed_at
    FROM interest_requests
    WHERE member_id = ${user.member_id}
  `;
};

export const interestActions: Record<string, Handler> = {
  'interest.submit':       interestSubmit,
  'interest.list':         interestList,
  'interest.listAll':      interestListAll,
  'interest.listOwn':      interestListOwn,
  'interest.markReviewed': interestMarkReviewed,
};
