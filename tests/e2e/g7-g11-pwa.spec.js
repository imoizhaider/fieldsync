import { inflateSync } from 'node:zlib';
import { test, expect, newDevice, env, seed, uniq } from './helpers.js';

test('G7 after one online sign-in the app opens with the network off and lists records', async ({ browser }, testInfo) => {
  // A brand new device: no saved session, real sign-in through the screen.
  const device = await newDevice(browser, 'fresh');
  const { page, context } = device;
  try {
    await page.goto('./');
    await expect(page.locator('#sb-text')).toHaveText('Online / sign-in needed');
    await page.fill('input[name="email"]', seed.users.researcherA.email);
    await page.fill('input[name="password"]', env.SEED_PASSWORD);
    await page.click('button[type="submit"]');
    await expect(page.locator('#region-link')).toContainText('Region A');
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null);

    const title = uniq('G7 soil');
    const id = await device.createRecord({ title, fields: { ph: 6.6 } });
    await device.idle();

    // Persistent storage was requested at sign-in.
    expect(await device.idb(async (db) => (await db.meta.get('persisted')) !== undefined)).toBe(true);

    // Network fully off: offline switch on, and every request that would
    // still reach the network is aborted and counted.
    await page.close();
    await context.setOffline(true);
    const leaked = [];
    await context.route('**/*', (route) => { leaked.push(route.request().url()); return route.abort('internetdisconnected'); });

    const reopened = await context.newPage();
    device.page = reopened;
    device.watch(reopened);
    await reopened.goto('./');
    await reopened.waitForSelector('html[data-ready="1"]');
    await expect(reopened.locator('#sb-text')).toHaveText('Offline / 0 pending');
    await expect(reopened.locator('h1.title')).toHaveText('Observations');
    await expect(device.row(id)).toContainText(title);
    await expect(device.row(id)).toHaveAttribute('data-status', 'synced');
    // The font came from the cache too.
    expect(await reopened.evaluate(() => document.fonts.ready.then(() => document.fonts.check('600 16px "IBM Plex Sans"')))).toBe(true);
    // Nothing of the app shell had to come from the network.
    expect(leaked.filter((u) => u.includes('localhost'))).toEqual([]);

    // Still fully usable offline: a new record saves and survives another reload.
    const offlineId = await device.createRecord({ title: uniq('G7 offline'), fields: { ph: 7 } });
    await reopened.reload();
    await reopened.waitForSelector('html[data-ready="1"]');
    await expect(device.row(offlineId)).toHaveAttribute('data-status', 'pending');
  } finally {
    await device.close(testInfo);
  }
});

function pngSize(buffer) {
  expect(buffer.subarray(1, 4).toString('ascii')).toBe('PNG');
  const idat = buffer.indexOf('IDAT');
  expect(idat).toBeGreaterThan(0);
  inflateSync(buffer.subarray(idat + 4, idat + 4 + buffer.readUInt32BE(idat - 4))); // throws if the image data is broken
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test('G11 the app is installable: valid manifest, icons, and a registered service worker', async ({ deviceA }) => {
  const { page } = deviceA;
  await deviceA.open();

  // Manifest is linked and well formed.
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  const manifestUrl = new URL(href, page.url()).href;
  const res = await page.request.get(manifestUrl);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/manifest+json');
  const manifest = await res.json();
  expect(manifest.name).toBe('FieldSync');
  expect(manifest.short_name.length).toBeLessThanOrEqual(12);
  expect(manifest.display).toBe('standalone');
  expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  // start_url and scope stay inside the sub-path the app is served from.
  const base = new URL('./', page.url()).href;
  expect(new URL(manifest.start_url, manifestUrl).href).toBe(base);
  expect(new URL(manifest.scope, manifestUrl).href).toBe(base);

  // Icons: 192 and 512 PNG, plus a maskable one, all really that size.
  const sizes = {};
  for (const icon of manifest.icons) {
    const r = await page.request.get(new URL(icon.src, manifestUrl).href);
    expect(r.status(), icon.src).toBe(200);
    const { width, height } = pngSize(await r.body());
    expect(`${width}x${height}`).toBe(icon.sizes);
    expect(icon.type).toBe('image/png');
    sizes[`${icon.sizes}/${icon.purpose}`] = true;
  }
  expect(sizes).toMatchObject({ '192x192/any': true, '512x512/any': true, '512x512/maskable': true });

  // Service worker: registered for the app's scope, active, controlling the page, with a fetch handler.
  const sw = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return { scope: reg.scope, state: reg.active?.state, script: reg.active?.scriptURL, controlled: navigator.serviceWorker.controller != null };
  });
  expect(sw).toEqual({ scope: base, state: 'activated', script: `${base}sw.js`, controlled: true });
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    const cache = await caches.open(keys.find((k) => k.startsWith('fieldsync-')));
    return (await cache.keys()).map((r) => new URL(r.url).pathname);
  });
  for (const file of ['index.html', 'css/app.css', 'js/main.js', 'js/vendor/dexie.js', 'js/vendor/supabase.js', 'manifest.webmanifest', 'icons/icon-192.png', 'fonts/ibm-plex-sans-latin-400-normal.woff2']) {
    expect(cached, file).toContain(new URL(file, base).pathname);
  }

  // Chrome's own verdict.
  const cdp = await page.context().newCDPSession(page);
  const parsed = await cdp.send('Page.getAppManifest');
  expect(parsed.errors).toEqual([]);
  expect(parsed.url).toBe(manifestUrl);
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
  // A Playwright browser context is an incognito profile, where Chrome never
  // offers installation. That one environment error is expected; any other
  // error (manifest, icons, service worker, HTTPS) fails the gate.
  expect(installabilityErrors.filter((e) => e.errorId !== 'in-incognito')).toEqual([]);
});
