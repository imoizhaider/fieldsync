// Runs once before the end-to-end tests:
//   * signs the three seeded accounts in and saves each session as a browser
//     storage state (so every test starts as a device that signed in before)
//   * writes the photo fixtures
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { loadEnv, ROOT } from '../../scripts/env.mjs';
import { fixturePhoto } from '../../scripts/png.mjs';

export default async function globalSetup(config) {
  const env = loadEnv();
  const seedFile = resolve(ROOT, 'tests/.auth/seed.json');
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SEED_PASSWORD || !existsSync(seedFile)) {
    throw new Error('No backend: set up .env and run `npm run schema && npm run seed` first (see README.md).');
  }
  const seed = JSON.parse(readFileSync(seedFile, 'utf8'));
  const origin = new URL(config.projects[0].use.baseURL).origin;

  for (const [key, user] of Object.entries(seed.users)) {
    const client = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    let session = null;
    for (let attempt = 1; attempt <= 3 && !session; attempt++) {
      const { data, error } = await client.auth.signInWithPassword({ email: user.email, password: env.SEED_PASSWORD });
      if (data?.session) session = data.session;
      else if (attempt === 3) throw new Error(`Sign-in failed for ${user.email}: ${error?.message}`);
      else await new Promise((r) => { setTimeout(r, 1500); });
    }
    writeFileSync(resolve(ROOT, `tests/.auth/${key}.json`), JSON.stringify({
      cookies: [],
      origins: [{ origin, localStorage: [{ name: 'fieldsync-auth', value: JSON.stringify(session) }] }],
    }));
  }

  const dir = resolve(ROOT, 'tests/fixtures/generated');
  mkdirSync(dir, { recursive: true });
  for (const n of [1, 2, 3]) {
    const file = resolve(dir, `photo-${n}.png`);
    if (!existsSync(file)) writeFileSync(file, fixturePhoto(2400, 1800, n));
  }
}
