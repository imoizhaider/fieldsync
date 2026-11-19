// Conflict log: every overwritten value, so nothing is silently lost.
import { html, render, hhmm } from '../html.js';
import { db, getMeta, setMeta } from '../db.js';
import { conflicts, profileNames, regions } from '../queries.js';
import { formatLabel, fieldLabel } from '../merge.js';
import { restoreRecord, updateRecord, resolveConflict } from '../store.js';
import { currentUser } from '../auth.js';

function show(v) {
  return v === null || v === undefined || v === '' ? '(empty)' : String(v);
}

// Group "edit against a deleted record" entries that came from one edit.
export function groupConflicts(list) {
  const out = [];
  const byEdit = new Map();
  for (const c of list) {
    if (c.kind !== 'edit_vs_delete') { out.push({ ...c, items: [c] }); continue; }
    const key = `${c.record_id}|${c.at}|${c.lost_device}`;
    if (!byEdit.has(key)) { byEdit.set(key, { ...c, items: [] }); out.push(byEdit.get(key)); }
    byEdit.get(key).items.push(c);
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}

export async function mount(el) {
  async function paint() {
    const [list, names, myDevice, regionList] = await Promise.all([conflicts(), profileNames(), getMeta('deviceId'), regions()]);
    const groups = groupConflicts(list);
    const me = currentUser()?.id;
    const who = (uid, dev) => (dev && dev === myDevice ? 'this device' : uid === me ? 'you' : names[uid] ?? 'another device');
    const rows = [];
    for (const g of groups) {
      const rec = await db.records.get(g.record_id);
      const label = rec ? formatLabel(rec.type, rec.seq) : 'Record';
      const editable = regionList.find((r) => r.id === g.region_id)?.role !== 'viewer';
      if (g.kind === 'same_field') {
        let decision = '';
        if (g.resolved) {
          decision = html`<p class="small muted" style="margin-top:10px" data-decision="${g.resolution ?? 'reviewed'}">${g.resolution === 'rejected'
            ? `Rejected: ${show(g.lost_value)} put back.` : g.resolution === 'accepted' ? `Accepted: ${show(g.kept_value)} kept.` : 'Reviewed.'}</p>`;
        } else if (editable && rec && !rec.deleted) {
          decision = html`<p class="small muted" style="margin-top:10px">Accept keeps ${show(g.kept_value)}. Reject puts ${show(g.lost_value)} back on every device.</p>
            <div class="grid2" style="margin-top:8px">
              <button class="btn secondary" data-accept="${g.id}">Accept</button>
              <button class="btn" data-reject="${g.id}">Reject</button>
            </div>`;
        }
        rows.push(html`
          <li class="row" data-conflict="${g.id}" data-kind="same_field" data-record-id="${g.record_id}">
            <div class="row-top"><span class="label">${label} / ${fieldLabel(g.field)}</span><span class="label">${hhmm(g.at)}</span></div>
            <p class="muted small" style="margin-top:4px">Same field edited on two devices. Later server time wins.</p>
            <div class="pair">
              <div class="kept"><div class="label">Kept / ${who(g.kept_by, g.kept_device)}</div><div class="reading" data-kept>${show(g.kept_value)}</div></div>
              <div class="lost"><div class="label">Overwritten / ${who(g.lost_by, g.lost_device)}</div><div class="reading" data-lost>${show(g.lost_value)}</div></div>
            </div>
            ${decision}
          </li>`);
      } else {
        const fields = Object.fromEntries(g.items.map((c) => [c.field, c.lost_value]));
        rows.push(html`
          <li class="row" data-conflict="${g.id}" data-kind="edit_vs_delete" data-record-id="${g.record_id}">
            <div class="row-top"><span class="label">${label} / ${g.items.map((c) => fieldLabel(c.field)).join(', ')}</span><span class="label">${hhmm(g.at)}</span></div>
            <p class="muted small" style="margin-top:4px">${g.kept_device && g.kept_device === myDevice
              ? 'Deleted on this device after it was edited on another one. The delete wins.'
              : 'Record deleted on another device. The delete wins.'}</p>
            ${g.items.map((c) => html`<div class="quote" data-lost>${g.lost_by === me ? 'Your edit' : `Edit by ${who(g.lost_by, g.lost_device)}`}: ${fieldLabel(c.field)} ${show(c.lost_value)}</div>`)}
            ${g.items.every((c) => c.resolved)
              ? html`<p class="small muted" style="margin-top:10px" data-decision="${g.resolution ?? 'restored'}">${g.resolution === 'accepted' ? 'Accepted: the record stays deleted.' : 'Restored.'}</p>`
              : editable && rec ? html`<div class="grid2" style="margin-top:10px">
                  <button class="btn secondary" data-accept="${g.id}">Accept delete</button>
                  <button class="btn" data-restore="${g.record_id}" data-fields="${JSON.stringify(fields)}">Restore record</button>
                </div>` : ''}
          </li>`);
      }
    }
    render(el, html`
      <header class="head-back">
        <a class="back" href="#/records" aria-label="Back">&larr;</a>
        <div class="grow"><h1>Conflict log</h1><span class="eyebrow" id="conflict-count">${groups.length} ${groups.length === 1 ? 'entry' : 'entries'} / nothing lost</span></div>
      </header>
      <div class="scroll">
        <ul class="rows" id="conflict-list">${rows}</ul>
        ${groups.length === 0 ? html`<div class="pad" style="padding-top:20px"><p class="muted">No conflicts. When two devices change the same field, the value that lost is kept here.</p></div>` : ''}
      </div>`);
  }

  el.addEventListener('click', async (ev) => {
    // Accept: the kept value (or the delete) stands; the entry is marked reviewed.
    // Reject: the overwritten value is written again as a normal edit of this
    // device, so it reaches every device through the usual sync and merge.
    const decide = ev.target.closest('[data-accept], [data-reject]');
    if (decide) {
      decide.disabled = true;
      const id = decide.dataset.accept ?? decide.dataset.reject;
      const list = await conflicts();
      const c = list.find((x) => x.id === id);
      if (!c) return;
      if (decide.dataset.reject !== undefined) {
        const rec = await db.records.get(c.record_id);
        if (!rec) return;
        // Every other field as it is: only this one is queued (diffFields).
        await updateRecord(c.record_id, { fields: { ...rec.fields, [c.field]: c.lost_value } });
        await resolveConflict(c, 'rejected');
      } else {
        // An edit against a deleted record can be logged as several entries.
        const same = c.kind === 'edit_vs_delete'
          ? list.filter((x) => x.kind === 'edit_vs_delete' && x.record_id === c.record_id && x.at === c.at && x.lost_device === c.lost_device && !x.resolved)
          : [c];
        for (const x of same) await resolveConflict(x, 'accepted');
      }
      await paint();
      return;
    }
    const btn = ev.target.closest('[data-restore]');
    if (!btn) return;
    btn.disabled = true;
    const list = await conflicts();
    await restoreRecord(btn.dataset.restore, JSON.parse(btn.dataset.fields));
    // Shown as restored straight away; the server confirms on the next sync.
    await setMeta('conflicts', list.map((c) => (c.record_id === btn.dataset.restore && c.kind === 'edit_vs_delete' ? { ...c, resolved: true } : c)));
    await paint();
  });

  await paint();
  return { update: (kind) => (kind === 'sync' ? null : paint()) };
}
