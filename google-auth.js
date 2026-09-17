/* Sign in with Google.
 *
 * The browser hands us the token Google gave it; we verify that token with Google ourselves before
 * it counts for anything. A token checked only in the page is worth nothing: anyone can send us
 * whatever they like, so the signature, the audience (our own client id) and the verified email are
 * all checked here, on the server.
 *
 * LINKING, decided by the owner (2026-09-17): the email is the identity. Somebody who signed up
 * with a password and later continues with Google lands in the SAME account, because Google has
 * verified that the address is theirs. The alternative — a second account on one address — would
 * quietly hide their verses from them.
 *
 * A Google account has no password at all (users.pw_hash is null), so anything that used to ask for
 * the password again asks them to sign in with Google again instead: see confirmIdentity.
 */
const { OAuth2Client } = require('google-auth-library');

// The web client, the Android client, and any other that may sign in to the same account.
const clientIds = () => (process.env.GOOGLE_CLIENT_IDS || process.env.GOOGLE_CLIENT_ID || '')
  .split(',').map(s => s.trim()).filter(Boolean);

/* A verifier, or null when Google sign-in has not been set up on this deployment. Returns the
   identity Google vouches for: nothing else from the token is trusted or kept. */
function makeVerifier(ids = clientIds()) {
  if (!ids.length) return null;
  const client = new OAuth2Client();
  return async function verify(credential) {
    if (!credential || typeof credential !== 'string') throw new Error('no Google token');
    const ticket = await client.verifyIdToken({ idToken: credential, audience: ids });
    const p = ticket.getPayload() || {};
    const email = String(p.email || '').trim().toLowerCase();
    // Google marks an address unverified on some workspace accounts; without that mark the address
    // is not proof of anything, and linking on it would hand over somebody else's account.
    if (!email || p.email_verified !== true) throw new Error('that Google account has no verified email address');
    if (!p.sub) throw new Error('no Google account id');
    return { email, sub: String(p.sub), name: p.name || null };
  };
}

/* Find the account this identity belongs to, linking or creating as needed.
   Returns { user, how } where how is 'signed-in' (known Google account), 'linked' (an existing
   password account on the same address) or 'created'. */
async function signInWithGoogle(pool, U, id) {
  const bySub = await pool.query(`SELECT id, email, google_sub, pw_hash FROM "${U}".users WHERE google_sub=$1`, [id.sub]);
  if (bySub.rows.length) return { user: bySub.rows[0], how: 'signed-in' };

  const byEmail = await pool.query(`SELECT id, email, google_sub, pw_hash FROM "${U}".users WHERE email=$1`, [id.email]);
  if (byEmail.rows.length) {
    const u = byEmail.rows[0];
    await pool.query(`UPDATE "${U}".users SET google_sub=$1, email_verified=TRUE WHERE id=$2`, [id.sub, u.id]);
    return { user: { id: u.id, email: u.email, google_sub: id.sub, pw_hash: u.pw_hash }, how: 'linked' };
  }

  const made = await pool.query(
    `INSERT INTO "${U}".users(email, pw_hash, google_sub, email_verified) VALUES($1, NULL, $2, TRUE)
     RETURNING id, email, google_sub, pw_hash`, [id.email, id.sub]);
  return { user: made.rows[0], how: 'created' };
}

/* Is this caller really the owner of this account, right now?
 *
 * Used by account deletion, the one act that cannot be undone. A password account types its
 * password; a Google account signs in with Google again and we check the token names that same
 * account. Returns null when confirmed, or the sentence to show when it is not.
 */
async function confirmIdentity({ user, password, credential, verify, compare }) {
  if (credential) {
    if (!verify) return 'Google sign-in is not available here.';
    let id;
    try { id = await verify(credential); }
    catch (e) { return 'That Google sign-in could not be verified. Try again.'; }
    if (id.email !== String(user.email || '').toLowerCase())
      return 'That Google account is not this account. Sign in as ' + user.email + '.';
    if (user.google_sub && id.sub !== String(user.google_sub)) return 'That is a different Google account.';
    return null;
  }
  if (!user.pw_hash) return 'This account signs in with Google. Confirm with Google to delete it.';
  if (!password || !(await compare(password, user.pw_hash))) return 'Incorrect password.';
  return null;
}

/* POST /api/auth/google — { credential } from Google's button, in exchange for our own token. */
function mountGoogleAuth(app, { pool, U, sign, limit, verify, stampLogin }) {
  app.post('/api/auth/google', limit(20, 60000), async (req, res) => {
    if (!verify) return res.status(503).json({ error: 'Google sign-in is not set up yet — use email and password.' });
    let id;
    try { id = await verify(req.body && req.body.credential); }
    catch (e) {
      console.warn('[google] refused a token:', e.message);
      return res.status(401).json({ error: 'That Google sign-in could not be verified. Try again.' });
    }
    try {
      const { user, how } = await signInWithGoogle(pool, U, id);
      if (stampLogin) stampLogin(user.id);
      console.log('[google] ' + how + ': ' + user.email);
      // hasPassword tells the app whether this person can be asked for a password later (deleting
      // the account): a linked account still has one, a Google-only account has none.
      res.json({ token: sign(user), email: user.email, provider: 'google', hasPassword: !!user.pw_hash, how });
    } catch (e) {
      console.error('[google] sign-in', e);
      res.status(500).json({ error: 'Server error. Please try again.' });
    }
  });
}

module.exports = { makeVerifier, signInWithGoogle, confirmIdentity, mountGoogleAuth, clientIds };
