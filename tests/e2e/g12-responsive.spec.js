import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, newDevice, uniq } from './helpers.js';
import { ROOT } from '../../scripts/env.mjs';

const WIDTHS = [[390, 844, 'phone'], [820, 1180, 'tablet'], [1280, 800, 'laptop']];
const SHOTS = resolve(ROOT, 'artifacts/screens');

// Layout rules checked on every screen: no horizontal scroll, nothing pushed
// off the side, and every control at least 44 x 44 px.
async function audit(page, name) {
  await page.evaluate(() => document.fonts.ready);
  const problems = await page.evaluate(() => {
    const out = [];
    const vw = window.innerWidth;
    if (document.documentElement.scrollWidth > vw) out.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${vw})`);
    for (const el of document.querySelectorAll('.scroll, .pane, .console .main, .console .side, .sheet, .signin .form')) {
      if (el.scrollWidth > el.clientWidth + 1) out.push(`${el.className} scrolls sideways (${el.scrollWidth} > ${el.clientWidth})`);
    }
    for (const el of document.querySelectorAll('a[href], button, input, select, textarea, [role="tab"], [role="button"]')) {
      if (el.type === 'file' || el.type === 'hidden' || el.closest('[hidden]')) continue;
      const style = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || (r.width === 0 && r.height === 0)) continue;
      const label = `${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute('aria-label') || el.name || '').trim().slice(0, 30)}"`;
      if (r.width < 44 || r.height < 44) out.push(`${label} is ${Math.round(r.width)} x ${Math.round(r.height)} px`);
      if (!el.closest('.table-wrap') && (r.left < -1 || r.right > vw + 1)) out.push(`${label} is off screen (${Math.round(r.left)}..${Math.round(r.right)} of ${vw})`);
    }
    return out;
  });
  expect(problems, `${name}: layout problems`).toEqual([]);
}

async function shot(page, width, name) {
  mkdirSync(resolve(SHOTS, String(width)), { recursive: true });
  await page.screenshot({ path: resolve(SHOTS, String(width), `${name}.png`) });
}

test('G12 every screen fits 390, 820 and 1280 px with no horizontal scroll and 44 px targets', async ({ browser, deviceA, deviceB, leadDevice }, testInfo) => {
  test.setTimeout(300_000);

  // Realistic content: synced records of each type, one same-field conflict,
  // one delete conflict, a saved track, and one record still pending.
  await deviceA.open();
  const soil = await deviceA.createRecord({ title: 'Soil sample, north transect', fields: { ph: 6.4, moisture: 22, temperature: 18.5, depth: 15 }, notes: 'Dark loam, damp near the roots.', photos: 3 });
  await deviceA.createRecord({ title: 'Stream sample, upstream', type: 'water', fields: { turbidity: 12, ph: 7.2 }, photos: 2 });
  await deviceA.createRecord({ title: 'Heron sighting', type: 'wildlife', fields: { species: 'Grey heron', count: 2 }, notes: 'Feeding at the bend.' });
  const doomed = await deviceA.createRecord({ title: uniq('Soil sample, east bank'), fields: { ph: 6.1 }, notes: 'Bank is eroding' });
  await deviceA.idle();
  await deviceB.open();
  await deviceB.offline();
  await deviceB.editRecord(soil, { ph: 6.8 });
  await deviceB.editRecord(doomed, { notes: 'Roots exposed on the east bank, resample.' });
  await deviceA.editRecord(soil, { ph: 6.5 });
  await deviceA.go(`#/record/${doomed}`);
  await deviceA.page.click('#delete-record');
  await deviceA.page.click('#confirm-delete');
  await deviceA.idle();
  await deviceB.online();
  await deviceB.idle();
  await deviceA.sync();

  await deviceA.go('#/tracks');
  await deviceA.page.fill('#track-name', 'Ridge walk');
  await deviceA.page.click('#start-track');
  for (const [lat, lng] of [[24.8611, 67.0016], [24.8618, 67.0021], [24.8616, 67.0032], [24.8627, 67.0041]]) {
    await deviceA.context.setGeolocation({ latitude: lat, longitude: lng, accuracy: 4 });
    await deviceA.page.waitForTimeout(250);
  }
  await expect(deviceA.page.locator('#track-points')).not.toHaveText('0');
  await deviceA.page.click('#stop-track');
  await deviceA.idle();

  await deviceA.offline();
  const pending = await deviceA.createRecord({ title: 'Soil sample, ridge', fields: { ph: 7.1, moisture: 18 }, photos: 1 });

  const { page } = deviceA;
  for (const [width, height, kind] of WIDTHS) {
    await page.setViewportSize({ width, height });
    const visit = async (hash, name, ready) => {
      await deviceA.go(hash);
      await page.locator(ready).first().waitFor();
      await page.waitForTimeout(150);
      await audit(page, `${kind} ${name}`);
      await shot(page, width, name);
    };
    await visit('#/records', 'records', '#record-list');
    await visit(`#/record/${soil}`, 'record-detail', '#record-title');
    await page.click('#delete-record');
    await page.locator('.sheet').waitFor();
    await audit(page, `${kind} delete-confirm`);
    await shot(page, width, 'delete-confirm');
    await page.click('.sheet [data-act="keep"]');
    await visit(`#/record/${pending}`, 'record-pending', '#record-title');
    await visit('#/new', 'new-record', '#record-form');
    await visit('#/permissions', 'permissions', 'text=Permissions are set in the browser');
    await visit(`#/edit/${soil}`, 'edit-record', '#record-form');
    await visit('#/tracks', 'tracks', '#recorder');
    await visit('#/sync', 'sync', '#outbox-list');
    await visit('#/conflicts', 'conflict-log', '#conflict-list');
    await visit('#/regions', 'regions', 'text=Assigned by your data lead');
    await visit('#/storage', 'storage', '#storage-card');
    await visit('#/install', 'install', 'text=Install FieldSync');
    await visit('#/styleguide', 'style-guide', 'text=One look, three builders');

    // First run: a region with no records yet (Region B is empty at this point).
    await deviceA.go('#/regions');
    await page.getByRole('button', { name: /Region B/ }).click();
    await page.getByText('No records yet').waitFor();
    await audit(page, `${kind} first-run-empty`);
    await shot(page, width, 'first-run-empty');
    await deviceA.go('#/regions');
    await page.getByRole('button', { name: /Region A/ }).click();
    await page.locator('#record-list').waitFor();
  }

  // iPhone in Safari (not installed): the Add to Home Screen notice and the install steps.
  const iphone = await newDevice(browser, 'iphone', {
    user: 'researcherA', viewport: { width: 393, height: 852 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });
  try {
    await iphone.open();
    await expect(iphone.page.locator('.notice.warn')).toContainText('Add to Home Screen');
    await audit(iphone.page, 'iphone records');
    await shot(iphone.page, 393, 'iphone-records');
    await iphone.page.getByRole('link', { name: 'How' }).click();
    await expect(iphone.page.locator('h1.title')).toHaveText('Install FieldSync');
    await expect(iphone.page.getByText('Open in Safari')).toBeVisible();
    await expect(iphone.page.locator('#cached-state')).toHaveText('Done');
    await audit(iphone.page, 'iphone install');
    await shot(iphone.page, 393, 'iphone-install');
  } finally {
    await iphone.close(testInfo);
  }

  // Sign-in (a device with no session) at each width.
  const fresh = await newDevice(browser, 'signin');
  try {
    for (const [width, height, kind] of WIDTHS) {
      await fresh.page.setViewportSize({ width, height });
      await fresh.page.goto('./');
      await fresh.page.locator('input[name="email"]').waitFor();
      await audit(fresh.page, `${kind} sign-in`);
      await shot(fresh.page, width, 'sign-in');
    }
  } finally {
    await fresh.close(testInfo);
  }

  // Data lead console at each width.
  await leadDevice.open();
  await expect(leadDevice.page).toHaveURL(/#\/console$/);
  for (const [width, height, kind] of WIDTHS) {
    await leadDevice.page.setViewportSize({ width, height });
    await leadDevice.page.locator('#dataset').waitFor();
    await leadDevice.page.waitForTimeout(150);
    await audit(leadDevice.page, `${kind} console`);
    await shot(leadDevice.page, width, 'console');
    for (const section of ['conflicts', 'researchers']) {
      await leadDevice.page.click(`[data-section="${section}"]`);
      await audit(leadDevice.page, `${kind} console ${section}`);
      await shot(leadDevice.page, width, `console-${section}`);
    }
    await leadDevice.page.click('[data-section="dataset"]');
  }
});
