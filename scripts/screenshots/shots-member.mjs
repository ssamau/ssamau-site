// Member-portal screenshot spec — runs as `demo_member`.
//
// Each shot:
//   - filename: file under docs/screenshots/member/
//   - goto:    optional path (relative to prod origin)
//   - setup:   optional async (page) => {…} run after goto, before
//              page.screenshot()
//   - teardown:optional async (page) => {…} run after the shot (e.g.
//              close a modal so the next shot starts from a clean state)
//   - viewport:{ width, height } override
//   - fullPage:true to capture beyond the viewport

export default {
  username: 'demo_member',
  shots: [
    // 02 — mobile sidebar drawer open.
    // Runs first while we can still resize cleanly. The hamburger
    // toggle is the topbar's #sb-toggle button.
    {
      filename: '02-sidebar.png',
      goto: '/member.html#/member/profile',
      viewport: { width: 375, height: 812 },
      setup: async (page) => {
        await page.waitForSelector('#sb-toggle', { timeout: 5000 });
        await page.click('#sb-toggle');
        // Wait for sidebar slide-in animation.
        await page.waitForTimeout(600);
      },
    },

    // 03 — profile read-only strip.
    {
      filename: '03-profile-strip.png',
      goto: '/member.html#/member/profile',
      setup: async (page) => {
        await page.waitForSelector('.profile-readonly-strip', { timeout: 8000 });
        await page.evaluate(() => window.scrollTo(0, 0));
      },
    },

    // 04 — full profile page (read-only strip + every form section).
    // Captured as fullPage so the PDF can crop or annotate any section
    // without re-running the screenshot pass. At desktop width the
    // entire form fits in one viewport, so a scroll-then-snap wouldn't
    // differ from shot 03 — fullPage is the meaningful variation.
    {
      filename: '04-profile-form.png',
      fullPage: true,
      setup: async (page) => {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(200);
      },
    },

    // 05 — study-level dropdown focused (native <select> can't be
    // visually "opened" in a portable way, but focus shows the
    // focus ring which is the next-best visual).
    {
      filename: '05-profile-dropdowns.png',
      setup: async (page) => {
        const sel = await page.$('#pf-study_level');
        if (sel) {
          await sel.scrollIntoViewIfNeeded();
          await sel.focus();
        }
        await page.waitForTimeout(200);
      },
    },

    // 06 — opportunities list.
    {
      filename: '06-opps-list.png',
      goto: '/member.html#/member/opportunities',
      setup: async (page) => {
        await page.waitForSelector('#opps-tbody tr', { timeout: 8000 });
      },
    },

    // 07 — pick-role modal open with motivation filled.
    // The seed registered demo_member's interest on the upcoming opp,
    // so the first row in the list shows "withdraw". For shot 07 we
    // need an EXPRESS button — withdraw the existing interest first
    // to expose one. Shot 08's setup re-registers if needed.
    {
      filename: '07-pick-role-modal.png',
      goto: '/member.html#/member/opportunities',
      setup: async (page) => {
        await page.waitForSelector('#opps-tbody tr', { timeout: 8000 });
        const expressOnPage = await page.$('[data-action="openPickRoleModal"]');
        if (!expressOnPage) {
          const wd = await page.$('[data-action="withdrawInterest"]');
          if (wd) {
            await wd.click();
            await page.waitForTimeout(1500);
          }
        }
        const express = await page.waitForSelector('[data-action="openPickRoleModal"]', { timeout: 6000 });
        await express.click();
        await page.waitForSelector('#ov-pick-role.open', { timeout: 5000 });
        const anyRadio = await page.$('input[name="pickrole-choice"][value="__any__"]');
        if (anyRadio) await anyRadio.check();
        await page.fill('#pickrole-motivation', 'تجربة المعدات الجاهزة + خبرة سابقة في تغطية الفعاليات الطلابية.');
      },
      teardown: async (page) => {
        const closeBtn = await page.$('[data-action="closePickRoleModal"]');
        if (closeBtn) await closeBtn.click();
        await page.waitForTimeout(400);
      },
    },

    // 08 — after-register state. Re-submits the interest if the
    // previous shot's teardown didn't restore it.
    {
      filename: '08-opps-after-register.png',
      goto: '/member.html#/member/opportunities',
      setup: async (page) => {
        await page.waitForSelector('#opps-tbody tr', { timeout: 8000 });
        const hasWithdraw = await page.$('[data-action="withdrawInterest"]');
        if (!hasWithdraw) {
          const express = await page.$('[data-action="openPickRoleModal"]');
          if (express) {
            await express.click();
            await page.waitForSelector('#ov-pick-role.open', { timeout: 5000 });
            const any = await page.$('input[name="pickrole-choice"][value="__any__"]');
            if (any) await any.check();
            await page.click('[data-action="submitPickRole"]');
            await page.waitForTimeout(2000);
          }
        }
      },
    },

    // 09 — assignments tab.
    {
      filename: '09-assignments-upcoming.png',
      goto: '/member.html#/member/assignments',
      setup: async (page) => {
        await page.waitForTimeout(1000);
      },
    },

    // 10 — log-hours modal open + filled.
    {
      filename: '10-log-hours-modal.png',
      setup: async (page) => {
        const btn = await page.$('[data-action="openLogHours"]');
        if (btn) {
          await btn.click();
          await page.waitForSelector('#ov-log-hours.open', { timeout: 5000 });
          await page.fill('#logh-before', '0');
          await page.fill('#logh-during', '2');
          await page.fill('#logh-after',  '0');
        }
      },
      teardown: async (page) => {
        const closeBtn = await page.$('[data-action="closeLogHoursModal"]');
        if (closeBtn) await closeBtn.click();
        await page.waitForTimeout(300);
      },
    },

    // 11 — hours list.
    {
      filename: '11-hours-list.png',
      goto: '/member.html#/member/hours',
      setup: async (page) => {
        await page.waitForTimeout(1000);
      },
    },

    // 12 — sidebar bottom (language toggle).
    {
      filename: '12-lang-toggle.png',
      goto: '/member.html#/member/profile',
      setup: async (page) => {
        await page.evaluate(() => {
          const langRow = document.querySelector('.lang-toggle');
          if (langRow) langRow.scrollIntoView({ block: 'end' });
        });
        await page.waitForTimeout(300);
      },
    },

    // 13 — support modal open.
    {
      filename: '13-support-modal.png',
      setup: async (page) => {
        const btn = await page.$('[data-action="openSupportModal"]');
        if (btn) {
          await btn.click();
          await page.waitForSelector('#ov-support.open', { timeout: 5000 });
        }
      },
      teardown: async (page) => {
        const closeBtn = await page.$('#ov-support [data-action="closeModal"][data-modal="support"]');
        if (closeBtn) await closeBtn.click();
        await page.waitForTimeout(300);
      },
    },
  ],
};
