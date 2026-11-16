// D. GPS
import { test, expect, state, sql, serverRecord, waitSql, uniq } from '../lib/harness.js';

const serverGps = (recordId) => sql('select * from public.gps_logs where record_id = $1', [recordId]);
const localTracks = async (d) => ((await d.idb(['gpsLogs']))?.gpsLogs ?? []).filter((g) => g.kind === 'track');

// A scriptable location source, installed before the app starts. It replaces
// only the browser's geolocation API (not app code).
function geoMock() {
  const g = { mode: 'ok', lat: 24.86, lng: 67.0, watchers: new Map(), next: 1, calls: 0 };
  window.__geo = g;
  const pos = () => ({ coords: { latitude: g.lat, longitude: g.lng, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() });
  const fail = (code, message) => ({ code, message, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
  const api = {
    getCurrentPosition(ok, err, opts) {
      g.calls++;
      if (g.mode === 'ok') setTimeout(() => ok(pos()), 50);
      else if (g.mode === 'unavailable') setTimeout(() => err?.(fail(2, 'Position unavailable')), 50);
      else if (g.mode === 'timeout') setTimeout(() => err?.(fail(3, 'Timeout expired')), Math.min(opts?.timeout ?? 3000, 3000));
    },
    watchPosition(ok, err) { const id = g.next++; g.watchers.set(id, { ok, err }); return id; },
    clearWatch(id) { g.watchers.delete(id); },
  };
  g.emit = (n, stepLat = 0.00005, stepLng = 0.00003) => {
    for (let i = 0; i < n; i++) { g.lat += stepLat; g.lng += stepLng; for (const w of g.watchers.values()) w.ok(pos()); }
    return g.watchers.size;
  };
  Object.defineProperty(navigator, 'geolocation', { value: api, configurable: true });
}

test('D01 [P0] GPS point capture', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a', geo: { latitude: 24.860712, longitude: 67.001134, accuracy: 7 } });
  await d.open();
  await d.offline();
  const id = await d.createRecord({ title: uniq('D01 gps point'), fields: { ph: 6.2 } });
  const local = await d.localGps(id);
  expect(local).toHaveLength(1);
  expect(local[0].kind).toBe('point');
  expect(local[0].points[0]).toMatchObject({ lat: 24.860712, lng: 67.001134, acc: 7 });
  expect(Number.isNaN(Date.parse(local[0].points[0].t))).toBe(false);
  expect((await d.outbox()).filter((o) => o.table === 'gps_logs' && o.rowId === local[0].id)).toHaveLength(1);
  await d.go(`#/record/${id}`);
  await expect(d.page.locator('#gps-line')).toHaveText('24.8607 n, 67.0011 e +/- 7 m');
  await d.shot('detail-gps');
  await d.online();
  await d.waitSynced();
  const s = await serverGps(id);
  expect(s).toHaveLength(1);
  expect(s[0].kind).toBe('point');
  expect(s[0].region_id).toBe(state.regions.main);
  expect(s[0].points[0]).toMatchObject({ lat: 24.860712, lng: 67.001134, acc: 7 });
  // recapture on edit replaces the point, it does not add a second one
  await d.context.setGeolocation({ latitude: 25.1, longitude: 67.5, accuracy: 3 });
  await d.go(`#/edit/${id}`);
  await d.page.waitForSelector('#record-form');
  await d.page.click('[data-act="gps"]');
  await expect(d.page.locator('#gps-box')).toContainText('25.1000 n, 67.5000 e');
  await d.page.click('#save-record');
  await d.page.waitForFunction(() => !document.querySelector('#record-form'));
  await d.waitSynced();
  const s2 = await serverGps(id);
  expect(s2).toHaveLength(1);
  expect(s2[0].points).toHaveLength(1);
  expect(s2[0].points[0]).toMatchObject({ lat: 25.1, lng: 67.5 });
});

test('D02 [P2] location permission denied', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a', geo: null, permissions: [] });
  await d.open();
  await d.go('#/new');
  await d.page.waitForSelector('#record-form');
  const title = uniq('D02 no location');
  await d.page.fill('[data-field="title"]', title);
  await expect(d.page.locator('#gps-box')).toHaveAttribute('data-gps', 'blocked', { timeout: 20_000 });
  await expect(d.page.locator('#gps-box')).toContainText('Location access is blocked');
  await d.shot('gps-blocked');
  await d.page.click('#gps-box a[href="#/permissions"]');
  await d.page.waitForFunction(() => document.body.dataset.route === 'permissions');
  const row = d.page.locator('.row', { hasText: 'Location' }).first();
  await expect(row.locator('.status')).toHaveText('Blocked');
  await d.shot('permissions-location-blocked');
  await d.page.click('[data-act="gps-retry"]');
  await expect(row.locator('.status')).toHaveText('Blocked');
  await d.page.click('[data-act="save"]');
  await d.page.waitForFunction(() => document.body.dataset.route === 'records');
  const rec = (await d.idb(['records'])).records.find((r) => r.fields.title === title);
  expect(rec, 'draft title survived the permissions detour and the record was saved').toBeTruthy();
  expect(await d.localGps(rec.id)).toHaveLength(0);
  await d.waitSynced();
  expect(await serverRecord(rec.id)).toBeTruthy();
  expect(await serverGps(rec.id)).toHaveLength(0);
  await d.go(`#/record/${rec.id}`);
  await expect(d.page.locator('#gps-line')).toHaveText('No GPS point');
  // tracks screen says why nothing is recorded
  await d.go('#/tracks');
  await d.page.click('#start-track');
  await expect(d.page.locator('[role="alert"]')).toContainText(/blocked/i, { timeout: 15_000 });
  await d.shot('track-blocked');
  await d.page.click('#stop-track');
});

test('D03 [P2] position unavailable and timeout', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a', init: [geoMock] });
  await d.open();
  for (const mode of ['unavailable', 'timeout']) {
    await d.page.evaluate((m) => { window.__geo.mode = m; }, mode);
    await d.go('#/new');
    await d.page.waitForSelector('#record-form');
    const title = uniq(`D03 ${mode}`);
    await d.page.fill('[data-field="title"]', title);
    await expect(d.page.locator('#gps-box')).toHaveAttribute('data-gps', 'none', { timeout: 20_000 });
    await expect(d.page.locator('#gps-box')).toContainText('No GPS fix yet');
    await expect(d.page.locator('[data-act="gps"]')).toBeEnabled();
    await d.shot(`gps-${mode}`);
    // typing was not interrupted by the GPS box repainting
    expect(await d.page.locator('[data-field="title"]').inputValue()).toBe(title);
    if (mode === 'unavailable') {
      // retry works once a fix is possible
      await d.page.evaluate(() => { window.__geo.mode = 'ok'; });
      await d.page.click('[data-act="gps"]');
      await expect(d.page.locator('#gps-box')).toHaveAttribute('data-gps', 'fixed');
    }
    await d.page.click('#save-record');
    await d.page.waitForFunction(() => !document.querySelector('#record-form'));
    const rec = (await d.idb(['records'])).records.find((r) => r.fields.title === title);
    expect(await d.localGps(rec.id)).toHaveLength(mode === 'unavailable' ? 1 : 0);
  }
  await d.waitSynced();
});

test('D04 [P1] a long track of 600 points', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a', init: [geoMock] });
  await d.open();
  await d.go('#/tracks');
  const name = uniq('D04 long walk');
  await d.page.fill('#track-name', name);
  await d.page.click('#start-track');
  await expect(d.page.locator('#recorder')).toHaveAttribute('data-status', 'recording');
  const t0 = Date.now();
  for (let i = 0; i < 12; i++) {
    await d.page.evaluate(() => window.__geo.emit(50));
    await d.page.waitForTimeout(150);
  }
  await expect(d.page.locator('#track-points')).toHaveText('600', { timeout: 30_000 });
  qa.note('emit600Ms', Date.now() - t0);
  await d.shot('recording-600');
  const paintMs = await d.page.evaluate(async () => {
    const t = performance.now();
    window.__geo.emit(1);
    await new Promise((r) => { requestAnimationFrame(() => requestAnimationFrame(r)); });
    return performance.now() - t;
  });
  qa.note('onePointAt600Ms', paintMs);
  await d.page.click('#stop-track');
  await expect(d.page.locator('#recorder')).toHaveAttribute('data-status', 'idle');
  const track = (await localTracks(d)).find((g) => g.name === name);
  expect(track.points).toHaveLength(601);
  expect(track.distanceM).toBeGreaterThan(3000);
  expect(track.recording).toBe(0);
  await d.waitSynced();
  const s = (await sql('select * from public.gps_logs where id = $1', [track.id]))[0];
  expect(s.kind).toBe('track');
  expect(s.points).toHaveLength(601);
  expect(s.points[600]).toEqual(track.points[600]);
  expect(Math.abs(s.distance_m - track.distanceM)).toBeLessThan(0.01);
  expect(s.name).toBe(name);
  await expect(d.page.locator(`[data-track="${track.id}"]`)).toHaveAttribute('data-status', 'synced');
  await d.shot('saved-track');
  qa.note('track', { points: 601, distanceM: Math.round(track.distanceM), payloadKb: Math.round(JSON.stringify(s.points).length / 1024) });
  expect(paintMs, 'adding one point to a 600-point track stays quick').toBeLessThan(500);
});

test('D05 [P0] a track recorded while the device goes offline uploads on reconnect', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a', geo: { latitude: 24.9, longitude: 67.1, accuracy: 5 } });
  await d.open();
  await d.go('#/tracks');
  const name = uniq('D05 offline walk');
  await d.page.fill('#track-name', name);
  await d.page.click('#start-track');
  const points = d.page.locator('#track-points');
  await expect(points).not.toHaveText('0', { timeout: 20_000 });
  let n = Number(await points.textContent());
  const step = async (i) => {
    await d.context.setGeolocation({ latitude: 24.9 + i * 0.0004, longitude: 67.1 + i * 0.0003, accuracy: 5 });
    await expect(points).not.toHaveText(String(n), { timeout: 20_000 });
    n = Number(await points.textContent());
  };
  for (let i = 1; i <= 3; i++) await step(i);
  await d.offline();                       // signal lost in the middle of the walk
  for (let i = 4; i <= 8; i++) await step(i);
  await d.shot('recording-offline');
  await d.page.click('#stop-track');
  await expect(d.page.locator('#recorder')).toHaveAttribute('data-status', 'idle');
  const track = (await localTracks(d)).find((g) => g.name === name);
  expect(track.points.length).toBe(n);
  expect(track.points.length).toBeGreaterThanOrEqual(9);
  expect((await d.outbox()).filter((o) => o.table === 'gps_logs' && o.rowId === track.id)).toHaveLength(1);
  await expect(d.page.locator(`[data-track="${track.id}"]`)).toHaveAttribute('data-status', 'pending');
  await expect(d.page.locator('#sb-text')).toHaveText('Offline / 1 pending');
  expect(await sql('select id from public.gps_logs where id = $1', [track.id])).toHaveLength(0);
  // survives a restart while still offline
  await d.page.reload();
  await d.page.waitForSelector('html[data-ready="1"]');
  await d.go('#/tracks');
  await expect(d.page.locator(`[data-track="${track.id}"]`)).toHaveAttribute('data-status', 'pending');
  await d.context.setOffline(false);
  const rows = await waitSql('select * from public.gps_logs where id = $1', [track.id], (r) => r.length === 1, 30_000);
  expect(rows[0].points).toHaveLength(track.points.length);
  expect(rows[0].kind).toBe('track');
  await expect(d.page.locator(`[data-track="${track.id}"]`)).toHaveAttribute('data-status', 'synced', { timeout: 30_000 });
});

test('D06 [P2] coordinates at the edge values', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a', geo: { latitude: 90, longitude: 180, accuracy: 1 } });
  await d.open();
  const cases = [
    { geo: { latitude: 90, longitude: 180, accuracy: 1 }, text: '90.0000 n, 180.0000 e' },
    { geo: { latitude: -90, longitude: -180, accuracy: 1 }, text: '90.0000 s, 180.0000 w' },
    { geo: { latitude: 0, longitude: 0, accuracy: 0 }, text: '0.0000 n, 0.0000 e' },
    { geo: { latitude: -0.000001, longitude: 179.9999999, accuracy: 2500 }, text: null },
  ];
  const seen = [];
  for (const c of cases) {
    await d.context.setGeolocation(c.geo);
    const id = await d.createRecord({ title: uniq(`D06 ${c.geo.latitude},${c.geo.longitude}`), fields: { ph: 6 } });
    const p = (await d.localGps(id))[0]?.points[0];
    expect(p, `point saved for ${JSON.stringify(c.geo)}`).toBeTruthy();
    expect(p.lat).toBe(Number(c.geo.latitude.toFixed(6)));
    expect(p.lng).toBe(Number(c.geo.longitude.toFixed(6)));
    await d.waitSynced();
    const s = (await serverGps(id))[0].points[0];
    expect(s.lat).toBe(p.lat);
    expect(s.lng).toBe(p.lng);
    await d.go(`#/record/${id}`);
    const line = await d.page.locator('#gps-line').textContent();
    seen.push({ geo: c.geo, stored: p, shown: line });
    if (c.text) expect(line).toContain(c.text);
    expect(line).not.toMatch(/NaN|undefined|No GPS point/);
  }
  qa.note('seen', seen);
  await d.shot('edge-coordinates');
  if (seen[3].shown.includes('180.0000 e') && seen[3].stored.lng !== 180) qa.finding('Display rounds to 4 decimals (about 11 m); stored value keeps 6. Fine, noted only.');
});

test('D07 [P1] reloading in the middle of a recording does not lose the track', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a', init: [geoMock] });
  await d.open();
  await d.go('#/tracks');
  const name = uniq('D07 interrupted');
  await d.page.fill('#track-name', name);
  await d.page.click('#start-track');
  await expect(d.page.locator('#recorder')).toHaveAttribute('data-status', 'recording');
  for (let i = 0; i < 9; i++) { await d.page.evaluate(() => window.__geo.emit(1)); await d.page.waitForTimeout(60); }
  await expect(d.page.locator('#track-points')).toHaveText('9');
  await d.page.waitForTimeout(300);
  await d.page.reload();                    // app killed mid-walk
  await d.page.waitForSelector('html[data-ready="1"]');
  await d.waitSynced().catch(() => {});
  const before = (await localTracks(d)).find((g) => g.name === name);
  qa.note('afterReloadBeforeTracksScreen', { points: before?.points.length ?? 0, recording: before?.recording, queued: (await d.outbox()).some((o) => o.rowId === before?.id) });
  expect(before, 'track draft survived the reload').toBeTruthy();
  const lost = 9 - before.points.length;
  qa.note('pointsLost', lost);
  expect(lost, 'at most the documented 4 points are lost').toBeLessThanOrEqual(4);
  if (lost > 0) qa.finding(`${lost} of 9 GPS points were lost by a reload mid-recording: the track is written to IndexedDB only every 5th point (DECISIONS 38), which conflicts with PRD "no data loss if the app closes".`);
  if (!(await d.outbox()).some((o) => o.rowId === before.id)) qa.finding('An interrupted track is only finished and queued when the Tracks screen is opened again; until then it never uploads.');
  await d.go('#/tracks');
  await expect(d.page.locator(`[data-track="${before.id}"]`)).toHaveCount(1);
  await d.shot('recovered-track');
  const rows = await waitSql('select * from public.gps_logs where id = $1', [before.id], (r) => r.length === 1, 30_000);
  expect(rows[0].points).toHaveLength(before.points.length);
  expect(rows[0].name).toBe(name);
});

test('D08 [P2] deleting a synced track reaches the server and the other device', async ({ qa }) => {
  const a = await qa.device('deviceA', { user: 'a', init: [geoMock] });
  const b = await qa.device('deviceB', { user: 'b' });
  await a.open();
  await b.open();
  await a.go('#/tracks');
  const name = uniq('D08 to delete');
  await a.page.fill('#track-name', name);
  await a.page.click('#start-track');
  await a.page.waitForFunction(() => window.__geo.watchers.size > 0);   // the watch starts a moment after the tap
  await a.page.evaluate(() => window.__geo.emit(4));
  await expect(a.page.locator('#track-points')).toHaveText('4');
  await a.page.click('#stop-track');
  await a.waitSynced();
  const track = (await localTracks(a)).find((g) => g.name === name);
  await b.syncNow();
  await b.go('#/tracks');
  await expect(b.page.locator(`[data-track="${track.id}"]`)).toHaveCount(1);
  await a.go('#/tracks');
  await a.page.click(`[data-track="${track.id}"]`);
  await expect(a.page.locator('#sheet-root .sheet')).toContainText('4 points');
  await a.shot('track-sheet');
  await a.page.click('#sheet-root [data-act="remove"]');
  await expect(a.page.locator(`[data-track="${track.id}"]`)).toHaveCount(0);
  await a.waitSynced();
  const s = (await sql('select deleted from public.gps_logs where id = $1', [track.id]))[0];
  expect(s.deleted).toBe(true);
  await b.syncNow();
  await b.go('#/tracks');
  await expect(b.page.locator(`[data-track="${track.id}"]`)).toHaveCount(0);
  expect((await localTracks(b)).some((g) => g.id === track.id)).toBe(false);
});
