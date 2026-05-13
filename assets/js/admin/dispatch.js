// Event delegation for the admin panel.
//
// Before this commit, every interactive element used inline `onclick="..."`
// attributes that called window-global functions. That required CSP to
// permit `script-src-attr 'unsafe-inline'` (a loophole for stored-XSS
// payloads injected via member names, project titles, etc.) and forced
// every handler to be re-exported onto `window` from main.js.
//
// After this commit, every element uses `data-action="handlerName"` plus
// any required `data-*` attributes. A single delegated listener at the
// document level catches every click/change/input/submit, walks up to
// find the closest `[data-action]` element, and invokes the named
// handler from a dispatch map.
//
// Handlers in the dispatch map take `(el, event)`:
//   - `el` is the element with data-action set (usually the click target's
//     ancestor — closest() handles nested icons inside buttons)
//   - `event` is the raw DOM event, only used when handlers need to
//     stopPropagation/preventDefault
//
// The dispatch map itself is built in main.js (`setHandlers({...})`)
// after every tab module has been imported, so all handler implementations
// are reachable. setupDispatch() then wires the document-level listeners.
//
// Commit 6 (drops script-src-attr 'unsafe-inline' from CSP) follows
// directly from this — once no inline handlers remain, the CSP exception
// is dead weight.

let _handlers = {};
export function setHandlers(h) { _handlers = h; }

// One delegated listener per event type. Submit + keydown aren't used by
// admin.html today (forms have explicit save buttons, no Enter-submits;
// keyboard handlers are wired by individual JS modules where needed).
// They're listed here so adding a `data-action` to a `<form>` or
// keydown-bearing element Just Works without re-touching this file.
const EVENTS = ['click', 'change', 'input', 'submit'];

export function setupDispatch(root = document) {
  EVENTS.forEach(eventType => {
    root.addEventListener(eventType, (e) => {
      // closest() so nested icons inside a [data-action] button still match.
      const el = e.target.closest('[data-action]');
      if (!el) return;
      // Per-event filter: an element should only fire on its intended event.
      // Many <select>/<input> elements live inside <form>; we don't want
      // their `change`/`input` dispatching as `submit`. Match `data-event`
      // when present, default to "click" otherwise.
      const expected = el.dataset.event || defaultEventFor(el);
      if (eventType !== expected) return;

      const action = el.dataset.action;
      const handler = _handlers[action];
      if (!handler) {
        console.warn(`[dispatch] No handler registered for data-action="${action}"`);
        return;
      }
      try {
        handler(el, e);
      } catch (err) {
        console.error(`[dispatch] Handler "${action}" threw:`, err);
      }
    });
  });
}

// Reasonable defaults so we don't have to put data-event on every element.
// Buttons + anchors + divs/spans → click. Inputs + selects + textareas →
// change (or input, if the attribute explicitly says so via data-event).
// Forms → submit.
function defaultEventFor(el) {
  const tag = el.tagName;
  if (tag === 'FORM') return 'submit';
  if (tag === 'INPUT') {
    const type = el.type;
    // text inputs typically use "input" for live-filter behavior, but
    // we'll trust the explicit data-event override when needed.
    if (type === 'checkbox' || type === 'radio') return 'change';
    return 'change'; // form fields default to change
  }
  if (tag === 'SELECT' || tag === 'TEXTAREA') return 'change';
  return 'click';
}
