// Membership-application handlers.
//
// Port of the MEMBERSHIP APPLICATIONS (§6) section from
// netlify/functions/api.js (lines 1110–1301).
// `applications.submit` is public (the public apply.html form hits it
// without auth); list / assignCommittee / requestInterview / accept /
// reject all require auth, with head-scope checks where appropriate.

import { sql } from '../_sql.ts';
import {
  httpErr, shortId,
  requireAuth, requireSuperadmin, requireAdminScope,
  type Handler,
} from '../_helpers.ts';
import { sendEmail } from '../_email.ts';

// Recipient address for new-application notifications. The president's
// stated requirement: notify the shared admin inbox every time someone
// submits the public form, so the team can quickly figure out which
// committee head should pick the application up. Replaces what Google
// Forms used to do automatically before this stack existed.
const APPLICATION_NOTIF_TO = 'info@ssamau.com';

// ─── MEMBERSHIP APPLICATIONS (§6) ────────────────────────────────────
// Public submission. Anyone on the website can hit this without auth.
// Accepts the expanded apply-form-v2 payload — see migration 0005 for the
// column list and apply.html for the canonical value sets.
const applicationsSubmit: Handler = async (body) => {
  const data = (body.data ?? body) as Record<string, unknown>;

  // Display name: prefer the new structured name_ar; fall back to full_name
  // for any old/legacy callers still posting the original v1 schema.
  const displayName = data.name_ar || data.full_name;
  if (!displayName) throw httpErr('name_ar (or full_name) is required', 400);
  if (!data.email && !data.phone) {
    throw httpErr('email or phone is required', 400);
  }
  if (data.confirmation_accepted !== true) {
    throw httpErr('confirmation_accepted must be true', 400);
  }

  const id = (data.application_id as string | undefined) || shortId('APP');
  const interests = Array.isArray(data.interests)
    ? data.interests
    : (typeof data.interests === 'string' && data.interests
        ? (data.interests as string).split(',').map(s => s.trim()).filter(Boolean)
        : []);

  await sql`
    INSERT INTO membership_applications (
      application_id, full_name, preferred_name, email, phone,
      university, major, gender, interests, pitch,
      national_id, name_ar, name_en, date_of_birth,
      address_melbourne, phone_country_code,
      whatsapp, whatsapp_country_code,
      scholarship_entity, scholarship_entity_other,
      study_level, degree_field, university_other,
      study_started_window, expected_graduation_window,
      cv_url, skills_hobbies, about_self,
      referral_source, referral_source_other, suggestions,
      confirmation_accepted, status
    ) VALUES (
      ${id}, ${displayName}, ${data.preferred_name || null},
      ${data.email || null}, ${data.phone || null},
      ${data.university || null}, ${data.degree_field || data.major || null},
      ${data.gender || null}, ${interests}, ${data.about_self || data.pitch || null},
      ${data.national_id || null}, ${data.name_ar || null}, ${data.name_en || null},
      ${data.date_of_birth || null},
      ${data.address_melbourne || null}, ${data.phone_country_code || null},
      ${data.whatsapp || null}, ${data.whatsapp_country_code || null},
      ${data.scholarship_entity || null}, ${data.scholarship_entity_other || null},
      ${data.study_level || null}, ${data.degree_field || null}, ${data.university_other || null},
      ${data.study_started_window || null}, ${data.expected_graduation_window || null},
      ${data.cv_url || null}, ${data.skills_hobbies || null}, ${data.about_self || null},
      ${data.referral_source || null}, ${data.referral_source_other || null},
      ${data.suggestions || null},
      ${data.confirmation_accepted === true},
      'PendingTriage'
    )
  `;

  // Side-effect: notify the shared admin inbox so the team can triage
  // and route the application to the right committee head. Replaces
  // the old Google-Forms-auto-notification behaviour. We deliberately
  // DON'T await + don't fail the submit if the email send breaks —
  // the application is already saved, and the admin team can still
  // see it in the dashboard; an email blip shouldn't surface as a
  // "submission failed" UX to the applicant.
  notifyNewApplication(id, data).catch(err => {
    console.error('[applications.submit] notification email failed:', err);
  });

  return { application_id: id };
};

// Compose + send the new-application notification. Pulled into its
// own function so the submit handler stays readable, and so future
// notifications (e.g. on application accept/reject) can reuse the
// same template helpers.
async function notifyNewApplication(applicationId: string, data: Record<string, unknown>): Promise<void> {
  const nameAr = String(data.name_ar || data.full_name || '—');
  const nameEn = String(data.name_en || '');
  const subject = `📥 طلب عضوية جديد — ${nameAr}`;

  const interests = Array.isArray(data.interests) ? data.interests as string[] : [];
  const phoneFull = data.phone
    ? `${data.phone_country_code || ''} ${data.phone}`.trim()
    : '—';
  const whatsappFull = data.whatsapp
    ? `${data.whatsapp_country_code || ''} ${data.whatsapp}`.trim()
    : '—';
  const universityField = data.university_other
    ? `${data.university || ''} (${data.university_other})`.trim()
    : String(data.university || '—');
  const scholarshipField = data.scholarship_entity_other
    ? `${data.scholarship_entity || ''} — ${data.scholarship_entity_other}`.trim()
    : String(data.scholarship_entity || '—');

  // Inline-CSS HTML email. Same design language as the password-
  // recovery template (green brand header + Arabic-first body). Most
  // email clients strip <style> blocks so every property is inline.
  const html = `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="UTF-8"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f6f4;font-family:'Helvetica Neue',Arial,sans-serif;color:#111827;line-height:1.55;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f6f4;">
  <tr><td align="center" style="padding:24px 12px;">
    <table cellpadding="0" cellspacing="0" border="0" width="640" style="max-width:640px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
      <tr><td style="background:#1A5C2E;padding:22px 24px;color:#fff;">
        <div style="font-size:13px;color:#c9a032;letter-spacing:.5px;">SSAM — طلبات العضوية</div>
        <div style="font-size:20px;font-weight:700;margin-top:4px;">طلب عضوية جديد</div>
        <div style="font-size:12px;color:rgba(255,255,255,.7);margin-top:6px;font-family:Menlo,Consolas,monospace;direction:ltr;text-align:left;">${esc(applicationId)}</div>
      </td></tr>
      <tr><td style="padding:24px;">
        ${section('المتقدّم', [
          ['الاسم (عربي)', nameAr],
          ['Name (English)',  nameEn || '—'],
          ['الاسم المختصر',   String(data.preferred_name || '—')],
          ['الجنس',          String(data.gender || '—')],
          ['تاريخ الميلاد',  String(data.date_of_birth || '—')],
        ])}
        ${section('التواصل', [
          ['البريد الإلكتروني', String(data.email || '—')],
          ['الجوال',            phoneFull],
          ['واتساب',            whatsappFull],
          ['العنوان في ملبورن', String(data.address_melbourne || '—')],
        ])}
        ${section('الهوية', [
          ['رقم الهوية', String(data.national_id || '—')],
          ['جهة الابتعاث', scholarshipField],
        ])}
        ${section('الدراسة', [
          ['الجامعة',     universityField],
          ['المرحلة',     String(data.study_level || '—')],
          ['التخصص',     String(data.degree_field || data.major || '—')],
          ['بداية الدراسة', String(data.study_started_window || '—')],
          ['التخرج المتوقع', String(data.expected_graduation_window || '—')],
          ['CV',          data.cv_url ? `<a href="${esc(String(data.cv_url))}" style="color:#1A5C2E">رابط</a>` : '—'],
        ])}
        ${interests.length ? `
          <div style="margin-bottom:18px;">
            <div style="font-size:13px;font-weight:700;color:#0e3a1c;margin-bottom:8px;">اللجان المهتمة بها</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;">
              ${interests.map(i => `<span style="display:inline-block;background:#e8f5e9;color:#0e3a1c;font-size:12px;padding:4px 10px;border-radius:50px;">${esc(i)}</span>`).join('')}
            </div>
          </div>` : ''}
        ${data.skills_hobbies ? `
          <div style="margin-bottom:14px;">
            <div style="font-size:13px;font-weight:700;color:#0e3a1c;margin-bottom:6px;">المهارات والاهتمامات</div>
            <div style="font-size:13px;color:#374151;white-space:pre-wrap;">${esc(String(data.skills_hobbies))}</div>
          </div>` : ''}
        ${data.about_self ? `
          <div style="margin-bottom:14px;">
            <div style="font-size:13px;font-weight:700;color:#0e3a1c;margin-bottom:6px;">نبذة عن المتقدّم</div>
            <div style="font-size:13px;color:#374151;white-space:pre-wrap;">${esc(String(data.about_self))}</div>
          </div>` : ''}
        ${data.suggestions ? `
          <div style="margin-bottom:14px;">
            <div style="font-size:13px;font-weight:700;color:#0e3a1c;margin-bottom:6px;">اقتراحات</div>
            <div style="font-size:13px;color:#374151;white-space:pre-wrap;">${esc(String(data.suggestions))}</div>
          </div>` : ''}
        <div style="margin-top:24px;text-align:center;">
          <a href="https://ssamau.com/admin.html#/admin/applications"
             style="display:inline-block;padding:12px 28px;background:#1A5C2E;color:#fff;text-decoration:none;font-weight:700;font-size:14px;border-radius:10px;">
            افتح في لوحة الإدارة
          </a>
        </div>
      </td></tr>
      <tr><td style="background:#f9fafb;padding:14px 24px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;text-align:center;">
        رسالة آلية من نظام إدارة النادي — لا ترد عليها.<br/>
        SSAM — Saudi Students Association in Melbourne
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

  await sendEmail({ to: APPLICATION_NOTIF_TO, subject, html });
}

// HTML-escape for content interpolated into email body. Same logic
// as the frontend's `esc` but inlined here so this module doesn't
// pull in lib/format.js (which is browser-targeted).
function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Renders a "section" of label/value rows in the email body. Same
// table-based layout the password-recovery email uses — survives
// Outlook + Gmail + Apple Mail rendering quirks.
function section(title: string, rows: Array<[string, string]>): string {
  return `
    <div style="margin-bottom:18px;border-bottom:1px solid #f0f0f0;padding-bottom:14px;">
      <div style="font-size:13px;font-weight:700;color:#0e3a1c;margin-bottom:10px;">${esc(title)}</div>
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:13px;">
        ${rows.map(([l, v]) => `
          <tr>
            <td style="color:#6b7280;padding:3px 0;width:140px;vertical-align:top;">${esc(l)}</td>
            <td style="color:#111827;padding:3px 0;vertical-align:top;">${v}</td>
          </tr>`).join('')}
      </table>
    </div>`;
}

const applicationsList: Handler = async (body, user) => {
  requireAuth(user);
  const status = body.status as string | undefined;
  const assigned_committee_id = body.assigned_committee_id as string | undefined;
  // Heads only see their committee's queue (plus untriaged ones, so they
  // can flag items presidency should triage). Presidency sees everything.
  if (user.access === 'head') {
    return sql`
      SELECT a.*, c.committee_name AS assigned_committee_name
      FROM membership_applications a
      LEFT JOIN committees c ON c.committee_id = a.assigned_committee_id
      WHERE 1=1
        AND (a.assigned_committee_id IS NULL OR a.assigned_committee_id = ${user.committee_id})
        ${status ? sql`AND a.status = ${status}` : sql``}
      ORDER BY a.created_at DESC
    `;
  }
  return sql`
    SELECT a.*, c.committee_name AS assigned_committee_name
    FROM membership_applications a
    LEFT JOIN committees c ON c.committee_id = a.assigned_committee_id
    WHERE 1=1
      ${status                ? sql`AND a.status                = ${status}`                : sql``}
      ${assigned_committee_id ? sql`AND a.assigned_committee_id = ${assigned_committee_id}` : sql``}
    ORDER BY a.created_at DESC
  `;
};

// Presidency triages a PendingTriage application to a committee.
const applicationsAssignCommittee: Handler = async (body, user) => {
  requireSuperadmin(user);
  const id = body.id as string | undefined;
  const committee_id = body.committee_id as string | undefined;
  if (!committee_id) throw httpErr('committee_id is required', 400);
  const [row] = await sql`SELECT status FROM membership_applications WHERE application_id = ${id}` as Array<{ status: string }>;
  if (!row) throw httpErr('Application not found', 404);
  if (row.status !== 'PendingTriage') {
    throw httpErr(`Cannot triage an application in status ${row.status}`, 409);
  }
  await sql`
    UPDATE membership_applications SET
      status                = 'AssignedToCommittee',
      assigned_committee_id = ${committee_id}
    WHERE application_id = ${id}
  `;
  return { application_id: id };
};

// Committee head flags that they want to interview before deciding.
const applicationsRequestInterview: Handler = async (body, user) => {
  const id = body.id as string | undefined;
  const note = body.note as string | undefined;
  const [row] = await sql`SELECT status, assigned_committee_id FROM membership_applications WHERE application_id = ${id}` as Array<{
    status: string; assigned_committee_id: string | null;
  }>;
  if (!row) throw httpErr('Application not found', 404);
  requireAdminScope(user, row.assigned_committee_id);
  if (row.status !== 'AssignedToCommittee' && row.status !== 'InterviewRequested') {
    throw httpErr(`Cannot request interview for status ${row.status}`, 409);
  }
  await sql`
    UPDATE membership_applications SET
      status          = 'InterviewRequested',
      decision_reason = COALESCE(${note}, decision_reason)
    WHERE application_id = ${id}
  `;
  return { application_id: id };
};

// Accept: creates a members row tied to the assigned committee. Per the
// current decision, no users (login) row is created — login provisioning
// is part of the upcoming member-portal restructure.
const applicationsAccept: Handler = async (body, user) => {
  const id = body.id as string | undefined;
  const note = body.note as string | undefined;
  const [app] = await sql`
    SELECT * FROM membership_applications WHERE application_id = ${id}
  ` as Array<Record<string, unknown>>;
  if (!app) throw httpErr('Application not found', 404);
  requireAdminScope(user, app.assigned_committee_id as string | null | undefined);
  if (app.status !== 'AssignedToCommittee' && app.status !== 'InterviewRequested') {
    throw httpErr(`Cannot accept an application in status ${app.status}`, 409);
  }
  if (!app.assigned_committee_id) {
    throw httpErr('Application must be assigned to a committee before acceptance', 400);
  }
  const memberId = shortId('MBR');
  // Display name preference: structured Arabic name first, then full_name
  // (covers both v2 and any legacy v1 applications still in the queue).
  const displayName = app.name_ar || app.full_name;
  // Combine WhatsApp country code + number into the E.164 string that
  // `members.whatsapp` stores (the apply form keeps them split for UX).
  const whatsappE164 = app.whatsapp
    ? (app.whatsapp_country_code && !(app.whatsapp as string).startsWith('+')
        ? `${app.whatsapp_country_code}${app.whatsapp}`
        : app.whatsapp)
    : null;
  await sql`
    INSERT INTO members
      (member_id, full_name, preferred_name, email, phone, whatsapp,
       gender, date_of_birth,
       committee_id, club_role, status, join_date, national_id)
    VALUES
      (${memberId}, ${displayName}, ${app.preferred_name || null},
       ${app.email || null}, ${app.phone || null}, ${whatsappE164},
       ${app.gender || null}, ${app.date_of_birth || null},
       ${app.assigned_committee_id}, 'Member', 'Active', CURRENT_DATE,
       ${app.national_id || null})
  `;
  await sql`
    UPDATE membership_applications SET
      status             = 'Accepted',
      decided_by_user_id = ${user!.id},
      decided_at         = NOW(),
      decision_reason    = COALESCE(${note}, decision_reason),
      created_member_id  = ${memberId}
    WHERE application_id = ${id}
  `;
  return { application_id: id, member_id: memberId };
};

const applicationsReject: Handler = async (body, user) => {
  const id = body.id as string | undefined;
  const reason = body.reason as string | undefined;
  const [app] = await sql`SELECT status, assigned_committee_id FROM membership_applications WHERE application_id = ${id}` as Array<{
    status: string; assigned_committee_id: string | null;
  }>;
  if (!app) throw httpErr('Application not found', 404);
  // Heads can reject only within their committee's scope, but only after
  // triage. Presidency can reject anything (including PendingTriage) for
  // obvious-spam cases.
  if (user!.access === 'head') {
    if (!app.assigned_committee_id) throw httpErr('This application has not been triaged yet', 409);
    requireAdminScope(user, app.assigned_committee_id);
  } else if (user!.access !== 'superadmin') {
    throw httpErr('Forbidden', 403);
  }
  if (app.status === 'Accepted' || app.status === 'Rejected') {
    throw httpErr(`Application already ${app.status}`, 409);
  }
  await sql`
    UPDATE membership_applications SET
      status             = 'Rejected',
      decided_by_user_id = ${user!.id},
      decided_at         = NOW(),
      decision_reason    = ${reason || null}
    WHERE application_id = ${id}
  `;
  return { application_id: id };
};

export const applicationsActions: Record<string, Handler> = {
  'applications.submit':           applicationsSubmit,
  'applications.list':             applicationsList,
  'applications.assignCommittee':  applicationsAssignCommittee,
  'applications.requestInterview': applicationsRequestInterview,
  'applications.accept':           applicationsAccept,
  'applications.reject':           applicationsReject,
};
