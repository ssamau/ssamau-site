// Certificate handlers.
//
// Port of the CERTIFICATES section from netlify/functions/api.js (lines 843–919).
// `certs.verify` is public (the verification URL on each certificate hits this
// without auth); the other three require a logged-in user.
//
// SMTP wiring (2026-05-15, Eid-Al-Adha readiness): after a cert row is
// inserted, an email goes to the recipient with the verification link
// (https://ssamau.com/verify-cert.html?code=<cert_code>). The recipient
// can also forward the link to verifiers (employers, scholarship admins).
// Send failure is non-fatal — the cert row exists either way and admins
// can re-send later via a follow-up action if needed.

import { sql } from '../_sql.ts';
import {
  httpErr, shortId,
  type Handler,
} from '../_helpers.ts';
import { sendEmail } from '../_email.ts';

const SITE_URL = Deno.env.get('SITE_URL') ?? 'https://ssamau.com';

function escHtml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Branded HTML email body for a certificate delivery. Used by both
// certsIssue (single) and certsBulkIssue (per recipient in the loop).
// recipientName / project / role / hours come from the cert row;
// cert_code drives the verification link.
function certDeliveryEmail(opts: {
  recipientName: string; projectName: string; role: string;
  hours: number | string; certCode: string;
}): string {
  const verifyUrl = `${SITE_URL}/verify-cert.html?code=${encodeURIComponent(opts.certCode)}`;
  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Almarai',Arial,sans-serif;color:#111827">
  <div style="max-width:600px;margin:24px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.06)">
    <div style="background:linear-gradient(135deg,#1A5C2E 0%,#0e3a1c 60%,#b8932a 100%);padding:1.8rem 1.4rem;color:#fff;text-align:center">
      <div style="font-size:1.6rem;font-weight:800;margin-bottom:.3rem">🏅</div>
      <div style="font-size:1.05rem;font-weight:800">شهادتك جاهزة</div>
      <div style="font-size:.72rem;color:rgba(255,255,255,.75);margin-top:.25rem">Your Certificate Is Ready</div>
    </div>
    <div style="padding:1.6rem 1.4rem;font-size:.92rem;color:#1f2937;line-height:1.75">
      <p style="margin:0 0 .85rem 0">السلام عليكم ${escHtml(opts.recipientName)},</p>
      <p style="margin:0 0 .85rem 0">يسعدنا تقديم شهادة تقدير لك على مشاركتك في:</p>

      <div style="background:#f9fafb;border-radius:10px;padding:1rem;margin:.85rem 0;font-size:.86rem">
        <div style="margin-bottom:.4rem"><span style="color:#6b7280">الفعالية:</span> <strong>${escHtml(opts.projectName)}</strong></div>
        <div style="margin-bottom:.4rem"><span style="color:#6b7280">الدور:</span> <strong>${escHtml(opts.role)}</strong></div>
        <div><span style="color:#6b7280">عدد الساعات:</span> <strong>${escHtml(String(opts.hours))}</strong></div>
      </div>

      <p style="margin:0 0 .85rem 0">يمكنك التحقق من الشهادة عبر الرابط التالي. الرابط نفسه قابل للمشاركة مع جهات التحقق (الجامعة، الجهة المبتعِثة، جهة عمل، ...):</p>

      <div style="text-align:center;margin:1.2rem 0">
        <a href="${verifyUrl}" style="display:inline-block;background:#1A5C2E;color:#fff;text-decoration:none;padding:.75rem 1.6rem;border-radius:50px;font-weight:700;font-size:.85rem">
          🔍 رابط التحقق من الشهادة
        </a>
      </div>

      <p style="margin:0 0 .4rem 0;font-size:.78rem;color:#6b7280;text-align:center">أو انسخ الرمز التالي وأدخله في صفحة التحقق:</p>
      <div style="text-align:center;font-family:monospace;letter-spacing:.08em;font-size:.85rem;font-weight:700;color:#1A5C2E;background:#f0fdf4;border-radius:8px;padding:.55rem;margin:.4rem 0 1rem">
        ${escHtml(opts.certCode)}
      </div>
    </div>
    <div style="padding:.95rem 1.4rem;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:.7rem;color:#6b7280;text-align:center">
      <span style="color:#b8932a;font-weight:700">نادي الطلبة السعوديين في ملبورن</span><br/>
      SSAM · Saudi Students Association in Melbourne
    </div>
  </div>
</body></html>`;
}

// Fires an email best-effort; never throws. Caller still gets the cert
// row even if delivery fails (the recipient can be re-emailed later).
async function tryDeliverCert(opts: {
  to: string | null; recipientName: string; projectName: string;
  role: string; hours: number | string; certCode: string;
}): Promise<void> {
  if (!opts.to) return;
  try {
    await sendEmail({
      to: opts.to,
      subject: `شهادتك من نادي الطلبة السعوديين — ${opts.projectName}`,
      html: certDeliveryEmail(opts),
    });
  } catch (err) {
    console.warn('[certs] delivery email failed (cert row still created):', err);
  }
}

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

  // Look up the project name for the email body — the form may have only
  // sent project_id. One round-trip is cheap and keeps the email handler
  // honest if the admin form ever loses the project-name pre-fill.
  const [project] = await sql`SELECT project_name FROM projects WHERE project_id = ${data.project_id}` as Array<{ project_name: string | null }>;

  await tryDeliverCert({
    to:            (data.recipient_email as string) || null,
    recipientName: (data.recipient_name as string)  || '—',
    projectName:   project?.project_name             || String(data.project_id || ''),
    role:          (data.role as string)             || '—',
    hours:         (data.hours as number | string)   ?? '—',
    certCode:      code,
  });

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

  const [project] = await sql`SELECT project_name FROM projects WHERE project_id = ${project_id}` as Array<{ project_name: string | null }>;
  const projectName = project?.project_name || String(project_id || '');

  let count = 0;
  let emailed = 0;
  for (const p of participants) {
    const code = shortId('CRT', 8);
    const recipientName = p.preferred_name || p.full_name || p.volunteer_name || '—';
    const recipientEmail = p.member_email || p.volunteer_email || null;
    await sql`
      INSERT INTO certificates (cert_code, member_id, project_id, recipient_name, recipient_email,
                                role, hours, issued_by)
      VALUES (${code}, ${p.member_id || null}, ${project_id},
              ${recipientName}, ${recipientEmail},
              ${role || null}, ${p.hours || 0}, ${user!.id})
    `;
    count++;
    if (recipientEmail) {
      await tryDeliverCert({
        to:            recipientEmail,
        recipientName,
        projectName,
        role:          role || '—',
        hours:         p.hours || 0,
        certCode:      code,
      });
      emailed++;
    }
  }
  return { count, emailed };
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
  // member_gender is now joined so the verify-cert page can pick the
  // right Arabic 3rd-person possessive ("جهوده" for male / "جهودها"
  // for female). DB values are 'ذكر' / 'أنثى'; the frontend maps to
  // the correct pronoun via a lookup. NULL = no member row (e.g.
  // volunteer cert) → frontend falls back to the masculine form
  // (Arabic's default neutral when speaker is uncertain).
  // Joins go through members → committees so the cert can display
  // "Committee: لجنة الفعاليات" under the role (president's spec —
  // "والمنصب تحت الدور = اللجنة"). committee_name is NULL for
  // volunteer certs where the recipient isn't a club member.
  const [c] = await sql`
    SELECT c.cert_code, c.recipient_name, c.role, c.hours, c.issued_at,
           m.full_name AS member_full_name, m.preferred_name, m.gender AS member_gender,
           cm.committee_name,
           p.project_name, p.event_date
    FROM certificates c
    LEFT JOIN members    m  ON m.member_id     = c.member_id
    LEFT JOIN committees cm ON cm.committee_id = m.committee_id
    LEFT JOIN projects   p  ON p.project_id    = c.project_id
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
