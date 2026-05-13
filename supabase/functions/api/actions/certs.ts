// Certificate handlers.
//
// Port of the CERTIFICATES section from netlify/functions/api.js (lines 843–919).
// `certs.verify` is public (the verification URL on each certificate hits this
// without auth); the other three require a logged-in user.

import { sql } from '../_sql.ts';
import {
  httpErr, shortId,
  type Handler,
} from '../_helpers.ts';

// ─── CERTIFICATES ────────────────────────────────────────────────────
const certsIssue: Handler = async (body, user) => {
  const data = (body.data ?? body) as Record<string, unknown>;
  const code = shortId('CRT', 8);
  const [r] = await sql`
    INSERT INTO certificates (cert_code, member_id, project_id, recipient_name, recipient_email,
                              role, hours, issued_by)
    VALUES (${code}, ${data.member_id || null}, ${data.project_id},
            ${data.recipient_name || null}, ${data.recipient_email || null},
            ${data.role || null}, ${data.hours || null}, ${user!.id})
    RETURNING id
  ` as Array<{ id: number }>;
  return { id: r.id, cert_code: code };
};

const certsBulkIssue: Handler = async (body, user) => {
  const project_id = body.project_id as string | undefined;
  const role = body.role as string | undefined;
  const participants = await sql`
    SELECT pa.member_id, pa.volunteer_name, pa.volunteer_email,
           m.full_name, m.preferred_name, m.email AS member_email,
           COALESCE(SUM(h.total_hours), 0) AS hours
    FROM participants pa
    LEFT JOIN members m ON m.member_id = pa.member_id
    LEFT JOIN hours   h ON h.project_id = pa.project_id AND h.member_id = pa.member_id
                        AND h.notes IS DISTINCT FROM 'Deleted'
    WHERE pa.project_id = ${project_id}
      AND NOT EXISTS (
        SELECT 1 FROM certificates c
        WHERE c.project_id = ${project_id}
          AND ((c.member_id IS NOT NULL AND c.member_id = pa.member_id)
            OR (c.recipient_email IS NOT NULL AND c.recipient_email = pa.volunteer_email))
      )
    GROUP BY pa.id, pa.member_id, pa.volunteer_name, pa.volunteer_email,
             m.full_name, m.preferred_name, m.email
  ` as Array<{
    member_id: string | null; volunteer_name: string | null; volunteer_email: string | null;
    full_name: string | null; preferred_name: string | null; member_email: string | null;
    hours: number;
  }>;
  let count = 0;
  for (const p of participants) {
    const code = shortId('CRT', 8);
    await sql`
      INSERT INTO certificates (cert_code, member_id, project_id, recipient_name, recipient_email,
                                role, hours, issued_by)
      VALUES (${code}, ${p.member_id || null}, ${project_id},
              ${p.preferred_name || p.full_name || p.volunteer_name || null},
              ${p.member_email || p.volunteer_email || null},
              ${role || null}, ${p.hours || 0}, ${user!.id})
    `;
    count++;
  }
  return { count };
};

const certsList: Handler = async (body) => {
  const project_id = body.project_id as string | undefined;
  const member_id = body.member_id as string | undefined;
  return sql`
    SELECT c.*, m.full_name AS member_full_name, m.preferred_name AS member_preferred_name,
           p.project_name
    FROM certificates c
    LEFT JOIN members  m ON m.member_id  = c.member_id
    LEFT JOIN projects p ON p.project_id = c.project_id
    WHERE 1=1
      ${project_id ? sql`AND c.project_id = ${project_id}` : sql``}
      ${member_id  ? sql`AND c.member_id  = ${member_id}`  : sql``}
    ORDER BY c.issued_at DESC
  `;
};

const certsVerify: Handler = async (body) => {
  const cert_code = body.cert_code as string | undefined;
  if (!cert_code) throw httpErr('Missing cert_code', 400);
  const [c] = await sql`
    SELECT c.cert_code, c.recipient_name, c.role, c.hours, c.issued_at,
           m.full_name AS member_full_name, m.preferred_name,
           p.project_name, p.event_date
    FROM certificates c
    LEFT JOIN members  m ON m.member_id  = c.member_id
    LEFT JOIN projects p ON p.project_id = c.project_id
    WHERE c.cert_code = ${cert_code}
    LIMIT 1
  ` as Array<Record<string, unknown>>;
  if (!c) return { valid: false };
  return { valid: true, certificate: c };
};

export const certsActions: Record<string, Handler> = {
  'certs.issue':     certsIssue,
  'certs.bulkIssue': certsBulkIssue,
  'certs.list':      certsList,
  'certs.verify':    certsVerify,
};
