/* Sign in with Google, tested without a database or a network: a stand-in pool holds the users in
   memory and a stand-in verifier stands for Google. Run with: node test/google-auth.test.js
   Nothing here touches the real API, database or Google. */
const express = require('express');
const http = require('http');
const { signInWithGoogle, confirmIdentity, mountGoogleAuth, makeVerifier } = require('../google-auth');

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.log('  FAIL ' + m); } };

// ── a pool holding users in memory ──────────────────────────────────────────────────────────────
function fakePool(seed = []) {
  const rows = seed.map((r, i) => Object.assign({ id: i + 1, pw_hash: null, google_sub: null, email_verified: false }, r));
  let next = rows.length + 1;
  return {
    rows,
    queries: [],
    async query(sql, args = []) {
      this.queries.push(sql.replace(/\s+/g, ' ').trim());
      if (/SELECT .* WHERE google_sub=\$1/.test(sql)) return { rows: rows.filter(r => r.google_sub === args[0]) };
      if (/SELECT pw_hash FROM .* WHERE email=\$1/.test(sql)) return { rows: rows.filter(r => r.email === args[0]) };
      if (/SELECT .* WHERE email=\$1/.test(sql)) return { rows: rows.filter(r => r.email === args[0]) };
      if (/UPDATE .* SET google_sub=\$1/.test(sql)) {
        const u = rows.find(r => r.id === args[1]);
        if (u) { u.google_sub = args[0]; u.email_verified = true; }
        return { rows: [] };
      }
      // the only insert here is the Google one: INSERT ... VALUES($1 email, NULL, $2 sub, TRUE)
      if (/INSERT INTO .*users/.test(sql)) {
        const u = { id: next++, email: args[0], pw_hash: null, google_sub: args[1], email_verified: true };
        rows.push(u);
        return { rows: [u] };
      }
      return { rows: [] };
    },
  };
}
const U = 'kb';
const id = (email, sub) => ({ email, sub, name: null });

// ── linking: the email is the identity ──────────────────────────────────────────────────────────
(async () => {
  // a brand new person
  let pool = fakePool();
  let r = await signInWithGoogle(pool, U, id('new@example.com', 'g-1'));
  ok(r.how === 'created' && r.user.email === 'new@example.com', 'an unknown Google account creates one');
  ok(r.user.pw_hash == null, '...with no password at all');

  // the same person coming back
  r = await signInWithGoogle(pool, U, id('new@example.com', 'g-1'));
  ok(r.how === 'signed-in' && r.user.id === 1 && pool.rows.length === 1, 'coming back finds the same account, not a second one');

  // somebody who signed up with a password, then continues with Google
  pool = fakePool([{ email: 'old@example.com', pw_hash: '$2a$hash' }]);
  r = await signInWithGoogle(pool, U, id('old@example.com', 'g-2'));
  ok(r.how === 'linked' && r.user.id === 1 && pool.rows.length === 1, 'a password account on the same email is linked, not duplicated');
  ok(pool.rows[0].google_sub === 'g-2' && pool.rows[0].email_verified === true, '...and the Google id is remembered');
  ok(r.user.pw_hash === '$2a$hash', '...and their password still works');
  r = await signInWithGoogle(pool, U, id('old@example.com', 'g-2'));
  ok(r.how === 'signed-in' && pool.rows.length === 1, '...and next time it is a plain sign-in');

  // Google's id, not the address, is what a returning person is found by: a changed address still
  // reaches the same account.
  pool = fakePool([{ email: 'before@example.com', google_sub: 'g-3' }]);
  r = await signInWithGoogle(pool, U, id('after@example.com', 'g-3'));
  ok(r.how === 'signed-in' && r.user.id === 1 && pool.rows.length === 1, 'a changed Google address still finds the account');

  // ── confirming who you are, for account deletion ─────────────────────────────────────────────
  const compare = async (pw, hash) => pw === 'right' && hash === 'HASH';
  const verify = async c => { if (c === 'good') return id('me@example.com', 'g-9'); throw new Error('bad token'); };
  const pwUser = { email: 'me@example.com', pw_hash: 'HASH' };
  const gUser = { email: 'me@example.com', pw_hash: null, google_sub: 'g-9' };

  ok(await confirmIdentity({ user: pwUser, password: 'right', compare, verify }) === null, 'a password account confirms with its password');
  ok(/Incorrect/.test(await confirmIdentity({ user: pwUser, password: 'wrong', compare, verify })), 'the wrong password is refused');
  ok(/Incorrect/.test(await confirmIdentity({ user: pwUser, password: '', compare, verify })), 'an empty password is refused');
  ok(/Google/.test(await confirmIdentity({ user: gUser, password: 'anything', compare, verify })),
    'a Google account cannot be deleted with a password it never had');
  ok(await confirmIdentity({ user: gUser, credential: 'good', compare, verify }) === null,
    'a Google account confirms by signing in with Google again');
  ok(/could not be verified/.test(await confirmIdentity({ user: gUser, credential: 'forged', compare, verify })),
    'a token Google does not vouch for is refused');
  ok(/not this account/.test(await confirmIdentity({ user: { email: 'someone@else.com', pw_hash: null }, credential: 'good', compare, verify })),
    'signing in as somebody else does not confirm this account');
  ok(/different Google account/.test(await confirmIdentity({ user: { email: 'me@example.com', pw_hash: null, google_sub: 'g-OTHER' }, credential: 'good', compare, verify })),
    'a different Google account on the same address is refused');
  ok(/not available/.test(await confirmIdentity({ user: gUser, credential: 'good', compare, verify: null })),
    'without Google set up, a Google confirmation cannot be accepted');

  // ── the route ────────────────────────────────────────────────────────────────────────────────
  const call = (app, body) => new Promise(res => {
    const srv = http.createServer(app).listen(0, async () => {
      const r = await fetch('http://127.0.0.1:' + srv.address().port + '/api/auth/google',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      srv.close(); res({ status: r.status, body: d });
    });
  });
  const mount = (verifier, pool) => {
    const app = express();
    app.use(express.json());
    mountGoogleAuth(app, { pool, U, sign: u => 'token-for-' + u.id, limit: () => (q, s, n) => n(), verify: verifier, stampLogin: () => {} });
    return app;
  };

  let p2 = fakePool();
  let res1 = await call(mount(verify, p2), { credential: 'good' });
  ok(res1.status === 200 && res1.body.token === 'token-for-1' && res1.body.provider === 'google', 'the route hands back our own token');
  ok(res1.body.hasPassword === false && res1.body.how === 'created', '...and says the account has no password yet');

  let res2 = await call(mount(verify, fakePool()), { credential: 'forged' });
  ok(res2.status === 401 && /could not be verified/.test(res2.body.error), 'a forged token gets nothing');

  let res3 = await call(mount(verify, fakePool()), {});
  ok(res3.status === 401, 'no token at all gets nothing');

  let res4 = await call(mount(null, fakePool()), { credential: 'good' });
  ok(res4.status === 503 && /not set up/.test(res4.body.error), 'with Google not set up, the route says so');

  let p5 = fakePool([{ email: 'me@example.com', pw_hash: 'HASH' }]);
  let res5 = await call(mount(verify, p5), { credential: 'good' });
  ok(res5.status === 200 && res5.body.hasPassword === true && res5.body.how === 'linked', 'a linked account reports that it still has a password');

  // ── the verifier itself ──────────────────────────────────────────────────────────────────────
  ok(makeVerifier([]) === null, 'no client ids means no Google sign-in');
  ok(typeof makeVerifier(['x.apps.googleusercontent.com']) === 'function', 'a client id gives a verifier');
  let threw = null;
  try { await makeVerifier(['x'])(''); } catch (e) { threw = e.message; }
  ok(/no Google token/.test(threw || ''), 'an empty credential never reaches Google');

  console.log((failed ? 'FAILED ' : 'ok ') + passed + '/' + (passed + failed) + ' google-auth checks');
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error('FAILED: ' + (e && e.stack || e)); process.exitCode = 1; });
