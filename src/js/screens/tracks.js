// GPS tracks: record a walk as a list of points, plotted with no basemap.
import { html, render, clock, go } from '../html.js';
import { db, uuid } from '../db.js';
import { currentRegion, canEdit } from '../queries.js';
import { formatLabel, trackDistance } from '../merge.js';
import { saveTrackDraft, finishTrack } from '../store.js';
import { watchPoints } from '../device.js';
import { emit, on } from '../bus.js';

// The recorder lives outside the screen, so it keeps running while the
// researcher looks at other screens.
const rec = {
  status: 'idle', id: null, regionId: null, name: '', points: [], startedAt: null,
  elapsed: 0, resumedAt: null, stop: null, error: null, seq: null, unsaved: 0,
};

function elapsedMs() {
  return rec.elapsed + (rec.resumedAt ? Date.now() - rec.resumedAt : 0);
}

async function persist() {
  rec.unsaved = 0;
  await saveTrackDraft({
    id: rec.id, regionId: rec.regionId, name: rec.name, seq: rec.seq, points: rec.points,
    startedAt: rec.startedAt, endedAt: null, distanceM: trackDistance(rec.points), elapsedMs: elapsedMs(),
  });
}

function watch() {
  rec.resumedAt = Date.now();
  rec.status = 'recording';
  rec.stop = watchPoints(async (p) => {
    rec.points.push(p);
    rec.error = null;
    if (++rec.unsaved >= 5 || rec.points.length === 1) await persist();
    emit('track');
  }, (err) => {
    rec.error = err.denied ? 'Location access is blocked. Allow it in the browser site settings.' : 'Waiting for a GPS fix.';
    emit('track');
  });
}

function pause() {
  rec.stop?.();
  rec.stop = null;
  rec.elapsed = elapsedMs();
  rec.resumedAt = null;
  rec.status = 'paused';
}

function reset() {
  Object.assign(rec, { status: 'idle', id: null, points: [], startedAt: null, elapsed: 0, resumedAt: null, stop: null, error: null, seq: null, unsaved: 0, name: '' });
}

export function plot(points) {
  const W = 300; const H = 150; const P = 18;
  const grid = html`<path d="M75 0V150M150 0V150M225 0V150M0 50H300M0 100H300" stroke="#d6d4ca" stroke-width="1" fill="none"/>`;
  if (points.length === 0) return html`<svg class="plot" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="No points yet">${grid}</svg>`;
  const lats = points.map((p) => p.lat); const lngs = points.map((p) => p.lng);
  const minLat = Math.min(...lats); const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs); const maxLng = Math.max(...lngs);
  const sx = (v) => (maxLng === minLng ? W / 2 : P + ((v - minLng) / (maxLng - minLng)) * (W - 2 * P));
  const sy = (v) => (maxLat === minLat ? H / 2 : H - P - ((v - minLat) / (maxLat - minLat)) * (H - 2 * P));
  const xy = points.map((p) => [sx(p.lng).toFixed(1), sy(p.lat).toFixed(1)]);
  const last = xy[xy.length - 1];
  return html`<svg class="plot" viewBox="0 0 ${W} ${H}" role="img" aria-label="Plotted trace, ${points.length} points">${grid}
    <polyline points="${xy.map((p) => p.join(',')).join(' ')}" fill="none" stroke="#0e5a4a" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${xy[0][0]}" cy="${xy[0][1]}" r="5" fill="#111A15"/><circle cx="${last[0]}" cy="${last[1]}" r="6" fill="#c0392b"/></svg>`;
}

export async function mount(el) {
  let timer = null;
  let off = null;

  async function paint() {
    const region = await currentRegion();
    if (!region) {
      render(el, html`<header class="head"><div class="eyebrow">GPS logs</div><h1 class="title">Tracks</h1></header>
        <div class="scroll"><p class="pad muted" style="padding-top:16px">Tracks appear after this device has loaded your regions.</p></div>`);
      return;
    }
    // A recording that was cut off by a restart is finished and queued, not lost.
    const all = (await db.gpsLogs.where('regionId').equals(region.id).toArray()).filter((g) => g.kind === 'track');
    for (const g of all) {
      if (g.recording && g.id !== rec.id) await finishTrack(g.id, { name: g.name || 'Interrupted walk' });
    }
    const queued = new Set((await db.outbox.where('table').equals('gps_logs').toArray()).map((e) => e.rowId));
    const saved = all.filter((g) => g.id !== rec.id).sort((a, b) => ((a.startedAt ?? '') < (b.startedAt ?? '') ? 1 : -1));
    const nextSeq = saved.reduce((m, g) => Math.max(m, g.seq ?? 0), 0) + 1;
    const active = rec.status !== 'idle' && rec.regionId === region.id;
    const km = (trackDistance(active ? rec.points : []) / 1000).toFixed(2);
    const acc = active && rec.points.length ? `${rec.points[rec.points.length - 1].acc} m` : '-- m';
    const editable = canEdit(region);

    render(el, html`
      <header class="head"><div class="eyebrow">${region.name} / GPS logs</div><h1 class="title">Tracks</h1></header>
      <div class="scroll" style="padding-top:12px">
        <div class="recorder" id="recorder" data-status="${active ? rec.status : 'idle'}">
          <div class="top">
            <span class="status ${active && rec.status === 'recording' ? 'recording' : 'queued'}">${active ? (rec.status === 'recording' ? 'Recording' : 'Paused') : 'Ready'}</span>
            <span class="label">${formatLabel('track', active ? rec.seq : nextSeq)}</span>
          </div>
          <div class="clock" id="track-clock">${clock(active ? elapsedMs() : 0)}</div>
          ${plot(active ? rec.points : [])}
          <div class="caption">Plotted trace / no basemap offline</div>
          <div class="stats">
            <div><div class="num" id="track-km">${km}</div><div class="label">KM</div></div>
            <div><div class="num" id="track-points">${active ? rec.points.length : 0}</div><div class="label">Points</div></div>
            <div><div class="num">${acc}</div><div class="label">Accuracy</div></div>
          </div>
        </div>
        ${active && rec.error ? html`<p class="pad error-text small" role="alert" style="padding-top:8px">${rec.error}</p>` : ''}
        <div class="pad stack" style="padding-top:12px">
          ${active ? html`
            <div class="grid2">
              <button class="btn secondary" data-act="${rec.status === 'recording' ? 'pause' : 'resume'}">${rec.status === 'recording' ? 'Pause' : 'Resume'}</button>
              <button class="btn" data-act="stop" id="stop-track">Stop and save</button>
            </div>` : editable ? html`
            <label class="field"><span class="label">Track name</span><input id="track-name" maxlength="60" placeholder="Ridge walk"></label>
            <button class="btn block" data-act="start" id="start-track">Start recording</button>` : html`
            <div class="notice"><b>${region.name} is view only.</b> Tracks cannot be recorded here.</div>`}
        </div>
        <div class="section-label ruled" style="margin-top:8px">Saved / ${saved.length}</div>
        <ul class="rows" id="track-list">
          ${saved.map((g) => html`
            <li><button class="row" data-track="${g.id}" data-status="${queued.has(g.id) ? 'pending' : 'synced'}"><span class="row-line">
              <span><span class="row-title" style="display:block">${g.name || 'Track'}</span>
                <span class="row-meta">${formatLabel('track', g.seq)} / ${Math.max(1, Math.round((g.elapsedMs ?? (new Date(g.endedAt) - new Date(g.startedAt))) / 60000) || 1)} min / ${((g.distanceM ?? 0) / 1000).toFixed(2)} KM</span></span>
              <span class="status ${queued.has(g.id) ? 'pending' : 'synced'}">${queued.has(g.id) ? 'Pending' : 'Synced'}</span>
            </span></button></li>`)}
        </ul>
      </div>`);
  }

  el.addEventListener('click', async (ev) => {
    // A saved track opens on its own screen: trace, distance, time and its points.
    const trackBtn = ev.target.closest('[data-track]');
    if (trackBtn) { go(`#/track/${trackBtn.dataset.track}`); return; }
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (act === 'start') {
      const region = await currentRegion();
      const name = el.querySelector('#track-name')?.value.trim();
      const tracks = (await db.gpsLogs.where('regionId').equals(region.id).toArray()).filter((g) => g.kind === 'track');
      reset();
      Object.assign(rec, {
        id: uuid(), regionId: region.id, startedAt: new Date().toISOString(),
        seq: tracks.reduce((m, g) => Math.max(m, g.seq ?? 0), 0) + 1,
      });
      rec.name = name || `Walk, ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
      watch();
      await paint();
    } else if (act === 'pause') {
      pause(); await persist(); await paint();
    } else if (act === 'resume') {
      watch(); await paint();
    } else if (act === 'stop') {
      if (rec.status === 'recording') pause();
      const id = rec.id;
      if (rec.points.length === 0) {
        await db.gpsLogs.delete(id);
        reset();
      } else {
        await persist();
        const name = rec.name;
        reset();
        await finishTrack(id, { name });
      }
      await paint();
    }
  });

  off = on('track', paint);
  timer = setInterval(() => {
    const c = el.querySelector('#track-clock');
    if (c && rec.status !== 'idle') c.textContent = clock(elapsedMs());
  }, 1000);
  await paint();
  return { update: (kind) => (kind === 'sync' ? null : paint()), destroy: () => { clearInterval(timer); off?.(); } };
}
