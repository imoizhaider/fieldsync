import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diffFields, mergeServerRecord, recordStatus, backoffDelay, formatLabel, fitWithin,
  trackDistance, haversine, summaryLine, recordTitle, toCsv, sameValue,
} from '../../src/js/merge.js';

const server = (over = {}) => ({
  id: 'r1', region_id: 'reg', type: 'soil', seq: 14, version: 3, updated_at: '2026-11-15T10:00:00Z',
  deleted: false, fields: { title: 'North transect', ph: 6.8, notes: 'server note' }, ...over,
});
const op = (over = {}) => ({ table: 'records', kind: 'upsert', status: 'queued', changedFields: {}, ...over });

test('diffFields returns only the fields that changed', () => {
  assert.deepEqual(diffFields({ ph: 6.4, notes: 'a' }, { ph: 6.8, notes: 'a' }), { ph: 6.8 });
  assert.deepEqual(diffFields({ ph: 6.4 }, { ph: 6.4 }), {});
  assert.deepEqual(diffFields({ ph: 6.4, notes: 'a' }, { ph: 6.4 }), { notes: null });
  assert.deepEqual(diffFields({}, { ph: 7, notes: '' }), { ph: 7 });
});

test('diffFields treats empty, null and missing as the same value', () => {
  assert.deepEqual(diffFields({ notes: null }, { notes: '' }), {});
  assert.deepEqual(diffFields({ notes: '' }, {}), {});
  assert.equal(sameValue(undefined, null), true);
  assert.equal(sameValue(6.4, '6.4'), false);
});

test('merge: with nothing pending the server copy wins for every field', () => {
  const local = { id: 'r1', fields: { title: 'old', ph: 6.4 }, version: 1, history: [{ at: 't', text: 'Created on this device' }] };
  const merged = mergeServerRecord(local, server());
  assert.deepEqual(merged.fields, { title: 'North transect', ph: 6.8, notes: 'server note' });
  assert.equal(merged.version, 3);
  assert.equal(merged.regionId, 'reg');
  assert.equal(merged.deleted, 0);
  assert.deepEqual(merged.history, local.history, 'local history is kept');
});

test('merge: different fields on two devices are both kept', () => {
  const local = { id: 'r1', fields: { ph: 6.4, notes: 'my note' }, version: 1 };
  const merged = mergeServerRecord(local, server(), [op({ changedFields: { notes: 'my note' } })]);
  assert.equal(merged.fields.ph, 6.8, 'the other device\'s pH arrives');
  assert.equal(merged.fields.notes, 'my note', 'my pending notes edit is not overwritten by the pull');
});

test('merge: a pending local edit to the same field stays until the server has answered', () => {
  const merged = mergeServerRecord({ id: 'r1', fields: { ph: 6.1 }, version: 1 }, server(), [op({ changedFields: { ph: 6.1 } })]);
  assert.equal(merged.fields.ph, 6.1);
  assert.equal(merged.version, 3, 'the base version moves forward so the server can tell what this device has seen');
});

test('merge: several pending edits apply in order, the newest last', () => {
  const merged = mergeServerRecord(null, server(), [op({ changedFields: { ph: 6.0, notes: 'a' } }), op({ changedFields: { ph: 6.2 } })]);
  assert.equal(merged.fields.ph, 6.2);
  assert.equal(merged.fields.notes, 'a');
});

test('merge: a delete on the server wins over a pending local edit', () => {
  const merged = mergeServerRecord({ id: 'r1', fields: { notes: 'mine' }, version: 1 }, server({ deleted: true }), [op({ changedFields: { notes: 'mine' } })]);
  assert.equal(merged.deleted, 1);
  assert.equal(merged.fields.notes, 'server note', 'the losing edit is not shown as if it had been saved');
});

test('merge: a pending local delete keeps the record hidden, a pending restore brings it back', () => {
  assert.equal(mergeServerRecord(null, server(), [op({ kind: 'delete' })]).deleted, 1);
  const restored = mergeServerRecord(null, server(), [op({ kind: 'delete' }), op({ kind: 'restore', changedFields: { notes: 'kept' } })]);
  assert.equal(restored.deleted, 0);
  assert.equal(restored.fields.notes, 'kept');
});

test('merge: rejected and non-record outbox entries do not shadow server values', () => {
  const merged = mergeServerRecord(null, server(), [
    op({ status: 'rejected', changedFields: { ph: 1 } }), { table: 'media', kind: 'upsert', status: 'queued' },
  ]);
  assert.equal(merged.fields.ph, 6.8);
});

test('merge: a record first seen from the server needs no local copy', () => {
  const merged = mergeServerRecord(undefined, server({ observed_at: '2026-11-15T09:00:00Z' }));
  assert.equal(merged.id, 'r1');
  assert.equal(merged.seq, 14);
  assert.equal(merged.observedAt, '2026-11-15T09:00:00Z');
  assert.deepEqual(merged.history, []);
});

test('recordStatus: failed beats pending beats deleted beats conflict beats synced', () => {
  assert.equal(recordStatus({ pendingOps: 2, rejectedOps: 1 }), 'failed');
  assert.equal(recordStatus({ pendingOps: 2, openConflicts: 1 }), 'pending');
  assert.equal(recordStatus({ deleted: true, openConflicts: 1 }), 'deleted');
  assert.equal(recordStatus({ openConflicts: 1 }), 'conflict');
  assert.equal(recordStatus({}), 'synced');
});

test('backoffDelay doubles from 2 s and is capped at 60 s', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 20].map((n) => backoffDelay(n)), [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  assert.equal(backoffDelay(0), 2000);
});

test('formatLabel pads the number and uses the type prefix', () => {
  assert.equal(formatLabel('soil', 14), 'SOIL-014');
  assert.equal(formatLabel('water', 7), 'WTR-007');
  assert.equal(formatLabel('wildlife', 3), 'WLD-003');
  assert.equal(formatLabel('track', 7), 'TRK-007');
  assert.equal(formatLabel('soil', 1234), 'SOIL-1234');
});

test('fitWithin shrinks to a 1280 px longest side and never enlarges', () => {
  assert.deepEqual(fitWithin(2400, 1800), { width: 1280, height: 960 });
  assert.deepEqual(fitWithin(1800, 2400), { width: 960, height: 1280 });
  assert.deepEqual(fitWithin(4032, 3024), { width: 1280, height: 960 });
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 });
  assert.deepEqual(fitWithin(1280, 1280), { width: 1280, height: 1280 });
});

test('track distance adds up the legs', () => {
  const a = { lat: 24.8607, lng: 67.0011 };
  const b = { lat: 24.8697, lng: 67.0011 }; // 0.009 degrees of latitude, about 1 km
  assert.ok(Math.abs(haversine(a, b) - 1000.8) < 2);
  assert.ok(Math.abs(trackDistance([a, b, a]) - 2001.6) < 4);
  assert.equal(trackDistance([a]), 0);
  assert.equal(trackDistance([]), 0);
});

test('summary line and title for the record list', () => {
  const soil = { type: 'soil', fields: { ph: 6.4 } };
  assert.equal(summaryLine(soil, 3, true), 'pH 6.4 / 3 photos / GPS');
  assert.equal(summaryLine({ type: 'water', fields: { turbidity: 12 } }, 1, false), 'Turb 12 NTU / 1 photo');
  assert.equal(summaryLine({ type: 'wildlife', fields: { notes: 'x' } }, 0, true), 'Notes / GPS');
  assert.equal(summaryLine({ type: 'soil', fields: {} }, 0, false), 'No readings');
  assert.equal(recordTitle(soil), 'Soil sample');
  assert.equal(recordTitle({ type: 'wildlife', fields: { title: 'Heron sighting' } }), 'Heron sighting');
});

test('CSV export quotes commas, quotes and line breaks', () => {
  const csv = toCsv([{
    id: 'r1', type: 'soil', seq: 14, version: 3, deleted: 0, updatedBy: 'u1', observedAt: 'o', updatedAt: 'u',
    fields: { title: 'North, transect', ph: 6.8, notes: 'said "wet"\nsecond line' },
  }], { gpsByRecord: { r1: { lat: 24.8607, lng: 67.0011, acc: 4 } }, photosByRecord: { r1: 3 }, names: { u1: 'Researcher B' } });
  const [header, ...rest] = csv.split('\r\n');
  assert.equal(header.split(',').length, 22);
  assert.ok(rest.join('\r\n').startsWith('SOIL-014,r1,soil,"North, transect",6.8,,,,,,,,"said ""wet""\nsecond line",24.8607,67.0011,4,3,o,u,Researcher B,3,no'));
});
