// The status bar is always visible: online or offline, pending count, last sync.
import { state } from './sync.js';
import { html, render, hhmm } from './html.js';

let mode = 'app'; // app | signin | lead | install

export function setBarMode(m) {
  mode = m;
  paint();
}

export function paint() {
  const el = document.getElementById('statusbar');
  if (!el) return;
  const online = state.online;
  let tone = online ? 'online' : 'offline';
  let left;
  let right = `Last sync ${hhmm(state.lastSyncAt)}`;
  let progress = null;

  if (mode === 'signin') {
    left = `${online ? 'Online' : 'Offline'} / sign-in needed`;
    right = 'Once';
  } else if (mode === 'install') {
    left = `${online ? 'Online' : 'Offline'} / install`;
    right = 'First run';
  } else if (!online) {
    left = `Offline / ${state.pending} pending`;
  } else if (state.phase === 'pushing' && state.total > 0) {
    const pct = Math.round((state.done / state.total) * 100);
    left = `Syncing ${Math.min(state.done + 1, state.total)} of ${state.total}`;
    right = `${pct}%`;
    progress = pct;
  } else if (state.reconnected > 0) {
    left = 'Back online';
    right = 'Starting sync';
  } else if (state.needsSignIn) {
    tone = 'problem';
    left = 'Online / sign-in needed to sync';
  } else if (state.rejected > 0) {
    tone = 'problem';
    left = 'Online / sync problem';
  } else if (state.phase !== 'idle') {
    left = 'Online / syncing';
  } else if (state.pending > 0) {
    left = `Online / ${state.pending} pending`;
  } else if (mode === 'lead') {
    left = 'Online / data lead';
    right = `Refreshed ${hhmm(state.lastSyncAt)}`;
  } else {
    left = 'Online / all synced';
  }

  el.dataset.tone = tone;
  el.dataset.online = online ? '1' : '0';
  render(el, html`
    <span class="sb-left"><span class="sb-mark"></span><span id="sb-text">${left}</span></span>
    <span id="sb-right">${right}</span>
    ${progress === null ? '' : html`<span class="sb-progress"><i style="width:${progress}%"></i></span>`}`);
}
