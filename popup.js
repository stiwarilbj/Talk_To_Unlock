(function initializePopup() {
  'use strict';

  const {
    DEFAULT_SITES,
    createSiteRule,
    normalizeSite
  } = globalThis.TalkToUnlockUtils;
  const elements = {
    customDuration: document.querySelector('#custom-duration'),
    customMinutes: document.querySelector('#custom-minutes'),
    demoAction: document.querySelector('#demo-action'),
    demoCopy: document.querySelector('#demo-copy'),
    enabled: document.querySelector('#enabled'),
    focusAction: document.querySelector('#focus-action'),
    focusChip: document.querySelector('#focus-chip'),
    focusHeading: document.querySelector('#focus-heading'),
    focusRemaining: document.querySelector('#focus-remaining'),
    finishOnboarding: document.querySelector('#finish-onboarding'),
    main: document.querySelector('#main-content'),
    onboarding: document.querySelector('#onboarding-panel'),
    onboardingCustomSite: document.querySelector('#onboarding-custom-site'),
    onboardingForm: document.querySelector('#onboarding-form'),
    onboardingMessage: document.querySelector('#onboarding-message'),
    protectionLabel: document.querySelector('#protection-label'),
    ruleList: document.querySelector('#rule-list'),
    siteChoices: document.querySelector('#site-choices'),
    toast: document.querySelector('#toast'),
    welcomeCopy: document.querySelector('#welcome-copy'),
    welcomeTitle: document.querySelector('#welcome-title')
  };
  let state = null;
  let selectedMinutes = 25;
  let focusTimer = 0;
  let toastTimer = 0;
  let demoTimer = 0;
  let demoRemaining = 10;
  let demoTried = false;

  function send(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!response?.ok) reject(new Error(response?.error || 'Something went wrong.'));
        else resolve(response);
      });
    });
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
  }

  function showToast(message, tone = 'success') {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.dataset.tone = tone;
    elements.toast.dataset.visible = 'true';
    toastTimer = window.setTimeout(() => { elements.toast.dataset.visible = 'false'; }, 2600);
  }

  function friendlySiteName(hostname) {
    const known = { 'youtube.com': 'YouTube', 'instagram.com': 'Instagram', 'reddit.com': 'Reddit', 'tiktok.com': 'TikTok', 'x.com': 'X', 'facebook.com': 'Facebook' };
    return known[hostname] || hostname.split('.')[0].replace(/(^|[-_])\w/g, (value) => value.replace(/[-_]/, '').toUpperCase());
  }

  function methodLabel(method) {
    return { pause: 'Pause', voice: 'Phrase', blocked: 'Blocked' }[method] || 'Pause';
  }

  function formatDuration(seconds) {
    const minutes = Math.max(0, Math.round(Number(seconds) / 60));
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
  }

  function renderOnboardingChoices() {
    const selected = new Set([...elements.siteChoices.querySelectorAll('input:checked')].map((input) => input.value));
    elements.siteChoices.innerHTML = DEFAULT_SITES.slice(0, 4).map((hostname) => `<label><input type="checkbox" value="${hostname}" ${selected.has(hostname) ? 'checked' : ''}><span>${friendlySiteName(hostname)}</span></label>`).join('');
  }

  function renderRules(settings, summary) {
    const rules = settings.siteRules.filter((rule) => rule.enabled).slice(0, 4);
    elements.ruleList.replaceChildren();
    if (!rules.length) {
      const empty = document.createElement('li');
      empty.className = 'empty-rules';
      empty.textContent = 'Your list is empty. Add a site when you are ready.';
      elements.ruleList.append(empty);
      return;
    }
    rules.forEach((rule) => {
      const item = document.createElement('li');
      item.className = 'rule-row';
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.setAttribute('aria-label', `Edit ${friendlySiteName(rule.hostname)} rule`);
      item.innerHTML = `<span class="rule-icon" aria-hidden="true">${escapeHtml(friendlySiteName(rule.hostname).slice(0, 2))}</span><span class="rule-copy"><strong>${escapeHtml(friendlySiteName(rule.hostname))}</strong><span>${escapeHtml(rule.hostname)}</span></span><span class="rule-status">${methodLabel(rule.method)}${rule.dailyAllowanceMinutes !== null ? ` · ${Math.max(0, rule.dailyAllowanceMinutes - Math.floor((summary.todayUsage[rule.id] || 0) / 60))}m left` : ''}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"></path></svg>`;
      const open = () => openDashboard('sites', rule.id);
      item.addEventListener('click', open);
      item.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
      elements.ruleList.append(item);
    });
  }

  function renderFocus(activeFocus) {
    clearInterval(focusTimer);
    if (!activeFocus) {
      elements.focusHeading.textContent = 'Ready when you are';
      elements.focusAction.dataset.active = 'false';
      elements.focusAction.querySelector('span:last-child').textContent = 'Start focusing';
      elements.focusAction.querySelector('.button-icon').textContent = '▶';
      elements.focusRemaining.textContent = '';
      elements.focusChip.textContent = selectedMinutes === 25 || selectedMinutes === 50 ? `${selectedMinutes} min` : `${selectedMinutes} min`;
      document.querySelector('.duration-picker').hidden = false;
      return;
    }
    document.querySelector('.duration-picker').hidden = true;
    elements.customDuration.hidden = true;
    elements.focusHeading.textContent = 'Focus is on';
    elements.focusAction.dataset.active = 'true';
    elements.focusAction.querySelector('span:last-child').textContent = 'End session';
    elements.focusAction.querySelector('.button-icon').textContent = '■';
    elements.focusChip.textContent = `${activeFocus.durationMinutes} min`;
    const tick = () => {
      const seconds = Math.max(0, Math.ceil((activeFocus.endsAt - Date.now()) / 1000));
      const minutes = Math.floor(seconds / 60);
      elements.focusRemaining.textContent = seconds ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s remaining` : 'Finishing up…';
      if (!seconds) load().catch(() => {});
    };
    tick();
    focusTimer = window.setInterval(tick, 1000);
  }

  function render(response) {
    state = response;
    const { settings, summary } = response;
    elements.enabled.checked = settings.enabled;
    elements.protectionLabel.textContent = settings.enabled ? 'Protection on' : 'Protection off';
    if (summary.protectionPausedUntil > Date.now()) {
      elements.protectionLabel.textContent = 'Protection paused';
      elements.welcomeTitle.textContent = 'A little breather.';
      elements.welcomeCopy.textContent = 'Protection is paused for now. Turn it back on whenever you are ready.';
    } else {
      elements.welcomeTitle.textContent = settings.enabled ? 'Make a little room.' : 'Protection is taking a break.';
      elements.welcomeCopy.textContent = settings.enabled ? 'Your chosen sites wait behind a friendly pause.' : 'Turn protection on when you want a little help with scrolling.';
    }
    renderRules(settings, summary);
    renderFocus(summary.activeFocus);
    const fresh = response.onboardingCompleted !== true && settings.siteRules.length === 0;
    elements.main.hidden = fresh;
    elements.onboarding.hidden = !fresh;
    if (fresh) renderOnboardingChoices();
  }

  async function load() {
    render(await send({ type: 'TTU_GET_DASHBOARD' }));
  }

  async function openDashboard(section, ruleId = '') {
    try {
      await send({ type: 'TTU_OPEN_DASHBOARD', section, ruleId });
      if (!document.documentElement.classList.contains('ttu-preview')) window.close();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  function startDemo() {
    if (demoTimer) return;
    demoRemaining = 10;
    elements.demoAction.disabled = true;
    elements.demoAction.textContent = '10s';
    elements.demoCopy.textContent = 'Take ten seconds. You can still stop anytime.';
    const tick = () => {
      elements.demoAction.textContent = demoRemaining ? `${demoRemaining}s` : 'Done';
      elements.demoCopy.textContent = demoRemaining ? `${demoRemaining} second${demoRemaining === 1 ? '' : 's'} left.` : 'Nice. That is all a pause needs to be.';
      if (!demoRemaining) {
        clearInterval(demoTimer);
        demoTimer = 0;
        demoTried = true;
        elements.demoAction.disabled = false;
        return;
      }
      demoRemaining -= 1;
    };
    tick();
    demoTimer = window.setInterval(tick, 1000);
  }

  function completeOnboarding() {
    return send({ type: 'TTU_COMPLETE_ONBOARDING' });
  }

  document.querySelectorAll('[data-open]').forEach((button) => button.addEventListener('click', () => openDashboard(button.dataset.open)));
  document.querySelectorAll('.duration').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('.duration').forEach((entry) => entry.classList.toggle('active', entry === button));
    if (button.dataset.minutes === 'custom') {
      elements.customDuration.hidden = false;
      elements.customMinutes.focus();
      selectedMinutes = Math.min(240, Math.max(5, Number(elements.customMinutes.value) || 75));
    } else {
      elements.customDuration.hidden = true;
      selectedMinutes = Number(button.dataset.minutes);
    }
    elements.focusChip.textContent = `${selectedMinutes} min`;
  }));
  elements.customMinutes.addEventListener('input', () => {
    selectedMinutes = Math.min(240, Math.max(5, Number(elements.customMinutes.value) || 5));
    elements.focusChip.textContent = `${selectedMinutes} min`;
  });
  elements.enabled.addEventListener('change', async () => {
    const enabled = elements.enabled.checked;
    try {
      await send({ type: 'TTU_SET_ENABLED', enabled });
      await load();
      showToast(enabled ? 'Protection turned on.' : 'Protection turned off.');
    } catch (error) {
      elements.enabled.checked = !enabled;
      showToast(error.message, 'error');
    }
  });
  elements.focusAction.addEventListener('click', async () => {
    elements.focusAction.disabled = true;
    try {
      if (state?.summary.activeFocus) {
        await send({ type: 'TTU_STOP_FOCUS' });
        showToast('Focus session ended.');
      } else {
        await send({ type: 'TTU_START_FOCUS', minutes: selectedMinutes });
        showToast(`${selectedMinutes}-minute focus session started.`);
      }
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      elements.focusAction.disabled = false;
    }
  });
  elements.demoAction.addEventListener('click', startDemo);
  elements.onboardingForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    elements.onboardingMessage.textContent = '';
    const chosen = [...elements.siteChoices.querySelectorAll('input:checked')].map((input) => input.value);
    const customValue = elements.onboardingCustomSite.value.trim();
    if (customValue) {
      const custom = normalizeSite(customValue);
      if (!custom) { elements.onboardingMessage.textContent = 'That website address needs a little adjustment. Try example.com.'; elements.onboardingCustomSite.focus(); return; }
      chosen.push(custom);
    }
    const uniqueSites = [...new Set(chosen)];
    const method = new FormData(elements.onboardingForm).get('onboarding-method') || 'pause';
    const next = structuredClone(state.settings);
    uniqueSites.filter((hostname) => !next.siteRules.some((rule) => rule.hostname === hostname)).forEach((hostname) => next.siteRules.push(createSiteRule(hostname, { method, phrase: next.defaultPhrase, voiceLevel: next.defaultVoiceLevel, fallbackSeconds: next.defaultFallbackSeconds })));
    elements.finishOnboarding.disabled = true;
    try {
      await send({ type: 'TTU_SAVE_SETTINGS', settings: next });
      await completeOnboarding();
      await load();
      showToast(uniqueSites.length ? 'Your pause places are ready.' : 'You can add sites anytime.');
    } catch (error) {
      elements.onboardingMessage.textContent = error.message;
    } finally {
      elements.finishOnboarding.disabled = false;
    }
  });
  document.querySelector('#skip-onboarding').addEventListener('click', async () => {
    try { await completeOnboarding(); await load(); showToast('No problem. Add a site whenever you are ready.'); }
    catch (error) { elements.onboardingMessage.textContent = error.message; }
  });

  load().catch((error) => showToast(error.message || 'Could not load Little Pause.', 'error'));
})();
