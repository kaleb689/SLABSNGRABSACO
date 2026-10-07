(() => {
  if (window.self !== window.top || new URLSearchParams(location.search).get("successDemo") === "1") return;
  const installed = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {});
  }

  if (!installed) {
    const header = document.querySelector(".main-nav");
    if (header) {
      let installPrompt;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "nav-link pwa-install-button";
      button.textContent = "Install App";
      header.append(button);
      window.addEventListener("beforeinstallprompt", event => { event.preventDefault(); installPrompt = event; });
      window.addEventListener("appinstalled", () => { button.hidden = true; installPrompt = null; });
      button.addEventListener("click", async () => {
        if (installPrompt) {
          const prompt = installPrompt;
          installPrompt = null;
          try { await prompt.prompt(); await prompt.userChoice; } catch { showInstructions(); }
        } else showInstructions();
      });
      function showInstructions() {
        const dialog = document.createElement("dialog");
        dialog.className = "pwa-install-dialog";
        dialog.setAttribute("aria-labelledby", "pwa-install-title");
        const heading = document.createElement("h2");
        heading.id = "pwa-install-title";
        heading.textContent = "Install Slabs N Grabs ACO";
        const intro = document.createElement("p");
        intro.textContent = "Add our free web app to your Home Screen for quick access to your account, profiles and live updates.";
        const instructions = document.createElement("p");
        const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
        instructions.textContent = ios
          ? "On iPhone or iPad: open this site in Safari, tap Share, choose Add to Home Screen, turn on Open as Web App if shown, then tap Add."
          : /Android/.test(navigator.userAgent)
            ? "On Android: open this site in Chrome, open the menu (⋮), choose Install app or Add to Home screen, then confirm."
            : "In Chrome or Edge, use the install icon in the address bar or the browser’s app installation menu. In Safari on Mac, choose File → Add to Dock.";
        const note = document.createElement("p");
        note.className = "fine";
        note.textContent = "Uses your existing website account. An internet connection is required. No Apple membership or App Store download is needed.";
        const close = document.createElement("button");
        close.type = "button";
        close.className = "pwa-install-close";
        close.textContent = "×";
        close.setAttribute("aria-label", "Close installation instructions");
        close.addEventListener("click", () => dialog.close());
        dialog.addEventListener("close", () => { dialog.remove(); button.focus(); });
        dialog.addEventListener("click", event => {
          const box = dialog.getBoundingClientRect();
          if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) dialog.close();
        });
        dialog.append(close, heading, intro, instructions, note);
        document.body.append(dialog);
        dialog.showModal();
        close.focus();
      }
    }
    return;
  }

  document.body.classList.add("installed-app");
  const nav = document.createElement("nav");
  nav.className = "pwa-bottom-nav";
  nav.setAttribute("aria-label", "App navigation");
  const destinations = [
    ["Home", "home", "⌂", ""], ["Pricing", "pricing", "◇", ""],
    ["Profile", "my-profile", "◎", "membership"],
    ["Success", "my-profile", "✓", "success"], ["Guide", "guide", "?", ""]
  ];
  for (const [label, page, icon, accountTab] of destinations) {
    const link = document.createElement("a");
    link.href = `#${page}`;
    link.dataset.page = page;
    link.dataset.accountTab = accountTab;
    const glyph = document.createElement("span");
    glyph.textContent = icon;
    glyph.setAttribute("aria-hidden", "true");
    link.append(glyph, document.createTextNode(label));
    link.addEventListener("click", () => {
      if (accountTab) setTimeout(() => {
        document.querySelector(`button[data-account-tab="${accountTab}"]`)?.click();
        sync();
      }, 0);
    });
    nav.append(link);
  }
  document.body.append(nav);
  function sync() {
    const page = location.hash.slice(1) || "home";
    const success = document.querySelector('button[data-account-tab="success"]')?.classList.contains("active");
    for (const link of nav.querySelectorAll("a")) {
      const active = link.dataset.page === page &&
        (page !== "my-profile" || (link.dataset.accountTab === "success") === Boolean(success));
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  }
  window.addEventListener("hashchange", sync);
  document.addEventListener("click", () => setTimeout(sync, 0));
  sync();
})();
