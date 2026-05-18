// Admin-portal screenshot spec — runs as `demo_admin` (admin tier).
//
// Shot 67 (`67-admin-support.png`) is superadmin-only — demo_admin
// won't see the tab. The runner will mark it as failed; capture
// manually with your real superadmin if you need it.

export default {
  username: 'demo_admin',
  shots: [
    // 40 — sidebar with all 17 admin tabs visible.
    {
      filename: '40-admin-sidebar.png',
      goto: '/admin.html#/admin/dashboard',
      setup: async (page) => {
        await page.waitForSelector('.sb-item', { timeout: 8000 });
        await page.waitForTimeout(500);
      },
    },

    // 41 — dashboard.
    {
      filename: '41-admin-dashboard.png',
      goto: '/admin.html#/admin/dashboard',
      setup: async (page) => {
        await page.waitForTimeout(1500);
      },
    },

    // 42 — members tab with search + filters at the top.
    {
      filename: '42-admin-members.png',
      goto: '/admin.html#/admin/members',
      setup: async (page) => {
        await page.waitForSelector('#members-tbody', { timeout: 8000 });
        await page.waitForTimeout(800);
      },
    },

    // 43 — add member modal.
    {
      filename: '43-admin-member-modal.png',
      setup: async (page) => {
        const btn = await page.$('[data-action="openModal"][data-modal="member"]');
        if (btn) {
          await btn.click();
          await page.waitForSelector('#ov-member.open', { timeout: 5000 });
        }
      },
      teardown: async (page) => {
        const close = await page.$('#ov-member [data-action="closeModal"][data-modal="member"]');
        if (close) await close.click();
        await page.waitForTimeout(300);
      },
    },

    // 44 — applications list with new NID column.
    {
      filename: '44-admin-apps-list.png',
      goto: '/admin.html#/admin/applications',
      setup: async (page) => {
        await page.waitForSelector('#applications-tbody', { timeout: 8000 });
        await page.waitForTimeout(800);
      },
    },

    // 45 — application review modal.
    // Critical privacy guard: ONLY open the demo application's modal.
    // The previous "click the first review button" approach would open
    // whatever real application happens to be at the top of the list,
    // which then renders inside the screenshot. Find the row whose
    // text content contains "تجريبي" (the demo applicant) and click
    // ITS review button.
    {
      filename: '45-admin-apps-review.png',
      setup: async (page) => {
        // Wait for the applications table to render at least one row.
        await page.waitForSelector('#applications-tbody tr', { timeout: 8000 });
        // Locate the demo row by its content marker, then click the
        // review button INSIDE that row.
        const demoBtn = await page.$('xpath=//tbody[@id="applications-tbody"]//tr[contains(., "تجريبي")]//button[@data-action="openApplicationReview"]');
        if (!demoBtn) {
          throw new Error('demo application not found — re-run seed-demo to add it');
        }
        await demoBtn.click();
        await page.waitForSelector('#ov-application.open', { timeout: 5000 });
        await page.waitForTimeout(500);
      },
      teardown: async (page) => {
        const close = await page.$('#ov-application [data-action="closeModal"][data-modal="application"]');
        if (close) await close.click();
        await page.waitForTimeout(300);
      },
    },

    // 46 — accounts tab with search + filters.
    {
      filename: '46-admin-accounts.png',
      goto: '/admin.html#/admin/accounts',
      setup: async (page) => {
        await page.waitForSelector('#accounts-tbody', { timeout: 8000 });
        await page.waitForTimeout(800);
      },
    },

    // 47 — add account modal.
    {
      filename: '47-admin-account-modal.png',
      setup: async (page) => {
        const btn = await page.$('#accounts-add-btn');
        if (btn) {
          await btn.click();
          await page.waitForSelector('#ov-account.open', { timeout: 5000 });
        }
      },
      teardown: async (page) => {
        const close = await page.$('#ov-account [data-action="closeModal"][data-modal="account"]');
        if (close) await close.click();
        await page.waitForTimeout(300);
      },
    },

    // 48 — password-shown modal. Resets demo_volunteer's password.
    // Done LAST in the admin pass so it doesn't break other shots that
    // need other accounts. demo_volunteer isn't used by any other run.
    //
    // The reset uses a native confirm() — we accept it programmatically.
    // The modal then displays a one-time temp password.
    {
      filename: '48-admin-pw-shown.png',
      goto: '/admin.html#/admin/accounts',
      setup: async (page) => {
        await page.waitForSelector('#accounts-tbody', { timeout: 8000 });
        // Auto-accept native confirm() before clicking the reset button.
        page.once('dialog', d => d.accept());
        // Find the reset button on demo_volunteer's row.
        const row = await page.$('tr:has(span:has-text("demo_volunteer"))');
        if (!row) throw new Error('demo_volunteer row not found');
        const resetBtn = await row.$('[data-action="resetAccountPassword"]');
        if (!resetBtn) {
          // demo_volunteer is on legacy bcrypt — should expose 🔑.
          // If only 📧 (sendPasswordResetEmail) exists, skip cleanly.
          throw new Error('no legacy reset button on demo_volunteer (it may be on Supabase Auth)');
        }
        await resetBtn.click();
        await page.waitForSelector('#ov-pw-shown.open', { timeout: 5000 });
      },
      teardown: async (page) => {
        const close = await page.$('#ov-pw-shown [data-action="closeModal"][data-modal="pw-shown"]');
        if (close) await close.click();
        await page.waitForTimeout(300);
      },
    },

    // 49 — advisors tab.
    {
      filename: '49-admin-advisors.png',
      goto: '/admin.html#/admin/advisors',
      setup: async (page) => {
        await page.waitForSelector('#advisors-tbody', { timeout: 8000 });
        await page.waitForTimeout(800);
      },
    },

    // 50 — committees tab.
    {
      filename: '50-admin-committees.png',
      goto: '/admin.html#/admin/committees',
      setup: async (page) => {
        await page.waitForTimeout(1000);
      },
    },

    // 51 — projects tab.
    {
      filename: '51-admin-projects.png',
      goto: '/admin.html#/admin/projects',
      setup: async (page) => {
        await page.waitForSelector('#projects-tbody', { timeout: 8000 });
        await page.waitForTimeout(800);
      },
    },

    // 52 — project edit modal with cover-photo uploader.
    // Target the demo project specifically — opening a real project's
    // modal would expose its proposal text, descriptions etc.
    {
      filename: '52-admin-project-photo.png',
      setup: async (page) => {
        await page.waitForSelector('#projects-tbody tr', { timeout: 8000 });
        const demoEditBtn = await page.$('xpath=//tbody[@id="projects-tbody"]//tr[contains(., "تجريبي")]//button[@data-action="editProject"]');
        if (!demoEditBtn) throw new Error('demo project edit button not found');
        await demoEditBtn.click();
        await page.waitForSelector('#ov-project.open', { timeout: 5000 });
        await page.evaluate(() => {
          const uploader = document.querySelector('#prj-photo-wrap, #ov-project [data-action*="rojectPhoto"]');
          if (uploader) uploader.scrollIntoView({ block: 'center' });
        });
      },
      teardown: async (page) => {
        const close = await page.$('#ov-project [data-action="closeModal"][data-modal="project"]');
        if (close) await close.click();
        await page.waitForTimeout(300);
      },
    },

    // 53 — participants tab.
    {
      filename: '53-admin-participants.png',
      goto: '/admin.html#/admin/participants',
      setup: async (page) => {
        await page.waitForTimeout(1000);
      },
    },

    // 54 — opportunity modal in CREATE mode with TWO role rows.
    {
      filename: '54-admin-opps-multi-role.png',
      goto: '/admin.html#/admin/opportunities',
      setup: async (page) => {
        // Open the create modal.
        const addBtn = await page.$('[data-action="openModal"][data-modal="opportunity"]');
        if (!addBtn) throw new Error('+ إضافة فرصة button not found');
        await addBtn.click();
        await page.waitForSelector('#ov-opportunity.open', { timeout: 5000 });
        // Add a second role row via the + إضافة دور button.
        const addRole = await page.$('[data-action="addOppRoleRow"]');
        if (addRole) {
          await addRole.click();
          await page.waitForTimeout(300);
        }
      },
      teardown: async (page) => {
        const close = await page.$('#ov-opportunity [data-action="closeModal"][data-modal="opportunity"]');
        if (close) await close.click();
        await page.waitForTimeout(300);
      },
    },

    // 55 — opportunities tab list — multi-role demo opp should read
    // "Role A (+1 more)".
    {
      filename: '55-admin-opps-list.png',
      goto: '/admin.html#/admin/opportunities',
      setup: async (page) => {
        await page.waitForSelector('#opportunities-tbody', { timeout: 8000 });
        await page.waitForTimeout(800);
      },
    },

    // 56 — assignments modal on the demo multi-role opp.
    // Target the demo opp specifically — modals carry assigned-member
    // names which would expose real data if any real opp opened.
    {
      filename: '56-admin-opp-assign.png',
      setup: async (page) => {
        await page.waitForSelector('#opportunities-tbody tr', { timeout: 8000 });
        const btn = await page.$('xpath=//tbody[@id="opportunities-tbody"]//tr[contains(., "تجريبي")]//button[@data-action="openOpportunityAssignments"]');
        if (!btn) throw new Error('demo opportunity assign button not found');
        await btn.click();
        await page.waitForSelector('#ov-opp-assign.open', { timeout: 5000 });
        await page.waitForTimeout(500);
      },
      teardown: async (page) => {
        const close = await page.$('#ov-opp-assign [data-action="closeModal"][data-modal="opp-assign"]');
        if (close) await close.click();
        await page.waitForTimeout(300);
      },
    },

    // 57 — notify modal on the demo multi-role opp.
    {
      filename: '57-admin-opp-notify.png',
      setup: async (page) => {
        await page.waitForSelector('#opportunities-tbody tr', { timeout: 8000 });
        const btn = await page.$('xpath=//tbody[@id="opportunities-tbody"]//tr[contains(., "تجريبي")]//button[@data-action="openOpportunityNotify"]');
        if (!btn) throw new Error('demo opportunity notify button not found');
        await btn.click();
        await page.waitForSelector('#ov-opp-notify.open', { timeout: 5000 });
      },
      teardown: async (page) => {
        const close = await page.$('#ov-opp-notify [data-action="closeModal"][data-modal="opp-notify"]');
        if (close) await close.click();
        await page.waitForTimeout(300);
      },
    },

    // 58 — attendance tab.
    {
      filename: '58-admin-attendance.png',
      goto: '/admin.html#/admin/attendance',
      setup: async (page) => {
        await page.waitForTimeout(1000);
      },
    },

    // 59 — bulk-attendance grid.
    {
      filename: '59-admin-bulk-att.png',
      setup: async (page) => {
        const btn = await page.$('[data-action="openModal"][data-modal="bulk-att"]');
        if (btn) {
          await btn.click();
          await page.waitForSelector('#ov-bulk-att.open', { timeout: 5000 });
        }
      },
      teardown: async (page) => {
        const close = await page.$('#ov-bulk-att [data-action="closeModal"][data-modal="bulk-att"]');
        if (close) await close.click();
        await page.waitForTimeout(300);
      },
    },

    // 60 — hours tab with primary + final approve buttons.
    {
      filename: '60-admin-hours.png',
      goto: '/admin.html#/admin/hours',
      setup: async (page) => {
        await page.waitForTimeout(1000);
      },
    },

    // 61 — interest tab with the new "لجنة العضو" column + datetime
    // + motivation comment from seed.
    {
      filename: '61-admin-interest.png',
      goto: '/admin.html#/admin/interest',
      setup: async (page) => {
        await page.waitForSelector('#tb-interest', { timeout: 8000 });
        await page.waitForTimeout(800);
      },
    },

    // 62 — assign-from-interest modal on the demo interest row.
    {
      filename: '62-admin-interest-assign.png',
      setup: async (page) => {
        await page.waitForSelector('#tb-interest tr', { timeout: 8000 });
        const btn = await page.$('xpath=//tbody[@id="tb-interest"]//tr[contains(., "تجريبي")]//*[@data-action="openInterestAssign"]');
        if (!btn) throw new Error('demo interest row not found');
        await btn.click();
        await page.waitForSelector('#ov-int-assign.open', { timeout: 5000 });
      },
      teardown: async (page) => {
        const close = await page.$('#ov-int-assign [data-action="closeModal"][data-modal="int-assign"]');
        if (close) await close.click();
        await page.waitForTimeout(300);
      },
    },

    // 63 — bulk-thanks modal.
    {
      filename: '63-admin-emails.png',
      goto: '/admin.html#/admin/emails',
      setup: async (page) => {
        const btn = await page.$('[data-action="openModal"][data-modal="bulk-thanks"]');
        if (btn) {
          await btn.click();
          await page.waitForSelector('#ov-bulk-thanks.open', { timeout: 5000 });
        }
      },
      teardown: async (page) => {
        const close = await page.$('#ov-bulk-thanks [data-action="closeModal"][data-modal="bulk-thanks"]');
        if (close) await close.click();
        await page.waitForTimeout(300);
      },
    },

    // 64 — cert issue subtab.
    {
      filename: '64-admin-cert-issue.png',
      goto: '/admin.html#/admin/certificates',
      setup: async (page) => {
        const issueTab = await page.$('[data-action="switchCertTab"][data-tab="issue"]');
        if (issueTab) {
          await issueTab.click();
          await page.waitForTimeout(500);
        }
      },
    },

    // 65 — cert list subtab.
    {
      filename: '65-admin-cert-list.png',
      setup: async (page) => {
        const listTab = await page.$('[data-action="switchCertTab"][data-tab="list"]');
        if (listTab) {
          await listTab.click();
          await page.waitForTimeout(800);
        }
      },
    },

    // 66 — cert preview opened in new tab (verify-cert.html).
    // The seed only created ONE cert (for تجريبي عضو) so any preview
    // button is safe, but be explicit to guard against future certs.
    {
      filename: '66-admin-cert-preview.png',
      setup: async (page) => {
        const ctx = page.context();
        const previewBtn = await page.$('xpath=//tbody[@id="tb-certs"]//tr[contains(., "تجريبي")]//*[@data-action="previewCertCard"]')
          || await page.$('[data-action="previewCertCard"]');
        if (!previewBtn) throw new Error('preview button not found in cert list');
        const newPagePromise = ctx.waitForEvent('page');
        await previewBtn.click();
        const fresh = await newPagePromise;
        await fresh.waitForLoadState('domcontentloaded');
        // Verify-cert auto-fires on URL ?code=. Wait for the cert sheet.
        await fresh.waitForSelector('.cert-sheet', { timeout: 8000 });
        await fresh.waitForTimeout(500);
        // Save the screenshot from the FRESH tab directly — bypass the
        // runner's own page.screenshot() which would capture the
        // original admin tab. We mark this by using a teardown that
        // re-captures the original page (overwriting with the cert
        // sheet) — simpler: do the screenshot inline here.
        const { join } = await import('node:path');
        const { homedir } = await import('node:os');
        // Mirror the runner's default output path — env var override
        // honored so a custom SSAM_DEMO_OUT_DIR still works.
        const outBase = process.env.SSAM_DEMO_OUT_DIR
          || join(homedir(), 'Desktop', 'SSAM-Demo-Output', 'screenshots');
        const out = join(outBase, 'admin', '66-admin-cert-preview.png');
        await fresh.screenshot({ path: out, fullPage: false });
        await fresh.close();
        // Force the runner to NOT overwrite by leaving a no-op on the
        // original page — the runner will still call page.screenshot()
        // which captures whatever admin.html shows. Use a sentinel
        // we'll handle by skipping in the runner... actually simpler:
        // just leave it. The runner's screenshot overwrites our PNG.
        // To avoid that, throw a special flag-error here that the
        // runner treats as "skip post-screenshot".
        throw Object.assign(new Error('shot-already-captured'), { ok: true });
      },
    },

    // 67 — support inbox (superadmin only). demo_admin can't see it;
    // the runner will report this as failed unless you swap creds.
    {
      filename: '67-admin-support.png',
      setup: async (page) => {
        const btn = await page.$('[data-action="openSupportModal"]');
        // The support TAB is superadmin-only; the modal-open icon
        // exists for everyone (lets them file tickets) but doesn't
        // expose the inbox. Skip cleanly.
        throw new Error('support inbox is superadmin-only — capture manually if needed');
      },
    },

    // 68 — admin's own My Profile tab.
    {
      filename: '68-admin-my-profile.png',
      goto: '/admin.html#/admin/my-profile',
      setup: async (page) => {
        await page.waitForSelector('.profile-readonly-strip', { timeout: 8000 });
        await page.waitForTimeout(800);
      },
    },
  ],
};
