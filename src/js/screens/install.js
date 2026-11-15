// Install help. iPhone has no install prompt, so the steps are spelled out.
import { html, render, go } from '../html.js';
import { db, getMeta } from '../db.js';
import { isIos, isStandalone } from '../device.js';
import { currentUser } from '../auth.js';

let promptEvent = null;
window.addEventListener('beforeinstallprompt', (ev) => {
  ev.preventDefault();
  promptEvent = ev;
});

const IOS_STEPS = [
  ['Open in Safari', 'Installing only works from Safari, not from in-app browsers.'],
  ['Tap Share', 'It is in the bottom toolbar.'],
  ['Add to Home Screen', 'Scroll the sheet, tap it, then tap Add.'],
  ['Open it from the Home Screen', 'Sign in once while online. After that it opens with no signal.'],
];
const OTHER_STEPS = [
  ['Open in Chrome', 'Installing works from Chrome on Android and on a laptop.'],
  ['Open the browser menu', 'The three dots at the top right.'],
  ['Install app', 'On some phones it is called Add to Home screen.'],
  ['Open it from the Home screen', 'Sign in once while online. After that it opens with no signal.'],
];

export async function mount(el) {
  async function paint() {
    const ios = isIos();
    const steps = ios ? IOS_STEPS : OTHER_STEPS;
    const cached = Boolean(navigator.serviceWorker?.controller);
    const persisted = db ? await getMeta('persisted') : false;
    render(el, html`
      <header class="head"><div class="eyebrow">First run / ${ios ? 'iphone' : 'this device'}</div><h1 class="title">Install FieldSync</h1></header>
      <div class="scroll">
        ${isStandalone() ? html`<div class="pad" style="padding-top:12px"><div class="notice good"><b>Installed.</b> FieldSync is running from the home screen.</div></div>` : ''}
        ${steps.map(([title, text], i) => html`
          <div class="step"><span class="n">${i + 1}</span><div><div class="row-title" style="margin:0">${title}</div><div class="muted small">${text}</div></div></div>`)}
        <div class="section-label ruled" style="margin-top:8px">Offline ready</div>
        <div class="pad">
          <div class="kv" style="border-top:0"><span>App files cached</span><span class="v ${cached ? '' : 'muted'}" id="cached-state">${cached ? 'Done' : 'Preparing'}</span></div>
          <div class="kv" style="border-top:0"><span>Signed in on this device</span><span class="v ${currentUser() ? '' : 'muted'}">${currentUser() ? 'Done' : 'Not yet'}</span></div>
          <div class="kv" style="border-top:0"><span>Storage protection</span><span class="v">${persisted ? 'Granted' : 'Requested'}</span></div>
        </div>
        <p class="pad muted small" style="padding-top:12px">${ios
          ? 'iOS may clear site data after long inactivity. Sync before any long gap in the field.'
          : 'Sync before any long gap in the field, so a lost or reset device costs nothing.'}</p>
      </div>
      <div class="foot">
        ${promptEvent ? html`<button class="btn secondary block" data-act="install">Install now</button>` : ''}
        <button class="btn block" data-act="done">Done</button>
      </div>`);
  }

  el.addEventListener('click', async (ev) => {
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (act === 'done') go(currentUser() ? '#/records' : '#/signin');
    if (act === 'install' && promptEvent) {
      promptEvent.prompt();
      await promptEvent.userChoice.catch(() => null);
      promptEvent = null;
      await paint();
    }
  });

  await paint();
  navigator.serviceWorker?.addEventListener('controllerchange', paint);
  return { destroy: () => navigator.serviceWorker?.removeEventListener('controllerchange', paint) };
}
