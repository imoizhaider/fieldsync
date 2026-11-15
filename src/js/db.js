// Local data: IndexedDB through Dexie. Tables as in the PRD.
// One database per signed-in user, so two accounts on one device never mix.
import Dexie from './vendor/dexie.js';

export let db = null;

export function openDb(userId) {
  if (db && db.name === `fieldsync-${userId}`) return db;
  if (db) db.close();
  db = new Dexie(`fieldsync-${userId}`);
  db.version(1).stores({
    // Observation data.            deleted is 0 or 1 (booleans cannot be indexed)
    records: 'id, regionId, type, updatedAt, deleted',
    // Photos as binary blobs.      uploaded is 0 or 1
    media: 'id, recordId, uploaded',
    // GPS points and tracks.
    gpsLogs: 'id, recordId, regionId, kind, uploaded',
    // Changes waiting to upload, in the order they were made.
    outbox: '++seq, &opId, table, rowId, recordId, status',
    // Sync bookkeeping as key/value rows: deviceId, lastPulledAt, userId,
    // plus small server caches (regions, profiles, conflicts, devices).
    meta: 'key',
  });
  return db;
}

export function closeDb() {
  if (db) db.close();
  db = null;
}

export async function getMeta(key, fallback = null) {
  const row = await db.meta.get(key);
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  await db.meta.put({ key, value });
}

export function uuid() {
  return crypto.randomUUID();
}

export async function deviceId() {
  let id = await getMeta('deviceId');
  if (!id) {
    id = uuid();
    await setMeta('deviceId', id);
  }
  return id;
}
