// Demo-data seeder for PDF guide screenshots.
//
// Idempotent: re-running the script picks up where it left off. Each
// step checks "does this already exist?" before creating, so you can
// safely run it after partial failures or to verify state.
//
// What it creates:
//   - 1 demo committee ("لجنة تجريبية")
//   - 6 demo members (admin, head, vice, member×2, volunteer) with
//     consistent "تجريبي ..." names + obviously-fake NIDs
//   - 6 portal accounts (demo_admin, demo_head, demo_vicehead,
//     demo_member, demo_member2, demo_volunteer) all sharing
//     DEMO_PASSWORD
//   - 2 demo projects (one upcoming, one past)
//   - 2 demo opportunities (one multi-role, one single-role)
//   - 1 interest registration (demo_member on the upcoming opp)
//   - 1 assignment + Attended + FinalApproved hours row
//     (demo_member on the past opp)
//   - 1 issued certificate (demo_member on the past project)
//
// Usage:
//   ADMIN_AUTH_USERNAME=president \
//   ADMIN_AUTH_PASSWORD=<superadmin-pw> \
//   DEMO_PASSWORD=Demo2026! \
//   ADMIN_ENDPOINT=https://pfibxvwiulwiiuwerawe.supabase.co/functions/v1/api \
//   node db/seed-demo.js
//
// To reset: there's no `--reset` flag. If you need to start fresh,
// delete the demo entities manually in the admin UI (Committee →
// Members → Accounts → Projects → Opportunities). Cascading FKs will
// take down the dependent rows.

import { randomBytes } from 'node:crypto';

const ENDPOINT = process.env.ADMIN_ENDPOINT
  || 'http://localhost:8888/.netlify/functions/api';
const AUTH_USER = process.env.ADMIN_AUTH_USERNAME;
const AUTH_PW   = process.env.ADMIN_AUTH_PASSWORD;
const DEMO_PW   = process.env.DEMO_PASSWORD || 'Demo' + randomBytes(4).toString('base64url');

// Supabase project anon key — same value the frontend sends in every
// request's `apikey` header. Public + safe to commit (it identifies
// the project, not the user). Required when the endpoint points at
// the Supabase Edge Function gateway; the legacy Netlify endpoint
// ignores it. Mirrors assets/js/lib/api.js's SUPABASE_ANON_KEY.
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmaWJ4dndpdWx3aWl1d2VyYXdlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg1ODI2NzEsImV4cCI6MjA5NDE1ODY3MX0.A0_w-iQQK-ozDiRWBS62ho_THvxEhzHWO-zgBcvfk78';

if (!AUTH_USER || !AUTH_PW) {
  console.error('Required env vars:');
  console.error('  ADMIN_AUTH_USERNAME      — existing superadmin / admin username');
  console.error('  ADMIN_AUTH_PASSWORD      — its password');
  console.error('Optional:');
  console.error('  DEMO_PASSWORD            — shared password for all demo accounts (default: random)');
  console.error('  ADMIN_ENDPOINT           — API URL (default: localhost:8888 dev)');
  process.exit(1);
}

// ─── HTTP helpers ──────────────────────────────────────────────────

let _token = null;

async function call(action, body = {}) {
  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Supabase's Edge Function gateway requires the project's anon
      // key on every request — same header the frontend sends. The
      // Edge Function reads `apikey` to verify the project; our
      // own `Bearer <token>` Authorization carries the real auth.
      'apikey':       SUPABASE_ANON_KEY,
      ...(_token ? { Authorization: `Bearer ${_token}` } : { Authorization: `Bearer ${SUPABASE_ANON_KEY}` }),
    },
    body: JSON.stringify({ action, ...body }),
  });
  const json = await resp.json().catch(() => null);
  if (!json?.success) {
    const msg = json?.error || `HTTP ${resp.status} ${resp.statusText}`;
    throw new Error(`${action} failed: ${msg}`);
  }
  return json.data;
}

// Two auth paths exist in production:
//   - Legacy: bcrypt hash in public.users.password_hash. Used by
//     accounts created via users.create (the demo accounts this
//     script makes). Issued via the `auth` action → returns our own
//     HS256 JWT.
//   - Supabase: auth.users row keyed by email. Modern accounts
//     (including the dev superadmin) sit here. Issued via
//     POST /auth/v1/token?grant_type=password → returns a Supabase
//     access_token JWT (which the Edge Function also accepts).
//
// We hit auth.resolveIdentifier first to find out which path the
// account is on, then route accordingly. Username OR email OR NID
// works as the lookup key — same as the public login form.
async function loginAs(identifier, password) {
  _token = null;
  // Temporarily attach anon key as Bearer so the Edge Function gateway
  // accepts the unauth'd lookup request.
  const probe = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey':        SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ action: 'auth.resolveIdentifier', identifier }),
  });
  const probeJson = await probe.json().catch(() => null);
  if (!probeJson?.success || !probeJson.data?.found) {
    throw new Error(`account "${identifier}" not found`);
  }

  if (probeJson.data.auth_provider === 'supabase') {
    // Supabase Auth path — exchange email + password for an access token.
    const email = probeJson.data.email;
    const tokResp = await fetch(`${new URL(ENDPOINT).origin}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey':       SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ email, password }),
    });
    const tokJson = await tokResp.json().catch(() => null);
    if (!tokResp.ok || !tokJson?.access_token) {
      throw new Error(`supabase auth failed for ${email}: ${tokJson?.error_description || tokResp.statusText}`);
    }
    _token = tokJson.access_token;
    // Confirm we have admin scope via auth.whoami (also primes the
    // user shape the rest of the script asserts on).
    const me = await call('auth.whoami');
    return me.user || me;
  }

  // Legacy path — `auth` action returns its own JWT keyed off
  // public.users + bcrypt.
  const data = await call('auth', { username: probeJson.data.username || identifier, password });
  _token = data.token;
  return data.user;
}

// ─── Step runner ───────────────────────────────────────────────────

let _step = 0;
async function step(label, fn) {
  _step++;
  process.stdout.write(`[${String(_step).padStart(2, '0')}] ${label}... `);
  try {
    const result = await fn();
    console.log(result?.skipped ? '↺ skipped' : '✓');
    return result;
  } catch (err) {
    console.log('✗');
    console.error('     ' + err.message);
    process.exit(1);
  }
}

// ─── Seed plan ─────────────────────────────────────────────────────

const DEMO_COMMITTEE_NAME    = 'لجنة تجريبية';
const DEMO_COMMITTEE_NAME_EN = 'Demo Committee';

const DEMO_MEMBERS = [
  { key: 'admin',     full_name: 'تجريبي مدير',   national_id: '1000000001',
    email: 'demo+admin@ssamau.com',     phone: '+966500000001', gender: 'ذكر',
    club_role: 'Vice President',        in_committee: false },
  { key: 'head',      full_name: 'تجريبي رئيس',   national_id: '1000000002',
    email: 'demo+head@ssamau.com',      phone: '+966500000002', gender: 'ذكر',
    club_role: 'Committee Head',        in_committee: true  },
  { key: 'vicehead',  full_name: 'تجريبي نائب',   national_id: '1000000003',
    email: 'demo+vice@ssamau.com',      phone: '+966500000003', gender: 'ذكر',
    club_role: 'Committee Vice Head',   in_committee: true  },
  { key: 'member',    full_name: 'تجريبي عضو',    national_id: '1000000004',
    email: 'demo+member@ssamau.com',    phone: '+966500000004', gender: 'أنثى',
    club_role: 'Member',                in_committee: true  },
  { key: 'member2',   full_name: 'تجريبي عضو ٢',  national_id: '1000000005',
    email: 'demo+member2@ssamau.com',   phone: '+966500000005', gender: 'ذكر',
    club_role: 'Member',                in_committee: true  },
  { key: 'volunteer', full_name: 'تجريبي متطوع',  national_id: '1000000006',
    email: 'demo+volunteer@ssamau.com', phone: '+966500000006', gender: 'أنثى',
    club_role: 'Volunteer',             in_committee: false },
  // Uninvited member — sits in the demo committee with NO portal
  // account, so the head's Members tab shows the 📩 "send invite"
  // button on this row. Used by screenshot shot 24 (head-invite-modal).
  { key: 'uninvited', full_name: 'تجريبي مدعو',   national_id: '1000000007',
    email: 'demo+invitee@ssamau.com',   phone: '+966500000007', gender: 'ذكر',
    club_role: 'Member',                in_committee: true  },
];

const ACCESS_LEVELS = {
  admin:     'admin',
  head:      'head',
  vicehead:  'head',
  member:    'member',
  member2:   'member',
  volunteer: 'volunteer',
};

const DEMO_PROJECTS = [
  { key: 'upcoming', name: 'فعالية تجريبية — يوم العلم', date: nextYearMonth(0, 15),
    location: 'Melbourne CBD', project_type: 'Event' },
  { key: 'past',     name: 'ورشة تجريبية — مهارات تطوعية', date: lastMonthDate(),
    location: 'Online',         project_type: 'Project' },
];

function nextYearMonth(monthsAhead, day) {
  const d = new Date();
  d.setMonth(d.getMonth() + 3 + monthsAhead);
  d.setDate(day);
  return d.toISOString().slice(0, 10);
}
function lastMonthDate() {
  const d = new Date();
  d.setMonth(d.getMonth() - 2);
  d.setDate(10);
  return d.toISOString().slice(0, 10);
}

// ─── Main ──────────────────────────────────────────────────────────

console.log(`[seed-demo] target: ${ENDPOINT}`);
console.log(`[seed-demo] auth:   ${AUTH_USER}`);
console.log(`[seed-demo] demo pw: ${DEMO_PW}\n`);

await step(`Authenticate as ${AUTH_USER}`, async () => {
  const user = await loginAs(AUTH_USER, AUTH_PW);
  if (!['superadmin', 'admin'].includes(user.access)) {
    throw new Error(`auth user is ${user.access}, needs admin or superadmin`);
  }
});

// ─── Committee ─────────────────────────────────────────────────────

let committeeId;
await step(`Demo committee "${DEMO_COMMITTEE_NAME}"`, async () => {
  const committees = await call('getCommittees');
  const found = (committees || []).find(c =>
    c.committee_name === DEMO_COMMITTEE_NAME ||
    c.committee_name_en === DEMO_COMMITTEE_NAME_EN
  );
  if (found) {
    committeeId = found.committee_id;
    return { skipped: true };
  }
  const res = await call('createCommittee', {
    committee_name:    DEMO_COMMITTEE_NAME,
    committee_name_en: DEMO_COMMITTEE_NAME_EN,
    description:       'للتوثيق فقط — لا تنشر بيانات حقيقية هنا',
  });
  committeeId = res.committee_id;
});

// ─── Members ───────────────────────────────────────────────────────

const memberIdByKey = {};
for (const spec of DEMO_MEMBERS) {
  await step(`Member: ${spec.full_name}`, async () => {
    const all = await call('getMembers');
    const found = (all || []).find(m => m.national_id === spec.national_id);
    if (found) {
      memberIdByKey[spec.key] = found.member_id;
      return { skipped: true };
    }
    const res = await call('createMember', {
      data: {
        full_name:     spec.full_name,
        national_id:   spec.national_id,
        email:         spec.email,
        phone:         spec.phone,
        gender:        spec.gender,
        date_of_birth: '2000-01-01',
        committee_id:  spec.in_committee ? committeeId : null,
        club_role:     spec.club_role,
        status:        'Active',
        join_date:     new Date().toISOString().slice(0, 10),
      },
    });
    memberIdByKey[spec.key] = res.member_id;
  });
}

// ─── Wire head + vice into the committee ───────────────────────────

await step('Committee head + vice assignment', async () => {
  const committees = await call('getCommittees');
  const com = (committees || []).find(c => c.committee_id === committeeId);
  if (!com) throw new Error('committee not found after create');
  if (com.committee_head_member_id === memberIdByKey.head
   && com.committee_vice_head_member_id === memberIdByKey.vicehead) {
    return { skipped: true };
  }
  await call('updateCommittee', {
    id: committeeId,
    data: {
      committee_name:                DEMO_COMMITTEE_NAME,
      committee_head_member_id:      memberIdByKey.head,
      committee_vice_head_member_id: memberIdByKey.vicehead,
    },
  });
});

// ─── Accounts ──────────────────────────────────────────────────────

const ACCOUNT_USERNAMES = {
  admin:     'demo_admin',
  head:      'demo_head',
  vicehead:  'demo_vicehead',
  member:    'demo_member',
  member2:   'demo_member2',
  volunteer: 'demo_volunteer',
};

for (const key of Object.keys(ACCOUNT_USERNAMES)) {
  const username = ACCOUNT_USERNAMES[key];
  await step(`Account: ${username}`, async () => {
    const accounts = await call('users.list');
    const found = (accounts || []).find(a => a.username === username);
    if (found) return { skipped: true };
    await call('users.create', {
      username,
      password:     DEMO_PW,
      member_id:    memberIdByKey[key],
      access_level: ACCESS_LEVELS[key],
    });
  });
}

// ─── Projects ──────────────────────────────────────────────────────

const projectIdByKey = {};
for (const spec of DEMO_PROJECTS) {
  await step(`Project: ${spec.name}`, async () => {
    const projects = await call('getProjects');
    const found = (projects || []).find(p => p.project_name === spec.name);
    if (found) {
      projectIdByKey[spec.key] = found.project_id;
      return { skipped: true };
    }
    const res = await call('createProject', {
      data: {
        project_name:        spec.name,
        project_type:        spec.project_type,
        event_date:          spec.date,
        location:            spec.location,
        owning_committee_id: committeeId,
        status:              'Active',
      },
    });
    projectIdByKey[spec.key] = res.project_id;
  });
}

// ─── Opportunities ─────────────────────────────────────────────────

const opportunityIdByKey = {};
await step('Opportunity (multi-role, upcoming): يوم العلم', async () => {
  const opps = await call('opportunities.list', { project_id: projectIdByKey.upcoming });
  if ((opps || []).length) {
    opportunityIdByKey.upcoming = opps[0].opportunity_id;
    return { skipped: true };
  }
  const res = await call('opportunities.create', {
    data: {
      project_id:          projectIdByKey.upcoming,
      role_name:           'منسق استقبال',
      role_key:            null,
      estimated_hours:     3,
      headcount_needed:    2,
      owning_committee_id: null,  // open to all
      status:              'Open',
      notes:               null,
      roles: [
        { role_name: 'منسق استقبال', estimated_hours: 3, headcount_needed: 2 },
        { role_name: 'مصوّر',         estimated_hours: 4, headcount_needed: 1 },
      ],
    },
  });
  opportunityIdByKey.upcoming = res.opportunity_id;
});

await step('Opportunity (single-role, past): ورشة', async () => {
  const opps = await call('opportunities.list', { project_id: projectIdByKey.past });
  if ((opps || []).length) {
    opportunityIdByKey.past = opps[0].opportunity_id;
    return { skipped: true };
  }
  const res = await call('opportunities.create', {
    data: {
      project_id:          projectIdByKey.past,
      role_name:           'منسق تسجيل',
      role_key:            null,
      estimated_hours:     2,
      headcount_needed:    1,
      owning_committee_id: committeeId,
      status:              'Done',
      notes:               null,
      roles: [
        { role_name: 'منسق تسجيل', estimated_hours: 2, headcount_needed: 1 },
      ],
    },
  });
  opportunityIdByKey.past = res.opportunity_id;
});

// ─── Interest registration (from demo_member's perspective) ────────
//
// interest.submit reads member_id from the auth context, so we have
// to log in as demo_member to record interest on their behalf.

await step('Interest: demo_member on upcoming opp', async () => {
  const oppId = opportunityIdByKey.upcoming;
  // Capture the picked role so we can pass role_id to interest.submit.
  const opps = await call('opportunities.list', { project_id: projectIdByKey.upcoming });
  const opp = opps[0];
  const greeterRole = (opp.roles || []).find(r => r.role_name === 'منسق استقبال') || opp.roles?.[0];
  await loginAs('demo_member', DEMO_PW);
  // Check if this member already has an interest on this opp.
  const myInterest = await call('interest.listOwn');
  if ((myInterest || []).some(i => i.opportunity_id === oppId && i.interested)) {
    // Switch back to admin before returning so subsequent steps work.
    await loginAs(AUTH_USER, AUTH_PW);
    return { skipped: true };
  }
  await call('interest.submit', {
    data: {
      project_id:     projectIdByKey.upcoming,
      opportunity_id: oppId,
      role_id:        greeterRole?.id || null,
      interested:     true,
      comment:        'أحب التواصل مع الناس وعندي خبرة في تنظيم الفعاليات الجامعية، وأقدر أساعد قبل وأثناء الفعالية.',
    },
  });
  // Switch back to superadmin for the remaining steps.
  await loginAs(AUTH_USER, AUTH_PW);
});

// ─── Assignment + attendance + hours on the past opportunity ───────

let assignmentId;
await step('Assign demo_member to past opp', async () => {
  const assignments = await call('assignments.list', { opportunity_id: opportunityIdByKey.past });
  const found = (assignments || []).find(a => a.member_id === memberIdByKey.member);
  if (found) {
    assignmentId = found.assignment_id;
    return { skipped: true };
  }
  const res = await call('assignments.add', {
    data: {
      opportunity_id: opportunityIdByKey.past,
      member_id:      memberIdByKey.member,
    },
  });
  assignmentId = res.assignment_id;
});

await step('Mark attendance = Attended', async () => {
  // markAttendance with status Attended auto-creates a FinalApproved
  // hours row keyed to the assignment if hours_override is supplied.
  // Use the opp's estimated_hours so the row looks realistic.
  await call('assignments.markAttendance', {
    data: {
      assignment_id:     assignmentId,
      attendance_status: 'Attended',
      hours_override:    2,
    },
  });
});

// Second assignment — on the UPCOMING opp, Attended but WITHOUT
// auto-hours. This is what the member-portal log-hours screenshot
// needs: an Attended assignment that hasn't had its hours logged
// yet, so the "تسجيل ساعات" button appears.
let pendingAssignmentId;
await step('Assign demo_member to upcoming opp (no auto-hours)', async () => {
  const assignments = await call('assignments.list', { opportunity_id: opportunityIdByKey.upcoming });
  const found = (assignments || []).find(a => a.member_id === memberIdByKey.member);
  if (found) {
    pendingAssignmentId = found.assignment_id;
    return { skipped: true };
  }
  const res = await call('assignments.add', {
    data: {
      opportunity_id: opportunityIdByKey.upcoming,
      member_id:      memberIdByKey.member,
    },
  });
  pendingAssignmentId = res.assignment_id;
});

await step('Mark upcoming assignment Attended (no hours override)', async () => {
  // Omit hours_override entirely → no FinalApproved hours row auto-
  // created → member portal sees the "log hours" button on this row.
  await call('assignments.markAttendance', {
    data: {
      assignment_id:     pendingAssignmentId,
      attendance_status: 'Attended',
    },
  });
});

// ─── Demo application ──────────────────────────────────────────────
// The admin Applications tab is empty without an application to
// review. Submit one through the public `applications.submit` action
// (no auth needed — it's the same path the apply form uses) so the
// screenshot pass has a row to display. Marked with "تجريبي" so the
// privacy filter passes it through.

await step('Submit demo application', async () => {
  const all = await call('applications.list');
  // Idempotency check by NID — sequential demo NID slot.
  const existingDemo = (all || []).find(a => a.national_id === '1000000099');
  if (existingDemo) return { skipped: true };
  // applications.submit is in PUBLIC_ACTIONS so it doesn't need auth.
  // We still send it through the same `call()` helper since it carries
  // the apikey header.
  await call('applications.submit', {
    data: {
      name_ar:          'تجريبي متقدم',
      name_en:          'Demo Applicant',
      preferred_name:   'تجريبي',
      gender:           'ذكر',
      date_of_birth:    '2000-06-15',
      national_id:      '1000000099',
      email:            'demo+applicant@ssamau.com',
      phone:            '500000099',
      phone_country_code:    '+966',
      whatsapp:         '500000099',
      whatsapp_country_code: '+966',
      address_melbourne:'123 Demo St, Melbourne',
      scholarship_entity: 'companion_student',
      study_level:      'Bachelor',
      degree_field:     'Information Technology',
      university:       'deakin',
      study_started_window:       '>1y',
      expected_graduation_window: '2028+',
      skills_hobbies:   'تنظيم الفعاليات، تصوير، تطوير ويب — كل المهارات تجريبية لأغراض التوثيق فقط.',
      about_self:       'هذا تقديم تجريبي أُنشئ تلقائياً لأغراض توثيق دليل المستخدم. ليس مرشحاً حقيقياً.',
      referral_source:  'friend',
      interests:        [],
      applicant_type:   'Member',
      confirmation_accepted: true,
    },
  });
});

// ─── Certificate ───────────────────────────────────────────────────

await step('Issue cert for demo_member on past project', async () => {
  const certs = await call('certs.list', { project_id: projectIdByKey.past });
  const found = (certs || []).find(c => c.member_id === memberIdByKey.member);
  if (found) return { skipped: true };
  await call('certs.issue', {
    data: {
      project_id:      projectIdByKey.past,
      member_id:       memberIdByKey.member,
      recipient_name:  'تجريبي عضو',
      recipient_email: 'demo+member@ssamau.com',
      role:            'منسق تسجيل',
      hours:           2,
    },
  });
});

// ─── Done ──────────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════════════════════════');
console.log('Demo data ready. Login credentials for screenshot agent:');
console.log('═══════════════════════════════════════════════════════');
for (const [key, username] of Object.entries(ACCOUNT_USERNAMES)) {
  console.log(`  ${username.padEnd(16)} → ${ACCESS_LEVELS[key]} access`);
}
console.log(`\nShared password: ${DEMO_PW}`);
console.log('\nNext step: paste docs/pdf-guides-prep.md Part 3 (the');
console.log('Chrome-agent prompt) into your screenshot agent. Substitute');
console.log('<PRODUCTION_URL> + <DEMO_PASSWORD> before sending.');
