(function initializePopup() {
  'use strict';

  const { summarizeSchedule } = globalThis.TalkToUnlockUtils;
  const elements = {
    allowance: document.querySelector('#metric-allowance'),
    allowanceProgress: document.querySelector('#allowance-progress'),
    customDuration: document.querySelector('#custom-duration'),
    customMinutes: document.querySelector('#custom-minutes'),
    enabled: document.querySelector('#enabled'),
    focusAction: document.querySelector('#focus-action'),
    focusRemaining: document.querySelector('#focus-remaining'),
    modeDescription: document.querySelector('#mode-description'),
    modeName: document.querySelector('#mode-name'),
    protectionLabel: document.querySelector('#protection-label'),
    ruleList: document.querySelector('#rule-list'),
    time: document.querySelector('#metric-time'),
    toast: document.querySelector('#toast'),
    unlocks: document.querySelector('#metric-unlocks')
  };
  let dashboard = null;
  let selectedMinutes = 25;
  let timer = 0;
  let toastTimer = 0;

  function send(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!response?.ok) reject(new Error(response?.error || 'Something went wrong.'));
        else resolve(response);
      });
    });
  }

  function showToast(message, tone = 'success') {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.dataset.tone = tone;
    elements.toast.dataset.visible = 'true';
    toastTimer = window.setTimeout(() => { elements.toast.dataset.visible = 'false'; }, 2400);
  }

  function friendlySiteName(hostname) {
    const known = { 'youtube.com': 'YouTube', 'instagram.com': 'Instagram', 'reddit.com': 'Reddit', 'tiktok.com': 'TikTok', 'x.com': 'X', 'facebook.com': 'Facebook' };
    return known[hostname] || hostname.split('.')[0].replace(/(^|[-_])\w/g, (value) => value.replace(/[-_]/, '').toUpperCase());
  }

  function formatDuration(seconds) {
    const minutes = Math.max(0, Math.round(seconds / 60));
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
  }

  function profileDescription(profile) {
    return {
      gentle: 'Timed pauses with a softer path',
      balanced: 'Voice check + timed fallback',
      strict: 'Voice checks without timed fallback'
    }[profile] || '';
  }

  function ruleStatus(rule, usageSeconds = 0) {
    if (rule.dailyAllowanceMinutes !== null) return `${Math.max(0, rule.dailyAllowanceMinutes - Math.floor(usageSeconds / 60))} min left`;
    if (rule.method === 'blocked') return summarizeSchedule(rule) === 'Always active' ? 'Blocked' : summarizeSchedule(rule);
    if (rule.method === 'pause') return `${rule.fallbackSeconds} sec pause`;
    return rule.cooldownMinutes ? `Voice every ${rule.cooldownMinutes} min` : 'Voice required';
  }

  function renderRules(settings, summary) {
    const rules = settings.siteRules.filter((rule) => rule.enabled).slice(0, 3);
    elements.ruleList.replaceChildren();
    if (!rules.length) {
      const empty = document.createElement('li');
      empty.className = 'empty-rules';
      empty.textContent = 'No active rules yet.';
      elements.ruleList.append(empty);
      return;
    }
    rules.forEach((rule) => {
      const item = document.createElement('li');
      item.className = 'rule-row';
      item.tabIndex = 0;
      item.dataset.ruleId = rule.id;
      item.innerHTML = `
        <span class="rule-icon" aria-hidden="true">${friendlySiteName(rule.hostname).slice(0, 2)}</span>
        <span class="rule-copy"><strong>${friendlySiteName(rule.hostname)}</strong><span>${rule.hostname}</span></span>
        <span class="rule-status">${ruleStatus(rule, summary.todayUsage[rule.id] || 0)}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"></path></svg>`;
      const open = () => openDashboard('site-rules', rule.id);
      item.addEventListener('click', open);
      item.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
      elements.ruleList.append(item);
    });
  }

  function renderFocus(activeFocus) {
    clearInterval(timer);
    if (!activeFocus) {
      elements.focusAction.dataset.active = 'false';
      elements.focusAction.querySelector('span').textContent = 'Start focus';
      elements.focusRemaining.textContent = '';
      return;
    }
    elements.focusAction.dataset.active = 'true';
    elements.focusAction.querySelector('span').textContent = 'End focus';
    const tick = () => {
      const remaining = Math.max(0, activeFocus.endsAt - Date.now());
      elements.focusRemaining.textContent = remaining ? `Focus lock ends in ${Math.ceil(remaining / 60000)} min` : 'Focus lock is ending…';
      if (!remaining) load().catch(() => {});
    };
    tick();
    timer = window.setInterval(tick, 30000);
  }

  function render(response) {
    dashboard = response;
    const { settings, summary } = response;
    elements.enabled.checked = settings.enabled;
    elements.protectionLabel.textContent = settings.enabled ? 'Protection on' : 'Protection off';
    elements.modeName.textContent = settings.profile[0].toUpperCase() + settings.profile.slice(1);
    elements.modeDescription.textContent = profileDescription(settings.profile);
    elements.unlocks.textContent = String(summary.unlocks);
    elements.time.textContent = formatDuration(summary.focusedTimeSeconds);
    if (summary.finiteAllowanceSeconds) {
      elements.allowance.textContent = `${Math.ceil(summary.finiteRemainingSeconds / 60)} min left`;
      const used = 100 - (summary.finiteRemainingSeconds / summary.finiteAllowanceSeconds) * 100;
      elements.allowanceProgress.style.width = `${Math.min(100, Math.max(0, used))}%`;
      elements.allowanceProgress.parentElement.setAttribute('aria-valuenow', String(Math.round(used)));
    } else {
      elements.allowance.textContent = 'Unlimited';
      elements.allowanceProgress.style.width = '0%';
      elements.allowanceProgress.parentElement.setAttribute('aria-valuenow', '0');
    }
    renderRules(settings, summary);
    renderFocus(summary.activeFocus);
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

  document.querySelectorAll('[data-open]').forEach((button) => button.addEventListener('click', () => openDashboard(button.dataset.open)));
  document.querySelectorAll('.duration').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('.duration').forEach((entry) => entry.classList.toggle('active', entry === button));
    if (button.dataset.minutes === 'custom') {
      elements.customDuration.hidden = false;
      selectedMinutes = Number(elements.customMinutes.value) || 75;
      elements.customMinutes.focus();
    } else {
      elements.customDuration.hidden = true;
      selectedMinutes = Number(button.dataset.minutes);
    }
  }));
  elements.customMinutes.addEventListener('input', () => { selectedMinutes = Math.min(240, Math.max(5, Number(elements.customMinutes.value) || 5)); });
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
      if (dashboard?.summary.activeFocus) {
        await send({ type: 'TTU_STOP_FOCUS' });
        showToast('Focus lock ended.');
      } else {
        await send({ type: 'TTU_START_FOCUS', minutes: selectedMinutes });
        showToast(`${selectedMinutes}-minute focus lock started.`);
      }
      await load();
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      elements.focusAction.disabled = false;
    }
  });

  load().catch((error) => showToast(error.message || 'Could not load Talk to Unlock.', 'error'));
})();
