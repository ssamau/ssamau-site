// Shared xlsx → DB-payload normaliser. Used by both:
//   • db/inspect-import.js  → dry-run preview, writes db/import-preview.json
//   • db/seed.js            → posts straight to setup.bulkSeed for a fresh install
//
// Keeping the mapping tables + helpers in one place so the two scripts don't
// drift — if a new university or scholarship category lands in the xlsx, you
// edit one file.

import XLSX from 'xlsx';

// ─── Mapping tables ──────────────────────────────────────────────────────────
// xlsx committee strings → canonical names we'll store in the DB. `null`
// means "skip — this isn't a real committee" (board / unspecified rows).
export const COMMITTEE_CANONICAL = {
  'مجلس الإدارة':              null,
  'غير محدد':                  null,
  'أكاديمية الأصالة':           'أكاديمية الأصالة',
  'الفعاليات':                  'لجنة الفعاليات',
  'الأنشطة الرياضية':           'لجنة الأنشطة الرياضية',
  'البرامج العلمية والمهنية':    'لجنة البرامج العلمية والمهنية',
  'اللجنة المالية':             'اللجنة المالية',
  'لجنة الإتصال المؤسسي':       'لجنة الاتصال المؤسسي',
  'الاتصال المؤسسي':            'لجنة الاتصال المؤسسي',
  'مبادرة مرفأ':                'مبادرة مرفأ',
  'شؤون الطلبة':                'لجنة شؤون الطلبة',
  'اللوجستية':                  'اللجنة اللوجستية',
  'التقييم والجودة':             'لجنة التقييم والجودة',
};

export const ROLE_MAP = {
  'الرئيس':              { club_role: 'President',             access: 'superadmin' },
  'نائب الرئيس':         { club_role: 'Vice President',        access: 'superadmin' },
  'نائبة الرئيس':        { club_role: 'Deputy Vice Head', access: 'superadmin' },
  'رئيس اللجنة':         { club_role: 'Committee Head',        access: 'head' },
  'رئيسة اللجنة':        { club_role: 'Committee Head',        access: 'head' },
  'نائب رئيس اللجنة':    { club_role: 'Committee Vice Head',   access: 'head' },
  'قائدة الأكاديمية':    { club_role: 'Committee Head',        access: 'head' },
  'عضو':                  { club_role: 'Member',                access: 'member' },
};

export const STUDY_LEVEL_MAP = {
  'دكتوراه':    'PhD',
  'ماجستير':    'Masters',
  'بكالوريوس':  'Bachelor',
  'دبلوم':      'Diploma',
  'دراسة لغة':  'Language',
};

export const STUDY_STARTED_MAP = {
  'أقل من 6 أشهر':       '<6mo',
  'من 6 أشهر إلى سنة':  '6mo-1y',
  'منذ أكثر من سنة':      '>1y',
};

export const GRADUATION_MAP = {
  'يوليو 2027':       'Jul2027',
  'ديسمبر 2027':      'Dec2027',
  'عام 2028 واكثر':  '2028+',
  'عام 2028 وأكثر':  '2028+',
  '2028 أو لاحقاً': '2028+',
};

export const SCHOLARSHIP_MAP_PARTIAL = [
  [/خادم الحرمين/i,         'khadem_alharamain'],
  [/الابتعاث الوظيفي/i,     'job_sponsored'],
  [/الشركات|أرامكو|سابك|نيوم/i, 'private_sector'],
  [/الثقافي والسياحي/i,     'cultural_tourism'],
  [/مرافق دارس/i,           'companion_student'],
  [/الحساب الخاص/i,         'self_funded'],
  [/مرافق غير دارس/i,       'companion_non_student'],
];

export const UNIVERSITY_MAP_PARTIAL = [
  [/melbourne/i, 'melbourne'],
  [/monash/i,    'monash'],
  [/rmit/i,      'rmit'],
  [/deakin/i,    'deakin'],
  [/la\s*trobe/i,'latrobe'],
  [/swinburne/i, 'swinburne'],
  [/^victoria$|victoria\s*univer/i, 'victoria'],
  [/australian\s*catholic|acu/i, 'acu'],
];

export const REFERRAL_MAP_PARTIAL = [
  [/إكس|تويتر|twitter|^x$/i,  'twitter'],
  [/سناب|snapchat/i,           'snapchat'],
  [/انستقرام|instagram/i,       'instagram'],
  [/واتس|whatsapp/i,            'whatsapp'],
  [/موقع|website/i,             'website'],
  [/صديق|زميل|friend/i,         'friend'],
];

// Per-row manual overrides for xlsx cells that the source mangled (e.g. Excel
// scientific-notation phones). Keyed by 1-indexed xlsx row number.
export const ROW_OVERRIDES = {
  28: {
    phone:              '+61493497451',     // primary (Australian mobile)
    phone_country_code: '+61',
    phone_local:        '493497451',
    whatsapp:           '+966568032245',    // Saudi (WhatsApp)
  },
};

// ─── Small helpers ───────────────────────────────────────────────────────────
const trim = v => typeof v === 'string' ? v.trim() : v;

function mapPartial(value, map) {
  if (!value) return null;
  const v = String(value);
  for (const [pat, key] of map) if (pat.test(v)) return key;
  return null;
}

// Phone numbers in xlsx land as either '0541234567', '+966 54 ...', or worst
// case Excel scientific notation '9.66542E+11'. Recover the digits and split
// into a +966 / +61 country code + the rest.
function normalisePhone(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (/e\+?\d/i.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) s = Math.round(n).toString();
  }
  const digits = s.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('966'))      return { cc: '+966', phone: digits.slice(3) };
  if (digits.startsWith('61'))       return { cc: '+61',  phone: digits.slice(2) };
  if (digits.startsWith('05'))       return { cc: '+966', phone: digits.slice(1) };
  if (digits.startsWith('04'))       return { cc: '+61',  phone: digits.slice(1) };
  if (digits.length === 9 && digits.startsWith('5')) return { cc: '+966', phone: digits };
  if (digits.length === 9 && digits.startsWith('4')) return { cc: '+61',  phone: digits };
  return { cc: null, phone: digits };
}

function normaliseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const n = Number(s);
  if (Number.isFinite(n) && n > 25000 && n < 60000) {
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const d = new Date(epoch.getTime() + n * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return s;
}

// ─── Main entry ──────────────────────────────────────────────────────────────
export function readXlsx(path) {
  const wb = XLSX.readFile(path);
  const sheetName = wb.SheetNames[0];
  const rawRows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null, raw: false });
  return { sheetName, rawRows };
}

export function normaliseRows(rawRows) {
  const newCommittees = new Set();
  const unmappedCommittees = new Set();
  const unmappedRoles = new Set();
  const unmappedScholarships = new Set();
  const unmappedUniversities = new Set();
  const unmappedReferrals = new Set();
  const phoneIssues = [];
  const skipped = [];

  const normalised = rawRows.map((r, idx) => {
    const xlsxRow = idx + 2;
    const fullNameStructure = trim(r['الاسم (الهيكلة)']);
    const nameAr  = trim(r['الاسم الرباعي بالعربي']) || fullNameStructure;
    const nameEn  = trim(r['الاسم الرباعي بالإنجليزي']);
    const nationalId = trim(r['رقم الهوية']);
    const email   = trim(r['البريد الإلكتروني']);

    if (!nameAr && !nationalId && !email) {
      skipped.push({ xlsxRow, reason: 'empty row' });
      return null;
    }

    const committeeXlsx = trim(r['اللجنة']);
    let newCommitteeName = null;
    if (committeeXlsx) {
      if (committeeXlsx in COMMITTEE_CANONICAL) {
        newCommitteeName = COMMITTEE_CANONICAL[committeeXlsx];
        if (newCommitteeName) newCommittees.add(newCommitteeName);
      } else {
        unmappedCommittees.add(committeeXlsx);
      }
    }

    const roleXlsx = trim(r['المنصب']);
    let club_role = 'Member', access = 'member';
    if (roleXlsx) {
      if (roleXlsx in ROLE_MAP) ({ club_role, access } = ROLE_MAP[roleXlsx]);
      else unmappedRoles.add(roleXlsx);
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

    const phoneE164    = phone    ? `${phone.cc || ''}${phone.phone}` : null;
    const whatsappE164 = whatsapp ? `${whatsapp.cc || ''}${whatsapp.phone}` : null;

    const override = ROW_OVERRIDES[xlsxRow] || {};

    return {
      _xlsx_row:          xlsxRow,
      _overridden:        override && Object.keys(override).length ? Object.keys(override) : undefined,
      full_name:          nameAr,
      name_ar:            nameAr,
      name_en:            nameEn,
      preferred_name:     null,
      national_id:        nationalId,
      email:              email,
      phone:              phoneE164,
      whatsapp:           whatsappE164,
      phone_country_code: phone ? phone.cc : null,
      phone_local:        phone ? phone.phone : null,
      gender:             trim(r['الجنس']),
      date_of_birth:      normaliseDate(r['تاريخ الميلاد']),
      address_melbourne:  trim(r['عنوان السكن']),
      linkedin:           trim(r['لينكد إن']),
      scholarship_entity: scholarship,
      scholarship_entity_raw: scholarshipRaw,
      study_level:        STUDY_LEVEL_MAP[trim(r['المرحلة الدراسية'])] || null,
      degree_field:       trim(r['التخصص']),
      university:         university,
      university_other:   university ? null : universityRaw,
      study_started_window:       STUDY_STARTED_MAP[trim(r['بداية الدراسة'])] || null,
      expected_graduation_window: GRADUATION_MAP[trim(r['التخرج المتوقع'])]   || null,
      interests: [trim(r['الرغبة 1']), trim(r['الرغبة 2']), trim(r['الرغبة 3'])].filter(Boolean),
      desired_role:       trim(r['الدور المرغوب']),
      cv_url:             trim(r['السيرة الذاتية']),
      skills_hobbies:     trim(r['المهارات والهوايات']),
      about_self:         trim(r['نبذة']),
      referral_source:    referral,
      referral_source_raw: referralRaw,
      suggestions:        trim(r['الاقتراحات']),
      suggested_committee_xlsx: trim(r['اللجنة المرشحة']),
      new_committee_name: newCommitteeName,
      club_role,
      access,
      ...override,
    };
  }).filter(Boolean);

  return {
    rows: normalised,
    newCommittees: [...newCommittees],
    unmapped: {
      committees: [...unmappedCommittees],
      roles: [...unmappedRoles],
      scholarships: [...unmappedScholarships],
      universities: [...unmappedUniversities],
      referrals: [...unmappedReferrals],
      phone_issues: phoneIssues,
    },
    skipped,
  };
}
