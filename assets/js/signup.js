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

// i18n: side-effect import sets <html dir/lang> + applies data-i18n
// strings. t() is used below for the dynamic mode-switch label and
// the per-field validation messages (those are set by JS, not by
// data-i18n attributes, so they need re-rendering on language change).
import { t, getLang, setLang, onLangChange } from './lib/i18n.js';

import { callApi } from './lib/api.js';
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
// On language change we also need to refresh the dynamic welcome +
// mode-switch labels (they're set imperatively in applyMode()).
onLangChange(() => { _syncLangButtons(); applyMode(); });
_syncLangButtons();

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
    welcome.textContent     = t('su.token_mode_welcome');
    toggle.textContent      = t('su.mode_switch_to_pin');
  } else {
    pinFields.style.display = '';
    welcome.textContent     = t('su.pin_mode_welcome');
    toggle.textContent      = t('su.mode_switch_to_link');
  }
}

// ── Submit ──────────────────────────────────────────────────────────
async function doSubmit() {
  const pw1 = $('#pw1').value;
  const pw2 = $('#pw2').value;

  hideMessages();

  // Per-mode field validation. Messages flow through t() so they
  // localize cleanly when the user toggles language.
  if (mode === 'pin') {
    const nid = $('#national-id').value.trim();
    const pin = $('#pin').value.trim();
    if (!nid)                  { showError(t('su.err_need_nid'));    return; }
    if (!/^\d{10}$/.test(nid)) { showError(t('su.err_nid_format'));  return; }
    if (!pin)                  { showError(t('su.err_need_pin'));    return; }
    if (!/^\d{6}$/.test(pin))  { showError(t('su.err_pin_format'));  return; }
  }
  if (!pw1 || !pw2)   { showError(t('su.err_need_passwords'));    return; }
  if (pw1 !== pw2)    { showError(t('su.err_password_mismatch')); return; }
  if (pw1.length < 8) { showError(t('su.err_password_short'));    return; }

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

    showSuccess(t('su.success_activated'));
    // Brief pause so the member SEES the success message before the
    // redirect — 2s matches reset-password.js's pacing.
    setTimeout(() => { window.location.href = 'login.html'; }, 2000);
  } catch (e) {
    btn.disabled  = false;
    btn.innerHTML = `<span id="submit-btn-txt" data-i18n="su.submit">${t('su.submit')}</span>`;
    // The Edge Function already returns Arabic-first error strings
    // (with English mirror), so passing the message through verbatim
    // is fine for now. Generic-error fallback uses t() so at least
    // the unknown-error case is bilingual.
    showError(String(e?.message || t('su.err_unexpected')));
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
