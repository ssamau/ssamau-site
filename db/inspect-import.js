// One-shot inspector for the leadership-supplied xlsx.
//
// Reads ../بيانات اللجان.xlsx, normalises every column into the shape the
// `setup.bulkImportMembers` action will accept, and prints a clear report so
// we can review BEFORE pushing anything to the DB. Also writes the normalised
// rows to db/import-preview.json for the import client to consume.
//
// Run with: npm run import:inspect

import XLSX from 'xlsx';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const XLSX_PATH = resolve(here, '..', '..', 'بيانات اللجان.xlsx');
const OUT_PATH  = resolve(here, 'import-preview.json');

// ─── Per-row manual overrides ────────────────────────────────────────────────
// xlsx values that were corrupted in the source spreadsheet and corrected
// out-of-band by leadership. Keyed by the 1-indexed xlsx row number (header
// row is row 1, so first data row is row 2).
const ROW_OVERRIDES = {
  28: {
    phone:              '+61493497451',     // primary (Australian mobile)
    phone_country_code: '+61',
    phone_local:        '493497451',
    whatsapp:           '+966568032245',    // Saudi (WhatsApp)
  },
};

// ─── Mapping tables ──────────────────────────────────────────────────────────
// xlsx committee name → existing DB committee_id. Anything not listed here is
// treated as a NEW committee and we'll create it on import (with a generated
// COM_xxx id).
const COMMITTEE_MAP = {
  'مجلس الإدارة':              null,   // board/presidency — no committee row
  'غير محدد':                  null,   // unspecified
  'أكاديمية الأصالة':           'COM_005',
  'الفعاليات':                  'COM_002',
  'الأنشطة الرياضية':           'COM_006',
  'البرامج العلمية والمهنية':    'COM_007',
  'اللجنة المالية':             'COM_008',
};
// Committees that don't exist in the DB yet — we'll create them with new IDs.
// The "Atissal" name appears in two spelling variants; collapse them.
const NEW_COMMITTEE_CANONICAL = {
  'لجنة الإتصال المؤسسي': 'الاتصال المؤسسي',
  'الاتصال المؤسسي':      'الاتصال المؤسسي',
  'مبادرة مرفأ':            'مبادرة مرفأ',
  'شؤون الطلبة':           'شؤون الطلبة',
  'اللوجستية':              'اللجنة اللوجستية',
  'التقييم والجودة':         'لجنة التقييم والجودة',
};

const ROLE_MAP = {
  'الرئيس':              { club_role: 'President',             access: 'superadmin' },
  'نائب الرئيس':         { club_role: 'Vice President',        access: 'superadmin' },
  'نائبة الرئيس':        { club_role: 'Deputy Vice President', access: 'superadmin' },
  'رئيس اللجنة':         { club_role: 'Committee Head',        access: 'head' },
  'رئيسة اللجنة':        { club_role: 'Committee Head',        access: 'head' },
  'نائب رئيس اللجنة':    { club_role: 'Committee Vice Head',   access: 'head' },
  'قائدة الأكاديمية':    { club_role: 'Committee Head',        access: 'head' },
  'عضو':                  { club_role: 'Member',                access: 'member' },
};

const STUDY_LEVEL_MAP = {
  'دكتوراه':    'PhD',
  'ماجستير':    'Masters',
  'بكالوريوس':  'Bachelor',
  'دبلوم':      'Diploma',
  'دراسة لغة':  'Language',
};

const STUDY_STARTED_MAP = {
  'أقل من 6 أشهر':            '<6mo',
  'من 6 أشهر إلى سنة':       '6mo-1y',
  'منذ أكثر من سنة':           '>1y',
};

const GRADUATION_MAP = {
  'يوليو 2027':       'Jul2027',
  'ديسمبر 2027':      'Dec2027',
  'عام 2028 واكثر':  '2028+',
  'عام 2028 وأكثر':  '2028+',
  '2028 أو لاحقاً': '2028+',
};

// Saudi scholarship-entity normalisation. The xlsx uses long descriptive
// strings; map them to our canonical enum keys.
const SCHOLARSHIP_MAP_PARTIAL = [
  [/خادم الحرمين/i,         'khadem_alharamain'],
  [/الابتعاث الوظيفي/i,     'job_sponsored'],
  [/الشركات|أرامكو|سابك|نيوم/i, 'private_sector'],
  [/الثقافي والسياحي/i,     'cultural_tourism'],
  [/مرافق دارس/i,           'companion_student'],
  [/الحساب الخاص/i,         'self_funded'],
  [/مرافق غير دارس/i,       'companion_non_student'],
];

const UNIVERSITY_MAP_PARTIAL = [
  [/melbourne/i, 'melbourne'],
  [/monash/i,    'monash'],
  [/rmit/i,      'rmit'],
  [/deakin/i,    'deakin'],
  [/la\s*trobe/i,'latrobe'],
  [/swinburne/i, 'swinburne'],
  [/^victoria$|victoria\s*univer/i, 'victoria'],
  [/australian\s*catholic|acu/i, 'acu'],
];

const REFERRAL_MAP_PARTIAL = [
  [/إكس|تويتر|twitter|^x$/i,  'twitter'],
  [/سناب|snapchat/i,           'snapchat'],
  [/انستقرام|instagram/i,       'instagram'],
  [/واتس|whatsapp/i,            'whatsapp'],
  [/موقع|website/i,             'website'],
  [/صديق|زميل|friend/i,         'friend'],
];

// ─── Normalisation helpers ───────────────────────────────────────────────────
function trim(v) { return typeof v === 'string' ? v.trim() : v; }

function mapPartial(value, map) {
  if (!value) return null;
  const v = String(value);
  for (const [pat, key] of map) if (pat.test(v)) return key;
  return null;
}

// Phone numbers in xlsx land as either '0541234567', '+966 54 ...', or worst
// case Excel scientific notation '9.66542E+11'. Recover the digits and split
// into a +966 / +61 country code + the rest. Returns { cc, phone } | null.
function normalisePhone(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // Recover scientific notation back to a digit string.
  if (/e\+?\d/i.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) s = Math.round(n).toString();
  }
  const digits = s.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('966')) return { cc: '+966', phone: digits.slice(3) };
  if (digits.startsWith('61'))  return { cc: '+61',  phone: digits.slice(2) };
  // Saudi local format starts with 05; assume +966.
  if (digits.startsWith('05'))  return { cc: '+966', phone: digits.slice(1) };
  // Australian local 04; assume +61.
  if (digits.startsWith('04'))  return { cc: '+61',  phone: digits.slice(1) };
  // 9-digit number starting with 5 → Saudi mobile entered without leading 0.
  if (digits.length === 9 && digits.startsWith('5')) return { cc: '+966', phone: digits };
  // 9-digit number starting with 4 → Australian mobile entered without leading 0.
  // (This club is in Melbourne, so default-Australian is the right bias.)
  if (digits.length === 9 && digits.startsWith('4')) return { cc: '+61', phone: digits };
  // Unknown — store as-is without a country code, flag in report.
  return { cc: null, phone: digits };
}

// Dates from xlsx come as 'YYYY-MM-DD' strings when raw:false. Sanity-check.
function normaliseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // Excel-serial day numbers come through as numeric strings sometimes.
  const n = Number(s);
  if (Number.isFinite(n) && n > 25000 && n < 60000) {
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const d = new Date(epoch.getTime() + n * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return s;
}

// ─── Run ─────────────────────────────────────────────────────────────────────
const wb = XLSX.readFile(XLSX_PATH);
const sheetName = wb.SheetNames[0];
const rawRows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null, raw: false });

const newCommittees = new Set();
const unmappedCommittees = new Set();
const unmappedRoles = new Set();
const unmappedScholarships = new Set();
const unmappedUniversities = new Set();
const unmappedReferrals = new Set();
const phoneIssues = [];
const skipped = [];

const normalised = rawRows.map((r, idx) => {
  const xlsxRow = idx + 2; // 1-indexed + header row

  const fullNameStructure = trim(r['الاسم (الهيكلة)']);
  const nameAr  = trim(r['الاسم الرباعي بالعربي']) || fullNameStructure;
  const nameEn  = trim(r['الاسم الرباعي بالإنجليزي']);
  const nationalId = trim(r['رقم الهوية']);
  const email   = trim(r['البريد الإلكتروني']);

  // Skip empty placeholder rows (no name + no NID + no email).
  if (!nameAr && !nationalId && !email) {
    skipped.push({ xlsxRow, reason: 'empty row' });
    return null;
  }

  const committeeXlsx = trim(r['اللجنة']);
  let committeeId = null;
  let newCommitteeName = null;
  if (committeeXlsx) {
    if (committeeXlsx in COMMITTEE_MAP) {
      committeeId = COMMITTEE_MAP[committeeXlsx];
    } else if (committeeXlsx in NEW_COMMITTEE_CANONICAL) {
      newCommitteeName = NEW_COMMITTEE_CANONICAL[committeeXlsx];
      newCommittees.add(newCommitteeName);
    } else {
      unmappedCommittees.add(committeeXlsx);
    }
  }

  const roleXlsx = trim(r['المنصب']);
  let club_role = 'Member';
  let access = 'member';
  if (roleXlsx) {
    if (roleXlsx in ROLE_MAP) {
      ({ club_role, access } = ROLE_MAP[roleXlsx]);
    } else {
      unmappedRoles.add(roleXlsx);
    }
  }

  const scholarshipRaw = trim(r['جهة الابتعاث']);
  const scholarship = mapPartial(scholarshipRaw, SCHOLARSHIP_MAP_PARTIAL);
  if (scholarshipRaw && !scholarship) unmappedScholarships.add(scholarshipRaw);

  const universityRaw = trim(r['الجامعة']);
  const university = mapPartial(universityRaw, UNIVERSITY_MAP_PARTIAL);
  if (universityRaw && !university) unmappedUniversities.add(universityRaw);

  const referralRaw = trim(r['كيف علم بالنادي']);
  const referral = mapPartial(referralRaw, REFERRAL_MAP_PARTIAL);
  if (referralRaw && !referral) unmappedReferrals.add(referralRaw);

  const phone = normalisePhone(r['رقم الجوال']);
  const whatsapp = normalisePhone(r['رقم الواتس اب']);
  if (phone && phone.cc === null) phoneIssues.push({ xlsxRow, nameAr, raw: r['رقم الجوال'] });
  // Combine cc + number into an E.164 string for the import payload. Drop the
  // '+' if there's no country code so we can still report the digits to admins.
  const phoneE164    = phone    ? `${phone.cc || ''}${phone.phone}` : null;
  const whatsappE164 = whatsapp ? `${whatsapp.cc || ''}${whatsapp.phone}` : null;

  const override = ROW_OVERRIDES[xlsxRow] || {};

  return {
    _xlsx_row:        xlsxRow,
    _overridden:      override && Object.keys(override).length ? Object.keys(override) : undefined,
    full_name:        nameAr,                 // canonical for `members.full_name`
    name_ar:          nameAr,
    name_en:          nameEn,
    preferred_name:   null,                   // not present in xlsx
    national_id:      nationalId,
    email:            email,
    // E.164 strings for both phones — what the import action writes to
    // `members.phone` / `members.whatsapp`. The split fields below are kept
    // for the apply-form-v2 review modal which renders them separately.
    phone:              phoneE164,
    whatsapp:           whatsappE164,
    phone_country_code: phone ? phone.cc : null,
    phone_local:        phone ? phone.phone : null,
    gender:           trim(r['الجنس']),
    date_of_birth:    normaliseDate(r['تاريخ الميلاد']),
    address_melbourne: trim(r['عنوان السكن']),
    linkedin:         trim(r['لينكد إن']),
    scholarship_entity: scholarship,
    scholarship_entity_raw: scholarshipRaw,
    study_level:      STUDY_LEVEL_MAP[trim(r['المرحلة الدراسية'])] || null,
    degree_field:     trim(r['التخصص']),
    university:       university,
    university_other: university ? null : universityRaw,
    study_started_window:       STUDY_STARTED_MAP[trim(r['بداية الدراسة'])] || null,
    expected_graduation_window: GRADUATION_MAP[trim(r['التخرج المتوقع'])]   || null,
    interests: [
      trim(r['الرغبة 1']),
      trim(r['الرغبة 2']),
      trim(r['الرغبة 3']),
    ].filter(Boolean),
    desired_role:      trim(r['الدور المرغوب']),
    cv_url:            trim(r['السيرة الذاتية']),
    skills_hobbies:    trim(r['المهارات والهوايات']),
    about_self:        trim(r['نبذة']),
    referral_source:   referral,
    referral_source_raw: referralRaw,
    suggestions:       trim(r['الاقتراحات']),
    suggested_committee_xlsx: trim(r['اللجنة المرشحة']),
    committee_id:      committeeId,
    new_committee_name: newCommitteeName,
    club_role,
    access,
    ...override,
  };
}).filter(Boolean);

// ─── Report ──────────────────────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════════════════════');
console.log('  Bulk-import inspection report');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  Xlsx file:       ${XLSX_PATH}`);
console.log(`  Sheet name:      ${sheetName}`);
console.log(`  Total raw rows:  ${rawRows.length}`);
console.log(`  Importable rows: ${normalised.length}`);
console.log(`  Skipped rows:    ${skipped.length}`);
console.log('');

const breakdown = (arr, key) => {
  const c = {};
  for (const r of arr) c[r[key] || '(null)'] = (c[r[key] || '(null)'] || 0) + 1;
  return c;
};
console.log('  By club_role:', breakdown(normalised, 'club_role'));
console.log('');

const withNID    = normalised.filter(r => r.national_id).length;
const withEmail  = normalised.filter(r => r.email).length;
const withPhone  = normalised.filter(r => r.phone).length;
const withDOB    = normalised.filter(r => r.date_of_birth).length;
console.log(`  Filled fields:   national_id ${withNID}/${normalised.length},  ` +
            `email ${withEmail},  phone ${withPhone},  dob ${withDOB}`);
console.log('');

console.log(`  Will CREATE ${newCommittees.size} new committee(s):`);
for (const c of newCommittees) console.log(`    + ${c}`);
console.log('');

if (unmappedCommittees.size) {
  console.log(`  ⚠️  Unmapped committee names (will be ignored, member ends up un-committee'd):`);
  for (const c of unmappedCommittees) console.log(`    ? ${c}`);
  console.log('');
}
if (unmappedRoles.size) {
  console.log(`  ⚠️  Unmapped roles (defaulted to "Member"):`);
  for (const c of unmappedRoles) console.log(`    ? ${c}`);
  console.log('');
}
if (unmappedScholarships.size) {
  console.log(`  ⚠️  Unmapped scholarship values (stored as raw in scholarship_entity_other):`);
  for (const c of unmappedScholarships) console.log(`    ? ${c}`);
  console.log('');
}
if (unmappedUniversities.size) {
  console.log(`  ⚠️  Unmapped universities (stored in university_other):`);
  for (const c of unmappedUniversities) console.log(`    ? ${c}`);
  console.log('');
}
if (unmappedReferrals.size) {
  console.log(`  ⚠️  Unmapped referral sources (stored in referral_source_other):`);
  for (const c of unmappedReferrals) console.log(`    ? ${c}`);
  console.log('');
}
if (phoneIssues.length) {
  console.log(`  ⚠️  ${phoneIssues.length} phone(s) with no recognisable country code:`);
  for (const p of phoneIssues.slice(0, 6)) {
    console.log(`    row ${p.xlsxRow}: ${p.nameAr} — raw "${p.raw}"`);
  }
  if (phoneIssues.length > 6) console.log(`    … and ${phoneIssues.length - 6} more`);
  console.log('');
}
if (skipped.length) {
  console.log(`  Skipped ${skipped.length} empty rows (no name + NID + email).`);
  console.log('');
}

await writeFile(OUT_PATH, JSON.stringify({
  generated_at: new Date().toISOString(),
  source_xlsx:  XLSX_PATH,
  new_committees: [...newCommittees],
  unmapped: {
    committees:    [...unmappedCommittees],
    roles:         [...unmappedRoles],
    scholarships:  [...unmappedScholarships],
    universities:  [...unmappedUniversities],
    referrals:     [...unmappedReferrals],
    phone_issues:  phoneIssues,
  },
  rows: normalised,
}, null, 2), 'utf8');

console.log(`  Preview written to: ${OUT_PATH}`);
console.log('  Review the JSON, tell me about anything wrong, then we run the import.');
