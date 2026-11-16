// K. UI and accessibility
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { chromium } from '@playwright/test';
import { test, expect, state, sql, uniq, photo, PUSH, BASE_URL } from '../lib/harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const DESIGN = resolve(ROOT, 'design');
const REVIEW = resolve(HERE, '../k01-review.json');
const AXE = readFileSync(resolve(ROOT, 'node_modules/axe-core/axe.min.js'), 'utf8');
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const WIDTHS = [{ width: 390, height: 844 }, { width: 820, height: 1180 }, { width: 1280, height: 800 }];
const quota85 = () => { navigator.storage.estimate = async () => ({ usage: 85e6, quota: 100e6 }); };
const pngSize = (file) => { const b = readFileSync(file); return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }; };

// One record with a photo and one open conflict, so every screen has content.
async function seedContent(qa) {
  const a = await qa.device('seedA', { user: 'a' });
  const b = await qa.device('seedB', { user: 'b' });
  await a.open();
  await b.open();
  const id = await a.createRecord({ title: uniq('K content'), fields: { ph: 6.4, moisture: 31 }, notes: 'Clay loam near the canal.', photos: [photo(1), photo(2)] });
  await a.waitSynced();
  await b.syncNow();
  await a.offline(); await b.offline();
  await a.editRecord(id, { ph: 6.1 });
  await b.editRecord(id, { ph: 6.9 });
  await a.context.setOffline(false); await a.waitSynced();
  await b.context.setOffline(false); await b.waitSynced();
  await a.syncNow();
  await a.context.close(); await b.context.close();
  qa.devices = qa.devices.filter((d) => d !== a && d !== b);
  return id;
}

// The screens every layout check walks through.
function screens(id) {
  return [
    ['records', '#/records'], ['record', `#/record/${id}`], ['new', '#/new'], ['edit', `#/edit/${id}`],
    ['tracks', '#/tracks'], ['sync', '#/sync'], ['conflicts', '#/conflicts'], ['storage', '#/storage'],
    ['regions', '#/regions'], ['install', '#/install'], ['permissions', '#/permissions'], ['styleguide', '#/styleguide'],
  ];
}

test('K01 [P2] every design screen next to the built screen', async ({ qa }) => {
  test.setTimeout(600_000);
  const id = await seedContent(qa);
  const out = resolve(qa.dir, 'sheets');
  mkdirSync(out, { recursive: true });
  const shots = {};
  const problems = [];
  const dev = (name, design, opts) => {
    const s = pngSize(resolve(DESIGN, `${design}.png`));
    return qa.device(name, { viewport: { width: s.width / 2, height: s.height / 2 }, deviceScaleFactor: 2, ...opts });
  };
  const snap = async (d, design) => { shots[design] = await d.page.screenshot(); };
  const attempt = async (design, fn) => { try { await fn(); } catch (err) { problems.push(`${design}: ${String(err.message).split('\n')[0]}`); } };

  // signed out
  await attempt('Sign in', async () => { const d = await dev('signin', 'Sign in'); await d.open('', { sync: false }); await snap(d, 'Sign in'); await d.context.close(); });
  await attempt('Laptop, sign in', async () => { const d = await dev('signin-laptop', 'Laptop, sign in'); await d.open('', { sync: false }); await snap(d, 'Laptop, sign in'); await d.context.close(); });
  await attempt('Style guide', async () => { const d = await dev('styleguide', 'Style guide'); await d.open('#/styleguide', { sync: false }); await snap(d, 'Style guide'); await d.context.close(); });

  // researcher on a phone
  const a = await dev('phone', 'Records', { user: 'a' });
  await a.open();
  await attempt('Records', async () => { await a.go('#/records'); await snap(a, 'Records'); });
  await attempt('Record detail', async () => { await a.go(`#/record/${id}`); await a.page.waitForTimeout(800); await snap(a, 'Record detail'); });
  await attempt('Delete confirm', async () => { await a.page.click('#delete-record'); await a.page.waitForSelector('#confirm-delete'); await snap(a, 'Delete confirm'); await a.page.keyboard.press('Escape'); await a.go('#/records'); });
  await attempt('New record', async () => { await a.go('#/new'); await a.page.waitForSelector('#record-form'); await expect(a.page.locator('#gps-box')).toHaveAttribute('data-gps', 'fixed'); await snap(a, 'New record'); });
  await attempt('GPS tracks', async () => { await a.go('#/tracks'); await snap(a, 'GPS tracks'); });
  await attempt('Regions', async () => { await a.go('#/regions'); await snap(a, 'Regions'); });
  await attempt('Conflict log', async () => { await a.go('#/conflicts'); await snap(a, 'Conflict log'); });
  await attempt('All synced', async () => { await a.go('#/sync'); await a.syncNow(); await a.go('#/records'); await a.page.waitForTimeout(300); await snap(a, 'All synced'); });
  await attempt('Sync', async () => {
    await a.offline();
    await a.createRecord({ title: uniq('K01 pending'), fields: { ph: 6 }, photos: [photo(3)] });
    await a.go('#/sync'); await snap(a, 'Sync');
  });
  await attempt('Syncing', async () => {
    let release; const gate = new Promise((r) => { release = r; });
    await a.context.route(PUSH, async (route) => { await gate; await route.continue().catch(() => {}); });
    await a.context.setOffline(false);
    await a.go('#/records');
    await a.page.waitForFunction(() => /sync/i.test(document.querySelector('#sb-text')?.textContent ?? ''), null, { timeout: 20_000 }).catch(() => {});
    await snap(a, 'Syncing');
    release(); await a.page.waitForTimeout(500); await a.context.unroute(PUSH); await a.waitSynced();
  });
  await attempt('Back online', async () => {
    await a.offline();
    await a.createRecord({ title: uniq('K01 back online'), fields: { ph: 6 } });
    await a.go('#/records');
    // the state lasts only until the first sync answers, so the sync calls are held while the picture is taken
    let open; const hold = new Promise((r) => { open = r; });
    await a.context.route('**/rest/v1/rpc/**', async (route) => { await hold; await route.continue().catch(() => {}); });
    try {
      await a.context.setOffline(false);
      await a.page.waitForSelector('#back-online', { timeout: 15_000 });
      shots['Back online'] = await a.page.screenshot();
      qa.note('backOnlineStatusBar', await a.page.locator('#sb-text').textContent());
    } finally {
      open(); await a.page.waitForTimeout(500); await a.context.unroute('**/rest/v1/rpc/**');
    }
    await a.waitSynced();
  });
  await attempt('Sync rejected', async () => {
    await a.context.route(PUSH, async (route) => {
      const ops = JSON.parse(route.request().postData() ?? '{}').p_ops ?? [];
      if (!ops.length) return route.continue();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: ops.map((o) => ({ op_id: o.op_id, status: 'rejected', reason: 'not an editor of this region' })) }) });
    });
    await a.createRecord({ title: uniq('K01 rejected'), fields: { ph: 6 } });
    await a.page.waitForTimeout(4000);
    await a.go('#/sync');
    await a.page.waitForSelector('#sync-rejected', { timeout: 20_000 });
    await snap(a, 'Sync rejected');
  });
  await a.context.close();

  await attempt('First run, empty', async () => {
    // an empty region made for this screen only (test setup; removed by the cleanup, name QA-<ts>-E)
    const name = `${state.names.main}-E`;
    let rid = (await sql('select id from public.regions where name = $1', [name]))[0]?.id;
    if (!rid) {
      rid = (await sql('insert into public.regions (name) values ($1) returning id', [name]))[0].id;
      await sql('insert into public.region_members (region_id, user_id, role) values ($1, $2, $3)', [rid, state.users.b.id, 'editor']);
    }
    const e = await dev('empty', 'First run, empty', { user: 'b' });
    await e.open();
    await e.go('#/regions');
    await e.page.click(`[data-region="${rid}"]`);
    await e.page.waitForFunction(() => document.body.dataset.route === 'records');
    await snap(e, 'First run, empty');
    await e.context.close();
  });
  await attempt('Permissions blocked', async () => { const d = await dev('blocked', 'Permissions blocked', { user: 'a', permissions: [], geo: null }); await d.open(); await d.go('#/permissions'); await d.page.waitForTimeout(500); await snap(d, 'Permissions blocked'); await d.context.close(); });
  await attempt('Storage almost full', async () => { const d = await dev('full', 'Storage almost full', { user: 'a', init: [quota85] }); await d.open(); await d.go('#/storage'); await snap(d, 'Storage almost full'); await d.context.close(); });
  await attempt('iPhone, records', async () => { const d = await dev('iphone', 'iPhone, records', { user: 'a', userAgent: IPHONE }); await d.open('', { sw: false }); await d.go('#/records'); await snap(d, 'iPhone, records'); await d.go('#/install'); await snap(d, 'iPhone, install'); await d.context.close(); });
  await attempt('Tablet', async () => { const d = await dev('tablet', 'Tablet', { user: 'a' }); await d.open(); await d.go(`#/record/${id}`); await d.page.waitForTimeout(800); await snap(d, 'Tablet'); await d.context.close(); });
  await attempt('Laptop, data lead', async () => { const d = await dev('lead', 'Laptop, data lead', { user: 'lead' }); await d.open(); await d.page.waitForFunction(() => document.body.dataset.route === 'console'); await d.page.click(`aside [data-region="${state.regions.main}"]`); await d.page.waitForTimeout(500); await snap(d, 'Laptop, data lead'); await d.context.close(); });

  // side-by-side sheets (design left, live build right)
  const designs = readdirSync(DESIGN).filter((f) => f.endsWith('.png')).map((f) => f.replace(/\.png$/, ''));
  const sheetCtx = await qa.browser.newContext({ viewport: { width: 1200, height: 800 } });
  const sheet = await sheetCtx.newPage();
  for (const name of designs) {
    if (!shots[name]) { if (!problems.some((p) => p.startsWith(name))) problems.push(`${name}: no capture`); continue; }
    const left = readFileSync(resolve(DESIGN, `${name}.png`)).toString('base64');
    const w = Math.min(560, pngSize(resolve(DESIGN, `${name}.png`)).width / 2);
    await sheet.setContent(`<body style="margin:0;background:#888;font:12px sans-serif"><div style="display:flex;gap:8px;padding:8px;width:max-content">
      <figure style="margin:0"><figcaption>DESIGN / ${name}</figcaption><img style="width:${w}px;display:block" src="data:image/png;base64,${left}"></figure>
      <figure style="margin:0"><figcaption>LIVE BUILD</figcaption><img style="width:${w}px;display:block" src="data:image/png;base64,${shots[name].toString('base64')}"></figure></div></body>`);
    await sheet.waitForFunction(() => [...document.images].every((i) => i.complete));
    await sheet.locator('body > div').screenshot({ path: resolve(out, `${name}.png`) });
  }
  await sheetCtx.close();
  qa.note('sheets', `${Object.keys(shots).length} of ${designs.length} written to artifacts/qa/K01/sheets`);
  qa.note('captureProblems', problems);

  // The verdict per screen is a human-style review of the sheets, kept in k01-review.json.
  expect(existsSync(REVIEW), 'tests/qa/k01-review.json (review of the sheets) is missing').toBe(true);
  const review = JSON.parse(readFileSync(REVIEW, 'utf8'));
  qa.note('review', review);
  expect(designs.filter((n) => !review[n]), 'designs without a verdict').toEqual([]);
  for (const [name, r] of Object.entries(review)) if (r.verdict !== 'match') qa.finding(`${name}: ${r.verdict} - ${r.differences}`);
  expect(Object.entries(review).filter(([, r]) => r.verdict === 'mismatch').map(([n]) => n), 'screens that do not match their design').toEqual([]);
  expect(problems, 'screens that could not be captured').toEqual([]);
});

test('K02 [P2] no screen scrolls sideways at 390, 820 and 1280', async ({ qa }) => {
  test.setTimeout(400_000);
  const id = await seedContent(qa);
  const bad = [];
  for (const viewport of WIDTHS) {
    const d = await qa.device(`w${viewport.width}`, { user: 'a', viewport });
    await d.open();
    for (const [name, hash] of screens(id)) {
      await d.go(hash);
      await d.page.waitForTimeout(300);
      const m = await d.page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const over = [...document.querySelectorAll('body *')].filter((el) => {
          if (el.closest('[hidden]') || el.id === 'nl-badge-frame') return false;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) return false;
          let p = el.parentElement;                       // ignore content inside a scroll area made on purpose
          while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return false; p = p.parentElement; }
          return r.right > vw + 1 || r.left < -1;
        }).slice(0, 4).map((el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String(el.className).split(' ')[0]}`);
        return { vw, scrollW: document.documentElement.scrollWidth, bodyW: document.body.scrollWidth, over };
      });
      if (m.scrollW > m.vw + 1 || m.bodyW > m.vw + 1 || m.over.length) { bad.push({ width: viewport.width, screen: name, ...m }); await d.shot(`overflow-${viewport.width}-${name}`, { fullPage: true }); }
    }
    await d.shot(`records-${viewport.width}`);
    await d.context.close();
  }
  // data lead console on a laptop: the page must fit and its main buttons must be on screen
  for (const viewport of [WIDTHS[2], { width: 1440, height: 900 }]) {
    const lead = await qa.device(`lead${viewport.width}`, { user: 'lead', viewport });
    await lead.open();
    await lead.page.waitForFunction(() => document.body.dataset.route === 'console');
    await lead.page.click(`aside [data-region="${state.regions.main}"]`);
    await lead.page.waitForTimeout(500);
    const m = await lead.page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const off = ['#export-csv', '#refresh'].filter((q) => { const r = document.querySelector(q)?.getBoundingClientRect(); return !r || r.right > vw + 1 || r.left < 0; });
      return { vw, scrollW: document.documentElement.scrollWidth, offScreen: off };
    });
    await lead.shot(`console-${viewport.width}`);
    if (m.scrollW > m.vw + 1 || m.offScreen.length) bad.push({ width: viewport.width, screen: 'console', ...m });
    await lead.context.close();
  }
  qa.note('overflow', bad);
  expect(bad, 'screens wider than the viewport').toEqual([]);
});

test('K03 [P1] every control is at least 44 x 44 px', async ({ qa }) => {
  test.setTimeout(400_000);
  const id = await seedContent(qa);
  const small = [];
  const measure = (d) => d.page.evaluate(() => [...document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], summary, label.btn')].map((el) => {
    if (el.id === 'nl-badge-frame' || el.type === 'hidden' || el.type === 'file') return null;
    let box = el;
    if ((el.type === 'checkbox' || el.type === 'radio') && el.closest('label')) box = el.closest('label');
    const r = box.getBoundingClientRect();
    const cs = getComputedStyle(box);
    if (!r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'none') return null;
    if (el.tagName === 'A' && cs.display === 'inline' && el.closest('p, .notice, li')?.textContent.trim() !== el.textContent.trim()) return null; // a link inside a sentence (WCAG exception)
    if (r.width >= 43.5 && r.height >= 43.5) return null;
    return { el: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.dataset.act ? `[data-act=${el.dataset.act}]` : ''}`, text: (el.textContent || el.getAttribute('aria-label') || el.name || '').trim().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) };
  }).filter(Boolean));
  for (const viewport of WIDTHS) {
    const d = await qa.device(`w${viewport.width}`, { user: 'a', viewport });
    await d.open();
    for (const [name, hash] of screens(id)) {
      await d.go(hash);
      await d.page.waitForTimeout(300);
      for (const s of await measure(d)) small.push({ width: viewport.width, screen: name, ...s });
    }
    await d.go(`#/record/${id}`);
    await d.page.click('#delete-record');
    await d.page.waitForSelector('#confirm-delete');
    for (const s of await measure(d)) if (/sheet|confirm|cancel/i.test(s.el + s.text)) small.push({ width: viewport.width, screen: 'delete sheet', ...s });
    await d.context.close();
  }
  const out = await qa.device('signin', {});
  await out.open('', { sync: false });
  for (const s of await measure(out)) small.push({ width: 390, screen: 'signin', ...s });
  const lead = await qa.device('lead', { user: 'lead', viewport: WIDTHS[2] });
  await lead.open();
  await lead.page.waitForFunction(() => document.body.dataset.route === 'console');
  await lead.page.click(`aside [data-region="${state.regions.main}"]`);
  for (const s of await measure(lead)) small.push({ width: 1280, screen: 'console', ...s });
  const uniqSmall = [...new Map(small.map((s) => [`${s.screen}|${s.el}|${s.text}|${s.w}x${s.h}`, s])).values()];
  qa.note('smallControls', uniqSmall);
  const phone = uniqSmall.filter((s) => s.screen !== 'console' && s.screen !== 'styleguide');
  if (uniqSmall.length !== phone.length) qa.finding(`${uniqSmall.length - phone.length} small control(s) on the laptop-only console / style guide (mouse use, recorded only).`);
  expect(phone.map((s) => `${s.width}px ${s.screen}: ${s.el} "${s.text}" ${s.w}x${s.h}`), 'controls smaller than 44 x 44').toEqual([]);
});

test('K04 [P2] every status has text and a marker that is not only colour', async ({ qa }) => {
  const id = await seedContent(qa);
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  await d.offline();
  await d.createRecord({ title: uniq('K04 pending'), fields: { ph: 6 } });
  const del = await d.createRecord({ title: uniq('K04 delete'), fields: { ph: 6 } });
  await d.deleteRecord(del);
  const seen = {};
  for (const hash of ['#/records', `#/record/${id}`, '#/sync', '#/conflicts', '#/storage', '#/styleguide']) {
    await d.go(hash);
    await d.page.waitForTimeout(300);
    const list = await d.page.evaluate(() => [...document.querySelectorAll('.status')].map((el) => {
      const b = getComputedStyle(el, '::before');
      return { cls: el.className.replace('status', '').trim(), text: el.textContent.trim(), marker: b.content !== 'none' && b.display !== 'none', w: b.width, h: b.height, radius: b.borderRadius, bg: b.backgroundColor, border: b.borderTopWidth + ' ' + b.borderTopStyle, transform: b.transform, clip: b.clipPath, color: getComputedStyle(el).color };
    }));
    for (const s of list) seen[s.cls || '(none)'] = s;
  }
  await d.go('#/records');
  await d.shot('statuses-list');
  await d.go('#/styleguide');
  await d.shot('statuses-styleguide', { fullPage: true });
  qa.note('statuses', seen);
  const noText = Object.values(seen).filter((s) => !s.text);
  expect(noText, 'statuses without text').toEqual([]);
  // "plain" labels (Storage screen: Requested, Freeable, Kept...) are text-only by design: the word is the non-colour signal
  const plain = Object.values(seen).filter((s) => !s.marker && s.cls.split(' ').includes('plain'));
  if (plain.length) qa.finding(`Text-only status labels without a marker shape: ${plain.map((s) => s.text).join(', ')}. The word carries the meaning, so colour is not the only signal.`);
  expect(Object.values(seen).filter((s) => !s.marker && !s.cls.split(' ').includes('plain')).map((s) => s.cls), 'statuses without a marker').toEqual([]);
  const marked = Object.values(seen).filter((s) => s.marker);
  const shape = (s) => [s.radius, s.bg === 'rgba(0, 0, 0, 0)' ? 'hollow' : 'filled', s.transform, s.clip, s.w, s.h].join('|');
  const groups = {};
  for (const s of marked) (groups[shape(s)] ??= []).push(s.cls || '(none)');
  const shared = Object.values(groups).filter((g) => g.length > 1);
  qa.note('statusesSharingOneShape', shared);
  if (shared.length) qa.finding(`Several statuses use the same marker shape and differ only by colour and word: ${shared.map((g) => g.join(' = ')).join('; ')}. The word still tells them apart, so this passes PRD "shape + text", but the shape alone does not.`);
  await d.context.setOffline(false);
  await d.waitSynced();
});

test('K05 [P1] the status bar stays in view on every screen', async ({ qa }) => {
  const id = await seedContent(qa);
  const missing = [];
  for (const viewport of [WIDTHS[0], WIDTHS[2]]) {
    const d = await qa.device(`w${viewport.width}`, { user: 'a', viewport });
    await d.open();
    for (const [name, hash] of screens(id)) {
      await d.go(hash);
      await d.page.evaluate(() => { for (const el of [document.scrollingElement, ...document.querySelectorAll('main, .pane, .screen, #pane-list, #pane-detail')]) el.scrollTop = 1e6; });
      await d.page.waitForTimeout(150);
      const s = await d.page.evaluate(() => {
        const bar = document.querySelector('#statusbar');
        if (!bar) return { present: false };
        const r = bar.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { present: true, inView: r.top >= 0 && r.bottom <= innerHeight && r.height > 0, onTop: bar.contains(top), text: bar.querySelector('#sb-text')?.textContent ?? '', top: Math.round(r.top), h: Math.round(r.height) };
      });
      if (!s.present || !s.inView || !s.onTop || !s.text) missing.push({ width: viewport.width, screen: name, ...s });
    }
    await d.go('#/new');
    await d.page.evaluate(() => { for (const el of [document.scrollingElement, ...document.querySelectorAll('#pane-detail, .screen')]) el.scrollTop = 1e6; });
    await d.shot(`scrolled-form-${viewport.width}`);
    await d.context.close();
  }
  const out = await qa.device('signin', {});
  await out.open('', { sync: false });
  await expect(out.page.locator('#statusbar')).toBeInViewport();
  const lead = await qa.device('lead', { user: 'lead', viewport: WIDTHS[2] });
  await lead.open();
  await expect(lead.page.locator('#statusbar')).toBeInViewport();
  qa.note('notInView', missing);
  expect(missing, 'screens where the status bar is missing, covered or scrolled away').toEqual([]);
});

test('K06 [P2] sign in and create a record with the keyboard only', async ({ qa }) => {
  const d = await qa.device('deviceA', { viewport: WIDTHS[2] });
  d.userKey = 'a';
  await d.open('', { sync: false });
  const kb = d.page.keyboard;
  const focus = () => d.page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const cs = getComputedStyle(el);
    // a field may show focus on its wrapping box (label) instead of on the input itself
    const wrap = el.closest('label, .field');
    const ws = wrap ? getComputedStyle(wrap) : null;
    const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none' || (!!ws && wrap.matches(':focus-within') && ((ws.outlineStyle !== 'none' && parseFloat(ws.outlineWidth) > 0) || ws.boxShadow !== 'none' || parseFloat(ws.borderTopWidth) >= 2));
    return { tag: el.tagName.toLowerCase(), id: el.id, name: el.name ?? '', field: el.dataset.field ?? '', text: el.textContent.trim().slice(0, 24), type: el.type ?? '', ring, visible: el.matches(':focus-visible') };
  });
  const noRing = [];
  const tabs = {};
  const tabTo = async (pred, label, max = 900) => {
    for (let i = 0; i < max; i++) {
      tabs[label] = i + 1;
      await kb.press('Tab');
      const f = await focus();
      if (f && !f.ring) noRing.push(`${f.tag}${f.id ? '#' + f.id : ''} ${f.field || f.name || f.text}`);
      if (f && pred(f)) return f;
    }
    throw new Error(`keyboard could not reach: ${label}`);
  };
  await tabTo((f) => f.name === 'email', 'email box');
  await kb.type(state.users.a.email);
  await tabTo((f) => f.name === 'password', 'password box');
  await kb.type(state.password);
  await kb.press('Enter');
  await d.page.waitForFunction(() => document.body.dataset.route === 'records', null, { timeout: 30_000 });
  await d.waitSynced();
  await tabTo((f) => f.id === 'new-record', 'New record', 900);
  qa.note('tabPressesNeeded', tabs);
  if (tabs['New record'] > 40) qa.finding(`Reaching "New record" with the keyboard took ${tabs['New record']} Tab presses: every row of the list comes first and there is no skip link or shortcut.`);
  await kb.press('Enter');
  await d.page.waitForSelector('#record-form');
  const title = uniq('K06 keyboard');
  await tabTo((f) => f.field === 'title', 'title field');
  await kb.type(title);
  await tabTo((f) => f.field === 'ph', 'pH field');
  await kb.type('6.5');
  await tabTo((f) => f.field === 'notes', 'notes field');
  await kb.type('typed without a mouse');
  await expect(d.page.locator('#gps-box')).toHaveAttribute('data-gps', 'fixed');
  await tabTo((f) => f.id === 'save-record', 'Save');
  await d.shot('focus-on-save');
  await kb.press('Enter');
  await d.page.waitForFunction(() => !document.querySelector('#record-form'));
  await d.waitSynced();
  const rec = (await d.idb(['records'])).records.find((r) => r.fields.title === title);
  expect(rec, 'record made by keyboard').toBeTruthy();
  expect(rec.fields).toMatchObject({ ph: 6.5, notes: 'typed without a mouse' });
  // delete sheet: opens by keyboard, focus goes inside, Escape closes it
  await d.go(`#/record/${rec.id}`);
  await tabTo((f) => f.id === 'delete-record', 'Delete');
  await kb.press('Enter');
  await d.page.waitForSelector('#confirm-delete');
  const inSheet = await d.page.evaluate(() => !!document.activeElement?.closest('#sheet-root'));
  await kb.press('Escape');
  const closed = await d.page.waitForFunction(() => !document.querySelector('#confirm-delete'), null, { timeout: 3000 }).then(() => true).catch(() => false);
  qa.note('sheet', { focusMovedIntoSheet: inSheet, escapeCloses: closed });
  qa.note('focusWithoutVisibleRing', [...new Set(noRing)]);
  if (!inSheet) qa.finding('When the delete sheet opens, keyboard focus stays on the page behind it.');
  expect(closed, 'Escape closes the delete sheet').toBe(true);
  expect([...new Set(noRing)], 'controls with no visible focus ring').toEqual([]);
});

test('K07 [P2] text contrast meets WCAG AA on every screen', async ({ qa }) => {
  test.setTimeout(400_000);
  const id = await seedContent(qa);
  const all = [];
  const other = {};
  const scan = async (d, name) => {
    await d.page.evaluate(AXE);
    const r = await d.page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } }));
    for (const v of r.violations) {
      if (v.id === 'color-contrast') for (const n of v.nodes) all.push({ screen: name, target: n.target.join(' '), text: n.html.replace(/<[^>]+>/g, '').trim().slice(0, 40), ratio: n.any[0]?.data?.contrastRatio, need: n.any[0]?.data?.expectedContrastRatio, fg: n.any[0]?.data?.fgColor, bg: n.any[0]?.data?.bgColor });
      else (other[v.id] ??= { impact: v.impact, help: v.help, screens: [] }).screens.push(name);
    }
  };
  const d = await qa.device('deviceA', { user: 'a' });
  await d.open();
  await d.offline();
  await d.createRecord({ title: uniq('K07 pending'), fields: { ph: 6 } });
  for (const [name, hash] of screens(id)) { await d.go(hash); await d.page.waitForTimeout(300); await scan(d, name); }
  await d.context.setOffline(false);
  await d.waitSynced();
  const out = await qa.device('signin', {});
  await out.open('', { sync: false });
  await scan(out, 'signin');
  const lead = await qa.device('lead', { user: 'lead', viewport: WIDTHS[2] });
  await lead.open();
  await lead.page.waitForFunction(() => document.body.dataset.route === 'console');
  await lead.page.click(`aside [data-region="${state.regions.main}"]`);
  await scan(lead, 'console');
  const distinct = [...new Map(all.map((v) => [`${v.fg}|${v.bg}|${v.target}`, v])).values()];
  qa.note('contrastViolations', distinct);
  qa.note('otherAxeViolations', other);
  writeFileSync(resolve(qa.dir, 'axe.json'), JSON.stringify({ contrast: all, other }, null, 2));
  for (const [rule, v] of Object.entries(other)) qa.finding(`axe ${rule} (${v.impact}): ${v.help} on ${[...new Set(v.screens)].join(', ')}`);
  expect(distinct.map((v) => `${v.screen}: "${v.text}" ${v.ratio}:1 (needs ${v.need}:1) ${v.fg} on ${v.bg}`), 'text below AA contrast').toEqual([]);
});

test('K08 [P3] Lighthouse scores', async ({ qa }) => {
  test.setTimeout(400_000);
  const file = resolve(qa.dir, 'lighthouse.json');
  const run = () => new Promise((res) => {
    execFile(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['-y', 'lighthouse@12', BASE_URL, '--quiet', '--output=json', `--output-path=${file}`, '--form-factor=mobile', '--chrome-flags=--headless=new --no-sandbox'],
      { env: { ...process.env, CHROME_PATH: chromium.executablePath() }, timeout: 300_000, shell: process.platform === 'win32', maxBuffer: 64e6 }, (err, so, se) => res({ err, se: String(se).slice(-600) }));
  });
  let r = await run();
  if (!existsSync(file)) r = await run();
  if (!existsSync(file)) qa.blocked(`Lighthouse could not run here: ${String(r.err?.message ?? r.se).split('\n')[0].slice(0, 200)}`, 'Open the site in Chrome, DevTools > Lighthouse > Mobile > Analyze page load, note the four scores.');
  const lh = JSON.parse(readFileSync(file, 'utf8'));
  const scores = Object.fromEntries(Object.entries(lh.categories).map(([k, v]) => [k, Math.round((v.score ?? 0) * 100)]));
  const failed = Object.values(lh.audits).filter((a) => a.score !== null && a.score < 0.9 && a.scoreDisplayMode === 'binary').map((a) => a.id);
  qa.note('scores', scores);
  qa.note('failedAudits', failed);
  qa.note('metrics', { fcp: lh.audits['first-contentful-paint']?.displayValue, lcp: lh.audits['largest-contentful-paint']?.displayValue, tbt: lh.audits['total-blocking-time']?.displayValue, cls: lh.audits['cumulative-layout-shift']?.displayValue });
  for (const [k, v] of Object.entries(scores)) expect(v, `Lighthouse ${k}`).toBeGreaterThanOrEqual(90);
});

test('K09 [P1] nothing from the host covers the app controls on the live site', async ({ qa }) => {
  const id = await seedContent(qa);
  const d = await qa.device('deviceA', { user: 'a', hud: true });
  await d.open();
  await d.page.waitForTimeout(4000);                      // the host script adds its badge after load
  const badge = await d.page.evaluate(() => {
    const el = document.querySelector('#nl-badge-frame, iframe[src*="netlify"], [id*="netlify" i]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { tag: el.tagName, id: el.id, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), z: getComputedStyle(el).zIndex };
  });
  qa.note('hostBadge', badge);
  const covered = [];
  const check = async (screen, selector) => {
    const loc = d.page.locator(selector).first();
    if (!(await loc.count())) return;
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    const hit = await loc.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const pts = [[0.5, 0.5], [0.85, 0.5], [0.15, 0.5], [0.5, 0.8]];
      const blockedBy = new Set();
      let blocked = 0;
      for (const [fx, fy] of pts) { const t = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy); if (t && !el.contains(t) && !t.contains(el)) { blocked++; blockedBy.add(`${t.tagName.toLowerCase()}#${t.id}`); } }
      return { blocked, of: pts.length, by: [...blockedBy], rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
    });
    if (hit.blocked) covered.push({ screen, selector, ...hit });
  };
  await d.go('#/records');
  await d.shot('records-as-deployed');
  for (const s of ['#nav a[href="#/records"]', '#nav a[href="#/tracks"]', '#nav a[href="#/sync"]', 'a[href="#/new"]']) await check('records', s);
  await d.go('#/new'); await d.page.waitForSelector('#record-form'); await check('new', '#save-record');
  await d.go('#/sync'); await check('sync', '#sync-now'); await d.shot('sync-as-deployed');
  await d.go('#/tracks'); await check('tracks', '#start-track');
  await d.go(`#/record/${id}`); await check('record', '#delete-record');
  await d.page.locator('#delete-record').click({ timeout: 5000 }).catch(() => d.page.locator('#delete-record').dispatchEvent('click'));
  await d.page.waitForSelector('#confirm-delete');
  await check('delete sheet', '#confirm-delete');
  await check('delete sheet', '#sheet-root [data-act="cancel"], #sheet-root button:not(#confirm-delete)');
  await d.shot('delete-sheet-as-deployed');
  await d.page.keyboard.press('Escape');
  await d.go('#/regions');
  await d.page.locator('[data-act="signout"]').click({ timeout: 5000 }).catch(() => d.page.locator('[data-act="signout"]').dispatchEvent('click'));
  await d.page.waitForSelector('#sheet-root [data-act="leave"], #sheet-root [data-act="keep"]', { timeout: 5000 }).catch(() => {});
  await check('sign out sheet', '#sheet-root [data-act="leave"]');
  await check('sign out sheet', '#sheet-root [data-act="keep"]');
  await d.shot('signout-sheet-as-deployed');
  qa.note('coveredControls', covered);
  expect(covered.map((c) => `${c.screen}: ${c.selector} covered at ${c.blocked}/${c.of} points by ${c.by.join(', ')}`), 'controls covered by the host badge').toEqual([]);
});
