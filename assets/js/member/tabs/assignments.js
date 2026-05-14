// Assignments tab — stub for sub-phase 5b. Full implementation in 5c
// (calls assignments.listOwn, splits Upcoming vs Past by event_date,
// renders into two separate tables).

export async function loadAssignments() {
  const up = document.getElementById('assignments-upcoming-tbody');
  const pa = document.getElementById('assignments-past-tbody');
  if (up) up.innerHTML = '<tr class="empty-row"><td colspan="5">قيد التطوير — Phase 5c</td></tr>';
  if (pa) pa.innerHTML = '<tr class="empty-row"><td colspan="5">—</td></tr>';
}
