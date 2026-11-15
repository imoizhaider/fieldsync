// Living style guide: the tokens and controls every screen is built from.
import { html, render } from '../html.js';

const COLORS = [
  ['#111A15', 'Ink, text and offline bar'], ['#f3f2ed', 'Paper, background'], ['#d6d4ca', 'Rules and borders'],
  ['#5b645d', 'Muted text'], ['#0e5a4a', 'Accent, actions, synced'], ['#b86e00', 'Pending marker'],
  ['#7A4700', 'Pending text'], ['#c0392b', 'Conflict marker'], ['#8a2a1b', 'Error text'], ['#0b4a3d', 'Online bar'],
];

export async function mount(el) {
  render(el, html`
    <div class="scroll"><div class="pad stack" style="padding-top:20px;padding-bottom:32px;gap:20px">
      <div><div class="eyebrow">Fieldsync / style guide</div><h1 class="title">One look, three builders</h1></div>
      <div><div class="panel-title">Color</div>
        <div class="swatches" style="margin-top:12px">${COLORS.map(([hex, use]) => html`
          <div class="swatch"><i style="background:${hex}"></i><div class="small" style="margin-top:6px">${hex}</div><div class="muted small">${use}</div></div>`)}</div></div>
      <div><div class="panel-title">Type</div>
        <div class="wrap-row" style="margin-top:12px;align-items:flex-end">
          <div><div class="title">Screen title 28 / 600</div><div>Body 16 / 400, IBM Plex Sans</div></div>
          <div><div class="reading">6.8 readings 22 / 500</div><div class="label">Labels 12 / 500, muted</div></div>
        </div></div>
      <div><div class="panel-title">Status markers</div>
        <div class="wrap-row" style="margin-top:12px">
          <span class="status pending">Pending</span><span class="status synced">Synced</span><span class="status conflict">Conflict</span>
          <span class="status deleted">Deleted</span><span class="status queued">Queued</span><span class="status retry">Retry 00:28</span>
        </div></div>
      <div><div class="panel-title">Controls</div>
        <div class="wrap-row" style="margin-top:12px">
          <button class="btn">Primary</button><button class="btn secondary">Secondary</button><button class="btn danger">Delete</button>
          <label class="field" style="min-width:160px"><span class="label">pH</span><input class="reading" value="6.4" inputmode="decimal"></label>
        </div></div>
      <div><div class="panel-title">Rules</div>
        <div class="wrap-row" style="margin-top:12px">
          <span>Touch targets 44 px or more</span><span>Page padding 16 px</span><span>Status uses shape and text, never color alone</span>
          <span>Radius 6 px, no shadows</span><span>Hairline rules, not cards</span><span>Offline bar is always visible</span>
        </div></div>
      <p><a class="btn secondary" href="#/">Back to the app</a></p>
    </div></div>`);
  return {};
}
