// Resets test data and makes sure the demo accounts exist.
//   Region A: Researcher A (edit), Researcher B (edit), Data lead
//   Region B: Researcher A (edit), Data lead        <- Researcher B is NOT assigned
//   Region C: Researcher A (view), Researcher B (view), Data lead
// WARNING: this deletes every record, photo, GPS log and conflict in the project.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { loadEnv, ROOT } from './env.mjs';
import { ensureAccount } from './lib/accounts.mjs';

const env = loadEnv();
for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_KEY', 'SUPABASE_DB_URL']) {
  if (!env[k]) { console.error(`seed: ${k} is not set (see .env.example)`); process.exit(2); }
}

// One shared password for the three demo accounts, kept out of git in .env.local.
let password = env.SEED_PASSWORD;
if (!password) {
  password = 'Fs-' + randomBytes(9).toString('base64url');
  appendFileSync(resolve(ROOT, '.env.local'), `SEED_PASSWORD=${password}\n`);
  console.log('seed: generated SEED_PASSWORD and saved it to .env.local');
}

export const USERS = [
  { key: 'researcherA', email: 'researcher.a@example.org', name: 'Researcher A' },
  { key: 'researcherB', email: 'researcher.b@example.org', name: 'Researcher B' },
  { key: 'lead', email: 'data.lead@example.org', name: 'Data lead' },
];
const REGIONS = ['Region A', 'Region B', 'Region C'];
const MEMBERS = [
  ['Region A', 'researcherA', 'editor'], ['Region A', 'researcherB', 'editor'], ['Region A', 'lead', 'lead'],
  ['Region B', 'researcherA', 'editor'], ['Region B', 'lead', 'lead'],
  ['Region C', 'researcherA', 'viewer'], ['Region C', 'researcherB', 'viewer'], ['Region C', 'lead', 'lead'],
];

const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
// Public-key client, only to check that a demo password still works (see lib/accounts.mjs).
const anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
// The admin API is called over the network; retry a dropped request a few times.
async function retry(label, fn) {
  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fn().catch((err) => ({ error: err }));
    if (!res.error) return res;
    last = res.error;
    if (!/fetch failed|network|timeout|ECONN|socket/i.test(String(last.message))) break;
    await new Promise((r) => { setTimeout(r, 1000 * attempt); });
  }
  throw new Error(`${label} failed: ${last.message}`);
}

const db = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();

try {
  // 1. Remove uploaded photos (through the Storage API, which also frees the files).
  const objects = (await db.query("select name from storage.objects where bucket_id = 'photos'")).rows.map((r) => r.name);
  for (let i = 0; i < objects.length; i += 100) {
    await retry('storage remove', () => admin.storage.from('photos').remove(objects.slice(i, i + 100)));
  }

  // 2. Empty the data tables.
  await db.query('truncate public.conflict_log, public.media, public.gps_logs, public.records, public.applied_ops, public.devices');

  // 3. Accounts.
  const { data: list } = await retry('list users', () => admin.auth.admin.listUsers({ page: 1, perPage: 200 }));
  const ids = {};
  for (const u of USERS) {
    const found = list.users.find((x) => x.email === u.email) ?? null;
    ids[u.key] = (await ensureAccount({ admin, anon, existing: found, email: u.email, password, retry })).id;
    await db.query(
      'insert into public.profiles (user_id, display_name) values ($1, $2) on conflict (user_id) do update set display_name = excluded.display_name',
      [ids[u.key], u.name]);
  }

  // 4. Regions and who may edit them.
  const regionIds = {};
  for (const name of REGIONS) {
    const r = await db.query(
      'insert into public.regions (name) values ($1) on conflict (name) do update set name = excluded.name returning id', [name]);
    regionIds[name] = r.rows[0].id;
  }
  await db.query('delete from public.region_members');
  for (const [region, user, role] of MEMBERS) {
    await db.query('insert into public.region_members (region_id, user_id, role) values ($1, $2, $3)',
      [regionIds[region], ids[user], role]);
  }

  mkdirSync(resolve(ROOT, 'tests/.auth'), { recursive: true });
  writeFileSync(resolve(ROOT, 'tests/.auth/seed.json'), JSON.stringify({
    users: Object.fromEntries(USERS.map((u) => [u.key, { id: ids[u.key], email: u.email, name: u.name }])),
    regions: regionIds,
  }, null, 2));
  console.log(`seed: reset data, ${USERS.length} accounts, ${REGIONS.length} regions, removed ${objects.length} stored photos`);
} finally {
  await db.end();
}
