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
  //   male   → "جهوده الكريمة ومشاركته الفاعلة"  (his)
  //   female → "جهودها الكريمة ومشاركتها الفاعلة"  (her)
  // DB stores 'ذكر' / 'أنثى' / NULL. NULL (volunteer cert with no
  // linked member row, or member row with empty gender) falls back to
  // the masculine form — that's the conventional Arabic default when
  // the speaker doesn't know the recipient's gender (and matches how
  // the cert read before this fix).
  // Note: the preposition `ل` is part of the efforts phrase ("لجهوده" =
  // "for his efforts"); keeping it in the variable avoids losing it
  // in the template, which earlier dropped the ل and produced the
  // ungrammatical "تقديراً جهوده" without the preposition.
  const isFemale  = cert.member_gender === 'أنثى';
  const efforts   = isFemale ? 'لجهودها الكريمة'     : 'لجهوده الكريمة';
  const partake   = isFemale ? 'ومشاركتها الفاعلة'  : 'ومشاركته الفاعلة';

  document.body.innerHTML = `
    <div class="cert-stage">
      <div class="cert-sheet">
        <img class="cert-logo" src="assets/img/logo-200.png" alt="SSAM"/>
        <div class="cert-title-ar">شهادة تقدير</div>
        <div class="cert-title-en">Certificate of Appreciation</div>
        <div class="cert-divider"></div>

        <div class="cert-intro">تُمنح هذه الشهادة إلى</div>
        <div class="cert-recipient">${escapeHtml(name)}</div>

        <div class="cert-body-text">
          تقديراً ${efforts} ${partake} في
          <span class="cert-project">${escapeHtml(project)}</span>
        </div>

        <div class="cert-stats">
          <div class="cert-stat">الدور: <strong>${escapeHtml(role)}</strong></div>
          <div class="cert-stat">عدد الساعات: <strong>${escapeHtml(hours)}</strong></div>
        </div>

        <div class="cert-footer">
          <div class="cert-date">${escapeHtml(issuedAt)}</div>
          <div class="seal">
            <div class="seal-mark">🌿</div>
            نادي الطلبة السعوديين<br/>في ملبورن
          </div>
          <div class="cert-code">${escapeHtml(code)}</div>
        </div>
      </div>

      <div class="cert-actions">
        <button type="button" id="cert-print-btn">🖨️ طباعة / حفظ PDF</button>
        <a href="index.html" class="cert-back-link">← العودة للصفحة الرئيسية</a>
      </div>
    </div>`;
  // CSP blocks inline event handlers (script-src-attr 'self' without
  // 'unsafe-inline'). Bind via JS instead of an inline onclick=.
  document.getElementById('cert-print-btn')?.addEventListener('click', () => window.print());
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
