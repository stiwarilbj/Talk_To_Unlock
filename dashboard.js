(function initializeDashboard() {
  'use strict';

  const {
    createSiteRule,
    exportSettingsPayload,
    normalizeSite,
    sanitizeSettings,
    summarizeSchedule,
    validateImportPayload
  } = globalThis.TalkToUnlockUtils;
  const elements = {
    addDialog: document.querySelector('#add-site-dialog'),
    addForm: document.querySelector('#add-site-form'),
    addHostname: document.querySelector('#add-site-hostname'),
    addError: document.querySelector('#add-site-error'),
    content: document.querySelector('#content'),
    headerActions: document.querySelector('#header-actions'),
    importFile: document.querySelector('#import-file'),
    protectionBar: document.querySelector('#protection-bar'),
    subtitle: document.querySelector('#page-subtitle'),
    title: document.querySelector('#page-title'),
    toast: document.querySelector('#toast')
  };
  const sectionCopy = {
    overview: ['Overview', 'Your attention, configured with intention.'],
    'site-rules': ['Site rules', 'Decide how each distraction earns your attention.'],
    schedules: ['Schedules', 'Choose when each rule should be active.'],
    focus: ['Focus sessions', 'Create a protected block of uninterrupted time.'],
    activity: ['Activity', 'A private, local record of your attention choices.'],
    settings: ['Settings', 'Tune defaults, privacy, and fallback behavior.']
  };
  const icons = {
    add: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"></path></svg>',
    upload: '<svg viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M5 20h14"></path></svg>',
    download: '<svg viewBox="0 0 24 24"><path d="M12 4v12M7 11l5 5 5-5M5 20h14"></path></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M8 6v12M16 6v12"></path></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="m9 6 8 6-8 6Z"></path></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"></circle><path d="m16 16 5 5"></path></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17"></path></svg>'
  };
  let model = null;
  let selectedRuleId = new URLSearchParams(location.search).get('rule');
  let draftRule = null;
  let activityFilter = 'all';
  let selectedFocusMinutes = 25;
  let toastTimer = 0;
  let focusTimer = 0;

  function send(message) {
    return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!response?.ok) reject(new Error(response?.error || 'Something went wrong.'));
      else resolve(response);
    }));
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
  }

  function friendlySiteName(hostname) {
    const known = { 'youtube.com': 'YouTube', 'instagram.com': 'Instagram', 'reddit.com': 'Reddit', 'tiktok.com': 'TikTok', 'x.com': 'X', 'facebook.com': 'Facebook' };
    return known[hostname] || hostname.split('.')[0].replace(/(^|[-_])\w/g, (value) => value.replace(/[-_]/, '').toUpperCase());
  }

  function formatDuration(seconds) {
    const minutes = Math.max(0, Math.round(seconds / 60));
    if (minutes < 60) return `${minutes} min`;
    return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
  }

  function formatClock(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function showToast(message, tone = 'success') {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.dataset.tone = tone;
    elements.toast.dataset.visible = 'true';
    toastTimer = setTimeout(() => { elements.toast.dataset.visible = 'false'; }, 2800);
  }

  function currentSection() {
    const section = location.hash.replace('#', '');
    return sectionCopy[section] ? section : 'overview';
  }

  function siteIcon(rule, className = 'site-icon') {
    return `<span class="${className}" aria-hidden="true">${escapeHtml(friendlySiteName(rule.hostname).slice(0, 2))}</span>`;
  }

  function ruleSummary(rule) {
    if (rule.method === 'blocked') return rule.schedule.length ? `Blocked · ${summarizeSchedule(rule)}` : 'Blocked';
    if (rule.dailyAllowanceMinutes !== null) return `${rule.dailyAllowanceMinutes} min daily allowance`;
    if (rule.method === 'pause') return `${rule.fallbackSeconds} sec pause`;
    return rule.cooldownMinutes ? `Voice · ${rule.cooldownMinutes} min cooldown` : 'Voice every visit';
  }

  function renderHeader(section) {
    const [title, subtitle] = sectionCopy[section];
    elements.title.textContent = title;
    elements.subtitle.textContent = subtitle;
    document.querySelectorAll('[data-nav]').forEach((button) => button.classList.toggle('active', button.dataset.nav === section));
    const actions = [];
    if (['site-rules', 'settings'].includes(section)) {
      actions.push(`<button class="button" type="button" data-action="import">${icons.upload}Import</button>`);
      actions.push(`<button class="button" type="button" data-action="export">${icons.download}Export</button>`);
    }
    if (['overview', 'site-rules'].includes(section)) actions.push(`<button class="button primary" type="button" data-action="add-site">${icons.add}Add site</button>`);
    if (section === 'activity' && model?.runtime.activity.length) actions.push('<button class="button danger" type="button" data-action="clear-activity">Clear activity</button>');
    elements.headerActions.innerHTML = actions.join('');
  }

  function renderProtectionBar() {
    const { settings, summary } = model;
    const paused = summary.protectionPausedUntil > Date.now();
    const used = summary.finiteAllowanceSeconds ? 100 - (summary.finiteRemainingSeconds / summary.finiteAllowanceSeconds) * 100 : 0;
    elements.protectionBar.innerHTML = `
      <div class="status-panel">
        <label class="status-switch" aria-label="Enable protection"><input id="dashboard-enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}><span></span></label>
        <div class="status-copy"><strong>${paused ? 'Protection is paused' : settings.enabled ? 'Protection is on' : 'Protection is off'}</strong><span>${model.summary.activeRuleCount} sites protected · ${settings.profile[0].toUpperCase() + settings.profile.slice(1)} mode${paused ? ` · resumes ${formatClock(summary.protectionPausedUntil)}` : ''}</span></div>
        <button class="button small status-action" type="button" data-action="${paused ? 'resume-protection' : 'pause-protection'}">${paused ? icons.play : icons.pause}${paused ? 'Resume protection' : 'Pause protection'}</button>
      </div>
      <div class="today-progress"><p><span>Today: <strong>${formatDuration(summary.focusedTimeSeconds)} focused</strong></span><span>${summary.finiteAllowanceSeconds ? `${Math.ceil(summary.finiteRemainingSeconds / 60)} min left` : 'No daily limits'}</span></p><div class="progress-track" role="progressbar" aria-label="Daily allowance used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(used)}"><span style="width:${Math.max(0, Math.min(100, used))}%"></span></div></div>`;
  }

  function renderOverview() {
    const { settings, summary } = model;
    const activeRules = settings.siteRules.filter((rule) => rule.enabled);
    elements.content.innerHTML = `
      <div class="overview-grid">
        <section class="panel summary-tile"><p>Unlocks today</p><strong>${summary.unlocks}</strong><span>Intentional choices completed</span></section>
        <section class="panel summary-tile"><p>Focused time</p><strong>${formatDuration(summary.focusedTimeSeconds)}</strong><span>Visible, active site use</span></section>
        <section class="panel summary-tile"><p>Active rules</p><strong>${activeRules.length}</strong><span>${summary.activeFocus ? 'Focus lock is active' : 'Protection is ready'}</span></section>
        <section class="panel overview-wide"><div class="panel-heading"><div><h2>Protected sites</h2><p>Your active distraction rules at a glance.</p></div><button class="button small" data-action="go-rules">Manage rules</button></div>
          ${activeRules.length ? `<ul class="overview-rule-list">${activeRules.slice(0, 6).map((rule) => `<li>${siteIcon(rule)}<span class="site-main"><strong>${escapeHtml(friendlySiteName(rule.hostname))}</strong><span>${escapeHtml(rule.hostname)}</span></span><span class="site-rule-summary">${escapeHtml(ruleSummary(rule))}</span><button class="button small" data-action="edit-rule" data-rule-id="${escapeHtml(rule.id)}">Edit</button></li>`).join('')}</ul>` : '<div class="empty-state"><p>No site rules yet. Add one to begin protecting your attention.</p></div>'}
        </section>
      </div>`;
  }

  function selectedRule() {
    return model.settings.siteRules.find((rule) => rule.id === selectedRuleId) || model.settings.siteRules[0] || null;
  }

  function renderSiteList(rules) {
    return rules.map((rule) => `
      <li class="site-list-item ${rule.id === selectedRuleId ? 'selected' : ''}" data-action="select-rule" data-rule-id="${escapeHtml(rule.id)}">
        ${siteIcon(rule)}
        <span class="site-main"><strong>${escapeHtml(friendlySiteName(rule.hostname))}</strong><span>${escapeHtml(rule.hostname)}</span></span>
        <span class="site-rule-summary">${escapeHtml(ruleSummary(rule))}</span>
        <label class="mini-switch" title="Toggle ${escapeHtml(rule.hostname)}"><input type="checkbox" data-action="toggle-rule" data-rule-id="${escapeHtml(rule.id)}" ${rule.enabled ? 'checked' : ''}><span></span></label>
      </li>`).join('');
  }

  function scheduleEditor(rule) {
    const windows = rule.schedule.length ? rule.schedule : [];
    if (!windows.length) return '<div class="empty-schedule"><p class="site-rule-summary">No windows means this rule is always active.</p></div>';
    const dayLabels = ['S','M','T','W','T','F','S'];
    return windows.map((window, index) => `
      <div class="schedule-window" data-window-index="${index}">
        <div class="weekday-row">${dayLabels.map((label, day) => `<button type="button" class="day-chip ${window.days.includes(day) ? 'active' : ''}" data-action="toggle-day" data-window-index="${index}" data-day="${day}" aria-pressed="${window.days.includes(day)}">${label}</button>`).join('')}</div>
        <div class="window-time-row"><input class="select-input" type="time" name="schedule-start-${index}" value="${window.start}"><span>to</span><input class="select-input" type="time" name="schedule-end-${index}" value="${window.end}"><button class="icon-button" type="button" data-action="remove-window" data-window-index="${index}" aria-label="Remove time window">${icons.close}</button></div>
      </div>`).join('');
  }

  function renderRulesSection(filter = '') {
    if (!selectedRuleId || !model.settings.siteRules.some((rule) => rule.id === selectedRuleId)) selectedRuleId = model.settings.siteRules[0]?.id || null;
    const original = selectedRule();
    if (original && (!draftRule || draftRule.id !== original.id)) draftRule = structuredClone(original);
    const rule = draftRule;
    const filtered = model.settings.siteRules.filter((entry) => entry.hostname.includes(filter.toLowerCase()) || friendlySiteName(entry.hostname).toLowerCase().includes(filter.toLowerCase()));
    elements.content.innerHTML = `
      <section class="panel rules-layout">
        <div class="rules-list-panel"><div class="rules-list-header"><h2>Protected sites</h2><div class="search-wrap">${icons.search}<input id="rule-search" type="search" placeholder="Search sites" value="${escapeHtml(filter)}"></div></div><ul class="site-list">${renderSiteList(filtered)}</ul></div>
        ${rule ? `<form class="rule-editor" id="rule-form">
          <div class="editor-heading"><div class="editor-site">${siteIcon(rule)}<div><h2>${escapeHtml(friendlySiteName(rule.hostname))}</h2><p>${escapeHtml(rule.hostname)}</p></div></div><label class="check-row">Active <span class="mini-switch"><input name="enabled" type="checkbox" ${rule.enabled ? 'checked' : ''}><span></span></span></label></div>
          <div class="editor-body">
            <section class="editor-group"><h3>Unlock method</h3><div class="form-grid">
              <fieldset class="field full"><div class="segmented">${['voice','pause','blocked'].map((method) => `<label><input type="radio" name="method" value="${method}" ${rule.method === method ? 'checked' : ''}><span>${method[0].toUpperCase() + method.slice(1)}</span></label>`).join('')}</div></fieldset>
              <label class="field"><span>Required phrase</span><input name="phrase" type="text" maxlength="100" value="${escapeHtml(rule.phrase)}"></label>
              <label class="field"><span>Voice effort</span><span class="range-row"><input name="voiceLevel" type="range" min="0" max="100" value="${rule.voiceLevel}"><output class="range-value">${rule.voiceLevel}%</output></span></label>
              <label class="check-row full"><input name="allowTimedFallback" type="checkbox" ${rule.allowTimedFallback ? 'checked' : ''}>Allow a ${rule.fallbackSeconds}-second fallback</label>
            </div></section>
            <section class="editor-group"><div class="editor-columns"><div><h3>Access limits</h3><div class="form-grid">
              <label class="field"><span>Daily allowance</span><input name="dailyAllowanceMinutes" type="number" min="1" max="1440" placeholder="Unlimited" value="${rule.dailyAllowanceMinutes ?? ''}"></label>
              <label class="field"><span>Unlock window</span><select name="unlockMinutes">${[1,5,10,15,30,60].map((value) => `<option value="${value}" ${rule.unlockMinutes === value ? 'selected' : ''}>${value} minute${value === 1 ? '' : 's'}</option>`).join('')}</select></label>
              <label class="field"><span>Cooldown</span><select name="cooldownMinutes">${[0,5,10,20,30,60].map((value) => `<option value="${value}" ${rule.cooldownMinutes === value ? 'selected' : ''}>${value ? `${value} minutes` : 'None'}</option>`).join('')}</select></label>
              <label class="field full"><span>When allowance runs out</span><select name="exhaustedBehavior"><option value="block" ${rule.exhaustedBehavior === 'block' ? 'selected' : ''}>Block until tomorrow</option><option value="voice" ${rule.exhaustedBehavior === 'voice' ? 'selected' : ''}>Require another voice check</option></select></label>
            </div></div><div><h3>Schedule</h3><div id="schedule-windows">${scheduleEditor(rule)}</div><button class="button small" type="button" data-action="add-window">${icons.add}Add time window</button></div></div></section>
            <section class="editor-group"><label class="check-row"><input name="blockDuringFocus" type="checkbox" ${rule.blockDuringFocus ? 'checked' : ''}>Block this site during Focus sessions</label></section>
          </div>
          <div class="editor-actions"><button class="button danger" type="button" data-action="remove-rule">Remove rule</button><button class="button secondary" type="button" data-action="reset-rule">Reset</button><button class="button primary" type="submit">Save changes</button></div>
        </form>` : '<div class="empty-state"><p>Add a site rule to begin.</p></div>'}
      </section>`;
    bindRangeOutputs();
  }

  function renderSchedules() {
    elements.content.innerHTML = `<section class="panel table-panel"><div class="panel-heading"><div><h2>Rule schedule</h2><p>Times use this computer’s local timezone. Overnight windows are supported.</p></div></div>
      <table class="data-table"><thead><tr><th>Site</th><th>Active windows</th><th>Focus behavior</th><th></th></tr></thead><tbody>${model.settings.siteRules.map((rule) => `<tr><td><strong>${escapeHtml(friendlySiteName(rule.hostname))}</strong><br><span class="site-rule-summary">${escapeHtml(rule.hostname)}</span></td><td>${escapeHtml(summarizeSchedule(rule))}</td><td>${rule.blockDuringFocus ? 'Blocked during Focus' : 'Use normal rule'}</td><td><button class="button small" data-action="edit-rule" data-rule-id="${escapeHtml(rule.id)}">Edit schedule</button></td></tr>`).join('')}</tbody></table></section>`;
  }

  function renderFocus() {
    clearInterval(focusTimer);
    const active = model.summary.activeFocus;
    elements.content.innerHTML = `<div class="focus-layout">
      <section class="panel focus-card"><h2>${active ? 'Focus lock is active' : 'Start a focus lock'}</h2><p>${active ? 'Protected sites remain blocked until this session ends.' : 'Choose a duration and protect every opted-in site.'}</p>
        ${active ? `<div class="focus-countdown"><span>Time remaining</span><strong id="focus-countdown"></strong><small>Started at ${formatClock(active.startedAt)}</small></div><button class="button danger" data-action="stop-focus">End focus lock</button>` : `<div class="focus-picker">${[25,50,90].map((minutes) => `<button data-action="focus-duration" data-minutes="${minutes}" class="${selectedFocusMinutes === minutes ? 'active' : ''}">${minutes === 90 ? 'Custom · 90' : `${minutes} min`}</button>`).join('')}</div><button class="button primary" data-action="start-focus">${icons.play}Start focus</button>`}
      </section>
      <section class="panel focus-sites"><div class="panel-heading"><div><h2>Sites protected by Focus</h2><p>These rules become hard blocks while Focus is active.</p></div></div>${model.settings.siteRules.map((rule) => `<div class="focus-site-row">${siteIcon(rule)}<span class="site-main"><strong>${escapeHtml(friendlySiteName(rule.hostname))}</strong><span>${escapeHtml(rule.hostname)}</span></span><label class="mini-switch"><input type="checkbox" data-action="toggle-focus-site" data-rule-id="${escapeHtml(rule.id)}" ${rule.blockDuringFocus ? 'checked' : ''}><span></span></label></div>`).join('')}</section>
    </div>`;
    if (active) {
      const tick = () => {
        const target = document.querySelector('#focus-countdown');
        if (!target) return;
        const seconds = Math.max(0, Math.ceil((active.endsAt - Date.now()) / 1000));
        target.textContent = `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`;
        if (!seconds) load().catch(() => {});
      };
      tick();
      focusTimer = setInterval(tick, 1000);
    }
  }

  function activityLabel(event) {
    return {
      gate_shown: ['Gate shown', 'A protected page requested an attention check.'],
      voice_success: ['Voice unlock', 'The phrase and voice effort matched.'],
      voice_failure: ['Voice attempt', 'The phrase or voice effort did not match.'],
      pause_unlock: ['Timed pause', 'The fallback countdown was completed.'],
      emergency_bypass: ['Emergency bypass', 'The hold-to-confirm bypass was used.'],
      focus_started: ['Focus started', `${event.detail.durationMinutes || 25}-minute session`],
      focus_ended: ['Focus ended', 'The Focus session finished.'],
      protection_paused: ['Protection paused', `${event.detail.minutes || 15} minutes`]
    }[event.type] || ['Activity', event.type];
  }

  function renderActivity() {
    const events = model.runtime.activity.filter((event) => activityFilter === 'all' || event.hostname === activityFilter);
    elements.content.innerHTML = `<div class="activity-summary"><section class="panel summary-tile"><p>Unlocks today</p><strong>${model.summary.unlocks}</strong><span>Voice, pause, and bypass</span></section><section class="panel summary-tile"><p>Focused time</p><strong>${formatDuration(model.summary.focusedTimeSeconds)}</strong><span>Visible, active usage</span></section><section class="panel summary-tile"><p>Activity retained</p><strong>${model.runtime.activity.length}</strong><span>Last ${model.settings.activityRetentionDays} days</span></section></div>
      <section class="panel"><div class="panel-heading"><div><h2>Local activity</h2><p>No audio or recognized transcript is ever stored.</p></div><label class="field"><span>Filter by site</span><select id="activity-filter"><option value="all">All activity</option>${model.settings.siteRules.map((rule) => `<option value="${escapeHtml(rule.hostname)}" ${activityFilter === rule.hostname ? 'selected' : ''}>${escapeHtml(friendlySiteName(rule.hostname))}</option>`).join('')}</select></label></div>
      ${events.length ? `<ul class="activity-list">${events.map((event) => { const [title, detail] = activityLabel(event); return `<li class="activity-event"><span class="event-icon">${event.type.includes('voice') ? 'V' : event.type.includes('focus') ? 'F' : event.type.includes('pause') ? 'P' : '•'}</span><div><strong>${escapeHtml(title)}${event.hostname ? ` · ${escapeHtml(friendlySiteName(event.hostname))}` : ''}</strong><p>${escapeHtml(detail)}</p></div><time datetime="${new Date(event.at).toISOString()}">${new Date(event.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></li>`; }).join('')}</ul>` : `<div class="empty-state"><svg viewBox="0 0 24 24"><path d="M4 19V9M10 19V5M16 19v-7M22 19V3"></path></svg><p>No activity matches this view yet.<br>Your future attention choices will appear here.</p></div>`}</section>`;
  }

  function renderSettings() {
    const settings = model.settings;
    elements.content.innerHTML = `<form id="settings-form" class="settings-layout"><section class="panel settings-panel"><h2>Protection profile</h2><p>Profiles change how Voice rules behave without replacing per-site settings.</p><div class="profile-options">${[
      ['gentle','Gentle','Voice checks become timed pauses.'],['balanced','Balanced','Use each configured rule with allowed fallback.'],['strict','Strict','Disable timed fallback while keeping emergency bypass.']
    ].map(([value,title,copy]) => `<label class="profile-option"><input type="radio" name="profile" value="${value}" ${settings.profile === value ? 'checked' : ''}><span><strong>${title}</strong><span>${copy}</span></span></label>`).join('')}</div>
      <div class="editor-group"><h3>Defaults for new rules</h3><div class="form-grid"><label class="field"><span>Default phrase</span><input name="defaultPhrase" type="text" maxlength="100" value="${escapeHtml(settings.defaultPhrase)}"></label><label class="field"><span>Voice effort</span><span class="range-row"><input name="defaultVoiceLevel" type="range" min="0" max="100" value="${settings.defaultVoiceLevel}"><output class="range-value">${settings.defaultVoiceLevel}%</output></span></label><label class="field"><span>Timed fallback</span><select name="defaultFallbackSeconds">${[5,10,15,20,30,45,60].map((value) => `<option value="${value}" ${settings.defaultFallbackSeconds === value ? 'selected' : ''}>${value} seconds</option>`).join('')}</select></label><label class="field"><span>Activity retention</span><select name="activityRetentionDays">${[7,14,30,60,90].map((value) => `<option value="${value}" ${settings.activityRetentionDays === value ? 'selected' : ''}>${value} days</option>`).join('')}</select></label></div></div>
      <div class="editor-group"><h3>Emergency access</h3><label class="check-row"><input name="emergencyBypassEnabled" type="checkbox" ${settings.emergencyBypassEnabled ? 'checked' : ''}>Show hold-to-confirm emergency bypass</label><label class="field" style="margin-top:12px"><span>Hold duration</span><select name="emergencyHoldSeconds">${[3,4,5,6,8,10].map((value) => `<option value="${value}" ${settings.emergencyHoldSeconds === value ? 'selected' : ''}>${value} seconds</option>`).join('')}</select></label></div>
      <button class="button primary" type="submit">Save settings</button></section>
      <aside class="settings-actions"><section class="panel settings-panel"><h2>Data and tools</h2><p>Configuration moves only when you choose it.</p><button class="button" type="button" data-action="test-overlay">Test unlock screen</button><button class="button" type="button" data-action="export">${icons.download}Export configuration</button><button class="button" type="button" data-action="import">${icons.upload}Import configuration</button><button class="button danger" type="button" data-action="reset-settings">Reset all settings</button></section><div class="privacy-note"><svg viewBox="0 0 24 24"><path d="M12 3 5 6.2v5.3c0 4.3 2.8 8 7 9.5 4.2-1.5 7-5.2 7-9.5V6.2Z"></path><path d="M9 12h6"></path></svg><span>Everything is stored on this device. Audio is requested only during an unlock attempt, then the stream is closed. Audio and transcripts are never saved.</span></div></aside></form>`;
    bindRangeOutputs();
  }

  function render() {
    const section = currentSection();
    renderHeader(section);
    renderProtectionBar();
    if (section === 'overview') renderOverview();
    if (section === 'site-rules') renderRulesSection();
    if (section === 'schedules') renderSchedules();
    if (section === 'focus') renderFocus();
    if (section === 'activity') renderActivity();
    if (section === 'settings') renderSettings();
  }

  function bindRangeOutputs() {
    elements.content.querySelectorAll('input[type="range"]').forEach((input) => {
      const output = input.parentElement.querySelector('output');
      input.addEventListener('input', () => { if (output) output.textContent = `${input.value}%`; });
    });
  }

  async function load() {
    model = await send({ type: 'TTU_GET_DASHBOARD' });
    if (!selectedRuleId) selectedRuleId = model.settings.siteRules[0]?.id || null;
    draftRule = null;
    render();
  }

  async function saveSettings(settings, message = 'Changes saved.') {
    const response = await send({ type: 'TTU_SAVE_SETTINGS', settings });
    model.settings = response.settings;
    await load();
    showToast(message);
  }

  function readRuleForm() {
    const form = document.querySelector('#rule-form');
    if (!form || !draftRule) return;
    const data = new FormData(form);
    draftRule.enabled = data.get('enabled') === 'on';
    draftRule.method = data.get('method');
    draftRule.phrase = String(data.get('phrase') || '').trim();
    draftRule.voiceLevel = Number(data.get('voiceLevel'));
    draftRule.allowTimedFallback = data.get('allowTimedFallback') === 'on';
    draftRule.dailyAllowanceMinutes = data.get('dailyAllowanceMinutes') ? Number(data.get('dailyAllowanceMinutes')) : null;
    draftRule.unlockMinutes = Number(data.get('unlockMinutes'));
    draftRule.cooldownMinutes = Number(data.get('cooldownMinutes'));
    draftRule.exhaustedBehavior = data.get('exhaustedBehavior');
    draftRule.blockDuringFocus = data.get('blockDuringFocus') === 'on';
    draftRule.schedule.forEach((window, index) => {
      window.start = String(data.get(`schedule-start-${index}`) || window.start);
      window.end = String(data.get(`schedule-end-${index}`) || window.end);
    });
  }

  async function exportSettings() {
    const response = await send({ type: 'TTU_EXPORT_SETTINGS' }).catch(() => ({ payload: exportSettingsPayload(model.settings) }));
    const blob = new Blob([JSON.stringify(response.payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `talk-to-unlock-settings-${new Date().toISOString().slice(0,10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 500);
    showToast('Configuration exported.');
  }

  elements.headerActions.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action) handleAction(action, event.target.closest('[data-action]'));
  });
  elements.protectionBar.addEventListener('change', async (event) => {
    if (event.target.id !== 'dashboard-enabled') return;
    try { await send({ type: 'TTU_SET_ENABLED', enabled: event.target.checked }); await load(); showToast(event.target.checked ? 'Protection turned on.' : 'Protection turned off.'); }
    catch (error) { showToast(error.message, 'error'); }
  });
  elements.protectionBar.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action) handleAction(action, event.target.closest('[data-action]'));
  });
  elements.content.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (target) handleAction(target.dataset.action, target, event);
  });
  elements.content.addEventListener('input', (event) => {
    if (event.target.id === 'rule-search') renderRulesSection(event.target.value);
  });
  elements.content.addEventListener('change', async (event) => {
    if (event.target.id === 'activity-filter') { activityFilter = event.target.value; renderActivity(); }
  });
  elements.content.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      if (event.target.id === 'rule-form') {
        readRuleForm();
        if (draftRule.phrase.length < 3) throw new Error('Use a phrase with at least 3 characters.');
        const next = structuredClone(model.settings);
        next.siteRules = next.siteRules.map((rule) => rule.id === draftRule.id ? draftRule : rule);
        await saveSettings(next, `${friendlySiteName(draftRule.hostname)} rule saved.`);
      }
      if (event.target.id === 'settings-form') {
        const data = new FormData(event.target);
        const next = { ...model.settings, profile: data.get('profile'), defaultPhrase: data.get('defaultPhrase'), defaultVoiceLevel: Number(data.get('defaultVoiceLevel')), defaultFallbackSeconds: Number(data.get('defaultFallbackSeconds')), emergencyBypassEnabled: data.get('emergencyBypassEnabled') === 'on', emergencyHoldSeconds: Number(data.get('emergencyHoldSeconds')), activityRetentionDays: Number(data.get('activityRetentionDays')) };
        if (String(next.defaultPhrase).trim().length < 3) throw new Error('Use a default phrase with at least 3 characters.');
        await saveSettings(next, 'Settings saved.');
      }
    } catch (error) { showToast(error.message, 'error'); }
  });

  async function handleAction(action, target, event) {
    try {
      if (action === 'add-site') { elements.addDialog.showModal(); elements.addHostname.focus(); return; }
      if (action === 'import') { elements.importFile.click(); return; }
      if (action === 'export') { await exportSettings(); return; }
      if (action === 'go-rules') { location.hash = 'site-rules'; return; }
      if (action === 'edit-rule') { selectedRuleId = target.dataset.ruleId; draftRule = null; location.hash = 'site-rules'; render(); return; }
      if (action === 'select-rule') {
        if (event?.target.closest('.mini-switch')) return;
        selectedRuleId = target.dataset.ruleId; draftRule = null; renderRulesSection(document.querySelector('#rule-search')?.value || ''); return;
      }
      if (action === 'toggle-rule') {
        event?.stopPropagation();
        const next = structuredClone(model.settings);
        const rule = next.siteRules.find((entry) => entry.id === target.dataset.ruleId);
        rule.enabled = target.checked;
        await saveSettings(next, `${friendlySiteName(rule.hostname)} ${rule.enabled ? 'enabled' : 'paused'}.`); return;
      }
      if (action === 'add-window') {
        readRuleForm();
        draftRule.schedule.push({ id: `window-${Date.now()}`, days: [1,2,3,4,5], start: '09:00', end: '18:00' });
        renderRulesSection(document.querySelector('#rule-search')?.value || ''); return;
      }
      if (action === 'remove-window') {
        readRuleForm(); draftRule.schedule.splice(Number(target.dataset.windowIndex), 1); renderRulesSection(); return;
      }
      if (action === 'toggle-day') {
        readRuleForm();
        const window = draftRule.schedule[Number(target.dataset.windowIndex)];
        const day = Number(target.dataset.day);
        window.days = window.days.includes(day) ? window.days.filter((value) => value !== day) : [...window.days, day].sort();
        renderRulesSection(); return;
      }
      if (action === 'reset-rule') { draftRule = structuredClone(selectedRule()); renderRulesSection(); showToast('Unsaved changes reset.'); return; }
      if (action === 'remove-rule') {
        if (!confirm(`Remove the rule for ${draftRule.hostname}?`)) return;
        const next = structuredClone(model.settings); next.siteRules = next.siteRules.filter((rule) => rule.id !== draftRule.id); selectedRuleId = next.siteRules[0]?.id || null;
        await saveSettings(next, 'Site rule removed.'); return;
      }
      if (action === 'pause-protection') { await send({ type: 'TTU_PAUSE_PROTECTION', minutes: 15 }); await load(); showToast('Protection paused for 15 minutes.'); return; }
      if (action === 'resume-protection') { await send({ type: 'TTU_RESUME_PROTECTION' }); await load(); showToast('Protection resumed.'); return; }
      if (action === 'focus-duration') { selectedFocusMinutes = Number(target.dataset.minutes); renderFocus(); return; }
      if (action === 'start-focus') { await send({ type: 'TTU_START_FOCUS', minutes: selectedFocusMinutes }); await load(); showToast(`${selectedFocusMinutes}-minute focus lock started.`); return; }
      if (action === 'stop-focus') { await send({ type: 'TTU_STOP_FOCUS' }); await load(); showToast('Focus lock ended.'); return; }
      if (action === 'toggle-focus-site') {
        const next = structuredClone(model.settings); const rule = next.siteRules.find((entry) => entry.id === target.dataset.ruleId); rule.blockDuringFocus = target.checked;
        await saveSettings(next, 'Focus sites updated.'); return;
      }
      if (action === 'clear-activity') { if (confirm('Clear all locally stored activity?')) { await send({ type: 'TTU_CLEAR_ACTIVITY' }); await load(); showToast('Activity cleared.'); } return; }
      if (action === 'reset-settings') { if (confirm('Reset every rule and setting to the 3.0 defaults?')) { await send({ type: 'TTU_RESET_SETTINGS' }); await load(); showToast('Settings reset.'); } return; }
      if (action === 'test-overlay') { await send({ type: 'TTU_OPEN_PREVIEW' }); showToast('Unlock preview opened.'); }
    } catch (error) { showToast(error.message, 'error'); }
  }

  document.querySelectorAll('[data-nav]').forEach((button) => button.addEventListener('click', () => { location.hash = button.dataset.nav; }));
  window.addEventListener('hashchange', () => { if (model) render(); });
  elements.addForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const hostname = normalizeSite(elements.addHostname.value);
    if (!hostname) { elements.addError.textContent = 'Enter a valid website, such as example.com.'; elements.addHostname.focus(); return; }
    if (model.settings.siteRules.some((rule) => rule.hostname === hostname)) { elements.addError.textContent = `${hostname} already has a rule.`; elements.addHostname.focus(); return; }
    const method = new FormData(elements.addForm).get('new-method');
    const id = globalThis.crypto?.randomUUID ? `rule-${crypto.randomUUID()}` : `rule-${Date.now()}`;
    const rule = createSiteRule(hostname, { id, method, phrase: model.settings.defaultPhrase, voiceLevel: model.settings.defaultVoiceLevel, fallbackSeconds: model.settings.defaultFallbackSeconds });
    const next = structuredClone(model.settings); next.siteRules.push(rule); selectedRuleId = rule.id;
    try { await saveSettings(next, `${friendlySiteName(hostname)} added.`); elements.addDialog.close(); elements.addForm.reset(); location.hash = 'site-rules'; }
    catch (error) { elements.addError.textContent = error.message; }
  });
  elements.addHostname.addEventListener('input', () => { elements.addError.textContent = ''; });
  elements.importFile.addEventListener('change', async () => {
    const file = elements.importFile.files[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const settings = validateImportPayload(payload);
      if (!confirm(`Replace the current configuration with ${settings.siteRules.length} imported site rules? Activity will remain on this device.`)) return;
      await send({ type: 'TTU_IMPORT_SETTINGS', payload }); await load(); showToast('Configuration imported.');
    } catch (error) { showToast(error.message, 'error'); }
    finally { elements.importFile.value = ''; }
  });

  if (!location.hash) history.replaceState(null, '', `${location.pathname}${location.search}#overview`);
  load().catch((error) => { elements.content.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message || 'Could not load the dashboard.')}</p></div>`; showToast(error.message, 'error'); });
})();
