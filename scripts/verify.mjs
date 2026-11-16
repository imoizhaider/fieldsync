// npm run verify
// Runs lint, unit tests, build, schema apply, seed, end-to-end tests and the
// secret scan, then prints one line per gate. Exits non-zero unless every
// gate passed. A gate that did not run is reported as BLOCKED, never as PASS.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hasBackend, ROOT } from './env.mjs';

const GATES = [
  ['T1', 'Offline create with 3 photos and a GPS point, then reload'],
  ['T2', 'Go online with no button press'],
  ['T3', 'Different fields edited on two devices'],
  ['T4', 'Same field edited on two devices'],
  ['T5', 'Photo upload aborted mid-flight, then reconnect'],
  ['T6', 'Delete on device A, both sync'],
  ['G7', 'Open the app with the network off'],
  ['G8', 'Write to a region that is not assigned'],
  ['G9', 'Edit a record another device deleted'],
  ['G10', 'No service key and no runtime CDN URL in the build'],
  ['G11', 'Installable: manifest and service worker'],
  ['G12', 'Screens at 390, 820 and 1280 px'],
];

const ART = resolve(ROOT, 'artifacts');
mkdirSync(ART, { recursive: true });
const started = Date.now();
const steps = [];

function run(name, command, args, { required = true } = {}) {
  process.stdout.write(`\n=== ${name} ===\n`);
  const t = Date.now();
  const r = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32', env: process.env });
  const ok = r.status === 0;
  steps.push({ name, ok, seconds: ((Date.now() - t) / 1000).toFixed(1), required });
  return ok;
}

const node = process.execPath.includes(' ') ? `"${process.execPath}"` : process.execPath;
const backend = hasBackend();

const lintOk = run('lint', 'npx', ['eslint', '.']);
const unitOk = run('unit tests', node, ['--test', 'tests/unit/merge.test.js', 'tests/unit/net.test.js']);
const buildOk = run('build', node, ['scripts/build.mjs']);

let e2eRan = false;
const resultsFile = resolve(ART, 'e2e-results.json');
rmSync(resultsFile, { force: true });
rmSync(resolve(ART, 'failures'), { recursive: true, force: true });

if (!backend) {
  console.log('\nNo backend configured (.env missing or incomplete): schema, seed and end-to-end gates are BLOCKED. See HANDOFF.md.');
} else if (buildOk) {
  const schemaOk = run('schema apply', node, ['scripts/apply-schema.mjs']);
  const seedOk = schemaOk && run('seed', node, ['scripts/seed.mjs']);
  if (seedOk) {
    run('end-to-end tests', 'npx', ['playwright', 'test']);
    e2eRan = existsSync(resultsFile);
  }
}
const scanOk = buildOk && run('secret scan', node, ['scripts/scan.mjs']);

// ------------------------------------------------------------ gate table
const tests = [];
if (e2eRan) {
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      const results = spec.tests.flatMap((t) => t.results.map((r) => r.status));
      const statuses = spec.tests.map((t) => t.status);
      tests.push({
        title: spec.title,
        ok: spec.ok && statuses.every((s) => s === 'expected') && results.length > 0 && results.every((s) => s === 'passed'),
        skipped: statuses.some((s) => s === 'skipped'),
      });
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of JSON.parse(readFileSync(resultsFile, 'utf8')).suites ?? []) walk(suite);
}

const rows = GATES.map(([id, check]) => {
  const mine = tests.filter((t) => t.title.startsWith(`${id} `));
  let status;
  let note = '';
  if (id === 'G10') {
    // Two halves: the static scan of dist/, and the runtime check in the browser.
    if (!buildOk) { status = 'FAIL'; note = 'build failed'; }
    else if (!scanOk) { status = 'FAIL'; note = 'scan found a secret or CDN URL'; }
    else if (!backend) { status = 'PASS'; note = 'static scan only (runtime check blocked: no backend)'; }
    else if (mine.length === 0 || !mine.every((t) => t.ok)) { status = 'FAIL'; note = 'runtime request check failed'; }
    else status = 'PASS';
  } else if (!backend) { status = 'BLOCKED'; note = 'no backend'; }
  else if (!e2eRan) { status = 'FAIL'; note = 'end-to-end tests did not run'; }
  else if (mine.length === 0) { status = 'FAIL'; note = 'no test found for this gate'; }
  else if (mine.some((t) => t.skipped)) { status = 'FAIL'; note = 'test was skipped'; }
  else status = mine.every((t) => t.ok) ? 'PASS' : 'FAIL';
  return { id, check, status, note };
});

const extra = tests.filter((t) => !GATES.some(([id]) => t.title.startsWith(`${id} `)));
const extraFailed = extra.filter((t) => !t.ok);
const infraFailed = steps.filter((s) => s.required && !s.ok && s.name !== 'end-to-end tests');
const allGreen = rows.every((r) => r.status === 'PASS') && infraFailed.length === 0 && extraFailed.length === 0 && lintOk && unitOk;

console.log('\n================ FieldSync verify ================');
for (const s of steps) console.log(`${s.ok ? 'ok  ' : 'FAIL'}  ${s.name} (${s.seconds}s)`);
console.log('--------------------------------------------------');
for (const r of rows) console.log(`${r.id.padEnd(4)} ${r.status.padEnd(8)} ${r.check}${r.note ? `  [${r.note}]` : ''}`);
console.log('--------------------------------------------------');
if (extra.length > 0) console.log(`Other named tests: ${extra.length - extraFailed.length}/${extra.length} passed${extraFailed.length ? ' -> ' + extraFailed.map((t) => t.title).join('; ') : ''}`);
console.log(`${allGreen ? 'VERIFY PASSED' : 'VERIFY FAILED'}: ${rows.filter((r) => r.status === 'PASS').length}/${rows.length} gates green in ${((Date.now() - started) / 1000).toFixed(0)}s`);

writeFileSync(resolve(ART, 'verify-summary.json'), JSON.stringify({
  at: new Date().toISOString(), passed: allGreen, steps, gates: rows,
  otherTests: extra.map((t) => ({ title: t.title, ok: t.ok })),
}, null, 2));
process.exit(allGreen ? 0 : 1);
