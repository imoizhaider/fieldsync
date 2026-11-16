// E. Offline and PWA
import { test, expect, state, serverRecord, uniq, photo, BASE_URL, ORIGIN } from '../lib/harness.js';

const photos = (n) => Array.from({ length: n }, (_, i) => photo(i + 1));
const ownFailures = (d) => d.network.filter((l) => l.includes(' x ') && l.includes(ORIGIN));

test('E01 [P0] the app shell opens with the network off', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  await d.context.setOffline(true);
  d.network.length = 0;
  d.console.length = 0;
  await d.page.reload();
  await d.page.waitForSelector('html[data-ready="1"]');
  await expect(d.page.locator('h1.title')).toHaveText('Observations');
  await expect(d.page.locator('#statusbar')).toHaveAttribute('data-online', '0');
  // styles and the bundled font really came from the cache
  const look = await d.page.evaluate(async () => {
    await document.fonts.ready;
    return {
      font: document.fonts.check('16px "IBM Plex Sans"'),
      family: getComputedStyle(document.body).fontFamily,
      barBg: getComputedStyle(document.getElementById('statusbar')).backgroundColor,
      icon: await fetch('icons/icon-192.png').then((r) => r.status).catch(() => 0),
      manifest: await fetch('manifest.webmanifest').then((r) => r.status).catch(() => 0),
    };
  });
  qa.note('look', look);
  expect(look.font).toBe(true);
  expect(look.family).toContain('IBM Plex Sans');
  expect(look.icon).toBe(200);
  expect(look.manifest).toBe(200);
  // every screen opens offline
  const routes = { records: 'Observations', tracks: 'Tracks', sync: 'Sync', regions: 'Regions', storage: 'Storage', install: 'Install FieldSync', conflicts: 'Conflict log', new: 'New soil sample', styleguide: 'One look, three builders' };
  for (const [route, heading] of Object.entries(routes)) {
    await d.go(`#/${route}`);
    await expect(d.page.locator('#pane-detail h1').first(), route).toHaveText(heading);
  }
  await d.shot('offline-shell');
  const failed = ownFailures(d);
  qa.note('ownOriginRequestsThatFailedOffline', failed);
  const appFiles = failed.filter((l) => !l.includes('/.netlify/'));
  expect(appFiles, 'no file of the app needed the network').toEqual([]);
  if (failed.some((l) => l.includes('/.netlify/scripts/hud'))) {
    qa.finding('Offline, every page load logs a failed request for /.netlify/scripts/hud (the Netlify badge script that the host adds to index.html, and which the worker caches as part of index.html but cannot serve). Harmless, but it is a console error on every offline start.');
  }
});

test('E02 [P0] reload and restart offline keep the record, photos and GPS point', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  await d.offline();
  const title = uniq('E02 offline survives');
  const id = await d.createRecord({ title, fields: { ph: 6.8, moisture: 22 }, notes: 'kept across reloads', photos: photos(3) });
  const before = { rec: await d.localRecord(id), media: await d.localMedia(id), gps: await d.localGps(id), outbox: await d.outbox() };
  expect(before.media).toHaveLength(3);
  expect(before.gps).toHaveLength(1);
  const verify = async (page, where) => {
    await page.waitForSelector('html[data-ready="1"]');
    const row = page.locator(`#record-list [data-record-id="${id}"]`);
    await expect(row, where).toHaveAttribute('data-status', 'pending');
    await expect(row.locator('.status')).toHaveText('Pending');
    await expect(row.locator('.status')).toHaveAttribute('title', 'Pending sync');
    await expect(row.locator('.row-meta')).toHaveText('pH 6.8 / 3 photos / GPS');
    await expect(page.locator('#sb-text')).toHaveText('Offline / 1 pending');
  };
  await d.page.reload();
  await verify(d.page, 'after reload');
  // full restart: close the tab, open a new one in the same profile
  await d.page.close();
  const page2 = await d.context.newPage();
  d.page = page2;
  d.watch(page2);
  await page2.goto(BASE_URL);
  await verify(page2, 'after restart');
  await d.go(`#/record/${id}`);
  await expect(page2.locator('#photos .photo.has-img')).toHaveCount(3);
  await expect(page2.locator('#gps-line')).toContainText('24.8607 n, 67.0011 e');
  await expect(page2.locator('p[data-field="notes"]')).toHaveText('kept across reloads');
  await d.shot('detail-after-restart');
  const after = { rec: await d.localRecord(id), media: await d.localMedia(id), gps: await d.localGps(id), outbox: await d.outbox() };
  expect(after).toEqual(before);
  expect(after.media.every((m) => m.blob?.size > 0 && m.uploaded === 0)).toBe(true);
  expect(await serverRecord(id)).toBeNull();
  await d.context.setOffline(false);
  await d.waitSynced();
});

test('E03 [P0] the manifest is valid and its icons are real', async ({ qa }) => {
  const d = await qa.device('deviceA');
  await d.open('', { sync: false });
  const href = await d.page.locator('link[rel="manifest"]').getAttribute('href');
  const url = new URL(href, BASE_URL).href;
  const res = await d.context.request.get(url);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(/application\/manifest\+json|application\/json/);
  const m = await res.json();
  qa.note('manifest', m);
  expect(m.name).toBe('FieldSync');
  expect(m.short_name.length).toBeLessThanOrEqual(12);
  expect(['standalone', 'fullscreen', 'minimal-ui']).toContain(m.display);
  expect(new URL(m.start_url, url).href).toBe(BASE_URL);
  expect(new URL(m.scope, url).href).toBe(BASE_URL);
  expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  expect(m.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  const sizes = {};
  for (const icon of m.icons) {
    const r = await d.context.request.get(new URL(icon.src, url).href);
    expect(r.status(), icon.src).toBe(200);
    expect(r.headers()['content-type']).toBe('image/png');
    const buf = await r.body();
    expect(buf.subarray(1, 4).toString()).toBe('PNG');
    const size = `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
    expect(size, `${icon.src} really is ${icon.sizes}`).toBe(icon.sizes);
    sizes[`${icon.purpose}:${icon.sizes}`] = buf.length;
  }
  qa.note('icons', sizes);
  expect(Object.keys(sizes)).toEqual(expect.arrayContaining(['any:192x192', 'any:512x512', 'maskable:512x512']));
  const meta = await d.page.evaluate(() => ({
    theme: document.querySelector('meta[name="theme-color"]')?.content,
    apple: document.querySelector('link[rel="apple-touch-icon"]')?.href,
    viewport: document.querySelector('meta[name="viewport"]')?.content,
  }));
  expect(meta.theme.toLowerCase()).toBe(m.theme_color.toLowerCase());
  expect((await d.context.request.get(meta.apple)).status()).toBe(200);
  if (!m.screenshots) qa.finding('Manifest has no "screenshots", so Chrome on Android shows the plain install prompt instead of the richer install sheet. Optional.');
});

test('E04 [P0] the service worker is registered, active and scoped to the app', async ({ qa }) => {
  const d = await qa.device('deviceA');
  await d.open('', { sync: false });
  const info = await d.page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    const all = await navigator.serviceWorker.getRegistrations();
    return {
      count: all.length, scope: reg.scope, script: reg.active?.scriptURL, state: reg.active?.state,
      controller: navigator.serviceWorker.controller?.scriptURL ?? null, waiting: Boolean(reg.waiting), caches: await caches.keys(),
    };
  });
  qa.note('worker', info);
  expect(info.count).toBe(1);
  expect(info.scope).toBe(BASE_URL);
  expect(info.script).toBe(`${BASE_URL}sw.js`);
  expect(info.state).toBe('activated');
  expect(info.controller).toBe(`${BASE_URL}sw.js`);
  expect(info.caches).toHaveLength(1);
  expect(info.caches[0]).toMatch(/^fieldsync-[0-9a-f]{12}$/);
  const res = await d.context.request.get(`${BASE_URL}sw.js`);
  qa.note('swCacheControl', res.headers()['cache-control']);
  expect(res.headers()['cache-control']).toMatch(/no-cache|max-age=0/);
  // The worker must leave Supabase alone: API calls are never answered from a cache.
  const src = await res.text();
  expect(src).toContain('self.location.origin');
});

test('E05 [P0] Chrome considers the app installable', async ({ qa }) => {
  const d = await qa.device('deviceA');
  await d.open('', { sync: false });
  const cdp = await d.context.newCDPSession(d.page);
  const manifest = await cdp.send('Page.getAppManifest');
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
  const ids = installabilityErrors.map((e) => e.errorId);
  qa.note('installabilityErrors', ids);
  qa.note('manifestErrors', manifest.errors);
  expect(manifest.errors).toEqual([]);
  expect(manifest.url).toBe(`${BASE_URL}manifest.webmanifest`);
  // "in-incognito" is the test browser itself (every Playwright context is an incognito profile).
  expect(ids.filter((id) => id !== 'in-incognito')).toEqual([]);
  await d.go('#/install');
  await d.shot('install-screen');
});

test('E06 [P1] a new deploy replaces the cached app without touching local data', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  await d.offline();
  const id = await d.createRecord({ title: uniq('E06 before update'), fields: { ph: 6.1 }, photos: photos(2) });
  const before = { rec: await d.localRecord(id), media: await d.localMedia(id), outbox: await d.outbox(), caches: await d.page.evaluate(() => caches.keys()) };
  // Hold back the upload so the change is still pending while the worker updates.
  await d.context.route('**/rest/v1/rpc/sync_push*', (r) => r.abort('internetdisconnected'));
  await d.context.route('**/storage/v1/object/**', (r) => r.abort('internetdisconnected'));
  await d.context.setOffline(false);
  // Pretend a new build was deployed: same worker, new version string.
  let served = 0;
  await d.context.route('**/sw.js', async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace(/const VERSION = "[0-9a-f]+"/, 'const VERSION = "qa0000000001"');
    served++;
    await route.fulfill({ response: res, body });
  });
  // watch the cache list while the worker updates
  await d.page.evaluate(() => { window.__cacheLog = []; window.__cacheTimer = setInterval(async () => { const k = (await caches.keys()).join(','); if (window.__cacheLog.at(-1) !== k) window.__cacheLog.push(k); }, 50); });
  await d.page.evaluate(async () => { const reg = await navigator.serviceWorker.getRegistration(); await reg.update(); }).catch(() => {});
  const updated = await expect(async () => { expect(await d.page.evaluate(() => window.__cacheLog.join(' '))).toContain('fieldsync-qa0000000001'); }).toPass({ timeout: 40_000 }).then(() => true).catch(() => false);
  qa.note('swRequestIntercepted', served);
  if (!updated) {
    qa.blocked('The test browser does not let the harness swap the service worker script, and redeploying is not allowed in this job.',
      '1) Note the pending count on a device with unsynced records. 2) Redeploy any change (new VERSION in sw.js). 3) Reopen the app twice. 4) Check DevTools > Application: one cache named fieldsync-<new version>, and the pending records and photos are still in IndexedDB and upload.');
  }
  // The old cache must be gone once the new worker is active. (Later the browser's own update check, which the
  // harness cannot intercept, may fetch the real worker again and swap back: that is a second real update.)
  await expect(async () => { expect(await d.page.evaluate(() => window.__cacheLog)).toContain('fieldsync-qa0000000001'); }).toPass({ timeout: 30_000 });
  qa.note('cacheSequence', await d.page.evaluate(() => window.__cacheLog));
  const after = { rec: await d.localRecord(id), media: await d.localMedia(id), outbox: await d.outbox(), caches: await d.page.evaluate(() => caches.keys()) };
  qa.note('caches', { before: before.caches, after: after.caches });
  expect(after.rec).toEqual(before.rec);
  expect(after.media).toEqual(before.media);
  expect(after.outbox).toEqual(before.outbox);
  // the page that was open keeps running; a reload gives the new build, offline too
  await d.context.setOffline(true);
  await d.page.reload();
  await d.page.waitForSelector('html[data-ready="1"]');
  await expect(d.row(id)).toHaveAttribute('data-status', 'pending');
  await d.shot('after-update-offline');
  await d.context.unroute('**/rest/v1/rpc/sync_push*');
  await d.context.unroute('**/storage/v1/object/**');
  await d.context.setOffline(false);
  await d.waitSynced();
  expect(await serverRecord(id)).toBeTruthy();
  qa.finding('After a new version is installed the open page keeps running the old code with no "new version" notice; the new build is only used after the next reload. Acceptable for the demo.');
});

test('E07 [P1] refreshing a deep link shows the same screen, online and offline', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  const title = uniq('E07 deep link');
  const id = await d.createRecord({ title, fields: { ph: 6.5 } });
  await d.waitSynced();
  const links = { [`#/record/${id}`]: title, '#/sync': 'Sync', '#/conflicts': 'Conflict log', '#/tracks': 'Tracks', '#/regions': 'Regions', [`#/edit/${id}`]: 'Edit soil sample' };
  for (const offline of [false, true]) {
    await d.context.setOffline(offline);
    for (const [hash, heading] of Object.entries(links)) {
      const res = await d.page.goto(BASE_URL + hash);
      await d.page.reload();
      await d.page.waitForSelector('html[data-ready="1"]');
      await expect(d.page.locator('#pane-detail h1').first(), `${hash} offline=${offline}`).toHaveText(heading);
      expect(d.page.url()).toBe(BASE_URL + hash);
      if (res) expect(res.status()).toBeLessThan(400);
    }
    // a link opened cold in a new tab
    const p2 = await d.context.newPage();
    await p2.goto(`${BASE_URL}#/record/${id}`);
    await p2.waitForSelector('html[data-ready="1"]');
    await expect(p2.locator('#record-title')).toHaveText(title);
    await p2.close();
  }
  await d.context.setOffline(false);
  // unknown hash falls back to the list, unknown record says so
  await d.page.goto(`${BASE_URL}#/nope`);
  await d.page.reload();
  await expect(d.page.locator('h1.title')).toHaveText('Observations');
  await d.go('#/record/00000000-0000-4000-8000-000000000000');
  await expect(d.page.locator('#pane-detail')).toContainText('Record not found');
  // real paths are not used by the app; record what the host answers
  const pathStatus = (await d.context.request.get(`${ORIGIN}/records`)).status();
  qa.note('GET /records', pathStatus);
  if (pathStatus === 404) qa.finding('Only hash links work. A path link such as /records is answered by the host with its own 404 page (no SPA fallback). The app never produces such links, so this is informational.');
  expect(state.ts).toBeTruthy();
});

test('E08 [P1] every file the app needs is in the worker cache', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  const sw = await (await d.context.request.get(`${BASE_URL}sw.js`)).text();
  const files = JSON.parse(/const FILES = (\[.*?\]);/s.exec(sw)[1]);
  qa.note('precacheCount', files.length);
  const result = await d.page.evaluate(async (list) => {
    const missing = [];
    for (const f of list) if (!(await caches.match(new URL(f, location.href.split('#')[0]).href))) missing.push(f);
    const used = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.startsWith(location.origin));
    const all = new Set(list.map((f) => new URL(f, location.href.split('#')[0]).href));
    return { missing, notPrecached: [...new Set(used.filter((n) => !all.has(n.split('?')[0])))] };
  }, files);
  qa.note('result', result);
  expect(result.missing).toEqual([]);
  expect(result.notPrecached.filter((u) => !u.includes('/.netlify/'))).toEqual([]);
  for (const need of ['./', 'js/main.js', 'js/vendor/dexie.js', 'js/vendor/supabase.js', 'js/config.js', 'css/app.css', 'manifest.webmanifest', 'icons/icon-192.png']) {
    expect(files, need).toContain(need);
  }
});

test('E09 [P2] first visit on a bad connection: one failed file must not leave a blank app', async ({ qa }) => {
  const d = await qa.device('deviceA');
  let aborted = 0;
  await d.context.route('**/js/screens/tracks.js', (route) => { aborted++; return route.abort('connectionreset'); });
  await d.page.goto(BASE_URL);
  await d.page.waitForTimeout(8000);
  const seen = await d.page.evaluate(() => ({
    ready: document.documentElement.dataset.ready ?? null,
    text: document.body.innerText.trim().slice(0, 200),
    statusbar: document.getElementById('statusbar').innerText.trim(),
  }));
  qa.note('aborted', aborted);
  qa.note('seen', seen);
  await d.shot('blank-after-one-failed-module');
  expect(aborted).toBeGreaterThan(0);
  expect(seen.text.length, 'the user sees something: the app, or a message with a way to retry').toBeGreaterThan(0);
});
