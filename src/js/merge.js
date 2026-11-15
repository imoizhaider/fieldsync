// Pure logic shared by the store and the sync engine. No DOM, no IndexedDB,
// so it runs in the unit tests under plain Node.

export const TYPES = {
  soil: {
    label: 'Soil', prefix: 'SOIL', noun: 'soil sample',
    readings: [
      { key: 'ph', label: 'pH', short: 'pH', unit: '', kind: 'number' },
      { key: 'moisture', label: 'Moisture', short: 'Moist', unit: '%', kind: 'number' },
      { key: 'temperature', label: 'Temperature', short: 'Temp', unit: 'C', kind: 'number' },
      { key: 'depth', label: 'Depth', short: 'Depth', unit: 'cm', kind: 'number' },
    ],
  },
  water: {
    label: 'Water', prefix: 'WTR', noun: 'water sample',
    readings: [
      { key: 'ph', label: 'pH', short: 'pH', unit: '', kind: 'number' },
      { key: 'turbidity', label: 'Turbidity', short: 'Turb', unit: 'NTU', kind: 'number' },
      { key: 'temperature', label: 'Temperature', short: 'Temp', unit: 'C', kind: 'number' },
      { key: 'oxygen', label: 'Dissolved oxygen', short: 'DO', unit: 'mg/L', kind: 'number' },
    ],
  },
  wildlife: {
    label: 'Wildlife', prefix: 'WLD', noun: 'wildlife sighting',
    readings: [
      { key: 'species', label: 'Species', short: 'Species', unit: '', kind: 'text' },
      { key: 'count', label: 'Count', short: 'Count', unit: '', kind: 'number' },
    ],
  },
};

export function fieldLabel(key) {
  if (key === 'title') return 'title';
  if (key === 'notes') return 'notes';
  for (const t of Object.values(TYPES)) {
    const r = t.readings.find((x) => x.key === key);
    if (r) return r.label;
  }
  return key;
}

export function formatLabel(type, seq) {
  const prefix = type === 'track' ? 'TRK' : (TYPES[type]?.prefix ?? 'REC');
  return `${prefix}-${String(seq ?? 0).padStart(3, '0')}`;
}

function norm(v) {
  return v === undefined || v === '' ? null : v;
}

export function sameValue(a, b) {
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

// Fields whose value differs between two versions of a record's fields.
// Only these go into the outbox, which is what makes the per-field merge work.
export function diffFields(before = {}, after = {}) {
  const changed = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!sameValue(before[key], after[key])) changed[key] = norm(after[key]);
  }
  return changed;
}

// Merge the server's copy of a record into the local one.
//   * the server wins for every field this device has no pending change for
//   * fields with a pending (not yet uploaded) local change keep the local value
//   * a delete on the server always wins; a pending local delete keeps it hidden here
// `pendingOps` are the outbox entries for this record, oldest first.
export function mergeServerRecord(local, server, pendingOps = []) {
  const ops = pendingOps.filter((op) => op.table === 'records' && op.status !== 'rejected');
  const fields = { ...(server.fields ?? {}) };
  let deleted = server.deleted ? 1 : 0;
  if (!deleted) {
    for (const op of ops) {
      if (op.kind === 'delete') deleted = 1;
      else if (op.kind === 'restore') { deleted = 0; Object.assign(fields, op.changedFields ?? {}); }
      else Object.assign(fields, op.changedFields ?? {});
    }
  }
  return {
    ...(local ?? {}),
    id: server.id,
    regionId: server.region_id,
    type: server.type,
    seq: server.seq,
    fields,
    version: server.version,
    updatedAt: server.updated_at,
    observedAt: server.observed_at ?? local?.observedAt ?? server.updated_at,
    createdBy: server.created_by ?? local?.createdBy ?? null,
    updatedBy: server.updated_by ?? null,
    deleted,
    history: local?.history ?? [],
  };
}

// What a record's badge says. Shape plus text, never colour alone.
export function recordStatus({ pendingOps = 0, rejectedOps = 0, openConflicts = 0, deleted = false }) {
  if (rejectedOps > 0) return 'failed';
  if (pendingOps > 0) return 'pending';
  if (deleted) return 'deleted';
  if (openConflicts > 0) return 'conflict';
  return 'synced';
}

// Retry delay after the n-th failure in a row: 2 s, 4 s, 8 s ... capped at 60 s.
export function backoffDelay(failures, base = 2000, cap = 60000) {
  return Math.min(cap, base * 2 ** Math.max(0, failures - 1));
}

export function haversine(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function trackDistance(points = []) {
  let m = 0;
  for (let i = 1; i < points.length; i++) m += haversine(points[i - 1], points[i]);
  return m;
}

// Target size for a photo: longest side at most `max`, never upscaled.
export function fitWithin(width, height, max = 1280) {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const k = max / longest;
  return { width: Math.round(width * k), height: Math.round(height * k) };
}

export function summaryLine(record, photoCount, hasGps) {
  const parts = [];
  const def = TYPES[record.type];
  const first = def?.readings.find((r) => norm(record.fields?.[r.key]) !== null);
  if (first) {
    const v = record.fields[first.key];
    parts.push(first.kind === 'text' ? String(v) : `${first.short} ${v}${first.unit && first.unit.length > 1 ? ' ' + first.unit : first.unit}`);
  } else if (norm(record.fields?.notes) !== null) {
    parts.push('Notes');
  }
  if (photoCount > 0) parts.push(`${photoCount} ${photoCount === 1 ? 'photo' : 'photos'}`);
  if (hasGps) parts.push('GPS');
  return parts.join(' / ') || 'No readings';
}

export function recordTitle(record) {
  const t = norm(record.fields?.title);
  if (t !== null) return String(t);
  const noun = TYPES[record.type]?.noun ?? 'record';
  return noun.charAt(0).toUpperCase() + noun.slice(1);
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// CSV of one region's merged dataset (FR-13).
export function toCsv(records, { gpsByRecord = {}, photosByRecord = {}, names = {} } = {}) {
  const fieldKeys = ['title', 'ph', 'moisture', 'temperature', 'depth', 'turbidity', 'oxygen', 'species', 'count', 'notes'];
  const header = ['label', 'id', 'type', ...fieldKeys, 'lat', 'lng', 'accuracy_m', 'photos', 'observed_at', 'updated_at', 'last_edit_by', 'version', 'deleted'];
  const lines = [header.join(',')];
  for (const r of records) {
    const p = gpsByRecord[r.id];
    lines.push([
      formatLabel(r.type, r.seq), r.id, r.type,
      ...fieldKeys.map((k) => r.fields?.[k]),
      p?.lat, p?.lng, p?.acc, photosByRecord[r.id] ?? 0,
      r.observedAt, r.updatedAt, names[r.updatedBy] ?? r.updatedBy ?? '', r.version, r.deleted ? 'yes' : 'no',
    ].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
