// App start and hash router. Hash routes keep the app working under any
// sub-path (GitHub Pages) and with no server rewrites.
import { restoreUser, currentUser } from './auth.js';
import { startAutoSync, state } from './sync.js';
import { on } from './bus.js';
import { paint, setBarMode } from './statusbar.js';
import { isWide, closeSheet } from './html.js';
import { watchHostInset } from './hostinset.js';
import { isLead } from './queries.js';
import * as signin from './screens/signin.js';
import * as regions from './screens/regions.js';
import * as records from './screens/records.js';
import * as record from './screens/record.js';
import * as form from './screens/form.js';
import * as tracks from './screens/tracks.js';
import * as track from './screens/track.js';
import * as syncScreen from './screens/syncscreen.js';
import * as conflicts from './screens/conflicts.js';
import * as storage from './screens/storage.js';
import * as install from './screens/install.js';
import * as consoleScreen from './screens/console.js';
import * as styleguide from './screens/styleguide.js';

const ROUTES = {
  signin, regions, records, record, new: form, edit: form, permissions: form, tracks, track,
  sync: syncScreen, conflicts, storage, install, console: consoleScreen, styleguide,
};
const SPLIT = new Set(['records', 'record', 'new', 'edit', 'permissions']);
const NAV = {
  records: 'records', record: 'records', new: 'records', edit: 'records', permissions: 'records',
  regions: 'records', conflicts: 'records', storage: 'records', tracks: 'tracks', track: 'tracks', sync: 'sync',
};
const NO_NAV = new Set(['signin', 'console', 'install', 'styleguide']);
// Screens with their own back arrow and bottom actions (designs New record, Record
// detail): on a phone they have no tab bar under them. On wider screens the tab
// bar is a side rail and stays.
const NO_TABBAR = new Set(['record', 'new', 'edit', 'permissions', 'track']);

let mounted = [];
let token = 0;
let autoRouted = false;
let current = '';

function parse() {
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  return { name: name || '', arg: arg ? decodeURIComponent(arg) : null };
}

async function mount(module, pane, params, mine) {
  const el = document.createElement('div');
  el.className = 'screen';
  pane.replaceChildren(el);
  const handle = await module.mount(el, params);
  if (mine !== token) { handle?.destroy?.(); return; }
  mounted.push(handle ?? {});
}

async function route() {
  const mine = ++token;
  const parsed = parse();
  let { name } = parsed;
  const { arg } = parsed;
  const user = currentUser();

  if (!user && name !== 'styleguide') {
    name = 'signin';
  } else if (user && (name === '' || (name === 'signin' && arg !== 'again'))) {
    name = (await isLead()) ? 'console' : 'records';
    autoRouted = true;
    history.replaceState(null, '', `#/${name}`);
  } else if (!ROUTES[name]) {
    name = 'records';
  }
  if (mine !== token) return;

  for (const h of mounted) h.destroy?.();
  mounted = [];
  current = name;
  closeSheet();

  const split = isWide() && SPLIT.has(name);
  document.body.classList.toggle('split', split);
  document.body.classList.toggle('no-nav', NO_NAV.has(name) || !user);
  document.body.classList.toggle('tabless', NO_TABBAR.has(name));
  document.body.dataset.route = name;
  setBarMode(name === 'signin' ? 'signin' : name === 'console' ? 'lead' : name === 'install' ? 'install' : 'app');
  for (const a of document.querySelectorAll('#nav a')) {
    if (a.dataset.nav === NAV[name]) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }

  const listPane = document.getElementById('pane-list');
  const detailPane = document.getElementById('pane-detail');
  listPane.hidden = !split;
  if (split) {
    const selected = name === 'record' ? arg : name === 'records' ? 'first' : null;
    await mount(records, listPane, { name: 'records', selected, split: true }, mine);
    if (name === 'records') await mount(record, detailPane, { name: 'record', arg: 'first', split: true }, mine);
    else await mount(ROUTES[name], detailPane, { name, arg, split: true }, mine);
  } else {
    listPane.replaceChildren();
    await mount(ROUTES[name], detailPane, { name, arg, split: false }, mine);
  }
}

// Screens repaint when local data or the sync state changes.
let queued = null;
let busy = false;
function refresh(type) {
  queued = queued && queued !== type ? 'both' : type;
  if (busy) return;
  busy = true;
  setTimeout(async () => {
    while (queued) {
      const kind = queued;
      queued = null;
      for (const h of [...mounted]) {
        try { await h.update?.(kind); } catch (err) { console.error(err); }
      }
    }
    busy = false;
  }, 40);
}

async function afterData() {
  // A data lead who landed on the field view by default is sent to the console
  // as soon as the first pull tells us who they are.
  if (autoRouted && current === 'records' && (await isLead())) {
    autoRouted = false;
    location.hash = '#/console';
  }
}

async function start() {
  paint();
  watchHostInset();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('service worker', err));
  }
  on('sync', () => { paint(); refresh('sync'); });
  on('data', () => { refresh('data'); afterData(); });
  window.addEventListener('online', () => { state.online = true; paint(); });
  window.addEventListener('offline', () => { state.online = false; paint(); });
  window.addEventListener('hashchange', route);
  window.matchMedia('(min-width: 768px)').addEventListener('change', route);

  const user = await restoreUser();
  if (user) startAutoSync();
  await route();
  document.documentElement.dataset.ready = '1';
  try { sessionStorage.removeItem('fieldsync.boot'); } catch { /* storage blocked */ }
}

start();
