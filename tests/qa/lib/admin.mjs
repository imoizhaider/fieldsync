// QA test data: set-up, clean-up and count queries.
// The service key and the database URL are used ONLY here, in Node. Never in a browser.
// Everything this file creates is named QA-<ts>... / qa-<x>+<ts>@example.org and
// clean-up only ever matches those names.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { loadEnv, ROOT } from '../../../scripts/env.mjs';
import { fixturePhoto } from '../../../scripts/png.mjs';

export const env = loadEnv();
export const STATE_DIR = resolve(ROOT, 'tests/.auth/qa'); // git-ignored (tests/.auth/)
export const STATE_FILE = resolve(STATE_DIR, 'run.json');
export const FIXTURES = resolve(ROOT, 'tests/fixtures/generated/qa');

const REGION_RE = '^QA-[0-9]{13}(-B|-V|-E)?$';
const EMAIL_RE = '^qa-(a|b|lead)\\+[0-9]{13}@example\\.org$';

export function readState() {
  return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : null;
}

function admin() {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function withDb(fn) {
  const db = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  try { return await fn(db); } finally { await db.end(); }
}

// One fresh session per user, saved for the browser contexts and the API tests.
export async function signIn(state, key) {
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  let last;
  for (let i = 0; i < 4; i++) {
    const { data, error } = await client.auth.signInWithPassword({ email: state.users[key].email, password: state.password });
    if (data?.session) {
      writeFileSync(resolve(STATE_DIR, `${key}.session.json`), JSON.stringify({ at: Date.now(), session: data.session }));
      return data.session;
    }
    last = error;
    await new Promise((r) => { setTimeout(r, 2000 * (i + 1)); });
  }
  throw new Error(`QA sign-in failed for ${key}: ${last?.message}`);
}

function bmp(width, height) {
  // 24-bit uncompressed BMP with a gradient + noise. 2400 x 1600 is about 11.5 MB.
  const row = Math.ceil((width * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + row * height);
  buf.write('BM'); buf.writeUInt32LE(buf.length, 2); buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14); buf.writeInt32LE(width, 18); buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28); buf.writeUInt32LE(row * height, 34);
  let s = 12345;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const o = 54 + y * row + x * 3;
      buf[o] = (x * 255 / width) | 0; buf[o + 1] = (y * 255 / height) | 0; buf[o + 2] = s & 0xff;
    }
  }
  return buf;
}

export function writeFixtures() {
  mkdirSync(FIXTURES, { recursive: true });
  for (let n = 1; n <= 10; n++) {
    const f = resolve(FIXTURES, `photo-${n}.png`);
    if (!existsSync(f)) writeFileSync(f, fixturePhoto(1600, 1200, n));
  }
  const big = resolve(FIXTURES, 'big-11mb.bmp');
  if (!existsSync(big)) writeFileSync(big, bmp(2400, 1600));
  writeFileSync(resolve(FIXTURES, 'not-an-image.txt'), 'This is a text file, not a photo.\n');
  writeFileSync(resolve(FIXTURES, 'fake-image.jpg'), 'This is text with a .jpg name.\n');
}

export async function setup() {
  const old = readState();
  if (old) return old;
  mkdirSync(STATE_DIR, { recursive: true });
  writeFixtures();
  const ts = Date.now();
  const password = 'Qa-' + randomBytes(12).toString('base64url');
  const sb = admin();
  const state = { ts, password, users: {}, regions: {}, names: {} };
  // Written before anything is created, so a crash half-way can still be cleaned up by name.
  for (const key of ['a', 'b', 'lead']) {
    const email = `qa-${key}+${ts}@example.org`;
    const { data, error } = await sb.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(`create ${email}: ${error.message}`);
    state.users[key] = { id: data.user.id, email, name: { a: 'QA Researcher A', b: 'QA Researcher B', lead: 'QA Data lead' }[key] };
  }
  await withDb(async (db) => {
    for (const u of Object.values(state.users)) {
      await db.query('insert into public.profiles (user_id, display_name) values ($1, $2)', [u.id, u.name]);
    }
    for (const [key, name] of [['main', `QA-${ts}`], ['other', `QA-${ts}-B`], ['view', `QA-${ts}-V`]]) {
      state.regions[key] = (await db.query('insert into public.regions (name) values ($1) returning id', [name])).rows[0].id;
      state.names[key] = name;
    }
    const members = [
      ['main', 'a', 'editor'], ['main', 'b', 'editor'], ['main', 'lead', 'lead'],
      ['other', 'a', 'editor'], ['other', 'lead', 'lead'],
      ['view', 'a', 'viewer'], ['view', 'b', 'viewer'], ['view', 'lead', 'lead'],
    ];
    for (const [r, u, role] of members) {
      await db.query('insert into public.region_members (region_id, user_id, role) values ($1, $2, $3)', [state.regions[r], state.users[u].id, role]);
    }
  });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  for (const key of Object.keys(state.users)) await signIn(state, key);
  return state;
}

// Rows that belong to QA runs (by name pattern), and everything else.
export async function counts() {
  return withDb(async (db) => {
    const one = async (text, params = []) => (await db.query(text, params)).rows[0];
    const regions = (await db.query('select id from public.regions where name ~ $1', [REGION_RE])).rows.map((r) => r.id);
    const users = (await db.query('select id from auth.users where email ~ $1', [EMAIL_RE])).rows.map((r) => r.id);
    const qa = await one(`select
      (select count(*)::int from public.regions where id = any($1::uuid[])) regions,
      (select count(*)::int from public.region_members where region_id = any($1::uuid[]) or user_id = any($2::uuid[])) region_members,
      (select count(*)::int from public.records where region_id = any($1::uuid[])) records,
      (select count(*)::int from public.media where region_id = any($1::uuid[])) media,
      (select count(*)::int from public.gps_logs where region_id = any($1::uuid[])) gps_logs,
      (select count(*)::int from public.conflict_log where region_id = any($1::uuid[])) conflict_log,
      (select count(*)::int from public.applied_ops where user_id = any($2::uuid[])) applied_ops,
      (select count(*)::int from public.devices where user_id = any($2::uuid[])) devices,
      (select count(*)::int from public.profiles where user_id = any($2::uuid[])) profiles,
      (select count(*)::int from auth.users where id = any($2::uuid[])) auth_users,
      (select count(*)::int from storage.objects where bucket_id = 'photos'
         and (split_part(name, '/', 1) = any($3::text[]) or owner_id = any($4::text[]))) storage_objects`,
    [regions, users, regions, users]);
    const all = await one(`select
      (select count(*)::int from public.regions) regions, (select count(*)::int from public.region_members) region_members,
      (select count(*)::int from public.records) records, (select count(*)::int from public.media) media,
      (select count(*)::int from public.gps_logs) gps_logs, (select count(*)::int from public.conflict_log) conflict_log,
      (select count(*)::int from public.applied_ops) applied_ops, (select count(*)::int from public.devices) devices,
      (select count(*)::int from public.profiles) profiles, (select count(*)::int from auth.users) auth_users,
      (select count(*)::int from storage.objects where bucket_id = 'photos') storage_objects`);
    return { qa, all };
  });
}

export async function cleanup() {
  const sb = admin();
  const log = [];
  await withDb(async (db) => {
    const regions = (await db.query('select id, name from public.regions where name ~ $1', [REGION_RE])).rows;
    const users = (await db.query('select id, email from auth.users where email ~ $1', [EMAIL_RE])).rows;
    const rid = regions.map((r) => r.id);
    const uid = users.map((u) => u.id);
    const objects = (await db.query(
      `select name from storage.objects where bucket_id = 'photos'
         and (split_part(name, '/', 1) = any($1::text[]) or owner_id = any($2::text[]))`, [rid, uid])).rows.map((r) => r.name);
    for (let i = 0; i < objects.length; i += 100) {
      const { error } = await sb.storage.from('photos').remove(objects.slice(i, i + 100));
      if (error) throw new Error(`storage remove: ${error.message}`);
    }
    log.push(`storage objects removed: ${objects.length}`);
    const del = async (label, text, params) => { log.push(`${label}: ${(await db.query(text, params)).rowCount}`); };
    await del('conflict_log', 'delete from public.conflict_log where region_id = any($1::uuid[])', [rid]);
    await del('media', 'delete from public.media where region_id = any($1::uuid[])', [rid]);
    await del('gps_logs', 'delete from public.gps_logs where region_id = any($1::uuid[])', [rid]);
    await del('records', 'delete from public.records where region_id = any($1::uuid[])', [rid]);
    await del('applied_ops', 'delete from public.applied_ops where user_id = any($1::uuid[])', [uid]);
    await del('devices', 'delete from public.devices where user_id = any($1::uuid[])', [uid]);
    await del('region_members', 'delete from public.region_members where region_id = any($1::uuid[]) or user_id = any($2::uuid[])', [rid, uid]);
    await del('regions', 'delete from public.regions where id = any($1::uuid[])', [rid]);
    await del('profiles', 'delete from public.profiles where user_id = any($1::uuid[])', [uid]);
    for (const u of users) {
      const { error } = await sb.auth.admin.deleteUser(u.id);
      if (error) throw new Error(`delete user: ${error.message}`);
    }
    log.push(`auth users: ${users.length}`);
  });
  rmSync(STATE_DIR, { recursive: true, force: true });
  return log;
}
