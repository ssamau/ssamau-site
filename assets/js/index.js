// Public homepage logic.
//
// Structurally this is the union of the three inline <script> blocks that
// used to live in index.html. Behaviour is intentionally identical — this
// commit is "move code from HTML to a file"; the next commit (CSP step) will
// convert the inline onclick="..." attributes in the markup over to
// addEventListener bindings, at which point the window.* re-exports below
// can be removed.
//
// Sections (top → bottom):
//   1. Fallback static governance data (MBS_LIST + COMS_DATA) for when the
//      API is unreachable. The live updateCommittees() below overwrites these
//      from the DB once the page is loaded.
//   2. Committee tabs / drawer — opens a bottom-sheet showing committee
//      members when a card is clicked.
//   3. Gallery slideshow modal — opens from "آخر فعالياتنا" cards.
//   4. Events strip (hero-area horizontal slideshow).
//   5. Nav: scroll-style toggle, mobile hamburger, smooth-scroll anchors.
//   6. Language toggle (AR ⇄ EN — pure DOM class swap).
//   7. Events tabs (upcoming / past).
//   8. DB sync on window load: getMembers/Advisors/Committees/Projects and
//      patch the board / committee cards / advisors strip / events grid /
//      recent-events grid with the live data. Static HTML acts as fallback.

import { callApi } from './lib/api.js';
import { getTheme, setTheme } from './lib/theme.js';

// ── Theme bootstrap ─────────────────────────────────────────────────────────
// The public homepage defaults to LIGHT mode regardless of OS preference
// (per design decision May 15: the homepage is the marketing surface and
// should look light + welcoming to first-time visitors). The admin pages
// keep the 3-way auto/light/dark toggle. Cross-page behaviour:
//
//   localStorage.ssam_theme value     → homepage shows
//   ────────────────────────────────────────────────────────
//   "dark"                            → dark (respects explicit choice)
//   "light"                           → light
//   "auto" or unset                   → LIGHT (homepage override)
//
// We run this synchronously at the top of the module to avoid a flash
// of dark-theme paint on slow mobile networks. Theme.js's applyStoredTheme
// would honour the auto/unset case as OS-prefers — we deliberately don't
// use it here.
(function applyHomepageTheme() {
  const stored = localStorage.getItem('ssam_theme');
  const effective = (stored === 'dark') ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', effective);
})();

// ── Inline-onclick retrofit ─────────────────────────────────────────────────
// Background: Branch 3 commit 6 tightened CSP to `script-src-attr 'self'`,
// which effectively bans `onclick="..."` attributes (inline attrs can never
// be same-origin). The admin pages got migrated to data-action delegation
// in the same branch. The public homepage was MISSED — ~40 inline onclicks
// in index.html became dead code overnight, but it wasn't noticed because
// most flows landed on apply.html (which uses addEventListener) and the
// admin path. The EN button, events tabs, governance drawer, gallery modal
// — all silently broken.
//
// Proper fix: rewrite each onclick to a data-action attribute + register
// handlers in a small dispatch map. ~40 element edits + a 30-line dispatcher.
// That's its own PR.
//
// This commit ships the SHORT fix: walk every `[onclick]` element at DOM-
// ready, parse the inline call as `fnName(args…)`, look fnName up on the
// window namespace (where index.js already re-exports the handlers), and
// re-bind via addEventListener. Same behaviour, CSP-compliant, no markup
// change. Logs a console warning if anything fails to parse so we catch
// it during the proper-migration follow-up.
function retrofitInlineOnclicks() {
  document.querySelectorAll('[onclick]').forEach(el => {
    const code = el.getAttribute('onclick');
    el.removeAttribute('onclick');
    const call = parseInlineCall(code);
    if (!call) {
      console.warn('[onclick-retrofit] unparseable onclick on', el, '→', code);
      return;
    }
    const fn = window[call.fnName];
    if (typeof fn !== 'function') {
      console.warn('[onclick-retrofit] window.' + call.fnName + ' missing for', el);
      return;
    }
    el.addEventListener('click', (event) => {
      // Resolve `this` and `event` lazily at click time. String / number
      // literals are baked at parse time.
      const args = call.argTokens.map(tok => {
        if (tok === 'this')  return el;
        if (tok === 'event') return event;
        if (tok.kind === 'string') return tok.value;
        if (tok.kind === 'number') return tok.value;
        return undefined;
      });
      try { fn.apply(el, args); }
      catch (err) { console.error('[onclick-retrofit] handler threw:', err); }
    });
  });
}

// Parse a single function-call expression. Supports:
//   - fn()
//   - fn(123), fn(-1)            → number arg
//   - fn('foo'), fn("bar")       → string arg (quotes stripped)
//   - fn(this), fn(event)        → DOM context (resolved at click time)
//   - fn('a', 0, this)           → mixed
// Doesn't support: chained calls, expressions like `event.preventDefault()`,
// arithmetic, member access. None of these appear in our index.html, so the
// minimal parser is adequate. If we ever add a complex inline handler,
// retrofitInlineOnclicks will log a warning and we'll do the proper fix.
function parseInlineCall(code) {
  const m = code.match(/^\s*(\w+)\s*\(\s*(.*?)\s*\)\s*;?\s*$/);
  if (!m) return null;
  const [, fnName, argStr] = m;
  if (!argStr.trim()) return { fnName, argTokens: [] };
  // Split on top-level commas (respecting matched quotes).
  const tokens = [];
  let buf = '', quote = null;
  for (const ch of argStr) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      buf += ch;
    } else if (ch === ',') {
      tokens.push(buf.trim());
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) tokens.push(buf.trim());
  // Normalize each token to { kind, value } or the raw 'this'/'event' string.
  const argTokens = tokens.map(t => {
    if (t === 'this' || t === 'event') return t;
    if (/^['"].*['"]$/.test(t)) return { kind: 'string', value: t.slice(1, -1) };
    if (/^-?\d+(\.\d+)?$/.test(t)) return { kind: 'number', value: Number(t) };
    return t;  // identifier — caller will resolve as undefined and console.warn
  });
  return { fnName, argTokens };
}

// ── Lang toggle wiring ──────────────────────────────────────────────────────
// EN ⇄ AR toggle. Two buttons (#lang-btn in nav-actions, #lang-btn-mobile in
// the drawer) both call window.toggleLang. We deliberately removed the
// inline onclick="toggleLang()" attributes (CSP forbade them anyway) and
// don't rely on the retrofit polyfill for these two — newly-touched code
// should use addEventListener directly, no legacy patterns.
function wireLangToggle() {
  ['lang-btn', 'lang-btn-mobile'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', () => toggleLang());
  });
}

// ── Theme toggle button wiring ──────────────────────────────────────────────
// Two buttons (desktop in nav-actions, mobile in the hamburger drawer) both
// flip light ↔ dark via theme.js's setTheme(). Icon: 🌙 in light mode (i.e.
// the icon shows what you'd switch TO), ☀️ in dark mode. Listens to the
// `ssam-theme-changed` event setTheme dispatches so the icon stays in sync
// even if some other code calls setTheme directly.
function wireThemeToggle() {
  const update = () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    const icon = dark ? '☀️' : '🌙';
    document.querySelectorAll('#theme-btn, #theme-btn-mobile').forEach(b => {
      b.textContent = icon;
    });
  };
  const toggle = () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    setTheme(dark ? 'light' : 'dark');
  };
  ['theme-btn', 'theme-btn-mobile'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', toggle);
  });
  window.addEventListener('ssam-theme-changed', update);
  update();
}

// ── Google Analytics bootstrap ──────────────────────────────────────────────
// The external gtag.js loader is loaded by a <script async> in index.html
// (which a strict CSP whitelists as `script-src 'self' https://www.googletagmanager.com`).
// The init block that used to live inline next to it moves here so we can
// keep `script-src 'self'` clean of `unsafe-inline`.
window.dataLayer = window.dataLayer || [];
window.gtag = function gtag() { window.dataLayer.push(arguments); };
window.gtag('js', new Date());
window.gtag('config', 'G-W1G3RERMS3');

// ── Fallback governance data (overwritten by API on load) ───────────────────
// These are intentionally static — they're what shows if the API call below
// fails (e.g. user is offline, function cold-starting, dev server not up).
window.MBS_LIST = [
  { nm: 'انمار بريسالي',     cm: 'لجنة الفعاليات',                gender: 'ذكر' },
  { nm: 'أمجد محمد',          cm: 'لجنة شؤون الطلبة',              gender: 'ذكر' },
  { nm: 'محمد الغامدي',       cm: 'لجنة الأنشطة الرياضية',         gender: 'ذكر' },
  { nm: 'جمانه عمير',         cm: 'لجنة البرامج العلمية والمهنية', gender: 'أنثى' },
  { nm: 'حنان الزهراني',      cm: 'لجنة الاتصال المؤسسي',          gender: 'أنثى' },
  { nm: 'عبدالرحمن الفيفي',   cm: 'لجنة الأنشطة الرياضية',         gender: 'ذكر' },
  { nm: 'بتال الأحمدي',       cm: 'لجنة الفعاليات',                gender: 'ذكر' },
  { nm: 'نهار الاحمدي',       cm: 'لجنة الفعاليات',                gender: 'ذكر' },
  { nm: 'فاطمة الحداد',       cm: 'لجنة شؤون الطلبة',              gender: 'أنثى' },
  { nm: 'عبدالله الجهوري',    cm: 'لجنة البرامج العلمية والمهنية', gender: 'ذكر' },
  { nm: 'ريما الشقيق',        cm: 'لجنة الفعاليات',                gender: 'أنثى' },
  { nm: 'محمد حكمي',          cm: 'لجنة الفعاليات',                gender: 'ذكر' },
  { nm: 'عبدالرحمن الغامدي',  cm: 'لجنة الفعاليات',                gender: 'ذكر' },
  { nm: 'ريان العنزي',        cm: 'لجنة الاتصال المؤسسي',          gender: 'ذكر' },
  { nm: 'خالد باتياه',        cm: 'لجنة الاتصال المؤسسي',          gender: 'ذكر' },
  { nm: 'عبدالرحمن الشهرب',   cm: 'لجنة الاتصال المؤسسي',          gender: 'ذكر' },
  { nm: 'بشرى الشمري',        cm: 'لجنة الاتصال المؤسسي',          gender: 'أنثى' },
  { nm: 'مروة الحربي',        cm: 'لجنة التقييم والجودة',          gender: 'أنثى' },
  { nm: 'رزان السعدي',        cm: 'لجنة التقييم والجودة',          gender: 'أنثى' },
  { nm: 'يوسف الشهري',        cm: 'لجنة شؤون الطلبة',              gender: 'ذكر' },
  { nm: 'عيسى المتعاني',      cm: 'لجنة الاتصال المؤسسي',          gender: 'ذكر' },
  { nm: 'حسن الشغب',          cm: 'لجنة الفعاليات',                gender: 'ذكر' },
  { nm: 'هدى البكيري',        cm: 'لجنة الاتصال المؤسسي',          gender: 'أنثى' },
  { nm: 'علي المرحبي',        cm: 'لجنة التقييم والجودة',          gender: 'ذكر' },
  { nm: 'يزن الحربي',         cm: 'لجنة البرامج العلمية والمهنية', gender: 'ذكر' },
  { nm: 'سوسن الغامدي',       cm: 'لجنة الشؤون المالية',           gender: 'أنثى' },
  { nm: 'هاشم الشريف',        cm: 'اللجنة اللوجستية',              gender: 'ذكر' },
  { nm: 'ابراهيم الخراشي',    cm: 'لجنة الاتصال المؤسسي',          gender: 'ذكر' },
  { nm: 'عبدالله العجاجي',    cm: 'لجنة الأنشطة الرياضية',         gender: 'ذكر' },
  { nm: 'محمد الشهري',        cm: 'لجنة البرامج العلمية والمهنية', gender: 'ذكر' },
  { nm: 'بيان الجارودي',      cm: 'لجنة الفعاليات',                gender: 'أنثى' },
  { nm: 'أسامه باركب',        cm: 'لجنة شؤون الطلبة',              gender: 'ذكر' },
  { nm: 'هديل حمدي',          cm: 'لجنة الفعاليات',                gender: 'أنثى' },
  { nm: 'سلطان طاهر',         cm: 'اللجنة اللوجستية',              gender: 'ذكر' },
  { nm: 'عبدالعزيز الرشيد',   cm: 'لجنة الشؤون المالية',           gender: 'ذكر' },
  { nm: 'سعد الشريف',         cm: 'اللجنة اللوجستية',              gender: 'ذكر' },
  { nm: 'عبدالعزيز الصيخان',  cm: 'لجنة شؤون الطلبة',              gender: 'ذكر' },
  { nm: 'غلا زاحم',           cm: 'لجنة شؤون الطلبة',              gender: 'أنثى' },
  { nm: 'سلطان الظفيري',      cm: 'اللجنة اللوجستية',              gender: 'ذكر' },
  { nm: 'تميم الغامدي',       cm: 'لجنة الفعاليات',                gender: 'ذكر' },
  { nm: 'عبدالاله القريني',   cm: 'لجنة شؤون الطلبة',              gender: 'ذكر' },
  { nm: 'حسين شريه',          cm: 'لجنة الأنشطة الرياضية',         gender: 'ذكر' },
  { nm: 'فؤاد الحديثي',       cm: 'لجنة الأنشطة الرياضية',         gender: 'ذكر' },
  { nm: 'عبير العميري',       cm: 'لجنة شؤون الطلبة',              gender: 'أنثى' },
  { nm: 'رضا الصالح',         cm: 'لجنة الاتصال المؤسسي',          gender: 'ذكر' },
  { nm: 'ايمن الشخص',         cm: 'لجنة الأنشطة الرياضية',         gender: 'ذكر' },
  { nm: 'علي شريف',           cm: 'لجنة البرامج العلمية والمهنية', gender: 'ذكر' },
  { nm: 'عمر الحسين',         cm: 'لجنة البرامج العلمية والمهنية', gender: 'ذكر' },
  { nm: 'سراج قاسم',          cm: 'لجنة الفعاليات',                gender: 'ذكر' },
  { nm: 'عبدالرحمن الحربي',   cm: 'لجنة الاتصال المؤسسي',          gender: 'ذكر' },
  { nm: 'بسام الراجحي',       cm: 'لجنة الفعاليات',                gender: 'ذكر' },
  { nm: 'أسماء الفضلي',       cm: 'لجنة الفعاليات',                gender: 'أنثى' },
  { nm: 'فيصل العتيبي',       cm: 'اللجنة اللوجستية',              gender: 'ذكر' },
  { nm: 'جنى الحصان',         cm: 'لجنة الفعاليات',                gender: 'أنثى' },
];

// Fallback governance data — overwritten by the API on every page load if it
// responds. Kept here so the public homepage still renders something sensible
// when the API is unreachable. Sourced from the xlsx (بيانات اللجان.xlsx).
//
// Important rule (from xlsx structure): a club VP or DVP who is also
// assigned to a committee IS the vice-head of that committee. The two
// roles aren't mutually exclusive — the same person can sit on the board
// AND lead/co-lead a committee. Examples below: حنان الزهراني is a club
// DVP AND vice of Communications; أسيل العواد is a club DVP AND vice of
// Finance. Reflecting this here so the static page matches the xlsx truth
// while the DB catches up.
window.COMS_DATA = [
  { id: 'events',    ic: '🎪', ar: 'لجنة الفعاليات',                en: 'Events Committee',     hAr: 'حنين الرحيلي',      hEn: 'Haneen Al-Rohaily',     depAr: 'انمار بريسالي', depEn: 'Anmar Beresaly',     cm: 'لجنة الفعاليات' },
  { id: 'student',   ic: '🎓', ar: 'لجنة شؤون الطلبة',              en: 'Student Affairs',      hAr: 'أمجد أبو الخير',    hEn: 'Amjad Abu Al-Khayr',    depAr: 'فاطمة الحداد',  depEn: 'Fatima Al-Haddad',   cm: 'لجنة شؤون الطلبة' },
  { id: 'sports',    ic: '⚽', ar: 'لجنة الأنشطة الرياضية',         en: 'Sports & Recreation',  hAr: 'محمد الغامدي',      hEn: 'Mohammed Al-Ghamdi',    depAr: 'ريما الغانمي',  depEn: 'Reema Al-Ghanmi',    cm: 'لجنة الأنشطة الرياضية' },
  { id: 'academic',  ic: '🔬', ar: 'لجنة البرامج العلمية والمهنية', en: 'Academic Programs',    hAr: 'أحمد الرويلي',      hEn: 'Ahmed Al-Ruwaili',      depAr: 'جمانه الغامدي', depEn: 'Jumanah Al-Ghamdi',  cm: 'لجنة البرامج العلمية والمهنية' },
  { id: 'media',     ic: '📡', ar: 'لجنة الاتصال المؤسسي',          en: 'Communications',       hAr: 'عبدالرحمن الحربي',  hEn: 'Abdulrahman Al-Harbi',  depAr: 'حنان الزهراني', depEn: 'Hanan Al-Zahrani',   cm: 'لجنة الاتصال المؤسسي' },
  { id: 'logistics', ic: '📦', ar: 'اللجنة اللوجستية',              en: 'Logistics',            hAr: 'سعد الشريف',        hEn: 'Saad Al-Sharif',        depAr: null,            depEn: null,                 cm: 'اللجنة اللوجستية' },
  { id: 'finance',   ic: '💰', ar: 'اللجنة المالية',                en: 'Finance',              hAr: 'محمد حكمي',         hEn: 'Mohammed Hakami',       depAr: 'أسيل العواد',   depEn: 'Aseel Al-Awad',      cm: 'اللجنة المالية' },
  { id: 'quality',   ic: '📊', ar: 'لجنة التقييم والجودة',          en: 'Quality & Evaluation', hAr: 'مروة الحربي',       hEn: 'Marwa Al-Harbi',        depAr: null,            depEn: null,                 cm: 'لجنة التقييم والجودة' },
  { id: 'academy',   ic: '📚', ar: 'أكاديمية الأصالة',              en: 'Asalah Academy',       hAr: 'سارة المطيري',      hEn: 'Sara Al-Mutairi',       depAr: null,            depEn: null,                 cm: 'أكاديمية الأصالة' },
  { id: 'mirfa',     ic: '⚓', ar: 'مبادرة مرفأ',                   en: 'Mirfa Initiative',     hAr: null,                hEn: null,                    depAr: null,            depEn: null,                 cm: 'مبادرة مرفأ' },
];

// ── COMMITTEE TABS ──────────────────────────────────────────────────────────
function swTab(id, idx) {
  document.querySelectorAll('.tpnl').forEach((p) => p.classList.remove('ac'));
  document.querySelectorAll('.tabs .tbtn').forEach((b, i) => b.classList.toggle('ac', i === idx));
  const panel = document.getElementById('tp-' + id);
  if (panel) panel.classList.add('ac');
}

// ── COMMITTEE DRAWER (bottom-sheet) ─────────────────────────────────────────
function oDrw(id) {
  const c = window.COMS_DATA.find((x) => x.id === id);
  if (!c) return;
  const mbs = window.MBS_LIST.filter((m) => m.cm === c.cm);
  document.getElementById('di').textContent = c.ic;
  document.getElementById('dn').innerHTML =
    '<span data-ar>' + c.ar + '</span>' +
    '<span data-en style="display:none">' + c.en + '</span>';

  const hH = c.hAr
    ? '<span data-ar>رئيس: ' + c.hAr + '</span>' +
      '<span data-en style="display:none">Head: ' + c.hEn + '</span>' +
      (c.depAr ? '<br><span data-ar style="font-size:.7rem;color:var(--tl);font-weight:600">نائب: ' + c.depAr + '</span>' : '')
    : '<span style="color:var(--tm)">قيد التعيين</span>';
  document.getElementById('dh').innerHTML = hH;

  if (mbs.length) {
    document.getElementById('dm').innerHTML =
      '<div class="drwmbs">' +
      mbs.map((m) => {
        const ini = m.nm[0];
        const iF  = m.gender === 'أنثى';
        return '<div class="drwmb' + (iF ? ' f' : '') + '">' +
          '<div class="drwav' + (iF ? ' f' : '') + '">' + ini + '</div>' +
          '<div><div class="drwmn">' + m.nm + '</div>' +
          '<div class="drwmg">' +
          '<span data-ar>' + (iF ? 'عضوة' : 'عضو') + '</span>' +
          '<span data-en style="display:none">Member</span>' +
          '</div></div></div>';
      }).join('') + '</div>';
  } else {
    document.getElementById('dm').innerHTML =
      '<p style="color:var(--tm);font-size:.84rem;padding:.5rem 0">' +
      '<span data-ar>لا يوجد أعضاء</span></p>';
  }
  document.getElementById('drw').classList.add('op');
  document.body.style.overflow = 'hidden';
}

function cDrw(e) {
  if (e.target === document.getElementById('drw') || e.target.classList.contains('drwbg')) cDrwD();
}
function cDrwD() {
  document.getElementById('drw').classList.remove('op');
  document.body.style.overflow = '';
}

// ── GALLERY SLIDESHOW ───────────────────────────────────────────────────────
let _galImages = [], _galIdx = 0, _galTimer = null;
const _galInterval = 3500;

const GALLERY_FTOURNA = [
  { src: 'assets/img/event-breakfast-reception.png', label: 'فطورنا في ذكرى جدودنا - استقبال الضيوف' },
  { src: 'assets/img/event-breakfast-buffet.jpg',    label: 'فطورنا في ذكرى جدودنا - البوفيه' },
];
// Map gallery key → images array. Both the friendly slug and the original
// Drive folder id resolve to the same local-images array.
const GALLERIES = {
  ftourna: GALLERY_FTOURNA,
  '1FLXQi3sONCPJIY2qjO75YUpzQTpMy0Mc': GALLERY_FTOURNA,
};

function openGallery(folderId, title, dateStr) {
  if (!folderId) return;
  document.getElementById('gallery-title').textContent  = title   || 'معرض الصور';
  document.getElementById('gallery-sub').textContent    = dateStr || '';
  document.getElementById('gallery-drive-link').href    = 'https://drive.google.com/drive/folders/' + folderId;
  document.getElementById('gallery-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  loadGalleryImages(folderId);
}

function loadGalleryImages(folderId) {
  const wrap = document.getElementById('gallery-slide-wrap');
  wrap.querySelectorAll('iframe, img.gallery-slide-img').forEach((el) => el.remove());
  wrap.style.aspectRatio = '16/9';
  wrap.style.minHeight   = '';

  _galImages = GALLERIES[folderId] || GALLERY_FTOURNA;
  _galIdx    = 0;

  document.getElementById('gallery-dots').style.display = 'flex';
  document.getElementById('gallery-prev').style.display = 'flex';
  document.getElementById('gallery-next').style.display = 'flex';
  document.getElementById('gallery-progress').parentElement.style.display = 'block';

  buildSlideshow(wrap);
}

function buildSlideshow(wrap) {
  document.getElementById('gallery-loading').style.display = 'none';
  wrap.querySelectorAll('.gallery-slide-img').forEach((el) => el.remove());

  _galImages.forEach((img, i) => {
    const el = document.createElement('img');
    el.className = 'gallery-slide-img' + (i === 0 ? ' active' : '');
    el.src       = img.src || img.url || '';
    el.alt       = img.label || '';
    el.loading   = 'lazy';
    el.addEventListener('click', (e) => e.stopPropagation());
    wrap.appendChild(el);
  });

  // Dots: build via DOM (addEventListener) instead of string-concat + inline
  // onclick — keeps CSP happy when the JS-generated handlers stay in JS.
  const dots = document.getElementById('gallery-dots');
  dots.innerHTML = '';
  _galImages.slice(0, 30).forEach((_, i) => {
    const d = document.createElement('div');
    d.className = 'gallery-dot' + (i === 0 ? ' active' : '');
    d.addEventListener('click', () => goToSlide(i));
    dots.appendChild(d);
  });

  updateGalleryUI();
  startAutoPlay();
}

function updateGalleryUI() {
  document.querySelectorAll('.gallery-slide-img').forEach((el, i) => el.classList.toggle('active', i === _galIdx));
  document.querySelectorAll('.gallery-dot').forEach((d, i) => d.classList.toggle('active', i === _galIdx));
  document.getElementById('gallery-counter').textContent = (_galIdx + 1) + ' / ' + _galImages.length;
  resetProgress();
}

function resetProgress() {
  const fill = document.getElementById('gallery-progress');
  fill.style.transition = 'none';
  fill.style.width      = '0%';
  requestAnimationFrame(() => {
    fill.style.transition = 'width ' + _galInterval + 'ms linear';
    fill.style.width      = '100%';
  });
}

function goToSlide(idx) {
  _galIdx = (idx + _galImages.length) % _galImages.length;
  updateGalleryUI();
  clearTimeout(_galTimer);
  _galTimer = setTimeout(() => galleryNav(1), _galInterval);
}
function galleryNav(dir) {
  if (!_galImages.length) return;
  goToSlide(_galIdx + dir);
}
function startAutoPlay() {
  clearTimeout(_galTimer);
  _galTimer = setTimeout(() => galleryNav(1), _galInterval);
}

function closeGallery(e) {
  if (e.target === document.getElementById('gallery-modal')) closeGalleryDirect();
}
function closeGalleryDirect() {
  document.getElementById('gallery-modal').classList.remove('open');
  document.body.style.overflow = '';
  clearTimeout(_galTimer);
  _galImages = [];
  _galIdx    = 0;

  const wrap = document.getElementById('gallery-slide-wrap');
  wrap.querySelectorAll('.gallery-slide-img, iframe').forEach((el) => el.remove());
  wrap.style.minHeight   = '';
  wrap.style.aspectRatio = '16/9';

  document.getElementById('gallery-loading').style.display = 'flex';
  document.getElementById('gallery-loading').textContent   = '⏳ جاري تحميل الصور...';
  document.getElementById('gallery-dots').innerHTML        = '';
  document.getElementById('gallery-dots').style.display    = 'flex';
  document.getElementById('gallery-prev').style.display    = 'flex';
  document.getElementById('gallery-next').style.display    = 'flex';
  document.getElementById('gallery-progress').parentElement.style.display = 'block';
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape')    closeGalleryDirect();
  if (e.key === 'ArrowLeft') galleryNav(1);
  if (e.key === 'ArrowRight') galleryNav(-1);
});

// ── EVENTS STRIP (hero-area autoplay slideshow) ─────────────────────────────
(function () {
  let _sIdx = 0;
  const _sTotal = 2, _sInterval = 5000;
  let _sTimer = null;

  function stripGo(idx) {
    document.querySelectorAll('.ev-strip-slide').forEach((s, i) => s.classList.toggle('active', i === idx));
    document.querySelectorAll('.ev-strip-dot').forEach((d, i) => d.classList.toggle('active', i === idx));
    _sIdx = idx;
    const bar = document.getElementById('ev-strip-progress');
    if (bar) {
      bar.style.transition = 'none';
      bar.style.width      = '0%';
      requestAnimationFrame(() => {
        bar.style.transition = 'width ' + _sInterval + 'ms linear';
        bar.style.width      = '100%';
      });
    }
    clearTimeout(_sTimer);
    _sTimer = setTimeout(() => stripGo((_sIdx + 1) % _sTotal), _sInterval);
  }

  window.stripGo = stripGo;

  window.addEventListener('load', () => {
    if (document.getElementById('ev-strip')) stripGo(0);
  });
})();

// ── NAV: scroll style + mobile hamburger + smooth-scroll anchors ────────────
window.addEventListener('scroll', () => {
  const nav = document.getElementById('navbar');
  if (!nav) return;
  if (window.scrollY > 60) {
    nav.style.background = 'rgba(255,255,255,.99)';
    nav.style.boxShadow  = '0 2px 16px rgba(0,0,0,.1)';
  } else {
    nav.style.background = 'rgba(255,255,255,.97)';
    nav.style.boxShadow  = 'none';
  }
});

let navOpen = false;
function toggleNav() {
  navOpen = !navOpen;
  document.getElementById('mobile-nav').classList.toggle('open', navOpen);
  document.getElementById('hamburger').innerHTML = navOpen ? '&times;' : '&#9776;';
}
function closeNav() {
  navOpen = false;
  document.getElementById('mobile-nav').classList.remove('open');
  document.getElementById('hamburger').innerHTML = '&#9776;';
}

document.querySelectorAll('a[href^="#"]').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    const t = document.querySelector(a.getAttribute('href'));
    if (t) {
      t.scrollIntoView({ behavior: 'smooth', block: 'start' });
      closeNav();
    }
  });
});

// ── LANGUAGE TOGGLE (AR ⇄ EN, pure DOM class swap) ──────────────────────────
let isAR = true;
function toggleLang() {
  isAR = !isAR;
  const btn  = document.getElementById('lang-btn');
  const body = document.body;
  if (isAR) {
    body.classList.remove('en-lang');
    body.dir = 'rtl';
    document.documentElement.lang = 'ar';
    btn.textContent = 'EN';
    document.querySelectorAll('[data-en]').forEach((el) => { el.style.display = 'none'; });
    document.querySelectorAll('[data-ar]').forEach((el) => { el.style.display = ''; });
  } else {
    body.classList.add('en-lang');
    body.dir = 'ltr';
    document.documentElement.lang = 'en';
    btn.textContent = 'AR';
    document.querySelectorAll('[data-ar]').forEach((el) => { el.style.display = 'none'; });
    document.querySelectorAll('[data-en]').forEach((el) => {
      const tag = el.tagName.toLowerCase();
      el.style.display = (tag === 'a' || tag === 'span' || tag === 'button') ? 'inline' : 'block';
    });
  }
}

// ── EVENTS TABS (upcoming / past) ───────────────────────────────────────────
function evTab(id, btn) {
  document.querySelectorAll('.ev-panel').forEach((p) => p.classList.remove('ac'));
  const panel = document.getElementById('ev-' + id);
  if (panel) panel.classList.add('ac');
  document.querySelectorAll('.ev-tbtn').forEach((b) => {
    b.classList.toggle('ac', b.getAttribute('onclick') === btn.getAttribute('onclick'));
  });
}

// ── DB sync: patch static HTML with live data on load ───────────────────────
// All five updaters fail soft — if their data source is empty/missing the
// static fallback markup just stays. We never want an API hiccup to leave the
// page broken.
function updateBoard(members) {
  const roles  = ['President', 'Vice President', 'Deputy Vice President'];
  const roleAr = { President: 'رئيس النادي السعودي في ملبورن', 'Vice President': 'نائب الرئيس', 'Deputy Vice President': 'نائبة الرئيس' };
  const roleEn = { President: 'President of SSAM',             'Vice President': 'Vice President',  'Deputy Vice President': 'Deputy VP' };

  // Per the xlsx rule (clarified by user): a club VP/DVP who also has a
  // committee assignment is THAT COMMITTEE'S vice-head, not a board member.
  // The board (مجلس الإدارة) is just the 3 people with no committee_id:
  // the President + the VPs/DVPs who serve purely at the club level.
  // Without this filter, after the API patch the board page balloons from
  // the correct 3 cards to 8 (every VP/DVP including those embedded in a
  // committee), which was the bug visible in prod.
  const board = members.filter((m) =>
    roles.indexOf(m.club_role) !== -1 && !m.committee_id
  );
  if (!board.length) return;

  const grid = document.querySelector('#tp-board .bgrid');
  if (!grid) return;

  grid.innerHTML = board.map((m) => {
    const fullName = m.full_name || '';
    const ini = fullName[0] || '?';
    const isF = m.gender === 'أنثى';
    const isP = m.club_role === 'President';
    return '<div class="bcard' + (isP ? ' pres' : '') + '">' +
      '<div class="bav' + (isF ? ' f' : '') + '">' + ini + '</div>' +
      '<div class="bnm">' +
        '<span data-ar>' + fullName + '</span>' +
        '<span data-en style="display:none">' + fullName + '</span>' +
      '</div>' +
      '<div class="brl">' +
        '<span data-ar>' + (roleAr[m.club_role] || m.club_role) + '</span>' +
        '<span data-en style="display:none">' + (roleEn[m.club_role] || m.club_role) + '</span>' +
      '</div></div>';
  }).join('');
}

function updateCommittees(members, committees) {
  // Overwrite the fallback MBS_LIST/COMS_DATA so the committee drawer shows
  // live data when opened.
  window.MBS_LIST = members.map((m) => {
    const com = committees.find((c) => c.committee_id === m.committee_id);
    return { nm: m.full_name, cm: com ? com.committee_name : '', gender: m.gender };
  });

  document.querySelectorAll('.ccard').forEach((card) => {
    const comNameEl = card.querySelector('.cnm [data-ar]');
    if (!comNameEl) return;
    const comName = comNameEl.textContent.trim();
    const com = committees.find((c) => c.committee_name === comName);
    if (!com) return;

    const count = members.filter((m) => m.committee_id === com.committee_id).length;
    const cct = card.querySelector('.cct [data-ar]');
    if (cct) cct.textContent = count + ' عضو';
    const cctEn = card.querySelector('.cct [data-en]');
    if (cctEn) cctEn.textContent = count + ' members';

    const headMember = members.find((m) => m.member_id === com.committee_head_member_id);
    const viceMember = members.find((m) => m.member_id === com.committee_vice_head_member_id);

    // Live DB is authoritative WHEN it has data. When it returns null for a
    // role, we fall back to whatever the static HTML / COMS_DATA already
    // says — i.e. the xlsx-sourced fallback wins over a DB silence. This
    // matters because the schema only stores one head + one vice per
    // committee, but the xlsx assigns club VPs/DVPs as committee vices too
    // and those aren't always reflected in the DB yet (separate re-seed
    // task). Once the DB catches up, the static fallback becomes a no-op.
    const chdEl = card.querySelector('.chd');
    if (chdEl && headMember) {
      chdEl.textContent = headMember.full_name;
      chdEl.style.color = 'var(--go)';
    }
    const cdepEl = card.querySelector('.cdep');
    if (cdepEl && viceMember) {
      cdepEl.textContent = 'نائب: ' + viceMember.full_name;
    }

    // Patch COMS_DATA so the drawer (opened via oDrw) shows live heads.
    const cid = card.getAttribute('onclick');
    if (cid) {
      const match = cid.match(/oDrw\('([^']+)'\)/);
      if (match) {
        const cEntry = window.COMS_DATA.find((x) => x.id === match[1]);
        if (cEntry) {
          if (headMember) { cEntry.hAr = headMember.full_name; cEntry.hEn = headMember.full_name; }
          if (viceMember) { cEntry.depAr = viceMember.full_name; cEntry.depEn = viceMember.full_name; }
        }
      }
    }
  });

  // KPI: total active members count.
  const totalActive = members.filter((m) => m.status === 'Active').length;
  document.querySelectorAll('.kpi-n').forEach((el) => {
    if (el.textContent.trim() === '59+') el.textContent = totalActive + '+';
  });
}

function updateAdvisors(advisors) {
  if (!advisors || !advisors.length) return;
  const grid = document.querySelector('#tp-adv .adv-grid');
  if (!grid) return;

  grid.innerHTML = advisors.filter((a) => a.status === 'Active').map((a) => {
    const ini = (a.full_name || 'م')[0];
    return '<div class="adv-card">' +
      '<div class="adv-av">' + ini + '</div>' +
      '<div>' +
        '<div class="adv-name" data-ar>' + a.full_name + '</div>' +
        '<div class="adv-name" data-en style="display:none">' + a.full_name + '</div>' +
        '<div class="adv-role" data-ar>' + (a.advisory_role || 'مستشار النادي') + '</div>' +
        '<div class="adv-role" data-en style="display:none">' + (a.advisory_role || 'Club Advisor') + '</div>' +
      '</div></div>';
  }).join('');
}

// Category → header colour + EN label. Mirrors the curated static cards.
// "Main event" gets gold + a flagship badge in the renderer below.
const EVENT_CATEGORY_META = {
  'مجتمعي':              { color: 'green', en: 'Community' },
  'تكامل':                { color: 'green', en: 'Integration' },
  'أكاديمي':             { color: 'blue',  en: 'Academic' },
  'فعالية رئيسية':       { color: 'gold',  en: 'Main Event', flagship: true },
  'مراسم رسمية':         { color: 'gold',  en: 'Ceremony' },
  'مبادرة دعم الطلاب': { color: 'blue',  en: 'Student Support' },
  'اجتماعي':             { color: 'green', en: 'Social' },
  'رياضي':               { color: 'green', en: 'Sports' },
};

// Parse the convention used by db/import-static-events.js descriptions:
//   Line 1: English title  (optionally with "· ⭐ الفعالية الرئيسية" for flagship)
//   Line 2: "الفئة: <category> · الحضور المتوقع: <range>"  (·-separated; either part may be absent)
//   Line 3: blank
//   Line 4+: Arabic description
// Returns {} if the description doesn't follow the convention — the caller
// then falls back to dumping the raw text into the description slot.
function parseEventDescription(desc) {
  if (!desc) return {};
  const lines = String(desc).split('\n').map((l) => l.trim());

  // Line 1 — English title (+ optional flagship marker)
  const rawLine1 = lines[0] || '';
  const isFlagshipMarker = /⭐|الفعالية الرئيسية|main event/i.test(rawLine1);
  const nameEn = rawLine1.split('·')[0].replace(/⭐.*$/, '').trim();

  // Line 2 — category + optional attendance range, separated by "·"
  const line2 = lines[1] || '';
  let categoryAr = '';
  let attendanceRange = '';
  const m = line2.match(/^الفئة:\s*(.+)$/);
  if (m) {
    // Split on " · " (Arabic uses ·) — first part is category, second (if any)
    // is the attendance range line
    const parts = m[1].split(/\s*·\s*/);
    categoryAr = (parts[0] || '').trim();
    for (let i = 1; i < parts.length; i++) {
      const a = parts[i].match(/الحضور المتوقع:?\s*(.+)/);
      if (a) attendanceRange = a[1].trim();
    }
  }

  // Line 4+ — Arabic description (skip the blank line 3)
  const descAr = lines.slice(3).join(' ').replace(/\s+/g, ' ').trim();

  return {
    nameEn,
    categoryAr,
    attendanceRange,
    descAr,
    isFlagship: isFlagshipMarker || (EVENT_CATEGORY_META[categoryAr] || {}).flagship === true,
  };
}

function updateEvents(projects) {
  if (!projects || !projects.length) return;

  const now = new Date();
  // Upcoming = not cancelled, not completed, AND either no date set (so it's
  // a "coming soon" event) OR a future date. Sort dated events by date,
  // dateless ones land at the end with a "قريباً" header.
  const upcoming = projects
    .filter((p) => {
      if (p.project_status === 'Cancelled' || p.project_status === 'Completed') return false;
      if (!p.event_date) return true;
      return new Date(p.event_date) >= now;
    })
    .sort((a, b) => {
      // Push dateless to the end of the upcoming list.
      if (!a.event_date && !b.event_date) return 0;
      if (!a.event_date) return 1;
      if (!b.event_date) return -1;
      return new Date(a.event_date) - new Date(b.event_date);
    });
  // Past = explicitly completed, or had a date that's now in the past.
  // Don't sweep dateless events into Past (they go to Upcoming above).
  const past = projects
    .filter((p) => {
      if (!p.event_date) return false;
      return p.project_status === 'Completed' || new Date(p.event_date) < now;
    })
    .sort((a, b) => new Date(b.event_date) - new Date(a.event_date));

  const tabs = document.querySelectorAll('.ev-tbtn .ev-cnt');
  if (tabs[0]) tabs[0].textContent = upcoming.length || '';
  if (tabs[1]) tabs[1].textContent = past.length     || '';

  if (upcoming.length) {
    const upGrid = document.querySelector('#ev-upcoming .events-grid');
    if (upGrid) {
      upGrid.innerHTML = upcoming.map((p) => {
        const d = p.event_date ? new Date(p.event_date) : null;
        // Use 'ar' (generic Arabic) instead of 'ar-SA' so the year renders
        // in Latin digits (2026, not ٢٠٢٦) — matches the brand and the
        // static cards. `calendar: 'gregory'` keeps Gregorian month names
        // (Saudi locale default is Hijri, which would mismatch event_date).
        const monthAr = d ? d.toLocaleDateString('ar', { month: 'long', year: 'numeric', calendar: 'gregory' }) : 'قريباً';
        const monthEn = d ? d.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }) : 'Coming Soon';

        const parsed = parseEventDescription(p.project_description);
        const meta   = EVENT_CATEGORY_META[parsed.categoryAr] || { color: 'green', en: '' };
        // Visible text values — prefer parsed structured pieces, fall back to
        // raw description if the convention wasn't followed.
        const descAr = parsed.descAr || p.project_description || '';
        const descEn = parsed.nameEn ? '' : '';   // EN description not stored separately yet
        const tagAr  = parsed.categoryAr || (p.project_type === 'Event' ? 'فعالية' : 'مشروع');
        const tagEn  = meta.en           || (p.project_type === 'Event' ? 'Event'  : 'Project');

        const flagshipBadge = parsed.isFlagship
          ? '<div class="ev-badge" data-ar>الفعالية الرئيسية</div><div class="ev-badge" data-en style="display:none">Main Event</div>'
          : '';

        const attendanceRow = parsed.attendanceRange
          ? '<div class="ev-meta-row"><div class="ev-dot"></div>' +
              esc(parsed.attendanceRange) + ' <span data-ar>حضور</span><span data-en style="display:none">attendees</span>' +
            '</div>'
          : '';

        const nameEnRow = parsed.nameEn
          ? '<div class="ev-name-en">' + esc(parsed.nameEn) + '</div>'
          : '';

        return '<div class="ev-card">' +
          '<div class="ev-hdr ' + meta.color + '">' +
            flagshipBadge +
            '<div class="ev-month">' + esc(monthAr) + '</div>' +
            '<div class="ev-month-en">' + esc(monthEn) + '</div>' +
            '<div class="ev-name">' + esc(p.project_name || '') + '</div>' +
            nameEnRow +
          '</div>' +
          '<div class="ev-body">' +
            '<div class="ev-meta">' +
              '<div class="ev-meta-row"><div class="ev-dot"></div>' + esc(p.location || 'Melbourne, Victoria') + '</div>' +
              attendanceRow +
            '</div>' +
            '<div class="ev-desc" data-ar>' + esc(descAr) + '</div>' +
            (descEn ? '<div class="ev-desc" data-en style="display:none">' + esc(descEn) + '</div>' : '') +
            '<div class="ev-foot">' +
              '<span class="ev-tag" data-ar>' + esc(tagAr) + '</span>' +
              '<span class="ev-tag" data-en style="display:none">' + esc(tagEn) + '</span>' +
              '<span class="ev-btn-disabled"><span class="ar-only i">التسجيل قريباً</span><span class="en-only i">Coming Soon</span></span>' +
            '</div>' +
          '</div></div>';
      }).join('');
    }
  }
  // Past events stay as the static HTML — no DB write needed.
}

// Local HTML escape — used so a description carrying < or & doesn't blow up
// the rendered card. Same shape as lib/dom.js's esc but inlined to keep the
// public-page module self-contained.
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderRecentEvents(projects, members) {
  const grid = document.getElementById('lrep-grid');
  if (!grid) return;
  const now = new Date();

  const recent = projects
    .filter((p) => p.project_status === 'Completed' || new Date(p.event_date) < now)
    .sort((a, b) => new Date(b.event_date) - new Date(a.event_date));
  if (!recent.length) { grid.innerHTML = ''; return; }

  const colors = ['#B8932A', '#1A5C2E', '#0e3a1c', '#185FA5', '#0D7377', '#2A7D42'];

  grid.innerHTML = recent.map((p, i) => {
    let stats = {};
    try {
      const raw = (p.notes || '').trim().replace(/^[﻿]+/, '');
      if (raw && raw[0] === '{') stats = JSON.parse(raw);
    } catch { /* notes wasn't JSON — that's fine, render with no extra stats */ }

    const d = p.event_date ? new Date(p.event_date) : null;
    let dateAr = d ? d.toLocaleDateString('ar-SA', { month: 'long', year: 'numeric' }) : '';
    if (stats.hijri_date) dateAr += ' | ' + stats.hijri_date;

    const mgrId   = p.assigned_event_manager_member_id || p.assigned_project_manager_member_id || '';
    const mgr     = members && mgrId ? members.find((m) => m.member_id === mgrId) : null;
    const mgrName = mgr ? mgr.full_name : '';
    const mgrIni  = mgrName ? mgrName[0] : '';

    const folderId    = stats.gallery_folder || '';
    const safeTitle   = (p.project_name || '').replace(/"/g, '&quot;');
    const safeDateStr = dateAr.replace(/"/g, '&quot;');
    const clickAttr   = folderId
      ? ' class="lrep-card has-gallery" data-gid="' + folderId + '" data-gtitle="' + safeTitle + '" data-gdate="' + safeDateStr + '" onclick="var el=this;openGallery(el.dataset.gid,el.dataset.gtitle,el.dataset.gdate)"'
      : ' class="lrep-card"';

    let statHTML = '';
    if (stats.attendance) statHTML += '<span class="lrep-card-stat">👥 ' + stats.attendance + ' حضور</span>';
    if (stats.tickets)    statHTML += '<span class="lrep-card-stat">🎫 ' + stats.tickets    + ' تذكرة</span>';
    if (stats.rating)     statHTML += '<span class="lrep-card-stat">⭐ ' + stats.rating     + '/5</span>';

    return '<div' + clickAttr + '>' +
      '<div class="lrep-card-hdr" style="background:' + colors[i % colors.length] + '">' +
        '<div class="lrep-card-done">✓ منتهية</div>' +
        '<div class="lrep-card-date">' + dateAr + '</div>' +
        '<div class="lrep-card-name">' + (p.project_name || '') + '</div>' +
        (folderId ? '<div class="lrep-card-gallery-tag">📷 معرض الصور</div>' : '') +
      '</div>' +
      '<div class="lrep-card-body">' +
        '<div class="lrep-card-loc">📍 ' + (p.location || 'Melbourne, Victoria') + '</div>' +
        (mgrName ? '<div class="lrep-card-mgr">' +
          '<div class="lrep-card-mgr-av">' + mgrIni + '</div>' +
          '<div><div class="lrep-card-mgr-t">مدير الفعالية</div>' +
          '<div class="lrep-card-mgr-n">' + mgrName + '</div></div>' +
        '</div>' : '') +
        (statHTML ? '<div class="lrep-card-stats">' + statHTML + '</div>' : '') +
      '</div>' +
    '</div>';
  }).join('');
}

// Theme toggle + inline-onclick retrofit need to run as early as
// possible — DOMContentLoaded rather than load — so the EN button is
// already functional by the time the user can see the page. (The load
// listener below additionally waits for images, which is overkill for
// re-binding click handlers.)
document.addEventListener('DOMContentLoaded', () => {
  retrofitInlineOnclicks();
  wireLangToggle();
  wireThemeToggle();
});

// Kick off the DB fetch when the page is fully loaded (images + all).
// All four reads are public actions; no JWT needed.
window.addEventListener('load', () => {
  Promise.all([
    callApi('getMembers'),
    callApi('getAdvisors'),
    callApi('getCommittees'),
    callApi('getProjects'),
  ]).then(([membersRes, advisorsRes, committeesRes, projectsRes]) => {
    const members    = (membersRes    && membersRes.success)    ? membersRes.data    : [];
    const advisors   = (advisorsRes   && advisorsRes.success)   ? advisorsRes.data   : [];
    const committees = (committeesRes && committeesRes.success) ? committeesRes.data : [];
    const projects   = (projectsRes   && projectsRes.success)   ? projectsRes.data   : [];

    if (members.length)                          updateBoard(members);
    if (members.length && committees.length)     updateCommittees(members, committees);
    if (advisors.length)                         updateAdvisors(advisors);
    if (projects.length)                         updateEvents(projects);
    if (projects.length)                         renderRecentEvents(projects, members);
  }).catch((e) => {
    console.warn('SSAM API: falling back to static data', e);
  });
});

// ── Expose handlers consumed by inline onclick="..." attributes ─────────────
// Temporary: the strict-CSP commit in this same branch will remove the inline
// handlers from the markup and wire addEventListener bindings here. Until
// then, the inline handlers in index.html need these names visible globally.
Object.assign(window, {
  swTab, oDrw, cDrw, cDrwD,
  openGallery, closeGallery, closeGalleryDirect, galleryNav, goToSlide,
  toggleNav, closeNav, toggleLang, evTab,
});
