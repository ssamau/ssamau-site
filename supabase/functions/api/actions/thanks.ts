// Thank-you-email handlers.
//
// Port of the THANKS section from netlify/functions/api.js (lines 799–842).
//
// Email sending is intentionally NOT wired up here — the Apps Script version uses
// GmailApp under the club's Google account. Sending real email from Netlify needs
// a separate provider (Resend / Postmark / SendGrid). For now we record the entry
// with status='Logged' so the UI keeps working; flip to status='Sent' once an
// email provider is wired in.

import { sql } from '../_sql.ts';
import {
  type Handler,
} from '../_helpers.ts';

// ─── THANKS ──────────────────────────────────────────────────────────
const thanksSend: Handler = async (body, user) => {
  const data = (body.data ?? body) as Record<string, unknown>;
  const [r] = await sql`
    INSERT INTO thanks_emails (member_id, project_id, recipient_email, subject, message, status, sent_by)
    VALUES (${data.member_id || null}, ${data.project_id || null},
            ${data.recipient_email || null}, ${data.subject}, ${data.message},
            'Logged', ${user!.id})
    RETURNING id
  ` as Array<{ id: number }>;
  return { id: r.id };
};

const thanksBulkSend: Handler = async (body, user) => {
  const project_id = body.project_id as string | undefined;
  const subject = body.subject as string | undefined;
  const message = body.message as string | undefined;
  const recipients = await sql`
    SELECT pa.member_id, pa.volunteer_email, m.email AS member_email
    FROM participants pa
    LEFT JOIN members m ON m.member_id = pa.member_id
    WHERE pa.project_id = ${project_id}
  ` as Array<{ member_id: string | null; volunteer_email: string | null; member_email: string | null }>;
  let count = 0;
  for (const rec of recipients) {
    await sql`
      INSERT INTO thanks_emails (member_id, project_id, recipient_email, subject, message, status, sent_by)
      VALUES (${rec.member_id || null}, ${project_id},
              ${rec.member_email || rec.volunteer_email || null},
              ${subject}, ${message}, 'Logged', ${user!.id})
    `;
    count++;
  }
  return { count };
};

const thanksList: Handler = async (body) => {
  const project_id = body.project_id as string | undefined;
  const member_id = body.member_id as string | undefined;
  return sql`
    SELECT t.*, m.full_name, m.preferred_name, p.project_name
    FROM thanks_emails t
    LEFT JOIN members  m ON m.member_id  = t.member_id
    LEFT JOIN projects p ON p.project_id = t.project_id
    WHERE 1=1
      ${project_id ? sql`AND t.project_id = ${project_id}` : sql``}
      ${member_id  ? sql`AND t.member_id  = ${member_id}`  : sql``}
    ORDER BY t.sent_at DESC
  `;
};

export const thanksActions: Record<string, Handler> = {
  'thanks.send':     thanksSend,
  'thanks.bulkSend': thanksBulkSend,
  'thanks.list':     thanksList,
};
