// Applies supabase/schema.sql to the database in SUPABASE_DB_URL.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { loadEnv, ROOT } from './env.mjs';

const env = loadEnv();
if (!env.SUPABASE_DB_URL) {
  console.error('schema: SUPABASE_DB_URL is not set (see .env.example)');
  process.exit(2);
}
const sql = readFileSync(resolve(ROOT, 'supabase/schema.sql'), 'utf8');
const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query(sql);
  console.log('schema: applied supabase/schema.sql');
} finally {
  await client.end();
}
