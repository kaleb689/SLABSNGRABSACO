/*
 * Call activateVgsCardNotices only after every ACO card entry, storage, and
 * reveal path uses the Live VGS vault. A visible provider claim before the
 * cutover would be inaccurate. This module is intentionally dormant.
 */
window.activateVgsCardNotices = function activateVgsCardNotices() {
  const stamp = document.getElementById("vgs-home-security-stamp");
  if (stamp) stamp.hidden = false;

  let queued = false;
  const addNotes = () => {
    queued = false;
    document.querySelectorAll('input[name="acoCardNumber"]').forEach(input => {
      if (input.dataset.vgsNoticeAttached === "true") return;
      const note = document.createElement("small");
      note.className = "vgs-card-security-note";
      note.textContent = "Card number stored securely in the VGS vault. Never enter your card CVV here.";
      input.insertAdjacentElement("afterend", note);
      input.dataset.vgsNoticeAttached = "true";
    });
  };

  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(addNotes);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  addNotes();
};
