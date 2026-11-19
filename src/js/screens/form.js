// New record / edit record, plus the "Permissions blocked" view.
import { html, render, coords, go, isWide, pad2 } from '../html.js';
import { db } from '../db.js';
import { currentRegion, regions, canEdit } from '../queries.js';
import { TYPES, formatLabel, parseReading } from '../merge.js';
import { createRecord, updateRecord, proposedSeq } from '../store.js';
import { compressPhoto, getPoint, watchPermission, PHOTO_MAX_SIDE, UNREADABLE_PHOTO } from '../device.js';

// The draft lives outside the screen so it survives a trip to the
// permissions view and back.
let draft = null;

async function newDraft() {
  const region = await currentRegion();
  return {
    mode: 'new', id: null, regionId: region?.id ?? null, regionName: region?.name ?? '', editable: canEdit(region),
    type: 'soil', fields: {}, original: {}, photos: [], existing: [], removed: [],
    gps: null, gpsState: 'idle', gpsChanged: false, camera: 'prompt', view: 'form', seq: null, busy: false, error: null, invalid: {},
  };
}

async function editDraft(id) {
  const rec = await db.records.get(id);
  if (!rec) return null;
  const region = (await regions()).find((r) => r.id === rec.regionId);
  const media = await db.media.where('recordId').equals(id).sortBy('position');
  const gps = await db.gpsLogs.where('recordId').equals(id).first();
  return {
    mode: 'edit', id, regionId: rec.regionId, regionName: region?.name ?? '', editable: canEdit(region) && !rec.deleted,
    type: rec.type, fields: { ...rec.fields }, original: { ...rec.fields }, photos: [],
    existing: media.map((m) => ({ id: m.id, blob: m.blob })), removed: [],
    gps: gps?.points?.[0] ?? null, gpsState: gps?.points?.[0] ? 'fixed' : 'none', gpsChanged: false,
    camera: 'prompt', view: 'form', seq: rec.seq, busy: false, error: null, invalid: {},
  };
}

// Reads the form. A reading that is not a number, or is outside its range, is
// never saved: it comes back in `invalid` (field key -> message) instead.
function collectFields(d) {
  const fields = d.mode === 'edit' ? { ...d.original } : {};
  const invalid = {};
  const text = (v) => String(v ?? '').trim() || null;
  fields.title = text(d.fields.title);
  fields.notes = text(d.fields.notes);
  for (const r of TYPES[d.type].readings) {
    const parsed = parseReading(r, d.fields[r.key]);
    if (parsed.error) invalid[r.key] = parsed.error; else fields[r.key] = parsed.value;
  }
  return { fields, invalid };
}

export async function mount(el, params) {
  let urls = [];
  let alive = true;

  if (params.name === 'edit') {
    if (!draft || draft.id !== params.arg) draft = await editDraft(params.arg);
  } else if (!draft || draft.mode !== 'new') {
    draft = await newDraft();
  }
  if (!draft) {
    render(el, html`<div class="scroll"><div class="pad" style="padding-top:32px"><h2 class="reading">Record not found</h2>
      <p style="margin-top:16px"><a class="btn secondary" href="#/records">Back to records</a></p></div></div>`);
    return {};
  }
  const d = draft;
  d.view = params.name === 'permissions' ? 'permissions' : 'form';
  // Known ahead of the tap: the photo picker has to open in the tap itself
  // (Safari on the iPhone ignores a click() made after an await).
  const stopWatch = watchPermission('camera', (s) => { d.camera = s; });
  if (d.mode === 'new' && d.seq === null && d.regionId) d.seq = await proposedSeq(d.regionId, d.type);

  function gpsBox() {
    const title = { idle: 'GPS / not captured', searching: 'GPS / searching', fixed: 'GPS / fixed', blocked: 'GPS / blocked', none: 'GPS / not captured' }[d.gpsState];
    const hint = d.gpsState === 'blocked' ? 'Location access is blocked' : d.gpsState === 'searching' ? 'Waiting for a fix' : (d.gpsError ?? 'No point yet');
    return html`
      <div class="gps-box" id="gps-box" data-gps="${d.gpsState}">
        <div class="grow"><div class="label">${title}</div>
          ${d.gps ? html`<div class="strong">${coords(d.gps)}</div><div class="label">+/- ${d.gps.acc} m</div>`
            : html`<div class="muted small">${hint}</div>`}
        </div>
        ${d.gpsState === 'blocked'
          ? html`<a class="btn secondary compact" href="#/permissions">Fix</a>`
          : html`<button type="button" class="btn secondary compact" data-act="gps" ${d.gpsState === 'searching' ? 'disabled' : ''}>${d.gps ? 'Recapture' : 'Capture'}</button>`}
      </div>`;
  }

  // Repaint only the GPS box, so typing in the form is never interrupted.
  function paintGps() {
    if (!alive) return;
    const box = el.querySelector('#gps-box');
    if (box && d.view === 'form') box.outerHTML = gpsBox().__raw; else paint();
  }

  async function captureGps() {
    d.gpsState = 'searching';
    d.gpsError = null;
    paintGps();
    try {
      d.gps = await getPoint();
      d.gpsState = 'fixed';
      d.gpsChanged = true;
    } catch (err) {
      d.gpsState = err.denied ? 'blocked' : (d.gps ? 'fixed' : 'none');
      if (!err.denied) d.gpsError = 'No GPS fix yet. Try again in the open.';
    }
    paintGps();
  }

  function paintPermissions() {
    const label = `${formatLabel(d.type, d.seq)} / ${d.mode === 'new' ? 'draft' : d.regionName.replace(/^./, (c) => c.toLowerCase())}`;
    const badge = (s) => (s === 'denied' || s === 'blocked'
      ? html`<span class="status plain failed">Blocked</span>` : html`<span class="status plain synced">${s === 'granted' || s === 'fixed' ? 'Allowed' : 'Not asked yet'}</span>`);
    render(el, html`
      <header class="head-back">
        <a class="back" href="#/${d.mode === 'new' ? 'new' : `edit/${d.id}`}" aria-label="Back">&larr;</a>
        <div class="grow"><h1>Permissions</h1><span class="eyebrow">${label}</span></div>
      </header>
      <div class="scroll">
        <div class="row">
          <div class="row-line"><span class="row-title">Camera</span>${badge(d.camera)}</div>
          <p class="muted" style="margin:6px 0 12px">Allow camera access in your browser site settings, then try again. You can also pick photos already on this device.</p>
          <div class="wrap-row"><button class="btn compact" data-act="camera-retry">Try again</button>
            <button class="btn secondary compact" data-act="library">Choose from library</button></div>
        </div>
        <div class="row">
          <div class="row-line"><span class="row-title">Location</span>${badge(d.gpsState)}</div>
          <p class="muted" style="margin:6px 0 12px">Without location access no GPS point can be saved. You can save the record now and add a point later.</p>
          <div class="wrap-row"><button class="btn compact" data-act="gps-retry">Try again</button>
            <button class="btn secondary compact" data-act="save">Save without GPS</button></div>
        </div>
        <p class="pad muted small" style="padding-top:12px">Permissions are set in the browser, not in fieldsync.</p>
        ${d.error ? html`<p class="pad error-text small" role="alert" style="padding-top:8px">${d.error}</p>` : ''}
      </div>
      <input type="file" accept="image/*" capture="environment" multiple class="file-input" tabindex="-1" aria-hidden="true" id="camera-input">
      <input type="file" accept="image/*" multiple class="file-input" tabindex="-1" aria-hidden="true" id="library-input">`);
  }

  function paint() {
    if (!alive) return;
    if (d.view === 'permissions') { paintPermissions(); return; }
    const def = TYPES[d.type];
    for (const u of urls) URL.revokeObjectURL(u);
    urls = [];
    const tile = (blob, n, attr) => {
      let style = '';
      if (blob) { const u = URL.createObjectURL(blob); urls.push(u); style = `background-image:url(${u})`; }
      return html`<div class="photo ${blob ? 'has-img' : ''}" style="${style}"><span>${pad2(n)}</span>
        <button class="remove" ${attr} aria-label="Remove photo ${n}" title="Remove photo ${n}"></button></div>`;
    };
    const kept = d.existing.filter((m) => !d.removed.includes(m.id));
    const total = kept.length + d.photos.length;
    const tiles = [
      ...kept.map((m, i) => tile(m.blob, i + 1, html`data-remove-existing="${m.id}"`)),
      ...d.photos.map((p, i) => tile(p.blob, kept.length + i + 1, html`data-remove-new="${i}"`)),
    ];
    const heading = d.mode === 'new' ? `New ${def.noun}` : `Edit ${def.noun}`;
    const sub = `${formatLabel(d.type, d.seq)} / ${d.mode === 'new' ? 'draft' : d.regionName.replace(/^./, (c) => c.toLowerCase())}`;

    render(el, html`
      <header class="head-back">
        <a class="back" href="${d.mode === 'new' ? '#/records' : `#/record/${d.id}`}" aria-label="Back" data-act="cancel">&larr;</a>
        <div class="grow"><h1>${heading}</h1><span class="eyebrow" id="draft-label">${sub}</span></div>
      </header>
      <form class="scroll" id="record-form" novalidate autocomplete="off">
        <div class="pad stack" style="padding-top:14px;padding-bottom:16px">
          ${d.editable ? '' : html`<div class="notice"><b>${d.regionName || 'This region'} is view only.</b> New records and edits are blocked on this device.</div>`}
          <div class="segmented" role="group" aria-label="Record type">
            ${Object.entries(TYPES).map(([key, t]) => html`
              <button type="button" data-type="${key}" aria-pressed="${d.type === key}" ${d.mode === 'edit' ? 'disabled' : ''}>${t.label}</button>`)}
          </div>
          <label class="field"><span class="label">Title</span>
            <input name="title" data-field="title" dir="auto" value="${d.fields.title ?? ''}" placeholder="${def.noun.charAt(0).toUpperCase() + def.noun.slice(1)}, north transect" maxlength="80"></label>
          <div class="grid2">
            ${def.readings.map((r) => html`
              <label class="field ${d.invalid[r.key] ? 'invalid' : ''}"><span class="label">${r.label}</span>
                <input class="reading" name="${r.key}" data-field="${r.key}" value="${d.fields[r.key] ?? ''}"
                  ${r.kind === 'number' ? html`inputmode="decimal"` : ''} maxlength="40"
                  ${d.invalid[r.key] ? html`aria-invalid="true" aria-describedby="field-errors"` : ''}>
                ${r.unit ? html`<span class="unit">${r.unit}</span>` : ''}</label>`)}
          </div>
          ${Object.keys(d.invalid).length > 0 ? html`<div class="notice outline-bad small" role="alert" id="field-errors">
            <b>Not saved.</b> ${Object.values(d.invalid).join(' ')}</div>` : ''}
          <label class="field"><span class="label">Notes</span>
            <textarea name="notes" data-field="notes" dir="auto" rows="3" maxlength="2000">${d.fields.notes ?? ''}</textarea></label>
          <div>
            <div class="section-label" style="padding:0 0 8px"><span id="photo-count">Photos / ${total}</span><span>Compressed to ${PHOTO_MAX_SIDE} px</span></div>
            <div class="photos" style="padding:0">${tiles}
              <button type="button" class="photo-add" data-act="add-photo" id="add-photo" aria-label="Add photo">${d.busy ? 'Saving' : 'Add'}</button></div>
          </div>
          ${gpsBox()}
          ${d.error ? html`<p class="error-text small" role="alert">${d.error}</p>` : ''}
        </div>
      </form>
      <div class="foot ruled">
        <button class="btn block" data-act="save" id="save-record" ${d.busy || !d.editable ? 'disabled' : ''}>${d.mode === 'new' ? 'Save to device' : 'Save changes'}</button>
        <p class="foot-note">Stored locally. Uploads on reconnect.</p>
      </div>
      <input type="file" accept="image/*" capture="environment" multiple class="file-input" tabindex="-1" aria-hidden="true" id="camera-input">
      <input type="file" accept="image/*" multiple class="file-input" tabindex="-1" aria-hidden="true" id="library-input">`);
  }

  async function addFiles(files) {
    if (!files || files.length === 0) return;
    d.busy = true; d.error = null;
    paint();
    // Each file on its own: one unreadable file (a video, a document) must not
    // drop the good photos picked with it.
    let bad = 0;
    for (const file of files) {
      try {
        d.photos.push(await compressPhoto(file));
      } catch {
        bad += 1;
      }
    }
    if (bad > 0) {
      d.error = files.length === 1 ? UNREADABLE_PHOTO
        : `${bad} of ${files.length} files could not be added. ${UNREADABLE_PHOTO}`;
    }
    d.busy = false;
    if (d.view === 'permissions') { go(d.mode === 'new' ? '#/new' : `#/edit/${d.id}`); return; }
    paint();
  }

  async function save() {
    if (d.busy || !d.editable) return;
    const { fields, invalid } = collectFields(d);
    d.invalid = invalid;
    const firstBad = Object.keys(invalid)[0];
    if (firstBad) {
      paint();
      el.querySelector(`#record-form [data-field="${firstBad}"]`)?.focus();
      return;
    }
    d.busy = true;
    try {
      let id = d.id;
      if (d.mode === 'new') {
        id = await createRecord({ regionId: d.regionId, type: d.type, fields, photos: d.photos, gps: d.gps });
      } else {
        await updateRecord(id, { fields, addPhotos: d.photos, removePhotoIds: d.removed, gps: d.gpsChanged ? d.gps : undefined });
      }
      draft = null;
      go(isWide() || d.mode === 'edit' ? `#/record/${id}` : '#/records');
    } catch (err) {
      d.busy = false;
      d.error = `Could not save on this device: ${err.message}`;
      paint();
    }
  }

  el.addEventListener('input', (ev) => {
    const key = ev.target.dataset?.field;
    if (key) d.fields[key] = ev.target.value;
  });
  el.addEventListener('change', (ev) => {
    if (ev.target.type === 'file') { addFiles([...ev.target.files]); ev.target.value = ''; }
  });
  el.addEventListener('submit', (ev) => { ev.preventDefault(); save(); });
  el.addEventListener('click', async (ev) => {
    const typeBtn = ev.target.closest('[data-type]');
    if (typeBtn && d.mode === 'new') {
      d.type = typeBtn.dataset.type;
      d.invalid = {};
      d.seq = d.regionId ? await proposedSeq(d.regionId, d.type) : null;
      paint();
      return;
    }
    const rmNew = ev.target.closest('[data-remove-new]');
    if (rmNew) { d.photos.splice(Number(rmNew.dataset.removeNew), 1); paint(); return; }
    const rmOld = ev.target.closest('[data-remove-existing]');
    if (rmOld) { d.removed.push(rmOld.dataset.removeExisting); paint(); return; }
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'cancel') { draft = null; return; }
    if (act === 'save') { ev.preventDefault(); save(); return; }
    if (act === 'gps' || act === 'gps-retry') { d.error = null; await captureGps(); return; }
    if (act === 'library') { el.querySelector('#library-input').click(); return; }
    if (act === 'add-photo' || act === 'camera-retry') {
      // No await before click(): see watchPermission above.
      // A blocked camera leads to the Permissions view first (C05).
      if (act === 'add-photo' && d.camera === 'denied') { go('#/permissions'); return; }
      // Add opens the phone's own photo menu (take a photo, or pick from the
      // library, several at once). "Try again" opens the camera even while the
      // site's camera permission reads "blocked": a file input does not use that
      // permission, the phone's own camera app takes the photo.
      el.querySelector(act === 'add-photo' ? '#library-input' : '#camera-input').click();
    }
  });

  paint();
  if (d.mode === 'new' && d.gpsState === 'idle' && d.view === 'form' && d.editable) captureGps();
  return { destroy: () => { alive = false; stopWatch(); for (const u of urls) URL.revokeObjectURL(u); } };
}
