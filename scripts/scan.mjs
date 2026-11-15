// Gate G10: the built output must not contain the service key or any runtime
// CDN URL. Exits non-zero when something is found.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { loadEnv, ROOT } from './env.mjs';

const env = loadEnv();
const DIST = resolve(ROOT, 'dist');
if (!existsSync(DIST)) {
  console.error('scan: dist/ does not exist, run `npm run build` first');
  process.exit(2);
}

const CDN_HOSTS = [
  'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'esm.sh', 'cdn.skypack.dev', 'ga.jspm.io',
  'fonts.googleapis.com', 'fonts.gstatic.com', 'ajax.googleapis.com', 'code.jquery.com', 'cdn.tailwindcss.com',
  'stackpath.bootstrapcdn.com', 'use.fontawesome.com', 'use.typekit.net',
];
// Anything that would make the browser load a file from another origin.
const REMOTE_LOADS = [
  /<script[^>]+src=["']https?:\/\//i,
  /<link[^>]+href=["']https?:\/\//i,
  /@import\s+(url\()?["']?https?:\/\//i,
  /url\(\s*["']?https?:\/\//i,
  /\bimport\s*(\(|[\w*{}\s,]+from\s*)["']https?:\/\//,
  /importScripts\(\s*["']https?:\/\//,
];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const problems = [];
const serviceKey = env.SUPABASE_SERVICE_KEY;
const dbUrl = env.SUPABASE_DB_URL;
const seedPassword = env.SEED_PASSWORD;
const files = walk(DIST);

for (const file of files) {
  const name = relative(DIST, file).replaceAll('\\', '/');
  const text = readFileSync(file).toString('latin1');
  if (serviceKey && text.includes(serviceKey)) problems.push(`${name}: contains the Supabase service key`);
  if (/sb_secret_[A-Za-z0-9_-]{8,}/.test(text)) problems.push(`${name}: contains a Supabase secret key`);
  if (/service_role/.test(text) && /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/.test(text)) problems.push(`${name}: may contain a service_role JWT`);
  if (dbUrl && text.includes(dbUrl)) problems.push(`${name}: contains the database connection string`);
  if (/postgres(ql)?:\/\/[^\s"']+:[^\s"']+@/.test(text)) problems.push(`${name}: contains a Postgres connection string`);
  if (seedPassword && text.includes(seedPassword)) problems.push(`${name}: contains the seed password`);
  if (/\.(html|css|js|webmanifest|json)$/.test(name)) {
    for (const host of CDN_HOSTS) if (text.includes(host)) problems.push(`${name}: references CDN host ${host}`);
    for (const re of REMOTE_LOADS) {
      const m = text.match(re);
      if (m) problems.push(`${name}: loads a remote file (${m[0].slice(0, 70)})`);
    }
  }
}

if (problems.length > 0) {
  console.error(`scan: ${problems.length} problem(s)`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log(`scan: ${files.length} files clean (no service key, no runtime CDN URLs)`);
