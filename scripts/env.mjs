// Loads .env and .env.local into process.env without printing anything.
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv() {
  for (const name of ['.env', '.env.local']) {
    const file = resolve(ROOT, name);
    if (existsSync(file)) process.loadEnvFile(file);
  }
  return process.env;
}

export function hasBackend() {
  const e = loadEnv();
  return Boolean(e.SUPABASE_URL && e.SUPABASE_ANON_KEY && e.SUPABASE_SERVICE_KEY && e.SUPABASE_DB_URL);
}
