// English string catalog. Mirror of ar.js — every key here must exist
// there too. Add keys to both files in lockstep.

export default {
  // ─── Brand / cross-cutting ────────────────────────────────────────
  'brand.ssam_full_ar': 'نادي الطلبة السعوديين في ملبورن',
  'brand.ssam_full_en': 'Saudi Students Association in Melbourne',
  'brand.logo_alt':     'SSAM logo',

  // ─── Language toggle ──────────────────────────────────────────────
  'lang.label':         'Language',
  'lang.arabic':        'العربية',
  'lang.english':       'English',
  'lang.toggle_title':  'Change language',

  // ─── Login page ───────────────────────────────────────────────────
  'login.welcome':              'Welcome — please sign in to access the admin panel.',
  'login.identifier_label':     'Email, national ID, or username',
  'login.identifier_placeholder': 'Enter your identifier',
  'login.password_label':       'Password',
  'login.password_placeholder': 'Enter your password',
  'login.submit':               'Sign in',
  'login.error_invalid':        '❌ Incorrect identifier or password',
  'login.forgot':               'Forgot password?',
  'login.activate_prompt':      'New member with an invitation from an admin? ',
  'login.activate_cta':         'Activate your account here →',

  // Reset-password pane (toggled in by "forgot password" link)
  'reset.title':                'Reset password',
  'reset.intro':                'Enter your email or national ID and we’ll send a recovery link to the email on file.',
  'reset.identifier_label':     'Email or national ID',
  'reset.identifier_placeholder': 'Enter your identifier',
  'reset.submit':               'Send recovery link',
  'reset.back':                 '→ Back to sign in',

  // Footer
  'footer.back_home':          '→ Back to home',
  'footer.admin_internal':     'SSAM admin panel — internal use only',

  // ─── reset-password.html landing page ─────────────────────────────
  'rp.page_title':              'Reset Password',
  'rp.lead':                    'Set a new password for your account.',
  'rp.password_label':          'New password',
  'rp.password_placeholder':    'At least 8 characters',
  'rp.confirm_label':           'Confirm password',
  'rp.confirm_placeholder':     'Re-enter password',
  'rp.submit':                  'Set password',
  'rp.back':                    '→ Back to sign in',
  'rp.footer_hint':             'Password reset — only valid via the link from your email.',

  // ─── signup.html (member portal activation) ───────────────────────
  'su.welcome':                 'Please complete your account activation.',
  'su.nid_label':               'National ID',
  'su.nid_placeholder':         '10 digits',
  'su.pin_label':               'One-time PIN',
  'su.pin_placeholder':         '6 digits',
  'su.password_label':          'New password',
  'su.password_placeholder':    'At least 8 characters',
  'su.confirm_label':           'Confirm password',
  'su.confirm_placeholder':     'Re-enter password',
  'su.submit':                  'Activate account',
  'su.back_to_login':           '→ Back to sign in',
  'su.footer_hint':             'Member account activation — use your invitation link or PIN.',
  'su.mode_switch_to_pin':      'Have a PIN instead of a link? Click here',
  'su.mode_switch_to_link':     'Have an email link instead of a PIN? Click here',
  'su.token_mode_welcome':      'You are one step away from activating your account. Choose a password and you are in.',
  'su.pin_mode_welcome':        'Enter your national ID and the PIN the admin shared with you, then choose a password.',
  'su.err_need_nid':            'Enter your national ID',
  'su.err_nid_format':          'National ID must be exactly 10 digits',
  'su.err_need_pin':            'Enter the 6-digit PIN',
  'su.err_pin_format':          'PIN must be exactly 6 digits',
  'su.err_need_passwords':      'Please fill in both password fields',
  'su.err_password_mismatch':   'The passwords don’t match',
  'su.err_password_short':      'Password must be at least 8 characters',
  'su.success_activated':       'Account activated! Redirecting you to sign-in…',
  'su.err_unexpected':          'Something went wrong',
  'rp.err_invalid_link':        'This recovery link is invalid or expired. Ask an admin for a new one.',

  // ─── Common runtime messages ──────────────────────────────────────
  'common.loading':             'Loading...',
  'common.please_fill':         'Please enter both your identifier and password.',
  'common.network_error':       'Couldn’t reach the server. Try again.',
  'common.generic_error':       'Something went wrong. Try again.',
  'common.connected':           'Connected',
  'common.refresh':             'Refresh',
  'common.logout':              'Sign out',
};
