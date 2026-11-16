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

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
let closeOpenSheet = null;

// Close the sheet that is open, if any (used when the route changes).
export function closeSheet() {
  closeOpenSheet?.();
}

// Bottom sheet. Returns a close function.
// Keyboard: focus moves into the sheet (onto its first, safe, button), Tab
// stays inside it, Escape closes it and focus goes back to where it was.
export function openSheet(tpl, handlers = {}) {
  closeSheet();
  const root = document.getElementById('sheet-root');
  const opener = document.activeElement;
  render(root, html`<div class="sheet" role="dialog" aria-modal="true" tabindex="-1"><div class="grip"></div>${tpl}</div>`);
  const sheet = root.firstElementChild;
  const onKey = (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); close(); return; }
    if (ev.key !== 'Tab') return;
    const items = [...sheet.querySelectorAll(FOCUSABLE)];
    if (items.length === 0) { ev.preventDefault(); sheet.focus(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const inside = sheet.contains(document.activeElement);
    if (ev.shiftKey && (!inside || document.activeElement === first || document.activeElement === sheet)) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && (!inside || document.activeElement === last)) { ev.preventDefault(); first.focus(); }
  };
  function close() {
    if (closeOpenSheet !== close) return;
    closeOpenSheet = null;
    document.removeEventListener('keydown', onKey, true);
    root.innerHTML = '';
    root.onclick = null;
    if (opener?.isConnected) opener.focus?.();
  }
  closeOpenSheet = close;
  document.addEventListener('keydown', onKey, true);
  (sheet.querySelector(FOCUSABLE) ?? sheet).focus();
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
