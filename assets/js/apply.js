// Public membership application form. POSTs to `applications.submit` (a
// PUBLIC_ACTIONS entry — no token needed). On success, swaps the form for
// the thank-you panel showing the generated application_id.
//
// Inline onclick/onchange handlers in apply.html have been replaced with
// addEventListener bindings here so a strict CSP `script-src 'self'` works
// without `'unsafe-inline'` exceptions.

import { callApi } from './lib/api.js';
import { $, $$ } from './lib/dom.js';

// ─── Committees (live fetch + static fallback) ──────────────────────────────
// Render the committee checklist as soon as we have data — getCommittees is
// public, but if the API is unreachable we still want users to be able to
// submit, so fall back to the canonical list shipped at build time.
const FALLBACK_COMMITTEES = [
  { committee_id: 'COM_001', committee_name: 'لجنة العلاقات العامة' },
  { committee_id: 'COM_002', committee_name: 'لجنة الفعاليات' },
  { committee_id: 'COM_003', committee_name: 'لجنة الإعلام والتسويق' },
  { committee_id: 'COM_004', committee_name: 'لجنة العائلات' },
  { committee_id: 'COM_005', committee_name: 'أكاديمية الأصالة' },
  { committee_id: 'COM_006', committee_name: 'لجنة الرياضة' },
  { committee_id: 'COM_007', committee_name: 'لجنة الأكاديمية والمهنية' },
  { committee_id: 'COM_008', committee_name: 'لجنة الموارد المالية' },
];

function renderCommittees(list) {
  $('#committees-grid').innerHTML = list.map((c) =>
    `<label><input type="checkbox" name="interest" value="${c.committee_id}"/> ${escapeText(c.committee_name)}</label>`
  ).join('');
}

// Lightweight HTML escape for the committee names (defence in depth — the
// xlsx-sourced names are trusted but we still escape because they're rendered
// into label content).
function escapeText(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

(async () => {
  const r = await callApi('getCommittees');
  const list = (r && r.success && Array.isArray(r.data) && r.data.length) ? r.data : FALLBACK_COMMITTEES;
  renderCommittees(list);
})();

// ─── Form helpers ───────────────────────────────────────────────────────────
const gv = (id) => $('#' + id).value.trim();

function showErr(msg) {
  const el = $('#err-msg');
  el.textContent = '❌ ' + msg;
  el.classList.add('show');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function clearErr() { $('#err-msg').classList.remove('show'); }

function toggleOther(group) {
  const radios = $$(`input[name=${group}]`);
  const sel    = radios.find((r) => r.checked);
  $('#other-' + group).style.display = (sel && sel.value === 'other') ? '' : 'none';
}
function toggleUniOther() {
  $('#university-other-wrap').style.display = (gv('f-university') === 'other') ? '' : 'none';
}
function toggleWaSame() {
  const same = $('#f-wa-same').checked;
  $('#f-wa-section').style.display = same ? 'none' : '';
}
function updateSubmitState() {
  $('#submit-btn').disabled = !$('#f-confirm').checked;
}

// Show / hide the entire study section based on the scholarship choice.
// `companion_non_student` means the applicant is a dependent who isn't
// themselves a student — they have no degree, no university, no graduation
// date to report. Keep the section visible for every other choice.
function toggleStudySection() {
  const sel = $$('input[name=scholarship]').find((r) => r.checked);
  const isNonStudent = !!sel && sel.value === 'companion_non_student';
  const sec = $('#section-study');
  if (sec) sec.style.display = isNonStudent ? 'none' : '';
}

// ─── CV paste modal ─────────────────────────────────────────────────────────
let _cvUrl = '';
function openCvModal() {
  $('#cv-url-input').value = _cvUrl;
  $('#cv-modal').classList.add('open');
  setTimeout(() => $('#cv-url-input').focus(), 50);
}
function closeCvModal() { $('#cv-modal').classList.remove('open'); }
function saveCv() {
  const u = $('#cv-url-input').value.trim();
  if (u && !/^https?:\/\//i.test(u)) {
    alert('الرجاء إدخال رابط صحيح (يبدأ بـ http أو https).');
    return;
  }
  _cvUrl = u;
  const state = $('#cv-state');
  if (u) {
    state.classList.add('show');
    $('#cv-display').textContent = u.length > 40 ? u.slice(0, 38) + '…' : u;
  } else {
    state.classList.remove('show');
  }
  closeCvModal();
}
function clearCv() {
  _cvUrl = '';
  $('#cv-state').classList.remove('show');
}

// ─── Submit ─────────────────────────────────────────────────────────────────
function radioVal(name) {
  const r = $$(`input[name=${name}]:checked`);
  return r.length ? r[0].value : '';
}

async function doSubmit() {
  clearErr();

  const body = {
    // Identity
    national_id:    gv('f-national-id'),
    name_ar:        gv('f-name-ar'),
    name_en:        gv('f-name-en'),
    preferred_name: gv('f-preferred-name'),
    gender:         gv('f-gender'),
    date_of_birth:  gv('f-dob'),
    // Contact
    address_melbourne:  gv('f-address'),
    phone_country_code: gv('f-phone-cc'),
    phone:              gv('f-phone'),
    // WhatsApp: if "same as phone" is ticked, reuse the phone fields; else
    // take the separately-entered WhatsApp number.
    whatsapp_country_code: $('#f-wa-same').checked ? gv('f-phone-cc') : gv('f-wa-cc'),
    whatsapp:              $('#f-wa-same').checked ? gv('f-phone')    : gv('f-wa-number'),
    email:                 gv('f-email'),
    // Sponsorship
    scholarship_entity:       radioVal('scholarship'),
    scholarship_entity_other: gv('f-scholarship-other'),
    // Study
    study_level:                gv('f-study-level'),
    degree_field:               gv('f-degree-field'),
    university:                 gv('f-university'),
    university_other:           gv('f-university-other'),
    study_started_window:       gv('f-study-started'),
    expected_graduation_window: gv('f-graduation'),
    // About + interests
    cv_url:         _cvUrl,
    skills_hobbies: gv('f-skills'),
    about_self:     gv('f-about'),
    interests:      $$('input[name=interest]:checked').map((i) => i.value),
    // Referral + suggestions
    referral_source:       radioVal('referral'),
    referral_source_other: gv('f-referral-other'),
    suggestions:           gv('f-suggestions'),
    // Confirmation
    confirmation_accepted: $('#f-confirm').checked,
  };

  // Required-field validation matches the form's spec.
  //
  // address_melbourne is intentionally NOT required — many applicants don't
  // have a fixed Melbourne address yet when they apply (new arrivals, short-
  // term visitors, family staying temporarily). We collect it when it exists.
  //
  // Study fields are only required when the applicant is actually studying.
  // A `companion_non_student` (dependent who isn't a student themselves)
  // legitimately has no university/degree/graduation to report — leaving
  // them required forced people to invent fake data to submit.
  const required = [
    ['national_id',                'رقم الهوية'],
    ['name_ar',                    'الاسم بالعربية'],
    ['name_en',                    'الاسم بالإنجليزية'],
    ['gender',                     'الجنس'],
    ['date_of_birth',              'تاريخ الميلاد'],
    ['phone',                      'رقم الجوال'],
    ['email',                      'البريد الإلكتروني'],
    ['scholarship_entity',         'جهة الابتعاث'],
    ['skills_hobbies',             'المهارات والهوايات'],
    ['about_self',                 'النبذة عن نفسك'],
    ['referral_source',            'كيف علمت عن النادي'],
    ['suggestions',                'الاقتراحات'],
  ];
  const isStudying = body.scholarship_entity !== 'companion_non_student';
  if (isStudying) {
    required.push(
      ['study_level',                'المرحلة الدراسية'],
      ['degree_field',               'التخصص'],
      ['university',                 'الجامعة'],
      ['study_started_window',       'وقت بدء الدراسة'],
      ['expected_graduation_window', 'تاريخ التخرج المتوقع'],
    );
  }
  for (const [k, label] of required) {
    if (!body[k]) { showErr(`الحقل مطلوب: ${label}`); return; }
  }
  if (body.scholarship_entity === 'other' && !body.scholarship_entity_other) {
    showErr('فضلاً حدّد جهة الابتعاث في خانة "أخرى".'); return;
  }
  if (body.university === 'other' && !body.university_other) {
    showErr('فضلاً اكتب اسم الجامعة.'); return;
  }
  if (body.referral_source === 'other' && !body.referral_source_other) {
    showErr('فضلاً حدّد مصدر معرفتك بالنادي.'); return;
  }
  if (!body.confirmation_accepted) { showErr('يجب الموافقة على الإقرار.'); return; }

  const btn = $('#submit-btn');
  btn.disabled  = true;
  btn.textContent = '⏳ جاري الإرسال…';

  const r = await callApi('applications.submit', body);
  if (!r || !r.success) {
    showErr((r && r.error) || 'تعذّر إرسال الطلب — حاول مجدداً');
    btn.disabled  = false;
    btn.textContent = '📨 إرسال الطلب';
    return;
  }
  $('#thanks-ref').textContent = (r.data && r.data.application_id) || '—';
  $('#form-view').style.display   = 'none';
  $('#thanks-view').style.display = 'block';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─── Wire handlers (replaces inline onclick/onchange) ───────────────────────
$('#f-wa-same')   ?.addEventListener('change', toggleWaSame);
$('#f-university')?.addEventListener('change', toggleUniOther);
$('#f-confirm')   ?.addEventListener('change', updateSubmitState);
$('#submit-btn')  ?.addEventListener('click',  doSubmit);

$$('input[name=scholarship]').forEach((r) => r.addEventListener('change', () => {
  toggleOther('scholarship');
  toggleStudySection();
}));
$$('input[name=referral]').forEach((r)    => r.addEventListener('change', () => toggleOther('referral')));

// CV button + modal
$('.cv-btn')                   ?.addEventListener('click', openCvModal);
$('#cv-state .clear')          ?.addEventListener('click', clearCv);
$('.cv-modal .acts .ok')       ?.addEventListener('click', saveCv);
$('.cv-modal .acts .cancel')   ?.addEventListener('click', closeCvModal);
$('#cv-modal')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeCvModal();   // backdrop click closes
});
