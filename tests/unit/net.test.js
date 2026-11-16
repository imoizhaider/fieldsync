import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithTimeout, timeoutFor, REQUEST_TIMEOUT_MS, TRANSFER_TIMEOUT_MS } from '../../src/js/net.js';

// A server that accepts the request and never answers; it only ends when aborted.
const hang = (input, init) => new Promise((resolve, reject) => {
  init.signal.addEventListener('abort', () => reject(init.signal.reason));
});

test('a request that never answers is cut off and fails like a network error', async () => {
  const t0 = Date.now();
  await assert.rejects(
    fetchWithTimeout('https://x.test/rest/v1/rpc/sync_push', {}, { fetchImpl: hang, ms: 60 }),
    (err) => err.name === 'TimeoutError');
  assert.ok(Date.now() - t0 < 2000);
});

test('a request that answers in time is passed through untouched', async () => {
  const res = await fetchWithTimeout('https://x.test/a', { method: 'POST' }, {
    fetchImpl: async (input, init) => ({ ok: true, url: input, method: init.method }), ms: 60,
  });
  assert.deepEqual(res, { ok: true, url: 'https://x.test/a', method: 'POST' });
});

test('the caller can still abort the request itself', async () => {
  const outer = new AbortController();
  const p = fetchWithTimeout('https://x.test/a', { signal: outer.signal }, { fetchImpl: hang, ms: 5000 });
  outer.abort(new Error('caller gave up'));
  await assert.rejects(p, /caller gave up/);
});

test('every backend request has a deadline; photo transfers get a longer one', () => {
  assert.equal(timeoutFor('https://p.supabase.co/rest/v1/rpc/sync_push'), REQUEST_TIMEOUT_MS);
  assert.equal(timeoutFor('https://p.supabase.co/auth/v1/token?grant_type=refresh_token'), REQUEST_TIMEOUT_MS);
  assert.equal(timeoutFor('https://p.supabase.co/storage/v1/object/photos/a/b/c.jpg'), TRANSFER_TIMEOUT_MS);
  assert.ok(REQUEST_TIMEOUT_MS <= 30000);
});
