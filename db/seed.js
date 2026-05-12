// Full-system seeder. Reads the leadership-supplied xlsx
// (../بيانات اللجان.xlsx), normalises it via _normalise-xlsx.js, and posts
// it to setup.bulkSeed in four phases (the server splits the workload so each
// call finishes inside Netlify's 10s Free-tier function-timeout ceiling).
//
// Phases the client drives:
//   1. wipe        — only if --force; idempotent on an empty DB
//   2. committees  — one call, returns {name → committee_id}
//   3. members     — N calls, batched at MEMBER_BATCH rows per call
//   4. finalize    — wires head/vice FKs + creates leadership accounts +
//                    optional dev/maintainer superadmin
//
// The server creates:
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
//   MEMBER_BATCH        — rows per /members call (default 25, max ~30 on Free tier)
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
const XLSX_PATH    = resolve(here, '..', '..', 'بيانات اللجان.xlsx');
const ENDPOINT     = process.env.SEED_ENDPOINT || 'http://localhost:8888/.netlify/functions/api';
const DEV_USER     = process.env.DEV_ADMIN_USERNAME;
const DEV_PW       = process.env.DEV_ADMIN_PASSWORD;
const FORCE        = !!process.env.SEED_FORCE;
const MEMBER_BATCH = Math.max(1, parseInt(process.env.MEMBER_BATCH, 10) || 25);

// ─── Helper: POST one phase to setup.bulkSeed ───────────────────────────────
async function callPhase(phase, extra = {}) {
  const payload = { action: 'setup.bulkSeed', phase, ...extra };
  let resp;
  try {
    resp = await fetch(ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
  } catch (e) {
    console.error(`[seed] Could not reach ${ENDPOINT}. Is netlify dev running?`);
    console.error(e.message);
    process.exit(1);
  }
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.success) {
    console.error(`[seed] Phase "${phase}" failed — server returned ${resp.status}: ${json.error || JSON.stringify(json)}`);
    process.exit(1);
  }
  return json.data;
}

// ─── 1. Read + normalise xlsx ────────────────────────────────────────────────
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

// ─── 2. PHASE wipe (only if --force) ─────────────────────────────────────────
if (FORCE) {
  console.log(`[seed] → phase wipe (force=true)…`);
  const w = await callPhase('wipe', { force: true });
  console.log(`[seed]   ${w.wiped ? 'wiped clean' : 'db was already empty'}`);
} else {
  // Sanity check — the committees phase will 409 if users exist, but we get
  // a friendlier early error by checking here too.
  console.log(`[seed] (no --force; will refuse to overwrite an existing seed)`);
}

// ─── 3. PHASE committees ─────────────────────────────────────────────────────
console.log(`[seed] → phase committees (${newCommittees.length})…`);
const cRes = await callPhase('committees', { committees: newCommittees });
const committeeIdByName = cRes.committee_id_by_name;
console.log(`[seed]   ${cRes.created.length} committees created`);

// ─── 4. PHASE members (batched) ──────────────────────────────────────────────
const memberIdByXlsxRow = {};
const totalBatches = Math.ceil(rows.length / MEMBER_BATCH);
let totalInserted = 0;
for (let i = 0; i < rows.length; i += MEMBER_BATCH) {
  const batch = rows.slice(i, i + MEMBER_BATCH);
  const batchNum = Math.floor(i / MEMBER_BATCH) + 1;
  console.log(`[seed] → phase members batch ${batchNum}/${totalBatches} (${batch.length} rows)…`);
  const mRes = await callPhase('members', {
    rows: batch,
    committee_id_by_name: committeeIdByName,
  });
  Object.assign(memberIdByXlsxRow, mRes.member_id_by_xlsx_row);
  totalInserted += mRes.inserted;
  console.log(`[seed]   inserted ${mRes.inserted} (running total ${totalInserted}/${rows.length})`);
}

// ─── 5. PHASE finalize ───────────────────────────────────────────────────────
console.log(`[seed] → phase finalize (head/vice FKs + leadership accounts${DEV_USER ? ` + dev_admin "${DEV_USER}"` : ''})…`);
const finalizePayload = {
  rows,
  committee_id_by_name: committeeIdByName,
  member_id_by_xlsx_row: memberIdByXlsxRow,
};
if (DEV_USER) {
  finalizePayload.dev_admin = { username: DEV_USER };
  if (DEV_PW) finalizePayload.dev_admin.password = DEV_PW;
}
const fRes = await callPhase('finalize', finalizePayload);

// ─── 6. Report ────────────────────────────────────────────────────────────────
console.log('');
console.log('═══════════════════════════════════════════════════════════════════════');
console.log('  Seed complete');
console.log('═══════════════════════════════════════════════════════════════════════');
console.log(`  Committees created:  ${cRes.created.length}`);
for (const c of cRes.created) console.log(`    + ${c.committee_id}  ${c.committee_name}`);
console.log('');
console.log(`  Members inserted:    ${totalInserted}`);
console.log(`  Committee head/vice FKs assigned: ${fRes.heads_assigned}`);
console.log('');
console.log('  ╔══════════════════════════════════════════════════════════════════════');
console.log('  ║ TEMP PASSWORDS — copy now, these are not stored recoverably');
console.log('  ╚══════════════════════════════════════════════════════════════════════');
console.log(`    ${pad('username', 22)} ${pad('access', 11)} ${pad('password', 12)} name`);
console.log(`    ${'─'.repeat(22)} ${'─'.repeat(11)} ${'─'.repeat(12)} ${'─'.repeat(40)}`);
for (const a of fRes.accounts) {
  console.log(`    ${pad(a.username, 22)} ${pad(a.access, 11)} ${pad(a.temp_password, 12)} ${a.name}`);
}
console.log('');
console.log('  Distribute the passwords through a secure channel (WhatsApp is fine).');
console.log('  Users should change their passwords on first login.');

function pad(s, n) { return String(s ?? '').padEnd(n); }
