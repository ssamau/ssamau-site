// Demo-data wiper — surgical removal of the entities seeded by
// db/seed-demo.js. Run BEFORE phase 2 opens to real members so they
// don't see "تجريبي" rows in opportunities, members, etc.
//
// Safety model:
//   - Marker-scoped — every delete is gated on a hardcoded demo marker
//     (committee name "لجنة تجريبية", NIDs 1000000001..1000000099,
//     username prefix `demo_`). The script CANNOT touch a real entity
//     that lacks these markers.
//   - Fails closed — if an unexpected count comes back at any step
//     (e.g. >10 "demo" members), the script aborts before deleting.
//   - Same auth as seed-demo.js (Supabase Auth for faisal-admin).
//
// What it deletes (in FK-respecting order):
//   1. assignments where opportunity ∈ demo opps
//   2. opportunities where project ∈ demo projects
//   3. projects where owning_committee = demo committee
//   4. users where username LIKE 'demo_%' (cascades to auth.users)
//   5. members where national_id IN (demo NIDs)
//   6. committee "لجنة تجريبية"
//
// Skipped (no public API delete — handle manually if needed):
//   - applications with NID 1000000099 (admin UI doesn't expose
//     delete; can be removed from Supabase dashboard)
//   - hours, attendance, interest_requests, certificates (rely on
//     DB-level CASCADE from the parent deletes above)
//
// Usage (identical env to seed-demo.js):
//   ADMIN_AUTH_USERNAME=faisal-admin \
//   ADMIN_AUTH_PASSWORD=<superadmin-pw> \
//   ADMIN_ENDPOINT=https://pfibxvwiulwiiuwerawe.supabase.co/functions/v1/api \
//   node db/wipe-demo.js

const ENDPOINT  = process.env.ADMIN_ENDPOINT
  || 'http://localhost:8888/.netlify/functions/api';
const AUTH_USER = process.env.ADMIN_AUTH_USERNAME;
const AUTH_PW   = process.env.ADMIN_AUTH_PASSWORD;

// Public anon key — same value the frontend sends in every request.
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmaWJ4dndpdWx3aWl1d2VyYXdlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg1ODI2NzEsImV4cCI6MjA5NDE1ODY3MX0.A0_w-iQQK-ozDiRWBS62ho_THvxEhzHWO-zgBcvfk78';

if (!AUTH_USER || !AUTH_PW) {
  console.error('Required env vars: ADMIN_AUTH_USERNAME + ADMIN_AUTH_PASSWORD');
  process.exit(1);
}

// ─── Demo markers — the ONLY entities this script may touch ──────────
const DEMO_COMMITTEE_NAME    = 'لجنة تجريبية';
const DEMO_COMMITTEE_NAME_EN = 'Demo Committee';
const DEMO_MEMBER_NIDS = [
  '1000000001', '1000000002', '1000000003', '1000000004',
  '1000000005', '1000000006', '1000000007',
];
const DEMO_USERNAME_PREFIX = 'demo_';
// Caps to fail-closed if we ever see more demo-marked rows than the
// seed script could plausibly have created. Adjust ONLY if you know
// you've intentionally added more demo entities.
const MAX_EXPECTED = {
  members:       10,
  users:         10,
  projects:      4,
  opportunities: 6,
  assignments:   8,
};

// ─── HTTP helpers ────────────────────────────────────────────────────
let _token = null;

async function call(action, body = {}) {
  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_ANON_KEY,
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

async function loginAs(identifier, password) {
  _token = null;
  const probe = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
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
    const email = probeJson.data.email;
    const tokResp = await fetch(`${new URL(ENDPOINT).origin}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
      body: JSON.stringify({ email, password }),
    });
    const tokJson = await tokResp.json().catch(() => null);
    if (!tokResp.ok || !tokJson?.access_token) {
      throw new Error(`supabase auth failed: ${tokJson?.error_description || tokResp.statusText}`);
    }
    _token = tokJson.access_token;
    const me = await call('auth.whoami');
    return me.user || me;
  }
  const data = await call('auth', { username: probeJson.data.username || identifier, password });
  _token = data.token;
  return data.user;
}

let _step = 0;
async function step(label, fn) {
  _step++;
  process.stdout.write(`[${String(_step).padStart(2, '0')}] ${label}... `);
  try {
    const result = await fn();
    console.log(result?.skipped ? '↺ skipped' : `✓ ${result?.note || ''}`);
    return result;
  } catch (err) {
    console.log('✗');
    console.error('     ' + err.message);
    process.exit(1);
  }
}

// ─── Plan ────────────────────────────────────────────────────────────
console.log(`[wipe-demo] target: ${ENDPOINT}`);
console.log(`[wipe-demo] auth:   ${AUTH_USER}\n`);

await step(`Authenticate as ${AUTH_USER}`, async () => {
  const user = await loginAs(AUTH_USER, AUTH_PW);
  if (!['superadmin', 'admin'].includes(user.access)) {
    throw new Error(`auth user is ${user.access}, needs admin or superadmin`);
  }
});

// ─── 1. Locate the demo committee ────────────────────────────────────
let committeeId = null;
await step(`Locate committee "${DEMO_COMMITTEE_NAME}"`, async () => {
  const all = await call('getCommittees');
  const found = (all || []).find(c =>
    c.committee_name === DEMO_COMMITTEE_NAME ||
    c.committee_name_en === DEMO_COMMITTEE_NAME_EN
  );
  if (!found) return { skipped: true, note: '(no demo committee — nothing to do)' };
  committeeId = found.committee_id;
  return { note: committeeId };
});
if (!committeeId) {
  console.log('\nNo demo committee found. Already clean.');
  process.exit(0);
}

// ─── 2. Find demo projects (by owning_committee) ─────────────────────
let demoProjectIds = [];
await step('Find demo projects', async () => {
  const all = await call('getProjects');
  const mine = (all || []).filter(p => p.owning_committee_id === committeeId);
  if (mine.length > MAX_EXPECTED.projects) {
    throw new Error(`got ${mine.length} demo projects, max expected ${MAX_EXPECTED.projects} — refusing to delete`);
  }
  demoProjectIds = mine.map(p => p.project_id);
  return { note: `${demoProjectIds.length} found` };
});

// ─── 3. Find demo opportunities (by project_id) ──────────────────────
let demoOppIds = [];
await step('Find demo opportunities', async () => {
  // opportunities.list returns ALL opps; filter to demo project IDs.
  const all = await call('opportunities.list');
  const mine = (all || []).filter(o => demoProjectIds.includes(o.project_id));
  if (mine.length > MAX_EXPECTED.opportunities) {
    throw new Error(`got ${mine.length} demo opps, max expected ${MAX_EXPECTED.opportunities} — refusing to delete`);
  }
  demoOppIds = mine.map(o => o.opportunity_id);
  return { note: `${demoOppIds.length} found` };
});

// ─── 4. Delete assignments on demo opportunities ─────────────────────
await step('Remove demo assignments', async () => {
  let total = 0;
  for (const oppId of demoOppIds) {
    const rows = await call('assignments.list', { opportunity_id: oppId });
    if ((rows || []).length > MAX_EXPECTED.assignments) {
      throw new Error(`opp ${oppId}: ${rows.length} assignments, max expected ${MAX_EXPECTED.assignments}`);
    }
    for (const a of (rows || [])) {
      await call('assignments.remove', { id: a.assignment_id });
      total++;
    }
  }
  return { note: `${total} deleted` };
});

// ─── 5. Delete opportunities ─────────────────────────────────────────
await step('Delete demo opportunities', async () => {
  for (const id of demoOppIds) {
    await call('opportunities.delete', { id });
  }
  return { note: `${demoOppIds.length} deleted` };
});

// ─── 6. Delete projects ──────────────────────────────────────────────
await step('Delete demo projects', async () => {
  for (const id of demoProjectIds) {
    await call('deleteProject', { id });
  }
  return { note: `${demoProjectIds.length} deleted` };
});

// ─── 7. Delete users (by username prefix) ────────────────────────────
await step('Delete demo users', async () => {
  const all = await call('users.list');
  const mine = (all || []).filter(u => u.username && u.username.startsWith(DEMO_USERNAME_PREFIX));
  if (mine.length > MAX_EXPECTED.users) {
    throw new Error(`got ${mine.length} demo users, max expected ${MAX_EXPECTED.users}`);
  }
  for (const u of mine) {
    await call('users.delete', { id: u.id });
  }
  return { note: `${mine.length} deleted` };
});

// ─── 8. Delete members (by NID) ──────────────────────────────────────
await step('Delete demo members', async () => {
  const all = await call('getMembers');
  const mine = (all || []).filter(m => DEMO_MEMBER_NIDS.includes(String(m.national_id)));
  if (mine.length > MAX_EXPECTED.members) {
    throw new Error(`got ${mine.length} demo members, max expected ${MAX_EXPECTED.members}`);
  }
  for (const m of mine) {
    // Defense in depth — verify the row is on the demo committee
    // (or no committee). A demo NID on a real committee would be
    // suspicious and we'd refuse.
    if (m.committee_id && m.committee_id !== committeeId) {
      throw new Error(`member ${m.national_id} sits on a non-demo committee — refusing`);
    }
    await call('deleteMember', { id: m.member_id });
  }
  return { note: `${mine.length} deleted` };
});

// ─── 9. Delete the committee ─────────────────────────────────────────
await step(`Delete committee "${DEMO_COMMITTEE_NAME}"`, async () => {
  await call('deleteCommittee', { id: committeeId });
  return { note: committeeId };
});

console.log('\n✓ Demo data wiped.\n');
console.log('Note: the demo application (NID 1000000099) is not deleted via this script — no public API exists.');
console.log('      Remove it from the Supabase dashboard (applications table) if it bothers you.');
