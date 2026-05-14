// signup.html logic — Phase 3 of Branch 4 (feature/member-portal).
//
// The page services two activation paths, both ending the same:
//   1. EMAIL-LINK: admin issued an invite via auth.invite.byEmail, the
//      member clicked the link in their email which lands them here
//      with `?token=<64-hex>` in the URL. We hide the NID + PIN fields
//      and just collect a password.
//   2. NID + PIN: admin issued a 6-digit PIN via auth.invite.byPin and
//      told the member offline. The member visits this page directly
//      (no query string). We show NID + PIN + password fields.
//
// Either way, on submit we call the matching Edge Function action
// (auth.signup.completeByToken or .completeByPin). On success the
// server has created an auth.users row, linked it to public.users,
// and cleared the signup-state columns. We redirect to login.html
// so the member can sign in normally with their email + chosen
// password — same flow as everyone else from that point on.
//
// The "use a PIN instead" / "use the email link instead" toggle below
// the submit button lets the member switch modes if they have both
// credentials (e.g. their token-link expired but they got a PIN as
// backup). The toggle is purely client-side — it just hides/shows
// the NID+PIN fieldset and re-labels things.

import { applyStoredTheme } from './lib/theme.js';
applyStoredTheme();

import { callApi } from './lib/api.js';
import { $ } from './lib/dom.js';

// ── Detect mode from URL params ─────────────────────────────────────
// `?token=...` (or accidentally `&token=...`) → email-link mode.
// Anything else → NID+PIN mode. We don't validate token format here;
// the server is the source of truth ("invalid or expired" is just one
// error path the action already handles).
const params      = new URLSearchParams(window.location.search);
const initialToken = (params.get('token') || '').trim();
let   mode        = initialToken ? 'token' : 'pin';

applyMode();

// ── Wire handlers ───────────────────────────────────────────────────
$('#submit-btn') ?.addEventListener('click', doSubmit);
$('#pw-eye1')    ?.addEventListener('click', () => togglePw('#pw1', '#pw-eye1'));
$('#pw-eye2')    ?.addEventListener('click', () => togglePw('#pw2', '#pw-eye2'));
$('#mode-switch')?.addEventListener('click', () => {
  mode = (mode === 'token') ? 'pin' : 'token';
  applyMode();
  hideMessages();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSubmit(); });

// ── Apply the current mode to the DOM ───────────────────────────────
function applyMode() {
  const pinFields = $('#pin-fields');
  const welcome   = $('#welcome-msg');
  const toggle    = $('#mode-switch');
  if (mode === 'token') {
    pinFields.style.display = 'none';
    welcome.textContent     = 'أنت على بُعد خطوة واحدة من تفعيل حسابك. اختر كلمة المرور وابدأ.';
    toggle.textContent      = 'لديك رمز PIN بدلاً من الرابط؟ اضغط هنا';
  } else {
    pinFields.style.display = '';
    welcome.textContent     = 'أدخل رقم الهوية الوطنية ورمز PIN الذي زوّدك به المسؤول، ثم اختر كلمة المرور.';
    toggle.textContent      = 'لديك رابط بريد إلكتروني بدلاً من PIN؟ اضغط هنا';
  }
}

// ── Submit ──────────────────────────────────────────────────────────
async function doSubmit() {
  const pw1 = $('#pw1').value;
  const pw2 = $('#pw2').value;

  hideMessages();

  // Per-mode field validation. Keep messages friendly + bilingual so a
  // member who's iffy on Arabic still gets actionable feedback.
  if (mode === 'pin') {
    const nid = $('#national-id').value.trim();
    const pin = $('#pin').value.trim();
    if (!nid) { showError('أدخل رقم الهوية الوطنية'); return; }
    if (!/^\d{10}$/.test(nid)) { showError('رقم الهوية يجب أن يكون 10 أرقام'); return; }
    if (!pin) { showError('أدخل رمز PIN المكوّن من 6 أرقام'); return; }
    if (!/^\d{6}$/.test(pin)) { showError('رمز PIN يجب أن يكون 6 أرقام'); return; }
  }
  if (!pw1 || !pw2) { showError('يرجى تعبئة كلمتي المرور'); return; }
  if (pw1 !== pw2)  { showError('كلمتا المرور غير متطابقتين'); return; }
  if (pw1.length < 8) { showError('كلمة المرور يجب أن تكون 8 أحرف على الأقل'); return; }

  const btn = $('#submit-btn');
  btn.disabled  = true;
  btn.innerHTML = '<div class="spinner"></div>';

  try {
    // Pick the right action + payload for the current mode.
    const result = (mode === 'token')
      ? await callApi('auth.signup.completeByToken', { token: initialToken, password: pw1 })
      : await callApi('auth.signup.completeByPin',   {
          national_id: $('#national-id').value.trim(),
          pin:         $('#pin').value.trim(),
          password:    pw1,
        });

    if (!result.success) throw new Error(result.error || 'Activation failed');

    // Clear the URL query string so refreshing doesn't replay the token.
    history.replaceState(null, '', window.location.pathname);

    showSuccess('تم تفعيل الحساب بنجاح. سيتم تحويلك إلى صفحة تسجيل الدخول…');
    // Brief pause so the member SEES the success message before the
    // redirect — 2s matches reset-password.js's pacing.
    setTimeout(() => { window.location.href = 'login.html'; }, 2000);
  } catch (e) {
    btn.disabled  = false;
    btn.innerHTML = '<span id="submit-btn-txt">تفعيل الحساب</span>';
    // The Edge Function already returns Arabic-first error strings
    // (with English mirror), so passing the message through verbatim
    // is fine. If we ever need to add client-side translation later,
    // do it here.
    showError(String(e?.message || 'حدث خطأ غير متوقع'));
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
  $('#error-msg')  .classList.remove('show');
  $('#success-msg').classList.remove('show');
}

function togglePw(inputSel, eyeSel) {
  const inp = $(inputSel);
  const eye = $(eyeSel);
  if (inp.type === 'password') { inp.type = 'text';     eye.textContent = '🙈'; }
  else                          { inp.type = 'password'; eye.textContent = '👁️'; }
}
