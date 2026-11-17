// A saved GPS track: its plotted trace, distance, time, accuracy and every point.
// Opened from the Tracks list (#/track/<id>). Same card as the recorder in the
// GPS tracks design, read-only.
import { html, render, clock, hhmm, go, openSheet } from '../html.js';
import { db } from '../db.js';
import { regions, canEdit } from '../queries.js';
import { formatLabel } from '../merge.js';
import { deleteTrack } from '../store.js';
import { plot } from './tracks.js';

const km = (m) => ((m ?? 0) / 1000).toFixed(2);
const durationMs = (g) => g.elapsedMs ?? (g.startedAt && g.endedAt ? new Date(g.endedAt) - new Date(g.startedAt) : 0);
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '--');
const deg = (v, pos, neg) => (typeof v === 'number' ? `${Math.abs(v).toFixed(5)} ${v >= 0 ? pos : neg}` : '--');

export async function mount(el, params) {
  const id = params.arg;

  async function paint(kind) {
    if (kind === 'sync') return;
    const g = id ? await db.gpsLogs.get(id) : null;
    if (!g || g.kind !== 'track') {
      render(el, html`<header class="head-back"><a class="back" href="#/tracks" aria-label="Back to tracks">&larr;</a>
        <div class="grow"><h1>Track not found</h1></div></header>
        <div class="scroll"><p class="pad muted" style="padding-top:16px">It may have been deleted, or it has not reached this device yet.</p></div>`);
      return;
    }
    const region = (await regions()).find((r) => r.id === g.regionId);
    const pending = (await db.outbox.where('rowId').equals(g.id).count()) > 0;
    const points = Array.isArray(g.points) ? g.points : [];
    const accs = points.map((p) => p.acc).filter((a) => typeof a === 'number');
    const acc = accs.length ? `${Math.round(accs.reduce((s, a) => s + a, 0) / accs.length)} m` : '-- m';
    const editable = canEdit(region);

    render(el, html`
      <header class="head-back">
        <a class="back" href="#/tracks" aria-label="Back to tracks">&larr;</a>
        <div class="grow"><h1 id="track-title" dir="auto">${g.name || 'Track'}</h1>
          <span class="eyebrow">${formatLabel('track', g.seq)} / ${region?.name ?? 'region'}</span></div>
      </header>
      <div class="scroll" id="track-detail" style="padding-top:12px">
        <div class="recorder" data-status="saved">
          <div class="top">
            <span class="status ${pending ? 'pending' : 'synced'}" title="${pending ? 'Pending sync' : 'Synced'}">${pending ? 'Pending' : 'Synced'}</span>
            <span class="label">${day(g.startedAt)}</span>
          </div>
          <div class="clock" id="track-duration" aria-label="Duration">${clock(durationMs(g))}</div>
          ${plot(points)}
          <div class="caption">Plotted trace / start black, end red / no basemap</div>
          <div class="stats">
            <div><div class="num" id="track-km">${km(g.distanceM)}</div><div class="label">KM</div></div>
            <div><div class="num" id="track-points">${points.length}</div><div class="label">Points</div></div>
            <div><div class="num">${acc}</div><div class="label">Avg accuracy</div></div>
          </div>
        </div>
        <dl class="track-times">
          <div><dt>Started</dt><dd id="track-start">${hhmm(g.startedAt)}</dd></div>
          <div><dt>Ended</dt><dd id="track-end">${hhmm(g.endedAt)}</dd></div>
        </dl>
        <div class="section-label ruled" style="margin-top:8px">Points / ${points.length}</div>
        <ol class="point-list" id="track-points-list">
          ${points.map((p, i) => html`<li><span class="n">${i + 1}</span><span class="t">${hhmm(p.t)}</span>
            <span class="ll">${deg(p.lat, 'n', 's')}, ${deg(p.lng, 'e', 'w')}</span><span class="acc">+/- ${p.acc ?? '--'} m</span></li>`)}
        </ol>
      </div>
      ${editable ? html`<div class="foot ruled"><button class="btn danger block" data-act="delete" id="track-delete">Delete track</button></div>` : ''}`);
  }

  el.addEventListener('click', async (ev) => {
    if (ev.target.closest('[data-act]')?.dataset.act !== 'delete') return;
    const g = await db.gpsLogs.get(id);
    if (!g) return;
    openSheet(html`
      <div class="eyebrow">${formatLabel('track', g.seq)}</div>
      <h2>Delete ${g.name || 'this track'}?</h2>
      <p class="muted">${(g.points?.length ?? 0)} points / ${km(g.distanceM)} KM. It is removed from every device on the next sync.</p>
      <div class="actions"><button class="btn secondary" data-act="keep">Keep track</button>
        <button class="btn danger" data-act="remove" id="confirm-track-delete">Delete track</button></div>`, {
      remove: async (close) => { await deleteTrack(g.id); close(); go('#/tracks'); },
    });
  });

  await paint();
  return { update: (kind) => paint(kind) };
}
