(function initializeLittlePauseSite() {
  'use strict';

  document.body.classList.remove('no-js');
  document.querySelectorAll('[data-year]').forEach((element) => { element.textContent = String(new Date().getFullYear()); });

  const navToggle = document.querySelector('[data-nav-toggle]');
  const siteNav = document.querySelector('[data-site-nav]');
  navToggle?.addEventListener('click', () => {
    const open = siteNav?.dataset.open === 'true';
    if (siteNav) siteNav.dataset.open = String(!open);
    navToggle.setAttribute('aria-expanded', String(!open));
  });

  const demo = document.querySelector('[data-demo]');
  if (!demo) return;
  const action = demo.querySelector('[data-demo-action]');
  const clock = demo.querySelector('[data-demo-clock]');
  const copy = demo.querySelector('[data-demo-copy]');
  const status = demo.querySelector('[data-demo-status]');
  let timer = 0;
  let remaining = 10;
  const render = () => {
    if (clock) clock.innerHTML = `${remaining}<small>seconds</small>`;
    if (copy) copy.textContent = remaining ? 'This is a preview — nothing is blocked.' : 'That is the whole idea: ten seconds to choose what comes next.';
    if (status) status.textContent = remaining ? 'A tiny moment for your attention.' : 'Pause complete.';
  };
  action?.addEventListener('click', () => {
    if (timer) return;
    remaining = 10;
    action.disabled = true;
    action.textContent = 'Pausing…';
    render();
    timer = window.setInterval(() => {
      remaining -= 1;
      render();
      if (remaining <= 0) {
        clearInterval(timer);
        timer = 0;
        action.disabled = false;
        action.textContent = 'Try the preview again';
      }
    }, 1000);
  });
})();
