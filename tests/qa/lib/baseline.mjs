// Read-only: row counts per table, split into QA rows and everything else.
import pg from 'pg';
import { loadEnv } from '../../../scripts/env.mjs';
const env = loadEnv();
const db = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const q = async (s) => (await db.query(s)).rows;
console.log(JSON.stringify({
  regions: await q("select name, (select count(*)::int from public.records r where r.region_id = g.id) records from public.regions g order by name"),
  users: await q("select count(*)::int n, count(*) filter (where email ~ '^qa-')::int qa from auth.users"),
  totals: (await q(`select (select count(*)::int from public.records) records, (select count(*)::int from public.media) media,
    (select count(*)::int from public.gps_logs) gps_logs, (select count(*)::int from public.conflict_log) conflict_log,
    (select count(*)::int from public.applied_ops) applied_ops, (select count(*)::int from public.devices) devices,
    (select count(*)::int from storage.objects where bucket_id='photos') objects, (select count(*)::int from public.region_members) members,
    (select count(*)::int from public.profiles) profiles`))[0],
}, null, 1));
await db.end();
