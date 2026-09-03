(function initializeTalkToUnlock() {
  'use strict';

  if (globalThis.__talkToUnlockContentLoaded) return;
  globalThis.__talkToUnlockContentLoaded = true;

  const { createSiteRule, phrasesMatch } = globalThis.TalkToUnlockUtils;
  const ROOT_ID = 'talk-to-unlock-root';
  const hostname = window.location.hostname || 'youtube.com';
  let decision = null;
  let rootHost = null;
  let shadowRoot = null;
  let recognition = null;
  let audioContext = null;
  let audioStream = null;
  let audioSource = null;
  let analyser = null;
  let meterFrame = 0;
  let speechTimeout = 0;
  let peakLevel = 0;
  let sessionFinished = false;
  let pauseTimer = 0;
  let holdTimer = 0;
  let holdStartedAt = 0;
  let heartbeatTimer = 0;
  let grantExpiryTimer = 0;
  let lastHeartbeatAt = 0;
  let activeGrant = null;
  let pausedVideos = new Set();
  let videoObserver = null;
  let priorHtmlOverflow = null;
  let priorBodyOverflow = null;
  let evaluationSequence = 0;

  function send(message) {
    return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!response?.ok) reject(new Error(response?.error || 'Something went wrong.'));
      else resolve(response);
    }));
  }

  function icon(name) {
    const icons = {
      microphone: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="2.5" width="8" height="13" rx="4"></rect><path d="M5 11.5a7 7 0 0 0 14 0M12 18.5v3M8.5 21.5h7"></path></svg>',
      close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"></path></svg>',
      lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="3"></rect><path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10"></path></svg>',
      play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 8 6-8 6Z"></path></svg>'
    };
    return icons[name] || '';
  }

  function brandMark() {
    return '<span class="ttu-brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>';
  }

  function friendlySiteName(value) {
    const known = { 'youtube.com': 'YouTube', 'instagram.com': 'Instagram', 'reddit.com': 'Reddit', 'tiktok.com': 'TikTok', 'x.com': 'X', 'facebook.com': 'Facebook' };
    return known[value] || value;
  }

  function formatRemaining(milliseconds) {
    const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
    if (totalSeconds < 60) return `${totalSeconds} sec`;
    const minutes = Math.ceil(totalSeconds / 60);
    return `${minutes} min`;
  }

  function contextLabel(next) {
    if (next.reason === 'focus') return 'Focus rule active';
    if (next.reason === 'allowance_exhausted') return 'Daily allowance used';
    if (next.reason === 'cooldown') return 'Cooldown active';
    if (next.rule.dailyAllowanceMinutes !== null) return 'Daily allowance';
    if (next.decision === 'blocked') return 'Protected';
    return next.decision === 'pause' ? 'Pause required' : 'Voice required';
  }

  function contextValue(next) {
    if (next.until) return `${formatRemaining(next.until - Date.now())} left`;
    if (next.allowanceSeconds !== null && next.allowanceSeconds !== undefined) return `${Math.max(0, Math.ceil((next.allowanceSeconds - next.usedSeconds) / 60))} min left`;
    return `${next.rule.unlockMinutes} min unlock`;
  }

  function headingFor(next) {
    if (next.reason === 'focus') return ['Focus lock in progress', 'This site is protected until your Focus session ends.'];
    if (next.reason === 'allowance_exhausted') return ['Your daily allowance is complete', 'Step away for today, or use the emergency bypass if necessary.'];
    if (next.reason === 'cooldown') return ['Give your attention a moment', `Another unlock becomes available in ${formatRemaining(next.until - Date.now())}.`];
    if (next.decision === 'pause') return ['Pause before you continue', `Complete a ${next.fallbackSeconds}-second pause to unlock this site for ${next.rule.unlockMinutes} minutes.`];
    if (next.decision === 'blocked') return ['This site is blocked right now', 'Your current rule does not offer a normal unlock path.'];
    return ['Pause before you continue', `Say the phrase clearly to unlock this site for ${next.rule.unlockMinutes} minutes.`];
  }

  function interactionMarkup(next) {
    if (next.decision === 'voice') {
      return `<div class="ttu-phrase">“<span data-phrase></span>”</div>
        <div class="ttu-waveform" data-waveform aria-hidden="true">${Array.from({ length: 38 }, (_, index) => `<i style="--i:${index}"></i>`).join('')}</div>
        <button class="ttu-mic" type="button" data-mic aria-label="Start voice unlock"><span class="ttu-mic-ring" aria-hidden="true"></span>${icon('microphone')}</button>
        <p class="ttu-status" role="status" aria-live="polite" data-status>Ready when you are</p>
        <p class="ttu-status-detail" data-status-detail>Speak naturally — punctuation does not matter.</p>
        <div class="ttu-effort"><div class="ttu-effort-label"><span>Voice effort</span><strong data-effort-label>Ready</strong></div><div class="ttu-meter" role="meter" aria-label="Voice effort" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" data-meter><span data-meter-fill></span><i data-threshold></i></div></div>
        <div class="ttu-steps" aria-label="Unlock progress"><span class="active" data-step="listen"><b>1</b>Listen</span><i></i><span data-step="match"><b>2</b>Match phrase</span><i></i><span data-step="unlock"><b>3</b>Unlock</span></div>
        ${next.allowTimedFallback ? `<button class="ttu-secondary" type="button" data-pause>${icon('play')}<span>Use ${next.fallbackSeconds}-second pause instead</span></button>` : ''}`;
    }
    if (next.decision === 'pause') {
      return `<div class="ttu-pause-icon">${icon('play')}<strong data-pause-count>${next.fallbackSeconds}</strong></div><p class="ttu-status" role="status" aria-live="polite" data-status>Take one intentional pause</p><p class="ttu-status-detail" data-status-detail>The countdown begins when you are ready.</p><button class="ttu-primary" type="button" data-pause>Begin ${next.fallbackSeconds}-second pause</button>`;
    }
    return `<div class="ttu-block-icon">${icon('lock')}</div><p class="ttu-status" role="status" aria-live="polite" data-status>${next.reason === 'focus' ? 'Stay with the task you chose.' : 'This rule is holding the boundary.'}</p><p class="ttu-status-detail" data-status-detail>${next.until ? `Available again around ${new Date(next.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : 'You can close this tab or use the emergency option below.'}</p>`;
  }

  function createOverlay(next) {
    if (rootHost?.isConnected) removeOverlay(false);
    decision = next;
    rootHost = document.createElement('div');
    rootHost.id = ROOT_ID;
    rootHost.style.setProperty('position', 'fixed', 'important');
    rootHost.style.setProperty('inset', '0', 'important');
    rootHost.style.setProperty('z-index', '2147483647', 'important');
    rootHost.style.setProperty('visibility', 'hidden', 'important');
    shadowRoot = rootHost.attachShadow({ mode: 'open' });
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = `${chrome.runtime.getURL('styles.css')}?v=4`;
    const reveal = () => rootHost?.style.removeProperty('visibility');
    stylesheet.addEventListener('load', reveal, { once: true });
    setTimeout(reveal, 500);
    const [heading, description] = headingFor(next);
    const overlay = document.createElement('div');
    overlay.className = 'ttu-overlay';
    overlay.innerHTML = `
      <div class="ttu-top-brand">${brandMark()}<span>Talk to Unlock</span></div>
      <button class="ttu-close-tab" type="button" data-close-tab><span>Close tab</span>${icon('close')}</button>
      <main class="ttu-card" role="dialog" aria-modal="true" aria-labelledby="ttu-title" aria-describedby="ttu-description">
        <div class="ttu-context"><span class="ttu-site-icon" aria-hidden="true">${friendlySiteName(next.rule.hostname).slice(0,2)}</span><strong>${next.rule.hostname}</strong><span class="ttu-context-tag">${contextLabel(next)}</span><span class="ttu-context-value">${contextValue(next)}</span></div>
        <header class="ttu-header"><h1 id="ttu-title">${heading}</h1><p id="ttu-description">${description}</p></header>
        <div class="ttu-interaction">${interactionMarkup(next)}</div>
        <div class="ttu-footer-actions"><button type="button" data-why>Why am I seeing this?</button>${next.allowEmergency ? '<button type="button" data-emergency><span data-emergency-label>Emergency bypass</span><i aria-hidden="true"></i></button>' : ''}</div>
        <p class="ttu-rule-note" data-explanation hidden></p>
        <p class="ttu-schedule-note">${next.rule.schedule.length ? 'This rule follows its configured local schedule.' : 'This rule is active whenever protection is on.'}</p>
      </main>`;
    shadowRoot.append(stylesheet, overlay);
    document.documentElement.append(rootHost);
    if (next.decision === 'voice') {
      shadowRoot.querySelector('[data-phrase]').textContent = next.rule.phrase;
      shadowRoot.querySelector('[data-threshold]').style.left = `${next.rule.voiceLevel}%`;
      shadowRoot.querySelector('[data-mic]').addEventListener('click', startRecognition);
    }
    shadowRoot.querySelector('[data-pause]')?.addEventListener('click', startPauseFallback);
    shadowRoot.querySelector('[data-close-tab]').addEventListener('click', closeTab);
    shadowRoot.querySelector('[data-why]').addEventListener('click', toggleExplanation);
    installEmergencyHold();
    overlay.addEventListener('keydown', trapFocus);
    lockDocumentScroll();
    pausePlayingVideos();
    observeVideos();
    send({ type: 'TTU_RECORD_EVENT', eventType: 'gate_shown', hostname, detail: { reason: next.reason } }).catch(() => {});
    requestAnimationFrame(() => (shadowRoot.querySelector('[data-mic], [data-pause], [data-emergency], [data-close-tab]')?.focus()));
  }

  function setStatus(message, tone = 'neutral', detail = '') {
    const status = shadowRoot?.querySelector('[data-status]');
    const statusDetail = shadowRoot?.querySelector('[data-status-detail]');
    if (status) { status.textContent = message; status.dataset.tone = tone; }
    if (statusDetail && detail) statusDetail.textContent = detail;
  }

  function setMicState(state) {
    const mic = shadowRoot?.querySelector('[data-mic]');
    if (!mic) return;
    mic.dataset.state = state;
    mic.disabled = ['requesting', 'listening', 'success'].includes(state);
    shadowRoot.querySelector('[data-waveform]')?.classList.toggle('active', state === 'listening');
  }

  function setStep(step) {
    const order = ['listen', 'match', 'unlock'];
    const index = order.indexOf(step);
    order.forEach((name, position) => {
      const element = shadowRoot?.querySelector(`[data-step="${name}"]`);
      element?.classList.toggle('active', position === index);
      element?.classList.toggle('complete', position < index);
    });
  }

  function setMeter(level) {
    const clamped = Math.min(100, Math.max(0, Math.round(level)));
    const meter = shadowRoot?.querySelector('[data-meter]');
    const fill = shadowRoot?.querySelector('[data-meter-fill]');
    const label = shadowRoot?.querySelector('[data-effort-label]');
    if (meter) meter.setAttribute('aria-valuenow', String(clamped));
    if (fill) fill.style.width = `${clamped}%`;
    if (label) label.textContent = clamped >= decision.rule.voiceLevel ? 'Good' : clamped ? 'Keep going' : 'Ready';
  }

  function readAudioLevel() {
    if (!analyser) return 0;
    const samples = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(samples);
    const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
    if (!rms) return 0;
    return Math.min(100, Math.max(0, Math.round(((20 * Math.log10(rms) + 60) / 60) * 100)));
  }

  function updateMeter() {
    const level = readAudioLevel();
    peakLevel = Math.max(peakLevel, level);
    setMeter(level);
    meterFrame = requestAnimationFrame(updateMeter);
  }

  function friendlyRecognitionError(code) {
    return ({
      'audio-capture': 'No microphone was found. Check your device and try again.',
      network: 'Speech recognition is temporarily unavailable. Try the timed pause instead.',
      'not-allowed': 'Microphone access is blocked. Allow it for this site or use the timed pause.',
      'service-not-allowed': 'Speech recognition is disabled in this browser.',
      'no-speech': 'No speech was detected. Take a breath and try again.',
      aborted: 'Listening stopped. Try again when you are ready.'
    })[code] || 'We could not recognize that. Please try again.';
  }

  async function startRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition || !navigator.mediaDevices?.getUserMedia) {
      setMicState('error');
      setStatus('Voice recognition is unavailable.', 'error', decision.allowTimedFallback ? 'Use the timed pause below to continue.' : 'Use the emergency option if necessary.');
      return;
    }
    cleanupSession();
    sessionFinished = false;
    peakLevel = 0;
    setMeter(0);
    setStep('listen');
    setMicState('requesting');
    setStatus('Waiting for microphone…', 'active', 'Your browser may ask for permission.');
    try {
      audioStream = await navigator.mediaDevices.getUserMedia({ audio: { autoGainControl: true, echoCancellation: true, noiseSuppression: true } });
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      audioContext = new AudioContext();
      if (audioContext.state === 'suspended') await audioContext.resume();
      audioSource = audioContext.createMediaStreamSource(audioStream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = .65;
      audioSource.connect(analyser);
      recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = navigator.language || 'en-US';
      recognition.maxAlternatives = 3;
      recognition.onresult = handleRecognitionResult;
      recognition.onerror = (event) => finishWithError(friendlyRecognitionError(event.error));
      recognition.onend = () => { if (!sessionFinished) finishWithError('No speech was detected. Take a breath and try again.'); };
      recognition.start();
      setMicState('listening');
      setStatus('Listening…', 'active', 'Speak naturally — punctuation does not matter.');
      updateMeter();
      speechTimeout = setTimeout(() => finishWithError('Listening timed out. Tap the microphone to try again.'), 15000);
    } catch (error) {
      finishWithError(error?.name === 'NotAllowedError' ? 'Microphone access is blocked. Allow it or use the timed pause.' : 'We could not start the microphone. Check your device and try again.');
    }
  }

  function handleRecognitionResult(event) {
    if (sessionFinished) return;
    sessionFinished = true;
    const alternatives = Array.from(event.results?.[0] || []);
    const bestMatch = alternatives.find((alternative) => phrasesMatch(alternative.transcript, decision.rule.phrase));
    const transcript = bestMatch?.transcript || alternatives[0]?.transcript || '';
    const observedPeak = peakLevel;
    cleanupSession(false);
    setStep('match');
    if (!phrasesMatch(transcript, decision.rule.phrase)) {
      setMicState('error');
      setStatus('The phrase did not match.', 'error', `We heard “${transcript || 'nothing'}”. Try the phrase again.`);
      send({ type: 'TTU_RECORD_EVENT', eventType: 'voice_failure', hostname, detail: { reason: 'phrase' } }).catch(() => {});
      return;
    }
    if (observedPeak < decision.rule.voiceLevel) {
      setMicState('error');
      setStatus('The phrase matched, but the voice effort was low.', 'error', `You reached ${observedPeak}%. Aim for ${decision.rule.voiceLevel}%.`);
      send({ type: 'TTU_RECORD_EVENT', eventType: 'voice_failure', hostname, detail: { reason: 'effort', observedPeak } }).catch(() => {});
      return;
    }
    setMeter(100);
    setStep('unlock');
    setMicState('success');
    setStatus('Phrase matched. Unlocking…', 'success', 'Your audio stream has been closed.');
    setTimeout(() => unlockWith('voice'), 450);
  }

  function finishWithError(message) {
    if (sessionFinished) return;
    sessionFinished = true;
    cleanupSession();
    setMicState('error');
    setStatus(message, 'error', decision.allowTimedFallback ? 'You can retry or use the timed pause.' : 'Try again when you are ready.');
  }

  function cleanupSession(abort = true) {
    clearTimeout(speechTimeout); speechTimeout = 0;
    if (meterFrame) cancelAnimationFrame(meterFrame); meterFrame = 0;
    if (recognition) {
      const active = recognition; recognition = null;
      active.onresult = null; active.onerror = null; active.onend = null;
      if (abort) try { active.abort(); } catch (_error) {}
    }
    audioSource?.disconnect(); audioSource = null; analyser = null;
    audioStream?.getTracks().forEach((track) => track.stop()); audioStream = null;
    if (audioContext && audioContext.state !== 'closed') audioContext.close().catch(() => {}); audioContext = null;
  }

  function startPauseFallback() {
    const button = shadowRoot?.querySelector('[data-pause]');
    if (!button || button.disabled) return;
    let remaining = decision.fallbackSeconds;
    button.disabled = true;
    setStatus('Pause in progress…', 'active', 'Stay here until the countdown completes.');
    const count = shadowRoot.querySelector('[data-pause-count]');
    const label = button.querySelector('span') || button;
    const tick = () => {
      if (count) count.textContent = String(remaining);
      if (label) label.textContent = `${remaining} second${remaining === 1 ? '' : 's'} remaining`;
      if (remaining <= 0) { clearInterval(pauseTimer); pauseTimer = 0; unlockWith('pause'); }
      remaining -= 1;
    };
    tick();
    pauseTimer = setInterval(tick, 1000);
  }

  function installEmergencyHold() {
    const button = shadowRoot?.querySelector('[data-emergency]');
    if (!button) return;
    const start = (event) => {
      if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
      if (event.type === 'keydown' && event.repeat) return;
      event.preventDefault();
      clearEmergencyHold();
      const seconds = decision.policy?.emergencyHoldSeconds || 5;
      holdStartedAt = Date.now();
      button.dataset.holding = 'true';
      button.style.setProperty('--hold-duration', `${seconds}s`);
      button.querySelector('[data-emergency-label]').textContent = `Keep holding for ${seconds} seconds`;
      holdTimer = setTimeout(() => unlockWith('emergency'), seconds * 1000);
    };
    const cancel = (event) => { if (event.type === 'keyup' && !['Enter', ' '].includes(event.key)) return; clearEmergencyHold(); };
    button.addEventListener('pointerdown', start);
    button.addEventListener('pointerup', cancel);
    button.addEventListener('pointercancel', cancel);
    button.addEventListener('pointerleave', cancel);
    button.addEventListener('keydown', start);
    button.addEventListener('keyup', cancel);
    button.addEventListener('blur', clearEmergencyHold);
  }

  function clearEmergencyHold() {
    clearTimeout(holdTimer); holdTimer = 0; holdStartedAt = 0;
    const button = shadowRoot?.querySelector('[data-emergency]');
    if (!button) return;
    button.dataset.holding = 'false';
    button.querySelector('[data-emergency-label]').textContent = 'Emergency bypass';
  }

  async function unlockWith(method) {
    cleanupSession();
    clearInterval(pauseTimer); pauseTimer = 0;
    clearEmergencyHold();
    try {
      const response = await send({ type: 'TTU_RECORD_UNLOCK', hostname, method });
      removeOverlay(true);
      startUsage(response.grant);
    } catch (error) {
      setStatus('Could not create the unlock window.', 'error', error.message);
    }
  }

  function toggleExplanation() {
    const explanation = shadowRoot?.querySelector('[data-explanation]');
    if (!explanation) return;
    explanation.hidden = !explanation.hidden;
    explanation.textContent = decision.reason === 'focus'
      ? 'A Focus session is active and this site is included in it.'
      : decision.reason === 'allowance_exhausted'
        ? 'You have used the daily allowance configured for this site.'
        : decision.reason === 'cooldown'
          ? 'This rule requires a short cooldown after each completed unlock.'
          : `Your active ${decision.rule.method} rule protects ${decision.rule.hostname}.`;
  }

  function closeTab() {
    send({ type: 'TTU_CLOSE_TAB' }).catch((error) => setStatus('Close this tab from your browser.', 'error', error.message));
  }

  function trapFocus(event) {
    if (event.key === 'Escape') { event.preventDefault(); setStatus('Protection remains active.', 'neutral', 'Use an unlock option or close the tab.'); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...shadowRoot.querySelectorAll('button:not(:disabled), [href], input:not(:disabled)')].filter((element) => !element.hidden);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && shadowRoot.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && shadowRoot.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function lockDocumentScroll() {
    if (priorHtmlOverflow === null) { priorHtmlOverflow = document.documentElement.style.overflow; document.documentElement.style.setProperty('overflow', 'hidden', 'important'); }
    const lockBody = () => {
      if (!document.body || priorBodyOverflow !== null || !rootHost?.isConnected) return;
      priorBodyOverflow = document.body.style.overflow;
      document.body.style.setProperty('overflow', 'hidden', 'important');
      pausePlayingVideos();
    };
    lockBody();
    if (!document.body) document.addEventListener('DOMContentLoaded', lockBody, { once: true });
  }

  function restoreDocumentScroll() {
    if (priorHtmlOverflow !== null) { priorHtmlOverflow ? document.documentElement.style.overflow = priorHtmlOverflow : document.documentElement.style.removeProperty('overflow'); priorHtmlOverflow = null; }
    if (document.body && priorBodyOverflow !== null) priorBodyOverflow ? document.body.style.overflow = priorBodyOverflow : document.body.style.removeProperty('overflow');
    priorBodyOverflow = null;
  }

  function pausePlayingVideos() {
    document.querySelectorAll('video').forEach((video) => { if (!video.paused) { pausedVideos.add(video); video.pause(); } });
  }

  function observeVideos() {
    videoObserver?.disconnect();
    videoObserver = new MutationObserver(pausePlayingVideos);
    videoObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function removeOverlay(resumeMedia = false) {
    cleanupSession(); clearInterval(pauseTimer); pauseTimer = 0; clearEmergencyHold();
    videoObserver?.disconnect(); videoObserver = null;
    rootHost?.remove(); rootHost = null; shadowRoot = null;
    restoreDocumentScroll();
    if (resumeMedia) pausedVideos.forEach((video) => { if (video.isConnected) video.play().catch(() => {}); });
    pausedVideos.clear();
  }

  function startUsage(grant) {
    clearInterval(heartbeatTimer); clearTimeout(grantExpiryTimer);
    if (!grant?.endsAt) return;
    activeGrant = grant;
    lastHeartbeatAt = Date.now();
    heartbeatTimer = setInterval(() => flushUsage(false), 15000);
    grantExpiryTimer = setTimeout(() => evaluateAndApply(), Math.max(500, grant.endsAt - Date.now() + 150));
  }

  async function flushUsage(force = false) {
    if (!activeGrant || activeGrant.endsAt <= Date.now()) return;
    const now = Date.now();
    const deltaSeconds = Math.min(30, Math.max(0, Math.round((now - lastHeartbeatAt) / 1000)));
    lastHeartbeatAt = now;
    if (deltaSeconds < 1 || (!force && (document.visibilityState !== 'visible' || !document.hasFocus()))) return;
    try { await send({ type: 'TTU_USAGE_HEARTBEAT', hostname, deltaSeconds }); } catch (_error) {}
  }

  async function evaluateAndApply() {
    const sequence = ++evaluationSequence;
    try {
      const next = await send({ type: 'TTU_EVALUATE_SITE', hostname });
      if (sequence !== evaluationSequence) return;
      if (next.decision === 'allow') {
        if (rootHost) removeOverlay(true);
        if (['grant', 'emergency_grant'].includes(next.reason)) startUsage(next.grant);
        else { clearInterval(heartbeatTimer); clearTimeout(grantExpiryTimer); activeGrant = null; }
      } else if (!rootHost || decision?.decision !== next.decision || decision?.reason !== next.reason || decision?.rule?.id !== next.rule?.id) {
        flushUsage(true);
        clearInterval(heartbeatTimer); clearTimeout(grantExpiryTimer); activeGrant = null;
        createOverlay(next);
      }
      else decision = next;
    } catch (_error) {
      if (rootHost) setStatus('Protection could not refresh.', 'error', 'Reload this page or open extension settings.');
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'TTU_SHOW_TEST') return false;
    const rule = createSiteRule(hostname, { id: 'preview-rule', dailyAllowanceMinutes: 12, unlockMinutes: 5, voiceLevel: 35, fallbackSeconds: 10, schedule: [{ days: [1,2,3,4,5], start: '09:00', end: '18:00' }] });
    createOverlay({ decision: 'voice', reason: 'rule', rule, usedSeconds: 240, allowanceSeconds: 720, allowTimedFallback: true, fallbackSeconds: 10, allowEmergency: true, policy: { emergencyHoldSeconds: 5 } });
    sendResponse({ ok: true });
    return false;
  });
  chrome.storage.onChanged.addListener((_changes, areaName) => { if (areaName === 'local') setTimeout(evaluateAndApply, 40); });
  window.addEventListener('focus', () => { lastHeartbeatAt = Date.now(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushUsage(true); else lastHeartbeatAt = Date.now(); });
  window.addEventListener('pagehide', () => { flushUsage(true); cleanupSession(); clearInterval(heartbeatTimer); });
  evaluateAndApply();
})();
