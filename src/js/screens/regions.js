import { html, render, go, openSheet } from '../html.js';
import { regions, currentRegion, setCurrentRegion, recordCounts } from '../queries.js';
import { currentUser, signOut } from '../auth.js';
import { state } from '../sync.js';

export async function mount(el) {
  async function paint() {
    const [list, current, counts] = await Promise.all([regions(), currentRegion(), recordCounts()]);
    const viewOnly = list.filter((r) => r.role === 'viewer');
    render(el, html`
      <header class="head">
        <div class="eyebrow">Assigned by your data lead</div>
        <h1 class="title">Regions</h1>
      </header>
      <div class="scroll">
        ${list.length === 0 ? html`<div class="pad" style="padding-top:16px"><div class="notice"><b>No regions yet.</b> They load the first time this device syncs. Connect once and they appear here.</div></div>` : ''}
        <ul class="rows">
          ${list.map((r) => html`
            <li><button class="row ${r.id === current?.id ? 'selected' : ''}" data-region="${r.id}">
              <span class="row-line">
                <span><span class="row-title" style="display:block">${r.name}</span>
                  <span class="row-meta">${counts[r.id] ?? 0} ${(counts[r.id] ?? 0) === 1 ? 'record' : 'records'}</span></span>
                <span class="status plain ${r.role === 'viewer' ? 'queued' : 'synced'}">${r.role === 'viewer' ? 'View only' : 'Can edit'}</span>
              </span>
            </button></li>`)}
        </ul>
        ${viewOnly.length > 0 ? html`<div class="pad" style="padding-top:16px"><div class="notice">
          <b>${viewOnly.map((r) => r.name).join(', ')} ${viewOnly.length === 1 ? 'is' : 'are'} view only.</b>
          New records and edits are blocked on this device. Ask your data lead for edit access.</div></div>` : ''}
        <div class="section-label ruled" style="margin-top:12px">This device</div>
        <ul class="rows">
          <li><a class="row" href="#/install"><span class="row-line"><span>Install FieldSync</span><span class="row-meta">Home screen</span></span></a></li>
          <li><a class="row" href="#/storage"><span class="row-line"><span>Storage</span><span class="row-meta">Photos and space</span></span></a></li>
          <li><a class="row" href="#/conflicts"><span class="row-line"><span>Conflict log</span><span class="row-meta">Overwritten values</span></span></a></li>
        </ul>
        <p class="pad muted small" style="padding-top:12px">Signed in as ${currentUser()?.name ?? ''}</p>
      </div>
      <div class="foot"><button class="btn secondary block" data-act="signout">Sign out</button></div>`);
  }

  el.addEventListener('click', async (ev) => {
    const region = ev.target.closest('[data-region]');
    if (region) {
      await setCurrentRegion(region.dataset.region);
      go('#/records');
      return;
    }
    if (ev.target.closest('[data-act="signout"]')) {
      const leave = async (close) => { close(); await signOut(); go('#/signin'); };
      openSheet(html`
        <div class="eyebrow">Sign out</div>
        <h2>Sign out of this device?</h2>
        <p class="muted">${state.pending > 0
          ? `${state.pending} ${state.pending === 1 ? 'change has' : 'changes have'} not uploaded yet. They stay saved on this device and upload after you sign in again.`
          : 'Your records stay on this device. Signing in again needs a connection.'}</p>
        <div class="actions">
          <button class="btn secondary" data-act="keep">Stay signed in</button>
          <button class="btn" data-act="leave">Sign out</button>
        </div>`, { leave });
    }
  });

  await paint();
  return { update: paint };
}
