// Arabic string catalog. Flat key:value pairs — the dotted prefixes are
// pure naming convention to group strings by page or feature.
//
// Convention:
//   <page-or-feature>.<element-or-purpose>
//
// Add keys here AND in en.js (matching key set). Missing keys fall back
// to the key string itself, which makes typos visible in the UI.

export default {
  // ─── Brand / cross-cutting ────────────────────────────────────────
  'brand.ssam_full_ar': 'نادي الطلبة السعوديين في ملبورن',
  'brand.ssam_full_en': 'Saudi Students Association in Melbourne',
  'brand.logo_alt':     'شعار النادي',

  // ─── Language toggle ──────────────────────────────────────────────
  'lang.label':    'اللغة',
  'lang.arabic':   'العربية',
  'lang.english':  'English',
  'lang.toggle_title': 'تغيير اللغة',

  // ─── Login page ───────────────────────────────────────────────────
  'login.welcome':              'مرحباً — يرجى تسجيل الدخول للوصول إلى لوحة الإدارة',
  'login.identifier_label':     'البريد الإلكتروني، الهوية الوطنية، أو اسم المستخدم',
  'login.identifier_placeholder': 'أدخل أحد المعرّفات',
  'login.password_label':       'كلمة المرور',
  'login.password_placeholder': 'أدخل كلمة المرور',
  'login.submit':               'تسجيل الدخول',
  'login.error_invalid':        '❌ المعرّف أو كلمة المرور غير صحيحة',
  'login.forgot':               'نسيت كلمة المرور؟',
  'login.activate_prompt':      'عضو جديد ولديك دعوة من المسؤول؟ ',
  'login.activate_cta':         'فعّل حسابك هنا ←',

  // Reset-password pane (toggled in by "forgot password" link)
  'reset.title':                'إعادة تعيين كلمة المرور',
  'reset.intro':                'أدخل بريدك الإلكتروني أو هويتك الوطنية، وسنرسل لك رابط استعادة إلى البريد المسجّل في حسابك.',
  'reset.identifier_label':     'البريد الإلكتروني أو الهوية الوطنية',
  'reset.identifier_placeholder': 'أدخل المعرّف',
  'reset.submit':               'إرسال رابط الاستعادة',
  'reset.back':                 '← العودة إلى تسجيل الدخول',

  // Footer
  'footer.back_home':          '← العودة إلى الصفحة الرئيسية',
  'footer.admin_internal':     'لوحة إدارة النادي — للاستخدام الداخلي فقط',

  // ─── Common runtime messages ──────────────────────────────────────
  'common.loading':             'جاري التحميل...',
  'common.please_fill':         'يرجى إدخال المعرّف وكلمة المرور',
  'common.network_error':       'تعذّر الاتصال بالخادم، حاول مجدداً',
  'common.generic_error':       'حدث خطأ، حاول مجدداً',
  'common.connected':           'متصل',
  'common.refresh':             'تحديث',
  'common.logout':              'خروج',
};
