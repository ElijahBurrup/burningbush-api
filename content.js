/* ---- content the owner can change without a release --------------------------------------------
   Everything here used to be compiled into the app, which meant that adding one video, retuning a
   price or announcing a new song needed a code change, a build and — for the store apps — days of
   review. It now lives in this database and reaches every copy of the app, web and phone, the next
   time it opens.

   Two kinds of thing:
     media     one row per video (1,080 at the start), because they are added and removed one at a
               time from the app's admin screen and each needs its own checks.
     docs      whole documents, edited and saved as one: announcements, config (feature switches and
               tunable numbers), suggested verses, story sections. Every save keeps the previous
               version in content_history, so a bad edit is one "revert" away.

   The app asks for all of it in ONE request, GET /api/content, and caches the answer. It never waits
   for it: it draws from its cache (or its built-in defaults) at once and redraws when a fresh bundle
   arrives. That matters on the free plan, where the first request after a quiet spell can take the
   best part of a minute.

   Nothing in here may take the API down. If the tables cannot be made, the error is logged and the
   rest of the server — sign-in, sync — carries on exactly as before. */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const LEVELS = ['book', 'chapter', 'verse'];
const KINDS = ['overview', 'hear', 'teach', 'deep'];
const DOC_KEYS = { announcements: 'array', config: 'object', suggested: 'object', stories: 'object' };
const DOC_MAX_BYTES = 512 * 1024;
// Chapters in each book, Genesis to Revelation: a reference to chapter 51 of Genesis is refused here
// rather than stored and never shown.
const CHAPS = [50, 40, 27, 36, 34, 24, 21, 4, 31, 24, 22, 25, 29, 36, 10, 13, 10, 42, 150, 31, 12, 8, 66, 52, 5, 48, 12, 14, 3, 9,
  1, 4, 7, 3, 3, 3, 2, 14, 4, 28, 16, 24, 21, 28, 16, 16, 13, 6, 6, 4, 4, 5, 3, 6, 4, 3, 1, 13, 5, 5, 3, 5, 1, 1, 1, 22];
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/* A reference as the app writes it: "11" a book, "11:1" a chapter, "45:16:23" a verse. */
function parseRef(ref) {
  const m = /^(\d{1,2})(?::(\d{1,3}))?(?::(\d{1,3}))?$/.exec(String(ref || '').trim());
  if (!m) return null;
  const b = +m[1], c = m[2] ? +m[2] : null, v = m[3] ? +m[3] : null;
  if (b < 1 || b > 66) return null;
  if (c !== null && (c < 1 || c > CHAPS[b - 1])) return null;
  if (v !== null && (v < 1 || v > 200)) return null;
  return { level: v !== null ? 'verse' : c !== null ? 'chapter' : 'book', key: [b, c, v].filter(x => x !== null).join(':') };
}

/* A link as people paste it. YouTube in any of its shapes becomes an id; Facebook stays a URL,
   because its embed takes the whole address. Anything else is refused. */
function parseUrl(url) {
  const u = String(url || '').trim();
  if (YT_ID.test(u)) return { yt: u };
  let m = /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(u);
  if (m) return { yt: m[1] };
  m = /^https:\/\/(?:www\.|m\.|web\.)?facebook\.com\/([^?#]+(?:\?[^#]*)?)/.exec(u);
  if (m && /(watch|videos|reel)/.test(m[1])) return { fb: 'https://www.facebook.com/' + m[1] };
  m = /^https:\/\/fb\.watch\/[A-Za-z0-9_-]+\/?$/.exec(u);
  if (m) return { fb: u };
  return null;
}

/* Ask YouTube whether the video is public and may be embedded. One request per video an admin adds —
   never a sweep. Resolves {ok, title, author} or {ok:false, why}. */
function oembed(yt, timeout = 8000) {
  return new Promise(resolve => {
    const url = 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + yt);
    const req = https.get(url, { timeout }, r => {
      let body = '';
      r.on('data', d => { body += d; });
      r.on('end', () => {
        if (r.statusCode === 200) {
          try { const j = JSON.parse(body); return resolve({ ok: true, title: j.title || '', author: j.author_name || '' }); }
          catch { return resolve({ ok: false, why: 'YouTube answered, but not with the video details.' }); }
        }
        if (r.statusCode === 401 || r.statusCode === 403) return resolve({ ok: false, why: 'That video does not allow embedding, so it could not play inside the app.' });
        if (r.statusCode === 404 || r.statusCode === 400) return resolve({ ok: false, why: 'YouTube has no public video at that link.' });
        if (r.statusCode === 429) return resolve({ ok: null, why: 'YouTube is rate-limiting just now; saved without checking.' });
        resolve({ ok: null, why: 'YouTube could not be asked (' + r.statusCode + '); saved without checking.' });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: null, why: 'YouTube did not answer in time; saved without checking.' }); });
    req.on('error', () => resolve({ ok: null, why: 'YouTube could not be reached; saved without checking.' }));
  });
}

/* The media rows as the app's MEDIA object: {book:{}, chapter:{}, verse:{}}, each key a list in order. */
function mediaTree(rows) {
  const out = { book: {}, chapter: {}, verse: {} };
  rows.slice().sort((a, b) => (a.sort - b.sort) || (Number(a.id) - Number(b.id))).forEach(r => {
    if (!r.active || !out[r.level]) return;
    const it = { kind: r.kind, by: r.by_line || '', label: r.label || '' };
    if (r.yt) it.yt = r.yt;
    if (r.fb) it.fb = r.fb;
    if (r.covers) it.covers = r.covers;
    (out[r.level][r.ref_key] = out[r.level][r.ref_key] || []).push(it);
  });
  return out;
}

/* A document must be the right shape and a sane size before it can be saved: the app trusts nothing
   it is sent either, but the first line of defence is not storing nonsense. */
function checkDoc(key, doc) {
  const want = DOC_KEYS[key];
  if (!want) return 'There is no document called ' + key + '.';
  if (want === 'array' && !Array.isArray(doc)) return key + ' must be a list.';
  if (want === 'object' && (doc === null || typeof doc !== 'object' || Array.isArray(doc))) return key + ' must be an object.';
  const size = Buffer.byteLength(JSON.stringify(doc));
  if (size > DOC_MAX_BYTES) return key + ' is ' + Math.round(size / 1024) + ' KB; the limit is ' + (DOC_MAX_BYTES / 1024) + ' KB.';
  if (key === 'announcements') {
    for (const a of doc) {
      if (!a || typeof a !== 'object' || !a.id || !a.text) return 'Every announcement needs an id and some text.';
      if (a.link && !/^https:\/\//.test(a.link)) return 'An announcement link must start with https://.';
    }
  }
  const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  if (key === 'suggested') {
    for (const f of ['gemsAdd', 'gemsHide']) if (doc[f] != null && !Array.isArray(doc[f])) return f + ' must be a list.';
    if (doc.psalmFor != null && !isObj(doc.psalmFor)) return 'psalmFor must be an object.';
    if (doc.topics != null && !Array.isArray(doc.topics)) return 'topics must be a list, or left out.';
    if (Array.isArray(doc.topics) && doc.topics.some(t => !t || typeof t.name !== 'string' || !t.name.trim())) return 'Every topic needs a name.';
  }
  if (key === 'stories') {
    if (doc.names != null && !isObj(doc.names)) return 'names must be an object.';
    const ms = doc.milestones;
    if (ms != null && !isObj(ms)) return 'milestones must be an object.';
    if (ms && ms.add != null && !Array.isArray(ms.add)) return 'milestones.add must be a list.';
    if (ms && Array.isArray(ms.add) && ms.add.some(a => !a || !a.id || !a.t || !a.after)) return 'A new milestone needs an id, a title and the section it follows.';
  }
  return null;
}

/* Corrections to the seeded videos, from seed/corrections.json. Each is applied once and remembered
   by its id in the _corrections row, so a redeploy never undoes what an admin has done since (a
   video hidden here and put back from the admin screen stays put back). A correction names a video
   by the reference it is on and its link, then either hides it or moves it to the right verse,
   with the label that verse needs. */
async function applyCorrections(pool, D, list) {
  const row = (await pool.query(`SELECT doc FROM "${D}".content WHERE key='_corrections'`)).rows[0];
  const done = new Set((row && row.doc && Array.isArray(row.doc.ids)) ? row.doc.ids : []);
  let applied = 0;
  for (const k of Array.isArray(list) ? list : []) {
    if (!k || !k.id || done.has(k.id)) continue;
    // A video the app did not ship with: a new song in a playlist, say. Added once, and never twice,
    // because the same YouTube id anywhere in the table means it is already there.
    if (k.add) {
      const a = k.add, ref = parseRef(a.ref);
      if (!ref || !a.yt || !String(a.label || '').trim()) { console.warn('[content] correction ' + k.id + ' skipped: an add needs ref, yt and label'); continue; }
      const dupe = (await pool.query(`SELECT id FROM "${D}".media WHERE yt=$1`, [a.yt])).rows;
      if (!dupe.length) await pool.query(`INSERT INTO "${D}".media(level, ref_key, kind, yt, label, by_line, sort, created_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,'correction')`,
        [ref.level, ref.key, KINDS.includes(a.kind) ? a.kind : 'teach', a.yt, String(a.label).trim().slice(0, 200),
         String(a.by || '').trim().slice(0, 120), Number.isInteger(a.sort) ? a.sort : 0]);
      done.add(k.id); applied++;
      console.log('[content] correction ' + k.id + ': ' + (dupe.length ? 'already there' : 'added ' + a.yt));
      continue;
    }
    const to = k.move_to ? parseRef(k.move_to) : null;
    if (!k.hide && (!to || !String(k.label || '').trim())) { console.warn('[content] correction ' + k.id + ' skipped: it needs hide, or move_to with a label'); continue; }
    const hits = (await pool.query(`SELECT id FROM "${D}".media WHERE ref_key=$1 AND (yt=$2 OR fb=$3)`,
      [k.ref, k.yt || null, k.fb || null])).rows;
    for (const h of hits) {
      if (k.hide) await pool.query(`UPDATE "${D}".media SET active=$1, updated_at=now(), updated_by='correction' WHERE id=$2`, [false, h.id]);
      else await pool.query(`UPDATE "${D}".media SET ref_key=$1, level=$2, label=$3, updated_at=now(), updated_by='correction' WHERE id=$4`,
        [to.key, to.level, String(k.label).trim().slice(0, 200), h.id]);
    }
    done.add(k.id); applied++;
    console.log('[content] correction ' + k.id + ': ' + hits.length + ' video(s)');
  }
  if (applied) await pool.query(`INSERT INTO "${D}".content(key, doc, updated_by) VALUES('_corrections', $1, 'seed')
      ON CONFLICT (key) DO UPDATE SET doc=EXCLUDED.doc, updated_at=now(), updated_by='seed'`, [JSON.stringify({ ids: [...done] })]);
  return applied;
}

function mountContent(app, { pool, D, adminAuth, limit }) {
  let ready = false;
  let bundle = null;          // { etag, body } — rebuilt after any write

  async function init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "${D}".media (
        id BIGSERIAL PRIMARY KEY,
        level TEXT NOT NULL CHECK (level IN ('book','chapter','verse')),
        ref_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('overview','hear','teach','deep')),
        yt TEXT, fb TEXT,
        label TEXT NOT NULL DEFAULT '',
        by_line TEXT NOT NULL DEFAULT '',
        covers TEXT,
        sort INT NOT NULL DEFAULT 0,
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT now(), created_by TEXT,
        updated_at TIMESTAMPTZ DEFAULT now(), updated_by TEXT,
        CHECK (yt IS NOT NULL OR fb IS NOT NULL)
      );
      CREATE INDEX IF NOT EXISTS media_ref ON "${D}".media(level, ref_key);
      CREATE TABLE IF NOT EXISTS "${D}".content (
        key TEXT PRIMARY KEY,
        doc JSONB NOT NULL,
        version INT NOT NULL DEFAULT 1,
        updated_at TIMESTAMPTZ DEFAULT now(), updated_by TEXT
      );
      CREATE TABLE IF NOT EXISTS "${D}".content_history (
        id BIGSERIAL PRIMARY KEY,
        key TEXT NOT NULL,
        doc JSONB,
        version INT,
        saved_at TIMESTAMPTZ DEFAULT now(), saved_by TEXT, note TEXT
      );
      CREATE INDEX IF NOT EXISTS content_history_key ON "${D}".content_history(key, id);
    `);
    // The approved videos go in once. Remembered in a row of its own, so an admin who later removes
    // every video does not find them all back after the next deploy.
    const seeded = await pool.query(`SELECT 1 FROM "${D}".content WHERE key='_media_seeded'`);
    const file = path.join(__dirname, 'seed', 'media.json');
    if (!seeded.rows.length && fs.existsSync(file)) {
      const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        for (const r of rows) {
          await c.query(`INSERT INTO "${D}".media(level, ref_key, kind, yt, fb, label, by_line, covers, sort, created_by)
                         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'seed')`,
            [r.level, r.ref_key, r.kind, r.yt || null, r.fb || null, r.label || '', r.by_line || '', r.covers || null, r.sort || 0]);
        }
        await c.query(`INSERT INTO "${D}".content(key, doc, updated_by) VALUES('_media_seeded', $1, 'seed')`,
          [JSON.stringify({ rows: rows.length, at: new Date().toISOString() })]);
        await c.query('COMMIT');
        console.log('[content] seeded ' + rows.length + ' videos');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
      finally { c.release(); }
    }
    const cfile = path.join(__dirname, 'seed', 'corrections.json');
    if (fs.existsSync(cfile)) await applyCorrections(pool, D, JSON.parse(fs.readFileSync(cfile, 'utf8')));
    bundle = null;
    ready = true;
  }

  async function build() {
    const media = (await pool.query(`SELECT id, level, ref_key, kind, yt, fb, label, by_line, covers, sort, active
                                     FROM "${D}".media WHERE active`)).rows;
    const docs = {};
    (await pool.query(`SELECT key, doc, version FROM "${D}".content WHERE key NOT LIKE '\\_%'`)).rows
      .forEach(r => { docs[r.key] = r.doc; });
    const payload = { media: mediaTree(media), announcements: docs.announcements || [],
      config: docs.config || null, suggested: docs.suggested || null, stories: docs.stories || null };
    const body = JSON.stringify(payload);
    const etag = '"' + crypto.createHash('sha1').update(body).digest('hex').slice(0, 20) + '"';
    return { etag, body: JSON.stringify(Object.assign({ v: etag.replace(/"/g, '') }, payload)) };
  }
  const fresh = () => { bundle = null; };

  app.get('/api/content', limit(240, 60000), async (req, res) => {
    if (!ready) return res.status(503).json({ error: 'Content is not available yet.' });
    try {
      if (!bundle) bundle = await build();
      res.set('Cache-Control', 'public, max-age=60');
      res.set('ETag', bundle.etag);
      if (req.headers['if-none-match'] === bundle.etag) return res.status(304).end();
      res.type('application/json').send(bundle.body);
    } catch (e) { console.error('content', e); res.status(500).json({ error: 'Server error.' }); }
  });

  /* ---- admin: videos ---------------------------------------------------------------------------- */
  app.get('/api/admin/media', adminAuth, async (req, res) => {
    try {
      const ref = req.query.ref ? parseRef(req.query.ref) : null;
      if (req.query.ref && !ref) return res.status(400).json({ error: 'That is not a reference the app knows.' });
      const rows = ref
        ? (await pool.query(`SELECT * FROM "${D}".media WHERE level=$1 AND ref_key=$2 ORDER BY active DESC, sort, id`, [ref.level, ref.key])).rows
        : (await pool.query(`SELECT * FROM "${D}".media ORDER BY updated_at DESC LIMIT 40`)).rows;
      res.json({ ref, rows });
    } catch (e) { console.error('admin-media', e); res.status(500).json({ error: 'Server error.' }); }
  });

  app.post('/api/admin/media', adminAuth, limit(60, 60000), async (req, res) => {
    try {
      const ref = parseRef(req.body.ref);
      if (!ref) return res.status(400).json({ error: 'Give a reference like "Romans 16:23" as 45:16:23, or pick one.' });
      const kind = KINDS.includes(req.body.kind) ? req.body.kind : (ref.level === 'book' ? 'overview' : ref.level === 'verse' ? 'deep' : 'teach');
      const link = parseUrl(req.body.url);
      if (!link) return res.status(400).json({ error: 'Paste a YouTube or Facebook video link.' });
      const dupe = await pool.query(`SELECT id, active FROM "${D}".media WHERE level=$1 AND ref_key=$2 AND (yt=$3 OR fb=$4)`,
        [ref.level, ref.key, link.yt || null, link.fb || null]);
      if (dupe.rows.some(r => r.active)) return res.status(409).json({ error: 'That video is already on this reference.' });
      let note = '', label = String(req.body.label || '').trim().slice(0, 200), by = String(req.body.by || '').trim().slice(0, 120);
      if (link.yt) {
        const o = await oembed(link.yt);
        if (o.ok === false) return res.status(422).json({ error: o.why });
        if (o.ok) { if (!label) label = o.title; if (!by) by = o.author; } else note = o.why;
      }
      if (!label) return res.status(400).json({ error: 'Give the video a title.' });
      const sort = (await pool.query(`SELECT COALESCE(MAX(sort),-1)+1 AS s FROM "${D}".media WHERE level=$1 AND ref_key=$2`, [ref.level, ref.key])).rows[0].s;
      const row = (await pool.query(`INSERT INTO "${D}".media(level, ref_key, kind, yt, fb, label, by_line, sort, created_by, updated_by)
                                     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
        [ref.level, ref.key, kind, link.yt || null, link.fb || null, label, by, sort, req.user.email])).rows[0];
      fresh();
      res.json({ ok: true, row, note });
    } catch (e) { console.error('admin-media-add', e); res.status(500).json({ error: 'Server error.' }); }
  });

  // Edit, hide (active:false) or bring back (active:true). Nothing is ever deleted outright.
  app.post('/api/admin/media/:id', adminAuth, limit(120, 60000), async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Bad id.' });
      const sets = [], vals = [];
      const put = (col, v) => { vals.push(v); sets.push(col + '=$' + vals.length); };
      if (typeof req.body.active === 'boolean') put('active', req.body.active);
      if (typeof req.body.label === 'string' && req.body.label.trim()) put('label', req.body.label.trim().slice(0, 200));
      if (typeof req.body.by === 'string') put('by_line', req.body.by.trim().slice(0, 120));
      if (KINDS.includes(req.body.kind)) put('kind', req.body.kind);
      if (Number.isInteger(req.body.sort)) put('sort', req.body.sort);
      if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });
      put('updated_by', req.user.email);
      vals.push(id);
      const r = await pool.query(`UPDATE "${D}".media SET ${sets.join(', ')}, updated_at=now() WHERE id=$${vals.length} RETURNING *`, vals);
      if (!r.rows.length) return res.status(404).json({ error: 'No such video.' });
      fresh();
      res.json({ ok: true, row: r.rows[0] });
    } catch (e) { console.error('admin-media-edit', e); res.status(500).json({ error: 'Server error.' }); }
  });

  /* ---- admin: documents ------------------------------------------------------------------------- */
  app.get('/api/admin/content/:key', adminAuth, async (req, res) => {
    try {
      const key = req.params.key;
      if (!DOC_KEYS[key]) return res.status(404).json({ error: 'No such document.' });
      const cur = (await pool.query(`SELECT doc, version, updated_at, updated_by FROM "${D}".content WHERE key=$1`, [key])).rows[0] || null;
      const history = (await pool.query(`SELECT id, version, saved_at, saved_by, note FROM "${D}".content_history
                                         WHERE key=$1 ORDER BY id DESC LIMIT 30`, [key])).rows;
      res.json({ key, current: cur, history });
    } catch (e) { console.error('admin-doc', e); res.status(500).json({ error: 'Server error.' }); }
  });

  async function saveDoc(key, doc, who, note) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const cur = (await c.query(`SELECT doc, version FROM "${D}".content WHERE key=$1 FOR UPDATE`, [key])).rows[0];
      if (cur) await c.query(`INSERT INTO "${D}".content_history(key, doc, version, saved_by, note) VALUES($1,$2,$3,$4,$5)`,
        [key, JSON.stringify(cur.doc), cur.version, who, note || null]);
      const version = cur ? cur.version + 1 : 1;
      await c.query(`INSERT INTO "${D}".content(key, doc, version, updated_at, updated_by) VALUES($1,$2,$3,now(),$4)
                     ON CONFLICT(key) DO UPDATE SET doc=$2, version=$3, updated_at=now(), updated_by=$4`,
        [key, JSON.stringify(doc), version, who]);
      await c.query('COMMIT');
      return version;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    finally { c.release(); }
  }

  app.post('/api/admin/content/:key', adminAuth, limit(60, 60000), async (req, res) => {
    try {
      const key = req.params.key, doc = req.body.doc;
      const bad = checkDoc(key, doc);
      if (bad) return res.status(400).json({ error: bad });
      const version = await saveDoc(key, doc, req.user.email, String(req.body.note || '').slice(0, 200));
      fresh();
      res.json({ ok: true, version });
    } catch (e) { console.error('admin-doc-save', e); res.status(500).json({ error: 'Server error.' }); }
  });

  // Put an earlier version back. The version being replaced goes into history like any other save,
  // so a revert can itself be reverted.
  app.post('/api/admin/content/:key/revert', adminAuth, limit(30, 60000), async (req, res) => {
    try {
      const key = req.params.key, hid = Number(req.body.id);
      if (!DOC_KEYS[key] || !Number.isInteger(hid)) return res.status(400).json({ error: 'Bad request.' });
      const h = (await pool.query(`SELECT doc, version FROM "${D}".content_history WHERE id=$1 AND key=$2`, [hid, key])).rows[0];
      if (!h) return res.status(404).json({ error: 'No such version.' });
      const version = await saveDoc(key, h.doc, req.user.email, 'revert to version ' + h.version);
      fresh();
      res.json({ ok: true, version });
    } catch (e) { console.error('admin-doc-revert', e); res.status(500).json({ error: 'Server error.' }); }
  });

  return {
    init: () => init().catch(e => { console.error('[content] could not start; the rest of the API is unaffected:', e.message); })
  };
}

module.exports = { applyCorrections, mountContent, parseRef, parseUrl, mediaTree, checkDoc, CHAPS };
