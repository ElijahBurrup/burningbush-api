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

/* ---- billing ------------------------------------------------------------------------------------
   Stripe signs each webhook over the EXACT bytes it sent. express.json() replaces req.body with a
   parsed object and throws the bytes away, so the signature can never be checked afterwards — the
   webhook route therefore takes express.raw and is mounted BEFORE the JSON parser below. Mounting it
   after is the classic way to get a billing integration that silently rejects every event.        */
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WH  = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripe = STRIPE_KEY ? require('stripe')(STRIPE_KEY) : null;
const PRICES = { yearly: process.env.STRIPE_PRICE_YEARLY || '', monthly: process.env.STRIPE_PRICE_MONTHLY || '' };
const PORTAL_CFG = process.env.STRIPE_PORTAL_CONFIG || '';

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WH) return res.status(503).send('billing not configured');
  let ev;
  try { ev = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WH); }
  catch (err) { return res.status(400).send('bad signature: ' + err.message); }
  // Answer first. Stripe retries anything not acknowledged inside its timeout, and a slow database
  // write is not a reason to be sent the same event again.
  res.json({ received: true });
  try { await handleStripeEvent(ev); }
  catch (err) { console.error('[stripe] ' + ev.type + ' failed:', err.message); }
});

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
    -- Who has actually paid. One row per user: a person has one subscription to this product, and
    -- resubscribing after a lapse overwrites rather than accumulating.
    CREATE TABLE IF NOT EXISTS "${D}".subscriptions (
      user_id BIGINT PRIMARY KEY REFERENCES "${U}".users(id) ON DELETE CASCADE,
      customer_id TEXT,
      subscription_id TEXT,
      status TEXT,                       -- active | trialing | past_due | canceled | incomplete…
      plan TEXT,                         -- yearly | monthly
      period_end BIGINT,                 -- unix seconds; when the paid-for stretch runs out
      cancel_at_period_end BOOLEAN DEFAULT false,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    -- the webhook usually knows the customer or the subscription, not the user
    CREATE INDEX IF NOT EXISTS subs_customer ON "${D}".subscriptions(customer_id);
    CREATE INDEX IF NOT EXISTS subs_subscription ON "${D}".subscriptions(subscription_id);
    CREATE TABLE IF NOT EXISTS "${D}".ticket_status (
      ticket_key TEXT PRIMARY KEY,
      done BOOLEAN DEFAULT false,
      deleted BOOLEAN DEFAULT false,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

/* Two statuses count as paid. Stripe keeps a subscription "active" through a pending cancellation —
   cancel_at_period_end is a flag on an otherwise live subscription — so someone who has cancelled
   keeps what they bought until the period they paid for actually ends. */
const PAID = new Set(['active', 'trialing']);
const GRACE = 36 * 3600;   // seconds. Covers a late renewal webhook rather than locking someone out.

function isPaid(row) {
  if (!row || !PAID.has(row.status)) return false;
  if (row.period_end && Number(row.period_end) + GRACE < Math.floor(Date.now() / 1000)) return false;
  return true;
}

async function saveSub(userId, sub, plan) {
  const item = (sub.items && sub.items.data && sub.items.data[0]) || {};
  const price = item.price || {};
  const known = plan || (price.recurring && price.recurring.interval === 'month' ? 'monthly' : 'yearly');
  await pool.query(
    `INSERT INTO "${D}".subscriptions
       (user_id, customer_id, subscription_id, status, plan, period_end, cancel_at_period_end, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (user_id) DO UPDATE SET
       customer_id=EXCLUDED.customer_id, subscription_id=EXCLUDED.subscription_id,
       status=EXCLUDED.status, plan=EXCLUDED.plan, period_end=EXCLUDED.period_end,
       cancel_at_period_end=EXCLUDED.cancel_at_period_end, updated_at=now()`,
    [userId, String(sub.customer || ''), String(sub.id || ''), String(sub.status || ''),
     known, sub.current_period_end || null, !!sub.cancel_at_period_end]);
}

// The user this event belongs to. A checkout carries it outright; later events carry only Stripe's
// own ids, so they are matched against the row the checkout wrote.
async function userForEvent(o) {
  if (o.client_reference_id && /^\d+$/.test(String(o.client_reference_id))) return Number(o.client_reference_id);
  if (o.metadata && o.metadata.uid && /^\d+$/.test(String(o.metadata.uid))) return Number(o.metadata.uid);
  const byId = o.id && (await pool.query(`SELECT user_id FROM "${D}".subscriptions WHERE subscription_id=$1`, [String(o.id)])).rows[0];
  if (byId) return Number(byId.user_id);
  const byCust = o.customer && (await pool.query(`SELECT user_id FROM "${D}".subscriptions WHERE customer_id=$1`, [String(o.customer)])).rows[0];
  return byCust ? Number(byCust.user_id) : null;
}

async function handleStripeEvent(ev) {
  const o = ev.data.object;
  if (ev.type === 'checkout.session.completed') {
    const uid = await userForEvent(o);
    if (!uid) return console.error('[stripe] checkout with no account attached:', o.id);
    if (!o.subscription) return;                       // a one-off payment is not a subscription
    const sub = await stripe.subscriptions.retrieve(String(o.subscription));
    await saveSub(uid, sub, (o.metadata && o.metadata.plan) || null);
    return;
  }
  if (ev.type === 'customer.subscription.updated' || ev.type === 'customer.subscription.deleted') {
    const uid = await userForEvent(o);
    if (!uid) return console.error('[stripe] ' + ev.type + ' for an unknown account:', o.id);
    // a deleted subscription arrives with its final status; record it rather than guessing
    await saveSub(uid, o, (o.metadata && o.metadata.plan) || null);
  }
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

/* ---- licensed scripture, proxied ---------------------------------------------------------------
   The NLT is Tyndale's and cannot ship inside the app the way the public domain texts do, so it is
   read through api.bible a chapter at a time. Two reasons this lives on the server rather than in
   the client: the api.bible key never reaches a browser, and one cache here serves every reader, so
   a chapter is fetched from api.bible once no matter how many people open it.

   The cache is deliberately bounded. It is a cache, not a copy of the Bible.                     */
const BIBLE_KEY = process.env.BIBLE_API_KEY || '';
const BIBLE_IDS = { nlt: process.env.BIBLE_NLT_ID || 'd6e14a625393b4da-01' };
const USFM = ('GEN EXO LEV NUM DEU JOS JDG RUT 1SA 2SA 1KI 2KI 1CH 2CH EZR NEH EST JOB PSA PRO ECC SNG ' +
  'ISA JER LAM EZK DAN HOS JOL AMO OBA JON MIC NAM HAB ZEP HAG ZEC MAL MAT MRK LUK JHN ACT ROM 1CO 2CO ' +
  'GAL EPH PHP COL 1TH 2TH 1TI 2TI TIT PHM HEB JAS 1PE 2PE 1JN 2JN 3JN JUD REV').split(' ');

const CHAP_MAX = 600;                       // ~half a Bible; oldest evicted first
const chapCache = new Map();                // "nlt:43:3" -> {verses, copyright}
const chapHit = (k) => { const v = chapCache.get(k); if (v) { chapCache.delete(k); chapCache.set(k, v); } return v; };
const chapPut = (k, v) => { chapCache.set(k, v); while (chapCache.size > CHAP_MAX) chapCache.delete(chapCache.keys().next().value); };
const inflight = new Map();                 // one upstream call per chapter, however many ask at once

// Text nodes carry attrs.verseId only sometimes; the <verse> tag is always present and always in
// document order, so it is the cursor. (Keying on verseId silently dropped whole quoted passages.)
function versesFrom(content) {
  const out = new Map();          // num -> {text, block}
  let cur = null, block = 0;
  (function walk(n) {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    if (n.type === 'tag' && n.name === 'verse') {
      if (n.attrs && n.attrs.style === 've') { cur = null; return; }
      const num = n.attrs && (n.attrs.number || String(n.attrs.sid || '').split(':')[1]);
      cur = num ? String(num).split('-')[0] : cur;
      return;
    }
    // Each line of poetry is its own para and carries no whitespace of its own, so crossing one is
    // a word boundary. Runs inside the same para (italics, divine name) must NOT gain a space.
    if (n.type === 'tag' && n.name === 'para') block++;
    if (n.type === 'text') {
      const k = (n.attrs && n.attrs.verseId) ? String(n.attrs.verseId).split('.')[2] : cur;
      if (!k) return;
      const prev = out.get(k);
      let t = n.text;
      if (prev && prev.block !== block && !/\s$/.test(prev.text) && !/^\s/.test(t)) t = ' ' + t;
      out.set(k, { text: (prev ? prev.text : '') + t, block });
      return;
    }
    if (n.items) walk(n.items);
  })(content);
  const flat = new Map();
  for (const [k, v] of out) flat.set(k, v.text);
  return flat;
}

async function fetchChapter(trans, book, chapter) {
  const key = trans + ':' + book + ':' + chapter;
  const hit = chapHit(key);
  if (hit) return hit;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const id = BIBLE_IDS[trans];
    const url = 'https://rest.api.bible/v1/bibles/' + id + '/chapters/' + USFM[book - 1] + '.' + chapter +
      '?content-type=json&include-notes=false&include-titles=false&include-chapter-numbers=false&include-verse-spans=false';
    const r = await fetch(url, { headers: { 'api-key': BIBLE_KEY } });
    if (!r.ok) throw new Error('upstream ' + r.status);
    const j = await r.json();
    const m = versesFrom(j.data.content);
    const verses = [];
    for (const [num, text] of m) {
      const n = Number(num);
      if (n > 0) verses[n - 1] = String(text).replace(/\s+/g, ' ').trim();
    }
    for (let i = 0; i < verses.length; i++) if (verses[i] == null) verses[i] = '';
    const out = { verses, copyright: (j.data.copyright || '').trim() };
    chapPut(key, out);
    return out;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// One chapter, or several in one round trip: ?refs=43.3,19.23 keeps a page load to a single request.
app.get('/api/bible/:trans', limit(240, 60000), async (req, res) => {
  const trans = String(req.params.trans || '').toLowerCase();
  if (!BIBLE_IDS[trans]) return res.status(404).json({ error: 'unknown translation' });
  if (!BIBLE_KEY) return res.status(503).json({ error: 'scripture api not configured' });
  const refs = String(req.query.refs || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 40);
  if (!refs.length) return res.status(400).json({ error: 'refs required, e.g. refs=43.3,19.23' });
  const bad = refs.find(r => !/^\d{1,2}\.\d{1,3}$/.test(r));
  if (bad) return res.status(400).json({ error: 'bad ref ' + bad });
  try {
    const out = {};
    let copyright = '';
    await Promise.all(refs.map(async r => {
      const [b, c] = r.split('.').map(Number);
      if (b < 1 || b > 66 || c < 1) return;
      const got = await fetchChapter(trans, b, c);
      out[r] = got.verses;
      copyright = copyright || got.copyright;
    }));
    res.set('Cache-Control', 'public, max-age=86400');
    res.json({ trans, chapters: out, copyright });
  } catch (e) {
    res.status(502).json({ error: 'scripture unavailable' });
  }
});

/* The one answer the app trusts. Everything about Pro in the browser is a cache of this. */
app.get('/api/entitlement', auth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM "${D}".subscriptions WHERE user_id=$1`, [req.user.uid]);
    const row = r.rows[0];
    res.json({
      pro: isPaid(row),
      plan: row ? row.plan : null,
      status: row ? row.status : null,
      until: row && row.period_end ? Number(row.period_end) * 1000 : null,
      cancelAtPeriodEnd: row ? !!row.cancel_at_period_end : false
    });
  } catch (e) { res.status(500).json({ error: 'Could not read your subscription.' }); }
});

/* Checkout is opened by the server so the account is attached to the payment by us rather than by a
   query parameter the browser could be talked out of. client_reference_id is the thread the webhook
   follows back to this user. */
app.post('/api/checkout', auth, limit(20, 60000), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Checkout is not set up yet.' });
  const plan = req.body && req.body.plan === 'monthly' ? 'monthly' : 'yearly';
  const price = PRICES[plan];
  if (!price) return res.status(503).json({ error: 'That plan is not set up yet.' });
  const app_url = process.env.APP_URL || 'https://kingdombuilders.ai/burningbush';
  try {
    const prior = await pool.query(`SELECT customer_id FROM "${D}".subscriptions WHERE user_id=$1`, [req.user.uid]);
    const s = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      client_reference_id: String(req.user.uid),
      // reuse the customer if they have subscribed before, so one person is one customer in Stripe
      ...(prior.rows[0] && prior.rows[0].customer_id
        ? { customer: prior.rows[0].customer_id }
        : { customer_email: req.user.email }),
      metadata: { uid: String(req.user.uid), plan },
      subscription_data: { metadata: { uid: String(req.user.uid), plan } },
      allow_promotion_codes: true,
      success_url: app_url + '?checkout=success',
      cancel_url: app_url + '?checkout=cancelled'
    });
    res.json({ url: s.url });
  } catch (e) { console.error('[stripe] checkout:', e.message); res.status(500).json({ error: 'Could not open checkout.' }); }
});

/* Manage or cancel. A session is made for this user, so there is no shared link to guess. */
app.post('/api/portal', auth, limit(20, 60000), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing is not set up yet.' });
  try {
    const r = await pool.query(`SELECT customer_id FROM "${D}".subscriptions WHERE user_id=$1`, [req.user.uid]);
    const cust = r.rows[0] && r.rows[0].customer_id;
    if (!cust) return res.status(404).json({ error: 'No subscription to manage yet.' });
    const s = await stripe.billingPortal.sessions.create({
      customer: cust,
      ...(PORTAL_CFG ? { configuration: PORTAL_CFG } : {}),
      return_url: process.env.APP_URL || 'https://kingdombuilders.ai/burningbush'
    });
    res.json({ url: s.url });
  } catch (e) { console.error('[stripe] portal:', e.message); res.status(500).json({ error: 'Could not open the billing page.' }); }
});

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
