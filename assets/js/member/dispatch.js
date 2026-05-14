// Event delegation for the member portal.
//
// Direct copy of the admin/dispatch.js pattern (same delegation strategy,
// same per-event filter, same warn-on-missing-handler behaviour). Kept
// as a separate module rather than imported from admin/ for two reasons:
//   1. The handlers map is wired by member/main.js — sharing the
//      delegation module would mean main.js has to coordinate two
//      handlers maps (admin's + member's), which is more error-prone
//      than just keeping the modules parallel.
//   2. Member portal will likely grow extra event types (touch gestures
//      for swipe-between-tabs?) that admin doesn't need.
//
// If the two files ever diverge by less than 10% over a long period we
// can DRY them into a lib/dispatch.js. Until then duplication is cheaper.

let _handlers = {};
export function setHandlers(h) { _handlers = h; }

const EVENTS = ['click', 'change', 'input', 'submit'];

export function setupDispatch(root = document) {
  EVENTS.forEach(eventType => {
    root.addEventListener(eventType, (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const expected = el.dataset.event || defaultEventFor(el);
      if (eventType !== expected) return;

      const action = el.dataset.action;
      const handler = _handlers[action];
      if (!handler) {
        console.warn(`[member-dispatch] No handler registered for data-action="${action}"`);
        return;
      }
      try {
        handler(el, e);
      } catch (err) {
        console.error(`[member-dispatch] Handler "${action}" threw:`, err);
      }
    });
  });
}

function defaultEventFor(el) {
  const tag = el.tagName;
  if (tag === 'FORM') return 'submit';
  if (tag === 'INPUT') {
    const type = el.type;
    if (type === 'checkbox' || type === 'radio') return 'change';
    return 'change';
  }
  if (tag === 'SELECT' || tag === 'TEXTAREA') return 'change';
  return 'click';
}
