(function installPreviewChromeApi(scope) {
  'use strict';

  if (scope.chrome?.runtime?.id) return;
  document.documentElement.classList.add('ttu-preview');
  const previewKey = 'talk-to-unlock-preview-v3-blue-hour-3';
  const messageListeners = [];
  const storageListeners = [];
  const defaultRule = (hostname, index) => ({
    id: `rule-${hostname.replace(/\W/g, '-')}-${index}`,
    hostname,
    enabled: true,
    includeSubdomains: true,
    method: index === 2 ? 'blocked' : index === 3 ? 'pause' : 'voice',
    phrase: 'I choose to continue',
    voiceLevel: 35,
    allowTimedFallback: true,
    fallbackSeconds: index === 3 ? 15 : 10,
    unlockMinutes: 5,
    cooldownMinutes: index === 0 || index === 4 ? 20 : 0,
    dailyAllowanceMinutes: index === 0 ? 12 : null,
    exhaustedBehavior: 'block',
    schedule: index === 0 || index === 2 ? [{ id: 'weekday', days: [1,2,3,4,5], start: '09:00', end: '18:00' }] : [],
    blockDuringFocus: true
  });
  const defaults = {
    settings: {
      settingsVersion: 3,
      enabled: true,
      profile: 'balanced',
      defaultPhrase: 'I choose to continue',
      defaultVoiceLevel: 35,
      defaultFallbackSeconds: 10,
      emergencyBypassEnabled: true,
      emergencyHoldSeconds: 5,
      activityRetentionDays: 30,
      siteRules: ['youtube.com','instagram.com','reddit.com','tiktok.com','x.com','facebook.com'].map(defaultRule)
    },
    runtime: { protectionPausedUntil: 0, activeFocus: null, grantsByRule: {}, cooldownsByRule: {}, usageByDate: {}, activity: [] }
  };
  let data;
  try { data = { ...defaults, ...(JSON.parse(localStorage.getItem(previewKey)) || {}) }; }
  catch (_error) { data = structuredClone(defaults); }

  function save(changes = {}) {
    localStorage.setItem(previewKey, JSON.stringify(data));
    storageListeners.forEach((listener) => listener(changes, 'local'));
  }

  function dateKey(timestamp = Date.now()) {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  }

  function summary() {
    if (data.runtime.activeFocus?.endsAt <= Date.now()) data.runtime.activeFocus = null;
    const today = data.runtime.usageByDate[dateKey()] || {};
    const focusedTimeSeconds = Object.values(today).reduce((sum, value) => sum + value, 0);
    const finiteRules = data.settings.siteRules.filter((rule) => rule.dailyAllowanceMinutes !== null);
    const finiteAllowanceSeconds = finiteRules.reduce((sum, rule) => sum + rule.dailyAllowanceMinutes * 60, 0);
    const finiteUsedSeconds = finiteRules.reduce((sum, rule) => sum + Math.min(today[rule.id] || 0, rule.dailyAllowanceMinutes * 60), 0);
    return {
      unlocks: data.runtime.activity.filter((event) => dateKey(event.at) === dateKey() && ['voice_success','pause_unlock','emergency_bypass'].includes(event.type)).length,
      focusedTimeSeconds,
      finiteAllowanceSeconds,
      finiteRemainingSeconds: Math.max(0, finiteAllowanceSeconds - finiteUsedSeconds),
      activeRuleCount: data.settings.siteRules.filter((rule) => rule.enabled).length,
      activeFocus: data.runtime.activeFocus,
      protectionPausedUntil: data.runtime.protectionPausedUntil,
      todayUsage: today
    };
  }

  function addEvent(type, hostname = null, detail = {}) {
    data.runtime.activity.unshift({ id: `${Date.now()}-${Math.random()}`, at: Date.now(), type, hostname, ruleId: data.settings.siteRules.find((rule) => rule.hostname === hostname)?.id || null, detail });
  }

  function handle(message) {
    const type = message?.type;
    if (type === 'TTU_GET_DASHBOARD') return { ok: true, settings: structuredClone(data.settings), runtime: structuredClone(data.runtime), summary: summary() };
    if (type === 'TTU_SET_ENABLED') { data.settings.enabled = message.enabled !== false; save(); return { ok: true }; }
    if (type === 'TTU_SAVE_SETTINGS') { data.settings = structuredClone(message.settings); save(); return { ok: true, settings: data.settings }; }
    if (type === 'TTU_RESET_SETTINGS') { data = structuredClone(defaults); save(); return { ok: true, settings: data.settings }; }
    if (type === 'TTU_CLEAR_ACTIVITY') { data.runtime.activity = []; save(); return { ok: true }; }
    if (type === 'TTU_START_FOCUS') { const minutes = Number(message.minutes) || 25; data.runtime.activeFocus = { id: `focus-${Date.now()}`, startedAt: Date.now(), endsAt: Date.now() + minutes * 60000, durationMinutes: minutes }; addEvent('focus_started', null, { durationMinutes: minutes }); save(); return { ok: true, activeFocus: data.runtime.activeFocus }; }
    if (type === 'TTU_STOP_FOCUS') { data.runtime.activeFocus = null; addEvent('focus_ended'); save(); return { ok: true }; }
    if (type === 'TTU_PAUSE_PROTECTION') { data.runtime.protectionPausedUntil = Date.now() + (Number(message.minutes) || 15) * 60000; addEvent('protection_paused', null, { minutes: Number(message.minutes) || 15 }); save(); return { ok: true }; }
    if (type === 'TTU_RESUME_PROTECTION') { data.runtime.protectionPausedUntil = 0; save(); return { ok: true }; }
    if (type === 'TTU_EXPORT_SETTINGS') return { ok: true, payload: { type: 'talk-to-unlock-settings', version: 3, exportedAt: new Date().toISOString(), settings: data.settings } };
    if (type === 'TTU_IMPORT_SETTINGS') { data.settings = structuredClone(message.payload.settings); save(); return { ok: true, settings: data.settings }; }
    if (type === 'TTU_RECORD_EVENT') { addEvent(message.eventType, message.hostname, message.detail); save(); return { ok: true }; }
    if (type === 'TTU_RECORD_UNLOCK') {
      const rule = data.settings.siteRules.find((entry) => message.hostname === entry.hostname || message.hostname.endsWith(`.${entry.hostname}`)) || data.settings.siteRules[0];
      const grant = { ruleId: rule.id, hostname: rule.hostname, startsAt: Date.now(), endsAt: Date.now() + rule.unlockMinutes * 60000, method: message.method };
      data.runtime.grantsByRule[rule.id] = grant;
      addEvent(message.method === 'voice' ? 'voice_success' : message.method === 'pause' ? 'pause_unlock' : 'emergency_bypass', rule.hostname);
      save(); return { ok: true, grant };
    }
    if (type === 'TTU_USAGE_HEARTBEAT') return { ok: true, exhausted: false };
    if (type === 'TTU_EVALUATE_SITE') {
      const current = message.hostname || 'youtube.com';
      const rule = data.settings.siteRules.find((entry) => current === entry.hostname || current.endsWith(`.${entry.hostname}`)) || data.settings.siteRules[0];
      const grant = data.runtime.grantsByRule[rule.id];
      if (grant?.endsAt > Date.now()) return { ok: true, decision: 'allow', reason: 'grant', rule, grant, until: grant.endsAt, policy: { emergencyHoldSeconds: 5 } };
      if (data.runtime.activeFocus?.endsAt > Date.now() && rule.blockDuringFocus) return { ok: true, decision: 'blocked', reason: 'focus', rule, until: data.runtime.activeFocus.endsAt, allowEmergency: true, policy: { emergencyHoldSeconds: 5 } };
      return { ok: true, decision: rule.method, reason: 'rule', rule, usedSeconds: 240, allowanceSeconds: rule.dailyAllowanceMinutes ? rule.dailyAllowanceMinutes * 60 : null, allowTimedFallback: rule.allowTimedFallback, fallbackSeconds: rule.fallbackSeconds, allowEmergency: true, policy: { emergencyHoldSeconds: 5 } };
    }
    if (type === 'TTU_OPEN_DASHBOARD') { location.href = `dashboard.html${message.ruleId ? `?rule=${encodeURIComponent(message.ruleId)}` : ''}#${message.section || 'overview'}`; return { ok: true }; }
    if (type === 'TTU_OPEN_SETTINGS') { location.href = 'dashboard.html#settings'; return { ok: true }; }
    if (type === 'TTU_OPEN_PREVIEW') { window.open('preview.html', '_blank'); return { ok: true }; }
    if (type === 'TTU_CLOSE_TAB') return { ok: false, error: 'Close tab is disabled in preview mode.' };
    return { ok: false, error: 'Unknown preview message.' };
  }

  const chromeApi = scope.chrome || {};
  chromeApi.runtime = {
    id: 'talk-to-unlock-preview',
    lastError: null,
    getURL(path) { return new URL(path, location.href).href; },
    openOptionsPage() { location.href = 'dashboard.html#overview'; return Promise.resolve(); },
    onMessage: { addListener(listener) { messageListeners.push(listener); } },
    sendMessage(message, callback) { queueMicrotask(() => callback?.(handle(message))); }
  };
  chromeApi.storage = {
    local: {
      get(keys, callback) { let result = structuredClone(data); if (Array.isArray(keys)) result = Object.fromEntries(keys.map((key) => [key, structuredClone(data[key])])); else if (typeof keys === 'string') result = { [keys]: structuredClone(data[keys]) }; queueMicrotask(() => callback(result)); },
      set(values, callback) { const changes = {}; Object.entries(values).forEach(([key,value]) => { changes[key] = { oldValue: data[key], newValue: value }; data[key] = structuredClone(value); }); save(changes); queueMicrotask(() => callback?.()); },
      remove(keys, callback) { (Array.isArray(keys) ? keys : [keys]).forEach((key) => delete data[key]); save(); queueMicrotask(() => callback?.()); }
    },
    onChanged: { addListener(listener) { storageListeners.push(listener); } }
  };
  chromeApi.tabs = {
    create({ url }) { window.open(url, '_blank'); return Promise.resolve(); },
    remove() { return Promise.resolve(); },
    query(_query, callback) { callback([{ id: 1, url: location.href }]); },
    sendMessage(_id, message, callback) { let responded = false; messageListeners.forEach((listener) => listener(message, { tab: { id: 1 } }, (response) => { responded = true; callback?.(response); })); if (!responded) callback?.({ ok: true }); }
  };
  chromeApi.alarms = { create() {}, clear() { return Promise.resolve(true); }, onAlarm: { addListener() {} } };
  scope.chrome = chromeApi;
})(globalThis);
