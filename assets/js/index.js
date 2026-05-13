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
// when the API is unreachable. Synced with the production DB (May 2026) so
// names + assignments match reality on first paint; any future drift is
// healed automatically by updateCommittees() below clearing stale slots.
//
// Important: a committee Vice-Head is a distinct role from a club Deputy
// Vice-President. Don't list board members (President / VP / DVP) in the
// `depAr` slot here — those belong on the Board card, not under a committee.
window.COMS_DATA = [
  { id: 'events',    ic: '🎪', ar: 'لجنة الفعاليات',                en: 'Events Committee',     hAr: 'حنين الرحيلي',      hEn: 'Haneen Al-Rohaily',     depAr: 'انمار بريسالي', depEn: 'Anmar Beresaly', cm: 'لجنة الفعاليات' },
  { id: 'student',   ic: '🎓', ar: 'لجنة شؤون الطلبة',              en: 'Student Affairs',      hAr: 'أمجد ابراهيم',      hEn: 'Amjad Ibrahim',         depAr: 'فاطمة الحداد',  depEn: 'Fatima Al-Haddad', cm: 'لجنة شؤون الطلبة' },
  { id: 'sports',    ic: '⚽', ar: 'لجنة الأنشطة الرياضية',         en: 'Sports & Recreation',  hAr: 'محمد الغامدي',      hEn: 'Mohammed Al-Ghamdi',    depAr: null,            depEn: null,                cm: 'لجنة الأنشطة الرياضية' },
  { id: 'academic',  ic: '🔬', ar: 'لجنة البرامج العلمية والمهنية', en: 'Academic Programs',    hAr: 'أحمد الرويلي',      hEn: 'Ahmed Al-Ruwaili',      depAr: null,            depEn: null,                cm: 'لجنة البرامج العلمية والمهنية' },
  { id: 'media',     ic: '📡', ar: 'لجنة الاتصال المؤسسي',          en: 'Communications',       hAr: 'عبدالرحمن الحربي',  hEn: 'Abdulrahman Al-Harbi',  depAr: null,            depEn: null,                cm: 'لجنة الاتصال المؤسسي' },
  { id: 'logistics', ic: '📦', ar: 'اللجنة اللوجستية',              en: 'Logistics',            hAr: 'سعد الشريف',        hEn: 'Saad Al-Sharif',        depAr: null,            depEn: null,                cm: 'اللجنة اللوجستية' },
  { id: 'finance',   ic: '💰', ar: 'اللجنة المالية',                en: 'Finance',              hAr: 'محمد حكمي',         hEn: 'Mohammed Hakami',       depAr: null,            depEn: null,                cm: 'اللجنة المالية' },
  { id: 'quality',   ic: '📊', ar: 'لجنة التقييم والجودة',          en: 'Quality & Evaluation', hAr: 'مروة الحربي',       hEn: 'Marwa Al-Harbi',        depAr: null,            depEn: null,                cm: 'لجنة التقييم والجودة' },
  { id: 'academy',   ic: '📚', ar: 'أكاديمية الأصالة',              en: 'Asalah Academy',       hAr: 'سارة المطيري',      hEn: 'Sara Al-Mutairi',       depAr: null,            depEn: null,                cm: 'أكاديمية الأصالة' },
  { id: 'mirfa',     ic: '⚓', ar: 'مبادرة مرفأ',                   en: 'Mirfa Initiative',     hAr: null,                hEn: null,                    depAr: null,            depEn: null,                cm: 'مبادرة مرفأ' },
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

  const board = members.filter((m) => roles.indexOf(m.club_role) !== -1);
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
    const chdEl = card.querySelector('.chd');
    if (chdEl) {
      if (headMember) {
        chdEl.textContent = headMember.full_name;
        chdEl.style.color = 'var(--go)';
      } else {
        // No head in DB — clear stale static text so we don't show a name
        // for someone who no longer holds the role.
        chdEl.textContent = '';
      }
    }
    const cdepEl = card.querySelector('.cdep');
    if (cdepEl) {
      // Critical: always clear when there's no vice in the DB. Without this,
      // a static fallback that lists someone (e.g. a club VP who is not
      // actually a committee vice) shows on every page load.
      cdepEl.textContent = viceMember ? ('نائب: ' + viceMember.full_name) : '';
    }

    // Patch COMS_DATA so the drawer (opened via oDrw) shows live heads.
    const cid = card.getAttribute('onclick');
    if (cid) {
      const match = cid.match(/oDrw\('([^']+)'\)/);
      if (match) {
        const cEntry = window.COMS_DATA.find((x) => x.id === match[1]);
        if (cEntry) {
          // Mirror the patcher's clear-on-empty behaviour so the drawer
          // doesn't keep stale names from the fallback either.
          cEntry.hAr = headMember ? headMember.full_name : null;
          cEntry.hEn = headMember ? headMember.full_name : null;
          cEntry.depAr = viceMember ? viceMember.full_name : null;
          cEntry.depEn = viceMember ? viceMember.full_name : null;
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

function updateEvents(projects) {
  if (!projects || !projects.length) return;

  const now = new Date();
  const upcoming = projects
    .filter((p) => p.project_status !== 'Cancelled' && new Date(p.event_date) >= now)
    .sort((a, b) => new Date(a.event_date) - new Date(b.event_date));
  const past = projects
    .filter((p) => p.project_status === 'Completed' || new Date(p.event_date) < now)
    .sort((a, b) => new Date(b.event_date) - new Date(a.event_date));

  const tabs = document.querySelectorAll('.ev-tbtn .ev-cnt');
  if (tabs[0]) tabs[0].textContent = upcoming.length || '';
  if (tabs[1]) tabs[1].textContent = past.length     || '';

  if (upcoming.length) {
    const upGrid = document.querySelector('#ev-upcoming .events-grid');
    if (upGrid) {
      upGrid.innerHTML = upcoming.map((p) => {
        const d = p.event_date ? new Date(p.event_date) : null;
        const monthAr = d ? d.toLocaleDateString('ar-SA', { month: 'long', year: 'numeric' }) : '';
        const monthEn = d ? d.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }) : '';
        return '<div class="ev-card">' +
          '<div class="ev-hdr green">' +
            '<div class="ev-month">' + monthAr + '</div>' +
            '<div class="ev-month-en">' + monthEn + '</div>' +
            '<div class="ev-name">' + (p.project_name || '') + '</div>' +
          '</div>' +
          '<div class="ev-body">' +
            '<div class="ev-meta">' +
              '<div class="ev-meta-row"><div class="ev-dot"></div>' + (p.location || 'Melbourne, Victoria') + '</div>' +
            '</div>' +
            '<div class="ev-desc" data-ar>' + (p.project_description || '') + '</div>' +
            '<div class="ev-foot">' +
              '<span class="ev-tag" data-ar>' + (p.project_type || '') + '</span>' +
              '<span class="ev-btn-disabled"><span class="ar-only i">التسجيل قريباً</span></span>' +
            '</div>' +
          '</div></div>';
      }).join('');
    }
  }
  // Past events stay as the static HTML — no DB write needed.
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
