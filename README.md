# Talk to Unlock 3.0

Talk to Unlock is a local-first Manifest V3 Chrome extension that adds intentional friction before distracting websites. Each site can require a spoken phrase, a timed pause, or a hard block, with optional schedules, allowances, cooldowns, and Focus sessions.

## What is included

- A compact blue-hour popup for protection status, Focus locks, today’s real usage, and active rules.
- A full dashboard with per-site rule editing, local schedules, Focus controls, activity, and privacy settings.
- Voice, Pause, and Blocked rule methods with Gentle, Balanced, and Strict global profiles.
- Per-site phrases, voice effort, timed fallback, unlock windows, cooldowns, daily allowances, and exhausted-limit behavior.
- Weekday, multi-window, and overnight schedules evaluated in the computer’s local timezone.
- Persisted 25-, 50-, and custom-length Focus sessions that survive browser restarts.
- A configurable timed fallback and hold-to-confirm emergency bypass.
- Local activity retention and focused, visible usage accounting. Audio and recognized transcripts are never stored.
- Versioned JSON configuration import/export and safe migration from 2.0 global settings.
- A Shadow DOM blocker with live voice feedback, focus trapping, reduced-motion support, and clear microphone errors.

## Install locally

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**.
3. Choose **Load unpacked**.
4. Select this folder.
5. Pin **Talk to Unlock** from the extensions menu.

The first Voice attempt on a protected site may trigger a browser microphone prompt. Allow access on that site to use voice verification. Pause fallback remains available when the rule and profile permit it.

## Privacy

Settings, grants, usage totals, Focus state, and activity remain in `chrome.storage.local`. The microphone stream is opened only during a Voice attempt and is stopped after success, failure, cancellation, or timeout. The extension never stores audio or recognized transcript text. Browser speech-recognition availability and processing depend on the installed browser.

## Preview and checks

Serve this folder from a local web server, then open:

- `popup.html` for the compact command center.
- `dashboard.html#site-rules` for the options dashboard.
- `preview.html` for the blocker and simulated successful speech recognition.

Run the checks with:

```sh
node --check shared.js
node --check background.js
node --check content.js
node --check popup.js
node --check dashboard.js
node --check preview-api.js
node --test tests/*.test.js
```
