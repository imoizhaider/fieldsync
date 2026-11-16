// B. Records CRUD
import { test, expect, state, sql, api, serverRecord, waitSql, uniq } from '../lib/harness.js';
import { randomUUID } from 'node:crypto';

const SAMPLES = {
  soil: { ph: 6.4, moisture: 31, temperature: 18.5, depth: 15 },
  water: { ph: 7.2, turbidity: 4.1, temperature: 12, oxygen: 8.3 },
  wildlife: { species: 'Houbara bustard', count: 3 },
};
const PREFIX = { soil: 'SOIL', water: 'WTR', wildlife: 'WLD' };

async function createAll(d, tag) {
  const ids = {};
  for (const type of Object.keys(SAMPLES)) {
    ids[type] = await d.createRecord({ title: uniq(`${tag} ${type}`), type, fields: SAMPLES[type], notes: `${tag} notes ${type}` });
  }
  return ids;
}

test('B01 [P0] create soil, water and wildlife records (screen, IndexedDB, Postgres)', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  await d.offline();
  const ids = await createAll(d, 'B01');
  // offline: on screen as Pending, in IndexedDB with an outbox entry, not on the server
  await d.go('#/records');
  for (const [type, id] of Object.entries(ids)) {
    await expect(d.row(id)).toHaveAttribute('data-status', 'pending');
    await expect(d.row(id).locator('.row-top .label').first()).toHaveText(new RegExp(`^${PREFIX[type]}-\\d{3}$`));
    const local = await d.localRecord(id);
    expect(local.type).toBe(type);
    for (const [k, v] of Object.entries(SAMPLES[type])) expect(local.fields[k], `${type}.${k} local`).toBe(v);
    expect((await d.outbox()).filter((o) => o.rowId === id && o.table === 'records')).toHaveLength(1);
    expect(await serverRecord(id)).toBeNull();
  }
  await d.shot('offline-pending');
  await d.online();
  await d.waitSynced();
  for (const [type, id] of Object.entries(ids)) {
    const s = await serverRecord(id);
    expect(s.type).toBe(type);
    expect(s.region_id).toBe(state.regions.main);
    expect(s.deleted).toBe(false);
    expect(s.version).toBe(1);
    expect(s.created_by).toBe(state.users.a.id);
    for (const [k, v] of Object.entries(SAMPLES[type])) expect(s.fields[k], `${type}.${k} server`).toBe(v);
    await expect(d.row(id)).toHaveAttribute('data-status', 'synced');
    const local = await d.localRecord(id);
    expect(local.seq).toBe(s.seq);
    expect(local.version).toBe(1);
    await d.go(`#/record/${id}`);
    for (const [k, v] of Object.entries(SAMPLES[type])) await expect(d.page.locator(`.reading[data-field="${k}"]`)).toContainText(String(v));
    await d.go('#/records');
  }
});

test('B02 [P0] edit each record type', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  const ids = await createAll(d, 'B02');
  await d.waitSynced();
  const edits = { soil: { ph: 6.9, notes: 'B02 edited soil notes' }, water: { turbidity: 9.5, oxygen: '' }, wildlife: { species: 'Sindh ibex', count: 12 } };
  for (const [type, id] of Object.entries(ids)) {
    await d.editRecord(id, edits[type]);
    await d.waitSynced();
    const s = await serverRecord(id);
    const local = await d.localRecord(id);
    expect(s.version, `${type} version`).toBe(2);
    expect(local.version).toBe(2);
    for (const [k, v] of Object.entries(edits[type])) {
      const want = v === '' ? null : v;
      expect(s.fields[k], `${type}.${k} server`).toBe(want);
      expect(local.fields[k], `${type}.${k} local`).toBe(want);
    }
    // untouched fields are still there
    const untouched = Object.keys(SAMPLES[type]).find((k) => !(k in edits[type]));
    if (untouched) expect(s.fields[untouched]).toBe(SAMPLES[type][untouched]);
    await d.go(`#/record/${id}`);
    await expect(d.page.locator('#record-status')).toHaveText('Synced');
    for (const [k, v] of Object.entries(edits[type])) {
      if (k === 'notes') await expect(d.page.locator('p[data-field="notes"]')).toHaveText(v);
      else await expect(d.page.locator(`.reading[data-field="${k}"]`)).toContainText(v === '' ? '--' : String(v));
    }
  }
  await d.shot('edited-detail');
});

test('B03 [P0] delete each record type (soft delete)', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  const ids = await createAll(d, 'B03');
  await d.waitSynced();
  for (const [type, id] of Object.entries(ids)) {
    await d.go(`#/record/${id}`);
    await d.page.click('#delete-record');
    await expect(d.page.locator('#sheet-root .sheet h2')).toHaveText(new RegExp(`^Delete ${PREFIX[type]}-\\d{3}\\?$`));
    if (type === 'soil') {
      await d.shot('delete-confirm');
      // "Keep record" really keeps it
      await d.page.click('#sheet-root [data-act="keep"]');
      expect((await d.localRecord(id)).deleted).toBe(0);
      await d.page.click('#delete-record');
    }
    await d.page.click('#confirm-delete');
    await d.page.waitForFunction(() => document.body.dataset.route === 'records');
    await expect(d.row(id)).toHaveCount(0);
    expect((await d.localRecord(id)).deleted).toBe(1);
  }
  await d.waitSynced();
  for (const id of Object.values(ids)) {
    const s = await serverRecord(id);
    expect(s, 'row is kept on the server').toBeTruthy();
    expect(s.deleted).toBe(true);
    expect(s.version).toBe(2);
    expect((await d.localRecord(id)).deleted).toBe(1);
    await expect(d.row(id)).toHaveCount(0);
  }
});

test('B04 [P3] saving a completely empty form', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a', geo: null, permissions: [] });
  await d.open();
  await d.go('#/new');
  await d.page.waitForSelector('#record-form');
  const beforeIds = new Set((await d.idb(['records'])).records.map((r) => r.id));
  await d.page.click('#save-record');
  await d.page.waitForTimeout(1500);
  const formStill = (await d.page.locator('#record-form').count()) > 0;
  const made = (await d.idb(['records'])).records.filter((r) => !beforeIds.has(r.id) && r.fields.title === null && r.version === 0 || (!beforeIds.has(r.id) && (r.history ?? []).some((h) => h.text === 'Created on this device')));
  if (formStill) {
    await expect(d.page.locator('#record-form [role="alert"]')).toBeVisible();
    expect(made.length).toBe(0);
    qa.note('behaviour', 'blocked with a message');
  } else {
    expect(made.length).toBe(1);
    const rec = made[0];
    qa.note('behaviour', 'saved an empty record');
    qa.note('fields', rec.fields);
    await d.waitSynced();
    const s = await serverRecord(rec.id);
    expect(s).toBeTruthy();
    await expect(d.row(rec.id).locator('.row-title')).toHaveText('Soil sample');
    await expect(d.row(rec.id).locator('.row-meta')).toHaveText('No readings');
    qa.finding('No required fields: a record with no title, no reading, no notes, no photo and no GPS point is saved and synced as "Soil sample / No readings".');
    await d.shot('empty-record-in-list');
  }
});

test('B05 [P2] non-numeric pH is refused or flagged', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  await d.go('#/new');
  await d.page.waitForSelector('#record-form');
  await d.page.fill('[data-field="title"]', uniq('B05 text in pH'));
  await d.page.fill('#record-form input[data-field="ph"]', 'abc');
  await d.page.fill('#record-form input[data-field="moisture"]', 'wet');
  const before = new Set((await d.idb(['records'])).records.map((r) => r.id));
  await d.page.click('#save-record');
  await d.page.waitForTimeout(1500);
  const saved = (await d.idb(['records'])).records.find((r) => !before.has(r.id));
  await d.shot('after-save');
  if (saved) {
    await d.waitSynced();
    const s = await serverRecord(saved.id);
    qa.note('local', saved.fields);
    qa.note('server', s?.fields);
    await d.go(`#/record/${saved.id}`);
    await d.shot('detail-with-text-ph');
    expect(typeof saved.fields.ph === 'number' || saved.fields.ph === null,
      `pH "abc" was saved as ${JSON.stringify(saved.fields.ph)} and synced as ${JSON.stringify(s?.fields.ph)}`).toBe(true);
  } else {
    await expect(d.page.locator('#record-form [role="alert"]')).toBeVisible();
  }
});

test('B06 [P2] negative and out-of-range pH is refused or flagged', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  const accepted = {};
  for (const value of ['-3', '99', '1e9']) {
    await d.go('#/new');
    await d.page.waitForSelector('#record-form');
    await d.page.fill('[data-field="title"]', uniq(`B06 pH ${value}`));
    await d.page.fill('#record-form input[data-field="ph"]', value);
    const before = new Set((await d.idb(['records'])).records.map((r) => r.id));
    await d.page.click('#save-record');
    await d.page.waitForTimeout(1200);
    const saved = (await d.idb(['records'])).records.find((r) => !before.has(r.id));
    if (saved) accepted[value] = saved.fields.ph;
    else await d.page.click('a.back');
  }
  await d.waitSynced();
  await d.go('#/records');
  await d.shot('list-with-impossible-ph');
  qa.note('acceptedWithoutWarning', accepted);
  expect(accepted, 'impossible pH values were saved with no warning').toEqual({});
});

test('B07 [P1] very long notes: limit enforced, value syncs intact', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  await d.go('#/new');
  await d.page.waitForSelector('#record-form');
  const title = uniq('B07 long notes');
  await d.page.fill('[data-field="title"]', title);
  const notes = d.page.locator('textarea[data-field="notes"]');
  await notes.click();
  const chunk = 'Lorem ipsum dolor sit amet, soil is dark and damp here. ';
  const long = chunk.repeat(90).slice(0, 5000); // pasted in one go, like from the clipboard
  await d.page.keyboard.insertText(long);
  const typed = await notes.inputValue();
  qa.note('lengthAfterPaste5000', typed.length);
  expect(typed.length).toBe(2000);
  expect(typed).toBe(long.slice(0, 2000));
  await expect(d.page.locator('#gps-box')).toHaveAttribute('data-gps', 'fixed');
  await d.page.click('#save-record');
  await d.page.waitForFunction(() => !document.querySelector('#record-form'));
  const rec = (await d.idb(['records'])).records.find((r) => r.fields.title === title);
  expect(rec.fields.notes).toBe(long.slice(0, 2000));
  await d.waitSynced();
  expect((await serverRecord(rec.id)).fields.notes).toBe(long.slice(0, 2000));
  await d.go(`#/record/${rec.id}`);
  await expect(d.page.locator('p[data-field="notes"]')).toHaveText(long.slice(0, 2000));
  const overflow = await d.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow, 'no horizontal scroll with long notes').toBe(false);
});

test('B16 [P2] a long unbroken word in the notes wraps instead of being cut off', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  const id = await d.createRecord({ title: uniq('B16 unbroken'), fields: { ph: 6 }, notes: 'W'.repeat(300) });
  await d.go(`#/record/${id}`);
  await d.shot('unbroken-word');
  const wide = await d.page.evaluate(() => {
    const p = document.querySelector('p[data-field="notes"]');
    return { doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, hiddenPx: p.scrollWidth - p.clientWidth, viewport: innerWidth };
  });
  qa.note('unbrokenWord', wide);
  await d.waitSynced();
  expect(wide.doc, 'page does not scroll sideways').toBeLessThanOrEqual(0);
  expect(wide.hiddenPx, 'pixels of the notes text that are cut off and cannot be read').toBeLessThanOrEqual(1);
});

test('B08 [P1] unicode, emoji and RTL text round-trip exactly', async ({ qa }) => {
  const a = await qa.device('deviceA', { user: 'a' });
  const b = await qa.device('deviceB', { user: 'b' });
  await a.open();
  await b.open();
  const title = `B08 مٹی کا نمونہ 😀 ${Date.now().toString(36)}`;
  const notes = 'اردو: مٹی نم ہے۔ عربى: تربة — 中文 土壤 — é ñ ü — 👨‍👩‍👧‍👦 🇵🇰 — "double" \'single\' \\back\\slash & <angle> %25 ‏‎ end';
  const id = await a.createRecord({ title, type: 'wildlife', fields: { species: 'تلور / Houbara 🐦', count: 2 }, notes });
  await a.waitSynced();
  const local = await a.localRecord(id);
  const s = await serverRecord(id);
  for (const src of [local.fields, s.fields]) {
    expect(src.title).toBe(title);
    expect(src.notes).toBe(notes);
    expect(src.species).toBe('تلور / Houbara 🐦');
  }
  await b.syncNow();
  const onB = await b.localRecord(id);
  expect(onB.fields.notes).toBe(notes);
  expect(onB.fields.title).toBe(title);
  for (const d of [a, b]) {
    await d.go(`#/record/${id}`);
    expect(await d.page.locator('p[data-field="notes"]').textContent()).toBe(notes);
    expect(await d.page.locator('#record-title').textContent()).toBe(title);
    await expect(d.page.locator('.reading[data-field="species"]')).toHaveText('تلور / Houbara 🐦');
    await d.shot(`${d.name}-unicode-detail`);
  }
  // and back into the edit form
  await b.go(`#/edit/${id}`);
  expect(await b.page.locator('textarea[data-field="notes"]').inputValue()).toBe(notes);
  expect(await b.page.locator('input[data-field="title"]').inputValue()).toBe(title);
  const dir = await b.page.evaluate(() => getComputedStyle(document.querySelector('textarea[data-field="notes"]')).direction + '/' + (document.querySelector('textarea[data-field="notes"]').getAttribute('dir') ?? 'no dir attr'));
  qa.note('notesDirection', dir);
  if (!dir.includes('auto')) qa.finding('Text inputs and the notes paragraph have no dir="auto", so Urdu/Arabic notes are laid out left-aligned in an LTR box (readable, but punctuation and mixed text order look wrong).');
});

test('B09 [P0] HTML and script in title and notes are shown as text (XSS)', async ({ qa }) => {
  const a = await qa.device('deviceA', { user: 'a' });
  const b = await qa.device('deviceB', { user: 'b' });
  const dialogs = [];
  for (const d of [a, b]) d.page.on('dialog', async (dlg) => { dialogs.push(dlg.message()); await dlg.dismiss(); });
  await a.open();
  await b.open();
  const title = `<img src=x onerror=window.__xss=1>${Date.now().toString(36)}`;
  const notes = '<script>window.__xss=1</script><svg onload=window.__xss=1></svg><a href="javascript:window.__xss=1">x</a>"\'><b id="xss-b">bold</b><iframe srcdoc="<script>parent.__xss=1</script>"></iframe></textarea><img src=x onerror=alert(1)>';
  const species = '"><img src=x onerror=window.__xss=1>';
  const id = await a.createRecord({ title, type: 'wildlife', fields: { species, count: 1 }, notes });
  await a.waitSynced();
  await b.syncNow();
  const check = async (d, where) => {
    const r = await d.page.evaluate(() => ({
      xss: window.__xss ?? null,
      injected: document.querySelectorAll('#app img[src="x"], #app script, #app iframe, #xss-b, #app svg[onload], #sheet-root img').length,
    }));
    expect(r, `${d.name} ${where}`).toEqual({ xss: null, injected: 0 });
  };
  for (const d of [a, b]) {
    await d.go('#/records');
    await expect(d.row(id).locator('.row-title')).toHaveText(title);
    await check(d, 'list');
    await d.go(`#/record/${id}`);
    expect(await d.page.locator('p[data-field="notes"]').textContent()).toBe(notes);
    expect(await d.page.locator('#record-title').textContent()).toBe(title);
    await expect(d.page.locator('.reading[data-field="species"]')).toHaveText(species);
    await check(d, 'detail');
    await d.shot(`${d.name}-xss-detail`);
    await d.go(`#/edit/${id}`);
    await d.page.waitForSelector('#record-form');
    expect(await d.page.locator('input[data-field="title"]').inputValue()).toBe(title);
    expect(await d.page.locator('textarea[data-field="notes"]').inputValue()).toBe(notes);
    expect(await d.page.locator('input[data-field="species"]').inputValue()).toBe(species);
    await check(d, 'edit form');
    await d.page.click('a.back');
    await d.go(`#/record/${id}`);
    await d.page.click('#delete-record');
    await check(d, 'delete sheet');
    await d.page.click('#sheet-root [data-act="keep"]');
    await d.go('#/sync');
    await check(d, 'sync');
  }
  expect(dialogs).toEqual([]);
  expect((await serverRecord(id)).fields.notes).toBe(notes);
});

test('B10 [P2] a region with 200 records stays fast', async ({ qa }) => {
  const lead = await api('a');
  const tag = `B10-${Date.now().toString(36)}`;
  const dev = randomUUID();
  const types = ['soil', 'water', 'wildlife'];
  try {
    for (let i = 0; i < 200; i += 50) {
      const ops = Array.from({ length: 50 }, (_, k) => {
        const n = i + k;
        return { op_id: randomUUID(), table: 'records', kind: 'upsert', row_id: randomUUID(), region_id: state.regions.other, type: types[n % 3], base_version: 0,
          changed: { title: `${tag} record ${n}`, ph: 5 + (n % 30) / 10, notes: `performance row ${n}` } };
      });
      const res = await lead.push(dev, ops);
      expect(res.status).toBe(200);
      expect(res.json.results.every((r) => r.status === 'applied')).toBe(true);
    }
    const d = await qa.device('deviceA', { user: 'a' });
    const t0 = Date.now();
    await d.open();
    qa.note('openAndFirstSyncMs', Date.now() - t0);
    expect((await d.idb(['records'])).records.filter((r) => r.regionId === state.regions.other).length).toBeGreaterThanOrEqual(200);
    await d.go('#/regions');
    const timings = await d.page.evaluate(async (regionId) => {
      const wait = (fn) => new Promise((res) => { const t = performance.now(); const tick = () => (fn() ? res(performance.now() - t) : requestAnimationFrame(tick)); tick(); });
      const out = {};
      document.querySelector(`[data-region="${regionId}"]`).click();
      out.listPaintMs = await wait(() => document.querySelectorAll('#record-list li').length >= 200);
      for (const f of ['water', 'all', 'soil', 'all']) {
        document.querySelector(`[data-filter="${f}"]`).click();
        out[`tab_${f}_${Object.keys(out).length}`] = await wait(() => document.querySelector(`[data-filter="${f}"]`)?.getAttribute('aria-selected') === 'true');
      }
      return out;
    }, state.regions.other);
    qa.note('timings', timings);
    await d.shot('200-records');
    const rows = await d.page.locator('#record-list li').count();
    expect(rows).toBeGreaterThanOrEqual(200);
    expect(timings.listPaintMs, 'list paint').toBeLessThan(2000);
    for (const [k, v] of Object.entries(timings)) if (k.startsWith('tab_')) expect(v, k).toBeLessThan(1000);
    // saving one more record must still feel instant
    await d.go('#/new');
    await d.page.waitForSelector('#record-form');
    await d.page.fill('[data-field="title"]', `${tag} saved on top`);
    await expect(d.page.locator('#gps-box')).toHaveAttribute('data-gps', 'fixed');
    const saveMs = await d.page.evaluate(async () => {
      const t = performance.now();
      document.querySelector('#save-record').click();
      await new Promise((res) => { const tick = () => (!document.querySelector('#record-form') ? res() : requestAnimationFrame(tick)); tick(); });
      return performance.now() - t;
    });
    qa.note('saveMs', saveMs);
    expect(saveMs, 'save feels instant').toBeLessThan(1000);
    await d.waitSynced();
    // scrolling the list
    await d.go('#/records');
    const scroll = await d.page.evaluate(async () => {
      const el = document.querySelector('#pane-detail .scroll');
      const t = performance.now();
      for (let y = 0; y < el.scrollHeight; y += 600) { el.scrollTop = y; await new Promise((r) => { requestAnimationFrame(r); }); }
      return { ms: performance.now() - t, height: el.scrollHeight };
    });
    qa.note('scroll', scroll);
  } finally {
    // QA rows only: remove the 200 performance rows so later cases stay small.
    await sql("delete from public.gps_logs where region_id = $1 and record_id in (select id from public.records where region_id = $1 and fields->>'title' like $2)", [state.regions.other, `${tag}%`]);
    await sql("delete from public.records where region_id = $1 and fields->>'title' like $2", [state.regions.other, `${tag}%`]);
  }
});

test('B11 [P2] filter tabs show exactly the right records', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  await createAll(d, 'B11');
  await d.waitSynced();
  await d.go('#/records');
  const local = (await d.idb(['records'])).records.filter((r) => r.regionId === state.regions.main && !r.deleted);
  const counts = {};
  for (const tab of ['soil', 'water', 'wildlife', 'all']) {
    await d.page.click(`[data-filter="${tab}"]`);
    await expect(d.page.locator(`[data-filter="${tab}"]`)).toHaveAttribute('aria-selected', 'true');
    const labels = await d.page.locator('#record-list .row-top .label:first-child').allTextContents();
    counts[tab] = labels.length;
    const want = local.filter((r) => tab === 'all' || r.type === tab).length;
    expect(labels.length, `${tab} count`).toBe(want);
    if (tab !== 'all') expect(labels.every((l) => l.startsWith(PREFIX[tab] + '-')), `${tab} rows only: ${labels.join(',')}`).toBe(true);
    await d.shot(`tab-${tab}`);
  }
  qa.note('counts', counts);
  // the header count is the region total, not the filtered count
  await d.page.click('[data-filter="water"]');
  await expect(d.page.locator('#region-link')).toContainText(`${counts.all} records`);
  // empty state of a tab
  await d.pickRegion('other');
  const title = uniq('B11 only soil');
  await d.createRecord({ title, fields: { ph: 6 } });
  await d.go('#/records');
  await d.page.click('[data-filter="water"]');
  await expect(d.page.locator('#pane-detail')).toContainText(`No water records in ${state.names.other}.`);
  await d.page.click('[data-filter="all"]');
  await d.waitSynced();
});

test('B12 [P1] an emoji at the length limit does not break the record or the sync', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  await d.go('#/new');
  await d.page.waitForSelector('#record-form');
  const stamp = Date.now().toString(36);
  const titleInput = d.page.locator('input[data-field="title"]');
  await titleInput.click();
  await d.page.keyboard.insertText(`B12 ${stamp} `.padEnd(79, 'x'));
  await d.page.keyboard.insertText('😀');            // would be characters 80 and 81
  const notes = d.page.locator('textarea[data-field="notes"]');
  await notes.click();
  await d.page.keyboard.insertText('n'.repeat(1999));
  await d.page.keyboard.insertText('🌱 tail');
  const values = { title: await titleInput.inputValue(), notes: await notes.inputValue() };
  const wellFormed = { title: values.title.isWellFormed(), notes: values.notes.isWellFormed() };
  qa.note('lengths', { title: values.title.length, notes: values.notes.length });
  qa.note('wellFormed', wellFormed);
  await expect(d.page.locator('#gps-box')).toHaveAttribute('data-gps', 'fixed');
  const before = new Set((await d.idb(['records'])).records.map((r) => r.id));
  await d.page.click('#save-record');
  await d.page.waitForFunction(() => !document.querySelector('#record-form'));
  const rec = (await d.idb(['records'])).records.find((r) => !before.has(r.id));
  // a second, normal record made afterwards must not get stuck behind it
  const id2 = await d.createRecord({ title: uniq('B12 after'), fields: { ph: 6.2 } });
  const synced = await waitSql('select id from public.records where id = any($1::uuid[])', [[rec.id, id2]], (r) => r.length === 2, 40_000).catch(() => null);
  await d.go('#/sync');
  await d.shot('sync-screen');
  qa.note('outboxAfter40s', (await d.outbox()).map((o) => `${o.table}/${o.kind}/${o.status}`));
  expect(wellFormed, 'no half emoji (lone surrogate) left in the field').toEqual({ title: true, notes: true });
  expect(synced, 'both records reached the server').toBeTruthy();
  expect((await serverRecord(rec.id)).fields.title).toBe(rec.fields.title);
});

test('B13 [P3] decimal comma is read as a number', async ({ qa }) => {
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  const id = await d.createRecord({ title: uniq('B13 comma'), fields: { ph: '6,5', moisture: ' 40 ', depth: '015' } });
  const local = await d.localRecord(id);
  qa.note('local', local.fields);
  expect(local.fields.ph).toBe(6.5);
  expect(local.fields.moisture).toBe(40);
  expect(local.fields.depth).toBe(15);
  await d.waitSynced();
  expect((await serverRecord(id)).fields.ph).toBe(6.5);
});

test('B14 [P1] a view-only region cannot be changed from the UI', async ({ qa }) => {
  // one record in the view-only region, made by the data lead through the public API
  const lead = await api('lead');
  const rid = randomUUID();
  const title = uniq('B14 lead record');
  const res = await lead.push(randomUUID(), [{ op_id: randomUUID(), table: 'records', kind: 'upsert', row_id: rid, region_id: state.regions.view, type: 'soil', base_version: 0, changed: { title, ph: 6 } }]);
  expect(res.json.results[0].status).toBe('applied');
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  await d.pickRegion('view');
  await expect(d.page.locator('#new-record')).toHaveCount(0);
  await expect(d.page.locator('#pane-detail')).toContainText('is view only');
  await d.shot('view-only-list');
  await d.go(`#/record/${rid}`);
  await expect(d.page.locator('#record-title')).toHaveText(title);
  await expect(d.page.locator('#edit-record')).toHaveCount(0);
  await expect(d.page.locator('#delete-record')).toHaveCount(0);
  for (const hash of ['#/new', `#/edit/${rid}`]) {
    await d.go(hash);
    await d.page.waitForSelector('#record-form');
    await expect(d.page.locator('#save-record')).toBeDisabled();
    await d.page.fill('[data-field="title"]', 'B14 should never be saved');
    await d.page.locator('#record-form').evaluate((f) => f.requestSubmit());
    await d.page.waitForTimeout(600);
    await d.page.click('a.back');
  }
  await d.go('#/tracks');
  await expect(d.page.locator('#start-track')).toHaveCount(0);
  expect(await d.outbox()).toHaveLength(0);
  const localView = (await d.idb(['records'])).records.filter((r) => r.regionId === state.regions.view);
  const serverView = await sql('select id from public.records where region_id = $1', [state.regions.view]);
  expect(localView.map((r) => r.id).sort(), 'the device holds exactly the server rows of the view-only region').toEqual(serverView.map((r) => r.id).sort());
  expect(localView.filter((r) => r.fields.title === 'B14 should never be saved')).toEqual([]);
  expect((await serverRecord(rid)).fields.title).toBe(title);
  expect((await serverRecord(rid)).version).toBe(1);
});

test('B15 [P1] two offline devices that pick the same label number both keep their record', async ({ qa }) => {
  const a = await qa.device('deviceA', { user: 'a' });
  const b = await qa.device('deviceB', { user: 'b' });
  await a.open();
  await b.open();
  await a.syncNow();
  await b.syncNow();
  await a.offline();
  await b.offline();
  const idA = await a.createRecord({ title: uniq('B15 from A'), type: 'water', fields: { ph: 7.1 } });
  const idB = await b.createRecord({ title: uniq('B15 from B'), type: 'water', fields: { ph: 7.9 } });
  const seqA = (await a.localRecord(idA)).seq;
  const seqB = (await b.localRecord(idB)).seq;
  qa.note('proposed', { seqA, seqB });
  expect(seqA, 'both devices proposed the same number').toBe(seqB);
  await a.online();
  await a.waitSynced();
  await b.online();
  await b.waitSynced();
  await a.syncNow();
  const sA = await serverRecord(idA);
  const sB = await serverRecord(idB);
  qa.note('server', { seqA: sA.seq, seqB: sB.seq });
  expect(sA.seq).toBe(seqA);
  expect(sB.seq).not.toBe(sA.seq);
  for (const d of [a, b]) {
    expect((await d.localRecord(idA)).seq).toBe(sA.seq);
    expect((await d.localRecord(idB)).seq).toBe(sB.seq);
    await d.go('#/records');
    await d.page.click('[data-filter="all"]');
    await expect(d.row(idA).locator('.row-top .label').first()).toHaveText(`WTR-${String(sA.seq).padStart(3, '0')}`);
    await expect(d.row(idB).locator('.row-top .label').first()).toHaveText(`WTR-${String(sB.seq).padStart(3, '0')}`);
  }
  expect(sA.fields.ph).toBe(7.1);
  expect(sB.fields.ph).toBe(7.9);
});
