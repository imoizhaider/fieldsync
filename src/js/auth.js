// Sign-in with Supabase Auth. The session is cached by supabase-js in
// localStorage, and a tiny "who is signed in" value sits next to it, so the
// app opens with no network after one online sign-in.
import { createClient } from './vendor/supabase.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { openDb, closeDb, setMeta } from './db.js';
import { fetchWithTimeout } from './net.js';

const USER_KEY = 'fieldsync.user';
const SESSION_KEY = 'fieldsync-auth';

export const configured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

// One online sign-in lasts until the user presses Sign out. supabase-js deletes
// its stored session whenever a token refresh fails with an answer it does not
// count as a network error (a 429, the server's 400 for a request cut off by a
// dropped connection, a proxy page) once the access token has run out. On a
// phone that drops its connection that left the app with nothing to refresh,
// and only the password could bring it back, although the server had never
// ended the session. So the stored session is only ever removed by Sign out.
// A token the server really rejected stays stored too: it is tried again with
// backoff (one request a minute at most), the status bar says "sign-in needed"
// meanwhile, and the next successful sign-in simply overwrites it.
let removalAllowed = false;
const sessionStorageGuard = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
  removeItem: (key) => {
    if (key === SESSION_KEY && !removalAllowed) return;
    localStorage.removeItem(key);
  },
};

export const supabase = configured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { storageKey: SESSION_KEY, storage: sessionStorageGuard, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    // Every request to the backend has a deadline (see net.js).
    global: { fetch: (input, init) => fetchWithTimeout(input, init) },
  })
  : null;

// Is a session (possibly expired) stored on this device?
export function hasStoredSession() {
  try { return Boolean(JSON.parse(localStorage.getItem(SESSION_KEY))?.refresh_token); } catch { return false; }
}

// After a failed refresh supabase-js answers every caller with that failure for
// 60 s instead of trying again. A failure from while the device was offline says
// nothing about the network that just came back, so a reconnect forgets it and
// the token is refreshed at once. (Field of the pinned auth-js 2.119; harmless
// no-op if a later version drops it.)
export function forgetRefreshFailure() {
  if (supabase?.auth && 'lastRefreshFailure' in supabase.auth) supabase.auth.lastRefreshFailure = null;
}

// A refresh token the server itself refused: the only case that needs a password.
// The token endpoint answers `refresh_token_not_found` for a token it does not
// know and `validation_failed` ("Refresh token is not valid") for one it cannot
// even read; neither will ever work again. (`bad_json`, a cut-off request, is not
// about the token and stays retryable.)
const REJECTED = new Set(['refresh_token_not_found', 'refresh_token_already_used', 'validation_failed', 'session_not_found', 'session_expired', 'user_not_found', 'user_banned']);
export function isSessionRejected(error) {
  return error?.name === 'AuthApiError' && REJECTED.has(error.code);
}

let user = null;

export function currentUser() {
  return user;
}

function readUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; }
}

function writeUser(u) {
  user = u;
  if (u) localStorage.setItem(USER_KEY, JSON.stringify(u));
  else localStorage.removeItem(USER_KEY);
}

export function setDisplayName(name) {
  if (user && name && user.name !== name) writeUser({ ...user, name });
}

async function adopt(u) {
  writeUser(u);
  openDb(u.id);
  await setMeta('userId', u.id);
  // Ask the browser not to clear our data under storage pressure.
  if (navigator.storage?.persist) {
    try { await setMeta('persisted', await navigator.storage.persist()); } catch { /* not supported */ }
  }
  return u;
}

// Called once on start. Works offline: nothing here needs the network.
export async function restoreUser() {
  let u = readUser();
  if (!u && supabase) {
    try {
      const { data } = await supabase.auth.getSession();
      const su = data?.session?.user;
      if (su) u = { id: su.id, email: su.email, name: su.email };
    } catch { /* offline or no session */ }
  }
  if (!u) return null;
  return adopt(u);
}

export async function signIn(email, password) {
  if (!supabase) throw new Error('This build has no backend configured. See README.');
  if (!navigator.onLine) throw new Error('A first sign-in needs a connection.');
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    throw new Error(/fetch|network/i.test(error.message) ? 'Could not reach the server. Check your connection.' : error.message);
  }
  return adopt({ id: data.user.id, email: data.user.email, name: data.user.email });
}

// Local data stays in this user's own database, so pending work is not lost.
export async function signOut() {
  removalAllowed = true;
  try { await supabase?.auth.signOut({ scope: 'local' }); } catch { /* offline */ }
  try { localStorage.removeItem(SESSION_KEY); } catch { /* storage blocked */ }
  removalAllowed = false;
  writeUser(null);
  closeDb();
}
