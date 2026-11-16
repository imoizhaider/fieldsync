// One demo account: create it, or make sure it has the given password.
// Used by scripts/seed.mjs and by QA case M09.
//   admin    supabase-js client with the service key
//   anon     supabase-js client with the public key (no stored session)
//   existing the auth user with this email, or null
// Returns { id, action } where action is 'created', 'kept' or 'password set'.
//
// Supabase Auth ends EVERY session of a user whenever an admin sets the
// password, even to the value it already has (artifacts/fix/signout/probe.json).
// Setting it on every seed run signed out each phone and laptop that used a
// demo account, about an hour later when its access token ran out. So the
// password is only set when it does not work any more.
export async function ensureAccount({ admin, anon, existing, email, password, retry = (_, fn) => fn() }) {
  if (!existing) {
    const { data, error } = await retry(`create ${email}`, () => admin.auth.admin.createUser({ email, password, email_confirm: true }));
    if (error) throw new Error(`create ${email}: ${error.message}`);
    return { id: data.user.id, action: 'created' };
  }
  const check = await anon.auth.signInWithPassword({ email, password }).catch((err) => ({ error: err }));
  if (check.data?.session) {
    // End only the session this check made; every other session stays.
    await anon.auth.signOut({ scope: 'local' }).catch(() => {});
    return { id: existing.id, action: 'kept' };
  }
  const { error } = await retry(`update ${email}`, () => admin.auth.admin.updateUserById(existing.id, { password, email_confirm: true }));
  if (error) throw new Error(`update ${email}: ${error.message}`);
  return { id: existing.id, action: 'password set' };
}
