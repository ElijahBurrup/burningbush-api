/* Content routes, tested without a database: a stand-in pool answers the handful of queries
   content.js makes, from memory. Run with: node test/content.test.js
   Uses a throwaway JWT secret; nothing here touches the real API, database or YouTube. */
const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const { mountContent, parseRef, parseUrl, mediaTree, checkDoc } = require('../content');

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.log('  FAIL ' + m); } };

// ── pure pieces ─────────────────────────────────────────────────────────────────────────────────
ok(JSON.stringify(parseRef('45:16:23')) === '{"level":"verse","key":"45:16:23"}', 'a verse reference');
ok(JSON.stringify(parseRef('11:1')) === '{"level":"chapter","key":"11:1"}', 'a chapter reference');
ok(JSON.stringify(parseRef('1')) === '{"level":"book","key":"1"}', 'a book reference');
ok(parseRef('1:51') === null, 'Genesis has no chapter 51');
ok(parseRef('67') === null && parseRef('x') === null && parseRef('') === null, 'nonsense is refused');
ok(parseUrl('https://www.youtube.com/watch?v=RtGcNOsuOYQ&list=PLT7O3cluGFuM').yt === 'RtGcNOsuOYQ', 'a watch link inside a playlist');
ok(parseUrl('https://youtu.be/Ugt0JTLacj8').yt === 'Ugt0JTLacj8', 'a short link');
ok(parseUrl('https://www.youtube.com/shorts/hPOi8WG6Aeg').yt === 'hPOi8WG6Aeg', 'a Short');
ok(parseUrl('https://www.facebook.com/watch/?v=1547436033127906').fb === 'https://www.facebook.com/watch/?v=1547436033127906', 'a Facebook video');
ok(parseUrl('https://example.com/video') === null && parseUrl('javascript:alert(1)') === null, 'anything else is refused');
ok(checkDoc('announcements', [{ id: 'a', text: 'Hi', link: 'https://x' }]) === null, 'a good announcement');
ok(/link/.test(checkDoc('announcements', [{ id: 'a', text: 'Hi', link: 'http://x' }]) || ''), 'an http link is refused');
ok(/list/.test(checkDoc('announcements', {}) || ''), 'announcements must be a list');
ok(/object/.test(checkDoc('config', []) || ''), 'config must be an object');
ok(/no document/.test(checkDoc('secrets', {}) || ''), 'an unknown document is refused');

// ── the seed, as the app will see it ────────────────────────────────────────────────────────────
const seed = require(path.join(__dirname, '..', 'seed', 'media.json'));
const rows = seed.map((r, i) => Object.assign({ id: i + 1, active: true }, r));
const tree = mediaTree(rows);
ok(Object.keys(tree.book).length === 66, 'all 66 books have their overview');
ok(tree.chapter['19:1'].length === 3 && tree.chapter['19:1'][0].label === 'Psalm 1 · 60’s Choir', 'Psalm 1 keeps its order: the two songs first');
ok(tree.verse['45:16:23'][0].fb, 'Romans 16:23 keeps its Facebook link');
ok(Object.keys(tree.chapter).length === 779 && Object.keys(tree.verse).length === 43, '779 chapters and 43 verses');

// ── the routes, against a stand-in pool ─────────────────────────────────────────────────────────
function fakePool(mediaRows) {
  const db = { media: mediaRows.map(r => Object.assign({ updated_at: new Date() }, r)), content: {}, history: [] };
  let nextId = db.media.length + 1, histId = 1;
  const q = async (sql, v = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^CREATE /.test(s)) return { rows: [] };
    if (/^SELECT 1 FROM .*content WHERE key='_media_seeded'/.test(s)) return { rows: db.content._media_seeded ? [{}] : [] };
    if (/^INSERT INTO .*media\(level, ref_key, kind, yt, fb, label, by_line, covers, sort, created_by\)/.test(s)) {
      db.media.push({ id: nextId++, level: v[0], ref_key: v[1], kind: v[2], yt: v[3], fb: v[4], label: v[5], by_line: v[6], covers: v[7], sort: v[8], active: true });
      return { rows: [] }; }
    if (/^INSERT INTO .*content\(key, doc, updated_by\) VALUES\('_media_seeded'/.test(s)) { db.content._media_seeded = { doc: JSON.parse(v[0]), version: 1 }; return { rows: [] }; }
    if (/^SELECT id, level, ref_key/.test(s)) return { rows: db.media.filter(r => r.active) };
    if (/FROM "\w+"\.content WHERE key NOT LIKE/.test(s)) return { rows: Object.entries(db.content).filter(([k]) => !k.startsWith('_')).map(([key, c]) => ({ key, doc: c.doc, version: c.version })) };
    if (/^SELECT id, active FROM .*media WHERE level/.test(s)) return { rows: db.media.filter(r => r.level === v[0] && r.ref_key === v[1] && ((v[2] && r.yt === v[2]) || (v[3] && r.fb === v[3]))) };
    if (/COALESCE\(MAX\(sort\)/.test(s)) return { rows: [{ s: Math.max(-1, ...db.media.filter(r => r.level === v[0] && r.ref_key === v[1]).map(r => r.sort)) + 1 }] };
    if (/^INSERT INTO .*media\(level/.test(s)) { const r = { id: nextId++, level: v[0], ref_key: v[1], kind: v[2], yt: v[3], fb: v[4], label: v[5], by_line: v[6], sort: v[7], active: true }; db.media.push(r); return { rows: [r] }; }
    if (/^UPDATE .*media SET/.test(s)) { const r = db.media.find(x => x.id === v[v.length - 1]); if (!r) return { rows: [] }; const cols = s.match(/SET (.*?), updated_at/)[1].split(', ').map(p => p.split('=')[0]); cols.forEach((c, i) => { r[c === 'by_line' ? 'by_line' : c] = v[i]; }); return { rows: [r] }; }
    if (/^SELECT \* FROM .*media WHERE level/.test(s)) return { rows: db.media.filter(r => r.level === v[0] && r.ref_key === v[1]) };
    if (/^SELECT doc, version, updated_at, updated_by FROM .*content WHERE key=\$1/.test(s)) return { rows: db.content[v[0]] ? [db.content[v[0]]] : [] };
    if (/^SELECT id, version, saved_at, saved_by, note FROM .*content_history WHERE key=\$1/.test(s)) return { rows: db.history.filter(x => x.key === v[0]).slice().reverse() };
    if (/^SELECT doc, version FROM .*content WHERE key=\$1 FOR UPDATE/.test(s)) return { rows: db.content[v[0]] ? [db.content[v[0]]] : [] };
    if (/^INSERT INTO .*content_history/.test(s)) { db.history.push({ id: histId++, key: v[0], doc: JSON.parse(v[1]), version: v[2] }); return { rows: [] }; }
    if (/^INSERT INTO .*content\(key, doc, version/.test(s)) { db.content[v[0]] = { doc: JSON.parse(v[1]), version: v[2] }; return { rows: [] }; }
    if (/^SELECT doc, version FROM .*content_history WHERE id/.test(s)) { const h = db.history.find(x => x.id === v[0] && x.key === v[1]); return { rows: h ? [h] : [] }; }
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s)) return { rows: [] };
    throw new Error('stand-in pool does not know: ' + s.slice(0, 90));
  };
  return { db, query: q, connect: async () => ({ query: q, release() {} }) };
}

const SECRET = 'test-only-secret';
const adminEmails = ['admin@example.com'];
function adminAuth(req, res, next) {
  try { const u = jwt.verify((req.headers.authorization || '').replace(/^Bearer\s+/i, ''), SECRET);
    if (!adminEmails.includes(u.email)) return res.status(403).json({ error: 'Admins only.' }); req.user = u; next();
  } catch { res.status(401).json({ error: 'Please sign in again.' }); }
}
const limit = () => (req, res, next) => next();

(async () => {
  const pool = fakePool([]);
  const app = express(); app.use(express.json());
  const c = mountContent(app, { pool, D: 'bb', adminAuth, limit });
  await c.init();
  ok(pool.db.media.length === 1080, 'the first start loads all 1,080 approved videos');
  await c.init();
  ok(pool.db.media.length === 1080, 'a second start does not load them again');
  const srv = app.listen(0); const port = srv.address().port;
  const call = (method, p, body, token, headers = {}) => new Promise(resolve => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ port, path: p, method, headers: Object.assign({ 'Content-Type': 'application/json' },
      token ? { Authorization: 'Bearer ' + token } : {}, headers) }, r => {
      let b = ''; r.on('data', d => { b += d; }); r.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: r.statusCode, body: j, headers: r.headers }); });
    });
    if (data) req.write(data); req.end();
  });
  const admin = jwt.sign({ uid: 1, email: 'admin@example.com' }, SECRET), user = jwt.sign({ uid: 2, email: 'someone@example.com' }, SECRET);

  const r = await call('GET', '/api/content');
  ok(r.status === 200, 'GET /api/content answers');
  if (r.status === 200) {
    ok(Object.keys(r.body.media.chapter).length === 779, 'the bundle carries every chapter');
    ok(r.body.announcements.length === 0 && r.body.config === null, 'no documents yet: the app keeps its defaults');
    const etag = r.headers.etag;
    const r304 = await call('GET', '/api/content', null, null, { 'If-None-Match': etag });
    ok(r304.status === 304, 'an unchanged bundle answers 304');
    ok((await call('POST', '/api/admin/media', { ref: '4:7:12', url: 'https://youtu.be/aaaaaaaaaaa', label: 'x' }, user)).status === 403, 'a non-admin cannot add');
    ok((await call('POST', '/api/admin/media', { ref: '4:7:12', url: 'https://youtu.be/aaaaaaaaaaa', label: 'x' })).status === 401, 'nobody signed in cannot add');
    ok((await call('POST', '/api/admin/media', { ref: '1:51', url: 'https://youtu.be/aaaaaaaaaaa', label: 'x' }, admin)).status === 400, 'a bad reference is refused');
    ok((await call('POST', '/api/admin/media', { ref: '4:7:12', url: 'https://vimeo.com/1', label: 'x' }, admin)).status === 400, 'a link that is not YouTube or Facebook is refused');
    const fbAdd = await call('POST', '/api/admin/media', { ref: '4:7:12', url: 'https://www.facebook.com/watch/?v=123', label: 'Numbers 7:12 · test', by: 'Tester' }, admin);
    ok(fbAdd.status === 200 && fbAdd.body.row.level === 'verse' && fbAdd.body.row.kind === 'deep', 'an admin adds a Facebook video to a verse (no YouTube call needed)');
    const after = await call('GET', '/api/content');
    ok(after.headers.etag !== etag && after.body.media.verse['4:7:12'] && after.body.media.verse['4:7:12'][0].label === 'Numbers 7:12 · test', 'the bundle changes at once');
    ok((await call('POST', '/api/admin/media', { ref: '4:7:12', url: 'https://www.facebook.com/watch/?v=123', label: 'again' }, admin)).status === 409, 'the same video twice is refused');
    const hide = await call('POST', '/api/admin/media/' + fbAdd.body.row.id, { active: false }, admin);
    ok(hide.status === 200 && !(await call('GET', '/api/content')).body.media.verse['4:7:12'], 'hiding takes it out of the bundle');
    const doc = [{ id: 'psalm23', text: 'Psalm 23 in four styles', link: 'https://burningbush.app' }];
    ok((await call('POST', '/api/admin/content/announcements', { doc }, admin)).status === 200, 'an admin saves an announcement');
    ok((await call('GET', '/api/content')).body.announcements[0].id === 'psalm23', '...and it is in the bundle');
    ok((await call('POST', '/api/admin/content/announcements', { doc: [] }, admin)).body.version === 2, 'saving again makes version 2');
    const hist = await call('GET', '/api/admin/content/announcements', null, admin);
    ok(hist.status === 200 && hist.body.history.length === 1, 'the previous version is in the history');
    const rev = await call('POST', '/api/admin/content/announcements/revert', { id: hist.body.history[0].id }, admin);
    ok(rev.status === 200 && (await call('GET', '/api/content')).body.announcements.length === 1, 'reverting puts it back');
    ok((await call('POST', '/api/admin/content/config', { doc: [1, 2] }, admin)).status === 400, 'a malformed document is refused');
  }
  srv.close();
  console.log('content: ' + passed + '/' + (passed + failed) + ' passed');
  process.exitCode = failed ? 1 : 0;
})();
