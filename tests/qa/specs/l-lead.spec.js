// L. Data lead console and CSV export
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, state, sql, serverRecord, serverConflicts, uniq, photo } from '../lib/harness.js';

const BOM = new RegExp('^' + String.fromCharCode(0xfeff));

// Strict RFC 4180 parser: quoted cells, doubled quotes, commas and line breaks inside quotes.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function leadDevice(qa) {
  const lead = await qa.device('lead', { user: 'lead', viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  await lead.open();
  await lead.page.waitForFunction(() => document.body.dataset.route === 'console', null, { timeout: 30_000 });
  await lead.page.click(`aside [data-region="${state.regions.main}"]`);
  return lead;
}

async function exportCsv(lead, name) {
  const dl = lead.page.waitForEvent('download');
  await lead.page.click('#export-csv');
  const download = await dl;
  const file = resolve(lead.qa.dir, name);
  await download.saveAs(file);
  const buf = readFileSync(file);
  return { buf, text: buf.toString('utf8'), filename: download.suggestedFilename(), file };
}

test('L01 [P1] the console shows the merged dataset of the region', async ({ qa }) => {
  const a = await qa.device('deviceA', { user: 'a' });
  const b = await qa.device('deviceB', { user: 'b' });
  await a.open();
  await b.open();
  const title = uniq('L01 merged');
  const id = await a.createRecord({ title, fields: { ph: 6.0, moisture: 20 }, notes: 'by A', photos: [photo(1)] });
  await a.waitSynced();
  await b.syncNow();
  await b.editRecord(id, { moisture: 44 });
  await b.waitSynced();
  await a.editRecord(id, { ph: 6.7 });
  await a.waitSynced();
  const lead = await leadDevice(qa);
  await expect(lead.page.locator('h1.title')).toHaveText('Regional dataset');
  await expect(lead.page.locator('.eyebrow').first()).toContainText(state.names.main);
  const pgLive = await sql('select id, fields, version, updated_by from public.records where region_id = $1 and not deleted', [state.regions.main]);
  await expect(lead.page.locator('[data-card="records"]')).toHaveText(String(pgLive.length).padStart(2, '0'));
  const shownIds = await lead.page.locator('#dataset tbody tr[data-record-id]:not(.is-deleted)').evaluateAll((trs) => trs.map((t) => t.dataset.recordId));
  expect(shownIds.sort()).toEqual(pgLive.map((r) => r.id).sort());
  const row = lead.page.locator(`#dataset tr[data-record-id="${id}"]`);
  await expect(row.locator('.rec')).toHaveText(title);
  await expect(row.locator('.key')).toHaveText('pH 6.7');
  await expect(row.locator('.who')).toHaveText(state.users.a.name);
  await expect(row.locator('.status')).toHaveText('Merged');
  const local = await lead.localRecord(id);
  expect(local.fields).toMatchObject({ ph: 6.7, moisture: 44, notes: 'by A' });
  expect(local.version).toBe(3);
  const open = (await sql('select 1 from public.conflict_log where region_id = $1 and not resolved', [state.regions.main])).length;
  qa.note('postgres', { liveRecords: pgLive.length, openConflictRows: open });
  await expect(lead.page.locator('aside [data-section="researchers"] .count')).toHaveText('02');
  await lead.shot('console');
  // status bar and the Researchers view
  await expect(lead.page.locator('#sb-text')).toHaveText('Online / data lead');
  await lead.page.click('[data-section="researchers"]');
  await expect(lead.page.locator('.main table')).toContainText(state.users.a.name);
  await expect(lead.page.locator('.main table')).toContainText(state.users.b.name);
  await lead.shot('researchers');
  // Refresh brings in a change made after the console was opened
  await b.editRecord(id, { notes: 'L01 added later by B' });
  await b.waitSynced();
  await lead.page.click('[data-section="dataset"]');
  await lead.syncNow();
  await expect(row.locator('.who')).toHaveText(state.users.b.name);
  expect((await lead.localRecord(id)).fields.notes).toBe('L01 added later by B');
  // a researcher account never lands on the console
  await a.go('#/');
  await expect(a.page.locator('h1.title')).toHaveText('Observations');
});

test('L02 [P2] CSV export keeps commas, quotes, line breaks and unicode intact', async ({ qa }) => {
  const a = await qa.device('deviceA', { user: 'a' });
  await a.open();
  const title = `L02 "quoted", comma; semi ${Date.now().toString(36)}`;
  const notes = 'line one, with comma\nline two "quoted"\r\nline three; اردو مٹی 😀 — tab\there, trailing quote"';
  const species = 'Houbara, "تلور"';
  const id = await a.createRecord({ title, type: 'wildlife', fields: { species, count: 3 }, notes, photos: [photo(1), photo(2)] });
  await a.waitSynced();
  const lead = await leadDevice(qa);
  const csv = await exportCsv(lead, 'export.csv');
  qa.note('file', { filename: csv.filename, bytes: csv.buf.length });
  expect(csv.filename).toMatch(new RegExp(`^fieldsync-qa-${state.ts}-\\d{4}-\\d{2}-\\d{2}\\.csv$`));
  const rows = parseCsv(csv.text.replace(BOM, ''));
  const header = rows[0];
  expect(header).toEqual(['label', 'id', 'type', 'title', 'ph', 'moisture', 'temperature', 'depth', 'turbidity', 'oxygen', 'species', 'count', 'notes', 'lat', 'lng', 'accuracy_m', 'photos', 'observed_at', 'updated_at', 'last_edit_by', 'version', 'deleted']);
  expect(rows.every((r) => r.length === header.length), 'every line has the same number of cells').toBe(true);
  const col = (r, name) => r[header.indexOf(name)];
  const mine = rows.find((r) => col(r, 'id') === id);
  expect(mine, 'record is in the export').toBeTruthy();
  const s = await serverRecord(id);
  expect(col(mine, 'title')).toBe(title);
  expect(col(mine, 'notes')).toBe(s.fields.notes);
  expect(col(mine, 'species')).toBe(species);
  expect(col(mine, 'count')).toBe('3');
  expect(col(mine, 'type')).toBe('wildlife');
  expect(col(mine, 'label')).toBe(`WLD-${String(s.seq).padStart(3, '0')}`);
  expect(col(mine, 'photos')).toBe('2');
  expect(Number(col(mine, 'lat'))).toBeCloseTo(24.8607, 4);
  expect(Number(col(mine, 'lng'))).toBeCloseTo(67.0011, 4);
  expect(col(mine, 'last_edit_by')).toBe(state.users.a.name);
  expect(col(mine, 'version')).toBe('1');
  expect(new Date(col(mine, 'updated_at')).getTime()).toBe(new Date(s.updated_at).getTime());
  // the whole region is there
  const pg = await sql('select id from public.records where region_id = $1 and not deleted', [state.regions.main]);
  const exported = new Set(rows.slice(1).map((r) => col(r, 'id')));
  expect(pg.filter((r) => !exported.has(r.id))).toEqual([]);
  expect(rows.slice(1).every((r) => /^[0-9a-f-]{36}$/.test(col(r, 'id')))).toBe(true);
  qa.note('rows', { exported: rows.length - 1, livePostgres: pg.length, notesStoredAs: JSON.stringify(s.fields.notes) });
  if (s.fields.notes !== notes) qa.finding(`The notes box turns Windows line ends into plain ones before saving (expected for a textarea); stored value ${JSON.stringify(s.fields.notes).slice(0, 60)}...`);
});

test('L03 [P2] deleted records are left out of the CSV or clearly flagged', async ({ qa }) => {
  const a = await qa.device('deviceA', { user: 'a' });
  await a.open();
  const keep = await a.createRecord({ title: uniq('L03 kept'), fields: { ph: 6 } });
  const gone = await a.createRecord({ title: uniq('L03 deleted later'), fields: { ph: 6 } });
  await a.waitSynced();
  const lead = await leadDevice(qa);            // this console sees the record before it is deleted
  await expect(lead.page.locator(`#dataset tr[data-record-id="${gone}"]`)).toHaveCount(1);
  await a.deleteRecord(gone);
  await a.waitSynced();
  await lead.syncNow();
  const row = lead.page.locator(`#dataset tr[data-record-id="${gone}"]`);
  const inTable = await row.count();
  if (inTable) { await expect(row).toHaveClass(/is-deleted/); await expect(row.locator('.status')).toHaveText('Deleted'); }
  await lead.shot('console-after-delete');
  const parse = (csv) => { const rows = parseCsv(csv.text.replace(BOM, '')); const h = rows[0]; return Object.fromEntries(rows.slice(1).map((r) => [r[h.indexOf('id')], r[h.indexOf('deleted')]])); };
  const seenBefore = parse(await exportCsv(lead, 'export-console-that-saw-it.csv'));
  const fresh = await qa.device('lead-fresh', { user: 'lead', viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  await fresh.open();
  await fresh.page.click(`aside [data-region="${state.regions.main}"]`);
  const seenFresh = parse(await exportCsv(fresh, 'export-fresh-console.csv'));
  qa.note('deletedRecordInCsv', { consoleThatSawItBefore: seenBefore[gone] ?? 'absent', freshConsole: seenFresh[gone] ?? 'absent' });
  expect(seenBefore[keep]).toBe('no');
  expect(seenFresh[keep]).toBe('no');
  for (const v of [seenBefore[gone], seenFresh[gone]]) expect(v === undefined || v === 'yes', 'deleted row is absent or flagged yes').toBe(true);
  if ((seenBefore[gone] ?? 'absent') !== (seenFresh[gone] ?? 'absent')) {
    qa.finding(`The same region exports differently on two laptops: a console that saw the record before it was deleted lists it with deleted=yes (${Object.keys(seenBefore).length} rows), a newly signed-in console leaves it out (${Object.keys(seenFresh).length} rows). The CSV is built from the laptop's local copy, not from the server.`);
  }
});

test('L04 [P3] the CSV opens cleanly in a spreadsheet', async ({ qa }) => {
  const a = await qa.device('deviceA', { user: 'a' });
  await a.open();
  const id = await a.createRecord({ title: '=HYPERLINK("http://example.org","L04 click")', fields: { ph: 6 }, notes: '+1+1 @SUM(A1) -2 اردو' });
  await a.waitSynced();
  const lead = await leadDevice(qa);
  const csv = await exportCsv(lead, 'export.csv');
  const bom = csv.buf[0] === 0xef && csv.buf[1] === 0xbb && csv.buf[2] === 0xbf;
  const rows = parseCsv(csv.text.replace(BOM, ''));
  const h = rows[0];
  const mine = rows.find((r) => r[h.indexOf('id')] === id);
  const title = mine[h.indexOf('title')];
  const notes = mine[h.indexOf('notes')];
  qa.note('csv', { utf8Bom: bom, lineEnds: csv.text.includes('\r\n') ? 'CRLF' : 'LF', titleCell: title, notesCell: notes });
  const problems = [];
  if (!bom) problems.push('no UTF-8 byte-order mark, so Excel on Windows opens Urdu, emoji and accented text as garbage unless imported by hand');
  if (/^[=+\-@]/.test(title) || /^[=+\-@]/.test(notes)) problems.push('cells that start with = + - @ are written as they are, so a spreadsheet runs them as formulas (CSV injection)');
  expect(problems, problems.join('; ')).toEqual([]);
});

test('L05 [P2] Mark reviewed and Restore from the console reach the server', async ({ qa }) => {
  const a = await qa.device('deviceA', { user: 'a' });
  const b = await qa.device('deviceB', { user: 'b' });
  await a.open();
  await b.open();
  const id = await a.createRecord({ title: uniq('L05 conflict'), fields: { ph: 6 } });
  const id2 = await a.createRecord({ title: uniq('L05 deleted'), fields: { ph: 6 } });
  await a.waitSynced();
  await b.syncNow();
  await a.offline(); await b.offline();
  await a.editRecord(id, { ph: 6.1 });
  await b.editRecord(id, { ph: 6.2 });
  await b.editRecord(id2, { notes: 'L05 edit lost to a delete' });
  await a.deleteRecord(id2);
  await a.context.setOffline(false); await a.waitSynced();
  await b.context.setOffline(false); await b.waitSynced();
  const same = (await serverConflicts(id))[0];
  expect((await serverConflicts(id2))[0].kind).toBe('edit_vs_delete');
  const lead = await leadDevice(qa);
  const card = lead.page.locator('[data-card="conflicts"]');
  const before = Number(await card.textContent());
  await expect(lead.page.locator(`#dataset tr[data-record-id="${id}"] .status`)).toHaveText('Conflict');
  await lead.shot('open-conflicts');
  await lead.page.locator(`#open-conflicts-panel [data-resolve="${same.id}"]`).click();
  await expect(async () => { expect((await serverConflicts(id))[0].resolved).toBe(true); }).toPass({ timeout: 30_000 });
  expect((await serverConflicts(id))[0].resolved_by).toBe(state.users.lead.id);
  await expect(card).toHaveText(String(before - 1).padStart(2, '0'));
  await expect(lead.page.locator(`#dataset tr[data-record-id="${id}"] .status`)).toHaveText('Merged');
  // restore the record that lost to a delete
  await lead.page.locator(`#open-conflicts-panel [data-restore="${id2}"]`).click();
  await expect(async () => { expect((await serverRecord(id2)).deleted).toBe(false); }).toPass({ timeout: 30_000 });
  expect((await serverRecord(id2)).fields.notes).toBe('L05 edit lost to a delete');
  await expect(card).toHaveText(String(before - 2).padStart(2, '0'), { timeout: 30_000 });
  await lead.shot('after-review');
  // the researchers see the result
  await a.syncNow();
  await a.go('#/records');
  await expect(a.row(id2)).toHaveCount(1);
  await expect(a.row(id)).toHaveAttribute('data-status', 'synced');
});
