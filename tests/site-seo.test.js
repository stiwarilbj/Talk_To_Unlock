const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const docsRoot = path.join(root, 'docs');
const baseUrl = 'https://stiwarilbj.github.io/Talk_To_Unlock/';
const pages = [
  'index.html',
  'install.html',
  'privacy.html',
  'help.html',
  'guides/index.html',
  'guides/reduce-scrolling.html',
  'guides/short-focus-sessions.html',
  'guides/pause-before-opening-websites.html',
  'guides/block-youtube-during-focus.html'
];

function pageUrl(page) {
  if (page === 'index.html') return baseUrl;
  if (page.endsWith('/index.html')) return baseUrl + page.slice(0, -'index.html'.length);
  return baseUrl + page;
}

function readPage(page) {
  return fs.readFileSync(path.join(docsRoot, page), 'utf8');
}

function matchOne(source, expression, label) {
  const match = source.match(expression);
  assert.ok(match, label + ' should exist');
  return match[1];
}

function localTarget(page, reference) {
  const cleanReference = reference.split('#')[0].split('?')[0];
  if (!cleanReference) return null;
  const target = path.resolve(path.dirname(path.join(docsRoot, page)), cleanReference);
  if (cleanReference.endsWith('/')) return path.join(target, 'index.html');
  return target;
}

test('all canonical public pages have complete crawl metadata', () => {
  for (const page of pages) {
    const html = readPage(page);
    const canonical = matchOne(html, /<link\s+rel="canonical"\s+href="([^"]+)"/i, page + ' canonical');
    assert.equal(canonical, pageUrl(page));
    assert.equal((html.match(/<title>/gi) || []).length, 1, page + ' should have one title');
    const title = matchOne(html, /<title>([^<]+)<\/title>/i, page + ' title');
    assert.ok(title.length >= 20 && title.length <= 75, page + ' title should be concise');
    const description = matchOne(html, /<meta\s+name="description"\s+content="([^"]+)"/i, page + ' description');
    assert.ok(description.length >= 80 && description.length <= 170, page + ' description should be useful');
    assert.equal((html.match(/<meta\s+name="description"/gi) || []).length, 1, page + ' should have one description');
    assert.match(html, /<meta\s+property="og:image"\s+content="https:\/\/stiwarilbj\.github\.io\/Talk_To_Unlock\/assets\/og-image\.png"/i);
    assert.match(html, /<meta\s+name="twitter:image"\s+content="https:\/\/stiwarilbj\.github\.io\/Talk_To_Unlock\/assets\/og-image\.png"/i);
    assert.match(html, /<link\s+rel="icon"[^>]+href="[^"]*assets\/favicon\.png"/i);
    assert.match(html, /<link\s+rel="stylesheet"\s+href="[^"]*styles\.css"/i);
    assert.match(html, /<main\s+[^>]*id="main-content"/i);
    assert.equal((html.match(/<h1\b/gi) || []).length, 1, page + ' should have one primary heading');
    assert.doesNotMatch(html, /<meta\s+name="robots"\s+content="[^"]*noindex/i, page + ' must remain indexable');
    for (const block of html.matchAll(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
      const data = JSON.parse(block[1]);
      assert.equal(data['@context'], 'https://schema.org', page + ' structured data context');
    }
  }
});

test('internal links and referenced local assets resolve from the published docs tree', () => {
  for (const page of pages) {
    const html = readPage(page);
    for (const match of html.matchAll(/(?:href|src)="([^"]+)"/gi)) {
      const reference = match[1];
      if (/^(?:https?:|mailto:|chrome:|#|data:|javascript:)/i.test(reference)) continue;
      const target = localTarget(page, reference);
      if (target) assert.equal(fs.existsSync(target), true, page + ' references missing ' + reference);
    }
  }
  for (const image of ['assets/favicon.png', 'assets/og-image.png', 'assets/popup.png', 'assets/settings.png', 'assets/blocker.png']) {
    assert.ok(fs.statSync(path.join(docsRoot, image)).size > 0, image + ' should be non-empty');
  }
});

test('sitemap contains exactly the canonical indexable pages', () => {
  const sitemap = fs.readFileSync(path.join(docsRoot, 'sitemap.xml'), 'utf8');
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  assert.deepEqual(urls.sort(), pages.map(pageUrl).sort());
  const dates = [...sitemap.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map(match => match[1]);
  assert.equal(dates.length, pages.length);
  for (const date of dates) {
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Number.isFinite(Date.parse(date)), 'lastmod must be a real date');
    assert.ok(Date.parse(date) <= Date.now(), 'lastmod must not be in the future');
  }
  assert.doesNotMatch(sitemap, /404\.html|little-pause-3\.1\.0\.zip/);
});

test('custom error page is excluded from indexing', () => {
  const notFound = fs.readFileSync(path.join(docsRoot, '404.html'), 'utf8');
  assert.match(notFound, /<meta\s+name="robots"\s+content="noindex, follow"/i);
  assert.doesNotMatch(fs.readFileSync(path.join(docsRoot, 'sitemap.xml'), 'utf8'), /404\.html/);
});
