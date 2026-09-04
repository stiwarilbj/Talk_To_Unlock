const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

test('manifest references files that exist', () => {
  const referenced = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_ui.page,
    ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap((entry) => entry.js),
    ...manifest.web_accessible_resources.flatMap((entry) => entry.resources)
  ];

  for (const file of referenced) {
    assert.equal(fs.existsSync(path.join(root, file)), true, `${file} should exist`);
  }
});

test('declares the 3.0 command-center surfaces and minimum runtime permissions', () => {
  assert.equal(manifest.name, 'Talk to Unlock — Voice Focus, Website Blocker & Productivity Coach');
  assert.equal(manifest.short_name, 'Talk Unlock');
  assert.equal(manifest.content_scripts.length, 1);
  assert.equal(manifest.permissions.includes('scripting'), false);
  assert.equal(manifest.permissions.includes('activeTab'), false);
  assert.equal(manifest.permissions.includes('alarms'), true);
  assert.equal('host_permissions' in manifest, false);
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.equal(manifest.options_ui.page, 'dashboard.html');
  assert.equal(manifest.version, '3.0.1');
});
