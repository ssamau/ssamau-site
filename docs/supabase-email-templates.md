# Supabase Auth — branded email templates

Supabase sends three transactional emails directly from its own service
(not via our Edge Function): **password reset**, **email-change
confirmation**, and **magic link**. By default they ship with
Supabase's generic blue-on-white template. The rest of our outbound
mail uses our green/gold letterhead, so the password-reset email
sticks out as visibly off-brand to anyone who clicks "Forgot password".

Fix is dashboard-only: Supabase doesn't expose these templates via SQL
or the management API. Paste the HTML below into:

**Supabase project → Authentication → Email Templates → [template] → Subject + Message body (HTML)**

After pasting, click **Save**.

---

## Variables Supabase substitutes at send time

Supabase's templates support a small set of Go-template-style
placeholders. Confirmed working ones used here:

| Placeholder | What it resolves to |
|---|---|
| `{{ .ConfirmationURL }}` | The signed action URL (reset / verify / sign-in) |
| `{{ .Email }}` | The recipient's email address |
| `{{ .SiteURL }}` | Project's configured Site URL (Auth → URL Configuration) |
| `{{ .Token }}` | The 6-digit OTP code (when OTP flow is enabled) |

If you change the redirect URL on the server side
(`admin.auth.resetPasswordForEmail(email, { redirectTo: ... })`),
Supabase still routes through `{{ .ConfirmationURL }}` first — the
template doesn't need to change.

---

## Template 1: Password reset (Recovery)

**Subject line:** `🔐 إعادة تعيين كلمة المرور — SSAM`

**Message body (HTML):**

```html
<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"></head>
<body dir="rtl" style="margin:0;padding:0;background:#f5f5f5;font-family:'Almarai',Arial,sans-serif;color:#111827;text-align:right">
  <div dir="rtl" style="max-width:560px;margin:24px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.06)">
    <div dir="rtl" style="background:linear-gradient(135deg,#1A5C2E 0%,#0e3a1c 60%,#b8932a 100%);padding:1.6rem 1.4rem;color:#fff;text-align:center">
      <div style="font-size:1.7rem;margin-bottom:.3rem">🔐</div>
      <div style="font-size:1.05rem;font-weight:800">إعادة تعيين كلمة المرور</div>
      <div style="font-size:.72rem;color:rgba(255,255,255,.75);margin-top:.25rem">SSAM — Password reset</div>
    </div>
    <div dir="rtl" style="padding:1.6rem 1.4rem;font-size:.92rem;color:#1f2937;line-height:1.75;text-align:right">
      <p dir="rtl" style="margin:0 0 1rem 0;text-align:right">السلام عليكم،</p>
      <p dir="rtl" style="margin:0 0 1rem 0;text-align:right">
        وصلنا طلب إعادة تعيين كلمة المرور للحساب المرتبط بالبريد:
        <strong style="direction:ltr;display:inline-block">{{ .Email }}</strong>
      </p>
      <p dir="rtl" style="margin:0 0 1rem 0;text-align:right">
        اضغط الزر أدناه لاختيار كلمة مرور جديدة. الرابط صالح لساعة واحدة فقط.
      </p>
      <div style="text-align:center;margin:1.4rem 0">
        <a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#1A5C2E;color:#fff;text-decoration:none;padding:.75rem 1.6rem;border-radius:50px;font-weight:700;font-size:.9rem">
          🔑 إعادة تعيين كلمة المرور
        </a>
      </div>
      <div dir="rtl" style="background:#fffbeb;border-inline-start:4px solid #b8932a;padding:.75rem 1rem;border-radius:6px;margin:1rem 0;font-size:.82rem;line-height:1.7;text-align:right">
        <strong>⚠️ لم تطلب إعادة التعيين؟</strong><br/>
        تجاهل هذه الرسالة — لن يتغير شيء في حسابك ما لم يضغط أحد على الرابط أعلاه.
      </div>
      <p dir="rtl" style="margin:0 0 .5rem 0;text-align:right;font-size:.8rem;color:#6b7280">
        إذا لم يعمل الزر، انسخ هذا الرابط والصقه في المتصفح:<br/>
        <span style="direction:ltr;word-break:break-all;font-family:monospace;font-size:.72rem;color:#1A5C2E">{{ .ConfirmationURL }}</span>
      </p>
    </div>
    <div dir="rtl" style="padding:.95rem 1.4rem;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:.7rem;color:#6b7280;text-align:center">
      <span style="color:#b8932a;font-weight:700">نادي الطلبة السعوديين في ملبورن</span><br/>
      SSAM · Saudi Students Association in Melbourne
    </div>
  </div>
</body></html>
```

---

## Template 2: Email-change confirmation (Change Email Address)

**Subject line:** `✉️ تأكيد تغيير البريد الإلكتروني — SSAM`

**Message body (HTML):**

```html
<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"></head>
<body dir="rtl" style="margin:0;padding:0;background:#f5f5f5;font-family:'Almarai',Arial,sans-serif;color:#111827;text-align:right">
  <div dir="rtl" style="max-width:560px;margin:24px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.06)">
    <div dir="rtl" style="background:linear-gradient(135deg,#1A5C2E 0%,#0e3a1c 60%,#b8932a 100%);padding:1.6rem 1.4rem;color:#fff;text-align:center">
      <div style="font-size:1.7rem;margin-bottom:.3rem">✉️</div>
      <div style="font-size:1.05rem;font-weight:800">تأكيد تغيير البريد الإلكتروني</div>
      <div style="font-size:.72rem;color:rgba(255,255,255,.75);margin-top:.25rem">SSAM — Confirm email change</div>
    </div>
    <div dir="rtl" style="padding:1.6rem 1.4rem;font-size:.92rem;color:#1f2937;line-height:1.75;text-align:right">
      <p dir="rtl" style="margin:0 0 1rem 0;text-align:right">السلام عليكم،</p>
      <p dir="rtl" style="margin:0 0 1rem 0;text-align:right">
        طُلب تحديث البريد الإلكتروني لحسابك في نادي SSAM إلى:
        <strong style="direction:ltr;display:inline-block">{{ .Email }}</strong>
      </p>
      <p dir="rtl" style="margin:0 0 1rem 0;text-align:right">
        اضغط الزر للتأكيد. لن يكتمل التغيير حتى تضغط.
      </p>
      <div style="text-align:center;margin:1.4rem 0">
        <a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#1A5C2E;color:#fff;text-decoration:none;padding:.75rem 1.6rem;border-radius:50px;font-weight:700;font-size:.9rem">
          ✓ تأكيد البريد الجديد
        </a>
      </div>
      <div dir="rtl" style="background:#fffbeb;border-inline-start:4px solid #b8932a;padding:.75rem 1rem;border-radius:6px;margin:1rem 0;font-size:.82rem;line-height:1.7;text-align:right">
        <strong>⚠️ لم تطلب التغيير؟</strong><br/>
        تجاهل هذه الرسالة وتواصل مع الإدارة فوراً — قد يكون حسابك مكشوفاً.
      </div>
    </div>
    <div dir="rtl" style="padding:.95rem 1.4rem;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:.7rem;color:#6b7280;text-align:center">
      <span style="color:#b8932a;font-weight:700">نادي الطلبة السعوديين في ملبورن</span><br/>
      SSAM · Saudi Students Association in Melbourne
    </div>
  </div>
</body></html>
```

---

## Template 3: Magic link (only if you ever enable passwordless sign-in)

Currently not used — the project's auth flow is username + password +
the legacy PIN invite chain. Listed here for completeness in case
magic links get turned on later.

**Subject line:** `🔗 رابط الدخول السريع — SSAM`

```html
<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"></head>
<body dir="rtl" style="margin:0;padding:0;background:#f5f5f5;font-family:'Almarai',Arial,sans-serif;color:#111827;text-align:right">
  <div dir="rtl" style="max-width:560px;margin:24px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.06)">
    <div dir="rtl" style="background:linear-gradient(135deg,#1A5C2E 0%,#0e3a1c 60%,#b8932a 100%);padding:1.6rem 1.4rem;color:#fff;text-align:center">
      <div style="font-size:1.7rem;margin-bottom:.3rem">🔗</div>
      <div style="font-size:1.05rem;font-weight:800">رابط الدخول السريع</div>
      <div style="font-size:.72rem;color:rgba(255,255,255,.75);margin-top:.25rem">SSAM — Magic sign-in link</div>
    </div>
    <div dir="rtl" style="padding:1.6rem 1.4rem;font-size:.92rem;color:#1f2937;line-height:1.75;text-align:right">
      <p dir="rtl" style="margin:0 0 1rem 0;text-align:right">السلام عليكم،</p>
      <p dir="rtl" style="margin:0 0 1rem 0;text-align:right">
        اضغط الزر للدخول مباشرة إلى حسابك بدون كلمة مرور. الرابط صالح لساعة واحدة.
      </p>
      <div style="text-align:center;margin:1.4rem 0">
        <a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#1A5C2E;color:#fff;text-decoration:none;padding:.75rem 1.6rem;border-radius:50px;font-weight:700;font-size:.9rem">
          🚪 الدخول إلى الحساب
        </a>
      </div>
    </div>
    <div dir="rtl" style="padding:.95rem 1.4rem;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:.7rem;color:#6b7280;text-align:center">
      <span style="color:#b8932a;font-weight:700">نادي الطلبة السعوديين في ملبورن</span><br/>
      SSAM · Saudi Students Association in Melbourne
    </div>
  </div>
</body></html>
```

---

## Verification checklist after pasting

1. Save the template in the dashboard.
2. Trigger a real reset from the admin Accounts tab on a test account
   (📧 icon, **not** the 🔑 legacy mint).
3. Check the inbox — should render the green/gold letterhead, not
   Supabase's default.
4. Click the button → should land on `reset-password.html` and let you
   set a new password.

If the template renders as raw HTML in the inbox, double-check the
**Authentication → Email Templates → [template] → "Custom HTML body"**
toggle is enabled (not the plain-text variant).
