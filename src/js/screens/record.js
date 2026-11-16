// Record detail, with the delete confirmation sheet.
import { html, render, hhmm, coords, go, openSheet, pad2 } from '../html.js';
import { db, getMeta } from '../db.js';
import { currentRegion, regionView, regions, canEdit, profileNames } from '../queries.js';
import { formatLabel, recordTitle, TYPES, fieldLabel } from '../merge.js';
import { deleteRecord } from '../store.js';
import { fetchPhotoBlob } from '../sync.js';
import { currentUser } from '../auth.js';

const STATUS_TEXT = { pending: 'Pending', synced: 'Synced', conflict: 'Conflict', failed: 'Failed', deleted: 'Deleted' };
const STATUS_TITLE = { pending: 'Pending sync', failed: 'Rejected by the server' };

function show(v) {
  return v === null || v === undefined || v === '' ? '--' : String(v);
}

export async function mount(el, params) {
  let urls = [];
  const asked = new Set();
  let recordId = null;

  async function paint(kind) {
    if (kind === 'sync') return; // only local data changes matter here
    let id = params.arg;
    const region = await currentRegion();
    if (id === 'first') {
      id = region ? (await regionView(region.id)).live[0]?.record.id : null;
    }
    recordId = id;
    const rec = id ? await db.records.get(id) : null;
    if (!rec) {
      render(el, html`<div class="scroll"><div class="pad" style="padding-top:32px">
        <h2 class="reading">${params.split ? 'No record selected' : 'Record not found'}</h2>
        <p class="muted" style="margin-top:8px">${params.split ? 'Create a record or pick one from the list.' : 'It may not have reached this device yet.'}</p>
        ${params.split ? '' : html`<p style="margin-top:16px"><a class="btn secondary" href="#/records">Back to records</a></p>`}
      </div></div>`);
      return;
    }

    const [recRegionList, view, media, gps, names, myDevice] = await Promise.all([
      regions(), regionView(rec.regionId), db.media.where('recordId').equals(id).sortBy('position'),
      db.gpsLogs.where('recordId').equals(id).first(), profileNames(), getMeta('deviceId'),
    ]);
    const recRegion = recRegionList.find((r) => r.id === rec.regionId);
    const row = view.rows.find((x) => x.record.id === id);
    const status = row?.status ?? 'synced';
    const def = TYPES[rec.type];
    const point = gps?.points?.[0];
    const label = formatLabel(rec.type, rec.seq);
    const editable = canEdit(recRegion) && !rec.deleted;
    const regionLabel = (recRegion?.name ?? 'region').replace(/^./, (c) => c.toLowerCase());
    const who = (uid, dev) => (dev && dev === myDevice ? 'This device' : uid === currentUser()?.id ? 'You' : names[uid] ?? 'Another device');

    for (const u of urls) URL.revokeObjectURL(u);
    urls = [];
    const tiles = media.map((m, i) => {
      let style = '';
      if (m.blob) {
        const u = URL.createObjectURL(m.blob);
        urls.push(u);
        style = `background-image:url(${u})`;
      } else if (!asked.has(m.id)) {
        asked.add(m.id);
        fetchPhotoBlob(m.id).then((b) => { if (b) paint('data'); });
      }
      return html`<div class="photo ${m.blob ? 'has-img' : ''}" style="${style}" data-photo-id="${m.id}"><span>${pad2(i + 1)}</span></div>`;
    });

    const fieldConflicts = (row?.conflicts ?? []).filter((c) => c.kind === 'same_field');
    const history = [
      ...(rec.history ?? []).map((h) => ({ at: h.at, text: h.text })),
      ...(await getMeta('conflicts', [])).filter((c) => c.record_id === id && c.kind === 'same_field')
        .map((c) => ({ at: c.at, text: `${who(c.kept_by, c.kept_device)} set ${fieldLabel(c.field)} to ${show(c.kept_value)}` })),
    ].sort((a, b) => (a.at < b.at ? 1 : -1));

    const statusEl = html`<span class="status ${status}" id="record-status" title="${STATUS_TITLE[status] ?? STATUS_TEXT[status]}">${STATUS_TEXT[status]}</span>`;
    const conflictNote = fieldConflicts.map((c) => html`
      <div class="pad" style="padding-bottom:12px"><div class="notice warn">
        <span class="grow"><b>Conflict on ${fieldLabel(c.field)}.</b> ${who(c.kept_by, c.kept_device)} changed it later, so ${show(c.kept_value)} was kept.
          ${c.lost_by === currentUser()?.id ? 'Your' : `${names[c.lost_by] ?? 'The other'}'s`} ${show(c.lost_value)} is saved in the log.</span>
        <a class="btn secondary compact" href="#/conflicts">Review</a></div></div>`);

    const body = html`
      ${rec.deleted ? html`<div class="pad" style="padding-bottom:12px"><div class="notice"><b>This record was deleted.</b> A data lead can restore it from the conflict log.</div></div>` : ''}
      ${conflictNote}
      <div class="readings ${params.split ? 'wide' : ''}">
        ${def.readings.map((r) => html`<div><div class="label">${params.split ? r.label : r.short}</div>
          <div class="reading" data-field="${r.key}">${show(rec.fields?.[r.key])}${r.unit && rec.fields?.[r.key] != null ? html`<span class="unit">${r.unit}</span>` : ''}</div></div>`)}
      </div>
      <div class="section-label">Photos / ${media.length}</div>
      <div class="photos" id="photos">${tiles}${media.length === 0 ? html`<span class="muted small">No photos</span>` : ''}</div>
      <div class="pad" style="padding-top:14px">
        <p class="notes-text" data-field="notes" dir="auto">${rec.fields?.notes ? rec.fields.notes : html`<span class="muted">No notes</span>`}</p>
        <p class="small" style="margin-top:8px" id="gps-line">${point ? html`${coords(point)} <span class="muted">+/- ${point.acc} m</span>` : html`<span class="muted">No GPS point</span>`}</p>
      </div>
      <div class="section-label ink" style="margin-top:14px">History</div>
      <div class="pad">${history.map((h) => html`<div class="kv" style="border-top:0"><span>${h.text}</span><span class="v muted">${hhmm(h.at)}</span></div>`)}</div>`;

    if (params.split) {
      render(el, html`
        <div class="scroll" style="padding-bottom:24px">
          <div class="detail-head">
            <div class="grow"><div class="eyebrow">${label} / ${regionLabel}</div>
              <h1 class="title" id="record-title" dir="auto">${recordTitle(rec)}</h1></div>
            ${statusEl}
            ${editable ? html`<a class="btn secondary compact" href="#/edit/${id}" id="edit-record">Edit</a>
              <button class="btn danger compact" data-act="delete" id="delete-record">Delete</button>` : ''}
          </div>
          ${body}
        </div>`);
    } else {
      render(el, html`
        <header class="head-back">
          <a class="back" href="#/records" aria-label="Back">&larr;</a>
          <div class="grow"><h1 id="record-title" dir="auto">${recordTitle(rec)}</h1><span class="eyebrow">${label} / ${regionLabel}</span></div>
        </header>
        <div class="scroll" style="padding-bottom:16px">
          <div class="pad" style="padding:12px 16px">${statusEl}</div>
          ${body}
        </div>
        ${editable ? html`<div class="foot pair-row">
          <a class="btn" href="#/edit/${id}" id="edit-record">Edit</a>
          <button class="btn danger" data-act="delete" id="delete-record">Delete</button></div>` : ''}`);
    }
    el.dataset.recordId = id;
  }

  el.addEventListener('click', async (ev) => {
    if (!ev.target.closest('[data-act="delete"]') || !recordId) return;
    const rec = await db.records.get(recordId);
    const photos = await db.media.where('recordId').equals(recordId).count();
    const gps = await db.gpsLogs.where('recordId').equals(recordId).count();
    const fieldCount = Object.values(rec.fields ?? {}).filter((v) => v !== null && v !== '').length;
    const label = formatLabel(rec.type, rec.seq);
    openSheet(html`
      <div class="small error-text">Delete record</div>
      <h2>Delete ${label}?</h2>
      <p class="muted">It disappears here now and on other devices after sync. Your data lead can restore it.</p>
      <div class="section-label ink" style="margin:14px 0 0">This removes</div>
      <div class="kv" style="border-top:0"><span>Photos</span><span class="v muted">${photos}</span></div>
      <div class="kv" style="border-top:0"><span>GPS point</span><span class="v muted">${gps}</span></div>
      <div class="kv" style="border-top:0"><span>Readings and notes</span><span class="v muted">${fieldCount} fields</span></div>
      <div class="actions">
        <button class="btn secondary" data-act="keep">Keep record</button>
        <button class="btn danger-solid" data-act="confirm" id="confirm-delete">Delete</button>
      </div>`, {
      confirm: async (close) => {
        await deleteRecord(recordId);
        close();
        go('#/records');
      },
    });
  });

  await paint('data');
  return { update: paint, destroy: () => { for (const u of urls) URL.revokeObjectURL(u); } };
}
