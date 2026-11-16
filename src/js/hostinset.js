// Some free hosts pin their own badge over the bottom of every page (Netlify's
// free plan adds an iframe in the bottom right corner, on top of everything).
// The app cannot and should not remove it, so it makes room instead: the
// height the badge covers is kept free at the bottom of the layout, and no
// button, tab or sheet ends up underneath it.
//
// Works by looking, not by name: any element that is not part of the app,
// sits directly under <html> or <body>, is position:fixed and touches the
// bottom edge counts. With no such element the inset is 0 and nothing changes.

const OWN_IDS = new Set(['statusbar', 'app', 'sheet-root']);
const MAX_SHARE = 0.25; // a pinned badge is small; anything taller is a panel the visitor opened

// Height to keep free, or null while a tall panel is open (keep what we had).
function measure() {
  const vh = window.innerHeight;
  let inset = 0;
  for (const parent of [document.documentElement, document.body]) {
    for (const el of parent?.children ?? []) {
      if (el === document.body || el === document.head || OWN_IDS.has(el.id)) continue;
      if (['SCRIPT', 'STYLE', 'LINK', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName)) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.bottom < vh - 1) continue;
      if (vh - r.top > vh * MAX_SHARE) return null;
      inset = Math.max(inset, vh - r.top);
    }
  }
  return Math.round(inset);
}

let scheduled = false;
let current = -1;

function apply() {
  scheduled = false;
  const inset = measure();
  if (inset === null || inset === current) return;
  current = inset;
  document.documentElement.style.setProperty('--host-inset', `${inset}px`);
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(apply);
}

export function watchHostInset() {
  const resize = 'ResizeObserver' in window ? new ResizeObserver(schedule) : null;
  const seen = new WeakSet();
  const track = () => {
    for (const parent of [document.documentElement, document.body]) {
      for (const el of parent?.children ?? []) {
        if (!seen.has(el) && !OWN_IDS.has(el.id) && el !== document.body && el !== document.head) {
          seen.add(el);
          resize?.observe(el);
        }
      }
    }
    schedule();
  };
  const mutation = new MutationObserver(track);
  mutation.observe(document.documentElement, { childList: true });
  if (document.body) mutation.observe(document.body, { childList: true });
  window.addEventListener('resize', schedule);
  track();
}
