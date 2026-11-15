// Review console for the data lead: one merged dataset per region, the open
// conflicts, the last sync of each device, and CSV export.
import { html, render, hhmm, pad2, go, openSheet } from '../html.js';
import { db, getMeta } from '../db.js';
import { regions, regionView, recordCounts, conflicts, profileNames, currentRegion, setCurrentRegion } from '../queries.js';
import { formatLabel, recordTitle, summaryLine, TYPES, fieldLabel, toCsv } from '../merge.js';
import { restoreRecord, resolveConflict } from '../store.js';
import { syncNow, state } from '../sync.js';
import { signOut } from '../auth.js';
import { groupConflicts } from './conflicts.js';

let section = 'dataset';

function show(v) {
  return v === null || v === undefined || v === '' ? '(empty)' : String(v);
}

async function exportCsv(region) {
  const view = await regionView(region.id);
  const names = await profileNames();
  const gpsByRecord = {};
  await db.gpsLogs.each((g) => { if (g.recordId && g.points?.[0]) gpsByRecord[g.recordId] = g.points[0]; });
  const photosByRecord = Object.fromEntries(view.rows.map((x) => [x.record.id, x.photos]));
  const csv = toCsv(view.rows.map((x) => x.record).sort((a, b) => (a.type + pad2(a.seq) < b.type + pad2(b.seq) ? -1 : 1)), { gpsByRecord, photosByRecord, names });
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `fieldsync-${region.name.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function mount(el) {
  async function paint() {
    const [regionList, region, counts, allConflicts, names, devices] = await Promise.all([
      regions(), currentRegion(), recordCounts(), conflicts(), profileNames(), getMeta('devices', []),
    ]);
    if (!region) {
      render(el, html`<div class="console"><div class="main"><h1 class="title">Regional dataset</h1>
        <p class="muted" style="margin-top:12px">Loading the regions you lead. This needs a connection the first time.</p>
        <p style="margin-top:16px"><button class="btn" data-act="refresh">Refresh</button></p></div></div>`);
      return;
    }
    const view = await regionView(region.id);
    const mine = allConflicts.filter((c) => c.region_id === region.id);
    const open = groupConflicts(mine.filter((c) => !c.resolved));
    const everything = groupConflicts(mine);
    const openRecordIds = new Set(open.map((c) => c.record_id));
    const lastSync = devices.reduce((m, d) => (d.last_sync_at > m ? d.last_sync_at : m), '');
    const deviceRows = devices.filter((d) => names[d.user_id] && names[d.user_id] !== 'Data lead');
    const labelOf = (id) => {
      const r = view.rows.find((x) => x.record.id === id)?.record;
      return r ? formatLabel(r.type, r.seq) : 'Record';
    };

    const conflictItem = (g) => (g.kind === 'same_field' ? html`
      <div class="panel-item" data-conflict="${g.id}" data-kind="same_field">
        <div class="label">${labelOf(g.record_id)} / ${fieldLabel(g.field)}${g.resolved ? ' / reviewed' : ''}</div>
        <div class="pair">
          <div class="kept"><div class="label">Kept / ${names[g.kept_by] ?? 'device'}</div><div class="reading" data-kept>${show(g.kept_value)}</div></div>
          <div class="lost"><div class="label">Lost / ${names[g.lost_by] ?? 'device'}</div><div class="reading" data-lost>${show(g.lost_value)}</div></div>
        </div>
        ${g.resolved ? '' : html`<button class="btn secondary compact" style="margin-top:10px" data-resolve="${g.id}">Mark reviewed</button>`}
      </div>` : html`
      <div class="panel-item" data-conflict="${g.id}" data-kind="edit_vs_delete">
        <div class="label">${labelOf(g.record_id)} / delete wins${g.resolved ? ' / restored' : ''}</div>
        <p style="margin:4px 0 0">Edit by ${names[g.lost_by] ?? 'a researcher'} saved for review.</p>
        ${g.items.map((c) => html`<div class="quote small" data-lost>${fieldLabel(c.field)}: ${show(c.lost_value)}</div>`)}
        ${g.items.every((c) => c.resolved) ? '' : html`<button class="btn secondary compact" style="margin-top:10px" data-restore="${g.record_id}"
          data-fields="${JSON.stringify(Object.fromEntries(g.items.map((c) => [c.field, c.lost_value])))}">Restore record</button>`}
      </div>`);

    const table = html`
      <div class="table-wrap"><table class="data" id="dataset">
        <thead><tr><th>Id</th><th>Type</th><th>Record</th><th>Key reading</th><th>Last edit</th><th>At</th><th>Status</th></tr></thead>
        <tbody>
          ${view.rows.map((x) => {
            const r = x.record;
            const st = r.deleted ? 'deleted' : openRecordIds.has(r.id) ? 'conflict' : x.status === 'pending' ? 'pending' : 'merged';
            const text = { deleted: 'Deleted', conflict: 'Conflict', pending: 'Pending', merged: 'Merged' }[st];
            return html`<tr class="${r.deleted ? 'is-deleted' : ''}" data-record-id="${r.id}" data-status="${st}">
              <td>${formatLabel(r.type, r.seq)}</td><td class="kind">${TYPES[r.type].label}</td>
              <td class="rec">${recordTitle(r)}</td><td class="key">${summaryLine(r, 0, false)}</td>
              <td class="who">${names[r.updatedBy] ?? 'This device'}</td><td>${hhmm(r.updatedAt)}</td>
              <td><span class="status ${st}">${text}</span></td></tr>`;
          })}
          ${view.rows.length === 0 ? html`<tr><td colspan="7" class="who">No records in ${region.name} yet.</td></tr>` : ''}
        </tbody></table></div>`;

    const researchers = html`
      <div class="table-wrap"><table class="data"><thead><tr><th>Researcher</th><th>Device</th><th>Last sync</th><th>State</th></tr></thead><tbody>
        ${deviceRows.map((d) => html`<tr><td class="rec">${names[d.user_id]}</td><td class="who">${d.device_id.slice(0, 8)}</td>
          <td>${hhmm(d.last_sync_at)}</td><td><span class="status ${d.last_status === 'ok' ? 'merged' : 'failed'}">${d.last_status === 'ok' ? 'OK' : 'Rejected'}</span></td></tr>`)}
        ${deviceRows.length === 0 ? html`<tr><td colspan="4" class="who">No device has synced yet.</td></tr>` : ''}
      </tbody></table></div>`;

    const side = html`
      <aside class="side">
        <div class="brand"><div class="strong" style="font-size:18px">FieldSync</div><div class="muted small">Review console</div></div>
        <nav aria-label="Regions"><div class="label">Regions</div>
          ${regionList.map((r) => html`<button data-region="${r.id}" aria-current="${r.id === region.id}">${r.name}<span class="count">${counts[r.id] ?? 0}</span></button>`)}
        </nav>
        <nav aria-label="Sections">
          <button class="sec" data-section="dataset" aria-current="${section === 'dataset'}">Dataset</button>
          <button class="sec" data-section="conflicts" aria-current="${section === 'conflicts'}">Conflicts<span class="count">${pad2(open.length)}</span></button>
          <button class="sec" data-section="researchers" aria-current="${section === 'researchers'}">Researchers<span class="count">${pad2(region.members ?? 0)}</span></button>
          <button class="sec" data-act="export">Export</button>
          <button class="sec" data-act="signout">Sign out</button>
        </nav>
      </aside>`;

    const title = { dataset: 'Regional dataset', conflicts: 'Conflict log', researchers: 'Researchers' }[section];
    render(el, html`
      <div class="console">
        ${side}
        <div class="main">
          <div class="top">
            <div><div class="eyebrow">${region.name} / ${section === 'dataset' ? 'merged dataset' : section}</div><h1 class="title">${title}</h1></div>
            <div class="actions">
              <button class="btn secondary compact" data-act="export" id="export-csv">Export CSV</button>
              <button class="btn compact" data-act="refresh" id="refresh" ${state.phase !== 'idle' ? 'disabled' : ''}>${state.phase !== 'idle' ? 'Refreshing' : 'Refresh'}</button>
            </div>
          </div>
          <div class="cards">
            <div><div class="reading" data-card="records">${pad2(view.counts.total)}</div><div class="label">Records</div></div>
            <div><div class="reading">${pad2(region.members ?? 0)}</div><div class="label">Researchers</div></div>
            <div><div class="reading ${open.length ? 'error-text' : ''}" data-card="conflicts">${pad2(open.length)}</div><div class="label">Open conflicts</div></div>
            <div><div class="reading" style="color:var(--accent)">${hhmm(lastSync || null)}</div><div class="label">Last device sync</div></div>
          </div>
          ${section === 'dataset' ? html`
            <div class="cols">
              <div class="wide">${table}</div>
              <div class="narrow">
                <div class="panel-title">Open conflicts / ${open.length}</div>
                <div id="open-conflicts-panel">${open.map(conflictItem)}${open.length === 0 ? html`<p class="muted small panel-item">Nothing to review.</p>` : ''}</div>
                <div class="panel-title" style="margin-top:20px">Device sync</div>
                ${deviceRows.map((d) => html`<div class="kv" style="border-top:0"><span>${names[d.user_id]} <span class="muted small">${d.device_id.slice(0, 4)}</span></span>
                  <span class="v muted">${hhmm(d.last_sync_at)} / ${d.last_status === 'ok' ? (Date.now() - new Date(d.last_sync_at) > 86400000 ? 'stale' : 'OK') : 'rejected'}</span></div>`)}
                ${deviceRows.length === 0 ? html`<p class="muted small panel-item">No device has synced yet.</p>` : ''}
              </div>
            </div>` : ''}
          ${section === 'conflicts' ? html`<div style="max-width:560px"><div class="panel-title">All entries / ${everything.length}</div>
            ${everything.map(conflictItem)}${everything.length === 0 ? html`<p class="muted small panel-item">No conflicts in ${region.name}.</p>` : ''}</div>` : ''}
          ${section === 'researchers' ? researchers : ''}
        </div>
      </div>`);
  }

  el.addEventListener('click', async (ev) => {
    const regionBtn = ev.target.closest('[data-region]');
    if (regionBtn) { await setCurrentRegion(regionBtn.dataset.region); await paint(); return; }
    const sec = ev.target.closest('[data-section]');
    if (sec) { section = sec.dataset.section; await paint(); return; }
    const restore = ev.target.closest('[data-restore]');
    if (restore) { restore.disabled = true; await restoreRecord(restore.dataset.restore, JSON.parse(restore.dataset.fields)); return; }
    const resolve = ev.target.closest('[data-resolve]');
    if (resolve) {
      const c = (await conflicts()).find((x) => x.id === resolve.dataset.resolve);
      if (c) await resolveConflict(c);
      return;
    }
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (act === 'refresh') syncNow({ manual: true });
    if (act === 'export') { const region = await currentRegion(); if (region) await exportCsv(region); }
    if (act === 'signout') {
      openSheet(html`<div class="eyebrow">Sign out</div><h2>Sign out of the console?</h2>
        <p class="muted">Signing in again needs a connection.</p>
        <div class="actions"><button class="btn secondary" data-act="keep">Stay</button><button class="btn" data-act="leave">Sign out</button></div>`,
      { leave: async (close) => { close(); await signOut(); go('#/signin'); } });
    }
  });

  await paint();
  return { update: paint };
}
