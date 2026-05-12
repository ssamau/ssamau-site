// One-shot importer for the events that were previously hardcoded in
// index.html. After running this, the same 8 cards on the public page come
// from the DB (via updateEvents()) and can be edited / extended from admin.
//
// Usage:
//   IMPORT_USERNAME=president IMPORT_PASSWORD=xxx npm run import:static-events
//
// Idempotent-ish: each row is inserted with a generated project_id; running
// twice creates duplicates. The script aborts up front if it detects any
// existing project with one of the same names so we don't accidentally
// double-insert.

const ENDPOINT = process.env.IMPORT_ENDPOINT
  || 'http://localhost:8888/.netlify/functions/api';
const USERNAME = process.env.IMPORT_USERNAME;
const PASSWORD = process.env.IMPORT_PASSWORD;

if (!USERNAME || !PASSWORD) {
  console.error('Set IMPORT_USERNAME and IMPORT_PASSWORD env vars.');
  process.exit(1);
}

// Curated event list extracted from index.html's static <div class="ev-card">
// markup. Dates pick a sensible mid-month default (Saudi National Day is
// 23 September, intentionally exact). Edit before running if you want
// different defaults.
// Sourced from the leadership-confirmed cards on index.html. Each card's
// English subtitle, attendance range and category tag are prefixed to the
// description so nothing's lost (the current `projects` schema has no
// dedicated columns for those — adding them is a small follow-up if you
// want a richer event-card UI later).
const EVENTS = [
  {
    project_name: 'احتفالية عيد الأضحى المبارك',
    project_type: 'Event', project_status: 'Planned',
    event_date: '2026-06-15',
    location: 'Melbourne, Victoria',
    project_description:
`Eid Al-Adha Celebration
الفئة: مجتمعي · الحضور المتوقع: 150–300

احتفال مجتمعي مع عشاء جماعي وفعاليات ثقافية وترفيهية.`,
  },
  {
    project_name: 'استقبال الطلاب الجدد',
    project_type: 'Event', project_status: 'Planned',
    event_date: '2026-07-15',
    location: 'Melbourne, Victoria',
    project_description:
`New Students Welcome
الفئة: تكامل · الحضور المتوقع: 100–200

فعالية ترحيبية بالطلاب السعوديين الجدد القادمين لأستراليا لأول مرة.`,
  },
  {
    project_name: 'المنتدى السعودي',
    project_type: 'Event', project_status: 'Planned',
    event_date: '2026-08-15',
    location: 'University of Melbourne',
    project_description:
`Saudi Forum
الفئة: أكاديمي · الحضور المتوقع: 150–200

ملتقى قيادي وعلمي مع الأكاديميين ومسؤولي الملحقية الثقافية في أستراليا.`,
  },
  {
    project_name: 'احتفالية اليوم الوطني السعودي',
    project_type: 'Project', project_status: 'Planned',     // flagship / multi-committee
    event_date: '2026-09-23',
    location: 'Melbourne CBD',
    project_description:
`Saudi National Day Celebration  ·  ⭐ الفعالية الرئيسية
الفئة: فعالية رئيسية · الحضور المتوقع: 400–800

الفعالية الكبرى بحضور ممثلي الملحقية الثقافية في أستراليا وقيادات الجامعات.`,
  },
  {
    project_name: 'حفل تكريم الخريجين',
    project_type: 'Project', project_status: 'Planned',
    event_date: '2026-11-15',
    location: 'Melbourne, Victoria',
    project_description:
`Graduates Recognition Ceremony
الفئة: مراسم رسمية · الحضور المتوقع: 200–400

حفل رسمي لتكريم الخريجين السعوديين من جامعات فيكتوريا.`,
  },
  {
    project_name: 'مبادرة مرفأ — لقاءات قادمة',
    project_type: 'Project', project_status: 'Planning',
    event_date: null,
    location: 'Online | Melbourne',
    project_description:
`Mirfa Initiative — Upcoming Meetings
الفئة: مبادرة دعم الطلاب

لقاءات قادمة قريباً لمبادرة مرفأ — لدعم الصحة النفسية والاجتماعية للطلاب السعوديين في الخارج.`,
  },
  {
    project_name: 'أنشطة رياضية',
    project_type: 'Event', project_status: 'Planning',
    event_date: null,
    location: 'Melbourne, Victoria',
    project_description:
`Sports Activities
الفئة: رياضي · تفاصيل قريباً

أنشطة رياضية وبطولات ترفيهية للطلاب السعوديين في ملبورن — التفاصيل قريباً.`,
  },
  {
    project_name: 'فعاليات اجتماعية',
    project_type: 'Event', project_status: 'Planning',
    event_date: null,
    location: 'Melbourne, Victoria',
    project_description:
`Social Events
الفئة: اجتماعي · تفاصيل قريباً

فعاليات اجتماعية متنوعة للمجتمع السعودي في ملبورن — ترقّبوا التفاصيل قريباً.`,
  },
];

// ─── auth ─────────────────────────────────────────────────────────────
console.log(`[events] Authenticating as ${USERNAME}…`);
const authJson = await (await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'auth', username: USERNAME, password: PASSWORD }),
})).json();
if (!authJson?.success) { console.error('Auth failed:', authJson?.error); process.exit(1); }
const token = authJson.data.token;
const userMemberId = authJson.data.user.member_id;
console.log(`[events] ✓ as ${authJson.data.user.name} (member ${userMemberId})`);

// ─── duplicate check ──────────────────────────────────────────────────
const listJson = await (await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  body: JSON.stringify({ action: 'getProjects' }),
})).json();
const existing = new Set((listJson?.data || []).map(p => p.project_name));
const dupes = EVENTS.filter(e => existing.has(e.project_name));
if (dupes.length) {
  console.error('[events] Aborting — these names already exist in projects:');
  for (const d of dupes) console.error('   - ' + d.project_name);
  console.error('[events] Delete them in admin first, or rename here, then re-run.');
  process.exit(1);
}

// ─── insert ───────────────────────────────────────────────────────────
let ok = 0;
for (const ev of EVENTS) {
  const body = { ...ev, created_by_member_id: userMemberId };
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ action: 'createProject', ...body }),
  });
  const j = await r.json();
  if (j?.success) {
    console.log(`  ✓ ${ev.project_name}  →  ${j.data.project_id}`);
    ok++;
  } else {
    console.error(`  ✗ ${ev.project_name}  →  ${j?.error || r.status}`);
  }
}
console.log(`\n[events] Done. Inserted ${ok}/${EVENTS.length} projects.`);
console.log('[events] Open admin → Projects/Events to edit dates/locations/descriptions.');
