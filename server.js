// Burning Bush — accounts + progress-sync API on the shared Kingdom Builders database.
//
// One Postgres instance, schema-isolated:
//   • USERS_SCHEMA (default "kb")          → the shared Kingdom Builders identity (kb.users, kb.reset_tokens).
//                                            One login recognized across every KB product.
//   • DATA_SCHEMA  (default "burningbush")  → THIS product's data (burningbush.progress → kb.users.id).
//   QA runs the same code with USERS_SCHEMA=kb_qa, DATA_SCHEMA=burningbush_qa in the same instance ($0 extra).
//
// Progress is stored as opaque JSON blobs; the client owns the schema and does the union-merge on pull.
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '4mb' }));

const ORIGINS = (process.env.ALLOWED_ORIGIN || 'https://kingdombuilders.ai')
  .split(',').map(s => s.trim()).filter(Boolean);
// exact-match allowlist; ALLOWED_ORIGIN="*" opens it (used only by the QA sandbox, which holds no real data)
app.use(cors({ origin(o, cb) { cb(null, !o || ORIGINS.includes('*') || ORIGINS.includes(o)); } }));

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
// schema names come from env; sanitize hard since they're interpolated into DDL
const U = (process.env.USERS_SCHEMA || 'kb').replace(/[^a-z0-9_]/gi, '');
const D = (process.env.DATA_SCHEMA || 'burningbush').replace(/[^a-z0-9_]/gi, '');
const PRODUCT = process.env.PRODUCT || 'burningbush';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false } : false,
  max: 5   // be a good neighbor on the shared instance
});
// every pooled connection sees this product's data schema first, then the shared identity schema
pool.on('connect', c => c.query(`SET search_path TO "${D}","${U}"`).catch(() => {}));

async function initDb() {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${U}"`);   // shared identity (created once, reused by every product)
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${D}"`);   // this product's data
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "${U}".users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      pw_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS "${U}".reset_tokens (
      token TEXT PRIMARY KEY,
      user_id BIGINT REFERENCES "${U}".users(id) ON DELETE CASCADE,
      product TEXT,
      expires BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "${D}".progress (
      user_id BIGINT PRIMARY KEY REFERENCES "${U}".users(id) ON DELETE CASCADE,
      prog_json TEXT,
      srs_json TEXT,
      updated_at BIGINT DEFAULT 0,
      saved_at TIMESTAMPTZ DEFAULT now()
    );
    -- admin overlay for support tickets. Tickets themselves live inside each user's prog_json blob
    -- (client-owned), so their reviewed/deleted status is tracked here, keyed by a stable ticket key.
    CREATE TABLE IF NOT EXISTS "${D}".ticket_status (
      ticket_key TEXT PRIMARY KEY,
      done BOOLEAN DEFAULT false,
      deleted BOOLEAN DEFAULT false,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

const sign = u => jwt.sign({ uid: Number(u.id), email: u.email }, JWT_SECRET, { expiresIn: '365d' });
const emailOk = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e || '');
function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  try { req.user = jwt.verify(t, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Please sign in again.' }); }
}

const hits = new Map();
const limit = (max, windowMs) => (req, res, next) => {
  const key = req.ip + ':' + req.path, now = Date.now();
  const rec = hits.get(key) || { n: 0, t: now };
  if (now - rec.t > windowMs) { rec.n = 0; rec.t = now; }
  rec.n++; hits.set(key, rec);
  if (rec.n > max) return res.status(429).json({ error: 'Too many attempts — try again in a minute.' });
  next();
};

app.get('/api/health', (req, res) => res.json({ ok: true, product: PRODUCT, users: U, data: D }));

app.post('/api/signup', limit(10, 60000), async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase(), pw = req.body.password || '';
    if (!emailOk(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    const hash = await bcrypt.hash(pw, 10);
    let r;
    try { r = await pool.query(`INSERT INTO "${U}".users(email, pw_hash) VALUES($1,$2) RETURNING id, email`, [email, hash]); }
    catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'That email already has a Kingdom Builders account — sign in instead.' }); throw e; }
    const u = r.rows[0];
    res.json({ token: sign(u), email: u.email });
  } catch (e) { console.error('signup', e); res.status(500).json({ error: 'Server error. Please try again.' }); }
});

app.post('/api/login', limit(15, 60000), async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase(), pw = req.body.password || '';
    const r = await pool.query(`SELECT id, email, pw_hash FROM "${U}".users WHERE email=$1`, [email]);
    if (!r.rows.length) return res.status(401).json({ error: 'No account found with that email.' });
    const u = r.rows[0];
    if (!(await bcrypt.compare(pw, u.pw_hash))) return res.status(401).json({ error: 'Incorrect password.' });
    res.json({ token: sign(u), email: u.email });
  } catch (e) { console.error('login', e); res.status(500).json({ error: 'Server error. Please try again.' }); }
});

app.get('/api/sync', auth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT prog_json, srs_json, updated_at FROM "${D}".progress WHERE user_id=$1`, [req.user.uid]);
    if (!r.rows.length) return res.json({ progJson: null, srsJson: null, updatedAt: 0 });
    res.json({ progJson: r.rows[0].prog_json, srsJson: r.rows[0].srs_json, updatedAt: Number(r.rows[0].updated_at) });
  } catch (e) { console.error('sync-get', e); res.status(500).json({ error: 'Server error.' }); }
});

app.put('/api/sync', auth, async (req, res) => {
  try {
    const { progJson, srsJson } = req.body;
    const updatedAt = Number(req.body.updatedAt) || Date.now();
    if (progJson != null && typeof progJson !== 'string') return res.status(400).json({ error: 'Bad payload.' });
    await pool.query(
      `INSERT INTO "${D}".progress(user_id, prog_json, srs_json, updated_at, saved_at)
       VALUES($1,$2,$3,$4, now())
       ON CONFLICT(user_id) DO UPDATE SET prog_json=$2, srs_json=$3, updated_at=$4, saved_at=now()`,
      [req.user.uid, progJson || null, srsJson || null, updatedAt]);
    res.json({ ok: true });
  } catch (e) { console.error('sync-put', e); res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/forgot', limit(6, 60000), async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const r = await pool.query(`SELECT id FROM "${U}".users WHERE email=$1`, [email]);
    if (r.rows.length) {
      const tok = crypto.randomBytes(24).toString('hex'), exp = Date.now() + 3600000;
      await pool.query(`INSERT INTO "${U}".reset_tokens(token, user_id, product, expires) VALUES($1,$2,$3,$4)`, [tok, r.rows[0].id, PRODUCT, exp]);
      await sendReset(email, tok);
    }
    res.json({ ok: true });   // never reveal whether the email exists
  } catch (e) { console.error('forgot', e); res.json({ ok: true }); }
});

app.post('/api/reset', limit(10, 60000), async (req, res) => {
  try {
    const { token, password } = req.body;
    if ((password || '').length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    const r = await pool.query(`SELECT user_id, expires FROM "${U}".reset_tokens WHERE token=$1`, [token]);
    if (!r.rows.length || Number(r.rows[0].expires) < Date.now())
      return res.status(400).json({ error: 'This reset link is invalid or expired. Request a new one.' });
    const hash = await bcrypt.hash(password, 10);
    await pool.query(`UPDATE "${U}".users SET pw_hash=$1 WHERE id=$2`, [hash, r.rows[0].user_id]);
    await pool.query(`DELETE FROM "${U}".reset_tokens WHERE token=$1`, [token]);
    res.json({ ok: true });
  } catch (e) { console.error('reset', e); res.status(500).json({ error: 'Server error.' }); }
});

// ---- admin: cross-user support-ticket review -----------------------------------------------
// Only the admin account may list/triage every user's tickets. Tickets are extracted live from each
// user's prog_json (source of truth); done/deleted state is overlaid from D.ticket_status.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'elijah@kingdombuilders.ai')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
function adminAuth(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  try {
    const u = jwt.verify(t, JWT_SECRET);
    if (!ADMIN_EMAILS.includes((u.email || '').toLowerCase()))
      return res.status(403).json({ error: 'Admins only.' });
    req.user = u; next();
  } catch { res.status(401).json({ error: 'Please sign in again.' }); }
}
// a stable key for a ticket: owner-email + submit-timestamp + type
const ticketKey = (email, t) => `${(email || '').toLowerCase()}|${t.ts}|${t.type || ''}`;

app.get('/api/admin/tickets', adminAuth, async (req, res) => {
  try {
    const wantType = (req.query.type || '').trim(); // e.g. "bug"; empty = all types
    const rows = (await pool.query(
      `SELECT u.email, p.prog_json FROM "${D}".progress p JOIN "${U}".users u ON u.id = p.user_id`
    )).rows;
    const st = {};
    (await pool.query(`SELECT ticket_key, done, deleted FROM "${D}".ticket_status`)).rows
      .forEach(r => { st[r.ticket_key] = r; });
    const out = [];
    for (const row of rows) {
      let prog; try { prog = JSON.parse(row.prog_json || '{}'); } catch { continue; }
      const tickets = Array.isArray(prog.tickets) ? prog.tickets : [];
      for (const t of tickets) {
        if (wantType && t.type !== wantType) continue;
        const key = ticketKey(row.email, t);
        const s = st[key] || {};
        if (s.deleted) continue;
        out.push({ key, email: row.email, type: t.type || '', text: t.text || '',
                   recipient: t.recipient || '', ts: t.ts || 0, done: !!s.done });
      }
    }
    out.sort((a, b) => b.ts - a.ts); // newest first
    res.json({ tickets: out });
  } catch (e) { console.error('admin-tickets', e); res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/admin/tickets/status', adminAuth, async (req, res) => {
  try {
    const key = String(req.body.key || ''); const done = !!req.body.done;
    if (!key) return res.status(400).json({ error: 'Missing key.' });
    await pool.query(
      `INSERT INTO "${D}".ticket_status(ticket_key, done, updated_at) VALUES($1,$2,now())
       ON CONFLICT(ticket_key) DO UPDATE SET done=$2, updated_at=now()`, [key, done]);
    res.json({ ok: true });
  } catch (e) { console.error('admin-status', e); res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/admin/tickets/delete', adminAuth, async (req, res) => {
  try {
    const key = String(req.body.key || '');
    if (!key) return res.status(400).json({ error: 'Missing key.' });
    await pool.query(
      `INSERT INTO "${D}".ticket_status(ticket_key, deleted, updated_at) VALUES($1,true,now())
       ON CONFLICT(ticket_key) DO UPDATE SET deleted=true, updated_at=now()`, [key]);
    res.json({ ok: true });
  } catch (e) { console.error('admin-delete', e); res.status(500).json({ error: 'Server error.' }); }
});

async function sendReset(email, tok) {
  const link = `${process.env.APP_URL || 'https://kingdombuilders.ai/burningbush'}?reset=${tok}`;
  if (!process.env.SENDGRID_API_KEY) { console.log('[reset link — SendGrid not set]', email, link); return; }
  try {
    const sg = require('@sendgrid/mail'); sg.setApiKey(process.env.SENDGRID_API_KEY);
    await sg.send({
      to: email, from: process.env.MAIL_FROM || 'dj@accreditationnow.com',
      subject: 'Reset your Burning Bush password',
      html: `<div style="font-family:system-ui,Segoe UI,sans-serif;font-size:15px;color:#1a1a1a">
        <h2 style="color:#c9962f">Burning Bush</h2>
        <p>Tap the button to set a new password. This link expires in 1 hour.</p>
        <p><a href="${link}" style="display:inline-block;background:#e3b34a;color:#241a02;font-weight:800;padding:12px 20px;border-radius:10px;text-decoration:none">Set a new password</a></p>
        <p style="color:#666;font-size:13px">If you didn't request this, you can safely ignore this email.</p></div>`
    });
  } catch (e) { console.error('sendReset', e && e.message); }
}

initDb()
  .then(() => app.listen(process.env.PORT || 3000, () => console.log(`burningbush-api up · users="${U}" data="${D}"`)))
  .catch(e => { console.error('DB init failed', e); process.exit(1); });
