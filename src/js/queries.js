// Read helpers used by several screens. Reads never touch the network.
import { db, getMeta, setMeta } from './db.js';
import { recordStatus } from './merge.js';

export async function regions() {
  return getMeta('regions', []);
}

export async function currentRegion() {
  const list = await regions();
  if (list.length === 0) return null;
  const id = await getMeta('currentRegionId');
  return list.find((r) => r.id === id) ?? list.find((r) => r.role !== 'viewer') ?? list[0];
}

export async function setCurrentRegion(id) {
  await setMeta('currentRegionId', id);
}

export const canEdit = (region) => Boolean(region) && region.role !== 'viewer';

export async function isLead() {
  return (await regions()).some((r) => r.role === 'lead');
}

export async function profileNames() {
  return Object.fromEntries((await getMeta('profiles', [])).map((p) => [p.user_id, p.display_name]));
}

export async function conflicts() {
  return getMeta('conflicts', []);
}

async function countByIndex(table, index) {
  const counts = {};
  await table.orderBy(index).eachKey((k) => { counts[k] = (counts[k] ?? 0) + 1; });
  return counts;
}

// Everything the record list needs for one region, without loading photo blobs.
export async function regionView(regionId) {
  const [all, outbox, photoCounts, gpsCounts, conflictList] = await Promise.all([
    db.records.where('regionId').equals(regionId).toArray(),
    db.outbox.orderBy('seq').toArray(),
    countByIndex(db.media, 'recordId'),
    countByIndex(db.gpsLogs, 'recordId'),
    conflicts(),
  ]);
  const ops = {};
  for (const e of outbox) {
    if (!e.recordId) continue;
    const o = (ops[e.recordId] ??= { pending: 0, rejected: 0, entries: [] });
    if (e.status === 'rejected') o.rejected++; else o.pending++;
    o.entries.push(e);
  }
  const open = {};
  for (const c of conflictList) if (!c.resolved) (open[c.record_id] ??= []).push(c);

  const rows = all.map((r) => ({
    record: r,
    photos: photoCounts[r.id] ?? 0,
    hasGps: (gpsCounts[r.id] ?? 0) > 0,
    ops: ops[r.id] ?? { pending: 0, rejected: 0, entries: [] },
    conflicts: open[r.id] ?? [],
    status: recordStatus({
      pendingOps: ops[r.id]?.pending ?? 0, rejectedOps: ops[r.id]?.rejected ?? 0,
      openConflicts: (open[r.id] ?? []).length, deleted: Boolean(r.deleted),
    }),
  }));
  rows.sort((a, b) => ((a.record.observedAt ?? '') < (b.record.observedAt ?? '') ? 1 : -1));
  const live = rows.filter((x) => !x.record.deleted);
  return {
    rows, live,
    counts: {
      total: live.length,
      pending: live.filter((x) => x.status === 'pending' || x.status === 'failed').length,
      synced: live.filter((x) => x.status === 'synced' || x.status === 'conflict').length,
      conflicts: Object.keys(open).filter((id) => all.some((r) => r.id === id)).length,
    },
  };
}

export async function recordCounts() {
  const counts = {};
  await db.records.each((r) => { if (!r.deleted) counts[r.regionId] = (counts[r.regionId] ?? 0) + 1; });
  return counts;
}

export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota, pct: quota ? Math.round((usage / quota) * 100) : 0 };
  } catch { return null; }
}
