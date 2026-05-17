// Public certificate-verification page logic.
//
// Two paths in: typed code in the input field + button click, OR
// ?code= in the URL (the cert-delivery email link drops directly here
// with the code pre-populated, so the recipient just hits "تحقق" or
// the page auto-verifies on load).
//
// No auth — calls the public `certs.verify` action.

import { applyStoredTheme } from './lib/theme.js';
applyStoredTheme();

import { callApi } from './lib/api.js';
import { $ } from './lib/dom.js';

const codeInput = $('#cert-code');
const verifyBtn = $('#verify-btn');
const resultEl  = $('#result');

// Pre-fill from URL ?code=<cert_code>, then auto-verify so a recipient
// clicking the email link sees the result without an extra tap.
const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode) {
  codeInput.value = urlCode.trim();
  // Defer to next tick so the input renders the value first (visual cue
  // for the recipient that the code was found in the URL).
  setTimeout(verify, 50);
}

verifyBtn?.addEventListener('click', verify);
codeInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') verify();
});

async function verify() {
  const code = (codeInput.value || '').trim();
  if (!code) {
    show('warn', 'أدخل رمز الشهادة أولاً.');
    return;
  }
  verifyBtn.disabled = true;
  verifyBtn.textContent = 'جاري التحقق...';
  resultEl.style.display = 'none';

  try {
    const res = await callApi('certs.verify', { cert_code: code });
    if (!res || !res.success) {
      show('error', 'تعذّر الاتصال بالخادم. حاول مرة أخرى.');
      return;
    }
    const data = res.data || {};
    if (!data.valid) {
      show('error', 'هذه الشهادة غير موجودة أو الرمز غير صحيح. تأكد من إدخال الرمز كما هو في الشهادة.');
      return;
    }
    showCertificate(data.certificate || {});
  } finally {
    verifyBtn.disabled = false;
    verifyBtn.textContent = '🔍 تحقق';
  }
}

function show(kind, msg) {
  const colors = {
    success: { bg: 'rgba(22,163,74,.1)',  border: '#16a34a', text: '#166534', icon: '✅' },
    error:   { bg: 'rgba(220,38,38,.1)',  border: '#dc2626', text: '#b91c1c', icon: '❌' },
    warn:    { bg: 'rgba(234,179,8,.1)',  border: '#eab308', text: '#b45309', icon: '⚠️' },
  };
  const c = colors[kind] || colors.error;
  resultEl.innerHTML = `
    <div style="background:${c.bg};border:1px solid ${c.border};border-radius:10px;padding:.9rem 1rem;color:${c.text};font-size:.85rem;font-weight:600;text-align:center">
      ${c.icon} ${escapeHtml(msg)}
    </div>`;
  resultEl.style.display = '';
}

function showCertificate(cert) {
  // On a successful verification, swap the entire body to a designed
  // certificate sheet. The recipient (or any verifier they shared the
  // link with) sees a proper-looking certificate they can print/save
  // as PDF via Cmd+P. The login-card form fades out because we replace
  // the whole `<body>` content — keeps the URL clean and the layout
  // unambiguous about whether the code was valid.
  const name      = cert.recipient_name || cert.preferred_name || cert.member_full_name || '—';
  const project   = cert.project_name || '—';
  const role      = cert.role || '—';
  const hours     = cert.hours != null ? `${cert.hours}` : '—';
  const issuedAt  = String(cert.issued_at || '').split('T')[0] || '—';
  const code      = cert.cert_code || '';

  // Arabic 3rd-person possessive needs the right gender suffix:
  //   male   → "لمشاركته الفاعلة وجهوده الكريمة"  (his)
  //   female → "لمشاركتها الفاعلة وجهودها الكريمة"  (her)
  // DB stores 'ذكر' / 'أنثى' / NULL. NULL (volunteer cert with no
  // linked member row, or member row with empty gender) falls back to
  // the masculine form — that's the conventional Arabic default when
  // the speaker doesn't know the recipient's gender.
  // Prepositions are baked into each variable: `ل` ("for") on partake
  // (leads the phrase) and `و` ("and") on efforts (joins the second
  // half). Keeping them in the strings avoids losing them in the
  // template glue.
  const isFemale  = cert.member_gender === 'أنثى';
  const partake   = isFemale ? 'لمشاركتها الفاعلة' : 'لمشاركته الفاعلة';
  const efforts   = isFemale ? 'وجهودها الكريمة'   : 'وجهوده الكريمة';
  const committee = cert.committee_name || '';

  // Issuing signer — currently hardcoded to the president for every
  // cert. When the rest of the leadership send in their signatures,
  // this can switch to a per-row issued_by → users → members lookup
  // and pick the signer's actual sig + name + title. Name is the
  // president's full given name as it appears on his ID (not the
  // kunya "أبو جمان") so the printed cert can be verified against
  // the official signer record.
  const signerSig   = 'assets/img/signatures/president.gif';
  const signerName  = 'عبدالمحسن محمد صالح سادس';
  const signerTitle = 'رئيس النادي';

  // Sticky top close bar + floating mobile ✕ button — president flag
  // 2026-05-18: on mobile, after the cert renders there was no clean
  // way to dismiss the page short of refreshing. Both elements link
  // back to the empty verify-cert.html so the user lands on the form
  // again (clean state). Hidden in @media print.
  document.body.innerHTML = `
    <div class="cert-close-bar">
      <a href="verify-cert.html" class="cert-close-btn">✕ إغلاق الشهادة</a>
      <span class="cert-close-label">رمز التحقق: <code style="direction:ltr">${escapeHtml(code)}</code></span>
    </div>
    <div class="cert-stage">
      <div class="cert-sheet">
        <img class="cert-logo" src="assets/img/logo-200.png" alt="SSAM"/>
        <div class="cert-title-ar">شهادة مشاركة</div>
        <div class="cert-divider"></div>

        <div class="cert-intro">تُمنح هذه الشهادة إلى</div>
        <div class="cert-recipient">${escapeHtml(name)}</div>

        <div class="cert-body-text">
          ${partake} ${efforts} في
          <span class="cert-project">${escapeHtml(project)}</span>
        </div>

        <div class="cert-stats">
          <div class="cert-stat">الدور: <strong>${escapeHtml(role)}</strong></div>
          ${committee ? `<div class="cert-stat">اللجنة: <strong>${escapeHtml(committee)}</strong></div>` : ''}
          <div class="cert-stat">عدد الساعات: <strong>${escapeHtml(hours)}</strong></div>
        </div>

        <div class="cert-footer">
          <div class="cert-date">${escapeHtml(issuedAt)}</div>
          <!-- Signer block — replaces the standalone "SSAM seal" that
               used to live here. The page logo at the top already
               establishes the SSAM identity; the footer's job is to
               carry the official "signed by" piece, which is the
               actual hallmark of a diploma-style certificate. -->
          <div class="cert-signer">
            <img src="${signerSig}" alt="signature" class="cert-sig"/>
            <div class="cert-signer-name">${escapeHtml(signerName)}</div>
            <div class="cert-signer-title">${escapeHtml(signerTitle)}</div>
          </div>
          <div class="cert-code">${escapeHtml(code)}</div>
        </div>
      </div>

      <div class="cert-actions">
        <button type="button" id="cert-print-btn">🖨️ طباعة / حفظ PDF</button>
        <a href="index.html" class="cert-back-link">← العودة للصفحة الرئيسية</a>
      </div>
    </div>
    <a href="verify-cert.html" class="cert-close-floating" aria-label="إغلاق الشهادة">✕</a>`;
  // CSP blocks inline event handlers (script-src-attr 'self' without
  // 'unsafe-inline'). Bind via JS instead of an inline onclick=.
  document.getElementById('cert-print-btn')?.addEventListener('click', () => window.print());
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
