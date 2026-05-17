// Support tickets — in-product bug/feature/question reporting.
//
// Four actions:
//   support.submit         — any authenticated user (admin, head, member,
//                            volunteer). Inserts a ticket row, uploads an
//                            optional attachment to the private bucket,
//                            and fires a fire-and-forget email to the
//                            dev's inbox (xtlg511@icloud.com) with full
//                            context.
//   support.list           — superadmin-only. Returns the queue, newest
//                            first, with reporter join so the admin
//                            inbox can show who reported what.
//   support.updateStatus   — superadmin-only. Flips status between
//                            Open / InProgress / Resolved / Closed and
//                            stamps resolved_at on Resolved/Closed.
//   support.getAttachment  — superadmin-only. Returns a 1h signed URL
//                            for the screenshot. We never bake URLs into
//                            the email because they'd expire.

import { sql } from '../_sql.ts';
import {
  httpErr, shortId,
  requireAuth, requireSuperadmin,
  type Handler,
} from '../_helpers.ts';
import { sendEmail } from '../_email.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// Where bug reports land. Hardcoded per president's spec (the dev's
// iCloud address). If we ever want this configurable, swap to an
// env var — for now the destination is intentionally explicit.
const DEV_INBOX = 'xtlg511@icloud.com';
const SUPPORT_BUCKET    = 'support-attachments';
const SUPPORT_SIZE_CAP  = 4 * 1024 * 1024;                // 4 MiB
const SUPPORT_MIMES     = ['image/jpeg', 'image/png', 'image/webp'];
const ALLOWED_CATEGORIES = ['Bug', 'Feature', 'Question'] as const;
type SupportCategory = typeof ALLOWED_CATEGORIES[number];

function svcClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw httpErr('err.misc.storage_not_configured', 500);
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^;]+;base64,/, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ─── SUPPORT — SUBMIT ────────────────────────────────────────────────
const supportSubmit: Handler = async (body, user) => {
  requireAuth(user);
  const data = (body.data ?? body) as Record<string, unknown>;

  const category = String(data.category || '').trim() as SupportCategory;
  if (!ALLOWED_CATEGORIES.includes(category)) {
    throw httpErr('err.required.category', 400);
  }
  const title       = String(data.title || '').trim();
  const description = String(data.description || '').trim();
  if (!title)       throw httpErr('err.required.title', 400);
  if (!description) throw httpErr('err.required.description', 400);

  const repro_steps = (data.repro_steps as string | undefined)?.trim() || null;
  const page_url    = (data.page_url    as string | undefined)?.slice(0, 1024) || null;
  const user_agent  = (data.user_agent  as string | undefined)?.slice(0, 512)  || null;
  const viewport    = (data.viewport    as string | undefined)?.slice(0, 32)   || null;

  // Reporter snapshot. We store name/email/access ALONGSIDE the user_id
  // so the support inbox keeps useful context even if the member is
  // later deactivated or has their email changed.
  const [reporter] = await sql`
    SELECT u.id, u.access_level, m.member_id,
           m.full_name, m.preferred_name, m.email
    FROM public.users u
    LEFT JOIN public.members m ON m.member_id = u.member_id
    WHERE u.id = ${user!.id}
  ` as Array<{
    id: number; access_level: string; member_id: string | null;
    full_name: string | null; preferred_name: string | null; email: string | null;
  }>;
  const reporterName  = reporter?.preferred_name || reporter?.full_name || user!.username;
  const reporterEmail = reporter?.email || user!.email || null;
  const reporterAccess = reporter?.access_level || user!.access;

  const ticket_id = shortId('SUP', 8);

  // Attachment is optional. If supplied, upload to the PRIVATE bucket;
  // store only the path on the ticket row. Signed URLs are minted on
  // demand by support.getAttachment.
  let attachmentPath: string | null = null;
  let attachmentMime: string | null = null;
  const file = data.attachment as Record<string, unknown> | undefined;
  if (file && file.base64Data && file.filename && file.contentType) {
    const contentType = String(file.contentType);
    if (!SUPPORT_MIMES.includes(contentType)) {
      throw httpErr('err.business.content_type_not_allowed', 415, { contentType });
    }
    const bytes = b64ToBytes(String(file.base64Data));
    if (bytes.length > SUPPORT_SIZE_CAP) {
      throw httpErr('err.business.photo_too_large', 413, { limit: SUPPORT_SIZE_CAP });
    }
    // Filename sanitized + scoped under ticket_id/ so future deletes
    // can wipe a ticket's folder in one call. Timestamp prefix breaks
    // ties if a user submits multiple files via re-submit.
    const safeName = String(file.filename).replace(/[\/\\\s]/g, '_').slice(-80);
    attachmentPath = `${ticket_id}/${Date.now()}-${safeName}`;
    attachmentMime = contentType;
    const sb = svcClient();
    const { error } = await sb.storage.from(SUPPORT_BUCKET).upload(attachmentPath, bytes, {
      contentType, upsert: false,
    });
    if (error) {
      console.error('[support.submit] upload error', error);
      throw httpErr('err.business.upload_failed', 500, { message: error.message });
    }
  }

  await sql`
    INSERT INTO public.support_tickets (
      ticket_id, reporter_user_id, reporter_member_id,
      reporter_email, reporter_name, reporter_access,
      category, title, description, repro_steps,
      page_url, user_agent, viewport,
      attachment_path, attachment_mime, status
    ) VALUES (
      ${ticket_id}, ${user!.id}, ${reporter?.member_id || null},
      ${reporterEmail}, ${reporterName}, ${reporterAccess},
      ${category}, ${title}, ${description}, ${repro_steps},
      ${page_url}, ${user_agent}, ${viewport},
      ${attachmentPath}, ${attachmentMime}, 'Open'
    )
  `;

  // Fire-and-forget email to the dev. If SMTP fails the ticket still
  // exists in the DB — superadmin can see it in the support tab.
  notifyDevOfTicket({
    ticket_id, category, title, description, repro_steps,
    reporterName: reporterName || '—',
    reporterEmail: reporterEmail || '—',
    reporterAccess: reporterAccess || '—',
    page_url, user_agent, viewport,
    hasAttachment: !!attachmentPath,
  }).catch(err => {
    console.error('[support.submit] dev-email failed (ticket still saved):', err);
  });

  return { ticket_id };
};

async function notifyDevOfTicket(opts: {
  ticket_id: string; category: SupportCategory; title: string;
  description: string; repro_steps: string | null;
  reporterName: string; reporterEmail: string; reporterAccess: string;
  page_url: string | null; user_agent: string | null; viewport: string | null;
  hasAttachment: boolean;
}): Promise<void> {
  const esc = (s: string) => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const nl = (s: string) => esc(s).replace(/\n/g, '<br/>');
  const subject = `[SSAM Support][${opts.category}] ${opts.title}`;

  // Plain LTR English body — the dev reads it in their iCloud inbox;
  // no need for the bilingual letterhead the user-facing emails use.
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#111827">
  <div style="max-width:640px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.06)">
    <div style="background:#1A5C2E;padding:1.2rem 1.4rem;color:#fff">
      <div style="font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;opacity:.7">SSAM Support · ${esc(opts.category)}</div>
      <div style="font-size:1.05rem;font-weight:700;margin-top:.3rem">${esc(opts.title)}</div>
      <div style="font-size:.72rem;opacity:.7;margin-top:.2rem;font-family:Menlo,Consolas,monospace">${esc(opts.ticket_id)}</div>
    </div>
    <div style="padding:1.4rem;font-size:.92rem;line-height:1.7;color:#1f2937">
      <table style="width:100%;font-size:.84rem;color:#374151;border-collapse:collapse;margin-bottom:1rem">
        <tr><td style="padding:.25rem 0;color:#6b7280;width:30%">Reporter</td><td style="padding:.25rem 0">${esc(opts.reporterName)}</td></tr>
        <tr><td style="padding:.25rem 0;color:#6b7280">Email</td><td style="padding:.25rem 0;direction:ltr">${esc(opts.reporterEmail)}</td></tr>
        <tr><td style="padding:.25rem 0;color:#6b7280">Role</td><td style="padding:.25rem 0">${esc(opts.reporterAccess)}</td></tr>
        ${opts.page_url   ? `<tr><td style="padding:.25rem 0;color:#6b7280">Page</td><td style="padding:.25rem 0;direction:ltr;word-break:break-all">${esc(opts.page_url)}</td></tr>` : ''}
        ${opts.viewport   ? `<tr><td style="padding:.25rem 0;color:#6b7280">Viewport</td><td style="padding:.25rem 0;direction:ltr">${esc(opts.viewport)}</td></tr>` : ''}
        ${opts.user_agent ? `<tr><td style="padding:.25rem 0;color:#6b7280">User agent</td><td style="padding:.25rem 0;direction:ltr;font-size:.72rem;color:#6b7280">${esc(opts.user_agent)}</td></tr>` : ''}
        <tr><td style="padding:.25rem 0;color:#6b7280">Attachment</td><td style="padding:.25rem 0">${opts.hasAttachment ? 'Yes — see admin support tab' : 'None'}</td></tr>
      </table>

      <div style="background:#f9fafb;border-radius:8px;padding:.85rem 1rem;margin-bottom:.85rem">
        <div style="font-size:.72rem;color:#6b7280;letter-spacing:.05em;text-transform:uppercase;margin-bottom:.35rem">Description</div>
        <div>${nl(opts.description)}</div>
      </div>

      ${opts.repro_steps ? `
      <div style="background:#fffbeb;border-left:4px solid #b8932a;border-radius:8px;padding:.85rem 1rem;margin-bottom:.85rem">
        <div style="font-size:.72rem;color:#6b7280;letter-spacing:.05em;text-transform:uppercase;margin-bottom:.35rem">Steps to reproduce</div>
        <div>${nl(opts.repro_steps)}</div>
      </div>` : ''}

      <p style="font-size:.78rem;color:#6b7280;margin:.6rem 0 0">View this ticket and manage status: <a href="https://ssamau.com/admin.html#/admin/support" style="color:#1A5C2E">admin support tab</a></p>
    </div>
  </div>
</body></html>`;

  await sendEmail({ to: DEV_INBOX, subject, html });
}

// ─── SUPPORT — LIST (superadmin) ─────────────────────────────────────
const supportList: Handler = async (body, user) => {
  requireSuperadmin(user);
  const status = body.status as string | undefined;
  return sql`
    SELECT id, ticket_id,
           reporter_user_id, reporter_member_id, reporter_name, reporter_email,
           reporter_access, category, title, description, repro_steps,
           page_url, user_agent, viewport, attachment_path, attachment_mime,
           status, resolution_note, created_at, updated_at, resolved_at
    FROM public.support_tickets
    WHERE 1=1
      ${status ? sql`AND status = ${status}` : sql``}
    ORDER BY
      CASE status WHEN 'Open' THEN 0 WHEN 'InProgress' THEN 1
                  WHEN 'Resolved' THEN 2 WHEN 'Closed' THEN 3 END,
      created_at DESC
    LIMIT 500
  `;
};

// ─── SUPPORT — UPDATE STATUS (superadmin) ────────────────────────────
const supportUpdateStatus: Handler = async (body, user) => {
  requireSuperadmin(user);
  const ticket_id     = body.ticket_id     as string | undefined;
  const status        = body.status        as string | undefined;
  const resolution    = body.resolution_note as string | undefined;
  if (!ticket_id) throw httpErr('err.required.ticket_id', 400);
  if (!status || !['Open','InProgress','Resolved','Closed'].includes(status)) {
    throw httpErr('err.required.status', 400);
  }
  const setResolvedAt = (status === 'Resolved' || status === 'Closed');
  await sql`
    UPDATE public.support_tickets SET
      status          = ${status},
      resolution_note = COALESCE(${resolution || null}, resolution_note),
      resolved_at     = CASE WHEN ${setResolvedAt} THEN COALESCE(resolved_at, NOW()) ELSE NULL END,
      updated_at      = NOW()
    WHERE ticket_id = ${ticket_id}
  `;
  return { ticket_id, status };
};

// ─── SUPPORT — GET ATTACHMENT (superadmin) ───────────────────────────
const supportGetAttachment: Handler = async (body, user) => {
  requireSuperadmin(user);
  const ticket_id = body.ticket_id as string | undefined;
  if (!ticket_id) throw httpErr('err.required.ticket_id', 400);
  const [row] = await sql`
    SELECT attachment_path, attachment_mime
    FROM public.support_tickets WHERE ticket_id = ${ticket_id}
  ` as Array<{ attachment_path: string | null; attachment_mime: string | null }>;
  if (!row?.attachment_path) {
    return { url: null, missing: true };
  }
  const sb = svcClient();
  const { data: signed, error } = await sb.storage
    .from(SUPPORT_BUCKET)
    .createSignedUrl(row.attachment_path, 60 * 60); // 1 hour
  if (error || !signed?.signedUrl) {
    return { url: null, missing: true };
  }
  return { url: signed.signedUrl, mime: row.attachment_mime };
};

export const supportActions: Record<string, Handler> = {
  'support.submit':        supportSubmit,
  'support.list':          supportList,
  'support.updateStatus':  supportUpdateStatus,
  'support.getAttachment': supportGetAttachment,
};
