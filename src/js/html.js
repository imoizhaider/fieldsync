// Template helper: html`...` escapes every interpolated value unless it is
// itself the result of html`...` (or raw()).
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

export function raw(s) {
  return { __raw: String(s) };
}

function part(v) {
  if (v === null || v === undefined || v === false) return '';
  if (Array.isArray(v)) return v.map(part).join('');
  if (typeof v === 'object' && '__raw' in v) return v.__raw;
  return esc(v);
}

export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => { out += part(v) + strings[i + 1]; });
  return { __raw: out };
}

export function render(el, tpl) {
  el.innerHTML = part(tpl);
}

export function hhmm(iso) {
  if (!iso) return '--:--';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

export function mmss(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}

export function bytes(n) {
  if (!n) return '0 KB';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function coords(p) {
  if (!p) return '';
  const lat = `${Math.abs(p.lat).toFixed(4)} ${p.lat >= 0 ? 'n' : 's'}`;
  const lng = `${Math.abs(p.lng).toFixed(4)} ${p.lng >= 0 ? 'e' : 'w'}`;
  return `${lat}, ${lng}`;
}

export function go(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}

export function isWide() {
  return window.matchMedia('(min-width: 768px)').matches;
}

// Bottom sheet. Returns a close function.
export function openSheet(tpl, handlers = {}) {
  const root = document.getElementById('sheet-root');
  render(root, html`<div class="sheet" role="dialog" aria-modal="true"><div class="grip"></div>${tpl}</div>`);
  const close = () => { root.innerHTML = ''; root.onclick = null; };
  root.onclick = (ev) => {
    if (ev.target === root) return close();
    const btn = ev.target.closest('[data-act]');
    if (!btn) return undefined;
    const fn = handlers[btn.dataset.act];
    if (fn) fn(close, btn); else close();
    return undefined;
  };
  return close;
}
