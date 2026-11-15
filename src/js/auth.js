// Sign-in with Supabase Auth. The session is cached by supabase-js in
// localStorage, and a tiny "who is signed in" value sits next to it, so the
// app opens with no network after one online sign-in.
import { createClient } from './vendor/supabase.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { openDb, closeDb, setMeta } from './db.js';

const USER_KEY = 'fieldsync.user';

export const configured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export const supabase = configured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { storageKey: 'fieldsync-auth', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  })
  : null;

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
  try { await supabase?.auth.signOut({ scope: 'local' }); } catch { /* offline */ }
  writeUser(null);
  closeDb();
}
