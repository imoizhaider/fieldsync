// Sync screen: what is uploading, what is waiting, what was rejected.
import { html, render, mmss, bytes, openSheet, pad2 } from '../html.js';
import { db } from '../db.js';
import { conflicts } from '../queries.js';
import { formatLabel } from '../merge.js';
import { state, syncNow } from '../sync.js';
import { retryRejected } from '../store.js';

async function describe(entries) {
  const out = [];
  for (const e of entries) {
    const rec = e.recordId ? await db.records.get(e.recordId) : null;
    const label = rec ? formatLabel(rec.type, rec.seq) : '';
    let title; let detail;
    if (e.table === 'records') {
      title = `Record ${label}`;
      detail = e.kind === 'delete' ? 'delete' : e.kind === 'restore' ? 'restore' : Object.keys(e.changedFields ?? {}).length === 1
        ? `1 field: ${Object.keys(e.changedFields)[0]}` : `${Object.keys(e.changedFields ?? {}).length} fields`;
    } else if (e.table === 'media') {
      const m = await db.media.get(e.rowId);
      title = `Photo ${pad2(m?.position ?? 0)}, ${label}`;
      detail = e.kind === 'delete' ? 'remove photo' : bytes(m?.size);
    } else if (e.table === 'gps_logs') {
      const g = await db.gpsLogs.get(e.rowId);
      title = g?.kind === 'track' ? `Track ${formatLabel('track', g.seq)}` : `GPS point, ${label}`;
      detail = g?.kind === 'track' ? `${g.points?.length ?? 0} points` : 'location';
    } else {
      title = 'Conflict reviewed';
      detail = 'mark as resolved';
    }
    out.push({ e, title, detail, label });
  }
  return out;
}

export async function mount(el) {
  let timer = null;

  async function paint() {
    const outbox = await db.outbox.orderBy('seq').toArray();
    const open = (await conflicts()).filter((c) => !c.resolved).length;
    const waiting = await describe(outbox);
    const doneRows = await describe(state.recent.filter((r) => r.result === 'done' && !outbox.some((o) => o.opId === r.opId)));
    const rejected = waiting.filter((x) => x.e.status === 'rejected');
    const pushing = state.online && state.phase === 'pushing' && state.total > 0;
    const retryIn = state.retryAt && state.retryAt > Date.now() ? state.retryAt - Date.now() : 0;
    const pct = state.total ? Math.round((state.done / state.total) * 100) : 0;
    const cur = state.current ? (await describe([state.current]))[0] : null;

    let card;
    if (rejected.length > 0) {
      const labels = [...new Set(rejected.map((x) => x.label || x.title))];
      card = html`<div class="notice outline-bad" id="sync-rejected">
        <h2>Server rejected ${labels.length} ${labels.length === 1 ? 'change' : 'changes'}</h2>
        <p>${labels.join(', ')} ${labels.length === 1 ? 'was' : 'were'} not uploaded. Nothing is lost. It is still safe on this device.</p>
        <p class="small error-text" style="margin-top:8px" id="reject-reason">Reason / ${rejected[0].e.reason}</p></div>`;
    } else if (pushing) {
      card = html`<div class="notice ink" id="sync-progress">
        <div class="label">Uploading${cur?.label ? ` / ${cur.label}` : ''}</div>
        <div class="reading" style="font-weight:600">${cur?.title ?? 'Sending changes'}</div>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="row-line small muted" style="margin-top:6px"><span>${pct}%</span><span>Next pull after push</span></div></div>`;
    } else if (!state.online) {
      card = html`<div class="notice ink"><h2>Offline</h2>
        <p class="muted">${state.pending} ${state.pending === 1 ? 'change is' : 'changes are'} saved on this device. Upload starts by itself when you have signal.</p></div>`;
    } else if (retryIn > 0) {
      card = html`<div class="notice warn" id="sync-retry" style="display:block"><h2>Upload interrupted</h2>
        <p>Nothing is lost. Trying again in <span id="retry-clock">${mmss(retryIn)}</span>.</p></div>`;
    } else if (state.needsSignIn) {
      card = html`<div class="notice outline-bad"><h2>Sign-in needed</h2><p>Your session ended. Sign in again to upload. Your records stay on this device.</p></div>`;
    } else if (outbox.length === 0) {
      card = html`<div class="notice ink" id="sync-clear"><h2>Everything is uploaded</h2><p class="muted">Changes from other devices arrive on each sync.</p></div>`;
    } else {
      card = html`<div class="notice ink"><h2>${state.phase === 'idle' ? 'Waiting to upload' : 'Syncing'}</h2><p class="muted">${outbox.length} ${outbox.length === 1 ? 'change' : 'changes'} in the outbox.</p></div>`;
    }

    const status = (x) => {
      const e = x.e;
      if (e.status === 'rejected') return html`<span class="status plain failed">Failed</span>`;
      if (pushing && state.current?.opId === e.opId) return html`<span class="status plain sending">Sending</span>`;
      if (retryIn > 0 && state.failedOpId === e.opId) return html`<span class="status plain retry">Retry ${mmss(retryIn)}</span>`;
      return html`<span class="status plain queued">Queued</span>`;
    };
    const mark = (x) => (x.e.status === 'rejected' ? 'failed' : (pushing && state.current?.opId === x.e.opId) ? 'done'
      : (retryIn > 0 && state.failedOpId === x.e.opId) ? 'retry' : 'queued');

    render(el, html`
      <header class="head" style="border-bottom:0"><h1 class="title">Sync</h1></header>
      <div class="scroll">
        <div class="pad">${card}</div>
        <div class="section-label ruled">Outbox / ${outbox.length}</div>
        <ul class="rows" id="outbox-list">
          ${doneRows.map((x) => html`<li class="row" data-op-status="done"><div class="row-line">
            <span class="status done" style="font-weight:400"><span><span class="row-title" style="display:block;color:var(--ink)">${x.title}</span><span class="row-meta">uploaded</span></span></span>
            <span class="status plain done">Done</span></div></li>`)}
          ${waiting.map((x) => html`<li class="row" data-op-status="${x.e.status}"><div class="row-line">
            <span class="status ${mark(x)}" style="font-weight:400"><span><span class="row-title" style="display:block;color:var(--ink)">${x.title}</span>
              <span class="row-meta">${x.e.status === 'rejected' ? 'rejected by server' : (retryIn > 0 && state.failedOpId === x.e.opId) ? 'dropped, backoff active' : x.detail}</span></span></span>
            ${status(x)}</div></li>`)}
        </ul>
        <ul class="rows">
          <li><a class="row" href="#/storage"><span class="row-line"><span>Storage on this device</span><span class="row-meta">Open</span></span></a></li>
        </ul>
      </div>
      <div class="foot pair-row">
        ${rejected.length > 0
          ? html`<button class="btn" data-act="retry" id="retry-sync">Retry</button><button class="btn secondary" data-act="details">View details</button>`
          : html`<button class="btn" data-act="sync" id="sync-now" ${state.online ? '' : 'disabled'}>Sync now</button>
              <a class="btn secondary" href="#/conflicts" id="open-conflicts">Conflicts (${open})</a>`}
      </div>`);
  }

  el.addEventListener('click', async (ev) => {
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (act === 'sync') syncNow({ manual: true });
    if (act === 'retry') { await retryRejected(); syncNow({ manual: true }); }
    if (act === 'details') {
      const rows = await describe((await db.outbox.toArray()).filter((e) => e.status === 'rejected'));
      openSheet(html`
        <div class="small error-text">Rejected by the server</div>
        <h2>${rows.length} ${rows.length === 1 ? 'change' : 'changes'} held on this device</h2>
        ${rows.map((x) => html`<div class="kv"><span>${x.title}</span><span class="v muted" style="white-space:normal;text-align:right">${x.e.reason}</span></div>`)}
        <p class="muted small" style="margin-top:12px">Ask your data lead for edit access, then press Retry. The data stays here until it uploads.</p>
        <div class="actions"><button class="btn secondary" data-act="keep">Close</button></div>`);
    }
  });

  timer = setInterval(() => {
    if (state.retryAt && state.retryAt > Date.now()) paint();
  }, 1000);
  await paint();
  return { update: paint, destroy: () => clearInterval(timer) };
}
