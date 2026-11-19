// G. Conflicts
import { test, expect, state, sql, serverRecord, serverConflicts, uniq } from '../lib/harness.js';

const DAY = 24 * 3600 * 1000;

// One record that both devices have at version 1.
async function shared(a, others, label, fields = { ph: 6.0 }, notes = 'base notes') {
  const id = await a.createRecord({ title: uniq(label), fields, notes });
  await a.waitSynced();
  for (const d of others) { await d.syncNow(); expect((await d.localRecord(id))?.version).toBe(1); }
  return id;
}

async function pair(qa, optsB = {}) {
  const a = await qa.device('deviceA', { user: 'a' });
  const b = await qa.device('deviceB', { user: 'b', ...optsB });
  await a.open();
  await b.open();
  return { a, b };
}

// Go online and wait until this device has nothing left to send.
async function syncUp(d) {
  await d.context.setOffline(false);
  await d.waitSynced();
}

test('G01 [P0] different fields edited on two devices are both kept', async ({ qa }) => {
  const { a, b } = await pair(qa);
  const id = await shared(a, [b], 'G01 different fields');
  await a.offline();
  await b.offline();
  await a.editRecord(id, { ph: 6.8 });
  await b.editRecord(id, { notes: 'G01 notes from B' });
  await syncUp(a);
  await syncUp(b);
  await a.syncNow();
  const s = await serverRecord(id);
  expect(s.fields.ph).toBe(6.8);
  expect(s.fields.notes).toBe('G01 notes from B');
  expect(s.version).toBe(3);
  expect(await serverConflicts(id)).toHaveLength(0);
  for (const d of [a, b]) {
    const l = await d.localRecord(id);
    expect(l.fields.ph, d.name).toBe(6.8);
    expect(l.fields.notes, d.name).toBe('G01 notes from B');
    expect(l.version).toBe(3);
    await d.go(`#/record/${id}`);
    await expect(d.page.locator('.reading[data-field="ph"]')).toHaveText('6.8');
    await expect(d.page.locator('p[data-field="notes"]')).toHaveText('G01 notes from B');
    await expect(d.page.locator('#record-status')).toHaveText('Synced');
    await d.shot(`${d.name}-merged`);
  }
});

test('G02 [P0] same field: the edit the server receives later wins, the other goes to the conflict log', async ({ qa }) => {
  const { a, b } = await pair(qa);
  const id = await shared(a, [b], 'G02 same field');
  await a.offline();
  await b.offline();
  await b.editRecord(id, { ph: 6.9 });        // B edits first by the clock...
  await a.editRecord(id, { ph: 6.1 });
  await syncUp(a);                             // ...but A reaches the server first
  await syncUp(b);
  await a.syncNow();
  const s = await serverRecord(id);
  expect(s.fields.ph).toBe(6.9);
  expect(s.fields.notes).toBe('base notes');
  const log = await serverConflicts(id);
  expect(log).toHaveLength(1);
  expect(log[0]).toMatchObject({ kind: 'same_field', field: 'ph', lost_value: 6.1, kept_value: 6.9, lost_by: state.users.a.id, kept_by: state.users.b.id, resolved: false, region_id: state.regions.main });
  qa.note('conflict', log[0]);
  for (const d of [a, b]) {
    expect((await d.localRecord(id)).fields.ph, d.name).toBe(6.9);
    await d.go('#/records');
    await expect(d.row(id)).toHaveAttribute('data-status', 'conflict');
    await expect(d.row(id).locator('.status')).toHaveText('Conflict');
    await d.go(`#/record/${id}`);
    await expect(d.page.locator('.reading[data-field="ph"]')).toHaveText('6.9');
    await expect(d.page.locator('.notice.warn')).toContainText('Conflict on pH');
    await expect(d.page.locator('.notice.warn')).toContainText('6.1');
    await d.shot(`${d.name}-record-conflict`);
    await d.go('#/conflicts');
    const row = d.page.locator(`[data-conflict="${log[0].id}"]`);
    await expect(row.locator('[data-kept]')).toHaveText('6.9');
    await expect(row.locator('[data-lost]')).toHaveText('6.1');
    await d.shot(`${d.name}-conflict-log`);
  }
  // the loser is told it was their value
  await a.go('#/conflicts');
  await expect(a.page.locator(`[data-conflict="${log[0].id}"] .lost .label`)).toContainText(/this device|you/i);
});

test('G03 [P0] a wrong device clock does not change the winner', async ({ qa }) => {
  // B's clock is a day behind, C's is a day ahead. Only the order of arrival may count.
  const a = await qa.device('deviceA', { user: 'a' });
  const b = await qa.device('deviceB-clock-minus-1d', { user: 'b', clockOffsetMs: -DAY });
  await a.open();
  await b.open();
  const skew = await b.page.evaluate(() => Date.now());
  expect(Math.abs(Date.now() - DAY - skew)).toBeLessThan(60_000);
  const id = await shared(a, [b], 'G03 clock skew');
  await a.offline();
  await b.offline();
  await a.editRecord(id, { ph: 6.1 });
  await b.editRecord(id, { ph: 5.5 });        // device time: "yesterday"
  await syncUp(a);
  await syncUp(b);                             // arrives later -> must win
  let s = await serverRecord(id);
  expect(s.fields.ph, 'the later arrival wins although its clock says yesterday').toBe(5.5);
  let log = await serverConflicts(id);
  expect(log).toHaveLength(1);
  expect(log[0]).toMatchObject({ lost_value: 6.1, kept_value: 5.5 });
  expect(Math.abs(new Date(log[0].at).getTime() - Date.now()), 'conflict stamped with server time').toBeLessThan(5 * 60_000);
  expect(Math.abs(new Date(s.updated_at).getTime() - Date.now())).toBeLessThan(5 * 60_000);
  qa.note('minus1d', { localUpdatedAtBeforeSync: 'device time', serverUpdatedAt: s.updated_at });

  // a clock a day AHEAD pushes first; the normal device arrives later and must win
  const c = await qa.device('deviceC-clock-plus-1d', { user: 'b', clockOffsetMs: DAY });
  await c.open();
  await a.syncNow();
  await c.offline();
  await a.offline();
  await c.editRecord(id, { ph: 7.7 });        // device time: "tomorrow"
  await a.editRecord(id, { ph: 4.4 });
  await syncUp(c);
  await syncUp(a);
  s = await serverRecord(id);
  expect(s.fields.ph, 'the later arrival wins although the other clock says tomorrow').toBe(4.4);
  log = await serverConflicts(id);
  expect(log).toHaveLength(2);
  expect(log[1]).toMatchObject({ lost_value: 7.7, kept_value: 4.4, lost_by: state.users.b.id, kept_by: state.users.a.id });
  await c.syncNow();
  expect((await c.localRecord(id)).fields.ph).toBe(4.4);
  await c.go(`#/record/${id}`);
  await c.shot('deviceC-after');
  // a record created on the skewed device carries the wrong observation time
  const made = await b.createRecord({ title: uniq('G03 made with wrong clock'), fields: { ph: 6 } });
  await b.waitSynced();
  const off = Date.now() - new Date((await serverRecord(made)).observed_at).getTime();
  qa.note('observedAtOffsetHours', Math.round(off / 3600000));
  if (Math.abs(off) > 3600_000) qa.finding(`observed_at is taken from the device clock and trusted by the server: a record made on the device with the wrong clock is stored as observed ${Math.round(off / 3600000)} h in the past, and the list is sorted by it. The merge is not affected.`);
});

test('G04 [P0] edit vs delete: the delete wins, the edit is logged and can be restored', async ({ qa }) => {
  const { a, b } = await pair(qa);
  const id = await shared(a, [b], 'G04 edit vs delete');
  await b.offline();
  await a.deleteRecord(id);
  await a.waitSynced();
  await b.editRecord(id, { notes: 'G04 edit made on B while A deleted', ph: 7.4 });
  await syncUp(b);
  let s = await serverRecord(id);
  expect(s.deleted, 'the delete wins').toBe(true);
  expect(s.fields.notes).toBe('base notes');
  const log = await serverConflicts(id);
  expect(log.map((c) => c.kind)).toEqual(['edit_vs_delete', 'edit_vs_delete']);
  expect(Object.fromEntries(log.map((c) => [c.field, c.lost_value]))).toEqual({ notes: 'G04 edit made on B while A deleted', ph: 7.4 });
  expect(log.every((c) => c.lost_by === state.users.b.id)).toBe(true);
  // B: the record is gone from the list and the edit is in the conflict log
  await b.go('#/records');
  await expect(b.row(id)).toHaveCount(0);
  expect((await b.localRecord(id)).deleted).toBe(1);
  await b.go('#/conflicts');
  const entry = b.page.locator(`[data-kind="edit_vs_delete"][data-record-id="${id}"]`);
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText('The delete wins');
  await expect(entry).toContainText('G04 edit made on B while A deleted');
  await expect(entry).toContainText('7.4');
  await b.shot('deviceB-conflict-log');
  // restore
  await entry.locator('[data-restore]').click();
  await expect(entry).toContainText('Restored.');
  await b.waitSynced();
  s = await serverRecord(id);
  expect(s.deleted).toBe(false);
  expect(s.fields.notes).toBe('G04 edit made on B while A deleted');
  expect(s.fields.ph).toBe(7.4);
  expect((await serverConflicts(id)).every((c) => c.resolved)).toBe(true);
  await a.syncNow();
  await a.go('#/records');
  await expect(a.row(id)).toHaveCount(1);
  expect((await a.localRecord(id)).fields.notes).toBe('G04 edit made on B while A deleted');
  await b.go('#/records');
  await expect(b.row(id)).toHaveCount(1);
});

test('G05 [P1] delete vs delete', async ({ qa }) => {
  const { a, b } = await pair(qa);
  const id = await shared(a, [b], 'G05 delete vs delete');
  await a.offline();
  await b.offline();
  await a.deleteRecord(id);
  await b.deleteRecord(id);
  await syncUp(a);
  await syncUp(b);
  await a.syncNow();
  const s = await serverRecord(id);
  expect(s.deleted).toBe(true);
  expect(s.version).toBe(2);
  expect(await serverConflicts(id)).toHaveLength(0);
  for (const d of [a, b]) {
    expect(await d.outbox(), d.name).toEqual([]);
    expect((await d.localRecord(id)).deleted).toBe(1);
    await d.go('#/records');
    await expect(d.row(id)).toHaveCount(0);
    await expect(d.page.locator('#sb-text')).toHaveText('Online / all synced');
  }
});

test('G06 [P0] three devices change one field: last arrival wins, two values in the log', async ({ qa }) => {
  const { a, b } = await pair(qa);
  const c = await qa.device('deviceC', { user: 'a' }); // researcher A's second device
  await c.open();
  const id = await shared(a, [b, c], 'G06 three devices');
  for (const d of [a, b, c]) await d.offline();
  await a.editRecord(id, { ph: 6.1 });
  await b.editRecord(id, { ph: 6.2 });
  await c.editRecord(id, { ph: 6.3 });
  await syncUp(a);
  await syncUp(b);
  await syncUp(c);
  const s = await serverRecord(id);
  expect(s.fields.ph).toBe(6.3);
  expect(s.version).toBe(4);
  const log = await serverConflicts(id);
  expect(log.map((x) => [x.lost_value, x.kept_value])).toEqual([[6.1, 6.2], [6.2, 6.3]]);
  expect(log[0].lost_by).toBe(state.users.a.id);
  expect(log[1].lost_by).toBe(state.users.b.id);
  expect(log[1].kept_by).toBe(state.users.a.id);
  expect(new Set(log.map((x) => x.lost_device)).size).toBe(2);
  await a.syncNow();
  await b.syncNow();
  for (const d of [a, b, c]) {
    expect((await d.localRecord(id)).fields.ph, d.name).toBe(6.3);
    await d.go('#/conflicts');
    await expect(d.page.locator(`[data-record-id="${id}"]`)).toHaveCount(2);
    for (const x of log) {
      await expect(d.page.locator(`[data-conflict="${x.id}"] [data-lost]`)).toHaveText(String(x.lost_value));
      await expect(d.page.locator(`[data-conflict="${x.id}"] [data-kept]`)).toHaveText(String(x.kept_value));
    }
    await d.shot(`${d.name}-conflict-log`);
  }
});

test('G07 [P0] the conflict log screen shows every entry of the region', async ({ qa }) => {
  const { a, b } = await pair(qa);
  // make sure there is at least one of each kind
  const id1 = await shared(a, [b], 'G07 same field');
  await a.offline(); await b.offline();
  await a.editRecord(id1, { ph: 5.1 });
  await b.editRecord(id1, { ph: 5.2 });
  await syncUp(a); await syncUp(b);
  const id2 = await shared(a, [b], 'G07 edit vs delete');
  await b.offline();
  await a.deleteRecord(id2);
  await a.waitSynced();
  await b.editRecord(id2, { notes: 'G07 lost edit' });
  await syncUp(b);

  const rows = await sql('select * from public.conflict_log where region_id = $1 order by at', [state.regions.main]);
  // the screen shows one entry per same-field row, and one per group of fields lost to a delete
  const groups = new Set(rows.map((c) => (c.kind === 'same_field' ? c.id : `${c.record_id}|${new Date(c.at).toISOString()}|${c.lost_device}`)));
  qa.note('postgres', { rows: rows.length, entriesExpectedOnScreen: groups.size, sameField: rows.filter((c) => c.kind === 'same_field').length });
  expect(rows.length).toBeGreaterThanOrEqual(2);

  const fresh = await qa.device('fresh-device', { user: 'b' });   // a device that never saw any of it
  const lead = await qa.device('lead', { user: 'lead', viewport: { width: 1280, height: 800 } });
  await fresh.open();
  await lead.open();
  await a.syncNow();
  await b.syncNow();
  for (const d of [a, b, fresh]) {
    await d.go('#/conflicts');
    const shown = await d.page.locator('#conflict-list > li').evaluateAll((els) => els.map((e) => ({ id: e.dataset.conflict, kind: e.dataset.kind, record: e.dataset.recordId, kept: e.querySelector('[data-kept]')?.textContent ?? null, lost: [...e.querySelectorAll('[data-lost]')].map((x) => x.textContent) })));
    // the log on a device covers every region of that user, so the expected number is counted per user
    const mine = await sql('select c.* from public.conflict_log c join public.region_members m on m.region_id = c.region_id where m.user_id = $1', [state.users[d.userKey].id]);
    const want = new Set(mine.map((c) => (c.kind === 'same_field' ? c.id : `${c.record_id}|${new Date(c.at).toISOString()}|${c.lost_device}`))).size;
    qa.note(`${d.name}Entries`, { onScreen: shown.length, postgresForThisUser: want, inMainRegion: groups.size });
    expect(shown.length, `${d.name}: entries on screen`).toBe(want);
    await expect(d.page.locator('#conflict-count')).toHaveText(`${want} ${want === 1 ? 'entry' : 'entries'} / nothing lost`);
    for (const c of rows.filter((x) => x.kind === 'same_field')) {
      const s = shown.find((x) => x.id === c.id);
      expect(s, `${d.name}: conflict ${c.id} is on screen`).toBeTruthy();
      expect(s.kept).toBe(String(c.kept_value));
      expect(s.lost).toEqual([String(c.lost_value)]);
    }
    for (const c of rows.filter((x) => x.kind === 'edit_vs_delete')) {
      expect(shown.some((x) => x.record === c.record_id && x.kind === 'edit_vs_delete' && x.lost.some((t) => t.includes(String(c.lost_value)))), `${d.name}: lost edit ${c.field} shown`).toBe(true);
    }
    await d.shot(`${d.name}-conflict-log`, { fullPage: true });
  }
  // data lead console
  await lead.page.click(`aside [data-region="${state.regions.main}"]`);
  // the console repaints while a sync finishes, so the tab is clicked until it is the current one
  await expect(async () => { await lead.page.click('[data-section="conflicts"]'); await expect(lead.page.locator('[data-section="conflicts"]')).toHaveAttribute('aria-current', 'true', { timeout: 1500 }); }).toPass({ timeout: 20_000 });
  await lead.syncNow();
  await expect(lead.page.locator('.main .panel-title', { hasText: 'All entries' })).toHaveText(`All entries / ${groups.size}`);
  await expect(lead.page.locator('.main [data-conflict]')).toHaveCount(groups.size);
  const open = new Set(rows.filter((c) => !c.resolved).map((c) => (c.kind === 'same_field' ? c.id : `${c.record_id}|${new Date(c.at).toISOString()}|${c.lost_device}`)));
  await expect(lead.page.locator('[data-card="conflicts"]')).toHaveText(String(open.size).padStart(2, '0'));
  await lead.shot('lead-conflicts');
  // the count on the Sync screen button matches the open rows
  await a.go('#/sync');
  const openA = await sql('select count(*)::int n from public.conflict_log c join public.region_members m on m.region_id = c.region_id where m.user_id = $1 and not c.resolved', [state.users.a.id]);
  await expect(a.page.locator('#open-conflicts')).toHaveText(`Conflicts (${openA[0].n})`);
});

test('G08 [P1] an edit that synced first is not silently lost when a stale delete arrives later', async ({ qa }) => {
  const { a, b } = await pair(qa);
  const id = await shared(a, [b], 'G08 stale delete');
  await b.offline();
  await a.editRecord(id, { ph: 6.6, notes: 'G08 careful re-measurement by A' });
  await a.waitSynced();
  expect((await serverRecord(id)).version).toBe(2);
  await b.deleteRecord(id);                    // B never saw A's edit (still at version 1)
  await syncUp(b);
  await a.syncNow();
  const s = await serverRecord(id);
  const log = await serverConflicts(id);
  qa.note('server', { deleted: s.deleted, version: s.version, fields: s.fields, conflictRows: log.length });
  await a.go('#/records');
  const stillListed = await a.row(id).count();
  await a.go('#/conflicts');
  await a.shot('deviceA-conflict-log');
  const mentioned = await a.page.locator(`[data-record-id="${id}"]`).count();
  qa.note('deviceA', { recordStillInList: stillListed, entriesInConflictLog: mentioned });
  expect(s.deleted, 'the delete wins').toBe(true);
  expect(log.length + mentioned, 'A\'s overwritten edit is in the conflict log (PRD: "The delete wins. The edit is saved in the conflict log so it can be restored")').toBeGreaterThan(0);
});

test('G09 [P2] the same value entered on both devices is not a conflict', async ({ qa }) => {
  const { a, b } = await pair(qa);
  const id = await shared(a, [b], 'G09 same value');
  await a.offline();
  await b.offline();
  await a.editRecord(id, { ph: 6.4 });
  await b.editRecord(id, { ph: 6.4 });
  await syncUp(a);
  await syncUp(b);
  const s = await serverRecord(id);
  expect(s.fields.ph).toBe(6.4);
  expect(s.version).toBe(2);
  expect(await serverConflicts(id)).toHaveLength(0);
  for (const d of [a, b]) {
    await d.go('#/records');
    await expect(d.row(id)).toHaveAttribute('data-status', 'synced');
    expect(await d.outbox()).toEqual([]);
  }
  // one device editing the same field twice in a row never conflicts with itself
  await a.offline();
  await a.editRecord(id, { ph: 6.5 });
  await a.editRecord(id, { ph: 6.7 });
  await syncUp(a);
  expect((await serverRecord(id)).fields.ph).toBe(6.7);
  expect(await serverConflicts(id)).toHaveLength(0);
});

test('G10 [P1] the conflict log offers Accept and Reject on a phone: Accept keeps the value, Reject puts the overwritten one back everywhere', async ({ qa }) => {
  const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
  const a = await qa.device('phoneA', { user: 'a', ...phone });
  const b = await qa.device('phoneB', { user: 'b', ...phone });
  await a.open();
  await b.open();
  // Two same-field conflicts on two records: one is accepted, one rejected.
  const make = async (label, lostPh, keptPh) => {
    const id = await shared(a, [b], label);
    await a.offline();
    await b.offline();
    await b.editRecord(id, { ph: keptPh });
    await a.editRecord(id, { ph: lostPh });
    await syncUp(a);
    await syncUp(b);
    await a.syncNow();
    const log = await serverConflicts(id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind: 'same_field', lost_value: lostPh, kept_value: keptPh, resolved: false });
    return { id, cid: log[0].id };
  };
  const acc = await make('G10 accept', 6.1, 6.9);
  const rej = await make('G10 reject', 5.2, 7.3);
  await a.go('#/conflicts');
  const accRow = a.page.locator(`[data-conflict="${acc.cid}"]`);
  const rejRow = a.page.locator(`[data-conflict="${rej.cid}"]`);
  await expect(accRow.locator('[data-accept]'), 'Accept button').toBeVisible();
  await expect(accRow.locator('[data-reject]'), 'Reject button').toBeVisible();
  await a.shot('conflict-log-buttons');
  // Accept: the kept value stays, the entry is reviewed on the server.
  await accRow.locator('[data-accept]').tap();
  await expect(accRow.locator('[data-decision]')).toHaveText(/Accepted: 6\.9 kept/);
  await expect(accRow.locator('[data-accept], [data-reject]')).toHaveCount(0);
  // Reject: the overwritten value is written again as an edit.
  await rejRow.locator('[data-reject]').tap();
  await expect(rejRow.locator('[data-decision]')).toHaveText(/Rejected: 5\.2 put back/);
  await a.waitSynced();
  expect((await serverRecord(acc.id)).fields.ph, 'accepted: kept value stays').toBe(6.9);
  expect((await serverRecord(rej.id)).fields.ph, 'rejected: overwritten value back on the server').toBe(5.2);
  const after = [...await serverConflicts(acc.id), ...await serverConflicts(rej.id)];
  expect(after.find((c) => c.id === acc.cid).resolved).toBe(true);
  expect(after.find((c) => c.id === rej.cid).resolved).toBe(true);
  expect(await serverConflicts(rej.id), 'putting it back is not a new conflict').toHaveLength(1);
  expect((await serverRecord(rej.id)).fields.notes, 'other fields untouched').toBe('base notes');
  // The other device gets the value back and sees the entries as done.
  await b.syncNow();
  expect((await b.localRecord(rej.id)).fields.ph).toBe(5.2);
  await b.go('#/conflicts');
  await expect(b.page.locator(`[data-conflict="${rej.cid}"] [data-reject]`)).toHaveCount(0);
  await expect(b.page.locator(`[data-conflict="${acc.cid}"] [data-accept]`)).toHaveCount(0);
  // The decision label survives a later pull on the device that made it.
  await a.syncNow();
  await a.go('#/conflicts');
  await expect(rejRow.locator('[data-decision]')).toHaveText(/Rejected/);
  await a.shot('conflict-log-decided');
});
