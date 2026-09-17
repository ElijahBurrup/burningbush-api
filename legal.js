/* Accepting the terms, recorded where it can be relied on.
 *
 * A tick in a browser proves nothing later: localStorage can be cleared, and a claim that somebody
 * agreed is worth only as much as the record of it. So the moment they tick the box, the version,
 * the time, the account and the IP address it came from are written down here, and CHECKOUT REFUSES
 * without that row. Nobody reaches a payment page without an acceptance on file, which is the whole
 * point of the box (owner's instruction, 2026-09-17).
 *
 * TERMS_VERSION must match LEGAL_VERSION in the app (src/index.html). Raising it here asks
 * everybody to accept again before their next purchase; it does not touch anything they have
 * already bought, and it never interrupts somebody mid-use.
 */
const TERMS_VERSION = '2026-09-17';

const ddl = U => `
  CREATE TABLE IF NOT EXISTS "${U}".legal_accept (
    user_id BIGINT REFERENCES "${U}".users(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    accepted_at TIMESTAMPTZ DEFAULT now(),
    source TEXT,
    ip TEXT,
    PRIMARY KEY (user_id, version)
  );`;

/* The versions this account has accepted, newest first. */
async function acceptances(pool, U, uid) {
  const r = await pool.query(
    `SELECT version, accepted_at, source FROM "${U}".legal_accept WHERE user_id=$1 ORDER BY accepted_at DESC`, [uid]);
  return r.rows;
}

async function hasAccepted(pool, U, uid, version = TERMS_VERSION) {
  const r = await pool.query(`SELECT 1 FROM "${U}".legal_accept WHERE user_id=$1 AND version=$2`, [uid, version]);
  return !!r.rows.length;
}

/* Written once per account per version: a second tick is not a second agreement, and must not
   overwrite the date of the first one, which is the date that matters. */
async function record(pool, U, uid, { version, source, ip }) {
  await pool.query(
    `INSERT INTO "${U}".legal_accept(user_id, version, source, ip) VALUES($1,$2,$3,$4)
     ON CONFLICT (user_id, version) DO NOTHING`,
    [uid, version || TERMS_VERSION, String(source || '').slice(0, 40) || null, String(ip || '').slice(0, 64) || null]);
  return acceptances(pool, U, uid);
}

function mountLegal(app, { pool, U, auth, limit }) {
  // What this account has accepted, and what it needs to accept. The app asks on boot.
  app.get('/api/legal', auth, async (req, res) => {
    try {
      const rows = await acceptances(pool, U, req.user.uid);
      res.json({ version: TERMS_VERSION, accepted: rows.some(r => r.version === TERMS_VERSION), history: rows });
    } catch (e) { console.error('legal-get', e); res.status(500).json({ error: 'Server error.' }); }
  });

  app.post('/api/legal/accept', auth, limit(20, 60000), async (req, res) => {
    try {
      const version = String((req.body && req.body.version) || TERMS_VERSION).slice(0, 20);
      if (version !== TERMS_VERSION)
        return res.status(409).json({ error: 'These are not the current terms — reload the app.', version: TERMS_VERSION });
      const rows = await record(pool, U, req.user.uid, { version, source: req.body && req.body.source, ip: req.ip });
      console.log('[legal] ' + req.user.email + ' accepted ' + version + ' (' + ((req.body && req.body.source) || 'app') + ')');
      res.json({ ok: true, version, accepted: true, history: rows });
    } catch (e) { console.error('legal-accept', e); res.status(500).json({ error: 'Server error.' }); }
  });
}

module.exports = { TERMS_VERSION, ddl, mountLegal, hasAccepted, acceptances, record };
