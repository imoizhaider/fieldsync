// Storage on this device: how full it is and what can safely be cleared.
import { html, render, bytes } from '../html.js';
import { db, getMeta } from '../db.js';
import { storageEstimate } from '../queries.js';
import { freeSyncedPhotos } from '../store.js';
import { syncNow, state } from '../sync.js';

export async function mount(el) {
  let message = null;

  async function paint() {
    const estimate = await storageEstimate();
    let synced = 0; let pending = 0; let photoBytes = 0;
    await db.media.each((m) => {
      if (m.blob) photoBytes += m.blob.size;
      if (m.uploaded) { if (m.blob) synced++; } else pending++;
    });
    const persisted = await getMeta('persisted');
    const pct = estimate?.pct ?? 0;
    const full = pct >= 80;

    render(el, html`
      <div class="scroll">
        <div class="pad" style="padding-top:12px">
          <div class="notice ${full ? 'bad' : 'ink'}" id="storage-card">
            <h2>${full ? 'Storage almost full' : 'Storage is fine'}</h2>
            <p>${full ? 'New photos may fail to save. Sync, then free space.' : 'There is room for more records and photos on this device.'}</p>
            <div class="bar ${full ? 'danger' : ''}" style="height:6px;margin-top:12px"><i style="width:${Math.max(1, pct)}%"></i></div>
            <div class="row-line small ${full ? 'error-text' : 'muted'}" style="margin-top:6px"><span>${pct}% used</span><span>Photos ${bytes(photoBytes)}</span></div>
          </div>
        </div>
        <header class="head" style="margin-top:8px"><div class="eyebrow">This device</div><h1 class="title">Storage</h1></header>
        <ul class="rows">
          <li class="row"><div class="row-line"><span><span class="row-title" style="display:block">Synced photos</span>
            <span class="row-meta" id="synced-photos">${synced} / can be cleared</span></span><span class="status plain synced">Freeable</span></div></li>
          <li class="row"><div class="row-line"><span><span class="row-title" style="display:block">Pending photos</span>
            <span class="row-meta">${pending} / not uploaded yet</span></span><span class="status plain pending">Kept</span></div></li>
          <li class="row"><div class="row-line"><span><span class="row-title" style="display:block">Records and GPS logs</span>
            <span class="row-meta">small, always kept</span></span><span class="status plain queued">Kept</span></div></li>
          <li class="row"><div class="row-line"><span><span class="row-title" style="display:block">Storage protection</span>
            <span class="row-meta">asks the browser not to clear this data</span></span>
            <span class="status plain ${persisted ? 'synced' : 'queued'}">${persisted ? 'Granted' : 'Requested'}</span></div></li>
        </ul>
        <p class="pad muted small" style="padding-top:12px">Photos already on the server can be removed from this device. Pending ones stay until they upload.</p>
        ${message ? html`<p class="pad small" role="status" style="padding-top:8px">${message}</p>` : ''}
      </div>
      <div class="foot">
        <button class="btn block" data-act="sync" ${state.online ? '' : 'disabled'}>Sync now</button>
        <button class="btn secondary block" data-act="free" id="free-space" ${synced === 0 ? 'disabled' : ''}>Free space from synced photos</button>
      </div>`);
  }

  el.addEventListener('click', async (ev) => {
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (act === 'sync') syncNow({ manual: true });
    if (act === 'free') {
      const n = await freeSyncedPhotos();
      message = `Removed ${n} synced ${n === 1 ? 'photo' : 'photos'} from this device. They are still on the server.`;
      await paint();
    }
  });

  await paint();
  return { update: paint };
}
