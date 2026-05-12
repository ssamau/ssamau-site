// Inspector — dry-run preview of what the xlsx would do if you ran the seed.
// No DB writes. Writes db/import-preview.json (gitignored) for downstream
// scripts like preview-import.js to read.
//
// Run with: npm run import:inspect
//
// All the actual normalisation lives in _normalise-xlsx.js so this file and
// db/seed.js stay in lockstep — if you edit the mapping tables there, both
// scripts pick up the change automatically.

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readXlsx, normaliseRows } from './_normalise-xlsx.js';

const here = dirname(fileURLToPath(import.meta.url));
const XLSX_PATH = resolve(here, '..', '..', 'بيانات اللجان.xlsx');
const OUT_PATH  = resolve(here, 'import-preview.json');

const { sheetName, rawRows } = readXlsx(XLSX_PATH);
const { rows, newCommittees, unmapped, skipped } = normaliseRows(rawRows);

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Bulk-import inspection report');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  Xlsx file:       ${XLSX_PATH}`);
console.log(`  Sheet name:      ${sheetName}`);
console.log(`  Total raw rows:  ${rawRows.length}`);
console.log(`  Importable rows: ${rows.length}`);
console.log(`  Skipped rows:    ${skipped.length}`);
console.log('');

const breakdown = (arr, key) => {
  const c = {};
  for (const r of arr) c[r[key] || '(null)'] = (c[r[key] || '(null)'] || 0) + 1;
  return c;
};
console.log('  By club_role:', breakdown(rows, 'club_role'));
console.log('');

const withNID    = rows.filter(r => r.national_id).length;
const withEmail  = rows.filter(r => r.email).length;
const withPhone  = rows.filter(r => r.phone).length;
const withDOB    = rows.filter(r => r.date_of_birth).length;
console.log(`  Filled fields:   national_id ${withNID}/${rows.length},  ` +
            `email ${withEmail},  phone ${withPhone},  dob ${withDOB}`);
console.log('');

console.log(`  Will CREATE ${newCommittees.length} committee(s):`);
for (const c of newCommittees) console.log(`    + ${c}`);
console.log('');

const printWarn = (label, items) => {
  if (!items || !items.length) return;
  console.log(`  ⚠️  ${label} (${items.length}):`);
  for (const it of items) console.log(`    ? ${it}`);
  console.log('');
};

printWarn('Unmapped committee names (will be silently skipped)', unmapped.committees);
printWarn('Unmapped roles (defaulted to Member)',                unmapped.roles);
printWarn('Unmapped scholarship values (kept in *_other column)', unmapped.scholarships);
printWarn('Unmapped universities (kept in university_other)',     unmapped.universities);
printWarn('Unmapped referral sources (kept in *_other column)',   unmapped.referrals);

if (unmapped.phone_issues.length) {
  console.log(`  ⚠️  ${unmapped.phone_issues.length} phone(s) with no recognisable country code:`);
  for (const p of unmapped.phone_issues.slice(0, 6)) {
    console.log(`    row ${p.xlsxRow}: ${p.nameAr} — raw "${p.raw}"`);
  }
  if (unmapped.phone_issues.length > 6) console.log(`    … and ${unmapped.phone_issues.length - 6} more`);
  console.log('');
}

if (skipped.length) {
  console.log(`  Skipped ${skipped.length} empty rows (no name + NID + email).`);
  console.log('');
}

await writeFile(OUT_PATH, JSON.stringify({
  generated_at:   new Date().toISOString(),
  source_xlsx:    XLSX_PATH,
  new_committees: newCommittees,
  unmapped,
  rows,
}, null, 2), 'utf8');

console.log(`  Preview written to: ${OUT_PATH}`);
console.log('  To execute the seed, run: npm run seed');
