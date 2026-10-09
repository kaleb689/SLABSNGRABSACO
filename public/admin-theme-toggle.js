(() => {
  const storageKey = 'sng-admin-theme';
  const choose = value => value === 'light' ? 'light' : 'dark';
  let theme = 'dark';
  try { theme = choose(localStorage.getItem(storageKey) || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')); } catch {}
  const apply = () => {
    document.body.dataset.adminTheme = theme;
    document.querySelectorAll('.admin-theme-switch').forEach(button => {
      button.setAttribute('aria-pressed', String(theme === 'light'));
      button.setAttribute('aria-label', theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
      button.innerHTML = theme === 'light' ? '☾ Dark mode' : '☀ Light mode';
    });
  };
  const addToggle = () => {
    if (document.querySelector('.admin-theme-switch')) return;
    const actions = document.querySelector('.admin-head-actions');
    if (!actions) return;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'admin-theme-switch';
    button.addEventListener('click', () => {
      theme = theme === 'light' ? 'dark' : 'light';
      try { localStorage.setItem(storageKey, theme); } catch {}
      apply();
    });
    actions.prepend(button);
    apply();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addToggle);
  else addToggle();
  apply();
})();
