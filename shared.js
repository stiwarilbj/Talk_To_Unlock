(function attachTalkToUnlockUtils(scope) {
  'use strict';

  const SETTINGS_VERSION = 3;
  const DEFAULT_PHRASE = 'I choose to continue';
  // Suggestions are used by onboarding only. Fresh settings never silently
  // enable these domains.
  const DEFAULT_SITES = Object.freeze(['youtube.com', 'instagram.com', 'reddit.com', 'tiktok.com', 'x.com', 'facebook.com']);
  const VALID_METHODS = new Set(['voice', 'pause', 'blocked']);
  const VALID_PROFILES = new Set(['gentle', 'balanced', 'strict']);
  const VALID_EXHAUSTED_BEHAVIORS = new Set(['block', 'voice']);
  const ACTIVITY_TYPES = new Set([
    'gate_shown', 'voice_success', 'voice_failure', 'pause_unlock', 'emergency_bypass',
    'focus_started', 'focus_ended', 'protection_paused'
  ]);
  const CONTRACTIONS = [
    [/\bi[’']m\b/giu, 'i am'], [/\bi[’']ve\b/giu, 'i have'], [/\bi[’']ll\b/giu, 'i will'],
    [/\bcan[’']t\b/giu, 'cannot'], [/\bwon[’']t\b/giu, 'will not'], [/\bdon[’']t\b/giu, 'do not'],
    [/\bdoesn[’']t\b/giu, 'does not'], [/\bdidn[’']t\b/giu, 'did not'],
    [/\bit[’']s\b/giu, 'it is'], [/\bthat[’']s\b/giu, 'that is']
  ];

  function clampNumber(value, minimum, maximum, fallback, integer = true) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    const clamped = Math.min(maximum, Math.max(minimum, numeric));
    return integer ? Math.round(clamped) : clamped;
  }

  function normalizePhrase(value) {
    let phrase = String(value ?? '').normalize('NFKC').toLowerCase();
    for (const [pattern, replacement] of CONTRACTIONS) phrase = phrase.replace(pattern, replacement);
    return phrase.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  }

  function phrasesMatch(transcript, target) {
    const normalizedTarget = normalizePhrase(target);
    return normalizedTarget.length > 0 && normalizePhrase(transcript) === normalizedTarget;
  }

  function normalizeSite(value) {
    let input = String(value ?? '').trim().toLowerCase();
    if (!input) return null;
    input = input.replace(/^\*\./, '');
    try {
      const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
      if (!['http:', 'https:'].includes(url.protocol)) return null;
      const hostname = url.hostname.replace(/^www\./, '').replace(/\.$/, '').toLowerCase();
      if (!hostname || hostname.length > 253) return null;
      if (hostname !== 'localhost' && !hostname.includes('.')) return null;
      if (!/^[a-z0-9.-]+$/.test(hostname)) return null;
      if (hostname.split('.').some((label) => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) return null;
      return hostname;
    } catch (_error) {
      return null;
    }
  }

  function normalizeHostname(value) {
    return String(value ?? '').trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  }

  function slugForSite(hostname) {
    return `rule-${hostname.replace(/[^a-z0-9]+/g, '-')}`;
  }

  function sanitizeTime(value, fallback) {
    const match = String(value || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    return match ? `${match[1]}:${match[2]}` : fallback;
  }

  function sanitizeSchedule(schedule) {
    if (!Array.isArray(schedule)) return [];
    return schedule.slice(0, 12).map((window, index) => ({
      id: String(window?.id || `window-${index + 1}`),
      days: [...new Set((Array.isArray(window?.days) ? window.days : []).map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort(),
      start: sanitizeTime(window?.start, '09:00'),
      end: sanitizeTime(window?.end, '18:00')
    })).filter((window) => window.days.length > 0);
  }

  function createSiteRule(hostname, overrides = {}) {
    const normalized = normalizeSite(hostname) || 'example.com';
    return {
      id: String(overrides.id || slugForSite(normalized)),
      hostname: normalized,
      enabled: overrides.enabled !== false,
      includeSubdomains: overrides.includeSubdomains !== false,
      method: VALID_METHODS.has(overrides.method) ? overrides.method : 'pause',
      phrase: String(overrides.phrase || DEFAULT_PHRASE).trim() || DEFAULT_PHRASE,
      voiceLevel: clampNumber(overrides.voiceLevel, 0, 100, 35),
      allowTimedFallback: overrides.allowTimedFallback !== false,
      fallbackSeconds: clampNumber(overrides.fallbackSeconds, 5, 60, 10),
      unlockMinutes: clampNumber(overrides.unlockMinutes, 1, 240, 5),
      cooldownMinutes: clampNumber(overrides.cooldownMinutes, 0, 1440, 0),
      dailyAllowanceMinutes: overrides.dailyAllowanceMinutes === null || overrides.dailyAllowanceMinutes === '' || overrides.dailyAllowanceMinutes === undefined
        ? null
        : clampNumber(overrides.dailyAllowanceMinutes, 1, 1440, 30),
      exhaustedBehavior: VALID_EXHAUSTED_BEHAVIORS.has(overrides.exhaustedBehavior) ? overrides.exhaustedBehavior : 'block',
      schedule: sanitizeSchedule(overrides.schedule),
      blockDuringFocus: overrides.blockDuringFocus !== false
    };
  }

  function sanitizeSiteRule(raw, fallbackHostname = 'example.com') {
    const hostname = normalizeSite(raw?.hostname || fallbackHostname);
    return hostname ? createSiteRule(hostname, raw || {}) : null;
  }

  function createDefaultSettings() {
    return {
      settingsVersion: SETTINGS_VERSION,
      enabled: true,
      profile: 'balanced',
      defaultPhrase: DEFAULT_PHRASE,
      defaultVoiceLevel: 35,
      defaultFallbackSeconds: 10,
      emergencyBypassEnabled: true,
      emergencyHoldSeconds: 5,
      activityRetentionDays: 30,
      // Keep new installs calm and intentional: onboarding adds rules after
      // the user chooses them. The 10-second default comes from the rule
      // factory and remains editable in More options.
      siteRules: []
    };
  }

  function sanitizeSettings(raw = {}) {
    const defaults = createDefaultSettings();
    const migratedSites = Array.isArray(raw.blockedSites)
      ? raw.blockedSites.map((hostname) => createSiteRule(hostname, {
          method: 'voice',
          phrase: raw.requiredPhrase || DEFAULT_PHRASE,
          voiceLevel: raw.requiredLevel,
          allowTimedFallback: true
        }))
      : null;
    const sourceRules = Array.isArray(raw.siteRules) ? raw.siteRules : migratedSites;
    const sanitizedRules = (sourceRules || []).map((rule) => sanitizeSiteRule(rule, rule?.hostname)).filter(Boolean);
    const uniqueRules = [];
    const seenHosts = new Set();
    sanitizedRules.forEach((rule) => {
      if (seenHosts.has(rule.hostname)) return;
      seenHosts.add(rule.hostname);
      let id = rule.id;
      let suffix = 2;
      while (uniqueRules.some((entry) => entry.id === id)) id = `${rule.id}-${suffix++}`;
      uniqueRules.push({ ...rule, id });
    });

    return {
      settingsVersion: SETTINGS_VERSION,
      enabled: raw.enabled !== false,
      profile: VALID_PROFILES.has(raw.profile) ? raw.profile : defaults.profile,
      defaultPhrase: String(raw.defaultPhrase || raw.requiredPhrase || defaults.defaultPhrase).trim() || defaults.defaultPhrase,
      defaultVoiceLevel: clampNumber(raw.defaultVoiceLevel ?? raw.requiredLevel, 0, 100, defaults.defaultVoiceLevel),
      defaultFallbackSeconds: clampNumber(raw.defaultFallbackSeconds, 5, 60, defaults.defaultFallbackSeconds),
      emergencyBypassEnabled: raw.emergencyBypassEnabled !== false,
      emergencyHoldSeconds: clampNumber(raw.emergencyHoldSeconds, 3, 10, defaults.emergencyHoldSeconds),
      activityRetentionDays: clampNumber(raw.activityRetentionDays, 1, 90, defaults.activityRetentionDays),
      siteRules: uniqueRules
    };
  }

  function createDefaultRuntime() {
    return {
      protectionPausedUntil: 0,
      activeFocus: null,
      grantsByRule: {},
      cooldownsByRule: {},
      usageByDate: {},
      activity: []
    };
  }

  function sanitizeActivityEvent(event) {
    if (!event || !ACTIVITY_TYPES.has(event.type)) return null;
    const detail = event.detail && typeof event.detail === 'object' ? { ...event.detail } : {};
    return {
      id: String(event.id || `${Number(event.at) || Date.now()}-${event.type}`),
      at: Math.max(0, Number(event.at) || Date.now()),
      type: event.type,
      hostname: normalizeSite(event.hostname) || null,
      ruleId: event.ruleId ? String(event.ruleId) : null,
      detail
    };
  }

  function pruneActivity(events, now = Date.now(), retentionDays = 30, maximum = 1000) {
    const cutoff = now - clampNumber(retentionDays, 1, 90, 30) * 86400000;
    return (Array.isArray(events) ? events : []).map(sanitizeActivityEvent).filter((event) => event && event.at >= cutoff).sort((a, b) => b.at - a.at).slice(0, maximum);
  }

  function sanitizeRuntime(raw = {}, settings = createDefaultSettings(), now = Date.now()) {
    const activeFocus = raw.activeFocus && Number(raw.activeFocus.endsAt) > now
      ? {
          id: String(raw.activeFocus.id || `focus-${Number(raw.activeFocus.startedAt) || now}`),
          startedAt: Number(raw.activeFocus.startedAt) || now,
          endsAt: Number(raw.activeFocus.endsAt),
          durationMinutes: clampNumber(raw.activeFocus.durationMinutes, 5, 240, 25)
        }
      : null;
    const validRuleIds = new Set(settings.siteRules.map((rule) => rule.id));
    const grantsByRule = {};
    const cooldownsByRule = {};
    Object.entries(raw.grantsByRule || {}).forEach(([ruleId, grant]) => {
      if (!validRuleIds.has(ruleId) || Number(grant?.endsAt) <= now) return;
      grantsByRule[ruleId] = {
        ruleId,
        hostname: normalizeSite(grant.hostname) || settings.siteRules.find((rule) => rule.id === ruleId)?.hostname,
        startsAt: Number(grant.startsAt) || now,
        endsAt: Number(grant.endsAt),
        method: ['voice', 'pause', 'emergency'].includes(grant.method) ? grant.method : 'voice'
      };
    });
    Object.entries(raw.cooldownsByRule || {}).forEach(([ruleId, endsAt]) => {
      if (validRuleIds.has(ruleId) && Number(endsAt) > now) cooldownsByRule[ruleId] = Number(endsAt);
    });
    const usageByDate = {};
    Object.entries(raw.usageByDate || {}).slice(-40).forEach(([date, usage]) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !usage || typeof usage !== 'object') return;
      usageByDate[date] = {};
      Object.entries(usage).forEach(([ruleId, seconds]) => {
        if (validRuleIds.has(ruleId)) usageByDate[date][ruleId] = Math.max(0, Math.round(Number(seconds) || 0));
      });
    });
    return {
      protectionPausedUntil: Number(raw.protectionPausedUntil) > now ? Number(raw.protectionPausedUntil) : 0,
      activeFocus,
      grantsByRule,
      cooldownsByRule,
      usageByDate,
      activity: pruneActivity(raw.activity, now, settings.activityRetentionDays)
    };
  }

  function findMatchingRule(hostname, siteRules) {
    const current = normalizeHostname(hostname);
    return [...(siteRules || [])].filter((rule) => rule.enabled && (current === rule.hostname || (rule.includeSubdomains && current.endsWith(`.${rule.hostname}`)))).sort((a, b) => b.hostname.length - a.hostname.length)[0] || null;
  }

  function matchingBlockedSite(hostname, blockedSites) {
    return findMatchingRule(hostname, (blockedSites || []).map((site) => createSiteRule(site)))?.hostname || null;
  }

  function timeToMinutes(value) {
    const [hours, minutes] = String(value).split(':').map(Number);
    return hours * 60 + minutes;
  }

  function isScheduleActive(rule, date = new Date()) {
    if (!rule?.schedule?.length) return true;
    const day = date.getDay();
    const previousDay = (day + 6) % 7;
    const minute = date.getHours() * 60 + date.getMinutes();
    return rule.schedule.some((window) => {
      const start = timeToMinutes(window.start);
      const end = timeToMinutes(window.end);
      if (start === end) return window.days.includes(day);
      if (start < end) return window.days.includes(day) && minute >= start && minute < end;
      return (window.days.includes(day) && minute >= start) || (window.days.includes(previousDay) && minute < end);
    });
  }

  function localDateKey(dateOrTimestamp = Date.now()) {
    const date = dateOrTimestamp instanceof Date ? dateOrTimestamp : new Date(dateOrTimestamp);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function resolveRuleMethod(profile, rule) {
    if (profile === 'gentle' && rule.method === 'voice') return { method: 'pause', allowTimedFallback: true };
    if (profile === 'strict') return { method: rule.method, allowTimedFallback: false };
    return { method: rule.method, allowTimedFallback: rule.allowTimedFallback };
  }

  function evaluateAccess({ settings: rawSettings, runtime: rawRuntime, hostname, now = Date.now() }) {
    const settings = sanitizeSettings(rawSettings);
    const runtime = sanitizeRuntime(rawRuntime, settings, now);
    if (!settings.enabled) return { decision: 'allow', reason: 'disabled', rule: null };
    if (runtime.protectionPausedUntil > now) return { decision: 'allow', reason: 'protection_paused', rule: null, until: runtime.protectionPausedUntil };
    const rule = findMatchingRule(hostname, settings.siteRules);
    if (!rule) return { decision: 'allow', reason: 'no_rule', rule: null };
    const grant = runtime.grantsByRule[rule.id];
    if (grant?.endsAt > now && grant.method === 'emergency') return { decision: 'allow', reason: 'emergency_grant', rule, grant, until: grant.endsAt };
    if (runtime.activeFocus && rule.blockDuringFocus) return { decision: 'blocked', reason: 'focus', rule, until: runtime.activeFocus.endsAt, allowEmergency: settings.emergencyBypassEnabled };
    if (!isScheduleActive(rule, new Date(now))) return { decision: 'allow', reason: 'outside_schedule', rule };
    if (grant?.endsAt > now) return { decision: 'allow', reason: 'grant', rule, grant, until: grant.endsAt };
    const today = localDateKey(now);
    const usedSeconds = runtime.usageByDate[today]?.[rule.id] || 0;
    const allowanceSeconds = rule.dailyAllowanceMinutes === null ? null : rule.dailyAllowanceMinutes * 60;
    if (allowanceSeconds !== null && usedSeconds >= allowanceSeconds) {
      if (rule.exhaustedBehavior === 'block') return { decision: 'blocked', reason: 'allowance_exhausted', rule, usedSeconds, allowanceSeconds, allowEmergency: settings.emergencyBypassEnabled };
      return { decision: 'voice', reason: 'allowance_exhausted_voice', rule, usedSeconds, allowanceSeconds, allowTimedFallback: false, allowEmergency: settings.emergencyBypassEnabled };
    }
    const cooldownUntil = runtime.cooldownsByRule[rule.id] || 0;
    if (cooldownUntil > now) return { decision: 'blocked', reason: 'cooldown', rule, until: cooldownUntil, usedSeconds, allowanceSeconds, allowEmergency: settings.emergencyBypassEnabled };
    const resolved = resolveRuleMethod(settings.profile, rule);
    return {
      decision: resolved.method,
      reason: 'rule',
      rule,
      usedSeconds,
      allowanceSeconds,
      allowTimedFallback: resolved.method === 'voice' && resolved.allowTimedFallback,
      fallbackSeconds: rule.fallbackSeconds || settings.defaultFallbackSeconds,
      allowEmergency: settings.emergencyBypassEnabled
    };
  }

  function createActivityEvent(type, detail = {}, now = Date.now()) {
    if (!ACTIVITY_TYPES.has(type)) return null;
    const { hostname, ruleId, ...eventDetail } = detail;
    return sanitizeActivityEvent({ id: `${now}-${Math.random().toString(36).slice(2, 8)}`, at: now, type, hostname, ruleId, detail: eventDetail });
  }

  function exportSettingsPayload(settings, now = Date.now()) {
    return { type: 'talk-to-unlock-settings', version: SETTINGS_VERSION, exportedAt: new Date(now).toISOString(), settings: sanitizeSettings(settings) };
  }

  function validateImportPayload(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('The selected file is not valid JSON settings.');
    if (payload.type !== 'talk-to-unlock-settings' || Number(payload.version) !== SETTINGS_VERSION || !payload.settings) throw new Error('Choose a Talk to Unlock 3.0 settings export.');
    const settings = sanitizeSettings(payload.settings);
    return settings;
  }

  function summarizeSchedule(rule) {
    if (!rule.schedule.length) return 'Always active';
    if (rule.schedule.length === 1) return `${rule.schedule[0].start}–${rule.schedule[0].end}`;
    return `${rule.schedule.length} time windows`;
  }

  const DEFAULT_SETTINGS = Object.freeze(createDefaultSettings());
  scope.TalkToUnlockUtils = Object.freeze({
    ACTIVITY_TYPES, DEFAULT_PHRASE, DEFAULT_SETTINGS, DEFAULT_SITES, SETTINGS_VERSION,
    createActivityEvent, createDefaultRuntime, createDefaultSettings, createSiteRule,
    evaluateAccess, exportSettingsPayload, findMatchingRule, isScheduleActive, localDateKey,
    matchingBlockedSite, normalizeHostname, normalizePhrase, normalizeSite, phrasesMatch,
    pruneActivity, resolveRuleMethod, sanitizeRuntime, sanitizeSchedule, sanitizeSettings,
    sanitizeSiteRule, summarizeSchedule, validateImportPayload
  });
})(globalThis);
