// Shared in-memory state for the admin SPA.
//
// `DB` is the single source of truth for the lookup tables that virtually
// every tab needs (members, committees, projects, …). Tabs that fetch their
// own data write back into `DB.<key>` so cross-tab renders (e.g. resolving
// `member_id` → preferred name inside the projects table) just work.
//
// The reference is stable — every consumer imports the same object literal —
// so reassignments like `DB.members = data.data || []` propagate to every
// importer without any pub/sub. Tabs that need to mutate must mutate the
// existing fields rather than reassign DB itself.

export const DB = {
  members:      [],
  advisors:     [],
  committees:   [],
  projects:     [],
  participants: [],
  attendance:   [],
  hours:        [],
  opportunities:[],
};

// ──────────────────────────────────────────────────────────────────────────
// Lookup tables that drive tag colours + Arabic labels in renderers. These
// are the same constants the per-tab modules used to read out of the giant
// main.js scope; living here means a single import wherever they're needed.

export const ROLE_COLORS = {
  'President':           't-o',
  'Vice President':      't-o',
  'Committee Head':      't-g',
  'Committee Vice Head': 't-g',
  'Deputy Vice Head':    't-g',
  'Project Manager':     't-b',
  'Event Manager':       't-b',
  'Member':              't-gr',
  'Volunteer':           't-p',
  'Advisor':             't-y',
};

export const STATUS_COLORS = {
  'Active':    't-g',
  'Inactive':  't-r',
  'Planning':  't-y',
  'Completed': 't-g',
  'Cancelled': 't-r',
  'Present':   't-g',
  'Absent':    't-r',
  'Late':      't-y',
  'Excused':   't-b',
  'Confirmed': 't-g',
  'Pending':   't-y',
  // Opportunity statuses
  'Open':           't-b',
  'Filled':         't-g',
  'NeedsHelp':      't-r',
  'Done':           't-gr',
  // Hours approval (§7)
  'Draft':            't-y',
  'PrimaryApproved':  't-b',
  'FinalApproved':    't-g',
  'Rejected':         't-r',
  // Attendance on assignments
  'Attended':         't-g',
};

// 14 standard roles from the requirements doc §12. The UI offers them as a
// dropdown; the user can also type a custom role_name. role_key is canonical
// (used by reports later); estimated_hours is the *default* — editable per row.
export const STANDARD_ROLES = [
  { key: 'reception_coordinator', name: 'منسق استقبال',          hours: 2.5 },
  { key: 'food_lead',             name: 'مسؤول طعام',            hours: 3.5 },
  { key: 'photographer',          name: 'مصوّر',                 hours: 3.5 },
  { key: 'logistics_coordinator', name: 'منسق لوجستي',           hours: 6.5 },
  { key: 'pre_event_setup',       name: 'تحضير قبلي',            hours: 3 },
  { key: 'cleanup',               name: 'تنظيف وإقفال',          hours: 2 },
  { key: 'general_supervisor',    name: 'مشرف عام',              hours: 9 },
  { key: 'mc',                    name: 'مقدّم برنامج',          hours: 4 },
  { key: 'registration',          name: 'مسؤول تسجيل',           hours: 3 },
  { key: 'av_support',            name: 'دعم فني (صوت وإضاءة)',  hours: 5 },
  { key: 'heritage_display',      name: 'مسؤول عرض تراثي',       hours: 4 },
  { key: 'academy_teacher',       name: 'معلم بالأكاديمية',      hours: 0 },
  { key: 'academy_coordinator',   name: 'منسق أكاديمية',         hours: 0 },
  { key: 'design_media',          name: 'تصميم وإعلام',          hours: 0 },
];
