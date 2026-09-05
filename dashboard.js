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
    sites: ['My sites', 'Choose a friendly boundary for each distracting site.'],
    activity: ['Activity', 'A private, local record of the choices you make.'],
    settings: ['Settings', 'Keep the simple controls simple. Tune the rest when you need it.']
  };
  const icons = {
    add: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>',
    upload: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M5 20h14"></path></svg>',
    download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v12M7 11l5 5 5-5M5 20h14"></path></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6v12M16 6v12"></path></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 8 6-8 6Z"></path></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m16 16 5 5"></path></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"></path></svg>',
    shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6.2v5.3c0 4.3 2.8 8 7 9.5 4.2-1.5 7-5.2 7-9.5V6.2Z"></path><path d="m9 12 2 2 4-4"></path></svg>'
  };
  const methodCopy = {
    pause: ['Take a pause', 'A short, friendly reset.'],
    voice: ['Say a phrase', 'Use your voice to continue.'],
    blocked: ['Keep blocked', 'No normal unlock path.']
  };
  let model = null;
  let selectedRuleId = new URLSearchParams(location.search).get('rule');
  let draftRule = null;
  let ruleFilter = '';
  let activityFilter = 'all';
  let moreOptionsOpen = false;
  let toastTimer = 0;

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

  function methodLabel(method) { return methodCopy[method]?.[0] || 'Take a pause'; }

  function formatDuration(seconds) {
    const minutes = Math.max(0, Math.round(Number(seconds) / 60));
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
  }

  function formatClock(timestamp) { return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }

  function showToast(message, tone = 'success') {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.dataset.tone = tone;
    elements.toast.dataset.visible = 'true';
    toastTimer = setTimeout(() => { elements.toast.dataset.visible = 'false'; }, 2800);
  }

  function currentSection() {
    const raw = location.hash.replace('#', '');
    const legacy = { overview: 'sites', 'site-rules': 'sites', schedules: 'sites', focus: 'sites' };
    const section = legacy[raw] || raw;
    return sectionCopy[section] ? section : 'sites';
  }

  function siteIcon(rule, className = 'site-icon') { return `<span class="${className}" aria-hidden="true">${escapeHtml(friendlySiteName(rule.hostname).slice(0, 2))}</span>`; }

  function ruleSummary(rule) {
    if (rule.method === 'blocked') return rule.schedule.length ? `Blocked · ${summarizeSchedule(rule)}` : 'Blocked';
    if (rule.method === 'pause') return rule.schedule.length ? `Pause · ${summarizeSchedule(rule)}` : `${rule.fallbackSeconds}-second pause`;
    if (rule.dailyAllowanceMinutes !== null) return `${rule.dailyAllowanceMinutes} min daily allowance`;
    return rule.cooldownMinutes ? `Phrase · ${rule.cooldownMinutes} min cooldown` : 'Phrase required';
  }

  function renderHeader(section) {
    const [title, subtitle] = sectionCopy[section];
    elements.title.textContent = title;
    elements.subtitle.textContent = subtitle;
    document.title = `Little Pause — ${title}`;
    document.querySelectorAll('[data-nav]').forEach((button) => button.classList.toggle('active', button.dataset.nav === section));
    const actions = [];
    if (section === 'sites' || section === 'settings') {
      actions.push(`<button class="button" type="button" data-action="import">${icons.upload}Import</button>`);
      actions.push(`<button class="button" type="button" data-action="export">${icons.download}Export</button>`);
    }
    if (section === 'sites') actions.push(`<button class="button primary" type="button" data-action="add-site">${icons.add}Add site</button>`);
    if (section === 'activity' && model?.runtime.activity.length) actions.push('<button class="button danger" type="button" data-action="clear-activity">Clear activity</button>');
    elements.headerActions.innerHTML = actions.join('');
  }

  function renderProtectionBar() {
    const { settings, summary } = model;
    const paused = summary.protectionPausedUntil > Date.now();
    const used = summary.finiteAllowanceSeconds ? 100 - (summary.finiteRemainingSeconds / summary.finiteAllowanceSeconds) * 100 : 0;
    elements.protectionBar.innerHTML = `<div class="status-panel"><label class="status-switch" aria-label="${settings.enabled ? 'Turn protection off' : 'Turn protection on'}"><input id="dashboard-enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}><span></span></label><div class="status-copy"><strong>${paused ? 'Protection is paused' : settings.enabled ? 'Protection is on' : 'Protection is off'}</strong><span>${summary.activeRuleCount} ${summary.activeRuleCount === 1 ? 'site' : 'sites'} protected · ${settings.profile[0].toUpperCase() + settings.profile.slice(1)} profile${paused ? ` · resumes ${formatClock(summary.protectionPausedUntil)}` : ''}</span></div><button class="button small status-action" type="button" data-action="${paused ? 'resume-protection' : 'pause-protection'}">${paused ? icons.play : icons.pause}${paused ? 'Resume protection' : 'Pause for 15 min'}</button></div><div class="today-progress"><p><span>Today: <strong>${formatDuration(summary.focusedTimeSeconds)} on protected sites</strong></span><span>${summary.finiteAllowanceSeconds ? `${Math.ceil(summary.finiteRemainingSeconds / 60)} min left` : 'No daily limits'}</span></p><div class="progress-track" role="progressbar" aria-label="Daily allowance used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(used)}"><span style="width:${Math.max(0, Math.min(100, used))}%"></span></div></div>`;
  }

  function welcomeCard() {
    if (model.onboardingCompleted !== false || model.settings.siteRules.length) return '';
    return `<section class="welcome-card"><div class="mascot" aria-hidden="true"><span></span><span></span><i></i></div><div><h2>Welcome to Little Pause.</h2><p>Open the extension popup for a short setup, or add your first site here.</p></div><button class="button primary" type="button" data-action="add-site">Choose a site</button></section>`;
  }

  function renderSiteList(rules) {
    if (!rules.length) return '<li class="empty-state"><p>No sites match this search.</p></li>';
    return rules.map((rule) => `<li class="site-list-item ${rule.id === selectedRuleId ? 'selected' : ''}" data-action="select-rule" data-rule-id="${escapeHtml(rule.id)}">${siteIcon(rule)}<span class="site-main"><strong>${escapeHtml(friendlySiteName(rule.hostname))}</strong><span>${escapeHtml(rule.hostname)}</span></span><label class="mini-switch" title="Toggle ${escapeHtml(rule.hostname)}"><input type="checkbox" data-action="toggle-rule" data-rule-id="${escapeHtml(rule.id)}" ${rule.enabled ? 'checked' : ''}><span></span></label></li>`).join('');
  }

  function scheduleEditor(rule) {
    if (!rule.schedule.length) return '<div class="empty-schedule"><p class="site-rule-summary">No windows means this rule is always active.</p></div>';
    const dayLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    return rule.schedule.map((window, index) => `<div class="schedule-window" data-window-index="${index}"><div class="weekday-row">${dayLabels.map((label, day) => `<button type="button" class="day-chip ${window.days.includes(day) ? 'active' : ''}" data-action="toggle-day" data-window-index="${index}" data-day="${day}" aria-pressed="${window.days.includes(day)}">${label}</button>`).join('')}</div><div class="window-time-row"><input class="select-input" type="time" name="schedule-start-${index}" value="${window.start}"><span>to</span><input class="select-input" type="time" name="schedule-end-${index}" value="${window.end}"><button class="icon-button" type="button" data-action="remove-window" data-window-index="${index}" aria-label="Remove time window">${icons.close}</button></div></div>`).join('');
  }

  function renderMethodCards(rule) {
    return ['pause', 'voice', 'blocked'].map((method) => `<label><input type="radio" name="method" value="${method}" ${rule.method === method ? 'checked' : ''}><span><strong>${methodCopy[method][0]}</strong><small>${methodCopy[method][1]}</small></span></label>`).join('');
  }

  function renderRulesSection() {
    if (!selectedRuleId || !model.settings.siteRules.some((rule) => rule.id === selectedRuleId)) selectedRuleId = model.settings.siteRules[0]?.id || null;
    const original = model.settings.siteRules.find((rule) => rule.id === selectedRuleId);
    if (original && (!draftRule || draftRule.id !== original.id)) draftRule = structuredClone(original);
    const rule = draftRule;
    const filter = ruleFilter.toLowerCase();
    const filtered = model.settings.siteRules.filter((entry) => entry.hostname.includes(filter) || friendlySiteName(entry.hostname).toLowerCase().includes(filter));
    const editor = rule ? `<form class="rule-editor" id="rule-form"><div class="editor-heading"><div class="editor-site">${siteIcon(rule)}<div><h2>${escapeHtml(friendlySiteName(rule.hostname))}</h2><p>${escapeHtml(rule.hostname)}</p></div></div><label class="check-row" title="Toggle this site rule">Active <span class="mini-switch"><input name="enabled" type="checkbox" ${rule.enabled ? 'checked' : ''}><span></span></span></label></div><div class="editor-body"><section class="editor-group"><h3>When I visit this site, I want to…</h3><div class="method-cards">${renderMethodCards(rule)}</div><p class="method-note">${escapeHtml(methodCopy[rule.method][1])}</p><details class="more-options" id="more-options" ${moreOptionsOpen ? 'open' : ''}><summary>More options</summary><div class="more-options-body">${rule.method === 'voice' ? `<div class="form-grid"><label class="field"><span>Phrase to say</span><input name="phrase" type="text" maxlength="100" value="${escapeHtml(rule.phrase)}"></label><label class="field"><span>Voice effort</span><span class="range-row"><input name="voiceLevel" type="range" min="0" max="100" value="${rule.voiceLevel}"><output class="range-value">${rule.voiceLevel}%</output></span></label><label class="check-row full"><input name="allowTimedFallback" type="checkbox" ${rule.allowTimedFallback ? 'checked' : ''}>Allow the ${rule.fallbackSeconds}-second fallback</label><label class="field"><span>Fallback length</span><select name="fallbackSeconds">${[5,10,15,20,30,45,60].map((value) => `<option value="${value}" ${rule.fallbackSeconds === value ? 'selected' : ''}>${value} seconds</option>`).join('')}</select></label></div>` : ''}<div class="settings-section"><h3>Access limits</h3><div class="form-grid"><label class="field"><span>Unlock window</span><select name="unlockMinutes">${[1,5,10,15,30,60,120].map((value) => `<option value="${value}" ${rule.unlockMinutes === value ? 'selected' : ''}>${value} minute${value === 1 ? '' : 's'}</option>`).join('')}</select></label><label class="field"><span>Cooldown after unlock</span><select name="cooldownMinutes">${[0,5,10,20,30,60,120].map((value) => `<option value="${value}" ${rule.cooldownMinutes === value ? 'selected' : ''}>${value ? `${value} minutes` : 'None'}</option>`).join('')}</select></label><label class="field"><span>Daily allowance</span><input name="dailyAllowanceMinutes" type="number" min="1" max="1440" placeholder="Unlimited" value="${rule.dailyAllowanceMinutes ?? ''}"></label><label class="field"><span>When allowance runs out</span><select name="exhaustedBehavior"><option value="block" ${rule.exhaustedBehavior === 'block' ? 'selected' : ''}>Keep blocked until tomorrow</option><option value="voice" ${rule.exhaustedBehavior === 'voice' ? 'selected' : ''}>Ask for another phrase</option></select></label></div></div><div class="settings-section"><h3>Schedule</h3><p class="method-note">Times use this computer’s local timezone. Overnight windows work too.</p><div id="schedule-windows">${scheduleEditor(rule)}</div><button class="button small" type="button" data-action="add-window">${icons.add}Add time window</button></div><div class="settings-section"><label class="check-row"><input name="includeSubdomains" type="checkbox" ${rule.includeSubdomains ? 'checked' : ''}>Include subdomains</label><label class="check-row" style="margin-top:10px"><input name="blockDuringFocus" type="checkbox" ${rule.blockDuringFocus ? 'checked' : ''}>Keep this site blocked during Focus sessions</label></div></div></details></section></div><div class="editor-actions"><button class="button danger" type="button" data-action="remove-rule">Remove</button><button class="button secondary" type="button" data-action="reset-rule">Reset</button><button class="button primary" type="submit">Save changes</button></div></form>` : '<section class="panel empty-state"><div class="mascot" aria-hidden="true"><span></span><span></span><i></i></div><p>Choose a site to edit it, or add your first one.</p><button class="button primary" type="button" data-action="add-site">Add a site</button></section>';
    elements.content.innerHTML = `${welcomeCard()}<div class="site-manager"><section class="panel sites-list-panel"><div class="rules-list-header"><div><p class="eyebrow">${model.settings.siteRules.length} protected</p><h2>My sites</h2></div><div class="search-wrap">${icons.search}<input id="rule-search" type="search" placeholder="Search" value="${escapeHtml(ruleFilter)}" aria-label="Search protected sites"></div></div><ul class="site-list">${renderSiteList(filtered)}</ul><div class="list-footnote">${icons.shield}<span>Each site can have its own pause, phrase, schedule, allowance, and Focus behavior.</span></div></section>${editor}</div>`;
    bindRangeOutputs();
  }

  function activityLabel(event) {
    return {
      gate_shown: ['Pause shown', 'A protected page asked for a moment of attention.'],
      voice_success: ['Phrase accepted', 'The phrase and voice effort matched.'],
      voice_failure: ['Phrase attempt', 'The phrase or voice effort did not match.'],
      pause_unlock: ['Pause completed', 'The timed pause finished.'],
      emergency_bypass: ['Emergency bypass', 'The hold-to-confirm bypass was used.'],
      focus_started: ['Focus started', `${event.detail.durationMinutes || 25}-minute session`],
      focus_ended: ['Focus ended', 'The Focus session finished.'],
      protection_paused: ['Protection paused', `${event.detail.minutes || 15} minutes`]
    }[event.type] || ['Activity', event.type];
  }

  function renderActivity() {
    const events = model.runtime.activity.filter((event) => activityFilter === 'all' || event.hostname === activityFilter);
    const eventRows = events.map((event) => { const [title, detail] = activityLabel(event); const icon = event.type.includes('voice') ? 'V' : event.type.includes('focus') ? 'F' : event.type.includes('pause') ? 'P' : '•'; return `<li class="activity-event"><span class="event-icon">${icon}</span><div><strong>${escapeHtml(title)}${event.hostname ? ` · ${escapeHtml(friendlySiteName(event.hostname))}` : ''}</strong><p>${escapeHtml(detail)}</p></div><time datetime="${new Date(event.at).toISOString()}">${new Date(event.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></li>`; }).join('');
    elements.content.innerHTML = `<div class="activity-summary"><section class="panel summary-tile"><p>Unlocks today</p><strong>${model.summary.unlocks}</strong><span>Phrase, pause, and bypass choices</span></section><section class="panel summary-tile"><p>Time on protected sites</p><strong>${formatDuration(model.summary.focusedTimeSeconds)}</strong><span>Visible time, counted only while focused</span></section><section class="panel summary-tile"><p>Activity retained</p><strong>${model.runtime.activity.length}</strong><span>Up to ${model.settings.activityRetentionDays} days or 1,000 events</span></section></div><section class="panel activity-panel"><div class="panel-heading"><div><p class="eyebrow">Local only</p><h2>Recent activity</h2><p>No audio or recognized transcript is ever stored.</p></div><label class="activity-filter"><span>Show</span><select id="activity-filter"><option value="all">All sites</option>${model.settings.siteRules.map((rule) => `<option value="${escapeHtml(rule.hostname)}" ${activityFilter === rule.hostname ? 'selected' : ''}>${escapeHtml(friendlySiteName(rule.hostname))}</option>`).join('')}</select></label></div>${eventRows ? `<ul class="activity-list">${eventRows}</ul>` : '<div class="empty-state"><div class="mascot" aria-hidden="true"><span></span><span></span><i></i></div><p>No activity matches this view yet.<br>Your future choices will appear here.</p></div>'}<p class="activity-footnote">Time on protected sites is shown as usage, not productive or focused time.</p></section>`;
  }

  function renderSettings() {
    const settings = model.settings;
    elements.content.innerHTML = `<form id="settings-form" class="settings-layout"><section class="panel settings-panel"><p class="eyebrow">How it feels</p><h2>Protection profile</h2><p>Profiles change how Voice rules behave without replacing each site’s settings.</p><div class="profile-options">${[['gentle', 'Gentle', 'Voice rules become timed pauses.'], ['balanced', 'Balanced', 'Use each configured rule with its permitted fallback.'], ['strict', 'Strict', 'Use configured rules without timed fallback. Emergency bypass stays available.']].map(([value, title, copy]) => `<label class="profile-option"><input type="radio" name="profile" value="${value}" ${settings.profile === value ? 'checked' : ''}><span><strong>${title}</strong><span>${copy}</span></span></label>`).join('')}</div><div class="settings-section"><h3>Defaults for new sites</h3><p class="method-note">New sites start as a 10-second pause. Existing rules are never changed by these defaults.</p><div class="form-grid"><label class="field"><span>Default phrase</span><input name="defaultPhrase" type="text" maxlength="100" value="${escapeHtml(settings.defaultPhrase)}"></label><label class="field"><span>Voice effort</span><span class="range-row"><input name="defaultVoiceLevel" type="range" min="0" max="100" value="${settings.defaultVoiceLevel}"><output class="range-value">${settings.defaultVoiceLevel}%</output></span></label><label class="field"><span>Fallback length</span><select name="defaultFallbackSeconds">${[5,10,15,20,30,45,60].map((value) => `<option value="${value}" ${settings.defaultFallbackSeconds === value ? 'selected' : ''}>${value} seconds</option>`).join('')}</select></label><label class="field"><span>Activity retention</span><select name="activityRetentionDays">${[7,14,30,60,90].map((value) => `<option value="${value}" ${settings.activityRetentionDays === value ? 'selected' : ''}>${value} days</option>`).join('')}</select></label></div></div><div class="settings-section"><h3>Emergency access</h3><label class="check-row"><input name="emergencyBypassEnabled" type="checkbox" ${settings.emergencyBypassEnabled ? 'checked' : ''}>Show the five-second hold-to-confirm bypass</label><label class="field" style="margin-top:12px"><span>Hold duration</span><select name="emergencyHoldSeconds">${[3,4,5,6,8,10].map((value) => `<option value="${value}" ${settings.emergencyHoldSeconds === value ? 'selected' : ''}>${value} seconds</option>`).join('')}</select></label></div><button class="button primary" type="submit">Save settings</button></section><aside class="settings-actions"><section class="panel settings-panel"><p class="eyebrow">Tools</p><h2>Data and help</h2><p>Configuration exports include settings only. Grants and activity stay on this device.</p><button class="button" type="button" data-action="test-overlay">${icons.play}Try the blocker</button><button class="button" type="button" data-action="export">${icons.download}Export configuration</button><button class="button" type="button" data-action="import">${icons.upload}Import configuration</button><button class="button danger" type="button" data-action="reset-settings">Reset settings</button></section><div class="privacy-note">${icons.shield}<span>Little Pause stores settings, unlock windows, usage totals, Focus state, and activity locally. Microphone audio and recognized words are never saved.</span></div><div class="settings-tip"><strong>Fixed blue theme</strong>Little Pause uses the same denim-blue palette everywhere and does not switch themes automatically.</div></aside></form>`;
    bindRangeOutputs();
  }

  function render() {
    const section = currentSection();
    renderHeader(section);
    renderProtectionBar();
    if (section === 'sites') renderRulesSection();
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
    draftRule.method = data.get('method') || draftRule.method;
    if (data.has('phrase')) draftRule.phrase = String(data.get('phrase') || '').trim();
    if (data.has('voiceLevel')) draftRule.voiceLevel = Number(data.get('voiceLevel'));
    if (data.has('allowTimedFallback')) draftRule.allowTimedFallback = data.get('allowTimedFallback') === 'on';
    if (data.has('fallbackSeconds')) draftRule.fallbackSeconds = Number(data.get('fallbackSeconds'));
    if (data.has('dailyAllowanceMinutes')) draftRule.dailyAllowanceMinutes = data.get('dailyAllowanceMinutes') ? Number(data.get('dailyAllowanceMinutes')) : null;
    if (data.has('unlockMinutes')) draftRule.unlockMinutes = Number(data.get('unlockMinutes'));
    if (data.has('cooldownMinutes')) draftRule.cooldownMinutes = Number(data.get('cooldownMinutes'));
    if (data.has('exhaustedBehavior')) draftRule.exhaustedBehavior = data.get('exhaustedBehavior');
    if (data.has('includeSubdomains')) draftRule.includeSubdomains = data.get('includeSubdomains') === 'on';
    if (data.has('blockDuringFocus')) draftRule.blockDuringFocus = data.get('blockDuringFocus') === 'on';
    draftRule.schedule.forEach((window, index) => {
      window.start = String(data.get(`schedule-start-${index}`) || window.start);
      window.end = String(data.get(`schedule-end-${index}`) || window.end);
    });
    moreOptionsOpen = Boolean(document.querySelector('#more-options')?.open);
  }

  async function exportSettings() {
    const response = await send({ type: 'TTU_EXPORT_SETTINGS' }).catch(() => ({ payload: exportSettingsPayload(model.settings) }));
    const blob = new Blob([JSON.stringify(response.payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `little-pause-settings-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 500);
    showToast('Configuration exported.');
  }

  async function handleAction(action, target, event) {
    try {
      if (action === 'add-site') { elements.addForm.reset(); elements.addError.textContent = ''; elements.addDialog.showModal(); elements.addHostname.focus(); return; }
      if (action === 'import') { elements.importFile.click(); return; }
      if (action === 'export') { await exportSettings(); return; }
      if (action === 'edit-rule') { selectedRuleId = target.dataset.ruleId; draftRule = null; location.hash = 'sites'; render(); return; }
      if (action === 'select-rule') { if (event?.target.closest('.mini-switch')) return; selectedRuleId = target.dataset.ruleId; draftRule = null; moreOptionsOpen = false; renderRulesSection(); return; }
      if (action === 'toggle-rule') { event?.stopPropagation(); const next = structuredClone(model.settings); const rule = next.siteRules.find((entry) => entry.id === target.dataset.ruleId); rule.enabled = target.checked; await saveSettings(next, `${friendlySiteName(rule.hostname)} ${rule.enabled ? 'enabled' : 'paused'}.`); return; }
      if (action === 'add-window') { readRuleForm(); moreOptionsOpen = true; draftRule.schedule.push({ id: `window-${Date.now()}`, days: [1,2,3,4,5], start: '09:00', end: '18:00' }); renderRulesSection(); return; }
      if (action === 'remove-window') { readRuleForm(); draftRule.schedule.splice(Number(target.dataset.windowIndex), 1); moreOptionsOpen = true; renderRulesSection(); return; }
      if (action === 'toggle-day') { readRuleForm(); const window = draftRule.schedule[Number(target.dataset.windowIndex)]; const day = Number(target.dataset.day); window.days = window.days.includes(day) ? window.days.filter((value) => value !== day) : [...window.days, day].sort(); moreOptionsOpen = true; renderRulesSection(); return; }
      if (action === 'reset-rule') { draftRule = structuredClone(model.settings.siteRules.find((rule) => rule.id === selectedRuleId)); moreOptionsOpen = false; renderRulesSection(); showToast('Unsaved changes reset.'); return; }
      if (action === 'remove-rule') { if (!confirm(`Remove the rule for ${draftRule.hostname}?`)) return; const next = structuredClone(model.settings); next.siteRules = next.siteRules.filter((rule) => rule.id !== draftRule.id); selectedRuleId = next.siteRules[0]?.id || null; await saveSettings(next, 'Site removed.'); return; }
      if (action === 'pause-protection') { await send({ type: 'TTU_PAUSE_PROTECTION', minutes: 15 }); await load(); showToast('Protection paused for 15 minutes.'); return; }
      if (action === 'resume-protection') { await send({ type: 'TTU_RESUME_PROTECTION' }); await load(); showToast('Protection resumed.'); return; }
      if (action === 'clear-activity') { if (confirm('Clear all locally stored activity?')) { await send({ type: 'TTU_CLEAR_ACTIVITY' }); await load(); showToast('Activity cleared.'); } return; }
      if (action === 'reset-settings') { if (confirm('Reset all site rules and settings? This also clears the short setup state.')) { await send({ type: 'TTU_RESET_SETTINGS' }); await load(); showToast('Settings reset.'); } return; }
      if (action === 'test-overlay') { await send({ type: 'TTU_OPEN_PREVIEW' }); showToast('Blocker preview opened.'); }
    } catch (error) { showToast(error.message, 'error'); }
  }

  elements.headerActions.addEventListener('click', (event) => { const target = event.target.closest('[data-action]'); if (target) handleAction(target.dataset.action, target, event); });
  elements.protectionBar.addEventListener('change', async (event) => { if (event.target.id !== 'dashboard-enabled') return; try { await send({ type: 'TTU_SET_ENABLED', enabled: event.target.checked }); await load(); showToast(event.target.checked ? 'Protection turned on.' : 'Protection turned off.'); } catch (error) { showToast(error.message, 'error'); } });
  elements.protectionBar.addEventListener('click', (event) => { const target = event.target.closest('[data-action]'); if (target) handleAction(target.dataset.action, target, event); });
  elements.content.addEventListener('click', (event) => { const target = event.target.closest('[data-action]'); if (target) handleAction(target.dataset.action, target, event); });
  elements.content.addEventListener('input', (event) => {
    if (event.target.id !== 'rule-search') return;
    const cursor = event.target.selectionStart;
    ruleFilter = event.target.value;
    renderRulesSection();
    const nextInput = document.querySelector('#rule-search');
    nextInput?.focus();
    nextInput?.setSelectionRange(cursor, cursor);
  });
  elements.content.addEventListener('change', (event) => {
    if (event.target.id === 'activity-filter') { activityFilter = event.target.value; renderActivity(); return; }
    if (event.target.name === 'method') { readRuleForm(); draftRule.method = event.target.value; moreOptionsOpen = true; renderRulesSection(); }
  });
  elements.content.addEventListener('toggle', (event) => { if (event.target.id === 'more-options') moreOptionsOpen = event.target.open; }, true);
  elements.content.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      if (event.target.id === 'rule-form') {
        readRuleForm();
        if (draftRule.method === 'voice' && draftRule.phrase.length < 3) throw new Error('Use a phrase with at least 3 characters.');
        const next = structuredClone(model.settings);
        next.siteRules = next.siteRules.map((rule) => rule.id === draftRule.id ? draftRule : rule);
        await saveSettings(next, `${friendlySiteName(draftRule.hostname)} saved.`);
      }
      if (event.target.id === 'settings-form') {
        const data = new FormData(event.target);
        const next = sanitizeSettings({ ...model.settings, profile: data.get('profile'), defaultPhrase: data.get('defaultPhrase'), defaultVoiceLevel: Number(data.get('defaultVoiceLevel')), defaultFallbackSeconds: Number(data.get('defaultFallbackSeconds')), emergencyBypassEnabled: data.get('emergencyBypassEnabled') === 'on', emergencyHoldSeconds: Number(data.get('emergencyHoldSeconds')), activityRetentionDays: Number(data.get('activityRetentionDays')) });
        if (next.defaultPhrase.length < 3) throw new Error('Use a default phrase with at least 3 characters.');
        await saveSettings(next, 'Settings saved.');
      }
    } catch (error) { showToast(error.message, 'error'); }
  });
  document.querySelectorAll('[data-nav]').forEach((button) => button.addEventListener('click', () => { location.hash = button.dataset.nav; }));
  window.addEventListener('hashchange', () => { if (model) render(); });
  elements.addForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const hostname = normalizeSite(elements.addHostname.value);
    if (!hostname) { elements.addError.textContent = 'Enter a valid website, such as example.com.'; elements.addHostname.focus(); return; }
    if (model.settings.siteRules.some((rule) => rule.hostname === hostname)) { elements.addError.textContent = `${hostname} already has a rule.`; elements.addHostname.focus(); return; }
    const method = new FormData(elements.addForm).get('new-method') || 'pause';
    const id = globalThis.crypto?.randomUUID ? `rule-${crypto.randomUUID()}` : `rule-${Date.now()}`;
    const rule = createSiteRule(hostname, { id, method, phrase: model.settings.defaultPhrase, voiceLevel: model.settings.defaultVoiceLevel, fallbackSeconds: model.settings.defaultFallbackSeconds });
    const next = structuredClone(model.settings);
    next.siteRules.push(rule);
    selectedRuleId = rule.id;
    try {
      await saveSettings(next, `${friendlySiteName(hostname)} added.`);
      await send({ type: 'TTU_COMPLETE_ONBOARDING' });
      elements.addDialog.close();
      location.hash = 'sites';
    } catch (error) { elements.addError.textContent = error.message; }
  });
  elements.addHostname.addEventListener('input', () => { elements.addError.textContent = ''; });
  elements.importFile.addEventListener('change', async () => {
    const file = elements.importFile.files[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const settings = validateImportPayload(payload);
      if (!confirm(`Replace the current configuration with ${settings.siteRules.length} site rule${settings.siteRules.length === 1 ? '' : 's'}? Existing activity and unlock windows stay on this device.`)) return;
      await send({ type: 'TTU_IMPORT_SETTINGS', payload });
      await load();
      showToast('Configuration imported.');
    } catch (error) { showToast(error.message, 'error'); }
    finally { elements.importFile.value = ''; }
  });

  if (!location.hash) history.replaceState(null, '', `${location.pathname}${location.search}#sites`);
  load().catch((error) => { elements.content.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message || 'Could not load the dashboard.')}</p></div>`; showToast(error.message, 'error'); });
})();
