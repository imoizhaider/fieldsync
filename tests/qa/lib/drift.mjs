// Read-only: rows outside the QA regions that are newer than the QA baseline.
// Used once to explain why totals differ from the baseline. Prints no secrets.
import pg from 'pg';
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync(new URL('../../../.env', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
const url = env.DATABASE_URL ?? env.SUPABASE_DB_URL ?? env.POSTGRES_URL;
const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await db.connect();
const since = process.argv[2] ?? '2026-11-15T12:00:00Z';
const q = async (label, text) => console.log(label, JSON.stringify((await db.query(text, [since])).rows, null, 1));
await q('records', "select r.id, g.name region, r.type, r.fields->>'title' title, r.version, r.deleted, r.updated_at, p.display_name by from public.records r join public.regions g on g.id = r.region_id left join public.profiles p on p.user_id = r.updated_by where r.updated_at > $1 order by r.updated_at");
await q('gps_logs', "select l.id, g.name region, l.kind, l.updated_at, p.display_name by from public.gps_logs l join public.regions g on g.id = l.region_id left join public.profiles p on p.user_id = l.created_by where l.updated_at > $1 order by l.updated_at");
await q('devices', "select left(d.device_id, 8) device, p.display_name by, d.last_sync_at from public.devices d left join public.profiles p on p.user_id = d.user_id where d.last_sync_at > $1 order by d.last_sync_at");
await q('applied_ops', "select count(*)::int n, min(at) first_at, max(at) last_at from public.applied_ops where at > $1");
await db.end();
