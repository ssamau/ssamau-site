# PDF Guides — production prep

Three guides to produce (member / head / admin), screenshot-driven
rather than text-heavy. Builds on the existing `docs/admin-guide.html`
print template, but each new guide leads with a screenshot per
screen and uses short captions + numbered callouts only.

This doc has three parts:

1. **What screenshots are needed per guide** — the script.
2. **Test accounts + seed data** — what to create so screenshots
   never leak real member info.
3. **Chrome-agent prompt** — paste verbatim into a Claude agent that
   has Chrome MCP tools.

---

## Part 1 — What screenshots are needed

Filenames follow the pattern `<order>-<area>-<state>.png`. Save them to
`docs/screenshots/<kind>/`. The PDF builder I'll write later will pick
them up automatically by filename, so the order prefix matters.

### Member guide (≈12 pages)

| # | Filename | Screen | Captured as |
|---|---|---|---|
| 01 | `01-login.png` | login.html — empty form | (any) |
| 02 | `02-sidebar.png` | member.html sidebar opened on mobile width (375px) | demo_member |
| 03 | `03-profile-strip.png` | My Profile tab — top read-only strip | demo_member |
| 04 | `04-profile-form.png` | My Profile tab — full form (personal + study) | demo_member |
| 05 | `05-profile-dropdowns.png` | Study section showing the new translated `<select>` dropdowns open | demo_member |
| 06 | `06-opps-list.png` | Opportunities tab — at least 1 upcoming opp | demo_member |
| 07 | `07-pick-role-modal.png` | Pick-role modal open on an opportunity, motivation textarea visible | demo_member |
| 08 | `08-opps-after-register.png` | Same opportunities tab after registering — chip + withdraw button | demo_member |
| 09 | `09-assignments-upcoming.png` | Assignments tab — at least one upcoming assignment | demo_member |
| 10 | `10-log-hours-modal.png` | Log-hours modal open | demo_member |
| 11 | `11-hours-list.png` | Hours tab — Draft + Approved rows | demo_member |
| 12 | `12-lang-toggle.png` | Sidebar bottom, language toggle pill visible | demo_member |
| 13 | `13-support-modal.png` | Support modal open with Bug/Feature/Question chips | demo_member |

### Head guide (≈16 pages)

Everything from the member guide (heads also have all those tabs)
PLUS:

| # | Filename | Screen | Captured as |
|---|---|---|---|
| 20 | `20-head-sidebar.png` | head.html full sidebar — every tab visible | demo_head |
| 21 | `21-head-dashboard.png` | Head dashboard (counts + recent activity) | demo_head |
| 22 | `22-head-members.png` | Members tab — committee roster + new role/status filters | demo_head |
| 23 | `23-head-member-profile.png` | Member-profile modal showing hours + invite buttons | demo_head |
| 24 | `24-head-invite-modal.png` | Invite modal — email vs PIN tabs | demo_head |
| 25 | `25-head-opps-create.png` | Inline create-opportunity form opened | demo_head |
| 26 | `26-head-opps-assign.png` | Assignments modal for an opportunity | demo_head |
| 27 | `27-head-other-opps.png` | Other-opportunities tab with at least one cross-committee opp | demo_head |
| 28 | `28-head-other-pick-role.png` | The head's own pick-role modal | demo_head |
| 29 | `29-head-hours-approve.png` | Hours tab showing the ✅ primary-approve button | demo_head |
| 30 | `30-head-attendance.png` | Attendance modal — project mode | demo_head |
| 31 | `31-head-apps.png` | Applications tab scoped to committee | demo_head |
| 32 | `32-head-emails.png` | Emails / thanks tab | demo_head |
| 33 | `33-head-certs.png` | Certificates tab | demo_head |

### Admin guide (≈22 pages)

Supersedes the existing `admin-guide.html`. Captures every admin tab
plus presidency-only flows.

| # | Filename | Screen | Captured as |
|---|---|---|---|
| 40 | `40-admin-sidebar.png` | admin.html sidebar — all 17 tabs visible | demo_admin |
| 41 | `41-admin-dashboard.png` | Dashboard — KPI cards + charts | demo_admin |
| 42 | `42-admin-members.png` | Members tab — search + role + status filters | demo_admin |
| 43 | `43-admin-member-modal.png` | Add/edit member modal | demo_admin |
| 44 | `44-admin-apps-list.png` | Applications tab list (new NID column visible) | demo_admin |
| 45 | `45-admin-apps-review.png` | Application review modal expanded | demo_admin |
| 46 | `46-admin-accounts.png` | Accounts tab — search + access + last-login filters | demo_admin |
| 47 | `47-admin-account-modal.png` | + إضافة حساب modal | demo_admin |
| 48 | `48-admin-pw-shown.png` | "password shown once" modal after reset (use a demo account) | demo_admin |
| 49 | `49-admin-advisors.png` | Advisors tab — status + role filters | demo_admin |
| 50 | `50-admin-committees.png` | Committees tab | demo_admin |
| 51 | `51-admin-projects.png` | Projects tab — at least 2 projects | demo_admin |
| 52 | `52-admin-project-photo.png` | Project edit modal with cover-photo uploader | demo_admin |
| 53 | `53-admin-participants.png` | Participants tab | demo_admin |
| 54 | `54-admin-opps-multi-role.png` | Opportunity modal in CREATE mode showing **two** role rows + "+ إضافة دور" | demo_admin |
| 55 | `55-admin-opps-list.png` | Opportunities tab list — role column shows "Role A (+1 more)" | demo_admin |
| 56 | `56-admin-opp-assign.png` | Assignments modal — attendance dropdown open | demo_admin |
| 57 | `57-admin-opp-notify.png` | Notify modal — three radio modes visible | demo_admin |
| 58 | `58-admin-attendance.png` | Attendance tab | demo_admin |
| 59 | `59-admin-bulk-att.png` | Bulk-attendance modal grid | demo_admin |
| 60 | `60-admin-hours.png` | Hours tab showing primary + final approve buttons | demo_admin |
| 61 | `61-admin-interest.png` | Interest tab with new member-committee column + datetime + motivation comment | demo_admin |
| 62 | `62-admin-interest-assign.png` | "Assign from interest" modal | demo_admin |
| 63 | `63-admin-emails.png` | Emails tab + bulk-thanks modal | demo_admin |
| 64 | `64-admin-cert-issue.png` | Certificate issue subtab | demo_admin |
| 65 | `65-admin-cert-list.png` | Certificate list subtab | demo_admin |
| 66 | `66-admin-cert-preview.png` | Cert preview opened in new tab (the A4 verify-cert page) | demo_admin |
| 67 | `67-admin-support.png` | Support inbox (superadmin only — use a superadmin acc if needed) | superadmin |
| 68 | `68-admin-my-profile.png` | Admin's own My Profile tab | demo_admin |

---

## Part 2 — Test accounts + seed data

**Goal**: every screenshot in the guides shows clearly-fake "demo" data
so no real member's name, email, NID, or hours leak into the public
PDF. Create everything once; you can leave it sitting in prod (it
won't interfere with real data since it's scoped to a Demo committee).

### Step 1 — Create one demo committee

Admin → Committees tab → + إضافة لجنة:
- **Name (Arabic)**: لجنة تجريبية
- **Name (English)**: Demo Committee
- **Description**: للتوثيق فقط — لا تنشر بيانات حقيقية هنا

Leave head/vice empty for now — fill in after you create the head member below.

### Step 2 — Create six demo members

Admin → Members tab → + إضافة عضو. Use the exact data below so every
screenshot has consistent test data:

| # | Full name (AR) | NID | Email | Phone | Gender | Committee | Role | Status |
|---|---|---|---|---|---|---|---|---|
| 1 | تجريبي مدير | 1000000001 | demo+admin@ssamau.com | +966500000001 | ذكر | (none) | Vice President | Active |
| 2 | تجريبي رئيس | 1000000002 | demo+head@ssamau.com | +966500000002 | ذكر | لجنة تجريبية | Committee Head | Active |
| 3 | تجريبي نائب | 1000000003 | demo+vice@ssamau.com | +966500000003 | ذكر | لجنة تجريبية | Committee Vice Head | Active |
| 4 | تجريبي عضو | 1000000004 | demo+member@ssamau.com | +966500000004 | أنثى | لجنة تجريبية | Member | Active |
| 5 | تجريبي عضو ٢ | 1000000005 | demo+member2@ssamau.com | +966500000005 | ذكر | لجنة تجريبية | Member | Active |
| 6 | تجريبي متطوع | 1000000006 | demo+volunteer@ssamau.com | +966500000006 | أنثى | (none) | Volunteer | Active |

For all six: DOB `2000-01-01`, address `123 Demo St, Melbourne`,
University `Deakin University`, Study level `Bachelor`, Scholarship
`companion_student`, Study started `>1y`.

After member #2 (head) exists, go back to the Committees tab and set
"Demo Committee" head = `تجريبي رئيس`, vice head = `تجريبي نائب`.

### Step 3 — Create accounts for each demo member

Admin → Accounts tab → + إضافة حساب for each of the six:

| # | Username | Access level | Linked member |
|---|---|---|---|
| 1 | `demo_admin` | admin | تجريبي مدير |
| 2 | `demo_head` | head | تجريبي رئيس |
| 3 | `demo_vicehead` | head | تجريبي نائب |
| 4 | `demo_member` | member | تجريبي عضو |
| 5 | `demo_member2` | member | تجريبي عضو ٢ |
| 6 | `demo_volunteer` | volunteer | تجريبي متطوع |

Use the same password for all six (e.g. `Demo2026!`) so the agent
doesn't need a credential matrix. **Note the password down.**

### Step 4 — Create two demo projects

Admin → Projects tab:

**Project 1 (upcoming):**
- Name: `فعالية تجريبية — يوم العلم`
- Date: 2026-08-15 (or any future date)
- Location: `Melbourne CBD`
- Type: `Event`
- Owning committee: `لجنة تجريبية`

**Project 2 (past):**
- Name: `ورشة تجريبية — مهارات تطوعية`
- Date: 2026-03-10 (any past date)
- Location: `Online`
- Type: `Workshop`
- Owning committee: `لجنة تجريبية`

### Step 5 — Create two demo opportunities

Admin → Opportunities tab → + إضافة فرصة:

**Opportunity 1 (multi-role, upcoming):**
- Project: `فعالية تجريبية — يوم العلم`
- Owning committee: `🌍 كل اللجان` (so members in any committee can register interest)
- Status: Open
- **Two roles:**
  - Role 1: name `منسق استقبال`, est_hours 3, headcount 2
  - Role 2: name `مصوّر`, est_hours 4, headcount 1

**Opportunity 2 (single role, past):**
- Project: `ورشة تجريبية — مهارات تطوعية`
- Owning committee: `لجنة تجريبية`
- Status: Done
- One role: name `منسق تسجيل`, est_hours 2, headcount 1

### Step 6 — Create one interest registration

Log in as `demo_member` → Opportunities tab → click "اهتمام" on
Opportunity 1 → pick role `منسق استقبال` → fill in the motivation
textarea with: `أحب التواصل مع الناس وعندي خبرة في تنظيم الفعاليات الجامعية.`

### Step 7 — Create one assignment + attendance + hours

Log back in as `demo_admin`:

1. Opportunities tab → Opportunity 2 (past) → 👥 → assign
   `تجريبي عضو` → mark attendance `Attended`.
2. Hours tab → confirm there's a Draft hours row for that assignment.
   Primary-approve it → Final-approve it. Now you have at least one
   `FinalApproved` row to screenshot.

### Step 8 — Issue a demo certificate

Admin → Certificates tab → Issue:
- Project: `ورشة تجريبية — مهارات تطوعية`
- Member: `تجريبي عضو`
- Click "Issue".

Now `60-admin-hours.png`, `61-admin-interest.png`,
`65-admin-cert-list.png`, etc. all have at least one row of real-shaped
demo data.

### Optional — One demo application

If you want the Applications-tab screenshots to look populated:
public site → apply.html → submit with name `تجريبي متقدم`, NID
`1000000007`, scholarship `companion_student`. Leaves you with one
`PendingTriage` row.

---

## Part 3 — Chrome-agent prompt

Paste this into your Chrome-enabled Claude agent. Replace
`<PRODUCTION_URL>` and `<DEMO_PASSWORD>` before sending.

```
You are taking screenshots of an Arabic admin portal for SSAM (Saudi
Students Association in Melbourne) for a user-facing PDF guide.

## Setup

- **Production URL**: <PRODUCTION_URL> (e.g. https://ssamau.com)
- **Demo password** (same for all test accounts): <DEMO_PASSWORD>
- **Viewport**: 1440×900 desktop for everything EXCEPT screenshot 02
  (`02-sidebar.png`) which uses 375×812 mobile.
- **Language**: Arabic (sidebar → language pill → switch if needed).
- **Theme**: Light (sidebar → theme row → 🌞 button).
- **Output path**: save each screenshot to
  `/Users/faisal/Desktop/SSAMAU Website/ssamau-site/docs/screenshots/<kind>/<filename>.png`
  where `<kind>` is `member`, `head`, or `admin`. Create the
  directories if they don't exist.

## Workflow per account

For each of the three accounts (demo_member, demo_head, demo_admin):

1. Open <PRODUCTION_URL>/login.html in a fresh tab.
2. Sign in with the username + DEMO_PASSWORD.
3. Take every screenshot listed in the section for that account.
4. Click 🚪 (logout) at the bottom of the sidebar.
5. Verify you've landed back on login.html before moving to the next
   account.

## Screenshot-quality rules

- **Full window** (not full page) unless the screen explicitly says
  "scroll first".
- **Clean state**: no toasts visible, no modals half-open. If a toast
  appears from a previous action, wait until it fades before shooting.
- **No personal data on screen**: every account/member/project/cert
  in the screenshots should be a "تجريبي ..." entity. If you see a
  real-looking name, STOP and tell the user.
- **Hover/focus reset**: click somewhere neutral (the page background)
  before each screenshot so no button is in a hover state.

## Member screenshots — log in as `demo_member`

1. `01-login.png` — Before logging in, capture the login page.
   Username field empty, password field empty.

2. `02-sidebar.png` — After login, resize browser to 375×812 (mobile).
   Tap the hamburger to open the sidebar drawer. Capture. Resize back
   to 1440×900.

3. `03-profile-strip.png` — Click "ملفي الشخصي" in the sidebar. Wait
   for the form to render. Capture just the top portion (the
   read-only strip + first row of form fields).

4. `04-profile-form.png` — Same page, scroll down so the "الدراسة
   والابتعاث" section is fully visible. Capture.

5. `05-profile-dropdowns.png` — Click the المرحلة الدراسية dropdown
   to open it. Capture with the dropdown open.

6. `06-opps-list.png` — Click "الفرص التطوعية" in sidebar. Should
   show 1+ opportunity. Capture.

7. `07-pick-role-modal.png` — Click "اهتمام" on opportunity 1
   (فعالية تجريبية). The pick-role modal opens. Pick "مصوّر" role.
   Type into the motivation textarea: "تجربة المعدات الجاهزة + خبرة
   سابقة في تغطية الفعاليات الطلابية." Do NOT click submit. Capture.

8. `08-opps-after-register.png` — Close the modal without saving. If
   demo_member already has an interest from earlier seed step,
   capture the opportunities list with the role chip + withdraw
   button visible.

9. `09-assignments-upcoming.png` — Click "مهامي" in sidebar. Capture.

10. `10-log-hours-modal.png` — Click "تسجيل ساعات" on the past
    assignment. Modal opens. Fill before=0 during=2 after=0. Capture.

11. `11-hours-list.png` — Close modal without submitting. Click
    "ساعاتي" in sidebar. Capture.

12. `12-lang-toggle.png` — Scroll the sidebar to the bottom. Capture
    just the language pill row + theme pill row.

13. `13-support-modal.png` — Click the 💬 support icon in the sidebar.
    Modal opens. Click the "🐞 بلاغ خلل" tab. Capture.

14. Logout. Verify you're on login.html.

## Head screenshots — log in as `demo_head`

20. `20-head-sidebar.png` — Capture sidebar with all 9 head tabs
    visible.

21. `21-head-dashboard.png` — Default landing tab. Capture.

22. `22-head-members.png` — Members tab. Open the role filter
    dropdown once to confirm it works, then close. Capture the
    populated list with filters visible at the top.

23. `23-head-member-profile.png` — Click the 👤 button on
    `تجريبي عضو`. Modal opens with stats + hours history. Capture.

24. `24-head-invite-modal.png` — Close. Click the 📩 invite button on
    a member who hasn't joined yet (or refresh + use the resend 🔄
    icon if all are joined). Modal opens with email / PIN choice.
    Capture without sending.

25. `25-head-opps-create.png` — Opportunities tab → click "+ إضافة
    فرصة" to open the inline create form. Capture.

26. `26-head-opps-assign.png` — Close. Click the 👥 button on
    Opportunity 2 (the past one). Assignments modal opens. Capture.

27. `27-head-other-opps.png` — "فرص أخرى" tab in sidebar. Should
    show cross-committee opportunities. Capture.

28. `28-head-other-pick-role.png` — Click "اهتمام" on any row. The
    pick-role modal opens. Capture without submitting.

29. `29-head-hours-approve.png` — Hours tab. Should show
    `Draft` rows from members in your committee. Capture with the ✅
    primary-approve button visible.

30. `30-head-attendance.png` — Attendance tab → click "+ تسجيل حضور".
    Modal opens. Capture in project-mode (the default).

31. `31-head-apps.png` — Applications tab (committee-scoped).
    Capture.

32. `32-head-emails.png` — Emails tab. Capture.

33. `33-head-certs.png` — Certificates tab. Capture.

34. Logout.

## Admin screenshots — log in as `demo_admin`

40. `40-admin-sidebar.png` — Capture sidebar with all 17 tabs
    visible.

41. `41-admin-dashboard.png` — Dashboard. Capture.

42. `42-admin-members.png` — Members tab. Capture with search +
    filters at the top.

43. `43-admin-member-modal.png` — Click "+ إضافة عضو". Modal opens.
    Capture empty (don't fill).

44. `44-admin-apps-list.png` — Applications tab. Capture — the new
    "رقم الهوية" column should be visible.

45. `45-admin-apps-review.png` — Click ✏️ on the pending demo
    application. Detail modal opens. Capture.

46. `46-admin-accounts.png` — Accounts tab. Open the access filter
    once to confirm it works, close. Capture the populated list.

47. `47-admin-account-modal.png` — Click "+ إضافة حساب". Modal opens.
    Capture empty.

48. `48-admin-pw-shown.png` — Close. Find any demo account row, click
    the 🔑 reset button → confirm. The "password shown" modal opens.
    Capture (the demo password is fine to show — it's not real).

49. `49-admin-advisors.png` — Advisors tab. Capture.

50. `50-admin-committees.png` — Committees tab. Capture.

51. `51-admin-projects.png` — Projects tab. Should show both demo
    projects. Capture.

52. `52-admin-project-photo.png` — Click ✏️ on a demo project. Modal
    opens. Capture with the cover-photo uploader visible.

53. `53-admin-participants.png` — Participants tab. Capture.

54. `54-admin-opps-multi-role.png` — Opportunities tab → "+ إضافة
    فرصة". Modal opens with one role row. Click "+ إضافة دور" to add
    a second row. Capture.

55. `55-admin-opps-list.png` — Close. Capture the opportunities tab
    list — the role column on the multi-role demo opportunity should
    read "Role A (+1 more)".

56. `56-admin-opp-assign.png` — Click 👥 on the multi-role
    opportunity. Assignments modal opens. Pick the attendance
    dropdown of an assignment (open the dropdown). Capture.

57. `57-admin-opp-notify.png` — Close. Click 📧 on the same
    opportunity. Notify modal opens with three radio modes (all /
    members / emails). Capture.

58. `58-admin-attendance.png` — Attendance tab. Capture.

59. `59-admin-bulk-att.png` — Click "⚡ جماعي". Bulk grid opens.
    Pick the demo project. Capture.

60. `60-admin-hours.png` — Hours tab. Should show the demo Hours
    rows from earlier seed step. Capture with primary + final
    approve buttons visible.

61. `61-admin-interest.png` — Interest tab. Should show the demo
    interest registration. Capture — note the new "لجنة العضو"
    column + datetime in the date column + motivation in the
    comment column.

62. `62-admin-interest-assign.png` — Click "إسناد" on the demo
    interest row. Modal opens. Capture.

63. `63-admin-emails.png` — Emails tab. Click "⚡ إرسال جماعي" to
    open the bulk-thanks modal. Capture.

64. `64-admin-cert-issue.png` — Close. Certificates tab → click
    "🏅 إصدار شهادة" subtab. Capture.

65. `65-admin-cert-list.png` — Click "📋 الشهادات الصادرة" subtab.
    The demo cert should appear. Capture.

66. `66-admin-cert-preview.png` — Click 👁️ on the demo cert row. A
    new tab opens with the verify-cert page rendered. Capture that
    new tab.

67. `67-admin-support.png` — Back to admin. If your demo_admin has
    superadmin tier, click 💬 in sidebar. Otherwise skip and tell
    the user this needs a superadmin pass later.

68. `68-admin-my-profile.png` — Click "ملفي الشخصي" in sidebar.
    Capture.

69. Logout.

## Final check

After all screenshots are saved, list every PNG you produced with
its size + dimensions, grouped by `kind`. Flag any screenshot where:
- the file size is < 50 KB (probably blank/broken)
- you saw real-looking member data on screen
- a step couldn't be completed (and why)
```

---

## Part 4 — What happens after screenshots arrive

Once you have all the `*.png` files in `docs/screenshots/<kind>/`,
ping me and I'll build three HTML templates (one per guide) that
embed the screenshots in print-friendly A4 layout. Then we
`@page size: A4; print → save as PDF` and they live alongside the
existing `admin-guide.pdf` in `docs/`.

Each PDF page will be:

```
┌────────────────────────────────────────┐
│  [section ribbon — "٤. ملف العضو"]    │
│                                        │
│  ┌──────────────────────────────────┐  │
│  │                                  │  │
│  │   [screenshot]                   │  │
│  │                                  │  │
│  └──────────────────────────────────┘  │
│                                        │
│  📍 1. اختر تبويب «ملفي»               │
│  📍 2. ابدأ بتعبئة الحقول              │
│  📍 3. اضغط «حفظ التعديلات»            │
└────────────────────────────────────────┘
```

About 80% image, 20% caption — what you asked for.
