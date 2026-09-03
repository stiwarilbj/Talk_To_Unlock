const test = require('node:test');
const assert = require('node:assert/strict');

require('../shared.js');
const {
  createDefaultRuntime,
  createSiteRule,
  evaluateAccess,
  findMatchingRule,
  isScheduleActive,
  localDateKey,
  normalizePhrase,
  normalizeSite,
  phrasesMatch,
  pruneActivity,
  resolveRuleMethod,
  sanitizeRuntime,
  sanitizeSettings,
  validateImportPayload
} = globalThis.TalkToUnlockUtils;

test('normalizes pasted sites, phrases, punctuation, and contractions', () => {
  assert.equal(normalizeSite(' https://www.YouTube.com/watch?v=1 '), 'youtube.com');
  assert.equal(normalizeSite('*.Example.com'), 'example.com');
  assert.equal(normalizeSite('not-a-domain'), null);
  assert.equal(normalizePhrase("I'M ready!"), 'i am ready');
  assert.equal(phrasesMatch('I am ready.', "I'm ready"), true);
  assert.equal(phrasesMatch('I am not ready', "I'm ready"), false);
});

test('migrates 2.0 global settings into equivalent per-site voice rules', () => {
  const settings = sanitizeSettings({ enabled: false, blockedSites: ['www.youtube.com', 'https://reddit.com/r/test'], requiredPhrase: '  Keep going  ', requiredLevel: 74 });
  assert.equal(settings.settingsVersion, 3);
  assert.equal(settings.enabled, false);
  assert.equal(settings.siteRules.length, 2);
  assert.deepEqual(settings.siteRules.map((rule) => rule.hostname), ['youtube.com', 'reddit.com']);
  assert.equal(settings.siteRules[0].method, 'voice');
  assert.equal(settings.siteRules[0].phrase, 'Keep going');
  assert.equal(settings.siteRules[0].voiceLevel, 74);
  assert.equal(settings.siteRules[0].dailyAllowanceMinutes, null);
});

test('sanitizes rule ranges, schedules, duplicates, and invalid values', () => {
  const settings = sanitizeSettings({
    profile: 'unknown',
    siteRules: [
      { hostname: 'youtube.com', voiceLevel: 140, fallbackSeconds: 1, unlockMinutes: 500, cooldownMinutes: -2, dailyAllowanceMinutes: 0, schedule: [{ days: [1, 1, 9], start: 'bad', end: '18:30' }] },
      { hostname: 'www.youtube.com' },
      { hostname: 'invalid' }
    ]
  });
  assert.equal(settings.profile, 'balanced');
  assert.equal(settings.siteRules.length, 1);
  assert.equal(settings.siteRules[0].voiceLevel, 100);
  assert.equal(settings.siteRules[0].fallbackSeconds, 5);
  assert.equal(settings.siteRules[0].unlockMinutes, 240);
  assert.equal(settings.siteRules[0].cooldownMinutes, 0);
  assert.equal(settings.siteRules[0].dailyAllowanceMinutes, 1);
  assert.deepEqual(settings.siteRules[0].schedule[0], { id: 'window-1', days: [1], start: '09:00', end: '18:30' });
});

test('chooses the most-specific matching enabled domain rule', () => {
  const broad = createSiteRule('example.com', { id: 'broad' });
  const specific = createSiteRule('video.example.com', { id: 'specific' });
  assert.equal(findMatchingRule('watch.video.example.com', [broad, specific]).id, 'specific');
  assert.equal(findMatchingRule('notexample.com', [broad, specific]), null);
  assert.equal(findMatchingRule('example.com', [{ ...broad, enabled: false }]), null);
});

test('evaluates normal and overnight local schedules', () => {
  const weekday = createSiteRule('example.com', { schedule: [{ days: [1], start: '09:00', end: '18:00' }] });
  const overnight = createSiteRule('example.com', { schedule: [{ days: [1], start: '22:00', end: '02:00' }] });
  const mondayMorning = new Date(2026, 7, 31, 10, 0);
  const mondayNight = new Date(2026, 7, 31, 23, 0);
  const tuesdayEarly = new Date(2026, 8, 1, 1, 0);
  assert.equal(mondayMorning.getDay(), 1);
  assert.equal(isScheduleActive(weekday, mondayMorning), true);
  assert.equal(isScheduleActive(weekday, mondayNight), false);
  assert.equal(isScheduleActive(overnight, mondayNight), true);
  assert.equal(isScheduleActive(overnight, tuesdayEarly), true);
});

test('applies global profiles without mutating the stored rule', () => {
  const rule = createSiteRule('example.com', { method: 'voice', allowTimedFallback: true });
  assert.deepEqual(resolveRuleMethod('gentle', rule), { method: 'pause', allowTimedFallback: true });
  assert.deepEqual(resolveRuleMethod('balanced', rule), { method: 'voice', allowTimedFallback: true });
  assert.deepEqual(resolveRuleMethod('strict', rule), { method: 'voice', allowTimedFallback: false });
  assert.equal(rule.method, 'voice');
});

test('uses the required access-decision precedence', () => {
  const now = new Date(2026, 8, 2, 12, 0).getTime();
  const rule = createSiteRule('example.com', { id: 'rule', dailyAllowanceMinutes: 1, cooldownMinutes: 20 });
  const settings = sanitizeSettings({ siteRules: [rule] });
  const runtime = createDefaultRuntime();

  assert.equal(evaluateAccess({ settings: { ...settings, enabled: false }, runtime, hostname: 'example.com', now }).reason, 'disabled');
  assert.equal(evaluateAccess({ settings, runtime: { ...runtime, protectionPausedUntil: now + 1000 }, hostname: 'example.com', now }).reason, 'protection_paused');
  assert.equal(evaluateAccess({ settings, runtime: { ...runtime, activeFocus: { id: 'focus', startedAt: now, endsAt: now + 60000, durationMinutes: 25 } }, hostname: 'example.com', now }).reason, 'focus');

  const emergencyDuringFocus = { ...runtime, activeFocus: { id: 'focus', startedAt: now, endsAt: now + 60000, durationMinutes: 25 }, grantsByRule: { rule: { ruleId: 'rule', hostname: 'example.com', startsAt: now, endsAt: now + 30000, method: 'emergency' } } };
  assert.equal(evaluateAccess({ settings, runtime: emergencyDuringFocus, hostname: 'example.com', now }).reason, 'emergency_grant');

  const granted = { ...runtime, grantsByRule: { rule: { ruleId: 'rule', hostname: 'example.com', startsAt: now, endsAt: now + 60000, method: 'voice' } }, usageByDate: { [localDateKey(now)]: { rule: 120 } } };
  assert.equal(evaluateAccess({ settings, runtime: granted, hostname: 'example.com', now }).reason, 'grant');

  const exhausted = { ...runtime, usageByDate: { [localDateKey(now)]: { rule: 60 } } };
  assert.equal(evaluateAccess({ settings, runtime: exhausted, hostname: 'example.com', now }).reason, 'allowance_exhausted');

  const cooldown = { ...runtime, cooldownsByRule: { rule: now + 60000 } };
  assert.equal(evaluateAccess({ settings, runtime: cooldown, hostname: 'example.com', now }).reason, 'cooldown');
  assert.equal(evaluateAccess({ settings, runtime, hostname: 'example.com', now }).decision, 'voice');
});

test('runtime sanitation removes expired grants and focus sessions', () => {
  const now = Date.now();
  const settings = sanitizeSettings({ siteRules: [createSiteRule('example.com', { id: 'rule' })] });
  const runtime = sanitizeRuntime({ activeFocus: { endsAt: now - 1 }, grantsByRule: { rule: { endsAt: now - 1 } }, cooldownsByRule: { rule: now + 5000 } }, settings, now);
  assert.equal(runtime.activeFocus, null);
  assert.deepEqual(runtime.grantsByRule, {});
  assert.equal(runtime.cooldownsByRule.rule, now + 5000);
});

test('prunes old activity, sorts newest first, and caps retained events', () => {
  const now = Date.now();
  const events = Array.from({ length: 1100 }, (_, index) => ({ id: String(index), at: now - index, type: 'gate_shown', hostname: 'example.com', detail: {} }));
  events.push({ id: 'old', at: now - 40 * 86400000, type: 'gate_shown', hostname: 'example.com', detail: {} });
  const pruned = pruneActivity(events, now, 30);
  assert.equal(pruned.length, 1000);
  assert.equal(pruned[0].id, '0');
  assert.equal(pruned.some((event) => event.id === 'old'), false);
});

test('validates versioned configuration imports and rejects invalid files', () => {
  const settings = sanitizeSettings({ siteRules: [createSiteRule('example.com')] });
  assert.equal(validateImportPayload({ type: 'talk-to-unlock-settings', version: 3, settings }).siteRules[0].hostname, 'example.com');
  assert.throws(() => validateImportPayload({ version: 2, settings }), /3\.0/);
  assert.throws(() => validateImportPayload({ type: 'talk-to-unlock-settings', version: 3, settings: { siteRules: [] } }), /valid site rules/);
});
