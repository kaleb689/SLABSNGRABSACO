(() => {
  const launch = new URLSearchParams(location.search).get("launch") === "1";
  const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const installButton = document.getElementById("installAdminApp");
  const iosHelp = document.getElementById("iosHelp");
  const installedState = document.getElementById("installedState");
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  }

  if (standalone) {
    if (installButton) installButton.hidden = true;
    if (installedState) installedState.hidden = false;
  }

  if (launch && standalone) {
    location.replace("/admin.html?source=admin-pwa");
    return;
  }

  let deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    deferredPrompt = event;
    if (installButton && !standalone) installButton.hidden = false;
  });

  installButton?.addEventListener("click", async () => {
    if (standalone) {
      location.assign("/admin.html?source=admin-pwa");
      return;
    }
    if (deferredPrompt) {
      deferredPrompt.prompt();
      try { await deferredPrompt.userChoice; } catch {}
      deferredPrompt = null;
      return;
    }
    if (isIos) {
      if (iosHelp) iosHelp.hidden = false;
      return;
    }
    if (iosHelp) {
      iosHelp.hidden = false;
      iosHelp.innerHTML = "Use your browser menu and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.";
    }
  });

  window.addEventListener("appinstalled", () => {
    if (installButton) installButton.hidden = true;
    if (installedState) {
      installedState.hidden = false;
      installedState.textContent = "ADMIN APP INSTALLED";
    }
  });
})();
