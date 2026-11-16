// Record list ("Observations"): also the Syncing, Back online, All synced and
// First run states from the design.
import { html, render, hhmm, pad2 } from '../html.js';
import { currentRegion, regionView, canEdit, storageEstimate } from '../queries.js';
import { formatLabel, recordTitle, summaryLine, TYPES } from '../merge.js';
import { state, syncNow } from '../sync.js';
import { isIos, isStandalone } from '../device.js';

const STATUS_TEXT = {
  pending: 'Pending', synced: 'Synced', conflict: 'Conflict', failed: 'Failed',
  waiting: 'Waiting', uploading: 'Uploading', deleted: 'Deleted',
};
const STATUS_TITLE = { pending: 'Pending sync', failed: 'Rejected by the server', waiting: 'Waiting to upload' };

let filter = 'all';
let hideInstallHint = false;

// Progress of the record that is uploading right now.
function uploadProgress(row) {
  const done = state.recent.filter((e) => e.recordId === row.record.id);
  const left = row.ops.entries.filter((e) => e.status !== 'rejected');
  const total = done.length + left.length;
  const isPhoto = (e) => e.table === 'media' && e.kind === 'upsert';
  const photosDone = done.filter(isPhoto).length;
  const photosAll = photosDone + left.filter(isPhoto).length;
  const text = state.current && isPhoto(state.current)
    ? `Uploading photo ${Math.min(photosDone + 1, photosAll)} of ${photosAll}`
    : 'Uploading record';
  return { text, pct: total ? Math.round((done.length / total) * 100) : 0 };
}

function rowTemplate(row, selectedId) {
  const r = row.record;
  let status = row.status;
  let meta = summaryLine(r, row.photos, row.hasGps);
  let bar = null;
  if (status === 'pending' && state.online) {
    if (state.phase === 'pushing' && state.current?.recordId === r.id) {
      const p = uploadProgress(row);
      status = 'uploading'; meta = p.text; bar = p.pct;
    } else if (state.phase === 'pushing' || state.phase === 'starting') {
      status = 'waiting'; meta = 'Next in line';
    } else if (state.reconnected > 0) {
      status = 'waiting';
    }
  }
  return html`
    <li><a class="row ${r.id === selectedId ? 'selected' : ''}" href="#/record/${r.id}" data-record-id="${r.id}" data-status="${status}">
      <div class="row-top"><span class="label">${formatLabel(r.type, r.seq)}</span><span class="label">${hhmm(r.observedAt)}</span></div>
      <div class="row-title" dir="auto">${recordTitle(r)}</div>
      <div class="row-bottom"><span class="row-meta">${meta}</span>
        <span class="status ${status}" title="${STATUS_TITLE[status] ?? STATUS_TEXT[status]}">${STATUS_TEXT[status]}</span></div>
      ${bar === null ? '' : html`<div class="bar"><i style="width:${bar}%"></i></div>`}
    </a></li>`;
}

export async function mount(el, params) {
  async function paint() {
    const region = await currentRegion();
    if (!region) {
      render(el, html`
        <header class="head"><a class="eyebrow" href="#/regions">No region yet</a><h1 class="title">Observations</h1></header>
        <div class="scroll"><div class="pad" style="padding-top:24px">
          <h2 class="reading">Getting your regions</h2>
          <p class="muted" style="margin-top:8px">${state.online
            ? 'Your regions load on the first sync. This takes a moment.'
            : 'Connect once so this device can load the regions you are assigned to.'}</p>
        </div></div>
        <div class="foot"><button class="btn secondary block" data-act="sync">Sync now</button></div>`);
      return;
    }
    const view = await regionView(region.id);
    const estimate = await storageEstimate();
    const rows = view.live.filter((x) => filter === 'all' || x.record.type === filter);
    const selectedId = params.selected === 'first' ? view.live[0]?.record.id : params.selected;
    const editable = canEdit(region);
    const syncing = state.online && state.phase !== 'idle' && state.total > 0;
    const c = view.counts;

    const banners = html`
      ${isIos() && !isStandalone() && !hideInstallHint ? html`
        <div class="pad" style="padding-top:12px"><div class="notice warn small">
          <span class="grow"><b>Add to Home Screen.</b> Safari can clear site data after weeks unused. Installing protects your records.</span>
          <a class="btn secondary compact" href="#/install">How</a></div></div>` : ''}
      ${state.reconnected > 0 ? html`
        <div class="pad" style="padding-top:12px"><div class="notice good" id="back-online">
          <b>You are back online.</b> Uploading ${state.reconnected} ${state.reconnected === 1 ? 'change' : 'changes'} now. You do not need to do anything.</div></div>` : ''}
      ${estimate && estimate.pct >= 80 ? html`
        <div class="pad" style="padding-top:12px"><div class="notice bad small" style="display:flex;align-items:center;gap:12px">
          <span class="grow"><b>Storage almost full.</b> ${estimate.pct}% used. Sync, then free space.</span>
          <a class="btn secondary compact" href="#/storage">Open</a></div></div>` : ''}`;

    // First stop for the keyboard: straight to a new record, past the whole list.
    const head = html`
      ${editable ? html`<a class="btn compact skip" href="#/new" id="skip-new">Skip to New record</a>` : ''}
      <header class="head">
        <a class="eyebrow" href="#/regions" id="region-link">${region.name} / ${c.total} ${c.total === 1 ? 'record' : 'records'}</a>
        <h1 class="title">Observations</h1>
      </header>`;
    const stats = html`
      <div class="stats" id="stats">
        <div><div class="num ${c.pending ? 'pending' : ''}" data-stat="pending">${pad2(c.pending)}</div><div class="label">Pending</div></div>
        <div><div class="num ${c.synced ? 'synced' : ''}" data-stat="synced">${pad2(c.synced)}</div><div class="label">Synced</div></div>
        <div><div class="num ${c.conflicts ? 'conflict' : ''}" data-stat="conflicts">${pad2(c.conflicts)}</div><div class="label">Conflicts</div></div>
      </div>`;

    if (c.total === 0) {
      render(el, html`
        ${head}${stats}
        <div class="scroll">${banners}
          <div class="pad" style="padding-top:28px">
            <h2 class="reading" style="font-weight:600">No records yet</h2>
            <p class="muted" style="margin:8px 0 20px">Everything you record is saved on this device first. It uploads on its own when you have signal.</p>
            <div class="kv"><span>App works offline</span><span class="v ${navigator.serviceWorker?.controller ? '' : 'muted'}">${navigator.serviceWorker?.controller ? 'Ready' : 'Preparing'}</span></div>
            <div class="kv"><span>Signed in on this device</span><span class="v">Ready</span></div>
            ${editable ? '' : html`<div class="notice" style="margin-top:16px"><b>${region.name} is view only.</b> New records are blocked on this device.</div>`}
          </div>
        </div>
        <div class="foot">
          ${editable ? html`<a class="btn block" href="#/new" id="new-record">Create first record</a>` : ''}
          <button class="btn secondary block" data-act="sync">Sync now</button>
        </div>`);
      return;
    }

    render(el, html`
      ${head}${stats}
      <div class="tabs" role="tablist">
        ${['all', 'soil', 'water', 'wildlife'].map((t) => html`
          <button role="tab" aria-selected="${filter === t}" data-filter="${t}">${t === 'all' ? 'All' : TYPES[t].label}</button>`)}
      </div>
      <div class="scroll">${banners}
        <ul class="rows" id="record-list">${rows.map((x) => rowTemplate(x, selectedId))}</ul>
        ${rows.length === 0 ? html`<p class="pad muted" style="padding-top:16px">No ${filter} records in ${region.name}.</p>` : ''}
        ${c.conflicts > 0 ? html`
          <div class="row"><div class="row-line"><span>${c.conflicts} ${c.conflicts === 1 ? 'conflict' : 'conflicts'} saved to the log</span>
            <a class="btn secondary compact" href="#/conflicts">Review</a></div></div>` : ''}
      </div>
      ${state.justSynced && state.online && state.pendingOps === 0 ? html`<div class="toast" id="all-uploaded"><span aria-hidden="true">&#10003;</span> All changes uploaded</div>` : ''}
      ${syncing ? html`<p class="foot-note" style="padding-bottom:8px">You can keep working while this runs.</p>` : ''}
      ${editable
        ? html`<div class="foot"><a class="btn block" href="#/new" id="new-record">New record</a></div>`
        : html`<div class="foot"><div class="notice small"><b>${region.name} is view only.</b> New records and edits are blocked on this device.</div></div>`}`);
  }

  el.addEventListener('click', (ev) => {
    const tab = ev.target.closest('[data-filter]');
    if (tab) { filter = tab.dataset.filter; paint(); return; }
    if (ev.target.closest('[data-act="sync"]')) syncNow({ manual: true });
    if (ev.target.closest('a[href="#/install"]')) hideInstallHint = true;
  });

  await paint();
  return { update: paint };
}
