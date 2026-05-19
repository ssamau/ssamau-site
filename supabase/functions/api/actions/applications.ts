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
  requireAuth, requireAdmin, requireAdminScope,
  type Handler,
} from '../_helpers.ts';
import { sendEmail } from '../_email.ts';
import { generateInviteToken, composeInviteEmail } from './auth.ts';
import { rateLimit, getClientIp } from '../_ratelimit.ts';

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
//
// Seasonal applicant-type gate (added 2026-05-17, president's call):
//   Jan 1 – May 31 → form accepts members + volunteers; body's
//     `applicant_type` is honored. Defaults to 'Member' if not set
//     (legacy form callers).
//   Jun 1 – Dec 31 → server forces 'Volunteer' regardless of what the
//     body claims. The form also hides member language client-side,
//     but the server is the authority: a tampered POST during the
//     volunteer window still lands as a volunteer.
//
// `gateApplicantType()` returns the effective applicant_type for the
// current UTC date. Pulled into a helper so the date logic can be unit-
// tested in isolation if we ever add tests.
function gateApplicantType(requested: unknown): 'Member' | 'Volunteer' {
  const m = new Date().getUTCMonth(); // 0=Jan ... 11=Dec
  const inMemberWindow = m >= 0 && m <= 4; // Jan(0) – May(4)
  if (!inMemberWindow) return 'Volunteer';
  return requested === 'Volunteer' ? 'Volunteer' : 'Member';
}

const applicationsSubmit: Handler = async (body, _user, req) => {
  const data = (body.data ?? body) as Record<string, unknown>;

  // ── Rate limiting (security audit H4, 2026-05-19) ────────────────
  // Public unauthenticated endpoint + triggers admin email per submit.
  // Two tiers stacked: IP cap defeats most scripted floods; NID cap
  // catches a determined attacker who rotates IPs but reuses one
  // identity. Either limit hit → 429 with `err.rate.too_many_applications`.
  if (req) {
    const ip = getClientIp(req);
    const ipCheck = rateLimit({
      bucket:     'applications.submit',
      identifier: `ip:${ip}`,
      max:        3,
      windowMs:   60 * 60 * 1000,  // 3 per hour per IP
    });
    if (!ipCheck.ok) throw httpErr('err.rate.too_many_applications', 429);

    const nid = String(data.national_id ?? '').trim();
    if (nid) {
      const nidCheck = rateLimit({
        bucket:     'applications.submit',
        identifier: `nid:${nid}`,
        max:        1,
        windowMs:   24 * 60 * 60 * 1000,  // 1 per 24h per NID
      });
      if (!nidCheck.ok) throw httpErr('err.rate.duplicate_application', 429);
    }
  }

  // Display name: prefer the new structured name_ar; fall back to full_name
  // for any old/legacy callers still posting the original v1 schema.
  const displayName = data.name_ar || data.full_name;
  if (!displayName) throw httpErr('err.required.name_ar', 400);
  if (!data.email && !data.phone) {
    throw httpErr('err.required.email_or_phone', 400);
  }
  if (data.confirmation_accepted !== true) {
    throw httpErr('err.required.confirmation', 400);
  }

  const applicantType = gateApplicantType(data.applicant_type);

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
      confirmation_accepted, status, applicant_type
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
      'PendingTriage', ${applicantType}
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

// Translation tables — keep these in sync with apply.html's <select>
// options. The form posts the raw value (e.g. `khadem_alharamain`),
// the DB stores the raw value, and the admin sees the friendly label
// in the email. We deliberately DON'T translate in the DB because the
// raw enum is what the admin UI filters on; rendering is a view concern.
//
// Gender values are exceptions — the form posts the already-Arabic
// label directly (`value="ذكر"` etc., see apply.html), so the value
// usually IS the label. We still maintain a fallback table because
// some test/legacy data has English codes (`male`/`female`).
const SCHOLARSHIP_LABELS_AR: Record<string, string> = {
  khadem_alharamain:    'برنامج خادم الحرمين الشريفين للابتعاث',
  job_sponsored:        'الابتعاث الوظيفي (حكومي / عسكري)',
  private_sector:       'ابتعاث الشركات والقطاع الخاص',
  cultural_tourism:     'الابتعاث الثقافي والسياحي',
  companion_student:    'مرافق دارس',
  self_funded:          'دارس على الحساب الخاص',
  companion_non_student:'مرافق غير دارس',
  resident_non_student: 'مقيم/ـة غير دارس',
  other:                'أخرى',
};
const UNIVERSITY_LABELS: Record<string, string> = {
  melbourne:  'Melbourne University',
  monash:     'Monash University',
  rmit:       'RMIT University',
  deakin:     'Deakin University',
  latrobe:    'La Trobe University',
  swinburne:  'Swinburne University',
  victoria:   'Victoria University',
  acu:        'Australian Catholic University',
  other:      'أخرى',
};
const STUDY_LEVEL_LABELS_AR: Record<string, string> = {
  PhD:      'دكتوراه',
  Masters:  'ماجستير',
  Bachelor: 'بكالوريوس',
  Diploma:  'دبلوم',
  Language: 'دراسة لغة',
};
const STUDY_STARTED_LABELS_AR: Record<string, string> = {
  '<6mo':   'أقل من 6 أشهر',
  '6mo-1y': 'من 6 أشهر إلى سنة',
  '>1y':    'أكثر من سنة',
};
const GRADUATION_LABELS_AR: Record<string, string> = {
  Jul2027: 'يوليو 2027',
  Dec2027: 'ديسمبر 2027',
  '2028+': '2028 أو لاحقاً',
};
const GENDER_LABELS_AR: Record<string, string> = {
  male:   'ذكر',
  female: 'أنثى',
  // form sends 'ذكر' / 'أنثى' directly — these fall through the
  // `?? raw` path in t() unchanged.
};

// Tiny translator with a sensible fallback: if the value isn't in the
// table (e.g. an old enum value or stray test data), show the raw key
// rather than `—` so the admin sees something to grep.
function t(table: Record<string, string>, value: unknown): string {
  if (value == null || value === '') return '—';
  const v = String(value);
  return table[v] ?? v;
}

// Compose + send the new-application notification. Pulled into its
// own function so the submit handler stays readable, and so future
// notifications (e.g. on application accept/reject) can reuse the
// same template helpers.
async function notifyNewApplication(applicationId: string, data: Record<string, unknown>): Promise<void> {
  const nameAr = String(data.name_ar || data.full_name || '—');
  const nameEn = String(data.name_en || '');
  const subject = `📥 طلب عضوية جديد — ${nameAr}`;

  // Resolve committee IDs (COM_001 …) → Arabic committee names by
  // querying the committees table. Cheap one-shot read — and the
  // notification is fire-and-forget anyway, so a small DB hit here
  // doesn't slow the applicant's submit response.
  const interestIds = Array.isArray(data.interests) ? data.interests as string[] : [];
  let committeeNames: string[] = [];
  if (interestIds.length) {
    const rows = await sql`
      SELECT committee_id, committee_name
      FROM committees
      WHERE committee_id = ANY(${interestIds})
    ` as Array<{ committee_id: string; committee_name: string }>;
    // Preserve the applicant's chosen ORDER (rows come back in PK order,
    // not the applicant's order). Fall through to raw ID if a COM_XXX
    // was deleted between submit and notify.
    const byId = new Map(rows.map(r => [r.committee_id, r.committee_name]));
    committeeNames = interestIds.map(id => byId.get(id) ?? id);
  }

  const phoneFull = data.phone
    ? `${data.phone_country_code || ''} ${data.phone}`.trim()
    : '—';
  const whatsappFull = data.whatsapp
    ? `${data.whatsapp_country_code || ''} ${data.whatsapp}`.trim()
    : '—';
  const universityField = data.university_other
    ? `${t(UNIVERSITY_LABELS, data.university)} — ${data.university_other}`
    : t(UNIVERSITY_LABELS, data.university);
  const scholarshipField = data.scholarship_entity_other
    ? `${t(SCHOLARSHIP_LABELS_AR, data.scholarship_entity)} — ${data.scholarship_entity_other}`
    : t(SCHOLARSHIP_LABELS_AR, data.scholarship_entity);

  // Inline-CSS HTML email. Same design language and structure as the
  // password-recovery template (which is known to render across Gmail,
  // Apple Mail, Outlook) — bulletproof patterns:
  //   * role="presentation" on every layout table (screen-reader hint
  //     + signals "this is layout, not data" to some clients)
  //   * bgcolor attribute MIRRORS style="background:…" because Gmail
  //     web preserves bgcolor when it strips `background`
  //   * No display:flex / gap (Gmail strips both — chips fall back to
  //     plain inline-block spans separated by literal whitespace)
  //   * <meta name="color-scheme" content="light only"> + supported-
  //     color-schemes — opts the message out of Gmail's auto-darken
  //     transform, which is the #1 reason "styling doesn't show up":
  //     it inverts the white card to black, washes out the green
  //     header, and rewrites text colors unpredictably
  //   * !important on text colors inside the dark header band (Gmail
  //     web/mobile will otherwise re-color white text to dark grey on
  //     dark-mode users)
  //   * Bulletproof CTA button: <a> inside a single-cell <table> with
  //     bgcolor — survives Outlook + Gmail
  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light only" />
  <meta name="supported-color-schemes" content="light only" />
  <title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f6f4;font-family:'Helvetica Neue',Arial,sans-serif;color:#111827;line-height:1.55;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#f4f6f4" style="background-color:#f4f6f4;">
    <tr>
      <td align="center" style="padding:24px 12px;">

        <!-- Card -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="640" bgcolor="#ffffff" style="max-width:640px;background-color:#ffffff;border-radius:12px;border:1px solid #e5e7eb;">

          <!-- Header band -->
          <tr>
            <td bgcolor="#1A5C2E" style="background-color:#1A5C2E;padding:22px 24px;border-top-left-radius:12px;border-top-right-radius:12px;">
              <div style="font-size:13px;color:#c9a032 !important;letter-spacing:.5px;">SSAM — طلبات العضوية</div>
              <div style="font-size:20px;font-weight:700;margin-top:4px;color:#ffffff !important;">طلب عضوية جديد</div>
              <div dir="ltr" style="font-size:12px;color:#ffffff !important;opacity:.8;margin-top:6px;font-family:Menlo,Consolas,monospace;text-align:left;">${esc(applicationId)}</div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:24px;">
              ${section('المتقدّم', [
                ['الاسم (عربي)', nameAr],
                ['Name (English)',  nameEn || '—'],
                ['الاسم المختصر',   String(data.preferred_name || '—')],
                ['الجنس',          t(GENDER_LABELS_AR, data.gender)],
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
                ['المرحلة',     t(STUDY_LEVEL_LABELS_AR, data.study_level)],
                ['التخصص',     String(data.degree_field || data.major || '—')],
                ['بداية الدراسة', t(STUDY_STARTED_LABELS_AR, data.study_started_window)],
                ['التخرج المتوقع', t(GRADUATION_LABELS_AR, data.expected_graduation_window)],
                ['CV',          data.cv_url
                  ? { html: `<a href="${esc(String(data.cv_url))}" style="color:#1A5C2E;text-decoration:underline;">رابط</a>` }
                  : '—'],
              ])}
              ${committeeNames.length ? `
              <div style="margin-bottom:18px;">
                <div style="font-size:13px;font-weight:700;color:#0e3a1c;margin-bottom:8px;">اللجان المهتمة بها</div>
                <div>
                  ${committeeNames.map(name => `<span style="display:inline-block;background-color:#e8f5e9;color:#0e3a1c;font-size:12px;padding:4px 10px;border-radius:50px;margin:0 0 4px 4px;">${esc(name)}</span>`).join(' ')}
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

              <!-- CTA button (bulletproof: table-wrapped <a> with bgcolor) -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:24px auto 0 auto;">
                <tr>
                  <td align="center" bgcolor="#1A5C2E" style="background-color:#1A5C2E;border-radius:10px;">
                    <a href="https://ssamau.com/admin.html#/admin/applications"
                       style="display:inline-block;padding:12px 28px;background-color:#1A5C2E;color:#ffffff !important;text-decoration:none;font-weight:700;font-size:14px;border-radius:10px;">
                      افتح في لوحة الإدارة
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" bgcolor="#f9fafb" style="background-color:#f9fafb;padding:14px 24px;border-top:1px solid #e5e7eb;border-bottom-left-radius:12px;border-bottom-right-radius:12px;font-size:11px;color:#9ca3af;line-height:1.6;">
              <span dir="rtl">رسالة آلية من نظام إدارة النادي — لا ترد عليها.</span><br/>
              <span dir="ltr">SSAM — Saudi Students Association in Melbourne</span>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>
</body>
</html>`;

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
// Outlook + Gmail + Apple Mail rendering quirks. role="presentation"
// tells assistive tech (and some clients) this is layout, not data.
//
// Hardened 2026-05-18: value cells are HTML-escaped by default so
// caller-supplied strings (member names, free-text answers, etc.) can't
// inject markup into the admin inbox. The CV row needs to inject a real
// `<a>` tag, so the row-shape now allows `{ html: string }` as an
// explicit opt-out for safe-by-construction HTML. Plain strings go
// through `esc()`; objects are passed through verbatim.
type SectionRow = [label: string, value: string | { html: string }];
function section(title: string, rows: Array<SectionRow>): string {
  return `
    <div style="margin-bottom:18px;border-bottom:1px solid #f0f0f0;padding-bottom:14px;">
      <div style="font-size:13px;font-weight:700;color:#0e3a1c;margin-bottom:10px;">${esc(title)}</div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:13px;">
        ${rows.map(([l, v]) => `
          <tr>
            <td style="color:#6b7280;padding:3px 0;width:140px;vertical-align:top;">${esc(l)}</td>
            <td style="color:#111827;padding:3px 0;vertical-align:top;">${typeof v === 'string' ? esc(v) : v.html}</td>
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
  requireAdmin(user);
  const id = body.id as string | undefined;
  const committee_id = body.committee_id as string | undefined;
  if (!committee_id) throw httpErr('err.required.committee_id', 400);
  const [row] = await sql`SELECT status FROM membership_applications WHERE application_id = ${id}` as Array<{ status: string }>;
  if (!row) throw httpErr('err.notfound.application', 404);
  if (row.status !== 'PendingTriage') {
    throw httpErr('err.business.cannot_triage_status', 409, { status: row.status });
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
  if (!row) throw httpErr('err.notfound.application', 404);
  requireAdminScope(user, row.assigned_committee_id);
  if (row.status !== 'AssignedToCommittee' && row.status !== 'InterviewRequested') {
    throw httpErr('err.business.cannot_request_interview_status', 409, { status: row.status });
  }
  await sql`
    UPDATE membership_applications SET
      status          = 'InterviewRequested',
      decision_reason = COALESCE(${note}, decision_reason)
    WHERE application_id = ${id}
  `;
  return { application_id: id };
};

// Accept: creates a members row tied to the assigned committee, then
// auto-fires a portal-signup invite to the new member's email
// (fire-and-forget — same pattern as notifyNewApplication).
//
// Per SSAM_Requirements_v1.1 §6: "عند القبول، يُنشأ حساب للعضو في
// النظام ويُضاف للجنة" — upon acceptance, an account is created for
// the member in the system and added to the committee. This handler
// implements that flow end-to-end:
//
//   1. INSERT the members row (already existed before Branch 4).
//   2. UPDATE the membership_applications row to status=Accepted
//      (already existed).
//   3. (NEW) Create a pending-signup public.users row with an email-
//      link signup_token.
//   4. (NEW) Email the new member an Arabic invite to /signup.html
//      so they can choose their own password and activate the account.
//
// Steps 3+4 are fire-and-forget. If the email fails (SMTP blip, no
// email on the application) the acceptance still succeeded — the
// admin can back-fill via the Members tab "Invite" button later.
const applicationsAccept: Handler = async (body, user) => {
  const id = body.id as string | undefined;
  const note = body.note as string | undefined;
  const [app] = await sql`
    SELECT * FROM membership_applications WHERE application_id = ${id}
  ` as Array<Record<string, unknown>>;
  if (!app) throw httpErr('err.notfound.application', 404);
  requireAdminScope(user, app.assigned_committee_id as string | null | undefined);
  if (app.status !== 'AssignedToCommittee' && app.status !== 'InterviewRequested') {
    throw httpErr('err.business.cannot_accept_status', 409, { status: String(app.status) });
  }
  if (!app.assigned_committee_id) {
    throw httpErr('err.business.app_needs_committee', 400);
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

  // Fire-and-forget auto-invite. The applicant's email comes straight
  // from their application (validated as non-null at submit time in
  // most cases — but we re-check here defensively). If they didn't
  // supply one, skip silently — the admin can use the "Invite by PIN"
  // back-fill path from the Members tab.
  if (app.email) {
    autoInviteAcceptedMember(
      memberId,
      String(app.email),
      String(displayName),
      app.assigned_committee_id as string,
    ).catch(err => {
      console.error('[applications.accept] auto-invite failed (acceptance still succeeded):', err);
    });
  } else {
    console.warn(`[applications.accept] member ${memberId} accepted without email — no auto-invite. Use Members tab "Invite by PIN" to back-fill.`);
  }

  return { application_id: id, member_id: memberId };
};

// Side-effect helper: stamp a pending-signup row + send the invite email
// to a freshly-accepted member. Caller has already INSERTed the
// members row, so we know there's no public.users conflict — a plain
// INSERT is safe (no UPSERT branching needed).
//
// Returns nothing visible — errors are caught by the .catch() in
// applications.accept and logged. We never want the auto-invite to
// roll back the acceptance.
async function autoInviteAcceptedMember(
  memberId: string,
  email: string,
  displayName: string,
  committeeId: string,
): Promise<void> {
  // Look up the committee name for the email body. If it's missing
  // (deleted between accept and invite, vanishingly rare), the email
  // just omits the "member of <committee>" line and ships fine.
  const [com] = await sql`
    SELECT committee_name FROM public.committees WHERE committee_id = ${committeeId}
  ` as Array<{ committee_name: string | null }>;

  const token = generateInviteToken();

  await sql`
    INSERT INTO public.users (
      username, member_id, access_level, password_hash,
      signup_token, signup_token_expires_at
    ) VALUES (
      ${'mbr_' + memberId.toLowerCase()},
      ${memberId},
      'member',
      NULL,
      ${token},
      NOW() + INTERVAL '7 days'
    )
  `;

  const html = composeInviteEmail({
    displayName,
    committeeName: com?.committee_name ?? null,
    signupLink: `https://ssamau.com/signup.html?token=${token}`,
  });
  await sendEmail({
    to: email,
    subject: 'دعوة للانضمام إلى لوحة الأعضاء — SSAM',
    html,
  });
}

const applicationsReject: Handler = async (body, user) => {
  const id = body.id as string | undefined;
  const reason = body.reason as string | undefined;
  const [app] = await sql`SELECT status, assigned_committee_id FROM membership_applications WHERE application_id = ${id}` as Array<{
    status: string; assigned_committee_id: string | null;
  }>;
  if (!app) throw httpErr('err.notfound.application', 404);
  // Heads can reject only within their committee's scope, but only after
  // triage. Presidency (admin) + dev (superadmin) can reject anything
  // (including PendingTriage) for obvious-spam cases.
  //
  // Bug fix (2026-05-17): the previous `!== 'superadmin'` check
  // accidentally blocked admin (presidency) — only the dev could
  // reject applications. The comment said "presidency can reject
  // anything" but the code didn't match.
  if (user!.access === 'head') {
    if (!app.assigned_committee_id) throw httpErr('err.business.app_not_triaged', 409);
    requireAdminScope(user, app.assigned_committee_id);
  } else if (user!.access !== 'admin' && user!.access !== 'superadmin') {
    throw httpErr('err.access.forbidden', 403);
  }
  if (app.status === 'Accepted' || app.status === 'Rejected') {
    throw httpErr('err.business.app_already_status', 409, { status: app.status });
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

// Admin path for the seasonal volunteer-only intake. From Jun 1 the
// public form only accepts Volunteer applications; the admin still
// wants to be able to convert a promising volunteer into a Member.
//
// This is a parallel to applications.accept but: (a) only operates on
// rows where applicant_type='Volunteer'; (b) takes a committee_id from
// the body instead of relying on assigned_committee_id (volunteer
// applications don't always go through the committee-assignment step);
// (c) flips applicant_type → 'Member' on the application row so the
// audit log shows the conversion happened. Same auto-invite tail as
// accept.
const applicationsInviteAsMember: Handler = async (body, user) => {
  const id            = body.id as string | undefined;
  const committee_id  = body.committee_id as string | undefined;
  const note          = body.note as string | undefined;
  if (!id)           throw httpErr('err.required.id', 400);
  if (!committee_id) throw httpErr('err.required.committee_id', 400);
  requireAdminScope(user, committee_id);

  const [app] = await sql`
    SELECT * FROM membership_applications WHERE application_id = ${id}
  ` as Array<Record<string, unknown>>;
  if (!app) throw httpErr('err.notfound.application', 404);
  if (app.applicant_type !== 'Volunteer') {
    throw httpErr('err.business.invite_only_volunteer', 409);
  }
  if (app.status === 'Accepted' || app.created_member_id) {
    throw httpErr('err.business.application_already_accepted', 409);
  }

  const memberId    = shortId('MBR');
  const displayName = app.name_ar || app.full_name;
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
       ${committee_id}, 'Member', 'Active', CURRENT_DATE,
       ${app.national_id || null})
  `;
  await sql`
    UPDATE membership_applications SET
      applicant_type        = 'Member',
      assigned_committee_id = ${committee_id},
      status                = 'Accepted',
      decided_by_user_id    = ${user!.id},
      decided_at            = NOW(),
      decision_reason       = COALESCE(${note}, decision_reason),
      created_member_id     = ${memberId}
    WHERE application_id = ${id}
  `;

  if (app.email) {
    autoInviteAcceptedMember(
      memberId,
      String(app.email),
      String(displayName),
      committee_id,
    ).catch(err => {
      console.error('[applications.inviteAsMember] auto-invite failed (conversion still succeeded):', err);
    });
  } else {
    console.warn(`[applications.inviteAsMember] member ${memberId} created without email — no auto-invite. Use Members tab "Invite by PIN".`);
  }

  return { application_id: id, member_id: memberId };
};

export const applicationsActions: Record<string, Handler> = {
  'applications.submit':           applicationsSubmit,
  'applications.list':             applicationsList,
  'applications.assignCommittee':  applicationsAssignCommittee,
  'applications.requestInterview': applicationsRequestInterview,
  'applications.accept':           applicationsAccept,
  'applications.reject':           applicationsReject,
  'applications.inviteAsMember':   applicationsInviteAsMember,
};
