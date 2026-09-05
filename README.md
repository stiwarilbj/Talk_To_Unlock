# Little Pause — Website Blocker & Focus Timer 3.1.0

Little Pause adds a small, friendly pause before the websites you choose. It includes a 10-second pause by default for new rules, optional Voice rules, hard blocks, and 25-, 50-, or custom-minute Focus sessions.

The project is also published as a static public website at [stiwarilbj.github.io/Talk_To_Unlock](https://stiwarilbj.github.io/Talk_To_Unlock/). The site explains manual Chrome installation because this release is not yet listed in the Chrome Web Store.

## Extension surfaces

- Popup: protection status, one Focus timer, onboarding, and My sites.
- My sites: per-domain Pause, Voice, or Blocked rules.
- More options: phrases, voice effort, timed fallback, unlock windows, cooldowns, daily allowances, schedules, subdomains, and Focus behavior.
- Activity: local usage and unlock events with per-site filtering and empty states.
- Settings: Gentle, Balanced, and Strict profiles, emergency hold, versioned import/export, a blocker preview, and reset.
- Shadow DOM blocker: explicit pause start, voice controls only for Voice rules, five-second emergency hold, Close tab, focus containment, reduced-motion support, and video pause/resume.

## Install locally

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**.
3. Choose **Load unpacked**.
4. Select the unzipped extension folder containing `manifest.json`.
5. Pin Little Pause from Chrome’s extensions menu.

The published [installation page](https://stiwarilbj.github.io/Talk_To_Unlock/install.html) provides the current `little-pause-3.1.0.zip` download and the same steps.

Fresh installations start with no hidden preset sites. The popup’s first-use setup lets you explicitly choose sites and a pause method. Existing v2.0 global settings migrate to per-site Voice rules with their phrase and threshold preserved. Existing v3 settings, grants, activity, and exports continue to use the v3 schema and storage keys.

## Privacy

Settings, grants, usage totals, Focus state, and activity remain in `chrome.storage.local`. Activity is retained for up to 30 days or 1,000 events. Visible usage is counted through capped content-script heartbeats only while the protected page is visible and focused. The microphone stream is opened only during a Voice attempt and stopped after success, failure, cancellation, or timeout. Audio and recognized transcript text are never stored. Browser speech-recognition availability and processing depend on Chrome and its settings.

The public site uses no advertising, tracking scripts, accounts, email collection, or forms. GitHub may process ordinary hosting and security logs under its own privacy policy.

## Checks

Run the syntax checks and unit tests with:

```sh
node --check shared.js
node --check background.js
node --check content.js
node --check popup.js
node --check dashboard.js
node --check preview-api.js
node --test tests/*.test.js
```

The release archive is generated as `little-pause-3.1.0.zip` with `manifest.json` at its root. Website files, tests, macOS metadata, and parent-directory paths are excluded from the extension archive.
