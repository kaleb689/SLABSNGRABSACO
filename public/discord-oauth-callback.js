// Runs on the same-origin return page, where the site's script policy allows external files.
try {
  const payload = JSON.parse(document.getElementById("discord-callback-payload")?.textContent || "{}");
  if (window.opener && !window.opener.closed) {
    window.opener.postMessage(payload, window.location.origin);
  }
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel("slabsngrabsaco-discord-connection");
    channel.postMessage(payload);
    channel.close();
  }
  window.close();
  const message = document.getElementById("discord-callback-message");
  if (message) message.textContent = "Discord verification finished. You can close this tab and return to SLABSNGRABSACO.";
} catch {
  const message = document.getElementById("discord-callback-message");
  if (message) message.textContent = "Please close this tab and return to SLABSNGRABSACO.";
}
