// Network deadline. On a weak signal a request can be accepted and then never
// answered. Without a deadline that one request would hold the sync run open
// for good. With it, the request fails like any other network error: the
// outbox stays as it is and the normal backoff retry takes over.
// No DOM and no app imports, so the unit tests can run it under plain Node.

export const REQUEST_TIMEOUT_MS = 30000;        // sync_push, sync_pull, auth
export const TRANSFER_TIMEOUT_MS = 120000;      // photo upload or download

export function timeoutFor(url) {
  return String(url).includes('/storage/v1/object/') ? TRANSFER_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
}

// A fetch that gives up after `ms` (headers and body together). The timer is
// left running on purpose: a response whose body stalls is cut off as well,
// and aborting a request that already finished does nothing.
export function fetchWithTimeout(input, init = {}, { fetchImpl = globalThis.fetch, ms = null } = {}) {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  const controller = new AbortController();
  const limit = ms ?? timeoutFor(url);
  const timer = setTimeout(() => {
    controller.abort(new DOMException('The server did not answer in time', 'TimeoutError'));
  }, limit);
  timer?.unref?.(); // Node only: do not keep the test process alive
  const outer = init.signal;
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener('abort', () => controller.abort(outer.reason), { once: true });
  }
  return fetchImpl(input, { ...init, signal: controller.signal });
}
