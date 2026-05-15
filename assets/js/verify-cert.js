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
  const name      = cert.recipient_name || cert.preferred_name || cert.member_full_name || '—';
  const project   = cert.project_name || '—';
  const role      = cert.role || '—';
  const hours     = cert.hours != null ? `${cert.hours} ساعة` : '—';
  const issuedAt  = String(cert.issued_at || '').split('T')[0] || '—';

  resultEl.innerHTML = `
    <div style="background:rgba(22,163,74,.08);border:1px solid #16a34a;border-radius:14px;padding:1.2rem;text-align:start">
      <div style="text-align:center;font-size:.85rem;font-weight:700;color:#166534;margin-bottom:1rem">
        ✅ شهادة موثّقة ومعتمدة من نادي الطلبة السعوديين في ملبورن
      </div>
      <div style="display:grid;gap:.55rem;font-size:.82rem">
        <div><span style="color:#6b7280">الاسم:</span> <strong>${escapeHtml(name)}</strong></div>
        <div><span style="color:#6b7280">الفعالية / المشروع:</span> <strong>${escapeHtml(project)}</strong></div>
        <div><span style="color:#6b7280">الدور:</span> <strong>${escapeHtml(role)}</strong></div>
        <div><span style="color:#6b7280">عدد الساعات:</span> <strong>${escapeHtml(hours)}</strong></div>
        <div><span style="color:#6b7280">تاريخ الإصدار:</span> <strong style="direction:ltr;display:inline-block">${escapeHtml(issuedAt)}</strong></div>
        <div style="font-family:monospace;font-size:.72rem;color:#9ca3af;text-align:center;letter-spacing:.05em;margin-top:.4rem">${escapeHtml(cert.cert_code || '')}</div>
      </div>
    </div>`;
  resultEl.style.display = '';
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
