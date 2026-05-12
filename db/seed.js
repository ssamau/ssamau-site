// Full-system seeder. Reads the leadership-supplied xlsx
// (../بيانات اللجان.xlsx), normalises it via _normalise-xlsx.js, and posts
// the result to setup.bulkSeed. The server creates:
//   • the committees that actually appear in the data
//   • every member with full profile (NID, dual phones, study, etc.)
//   • committee head/vice-head FKs
//   • a user account for every leadership row (NID or email as username,
//     temp password generated)
//   • optionally, a dev/maintainer superadmin account that's NOT tied to
//     a member row (use this for tech support — Faisal's "faisal-admin")
//
// Usage:
//   netlify dev                                                       # in terminal 1
//   netlify db migrations apply                                       # ensure schema is up
//   DEV_ADMIN_USERNAME=faisal-admin npm run seed                      # in terminal 2
//
// Optional env vars:
//   SEED_ENDPOINT       — target API URL (defaults to localhost dev)
//   DEV_ADMIN_USERNAME  — also create a dev superadmin with this username
//   DEV_ADMIN_PASSWORD  — explicit password for the dev admin; otherwise generated
//   SEED_FORCE=1        — re-seed an already-populated DB (refuses otherwise)
//
// One-stop for prod deploys:
//   SEED_ENDPOINT='https://ssamau.netlify.app/.netlify/functions/api' \
//   DEV_ADMIN_USERNAME=faisal-admin \
//   npm run seed
//
// Copy the password table that prints at the end — temp passwords are bcrypted
// in the DB and unrecoverable.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readXlsx, normaliseRows } from './_normalise-xlsx.js';

const here = dirname(fileURLToPath(import.meta.url));
const XLSX_PATH = resolve(here, '..', '..', 'بيانات اللجان.xlsx');
const ENDPOINT  = process.env.SEED_ENDPOINT || 'http://localhost:8888/.netlify/functions/api';
const DEV_USER  = process.env.DEV_ADMIN_USERNAME;
const DEV_PW    = process.env.DEV_ADMIN_PASSWORD;
const FORCE     = !!process.env.SEED_FORCE;

// ─── 1. Read + normalise ─────────────────────────────────────────────────────
console.log(`[seed] Reading xlsx: ${XLSX_PATH}`);
const { sheetName, rawRows } = readXlsx(XLSX_PATH);
const { rows, newCommittees, unmapped, skipped } = normaliseRows(rawRows);

console.log(`[seed] Sheet "${sheetName}": ${rawRows.length} raw, ${rows.length} importable, ${skipped.length} skipped`);
console.log(`[seed] Committees to create (${newCommittees.length}): ${newCommittees.join(', ')}`);
if (unmapped.committees.length) {
  console.warn(`[seed] ⚠️  Unmapped committee names will be silently skipped: ${unmapped.committees.join(', ')}`);
}
if (unmapped.phone_issues.length) {
  console.warn(`[seed] ⚠️  ${unmapped.phone_issues.length} phone(s) had no recognisable country code (still imported, just without cc)`);
}

// ─── 2. POST ──────────────────────────────────────────────────────────────────
const payload = {
  action:     'setup.bulkSeed',
  committees: newCommittees,
  rows,
  force:      FORCE,
};
if (DEV_USER) {
  payload.dev_admin = { username: DEV_USER };
  if (DEV_PW) payload.dev_admin.password = DEV_PW;
}

console.log(`[seed] POSTing to ${ENDPOINT}${FORCE ? ' (FORCE)' : ''}${DEV_USER ? ` (+dev_admin "${DEV_USER}")` : ''}…`);
let resp;
try {
  resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
} catch (e) {
  console.error(`[seed] Could not reach ${ENDPOINT}. Is netlify dev running?`);
  console.error(e.message);
  process.exit(1);
}
const json = await resp.json();
if (!resp.ok || !json.success) {
  console.error(`[seed] Server returned ${resp.status}: ${json.error || JSON.stringify(json)}`);
  process.exit(1);
}

// ─── 3. Report ────────────────────────────────────────────────────────────────
const s = json.data;
console.log('');
console.log('═══════════════════════════════════════════════════════════════════════');
console.log('  Seed complete');
console.log('═══════════════════════════════════════════════════════════════════════');
console.log(`  Committees created:  ${s.created_committees.length}`);
for (const c of s.created_committees) console.log(`    + ${c.committee_id}  ${c.committee_name}`);
console.log('');
console.log(`  Members inserted:    ${s.members_inserted}`);
console.log(`  Committee head/vice FKs assigned: ${s.heads_assigned}`);
console.log('');
console.log('  ╔══════════════════════════════════════════════════════════════════════');
console.log('  ║ TEMP PASSWORDS — copy now, these are not stored recoverably');
console.log('  ╚══════════════════════════════════════════════════════════════════════');
console.log(`    ${pad('username', 22)} ${pad('access', 11)} ${pad('password', 12)} name`);
console.log(`    ${'─'.repeat(22)} ${'─'.repeat(11)} ${'─'.repeat(12)} ${'─'.repeat(40)}`);
for (const a of s.accounts) {
  console.log(`    ${pad(a.username, 22)} ${pad(a.access, 11)} ${pad(a.temp_password, 12)} ${a.name}`);
}
console.log('');
console.log('  Distribute the passwords through a secure channel (WhatsApp is fine).');
console.log('  Users should change their passwords on first login.');

function pad(s, n) { return String(s ?? '').padEnd(n); }
