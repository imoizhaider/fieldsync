// Sync engine. Push the outbox first, then pull what changed since
// lastPulledAt. Starts by itself on app open and on reconnect; "Sync now"
// is only a backup.
import { db, getMeta, setMeta, deviceId } from './db.js';
import { supabase, setDisplayName, currentUser } from './auth.js';
import { mergeServerRecord, backoffDelay } from './merge.js';
import { emit, on } from './bus.js';

export const state = {
  online: navigator.onLine,
  phase: 'idle',          // idle | starting | pushing | pulling
  total: 0,               // outbox entries in this run
  done: 0,
  current: null,          // outbox entry being sent
  recent: [],             // entries finished in the latest run (for the Sync screen)
  failures: 0,
  retryAt: null,          // when the next automatic retry fires
  failedOpId: null,       // the entry that was interrupted
  lastError: null,
  needsSignIn: false,
  reconnected: 0,         // > 0 right after coming back online: number of changes about to upload
  justSynced: false,      // true for a few seconds after everything was uploaded
  pending: 0,             // distinct records / tracks with changes waiting
  pendingOps: 0,
  rejected: 0,
  lastSyncAt: null,
};

class SyncError extends Error {}

let running = null;
let again = false;
let retryTimer = null;
let toastTimer = null;
let debounce = null;

function update(patch) {
  Object.assign(state, patch);
  emit('sync', state);
}

export async function refreshCounts() {
  if (!db) return;
  const entries = await db.outbox.toArray();
  const live = entries.filter((e) => e.status !== 'rejected');
  const rejected = entries.filter((e) => e.status === 'rejected');
  update({
    pendingOps: live.length,
    pending: new Set(entries.map((e) => e.recordId ?? e.rowId)).size,
    rejected: new Set(rejected.map((e) => e.recordId ?? e.rowId)).size,
    lastSyncAt: await getMeta('lastSyncAt'),
  });
}

async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new SyncError(error.message || 'network error');
  return data;
}

// ------------------------------------------------------------------- push

async function buildOp(e) {
  const op = { op_id: e.opId, table: e.table, kind: e.kind, row_id: e.rowId };
  if (e.table === 'records') {
    const rec = await db.records.get(e.rowId);
    return { ...op, region_id: e.regionId, type: rec?.type, seq: rec?.seq, observed_at: rec?.observedAt, base_version: e.baseVersion ?? 0, changed: e.changedFields ?? {} };
  }
  if (e.table === 'gps_logs') {
    const g = await db.gpsLogs.get(e.rowId);
    if (!g && e.kind !== 'delete') return null;
    return {
      ...op, region_id: e.regionId, record_id: g?.recordId ?? null, gps_kind: g?.kind, name: g?.name ?? null, seq: g?.seq ?? null,
      points: g?.points, started_at: g?.startedAt ?? null, ended_at: g?.endedAt ?? null, distance_m: g?.distanceM ?? null,
    };
  }
  if (e.table === 'media') {
    const m = await db.media.get(e.rowId);
    if (!m && e.kind !== 'delete') return null;
    return {
      ...op, record_id: e.recordId,
      storage_path: m ? `${m.regionId}/${m.recordId}/${m.id}.jpg` : null,
      mime_type: m?.mimeType, size_bytes: m?.size, position: m?.position,
    };
  }
  return op;
}

// The server answered for one outbox entry. Only now does the entry leave the outbox.
async function applyResult(e, res) {
  if (res.status === 'rejected') {
    await db.outbox.update(e.seq, { status: 'rejected', reason: res.reason ?? 'rejected by server' });
    return false;
  }
  await db.transaction('rw', db.outbox, db.records, db.media, db.gpsLogs, async () => {
    await db.outbox.delete(e.seq);
    if (e.table === 'records' && res.record) {
      const local = await db.records.get(e.rowId);
      const rest = (await db.outbox.where('rowId').equals(e.rowId).toArray()).sort((a, b) => a.seq - b.seq);
      await db.records.put(mergeServerRecord(local, res.record, rest));
    } else if (e.table === 'media' && e.kind === 'upsert') {
      const m = await db.media.get(e.rowId);
      if (m) await db.media.update(e.rowId, { uploaded: 1, storagePath: `${m.regionId}/${m.recordId}/${m.id}.jpg` });
    } else if (e.table === 'gps_logs' && e.kind === 'upsert') {
      const more = await db.outbox.where('rowId').equals(e.rowId).count();
      const patch = more === 0 ? { uploaded: 1 } : {};
      if (res.seq) patch.seq = res.seq;
      await db.gpsLogs.update(e.rowId, patch);
    }
  });
  return true;
}

function isRejection(error) {
  if (/jwt|token/i.test(error?.message ?? '')) return false;
  const status = Number(error?.status ?? error?.statusCode);
  return status >= 400 && status < 500 && ![401, 408, 429].includes(status);
}

async function finish(e, ok) {
  state.recent.push({ ...e, result: ok ? 'done' : 'failed' });
  update({ done: state.done + 1, current: null });
}

async function push(dev) {
  const all = await db.outbox.orderBy('seq').toArray();
  const entries = all.filter((e) => e.status !== 'rejected');
  // A record with a rejected change holds back its later changes (photos etc).
  const blocked = new Set(all.filter((e) => e.status === 'rejected' && e.recordId).map((e) => e.recordId));
  update({ phase: 'pushing', total: entries.length, done: 0, recent: [] });

  let i = 0;
  while (i < entries.length) {
    const e = entries[i];
    if (e.recordId && blocked.has(e.recordId)) {
      await db.outbox.update(e.seq, { status: 'rejected', reason: 'held back: an earlier change to this record was rejected' });
      await finish(e, false);
      i++;
      continue;
    }

    if (e.table === 'media' && e.kind === 'upsert') {
      i++;
      update({ current: e });
      const m = await db.media.get(e.rowId);
      const op = await buildOp(e);
      if (!m || !op) { await db.outbox.delete(e.seq); await finish(e, true); continue; }
      if (m.blob) {
        const { error } = await supabase.storage.from('photos')
          .upload(op.storage_path, m.blob, { upsert: true, contentType: 'image/jpeg' });
        if (error) {
          if (!isRejection(error)) { update({ failedOpId: e.opId }); throw new SyncError('photo upload interrupted'); }
          await db.outbox.update(e.seq, { status: 'rejected', reason: error.message });
          blocked.add(e.recordId);
          await finish(e, false);
          continue;
        }
      }
      let data;
      try { data = await rpc('sync_push', { p_device_id: dev, p_ops: [op] }); } catch (err) { update({ failedOpId: e.opId }); throw err; }
      const ok = await applyResult(e, data.results[0]);
      if (!ok && e.recordId) blocked.add(e.recordId);
      await finish(e, ok);
      continue;
    }

    // Everything that is not a photo upload goes up in small batches.
    const batch = [];
    while (i < entries.length && batch.length < 25) {
      const b = entries[i];
      if ((b.table === 'media' && b.kind === 'upsert') || (b.recordId && blocked.has(b.recordId))) break;
      batch.push(b);
      i++;
    }
    update({ current: batch[0] });
    const ops = [];
    const sent = [];
    for (const b of batch) {
      const op = await buildOp(b);
      if (op) { ops.push(op); sent.push(b); } else { await db.outbox.delete(b.seq); await finish(b, true); }
    }
    if (ops.length === 0) continue;
    let data;
    try { data = await rpc('sync_push', { p_device_id: dev, p_ops: ops }); } catch (err) { update({ failedOpId: batch[0].opId }); throw err; }
    const byId = new Map(data.results.map((r) => [r.op_id, r]));
    for (const b of sent) {
      const res = byId.get(b.opId);
      if (!res) throw new SyncError('server did not answer for a change');
      const ok = await applyResult(b, res);
      if (!ok && b.recordId) blocked.add(b.recordId);
      await finish(b, ok);
    }
    emit('data');
  }

  // Nothing to push: still tell the server this device checked in.
  if (entries.length === 0) await rpc('sync_push', { p_device_id: dev, p_ops: [] });
  return entries.length;
}

// ------------------------------------------------------------------- pull

async function pull() {
  const since = await getMeta('lastPulledAt');
  const data = await rpc('sync_pull', { p_since: since });
  await db.transaction('rw', db.records, db.media, db.gpsLogs, db.outbox, db.meta, async () => {
    await setMeta('regions', data.regions);
    await setMeta('profiles', data.profiles);
    await setMeta('devices', data.devices);

    for (const r of data.records) {
      const local = await db.records.get(r.id);
      const pending = (await db.outbox.where('rowId').equals(r.id).toArray()).sort((a, b) => a.seq - b.seq);
      await db.records.put(mergeServerRecord(local, r, pending));
    }
    for (const m of data.media) {
      const local = await db.media.get(m.id);
      if (m.deleted) { await db.media.delete(m.id); continue; }
      if (local) await db.media.update(m.id, { uploaded: 1, storagePath: m.storage_path });
      else {
        await db.media.put({
          id: m.id, recordId: m.record_id, regionId: m.region_id, blob: null, mimeType: m.mime_type,
          size: m.size_bytes, position: m.position, uploaded: 1, storagePath: m.storage_path,
        });
      }
    }
    for (const g of data.gps_logs) {
      if ((await db.outbox.where('rowId').equals(g.id).count()) > 0) continue; // local change still waiting
      if (g.deleted) { await db.gpsLogs.delete(g.id); continue; }
      await db.gpsLogs.put({
        id: g.id, recordId: g.record_id, regionId: g.region_id, kind: g.kind, name: g.name, seq: g.seq,
        points: g.points, startedAt: g.started_at, endedAt: g.ended_at, distanceM: g.distance_m,
        uploaded: 1, recording: 0, updatedAt: g.updated_at ?? null,
      });
    }
    if (data.conflicts.length > 0 || since === null) {
      const known = new Map((since === null ? [] : await getMeta('conflicts', [])).map((c) => [c.id, c]));
      const waiting = new Set((await db.outbox.where('table').equals('conflict_log').toArray()).map((e) => e.rowId));
      for (const c of data.conflicts) known.set(c.id, waiting.has(c.id) ? { ...c, resolved: true } : c);
      await setMeta('conflicts', [...known.values()].sort((a, b) => (a.at < b.at ? 1 : -1)));
    }
    // Overlap the next pull by a few seconds: rows committed while this pull
    // was reading are picked up next time. Applying a row twice is harmless.
    await setMeta('lastPulledAt', new Date(new Date(data.server_time).getTime() - 5000).toISOString());
    await setMeta('lastSyncAt', new Date().toISOString());
  });
  const me = data.profiles.find((p) => p.user_id === currentUser()?.id);
  if (me) setDisplayName(me.display_name);
}

// -------------------------------------------------------------------- run

async function run() {
  update({ phase: 'starting', lastError: null, retryAt: null, failedOpId: null });
  try {
    const { data, error } = await supabase.auth.getSession();
    if (!data?.session) {
      // A refresh that failed for a network or server reason (offline, timeout,
      // 5xx) leaves the session stored: that is a sync failure, retried with
      // backoff. Only a session the server really ended needs a new sign-in.
      if (error && (error.name === 'AuthRetryableFetchError' || /fetch|network/i.test(error.message ?? ''))) {
        throw new SyncError('could not refresh the session');
      }
      update({ needsSignIn: true });
      return;
    }
    update({ needsSignIn: false });
    const dev = await deviceId();
    const pushed = await push(dev);
    update({ phase: 'pulling', current: null });
    await pull();
    state.failures = 0;
    await refreshCounts();
    if (pushed > 0 && state.pendingOps === 0 && state.rejected === 0) {
      update({ justSynced: true });
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => update({ justSynced: false }), 6000);
    }
  } catch (err) {
    // Interrupted or failed: the outbox is left as it is and we try again later.
    state.failures += 1;
    const delay = backoffDelay(state.failures);
    update({ lastError: err?.message ?? String(err), retryAt: Date.now() + delay });
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if (navigator.onLine) syncNow(); }, delay);
  } finally {
    update({ phase: 'idle', current: null, reconnected: 0 });
    await refreshCounts();
    emit('data');
  }
}

export function syncNow({ manual = false } = {}) {
  if (!db || !supabase) return Promise.resolve();
  if (running) { again = true; return running; }
  if (!navigator.onLine) { update({ online: false }); return Promise.resolve(); }
  if (manual) state.failures = 0;
  clearTimeout(retryTimer);
  running = run().finally(() => {
    running = null;
    if (again) { again = false; syncNow(); }
  });
  return running;
}

// Download a photo that came from another device, once, and keep it locally.
export async function fetchPhotoBlob(mediaId) {
  const m = await db.media.get(mediaId);
  if (!m || m.blob || !m.storagePath || !navigator.onLine || !supabase) return m?.blob ?? null;
  const { data, error } = await supabase.storage.from('photos').download(m.storagePath);
  if (error || !data) return null;
  await db.media.update(mediaId, { blob: data });
  return data;
}

let started = false;

// Wire the automatic triggers. No button press needed for any of them.
export function startAutoSync() {
  refreshCounts();
  if (started) { syncNow(); return; }
  started = true;

  window.addEventListener('online', async () => {
    await refreshCounts();
    state.failures = 0;
    update({ online: true, reconnected: state.pending, retryAt: null });
    syncNow();
  });
  window.addEventListener('offline', () => update({ online: false, reconnected: 0 }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncNow();
  });
  // A new local change: upload it right away when there is a connection.
  on('outbox', () => {
    refreshCounts();
    clearTimeout(debounce);
    debounce = setTimeout(() => syncNow(), 400);
  });
  // Safety net: look for work, and for other people's changes, every 20 s.
  setInterval(() => {
    if (db && navigator.onLine && state.phase === 'idle' && !(state.retryAt && state.retryAt > Date.now())) syncNow();
  }, 20000);

  syncNow(); // on app open
}
