// reset-password.html logic.
//
// Reads the URL fragment Supabase stamped onto the recovery link:
//   #access_token=<jwt>&refresh_token=<jwt>&type=recovery&expires_in=3600
//
// Then asks for a new password and PUTs /auth/v1/user with the
// access_token as Bearer. Supabase verifies the token is a fresh
// recovery token, accepts the password, and the user can now log in
// at /login.html with their email + new password.
//
// Failure modes:
// - Fragment missing or invalid → tell the user the link is bad or
//   expired (recovery tokens are short-lived: 1h by default)
// - Passwords don't match → client-side check
// - Server rejection (password too weak, etc.) → show the message

import { applyStoredTheme } from './lib/theme.js';
applyStoredTheme();

// i18n: side-effect import sets <html dir/lang> + applies data-i18n on
// the page. t() is used below for the runtime "invalid recovery link"
// error path which is set in JS, not data-i18n.
import { t, getLang, setLang, onLangChange } from './lib/i18n.js';

import { supabaseUpdatePassword } from './lib/auth.js';
import { $ } from './lib/dom.js';

// ── Language toggle wiring ──────────────────────────────────────────
function _syncLangButtons() {
  const cur = getLang();
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === cur);
  });
}
document.querySelectorAll('[data-action="setLang"]').forEach(btn => {
  btn.addEventListener('click', () => setLang(btn.dataset.value));
});
onLangChange(_syncLangButtons);
_syncLangButtons();

// ─── Parse the recovery token from the URL fragment ────────────────
function parseFragment() {
  // Supabase puts the params after `#`, not `?`. URLSearchParams works
  // fine on the substring after the hash.
  const hash = window.location.hash.slice(1); // drop the '#'
  return Object.fromEntries(new URLSearchParams(hash).entries());
}

const fragment    = parseFragment();
const accessToken = fragment.access_token || '';
const flowType    = fragment.type || '';

if (!accessToken || flowType !== 'recovery') {
  // Either the page was opened directly (no recovery link) or the
  // link was malformed/old. Surface the failure cleanly rather than
  // submitting a half-baked request.
  showError(t('rp.err_invalid_link'));
  $('#submit-btn').disabled = true;
}

// ─── Wire handlers ──────────────────────────────────────────────────
$('#submit-btn')?.addEventListener('click', doSubmit);
$('#pw-eye1')   ?.addEventListener('click', () => togglePw('#pw1', '#pw-eye1'));
$('#pw-eye2')   ?.addEventListener('click', () => togglePw('#pw2', '#pw-eye2'));
document.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSubmit(); });

// ─── Submit ─────────────────────────────────────────────────────────
async function doSubmit() {
  const pw1 = $('#pw1').value;
  const pw2 = $('#pw2').value;

  hideMessages();
  if (!pw1 || !pw2) {
    showError('يرجى تعبئة الحقلين');
    return;
  }
  if (pw1 !== pw2) {
    showError('كلمتا المرور غير متطابقتين');
    return;
  }
  if (pw1.length < 8) {
    showError('كلمة المرور قصيرة جداً — على الأقل 8 أحرف');
    return;
  }

  const btn = $('#submit-btn');
  btn.disabled  = true;
  btn.innerHTML = '<div class="spinner"></div>';

  try {
    await supabaseUpdatePassword(accessToken, pw1);
    // Clear the URL fragment so refreshing doesn't reuse the token.
    history.replaceState(null, '', window.location.pathname);
    showSuccess('تم تعيين كلمة المرور بنجاح. سيتم تحويلك إلى صفحة تسجيل الدخول…');
    setTimeout(() => { window.location.href = 'login.html'; }, 2000);
  } catch (e) {
    btn.disabled  = false;
    btn.innerHTML = '<span id="submit-btn-txt">تعيين كلمة المرور</span>';
    const m = String(e?.message || 'حدث خطأ');
    // Map a few common Supabase error messages to Arabic. Anything
    // unrecognised falls through verbatim so debugging still works.
    let friendly = m;
    if (/password should be at least/i.test(m)) friendly = 'كلمة المرور لا تستوفي شروط الأمان';
    if (/new password should be different/i.test(m)) friendly = 'كلمة المرور الجديدة يجب أن تختلف عن السابقة';
    if (/jwt|expired|invalid/i.test(m)) friendly = 'انتهت صلاحية الرابط، اطلب من المسؤول رابطاً جديداً';
    showError(friendly);
  }
}

function showError(msg) {
  const el = $('#error-msg');
  el.textContent = '❌ ' + msg;
  el.classList.add('show');
  $('#success-msg').classList.remove('show');
}
function showSuccess(msg) {
  const el = $('#success-msg');
  el.textContent = '✅ ' + msg;
  el.classList.add('show');
  $('#error-msg').classList.remove('show');
}
function hideMessages() {
  $('#error-msg').classList.remove('show');
  $('#success-msg').classList.remove('show');
}

function togglePw(inputSel, eyeSel) {
  const inp = $(inputSel);
  const eye = $(eyeSel);
  if (inp.type === 'password') { inp.type = 'text'; eye.textContent = '🙈'; }
  else { inp.type = 'password'; eye.textContent = '👁️'; }
}
