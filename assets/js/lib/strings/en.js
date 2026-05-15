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

  // ─── Common runtime messages ──────────────────────────────────────
  'common.loading':             'Loading...',
  'common.please_fill':         'Please enter both your identifier and password.',
  'common.network_error':       'Couldn’t reach the server. Try again.',
  'common.generic_error':       'Something went wrong. Try again.',
  'common.connected':           'Connected',
  'common.refresh':             'Refresh',
  'common.logout':              'Sign out',
};
