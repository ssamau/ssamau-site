// Head-portal screenshot spec — runs as `demo_head`.
// See shots-member.mjs for the spec shape.

export default {
  username: 'demo_head',
  shots: [
    // 20 — full sidebar with all 9 head tabs visible.
    {
      filename: '20-head-sidebar.png',
      goto: '/head.html#/head/dashboard',
      setup: async (page) => {
        await page.waitForSelector('.sb-item', { timeout: 8000 });
        await page.waitForTimeout(500);
      },
    },

    // 21 — head dashboard.
    {
      filename: '21-head-dashboard.png',
      goto: '/head.html#/head/dashboard',
      setup: async (page) => {
        await page.waitForTimeout(1000);
      },
    },

    // 22 — members tab with role + status filters visible.
    {
      filename: '22-head-members.png',
      goto: '/head.html#/head/members',
      setup: async (page) => {
        await page.waitForSelector('#hd-members-tbody', { timeout: 8000 });
        await page.waitForTimeout(800);
      },
    },

    // 23 — member profile modal.
    // Wait for the modal's CONTENT to materialize, not just the open
    // class — the data fetch (getMemberHours) is async so the modal
    // body starts as a loading spinner. Capture only after the
    // profile-hero element (which the success path renders) appears.
    {
      filename: '23-head-member-profile.png',
      setup: async (page) => {
        const btn = await page.$('xpath=//tbody[@id="hd-members-tbody"]//tr[contains(., "تجريبي")]//button[@data-action="hd.members.viewProfile"]');
        if (!btn) throw new Error('demo member view button not found');
        await btn.click();
        await page.waitForSelector('#ov-hd-profile.open', { timeout: 5000 });
        // Wait for the hours-fetch to complete + the hero markup to
        // replace the "جاري التحميل..." placeholder.
        await page.waitForSelector('#hd-prof-content .profile-hero', { timeout: 8000 });
        await page.waitForTimeout(400);
      },
      teardown: async (page) => {
        const close = await page.$('#ov-hd-profile [data-action="closeModal"][data-modal="hd-profile"]');
        if (close) await close.click();
        await page.waitForTimeout(300);
      },
    },

    // 24 — invite modal (email vs PIN).
    // The seed creates "تجريبي مدعو" (Demo Invitee) — a member with
    // no portal account — so the 📩 first-invite button is reachable
    // ONLY on that row. Click it specifically.
    {
      filename: '24-head-invite-modal.png',
      goto: '/head.html#/head/members',
      setup: async (page) => {
        await page.waitForSelector('#hd-members-tbody', { timeout: 8000 });
        // Find the invitee's row, then the invite button inside it.
        // (Other demo members already have accounts so they only show
        // the resend 🔄 button — we want the first-invite path here.)
        const invite = await page.$('xpath=//tbody[@id="hd-members-tbody"]//tr[contains(., "تجريبي مدعو")]//button[@data-action="hd.members.invite.open"]');
        if (!invite) {
          throw new Error('demo invitee row / invite button not found — re-run seed');
        }
        await invite.click();
        await page.waitForSelector('#ov-member-invite.open', { timeout: 5000 });
        // Wait for the modal body to populate (the invitee name is
        // written into #invite-member-name asynchronously).
        await page.waitForFunction(() => {
          const el = document.getElementById('invite-member-name');
          return el && el.textContent.trim().length > 0;
        }, { timeout: 5000 });
      },
      teardown: async (page) => {
        const close = await page.$('#ov-member-invite [data-action="closeModal"][data-modal="member-invite"]');
        if (close) await close.click();
        await page.waitForTimeout(300);
      },
    },

    // 24b — new "Projects/Events" head tab (committee-scoped).
    {
      filename: '24b-head-projects.png',
      goto: '/head.html#/head/projects',
      setup: async (page) => {
        await page.waitForSelector('#hd-projects-tbody', { state: 'attached', timeout: 8000 });
        await page.waitForTimeout(1000);
      },
    },

    // 24c — head's project create modal (empty form).
    {
      filename: '24c-head-project-modal.png',
      setup: async (page) => {
        const btn = await page.$('[data-action="hd.projects.openCreate"]');
        if (!btn) throw new Error('hd.projects.openCreate button missing');
        await btn.click();
        await page.waitForSelector('#ov-hd-project.open', { timeout: 5000 });
      },
      teardown: async (page) => {
        const close = await page.$('#ov-hd-project [data-action="closeModal"][data-modal="hd-project"]');
        if (close) await close.click();
        await page.waitForTimeout(300);
      },
    },

    // 25 — inline create-opportunity form open.
    {
      filename: '25-head-opps-create.png',
      goto: '/head.html#/head/opportunities',
      setup: async (page) => {
        // The opportunities .page div sits hidden until the router
        // activates it — default `waitForSelector` waits for visible
        // which can race the router. Wait for ATTACHED (in DOM) and
        // give the router time to flip display:block.
        await page.waitForSelector('#hd-opps-create-form', { state: 'attached', timeout: 8000 });
        await page.waitForTimeout(1000);
        const toggle = await page.$('[data-action="toggleOpportunityCreateForm"]');
        if (toggle) {
          const form = await page.$('#hd-opps-create-form');
          const visible = form && (await form.evaluate(el => el.style.display !== 'none'));
          if (!visible) await toggle.click();
        }
        await page.waitForTimeout(500);
      },
      teardown: async (page) => {
        // Close the inline form so it doesn't bleed into the next shot.
        const toggle = await page.$('[data-action="toggleOpportunityCreateForm"]');
        if (toggle) {
          const form = await page.$('#hd-opps-create-form');
          const visible = form && (await form.evaluate(el => el.style.display !== 'none'));
          if (visible) await toggle.click();
        }
      },
    },

    // 26 — assignments modal for an opportunity.
    {
      filename: '26-head-opps-assign.png',
      setup: async (page) => {
        const assign = await page.$('[data-action="hd.opps.assign.open"]');
        if (assign) {
          await assign.click();
          await page.waitForSelector('#ov-hd-opp-assign.open', { timeout: 5000 });
        }
      },
      teardown: async (page) => {
        const close = await page.$('#ov-hd-opp-assign [data-action="closeModal"][data-modal="hd-opp-assign"]');
        if (close) await close.click();
        await page.waitForTimeout(300);
      },
    },

    // 27 — "other opportunities" tab (cross-committee).
    {
      filename: '27-head-other-opps.png',
      goto: '/head.html#/head/other-opportunities',
      setup: async (page) => {
        await page.waitForSelector('#hd-other-opps-tbody', { timeout: 8000 });
        await page.waitForTimeout(800);
      },
    },

    // 28 — head's pick-role modal on a cross-committee opp.
    {
      filename: '28-head-other-pick-role.png',
      setup: async (page) => {
        const express = await page.$('[data-action="hd.other.openPick"]');
        if (express) {
          await express.click();
          await page.waitForSelector('#ov-pick-role.open', { timeout: 5000 });
          const any = await page.$('input[name="hd-pickrole-choice"][value="__any__"]');
          if (any) await any.check();
          await page.fill('#hd-pickrole-motivation', 'استعدد للمساعدة في تنسيق الفرص بين اللجان.');
        }
      },
      teardown: async (page) => {
        const close = await page.$('[data-action="hd.other.closePick"]');
        if (close) await close.click();
        await page.waitForTimeout(300);
      },
    },

    // 29 — hours tab showing ✅ primary-approve button.
    {
      filename: '29-head-hours-approve.png',
      goto: '/head.html#/head/hours',
      setup: async (page) => {
        await page.waitForTimeout(1000);
      },
    },

    // 30 — attendance modal (project mode).
    {
      filename: '30-head-attendance.png',
      goto: '/head.html#/head/attendance',
      setup: async (page) => {
        const openBtn = await page.$('[data-action="hd.attendance.open"]');
        if (openBtn) {
          await openBtn.click();
          await page.waitForSelector('#ov-hd-att.open', { timeout: 5000 });
        }
      },
      teardown: async (page) => {
        const close = await page.$('[data-action="hd.attendance.close"]');
        if (close) await close.click();
        await page.waitForTimeout(300);
      },
    },

    // 31 — applications tab (committee-scoped).
    {
      filename: '31-head-apps.png',
      goto: '/head.html#/head/applications',
      setup: async (page) => {
        await page.waitForTimeout(1000);
      },
    },

    // 32 — emails tab.
    {
      filename: '32-head-emails.png',
      goto: '/head.html#/head/emails',
      setup: async (page) => {
        await page.waitForTimeout(1000);
      },
    },

    // 33 — certificates tab.
    {
      filename: '33-head-certs.png',
      goto: '/head.html#/head/certificates',
      setup: async (page) => {
        await page.waitForTimeout(1000);
      },
    },
  ],
};
