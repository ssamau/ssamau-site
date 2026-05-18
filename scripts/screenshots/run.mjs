// Screenshot runner for the PDF guides.
//
// Drives a headless Chromium (via Playwright) through the same flows
// a real member / head / admin walks, capturing one PNG per spec
// entry. Spec entries live in `shots-<portal>.mjs`; each entry knows
// its goto URL, optional setup function (modal opens, fills, clicks)
// and target filename. Output lands under `docs/screenshots/<portal>/`.
//
// Usage:
//   npm run screenshots                       # all three portals
//   npm run screenshots -- --portal=member    # one portal
//   npm run screenshots -- --headed           # show the browser
//
// One-time setup (~150 MB):
//   npx playwright install chromium
//
// Env:
//   SCREENSHOT_URL    target (default https://ssamau.com)
//   DEMO_PASSWORD     shared demo-account password (default Demo2026!)

import { chromium } from 'playwright';
import { mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

const PROD_URL = process.env.SCREENSHOT_URL || 'https://ssamau.com';
const DEMO_PW  = process.env.DEMO_PASSWORD  || 'Demo2026!';
// Screenshots are working artifacts for the PDF guides — they're
// regenerated on demand and would bloat the repo if committed. Default
// output lives in ~/Desktop/SSAM-Demo-Output/screenshots/ so it sits
// next to the repo without being part of it. Override via env var.
const OUT_BASE = process.env.SSAM_DEMO_OUT_DIR
  || join(homedir(), 'Desktop', 'SSAM-Demo-Output', 'screenshots');

// CLI: --portal=member|head|admin (default: all). --headed shows browser.
const argv     = process.argv.slice(2);
const portalArg = (argv.find(a => a.startsWith('--portal=')) || '').split('=')[1] || 'all';
const headed   = argv.includes('--headed');

const PORTALS = ['member', 'head', 'admin'];
const portalsToRun = portalArg === 'all' ? PORTALS : [portalArg];
for (const p of portalsToRun) {
  if (!PORTALS.includes(p)) {
    console.error(`Unknown portal "${p}". Use member, head, or admin.`);
    process.exit(1);
  }
}

console.log(`[screenshots] target:   ${PROD_URL}`);
console.log(`[screenshots] portals:  ${portalsToRun.join(', ')}`);
console.log(`[screenshots] headed:   ${headed ? 'yes' : 'no (use --headed to watch)'}`);

const browser = await chromium.launch({ headless: !headed });

const summary = { ok: 0, skipped: 0, failed: [] };

// ─── Pre-portal: shot 01 (login.html) ─────────────────────────────
// Captured before any account signs in so the form is in its empty
// state. Lives under docs/screenshots/member/ because the member
// guide is where the login screen is documented.
if (portalsToRun.includes('member')) {
  const outDir = join(OUT_BASE, 'member');
  await mkdir(outDir, { recursive: true });
  const anon = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ar' });
  await anon.addInitScript(() => { try { localStorage.setItem('ssam_lang', 'ar'); } catch {} });
  const page = await anon.newPage();
  try {
    await page.goto(`${PROD_URL}/login.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(outDir, '01-login.png') });
    console.log('  01-login.png                                  ✓');
    summary.ok++;
  } catch (err) {
    console.log(`  01-login.png                                  ✗  ${err.message}`);
    summary.failed.push('member/01-login.png');
  }
  await anon.close();
}

for (const portal of portalsToRun) {
  console.log(`\n══════ ${portal.toUpperCase()} ══════`);
  const spec = (await import(`./shots-${portal}.mjs`)).default;

  const outDir = join(OUT_BASE, portal);
  await mkdir(outDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale:   'ar',
    // Force LTR/RTL via the i18n.js storage key (set on first navigation).
  });
  // Pre-seed localStorage with Arabic preference so first-paint matches the
  // language the production site auto-detects for an SSAM user.
  await context.addInitScript(() => {
    try { localStorage.setItem('ssam_lang', 'ar'); } catch {}
  });
  const page = await context.newPage();

  // Sign in once per portal — the existing session is reused across all
  // shots for that account. A clean newContext() guarantees no cookie
  // bleed between portals.
  try {
    await login(page, spec.username, DEMO_PW);
  } catch (err) {
    console.error(`  login failed for ${spec.username}: ${err.message}`);
    await context.close();
    summary.failed.push(`${portal} (login)`);
    continue;
  }

  for (const shot of spec.shots) {
    const label = `  ${shot.filename}`.padEnd(48);
    try {
      if (shot.viewport) {
        await page.setViewportSize(shot.viewport);
      } else {
        await page.setViewportSize({ width: 1440, height: 900 });
      }
      // Navigate. Some shots stay on the current page (no goto) and rely
      // entirely on setup() — typical for multi-step modal flows where
      // an earlier shot already left us on the right tab.
      if (shot.goto) {
        await page.goto(`${PROD_URL}${shot.goto}`, { waitUntil: 'domcontentloaded' });
        // The SPA routers (admin/head/member) listen for `hashchange`.
        // page.goto with a hash that matches the current document is a
        // same-doc navigation in Chromium — the hashchange event isn't
        // always dispatched, so the router can miss the route switch.
        // Force-fire it to make the route activation deterministic.
        await page.evaluate(() => {
          window.dispatchEvent(new HashChangeEvent('hashchange', {
            oldURL: location.href, newURL: location.href,
          }));
        }).catch(() => {});
        // Give SPA tabs a beat to render their content.
        await page.waitForTimeout(800);
      }
      let preCapturedOk = false;
      if (shot.setup) {
        try {
          await shot.setup(page);
        } catch (err) {
          // Special signal: a setup function that captured its own PNG
          // (e.g. cert-preview opens a new tab and screenshots it
          // directly) throws an error with `.ok === true` so the
          // runner skips the standard capture without flagging it
          // as a failure.
          if (err && err.ok === true) {
            preCapturedOk = true;
          } else {
            throw err;
          }
        }
      }
      if (!preCapturedOk) {
        // Privacy filter — demo data lives in the same DB as
        // production, so admin-tier tables surface real rows
        // alongside the "تجريبي ..." demo rows. Apply the filter
        // RIGHT BEFORE capture and revert it RIGHT AFTER. Without
        // the revert, the next shot's setup would try to click on
        // rows still hidden from the previous shot.
        // Opt out per shot via `shot.skipPrivacyFilter: true`.
        if (!shot.skipPrivacyFilter) {
          await applyPrivacyFilter(page);
        }
        // One last paint settle (fonts / icons load lazily in places).
        await page.waitForTimeout(300);
        const out = join(outDir, shot.filename);
        await page.screenshot({
          path: out,
          fullPage: shot.fullPage === true,
        });
        if (!shot.skipPrivacyFilter) {
          await revertPrivacyFilter(page);
        }
      }
      console.log(`${label} ✓`);
      summary.ok++;
      if (shot.teardown) {
        try { await shot.teardown(page); } catch { /* teardown is best-effort */ }
      }
    } catch (err) {
      console.log(`${label} ✗  ${err.message.split('\n')[0]}`);
      summary.failed.push(`${portal}/${shot.filename}`);
    }
  }

  await context.close();
}

await browser.close();

console.log('\n═══════════════════════════════════════════════════════');
console.log(`Done. ok=${summary.ok}  failed=${summary.failed.length}`);
if (summary.failed.length) {
  console.log('\nFailed:');
  for (const f of summary.failed) console.log(`  ${f}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────

// Hide page content that surfaces real members alongside the demo
// "تجريبي ..." entities. Runs after every shot's setup, before the
// PNG is captured. Best-effort — failures are swallowed because some
// shots target pages where these selectors don't exist (login,
// verify-cert, etc.).
//
// What it hides:
//   - <tbody> rows whose textContent doesn't include "تجريبي" or
//     "demo_" (we built every demo entity with one of those
//     markers — committee name "لجنة تجريبية", member names
//     "تجريبي ...", usernames "demo_..."). Empty-state rows
//     (.empty-row, .loading-spinner) stay visible.
//   - The member-portal contact directory (#contact-card) — it
//     lists real presidency + heads from getMembers, which would
//     leak names in the fullPage profile shot.
//   - Dashboard KPI tiles + recent-activity widgets that show
//     aggregate counts (kept visible — numbers don't expose
//     individuals — but recent-activity lists may. Hide their
//     name labels.)
async function applyPrivacyFilter(page) {
  try {
    await page.evaluate(() => {
      // Mark each hidden element with a sentinel class so the revert
      // step can find and unhide them without touching unrelated
      // display:none elements that were always hidden (modals, etc).
      const HIDE_MARKER = 'ssam-screenshot-hidden';
      const DEMO_MARKERS = ['تجريبي', 'demo_', 'لجنة تجريبية', 'يوم العلم', 'ورشة تجريبية'];
      const isDemo = (text) => DEMO_MARKERS.some(m => text.includes(m));

      // 1. Filter every tbody to demo-only rows. Keep empty-row
      //    fallbacks so a fully-filtered table renders the empty
      //    state instead of a blank tbody.
      document.querySelectorAll('tbody').forEach(tbody => {
        Array.from(tbody.querySelectorAll(':scope > tr')).forEach(tr => {
          if (tr.classList.contains('empty-row')) return;
          if (isDemo(tr.textContent || '')) return;
          tr.dataset.ssamPrevDisplay = tr.style.display || '';
          tr.style.display = 'none';
          tr.classList.add(HIDE_MARKER);
        });
      });

      // 2. Contact directory on the member portal profile tab —
      //    lists real presidency + heads.
      const contact = document.getElementById('contact-card');
      if (contact) {
        contact.dataset.ssamPrevDisplay = contact.style.display || '';
        contact.style.display = 'none';
        contact.classList.add(HIDE_MARKER);
      }

      // 3. Recent-activity dashboard widgets that surface real names.
      document.querySelectorAll('.recent-activity, [id$="recent-activity"], .dashboard-recent').forEach(el => {
        el.dataset.ssamPrevDisplay = el.style.display || '';
        el.style.display = 'none';
        el.classList.add(HIDE_MARKER);
      });
    });
  } catch {
    // No-op: evaluate may race a navigation.
  }
}

// Restore every element the privacy filter hid this turn. Reads the
// sentinel class added by applyPrivacyFilter so we don't touch
// display:none elements unrelated to the filter (real modals etc.).
async function revertPrivacyFilter(page) {
  try {
    await page.evaluate(() => {
      const HIDE_MARKER = 'ssam-screenshot-hidden';
      document.querySelectorAll('.' + HIDE_MARKER).forEach(el => {
        el.style.display = el.dataset.ssamPrevDisplay || '';
        delete el.dataset.ssamPrevDisplay;
        el.classList.remove(HIDE_MARKER);
      });
    });
  } catch {
    // No-op
  }
}

async function login(page, username, password) {
  await page.goto(`${PROD_URL}/login.html`, { waitUntil: 'domcontentloaded' });
  await page.fill('#identifier', username);
  await page.fill('#password',   password);
  await page.click('#login-btn');
  // Post-login the page redirects to admin/head/member.html based on access
  // tier. Wait for the URL to leave /login.html (allow up to 20s for the
  // initial round trip + JWT-issue + redirect).
  await page.waitForURL(
    url => !new URL(url).pathname.endsWith('/login.html'),
    { timeout: 20000 },
  );
  // SPA hash-routing settles asynchronously; pause briefly so first
  // tab content is rendered before the first shot.
  await page.waitForTimeout(800);
}
