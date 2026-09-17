/* Accepting the terms: recorded once per version, and required before checkout. Tested without a
   database — a stand-in pool holds the rows. Run with: node test/legal.test.js */
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const { TERMS_VERSION, ddl, mountLegal, hasAccepted, acceptances, record } = require('../legal');

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.log('  FAIL ' + m); } };
const U = 'kb';
const SECRET = 'test-secret';

function fakePool() {
  const rows = [];
  return {
    rows,
    async query(sql, args = []) {
      if (/INSERT INTO .*legal_accept/.test(sql)) {
        if (!rows.some(r => r.user_id === args[0] && r.version === args[1]))    // ON CONFLICT DO NOTHING
          rows.push({ user_id: args[0], version: args[1], source: args[2], ip: args[3], accepted_at: new Date(Date.now() + rows.length) });
        return { rows: [] };
      }
      if (/SELECT 1 FROM .*legal_accept/.test(sql))
        return { rows: rows.filter(r => r.user_id === args[0] && r.version === args[1]).map(() => ({ x: 1 })) };
      if (/SELECT version, accepted_at, source FROM .*legal_accept/.test(sql))
        return { rows: rows.filter(r => r.user_id === args[0]).slice().reverse() };
      return { rows: [] };
    },
  };
}

(async () => {
  ok(/^\d{4}-\d{2}-\d{2}$/.test(TERMS_VERSION), 'the terms carry a dated version');
  ok(/CREATE TABLE IF NOT EXISTS "kb".legal_accept/.test(ddl(U)), 'the table is created in the identity schema');
  ok(/PRIMARY KEY \(user_id, version\)/.test(ddl(U)), '...one row per account per version');
  ok(/ON DELETE CASCADE/.test(ddl(U)), '...and it goes when the account goes');

  const pool = fakePool();
  ok(await hasAccepted(pool, U, 7) === false, 'nobody has accepted anything to begin with');
  await record(pool, U, 7, { version: TERMS_VERSION, source: 'paywall', ip: '203.0.113.9' });
  ok(await hasAccepted(pool, U, 7) === true, 'ticking the box is on file');
  ok(pool.rows[0].ip === '203.0.113.9' && pool.rows[0].source === 'paywall', '...with where it came from');
  ok(await hasAccepted(pool, U, 8) === false, '...for that account only');
  ok(await hasAccepted(pool, U, 7, '2027-01-01') === false, '...and for that version only');

  const first = pool.rows[0].accepted_at;
  await record(pool, U, 7, { version: TERMS_VERSION, source: 'again' });
  ok(pool.rows.length === 1 && pool.rows[0].accepted_at === first && pool.rows[0].source === 'paywall',
    'a second tick does not overwrite the date of the first agreement');

  await record(pool, U, 7, { version: '2027-01-01', source: 'paywall' });
  const hist = await acceptances(pool, U, 7);
  ok(hist.length === 2 && hist[0].version === '2027-01-01', 'a new version is a new row, newest first');

  // ── the routes ───────────────────────────────────────────────────────────────────────────────
  const token = jwt.sign({ uid: 7, email: 'me@example.com' }, SECRET);
  const auth = (req, res, next) => {
    try { req.user = jwt.verify((req.headers.authorization || '').replace(/^Bearer\s+/i, ''), SECRET); next(); }
    catch { res.status(401).json({ error: 'sign in' }); }
  };
  const p2 = fakePool();
  const app = express();
  app.use(express.json());
  mountLegal(app, { pool: p2, U, auth, limit: () => (q, s, n) => n() });
  // the smallest stand-in for checkout's gate, exactly as server.js does it
  app.post('/api/checkout', auth, async (req, res) => {
    if (!(await hasAccepted(p2, U, req.user.uid, TERMS_VERSION)))
      return res.status(428).json({ error: 'Please accept the Terms of Service first.', needsTerms: TERMS_VERSION });
    res.json({ url: 'https://checkout.example/session' });
  });

  const srv = http.createServer(app).listen(0);
  await new Promise(r => srv.on('listening', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const call = async (path, opts = {}) => {
    const r = await fetch(base + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: 'Bearer ' + opts.token } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  let r = await call('/api/legal', { token });
  ok(r.status === 200 && r.body.accepted === false && r.body.version === TERMS_VERSION, 'the app is told what needs accepting');

  r = await call('/api/checkout', { method: 'POST', token, body: { plan: 'yearly' } });
  ok(r.status === 428 && r.body.needsTerms === TERMS_VERSION, 'checkout refuses until the terms are accepted');

  r = await call('/api/legal/accept', { method: 'POST', token, body: { version: TERMS_VERSION, source: 'paywall' } });
  ok(r.status === 200 && r.body.accepted === true, 'accepting is recorded');

  r = await call('/api/checkout', { method: 'POST', token, body: { plan: 'yearly' } });
  ok(r.status === 200 && /checkout/.test(r.body.url || ''), '...and then checkout opens');

  r = await call('/api/legal/accept', { method: 'POST', token, body: { version: '1999-01-01' } });
  ok(r.status === 409 && r.body.version === TERMS_VERSION, 'accepting some other version is refused');

  r = await call('/api/legal', {});
  ok(r.status === 401, 'none of this is readable without signing in');
  r = await call('/api/legal/accept', { method: 'POST', body: { version: TERMS_VERSION } });
  ok(r.status === 401, '...and nobody can accept on somebody else\'s behalf');

  r = await call('/api/legal', { token });
  ok(r.status === 200 && r.body.history.length === 1 && r.body.history[0].source === 'paywall',
    'the record says which version, when, and from where');

  srv.close();
  console.log((failed ? 'FAILED ' : 'ok ') + passed + '/' + (passed + failed) + ' legal checks');
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error('FAILED: ' + (e && e.stack || e)); process.exitCode = 1; });
