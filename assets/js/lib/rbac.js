// ================================================================
//  RBAC — Role Based Access Control
//  superadmin = يشوف كل شيء
//  head       = يشوف لجنته فقط + المشاريع + التقارير
// ================================================================
//
// Reads `window.CURRENT_USER` (populated by the auth guard in main.js)
// and `DB.members` / `DB.committees` to resolve "my committee". Lives in
// lib/ because every tab module needs it for at-render filtering and the
// shared init code calls applyUIRestrictions() once.

import { DB } from './state.js';

export const RBAC = {
  isSuperAdmin() {
    return window.CURRENT_USER?.access === 'superadmin';
  },

  isHead() {
    return window.CURRENT_USER?.access === 'head';
  },

  // committee_id للمستخدم الحالي (لرؤساء اللجان)
  myCommitteeId() {
    if (!window.CURRENT_USER) return null;
    // نبحث عن العضو في DB للحصول على committee_id
    const m = DB.members.find(mb => mb.member_id === window.CURRENT_USER.id);
    return m ? m.committee_id : null;
  },

  // هل يمكن رؤية هذه الصفحة؟
  canSeePage(page) {
    if (this.isSuperAdmin()) return true;
    // رؤساء اللجان: يشوفون كل شيء عدا المستشارين. تبويب الحسابات متاح لهم
    // (مع تصفية إلى أعضاء لجنتهم فقط) لإعادة تعيين كلمات المرور.
    const restricted = ['advisors'];
    return !restricted.includes(page);
  },

  // فلترة الأعضاء حسب الصلاحية
  filterMembers(members) {
    if (this.isSuperAdmin()) return members;
    // رئيس اللجنة يرى أعضاء لجنته فقط + نفسه
    const myId  = window.CURRENT_USER?.id;
    const myCom = this.myCommitteeId();
    if (!myCom) return members.filter(m => m.member_id === myId);
    return members.filter(m => m.committee_id === myCom || m.member_id === myId);
  },

  // فلترة اللجان
  filterCommittees(committees) {
    if (this.isSuperAdmin()) return committees;
    const myCom = this.myCommitteeId();
    if (!myCom) return [];
    return committees.filter(c => c.committee_id === myCom);
  },

  // إخفاء العناصر التي لا يملك صلاحيتها
  applyUIRestrictions() {
    if (this.isSuperAdmin()) return; // سوبر أدمن يشوف كل شيء

    // إخفاء بعض خيارات الـ sidebar (المستشارون للسوبر أدمن فقط؛
    // تبويب الحسابات متاح للرؤساء بنطاق لجنتهم)
    const hidePages = ['advisors'];
    hidePages.forEach(page => {
      const el = document.querySelector(`[data-page="${page}"]`);
      if (el) el.style.display = 'none';
    });

    // إخفاء أزرار الحذف لرؤساء اللجان
    document.querySelectorAll('.btn-icon.del, .bic.d').forEach(btn => {
      btn.style.display = 'none';
    });

    // إخفاء أزرار الإضافة/التعديل للعناصر الكبيرة
    const hideBtns = ['#page-committees .btn-g', '#page-projects .btn-g'];
    hideBtns.forEach(sel => {
      const el = document.querySelector(sel);
      if (el) el.style.display = 'none';
    });

    // تغيير نص الترحيب في الـ sidebar
    const role = document.getElementById('sb-role') || document.getElementById('sb-rl');
    if (role) {
      const myCom = this.myCommitteeId();
      const com   = DB.committees.find(c => c.committee_id === myCom);
      if (com) role.textContent = com.committee_name;
    }
  },

  // تطبيق بادج "لجنتي" على صفحة الأعضاء
  injectMyTeamBadge() {
    if (this.isSuperAdmin()) return;
    const pg = document.getElementById('page-members');
    if (!pg || pg.querySelector('.my-team-badge')) return;
    const myCom = this.myCommitteeId();
    const com   = DB.committees.find(c => c.committee_id === myCom);
    if (!com) return;
    const badge = document.createElement('div');
    badge.className = 'my-team-badge';
    badge.style.cssText = 'background:var(--gl);border:1.5px solid var(--g);border-radius:var(--rs);padding:.6rem 1rem;margin-bottom:1rem;font-size:.8rem;font-weight:700;color:var(--gd);display:flex;align-items:center;gap:.5rem;';
    badge.innerHTML = `🏛️ تعرض أعضاء لجنتك فقط: <span style="color:var(--g)">${com.committee_name}</span>`;
    pg.insertBefore(badge, pg.firstChild);
  },
};
