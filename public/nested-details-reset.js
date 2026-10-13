// Closing a section closes its nested sections, including ones added after load.
// Does not remove form values, saved records, or the parent itself.
(() => {
  "use strict";
  document.addEventListener("toggle", event => {
    const parent = event.target;
    if (!(parent instanceof HTMLDetailsElement) || parent.open) return;
    for (const nested of parent.querySelectorAll("details[open]")) nested.open = false;
  }, true);
})();
