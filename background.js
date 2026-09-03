importScripts('shared.js');

const {
  createActivityEvent,
  createDefaultRuntime,
  createDefaultSettings,
  evaluateAccess,
  exportSettingsPayload,
  findMatchingRule,
  localDateKey,
  pruneActivity,
  sanitizeRuntime,
  sanitizeSettings,
  validateImportPayload
} = globalThis.TalkToUnlockUtils;

const FOCUS_ALARM = 'ttu-focus-expiry';
const LEGACY_KEYS = ['settingsVersion', 'enabled', 'blockedSites', 'requiredPhrase', 'requiredLevel'];
let mutationQueue = Promise.resolve();

function storageGet(keys = null) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (value) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(value);
    });
  });
}

function storageSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function storageRemove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}

function createAlarm(name, info) {
  chrome.alarms.create(name, info);
  return Promise.resolve();
}

function clearAlarm(name) {
  const result = chrome.alarms.clear(name);
  return result && typeof result.then === 'function' ? result : Promise.resolve(result);
}

async function ensureData() {
  const stored = await storageGet(null);
  const settings = sanitizeSettings(stored.settings || stored);
  const runtime = sanitizeRuntime(stored.runtime || createDefaultRuntime(), settings);
  await storageSet({ settings, runtime });
  if (stored.settingsVersion || stored.blockedSites || stored.requiredPhrase || stored.requiredLevel !== undefined) {
    await storageRemove(LEGACY_KEYS);
  }
  if (runtime.activeFocus) await createAlarm(FOCUS_ALARM, { when: runtime.activeFocus.endsAt });
  return { settings, runtime };
}

const ready = ensureData().catch(async () => {
  const settings = createDefaultSettings();
  const runtime = createDefaultRuntime();
  await storageSet({ settings, runtime });
  return { settings, runtime };
});

async function readState(now = Date.now()) {
  await ready;
  const stored = await storageGet(['settings', 'runtime']);
  const settings = sanitizeSettings(stored.settings);
  const runtime = sanitizeRuntime(stored.runtime, settings, now);
  return { settings, runtime };
}

function mutateState(mutator) {
  const operation = mutationQueue.then(async () => {
    const state = await readState();
    const result = await mutator(state);
    state.settings = sanitizeSettings(state.settings);
    state.runtime = sanitizeRuntime(state.runtime, state.settings);
    await storageSet(state);
    return result;
  });
  mutationQueue = operation.catch(() => {});
  return operation;
}

function addActivity(state, type, detail = {}, now = Date.now()) {
  const event = createActivityEvent(type, detail, now);
  if (!event) return;
  state.runtime.activity = pruneActivity([event, ...state.runtime.activity], now, state.settings.activityRetentionDays);
}

function summarizeState(settings, runtime, now = Date.now()) {
  const today = localDateKey(now);
  const todayUsage = runtime.usageByDate[today] || {};
  const todayActivity = runtime.activity.filter((event) => localDateKey(event.at) === today);
  const focusedTimeSeconds = Object.values(todayUsage).reduce((total, value) => total + value, 0);
  const unlocks = todayActivity.filter((event) => ['voice_success', 'pause_unlock', 'emergency_bypass'].includes(event.type)).length;
  let finiteAllowanceSeconds = 0;
  let finiteUsedSeconds = 0;

  settings.siteRules.forEach((rule) => {
    if (rule.dailyAllowanceMinutes === null) return;
    finiteAllowanceSeconds += rule.dailyAllowanceMinutes * 60;
    finiteUsedSeconds += Math.min(todayUsage[rule.id] || 0, rule.dailyAllowanceMinutes * 60);
  });

  return {
    unlocks,
    focusedTimeSeconds,
    finiteAllowanceSeconds,
    finiteRemainingSeconds: Math.max(0, finiteAllowanceSeconds - finiteUsedSeconds),
    activeRuleCount: settings.siteRules.filter((rule) => rule.enabled).length,
    activeFocus: runtime.activeFocus,
    protectionPausedUntil: runtime.protectionPausedUntil,
    todayUsage
  };
}

async function recordUnlock(hostname, method) {
  return mutateState((state) => {
    const now = Date.now();
    const rule = findMatchingRule(hostname, state.settings.siteRules);
    if (!rule) throw new Error('No active rule was found for this site.');
    const grant = {
      ruleId: rule.id,
      hostname: rule.hostname,
      startsAt: now,
      endsAt: now + rule.unlockMinutes * 60000,
      method
    };
    state.runtime.grantsByRule[rule.id] = grant;
    if (rule.cooldownMinutes > 0) state.runtime.cooldownsByRule[rule.id] = grant.endsAt + rule.cooldownMinutes * 60000;
    const eventType = method === 'emergency' ? 'emergency_bypass' : method === 'pause' ? 'pause_unlock' : 'voice_success';
    addActivity(state, eventType, { hostname: rule.hostname, ruleId: rule.id, unlockMinutes: rule.unlockMinutes }, now);
    return { ok: true, grant };
  });
}

async function recordHeartbeat(hostname, deltaSeconds) {
  return mutateState((state) => {
    const now = Date.now();
    const rule = findMatchingRule(hostname, state.settings.siteRules);
    if (!rule) return { ok: false, exhausted: false };
    const grant = state.runtime.grantsByRule[rule.id];
    if (!grant || grant.endsAt <= now) return { ok: false, exhausted: false };
    const date = localDateKey(now);
    state.runtime.usageByDate[date] ||= {};
    const increment = Math.min(30, Math.max(1, Math.round(Number(deltaSeconds) || 0)));
    state.runtime.usageByDate[date][rule.id] = (state.runtime.usageByDate[date][rule.id] || 0) + increment;
    const usedSeconds = state.runtime.usageByDate[date][rule.id];
    const allowanceSeconds = rule.dailyAllowanceMinutes === null ? null : rule.dailyAllowanceMinutes * 60;
    return { ok: true, usedSeconds, allowanceSeconds, exhausted: allowanceSeconds !== null && usedSeconds >= allowanceSeconds };
  });
}

async function startFocus(minutes) {
  return mutateState(async (state) => {
    const now = Date.now();
    const durationMinutes = Math.min(240, Math.max(5, Math.round(Number(minutes) || 25)));
    state.runtime.activeFocus = {
      id: `focus-${now}`,
      startedAt: now,
      endsAt: now + durationMinutes * 60000,
      durationMinutes
    };
    addActivity(state, 'focus_started', { durationMinutes }, now);
    await createAlarm(FOCUS_ALARM, { when: state.runtime.activeFocus.endsAt });
    return { ok: true, activeFocus: state.runtime.activeFocus };
  });
}

async function endFocus() {
  return mutateState(async (state) => {
    if (state.runtime.activeFocus) addActivity(state, 'focus_ended', { durationMinutes: state.runtime.activeFocus.durationMinutes });
    state.runtime.activeFocus = null;
    await clearAlarm(FOCUS_ALARM);
    return { ok: true };
  });
}

async function handleMessage(message, sender) {
  const type = message?.type;
  if (type === 'TTU_EVALUATE_SITE') {
    const state = await readState();
    return {
      ok: true,
      ...evaluateAccess({ ...state, hostname: message.hostname }),
      policy: {
        emergencyBypassEnabled: state.settings.emergencyBypassEnabled,
        emergencyHoldSeconds: state.settings.emergencyHoldSeconds
      }
    };
  }
  if (type === 'TTU_GET_DASHBOARD') {
    const state = await readState();
    return { ok: true, ...state, summary: summarizeState(state.settings, state.runtime) };
  }
  if (type === 'TTU_RECORD_UNLOCK') return recordUnlock(message.hostname, message.method);
  if (type === 'TTU_USAGE_HEARTBEAT') return recordHeartbeat(message.hostname, message.deltaSeconds);
  if (type === 'TTU_START_FOCUS') return startFocus(message.minutes);
  if (type === 'TTU_STOP_FOCUS') return endFocus();
  if (type === 'TTU_SET_ENABLED') {
    return mutateState((state) => {
      state.settings.enabled = message.enabled !== false;
      return { ok: true, enabled: state.settings.enabled };
    });
  }
  if (type === 'TTU_PAUSE_PROTECTION') {
    return mutateState((state) => {
      const minutes = Math.min(1440, Math.max(1, Math.round(Number(message.minutes) || 15)));
      state.runtime.protectionPausedUntil = Date.now() + minutes * 60000;
      addActivity(state, 'protection_paused', { minutes });
      return { ok: true, until: state.runtime.protectionPausedUntil };
    });
  }
  if (type === 'TTU_RESUME_PROTECTION') {
    return mutateState((state) => {
      state.runtime.protectionPausedUntil = 0;
      return { ok: true };
    });
  }
  if (type === 'TTU_SAVE_SETTINGS') {
    return mutateState((state) => {
      state.settings = sanitizeSettings(message.settings);
      return { ok: true, settings: state.settings };
    });
  }
  if (type === 'TTU_IMPORT_SETTINGS') {
    return mutateState((state) => {
      state.settings = validateImportPayload(message.payload);
      state.runtime = sanitizeRuntime(state.runtime, state.settings);
      return { ok: true, settings: state.settings };
    });
  }
  if (type === 'TTU_EXPORT_SETTINGS') {
    const { settings } = await readState();
    return { ok: true, payload: exportSettingsPayload(settings) };
  }
  if (type === 'TTU_RESET_SETTINGS') {
    return mutateState((state) => {
      state.settings = createDefaultSettings();
      state.runtime = createDefaultRuntime();
      return { ok: true, settings: state.settings };
    });
  }
  if (type === 'TTU_CLEAR_ACTIVITY') {
    return mutateState((state) => {
      state.runtime.activity = [];
      return { ok: true };
    });
  }
  if (type === 'TTU_RECORD_EVENT') {
    return mutateState((state) => {
      const rule = findMatchingRule(message.hostname, state.settings.siteRules);
      addActivity(state, message.eventType, { hostname: rule?.hostname || message.hostname, ruleId: rule?.id, ...(message.detail || {}) });
      return { ok: true };
    });
  }
  if (type === 'TTU_OPEN_SETTINGS') {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  }
  if (type === 'TTU_OPEN_DASHBOARD') {
    const hash = ['overview', 'site-rules', 'schedules', 'focus', 'activity', 'settings'].includes(message.section) ? `#${message.section}` : '';
    const query = message.ruleId ? `?rule=${encodeURIComponent(message.ruleId)}` : '';
    await chrome.tabs.create({ url: `${chrome.runtime.getURL('dashboard.html')}${query}${hash}` });
    return { ok: true };
  }
  if (type === 'TTU_OPEN_PREVIEW') {
    await chrome.tabs.create({ url: chrome.runtime.getURL('preview.html') });
    return { ok: true };
  }
  if (type === 'TTU_CLOSE_TAB') {
    if (!sender.tab?.id) throw new Error('The current tab could not be closed.');
    await chrome.tabs.remove(sender.tab.id);
    return { ok: true };
  }
  return { ok: false, error: 'Unknown message.' };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message || 'Something went wrong.' }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => ensureData());
chrome.runtime.onStartup.addListener(() => ensureData());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FOCUS_ALARM) endFocus().catch(() => {});
});
