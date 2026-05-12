// Import client. Reads db/import-preview.json (produced by `npm run
// import:inspect`), authenticates as a superadmin, and POSTs the payload to
// the `setup.bulkImportMembers` action. Prints the server-side summary.
//
// Usage:
//   1. Make sure `netlify dev` is running and the schema is up to date:
//        netlify db migrations apply
//   2. Generate the preview:
//        npm run import:inspect
//   3. Review it:
//        npm run import:preview
//   4. Run the import:
//        IMPORT_USERNAME=president IMPORT_PASSWORD=xxx npm run import:members
//
// Pass IMPORT_FORCE=1 to re-run after the first successful import (the server
// refuses by default once any member has an NID).
//
// Pass IMPORT_ENDPOINT='https://<preview>.netlify.app/.netlify/functions/api'
// to import into a deployed environment instead of localhost.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ENDPOINT = process.env.IMPORT_ENDPOINT
  || 'http://localhost:8888/.netlify/functions/api';
const USERNAME = process.env.IMPORT_USERNAME;
const PASSWORD = process.env.IMPORT_PASSWORD;
const FORCE    = !!process.env.IMPORT_FORCE;

if (!USERNAME || !PASSWORD) {
  console.error('Set IMPORT_USERNAME and IMPORT_PASSWORD env vars (superadmin login).');
  console.error('Example:');
  console.error('  IMPORT_USERNAME=president IMPORT_PASSWORD=xxx npm run import:members');
  process.exit(1);
}

// ─── 1. Load the preview ───────────────────────────────────────────────────
const previewPath = resolve(here, 'import-preview.json');
let preview;
try {
  preview = JSON.parse(await readFile(previewPath, 'utf8'));
} catch (e) {
  console.error(`Could not read ${previewPath} — run "npm run import:inspect" first.`);
  console.error(e.message);
  process.exit(1);
}

console.log(`[import] Loaded preview: ${preview.rows.length} rows, ${preview.new_committees.length} new committees`);
console.log(`[import] Endpoint: ${ENDPOINT}`);

// ─── 2. Login ─────────────────────────────────────────────────────────────
console.log(`[import] Authenticating as ${USERNAME}…`);
const authResp = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'auth', username: USERNAME, password: PASSWORD }),
});
const authJson = await authResp.json();
if (!authJson || !authJson.success) {
  console.error(`[import] Auth failed: ${authJson && authJson.error}`);
  process.exit(1);
}
const token = authJson.data && authJson.data.token;
const access = authJson.data && authJson.data.user && authJson.data.user.access;
if (!token || access !== 'superadmin') {
  console.error(`[import] Auth ok but user is not superadmin (got ${access}). Use the president login.`);
  process.exit(1);
}
console.log(`[import] ✓ authenticated`);

// ─── 3. Send the payload ─────────────────────────────────────────────────
console.log(`[import] Sending import payload${FORCE ? ' (FORCE)' : ''}…`);
const resp = await fetch(ENDPOINT, {
  method: 'POST',
  headers: {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${token}`,
  },
  body: JSON.stringify({
    action: 'setup.bulkImportMembers',
    rows:           preview.rows,
    new_committees: preview.new_committees,
    force:          FORCE,
  }),
});
const json = await resp.json();
if (!resp.ok || !json.success) {
  console.error(`[import] Server returned ${resp.status}: ${json.error || JSON.stringify(json)}`);
  process.exit(1);
}

// ─── 4. Report ───────────────────────────────────────────────────────────
const s = json.data;
console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log('  Import complete');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  New committees created:  ${s.created_committees.length}`);
for (const c of s.created_committees) console.log(`    + ${c.committee_id}  ${c.committee_name}`);
console.log('');
console.log(`  Members updated in place: ${s.members_updated}`);
console.log(`  Members newly inserted:   ${s.members_inserted}`);
console.log(`  Committee head/vice FKs:  ${s.heads_assigned}`);
console.log(`  Dummy rows deleted:       ${s.dummies_deleted}`);
if (s.dummy_ids && s.dummy_ids.length) {
  console.log(`    (${s.dummy_ids.slice(0, 10).join(', ')}${s.dummy_ids.length > 10 ? ', …' : ''})`);
}
console.log('');
console.log('  Done. Refresh the admin Members tab to see the new roster.');
