// Every write in the app goes through this file.
// Rule: the change and its outbox entry are saved in ONE IndexedDB transaction,
// and the caller only hears "saved" after that transaction has committed.
import { db, uuid, getMeta, setMeta } from './db.js';
import { diffFields, trackDistance } from './merge.js';
import { emit } from './bus.js';

const now = () => new Date().toISOString();

function outboxEntry(table, kind, rowId, extra = {}) {
  return {
    opId: uuid(), table, kind, rowId,
    recordId: extra.recordId ?? null,
    regionId: extra.regionId ?? null,
    changedFields: extra.changedFields ?? null,
    baseVersion: extra.baseVersion ?? 0,
    createdAt: now(),
    status: 'queued',
    reason: null,
  };
}

function changed() {
  emit('data');
  emit('outbox');
}

async function nextSeq(regionId, type) {
  const rows = await db.records.where('regionId').equals(regionId).toArray();
  return rows.filter((r) => r.type === type).reduce((m, r) => Math.max(m, r.seq ?? 0), 0) + 1;
}

export async function proposedSeq(regionId, type) {
  return nextSeq(regionId, type);
}

function photoRow(recordId, regionId, photo, position) {
  return {
    id: uuid(), recordId, regionId, blob: photo.blob, mimeType: 'image/jpeg',
    size: photo.blob.size, width: photo.width, height: photo.height,
    position, uploaded: 0, storagePath: null, createdAt: now(),
  };
}

// Create a record with its photos and GPS point. Returns the new record id.
export async function createRecord({ regionId, type, fields, photos = [], gps = null }) {
  const id = uuid();
  await db.transaction('rw', db.records, db.media, db.gpsLogs, db.outbox, async () => {
    const seq = await nextSeq(regionId, type);
    const t = now();
    await db.records.add({
      id, regionId, type, seq, fields: { ...fields }, version: 0,
      updatedAt: t, observedAt: t, deleted: 0, createdBy: null, updatedBy: null,
      history: [{ at: t, text: 'Created on this device' }],
    });
    await db.outbox.add(outboxEntry('records', 'upsert', id, { recordId: id, regionId, changedFields: { ...fields } }));
    if (gps) {
      const gid = uuid();
      await db.gpsLogs.add({ id: gid, recordId: id, regionId, kind: 'point', points: [gps], uploaded: 0, updatedAt: t });
      await db.outbox.add(outboxEntry('gps_logs', 'upsert', gid, { recordId: id, regionId }));
    }
    let position = 1;
    for (const photo of photos) {
      const row = photoRow(id, regionId, photo, position++);
      await db.media.add(row);
      await db.outbox.add(outboxEntry('media', 'upsert', row.id, { recordId: id, regionId }));
    }
  });
  changed();
  return id;
}

// Edit a record. Only the fields that actually changed are queued, together
// with the server version this device last saw (the base for the merge).
export async function updateRecord(id, { fields, addPhotos = [], removePhotoIds = [], gps } = {}) {
  await db.transaction('rw', db.records, db.media, db.gpsLogs, db.outbox, async () => {
    const rec = await db.records.get(id);
    if (!rec) throw new Error('Record not found on this device');
    const t = now();
    const diff = fields ? diffFields(rec.fields, fields) : {};
    if (Object.keys(diff).length > 0) {
      await db.records.update(id, {
        fields: { ...rec.fields, ...diff }, updatedAt: t,
        history: [...(rec.history ?? []), { at: t, text: 'Edited on this device' }],
      });
      await db.outbox.add(outboxEntry('records', 'upsert', id, {
        recordId: id, regionId: rec.regionId, changedFields: diff, baseVersion: rec.version,
      }));
    }
    if (gps !== undefined && gps !== null) {
      const existing = await db.gpsLogs.where('recordId').equals(id).first();
      const gid = existing?.id ?? uuid();
      await db.gpsLogs.put({ ...(existing ?? {}), id: gid, recordId: id, regionId: rec.regionId, kind: 'point', points: [gps], uploaded: 0, updatedAt: t });
      await db.outbox.add(outboxEntry('gps_logs', 'upsert', gid, { recordId: id, regionId: rec.regionId }));
    }
    for (const mediaId of removePhotoIds) {
      const m = await db.media.get(mediaId);
      if (!m) continue;
      const queued = await db.outbox.where('rowId').equals(mediaId).toArray();
      await db.media.delete(mediaId);
      if (m.uploaded) {
        await db.outbox.add(outboxEntry('media', 'delete', mediaId, { recordId: id, regionId: rec.regionId }));
      } else {
        await db.outbox.bulkDelete(queued.map((q) => q.seq)); // never left the device
      }
    }
    if (addPhotos.length > 0) {
      const have = await db.media.where('recordId').equals(id).toArray();
      let position = have.reduce((m, x) => Math.max(m, x.position ?? 0), 0) + 1;
      for (const photo of addPhotos) {
        const row = photoRow(id, rec.regionId, photo, position++);
        await db.media.add(row);
        await db.outbox.add(outboxEntry('media', 'upsert', row.id, { recordId: id, regionId: rec.regionId }));
      }
    }
  });
  changed();
}

// Soft delete. Photos of this record that have not been uploaded yet are dropped.
export async function deleteRecord(id) {
  await db.transaction('rw', db.records, db.media, db.gpsLogs, db.outbox, async () => {
    const rec = await db.records.get(id);
    if (!rec) return;
    const t = now();
    await db.records.update(id, {
      deleted: 1, updatedAt: t,
      history: [...(rec.history ?? []), { at: t, text: 'Deleted on this device' }],
    });
    const queued = await db.outbox.where('recordId').equals(id).toArray();
    const mediaOps = queued.filter((q) => q.table === 'media' && q.kind === 'upsert');
    await db.outbox.bulkDelete(mediaOps.map((q) => q.seq));
    await db.media.bulkDelete(mediaOps.map((q) => q.rowId));
    await db.outbox.add(outboxEntry('records', 'delete', id, { recordId: id, regionId: rec.regionId, baseVersion: rec.version }));
  });
  changed();
}

// Bring back a record that was deleted on another device, with the edit that lost.
export async function restoreRecord(id, fields = {}) {
  await db.transaction('rw', db.records, db.outbox, async () => {
    const rec = await db.records.get(id);
    if (!rec) throw new Error('Record not found on this device');
    const t = now();
    await db.records.update(id, {
      deleted: 0, fields: { ...rec.fields, ...fields }, updatedAt: t,
      history: [...(rec.history ?? []), { at: t, text: 'Restored on this device' }],
    });
    await db.outbox.add(outboxEntry('records', 'restore', id, {
      recordId: id, regionId: rec.regionId, changedFields: fields, baseVersion: rec.version,
    }));
  });
  changed();
}

// `resolution` ('accepted' or 'rejected') is only remembered on this device, for
// the label in the conflict log; the server just records that it was reviewed.
export async function resolveConflict(conflict, resolution = null) {
  await db.transaction('rw', db.meta, db.outbox, async () => {
    const list = (await getMeta('conflicts', [])).map((c) => (c.id === conflict.id ? { ...c, resolved: true, ...(resolution ? { resolution } : {}) } : c));
    await setMeta('conflicts', list);
    await db.outbox.add(outboxEntry('conflict_log', 'resolve', conflict.id, { regionId: conflict.region_id }));
  });
  changed();
}

// ----------------------------------------------------------------- tracks

// A track being recorded is saved as it grows (so it survives a restart) but
// only gets its outbox entry when it is finished.
export async function saveTrackDraft(track) {
  await db.gpsLogs.put({ ...track, kind: 'track', recordId: null, uploaded: 0, recording: 1, updatedAt: now() });
}

export async function finishTrack(id, { name } = {}) {
  await db.transaction('rw', db.gpsLogs, db.outbox, async () => {
    const track = await db.gpsLogs.get(id);
    if (!track) return;
    const all = await db.gpsLogs.where('regionId').equals(track.regionId).toArray();
    const seq = track.seq ?? all.filter((g) => g.kind === 'track' && g.id !== id).reduce((m, g) => Math.max(m, g.seq ?? 0), 0) + 1;
    await db.gpsLogs.update(id, {
      recording: 0, seq, name: name ?? track.name, endedAt: track.endedAt ?? now(),
      distanceM: trackDistance(track.points), updatedAt: now(),
    });
    await db.outbox.add(outboxEntry('gps_logs', 'upsert', id, { regionId: track.regionId }));
  });
  changed();
}

export async function deleteTrack(id) {
  await db.transaction('rw', db.gpsLogs, db.outbox, async () => {
    const track = await db.gpsLogs.get(id);
    if (!track) return;
    const queued = await db.outbox.where('rowId').equals(id).toArray();
    await db.gpsLogs.delete(id);
    if (track.uploaded) {
      await db.outbox.add(outboxEntry('gps_logs', 'delete', id, { regionId: track.regionId }));
    } else {
      await db.outbox.bulkDelete(queued.map((q) => q.seq)); // never left the device
    }
  });
  changed();
}

// --------------------------------------------------------------- storage

// Drop the local copies of photos that are safely on the server.
export async function freeSyncedPhotos() {
  let freed = 0;
  await db.transaction('rw', db.media, async () => {
    const rows = await db.media.where('uploaded').equals(1).toArray();
    for (const m of rows) {
      if (m.blob) {
        await db.media.update(m.id, { blob: null });
        freed++;
      }
    }
  });
  emit('data');
  return freed;
}

export async function retryRejected() {
  await db.outbox.where('status').equals('rejected').modify({ status: 'queued', reason: null });
  changed();
}
