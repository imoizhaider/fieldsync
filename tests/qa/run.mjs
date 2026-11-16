// `npm run qa` : set up QA data, run the whole suite, clean up, print one line
// per case, exit non-zero if any P0 or P1 case failed.
//   --keep           keep the QA data (no clean-up) so more categories can be run
//   --cleanup-only   only delete QA data and print the proof counts
//   anything else is passed to Playwright (for example: -g "^A")
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../../scripts/env.mjs';
import { setup, cleanup, counts } from './lib/admin.mjs';
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const cleanupOnly = args.includes('--cleanup-only');
const pwArgs = args.filter((a) => a !== '--keep' && a !== '--cleanup-only');
const ART = resolve(ROOT, 'artifacts/qa');
mkdirSync(ART, { recursive: true });
const RESULTS = resolve(ART, 'results.json');

async function doCleanup() {
  const log = await cleanup();
  const after = await counts();
  writeFileSync(resolve(ART, 'cleanup.json'), JSON.stringify({ at: new Date().toISOString(), deleted: log, after }, null, 2));
  console.log('\nClean-up: ' + log.join(', '));
  console.log('QA rows left: ' + JSON.stringify(after.qa));
  if (Object.values(after.qa).some((n) => n !== 0)) { console.error('Clean-up left QA rows behind'); process.exitCode = 1; }
}

if (cleanupOnly) { await doCleanup(); process.exit(process.exitCode ?? 0); }

await setup();
const out = resolve(ART, '_pw-results.json');
rmSync(out, { force: true });
const pw = spawnSync(process.execPath, [resolve(ROOT, 'node_modules/@playwright/test/cli.js'), 'test', '-c', resolve(ROOT, 'tests/qa/playwright.config.js'), ...pwArgs],
  { cwd: ROOT, stdio: 'inherit', env: process.env });

const cases = pwArgs.length > 0 && existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : {};
if (existsSync(out)) {
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      const m = /^([A-M]\d\d) \[(P\d)\] (.*)$/.exec(spec.title);
      if (!m) continue;
      const t = spec.tests[0];
      const blocked = t.annotations?.find((a) => a.type === 'blocked')
        ?? t.results.flatMap((r) => r.annotations ?? []).find((a) => a.type === 'blocked');
      const result = blocked || t.status === 'skipped' ? 'BLOCKED' : { expected: 'PASS', unexpected: 'FAIL', flaky: 'FLAKY' }[t.status];
      const lastErr = [...t.results].reverse().find((r) => r.error)?.error?.message ?? '';
      cases[m[1]] = {
        id: m[1], severity: m[2], title: m[3], result, attempts: t.results.length,
        durationMs: t.results.reduce((s, r) => s + r.duration, 0),
        error: result === 'PASS' ? null : (blocked?.description ?? lastErr.replace(ANSI, '').split('\n').slice(0, 6).join(' | ').slice(0, 600)),
        evidence: `artifacts/qa/${m[1]}/`,
      };
    }
    for (const s of suite.suites ?? []) walk(s);
  };
  for (const s of JSON.parse(readFileSync(out, 'utf8')).suites ?? []) walk(s);
  writeFileSync(RESULTS, JSON.stringify(cases, null, 2));
}

if (!existsSync(out)) { console.error(`Playwright did not produce results (exit ${pw.status})`); process.exitCode = 2; }

if (!keep) await doCleanup();

const list = Object.values(cases).sort((a, b) => a.id.localeCompare(b.id));
console.log('');
for (const c of list) console.log(`${c.id} ${c.result.padEnd(7)} ${c.severity} ${c.title}`);
const tally = (r) => list.filter((c) => c.result === r).length;
console.log(`\n${list.length} cases: PASS ${tally('PASS')}, FAIL ${tally('FAIL')}, FLAKY ${tally('FLAKY')}, BLOCKED ${tally('BLOCKED')}`);
const bad = list.filter((c) => c.result === 'FAIL' && (c.severity === 'P0' || c.severity === 'P1'));
if (bad.length > 0) { console.log(`P0/P1 failures: ${bad.map((c) => c.id).join(', ')}`); process.exitCode = 1; }
