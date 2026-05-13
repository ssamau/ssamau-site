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
  return { application_id: id };
};

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
