// ============================================
// PRIZE STORE SERVICE - WITH CORS ENABLED
// ============================================
// Deploy as its own Railway service.
// Link your PostgreSQL addon to it —
// the DATABASE_URL variable will be set
// automatically via ${{ Postgres.DATABASE_URL }}
//
// ── FIXES APPLIED (see inline "FIX:" comments) ──
//   1. /users/:id/cooldown treated cooldown_seconds=0 as "not provided"
//      because of `parseInt(...) || 10`, silently forcing a 10s cooldown
//      even when the caller explicitly asked for 0.
//   2. initDatabase() ran `ALTER TABLE users ADD COLUMN ...` before the
//      `users` table itself was created, which throws on a totally fresh
//      database (no prior `users` table) and crashes startup. Reordered
//      so `users` is created first, and `last_claim_at` is now part of
//      that CREATE TABLE directly instead of depending on the ALTER.
// ============================================

const express = require('express');
const cors = require('cors'); // ← CORS module
const { Pool } = require('pg');

const app = express();

// ============================================
// MIDDLEWARE - CORS ENABLED!
// ============================================
// This allows your web app (from any domain) to
// send requests to this Prize Store API.
// Without this, browsers will block the requests!
// ============================================

app.use(cors()); // ← ENABLE CORS FOR ALL ROUTES
app.use(express.json());

// ============================================
// DATABASE CONNECTION
// ============================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL pool error:', err.message);
});

// ============================================
// SUBSCRIPTION CHECK CACHE
// ============================================
// GET /check-subscription hits Telegram's getChatMember for every
// call. That's fine for a one-off click, but the frontend also calls
// it right before every spin attempt, so a short in-memory cache keeps
// a user mashing "Check Again" (or re-opening Void Spin repeatedly)
// from hammering the Bot API and tripping its rate limit. Positive AND
// negative results are cached — negative ones expire faster so someone
// who just joined isn't stuck waiting out the full TTL.
// ============================================

const subCache = new Map(); // `${userId}:${channel}` -> { subscribed, expiresAt }
const SUB_CACHE_TTL_SUBSCRIBED_MS = 60_000;
const SUB_CACHE_TTL_UNSUBSCRIBED_MS = 15_000;

function getCachedSub(key) {
  const hit = subCache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) { subCache.delete(key); return undefined; }
  return hit.subscribed;
}

function setCachedSub(key, subscribed) {
  const ttl = subscribed ? SUB_CACHE_TTL_SUBSCRIBED_MS : SUB_CACHE_TTL_UNSUBSCRIBED_MS;
  subCache.set(key, { subscribed, expiresAt: Date.now() + ttl });
}

// ============================================
// AUTO-CREATE TABLE ON STARTUP
// ============================================

async function initDatabase() {
  const createTable = `
    CREATE TABLE IF NOT EXISTS prizes (
      prize_id        TEXT        PRIMARY KEY,
      gift_name       TEXT        NOT NULL,
      user_id         BIGINT      NOT NULL,
      username        TEXT,
      status          TEXT        NOT NULL DEFAULT 'pending',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      error_message   TEXT,
      claim_type      TEXT,
      scheduled_for   TIMESTAMPTZ,
      nft_slug        TEXT
    );
  `;

  // ── Leaderboard support ──
  // Coins/Stars used to live only in Telegram CloudStorage (per-device),
  // so there was nothing server-side to rank. This table is the shared
  // source of truth the webapp pushes to on every balance change.
  //
  // FIX: last_claim_at now lives directly in this CREATE TABLE (it used
  // to only be added via the ALTER TABLE below, which ran BEFORE this
  // table existed on a fresh install and crashed initDatabase()).
  const createUsersTable = `
    CREATE TABLE IF NOT EXISTS users (
      user_id              BIGINT      PRIMARY KEY,
      username              TEXT,
      first_name            TEXT,
      last_name             TEXT,
      avatar_url             TEXT,
      coins                 BIGINT      NOT NULL DEFAULT 0,
      stars                  BIGINT      NOT NULL DEFAULT 0,
      show_in_leaderboard    BOOLEAN     NOT NULL DEFAULT true,
      last_claim_at          TIMESTAMPTZ,
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  // Additive columns for installs that already have the old `prizes`
  // / `users` tables from before this migration existed — CREATE TABLE
  // IF NOT EXISTS above won't add columns to an already-existing table,
  // so cover that path explicitly. Safe to run every boot: IF NOT EXISTS
  // makes every one of these a no-op once the column is already there.
  //
  // FIX: this now runs AFTER both createTable and createUsersTable, so
  // `ALTER TABLE users ...` always has a `users` table to alter, even on
  // a completely fresh database.
  const addColumns = `
    ALTER TABLE prizes ADD COLUMN IF NOT EXISTS claim_type    TEXT;
    ALTER TABLE prizes ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;
    ALTER TABLE prizes ADD COLUMN IF NOT EXISTS nft_slug      TEXT;
    ALTER TABLE users  ADD COLUMN IF NOT EXISTS last_claim_at TIMESTAMPTZ;
  `;

  const createIndexScheduled = `
    CREATE INDEX IF NOT EXISTS idx_prizes_scheduled ON prizes (status, scheduled_for);
  `;

  const createIndexUser = `
    CREATE INDEX IF NOT EXISTS idx_prizes_user_id ON prizes (user_id);
  `;

  const createIndexStatus = `
    CREATE INDEX IF NOT EXISTS idx_prizes_status ON prizes (status);
  `;

  const createIndexCoins = `
    CREATE INDEX IF NOT EXISTS idx_users_coins ON users (coins DESC);
  `;

  const createIndexStars = `
    CREATE INDEX IF NOT EXISTS idx_users_stars ON users (stars DESC);
  `;

  // FIX: order changed — both tables exist before addColumns touches either.
  await pool.query(createTable);
  await pool.query(createUsersTable);
  await pool.query(addColumns);
  await pool.query(createIndexUser);
  await pool.query(createIndexStatus);
  await pool.query(createIndexScheduled);
  await pool.query(createIndexCoins);
  await pool.query(createIndexStars);

  console.log('✅ Database tables ready');
}

// ============================================
// HEALTH CHECK
// ============================================

app.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() as db_time');
    res.json({
      status: 'online',
      service: 'prize-store',
      db_time: result.rows[0].db_time
    });
  } catch (err) {
    res.status(503).json({ status: 'error', message: err.message });
  }
});

// ============================================
// POST /prizes
// ============================================
// Called by: webapp, right after a gift is won.
// Body: { prize_id, gift_name, user_id, username }
// ============================================

app.post('/prizes', async (req, res) => {
  const { prize_id, gift_name, user_id, username } = req.body;

  console.log('\n📝 Prize registration request:');
  console.log('   Prize ID:', prize_id);
  console.log('   Gift:', gift_name);
  console.log('   User ID:', user_id);
  console.log('   Username:', username);

  if (!prize_id || !gift_name || !user_id) {
    console.log('❌ Missing required fields');
    return res.status(400).json({
      error: 'Missing required fields: prize_id, gift_name, user_id'
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO prizes (prize_id, gift_name, user_id, username, status)
       VALUES ($1, $2, $3, $4, 'pending')
       ON CONFLICT (prize_id) DO NOTHING
       RETURNING *`,
      [prize_id, gift_name, user_id, username || null]
    );

    if (result.rows.length > 0) {
      console.log(`✅ Prize stored successfully!`);
      res.status(201).json({
        success: true,
        prize_id,
        message: 'Prize registered successfully',
        prize: result.rows[0]
      });
    } else {
      console.log('⚠️ Prize already exists (duplicate)');
      res.status(200).json({
        success: true,
        prize_id,
        message: 'Prize already registered'
      });
    }

  } catch (err) {
    console.error('❌ POST /prizes error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// GET /prizes/:prize_id
// ============================================
// Called by: gift transactor, to verify a prize
//           exists before sending the gift.
// ============================================

app.get('/prizes/:prize_id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM prizes WHERE prize_id = $1',
      [req.params.prize_id]
    );

    if (result.rows.length === 0) {
      console.log(`❌ Prize not found: ${req.params.prize_id}`);
      return res.status(404).json({ error: 'Prize not found' });
    }

    console.log(`✅ Prize found: ${req.params.prize_id}`);
    res.json(result.rows[0]);

  } catch (err) {
    console.error('❌ GET /prizes/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// GET /prizes?user_id=123
// ============================================
// Called by: webapp, to load a user's inventory.
// ============================================

app.get('/prizes', async (req, res) => {
  const { user_id, status } = req.query;

  if (!user_id) {
    return res.status(400).json({ error: 'user_id query param is required' });
  }

  try {
    let query = 'SELECT * FROM prizes WHERE user_id = $1';
    const params = [user_id];

    if (status) {
      query += ' AND status = $2';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC';

    const result = await pool.query(query, params);
    console.log(`📊 Found ${result.rows.length} prizes for user ${user_id}`);
    res.json(result.rows);

  } catch (err) {
    console.error('❌ GET /prizes error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// PATCH /prizes/:prize_id
// ============================================
// Called by: gift transactor, to update status.
// Body: { status, error_message (optional) }
// ============================================

app.patch('/prizes/:prize_id', async (req, res) => {
  const { status, error_message } = req.body;
  const { prize_id } = req.params;

  if (!status) {
    return res.status(400).json({ error: 'status is required' });
  }

  const allowed = ['pending', 'claiming', 'queued_nft', 'claimed', 'failed', 'converted'];
  if (!allowed.includes(status)) {
    return res.status(400).json({
      error: `Invalid status. Must be one of: ${allowed.join(', ')}`
    });
  }

  try {
    const result = await pool.query(
      `UPDATE prizes
       SET status = $1,
           error_message = $2,
           updated_at = NOW()
       WHERE prize_id = $3
       RETURNING *`,
      [status, error_message || null, prize_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Prize not found' });
    }

    console.log(`📊 Prize ${prize_id} status → ${status}`);
    res.json(result.rows[0]);

  } catch (err) {
    console.error('❌ PATCH /prizes/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// POST /prizes/:prize_id/lock
// ============================================
// Called by: gift-relayer, as the FIRST step of a claim.
// Atomically flips pending -> claiming. This is the thing that makes
// concurrent/duplicate claim requests for the same prize safe: only
// one request can ever win the WHERE status='pending' race, everyone
// else gets 409 and bails before touching the relayer's balance.
// Body: { user_id }  — must match the prize's owner.
// ============================================

app.post('/prizes/:prize_id/lock', async (req, res) => {
  const { prize_id } = req.params;
  const { user_id } = req.body;

  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  try {
    // FIX: a claim that fails downstream (e.g. a bad send to Telegram)
    // gets PATCHed to status='failed' by the relayer, but nothing ever
    // moved it back to 'pending'. Since this lock only matched
    // status='pending', the very first real failure permanently
    // stranded that prize — every retry got 409 "not claimable" forever,
    // even though the user never actually received anything. 'failed'
    // is now accepted here too, so a failed claim can be retried; only
    // 'claiming' (in-flight) and 'claimed'/'queued_nft' (already
    // succeeded) still correctly block re-locking.
    const result = await pool.query(
      `UPDATE prizes
       SET status = 'claiming', updated_at = NOW()
       WHERE prize_id = $1 AND user_id = $2 AND status IN ('pending', 'failed')
       RETURNING *`,
      [prize_id, user_id]
    );

    if (result.rows.length === 0) {
      // Distinguish "doesn't exist / wrong owner" from "already being
      // claimed or already claimed" so the relayer can give a sane error.
      const existing = await pool.query('SELECT status, user_id FROM prizes WHERE prize_id = $1', [prize_id]);
      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'Prize not found' });
      }
      if (String(existing.rows[0].user_id) !== String(user_id)) {
        return res.status(403).json({ error: 'Prize does not belong to this user' });
      }
      return res.status(409).json({ error: `Prize is not claimable (status: ${existing.rows[0].status})` });
    }

    console.log(`🔒 Prize locked for claim: ${prize_id}`);
    res.json({ success: true, prize: result.rows[0] });

  } catch (err) {
    console.error('❌ POST /prizes/:id/lock error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// POST /prizes/:prize_id/schedule
// ============================================
// Called by: gift-relayer, right after locking, when the gift is an
// NFT/collectible that needs the 48h transfer window instead of an
// immediate send. Must already be in 'claiming' status.
// Body: { claim_type: 'nft', scheduled_for (ISO string), nft_slug? }
// ============================================

app.post('/prizes/:prize_id/schedule', async (req, res) => {
  const { prize_id } = req.params;
  const { claim_type, scheduled_for, nft_slug } = req.body;

  if (!claim_type || !scheduled_for) {
    return res.status(400).json({ error: 'claim_type and scheduled_for are required' });
  }

  try {
    const result = await pool.query(
      `UPDATE prizes
       SET status = 'queued_nft', claim_type = $1, scheduled_for = $2, nft_slug = $3, updated_at = NOW()
       WHERE prize_id = $4 AND status = 'claiming'
       RETURNING *`,
      [claim_type, scheduled_for, nft_slug || null, prize_id]
    );

    if (result.rows.length === 0) {
      return res.status(409).json({ error: 'Prize must be in "claiming" status to schedule' });
    }

    console.log(`⏳ Prize ${prize_id} scheduled for ${scheduled_for}`);
    res.json({ success: true, prize: result.rows[0] });

  } catch (err) {
    console.error('❌ POST /prizes/:id/schedule error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// GET /prizes/queue/nft-due
// ============================================
// Called by: gift-relayer's background worker, polling for NFT
// transfers whose 48h window has elapsed.
// ============================================

app.get('/prizes/queue/nft-due', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

  try {
    const result = await pool.query(
      `SELECT * FROM prizes
       WHERE status = 'queued_nft' AND scheduled_for <= NOW()
       ORDER BY scheduled_for ASC
       LIMIT $1`,
      [limit]
    );
    res.json(result.rows);

  } catch (err) {
    console.error('❌ GET /prizes/queue/nft-due error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// DELETE /users/:user_id/cooldown
// ============================================
// Called by: gift-relayer, when a claim fails AFTER the cooldown was
// already started for it (see POST /users/:id/cooldown below). Without
// this, a failed claim still leaves last_claim_at set, so the user's
// very next (genuine) retry gets rejected with 429 "Please slow down"
// even though nothing of theirs was ever actually claimed.
//
// Only rolls the timestamp back if it matches what the relayer itself
// just set (passed back as expected_last_claim_at) — this stops a
// slow/late release call from accidentally wiping out a NEWER cooldown
// started by a different, unrelated claim attempt in the meantime.
// Body: { expected_last_claim_at }
// ============================================

app.delete('/users/:user_id/cooldown', async (req, res) => {
  const { user_id } = req.params;
  const { expected_last_claim_at } = req.body;

  if (!user_id || isNaN(Number(user_id))) {
    return res.status(400).json({ error: 'Valid numeric user_id is required' });
  }
  if (!expected_last_claim_at) {
    return res.status(400).json({ error: 'expected_last_claim_at is required' });
  }

  try {
    const result = await pool.query(
      `UPDATE users
       SET last_claim_at = NULL
       WHERE user_id = $1 AND last_claim_at = $2
       RETURNING user_id`,
      [user_id, expected_last_claim_at]
    );

    // No match just means someone else's claim already moved the
    // timestamp forward — nothing to release, and nothing to undo.
    res.json({ ok: true, released: result.rows.length > 0 });

  } catch (err) {
    console.error('❌ DELETE /users/:id/cooldown error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// POST /users/:user_id/cooldown
// ============================================
// Called by: gift-relayer, before doing anything else for a claim
// request. Atomically checks-and-sets last_claim_at so the cooldown
// is enforced even across relayer restarts/multiple instances —
// the DB row is the single source of truth, not in-memory state.
// Body: { cooldown_seconds }
// Returns 200 { ok: true } if the claim may proceed (and marks the
// cooldown as started), or 429 { ok: false, retry_after } if not.
// ============================================

app.post('/users/:user_id/cooldown', async (req, res) => {
  const { user_id } = req.params;

  // FIX: `parseInt(req.body.cooldown_seconds, 10) || 10` treated an
  // explicit 0 the same as "not provided", because 0 is falsy in JS —
  // so cooldown_seconds: 0 silently became a 10s cooldown no matter
  // what the caller asked for. Only fall back to the 10s default when
  // the value is genuinely missing/invalid (not a finite number >= 0).
  let cooldownSeconds = parseInt(req.body.cooldown_seconds, 10);
  if (!Number.isFinite(cooldownSeconds) || cooldownSeconds < 0) {
    cooldownSeconds = 10;
  }

  if (!user_id || isNaN(Number(user_id))) {
    return res.status(400).json({ error: 'Valid numeric user_id is required' });
  }

  try {
    // Upsert first so first-time claimers have a row to race against.
    await pool.query(
      `INSERT INTO users (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [user_id]
    );

    // FIX: truncate to millisecond precision on write. TIMESTAMPTZ stores
    // microseconds, but the value we hand back gets JSON-round-tripped
    // through a JS Date (ms precision only) before the relayer sends it
    // back to DELETE /cooldown for release. Without this truncation the
    // stored (microsecond) value never equals the round-tripped (ms)
    // value, so `last_claim_at = $2` in the release query never matches,
    // the release silently no-ops, and every failed claim leaves the
    // cooldown stuck for its full duration — bouncing the user's next
    // genuine retry with 429 "Please slow down" even though nothing of
    // theirs actually succeeded.
    const result = await pool.query(
      `UPDATE users
       SET last_claim_at = date_trunc('milliseconds', NOW())
       WHERE user_id = $1
         AND (last_claim_at IS NULL OR last_claim_at <= NOW() - ($2 || ' seconds')::interval)
       RETURNING last_claim_at`,
      [user_id, cooldownSeconds]
    );

    if (result.rows.length > 0) {
      return res.json({ ok: true, last_claim_at: result.rows[0].last_claim_at });
    }

    const current = await pool.query('SELECT last_claim_at FROM users WHERE user_id = $1', [user_id]);
    const lastClaim = current.rows[0]?.last_claim_at ? new Date(current.rows[0].last_claim_at) : new Date();
    const retryAfter = Math.max(0, cooldownSeconds - Math.floor((Date.now() - lastClaim.getTime()) / 1000));

    res.status(429).json({ ok: false, retry_after: retryAfter });

  } catch (err) {
    console.error('❌ POST /users/:id/cooldown error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// DELETE /prizes/:prize_id
// ============================================
// Called by: gift transactor, ONLY after the
//           prize status is "claimed".
// ============================================

app.delete('/prizes/:prize_id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM prizes WHERE prize_id = $1 AND status = $2 RETURNING *',
      [req.params.prize_id, 'claimed']
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Prize not found or not in "claimed" status'
      });
    }

    console.log(`🗑️  Prize deleted: ${req.params.prize_id}`);
    res.json({ success: true, deleted: result.rows[0] });

  } catch (err) {
    console.error('❌ DELETE /prizes/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// PUT /users/:user_id
// ============================================
// Called by: webapp, on login and on every coin/star
//            change, so the leaderboard has a live copy.
// Body: { username, first_name, last_name, avatar_url,
//         coins, stars, show_in_leaderboard }
// Any field can be omitted — omitted fields are left
// untouched on an existing row (partial update).
// ============================================

app.put('/users/:user_id', async (req, res) => {
  const { user_id } = req.params;
  const { username, first_name, last_name, avatar_url, coins, stars, show_in_leaderboard } = req.body;

  if (!user_id || isNaN(Number(user_id))) {
    return res.status(400).json({ error: 'Valid numeric user_id is required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO users (user_id, username, first_name, last_name, avatar_url, coins, stars, show_in_leaderboard, updated_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, 0), COALESCE($7, 0), COALESCE($8, true), NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         username             = COALESCE($2, users.username),
         first_name           = COALESCE($3, users.first_name),
         last_name             = COALESCE($4, users.last_name),
         avatar_url            = COALESCE($5, users.avatar_url),
         coins                 = COALESCE($6, users.coins),
         stars                 = COALESCE($7, users.stars),
         show_in_leaderboard   = COALESCE($8, users.show_in_leaderboard),
         updated_at            = NOW()
       RETURNING *`,
      [
        user_id,
        username ?? null,
        first_name ?? null,
        last_name ?? null,
        avatar_url ?? null,
        coins !== undefined ? coins : null,
        stars !== undefined ? stars : null,
        show_in_leaderboard !== undefined ? show_in_leaderboard : null
      ]
    );

    res.json({ success: true, user: result.rows[0] });

  } catch (err) {
    console.error('❌ PUT /users/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// GET /leaderboard
// ============================================
// Called by: webapp Leaderboard page.
// Query: ?user_id=123&limit=20
// Returns top N for coins/stars/gifts in one shot
// (so switching tabs doesn't need another request),
// plus the caller's own rank/score in "you" if
// user_id was provided.
// Coins/Stars leaderboards only include users with
// show_in_leaderboard = true. Gifts leaderboard is
// counted from claimed prizes and applies the same
// opt-out via a join against users.
// ============================================

app.get('/leaderboard', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const userId = req.query.user_id;

  try {
    const [coinsRes, starsRes, giftsRes] = await Promise.all([
      pool.query(
        `SELECT user_id, username, first_name, last_name, avatar_url, coins
         FROM users
         WHERE show_in_leaderboard = true
         ORDER BY coins DESC, updated_at ASC
         LIMIT $1`,
        [limit]
      ),
      pool.query(
        `SELECT user_id, username, first_name, last_name, avatar_url, stars
         FROM users
         WHERE show_in_leaderboard = true
         ORDER BY stars DESC, updated_at ASC
         LIMIT $1`,
        [limit]
      ),
      pool.query(
        `SELECT p.user_id, COUNT(*)::int AS gifts,
                u.username, u.first_name, u.last_name, u.avatar_url
         FROM prizes p
         LEFT JOIN users u ON u.user_id = p.user_id
         WHERE p.status = 'claimed'
           AND (u.show_in_leaderboard IS NULL OR u.show_in_leaderboard = true)
         GROUP BY p.user_id, u.username, u.first_name, u.last_name, u.avatar_url
         ORDER BY gifts DESC
         LIMIT $1`,
        [limit]
      )
    ]);

    let you = null;

    if (userId && !isNaN(Number(userId))) {
      const [coinsRank, starsRank, giftsRank, ownRes, giftsCountRes] = await Promise.all([
        pool.query(
          `SELECT COUNT(*)::int + 1 AS rank FROM users
           WHERE show_in_leaderboard = true
             AND coins > (SELECT COALESCE(coins, 0) FROM users WHERE user_id = $1)`,
          [userId]
        ),
        pool.query(
          `SELECT COUNT(*)::int + 1 AS rank FROM users
           WHERE show_in_leaderboard = true
             AND stars > (SELECT COALESCE(stars, 0) FROM users WHERE user_id = $1)`,
          [userId]
        ),
        pool.query(
          `SELECT COUNT(*)::int + 1 AS rank FROM (
             SELECT p.user_id, COUNT(*) AS c
             FROM prizes p
             LEFT JOIN users u ON u.user_id = p.user_id
             WHERE p.status = 'claimed'
               AND (u.show_in_leaderboard IS NULL OR u.show_in_leaderboard = true)
             GROUP BY p.user_id
           ) g
           WHERE g.c > (SELECT COUNT(*) FROM prizes WHERE user_id = $1 AND status = 'claimed')`,
          [userId]
        ),
        pool.query('SELECT coins, stars, show_in_leaderboard FROM users WHERE user_id = $1', [userId]),
        pool.query(`SELECT COUNT(*)::int AS gifts FROM prizes WHERE user_id = $1 AND status = 'claimed'`, [userId])
      ]);

      const own = ownRes.rows[0] || { coins: 0, stars: 0, show_in_leaderboard: true };

      you = {
        coins: { rank: coinsRank.rows[0].rank, score: Number(own.coins) || 0 },
        stars: { rank: starsRank.rows[0].rank, score: Number(own.stars) || 0 },
        gifts: { rank: giftsRank.rows[0].rank, score: giftsCountRes.rows[0].gifts },
        hidden: own.show_in_leaderboard === false
      };
    }

    res.json({
      coins: coinsRes.rows,
      stars: starsRes.rows,
      gifts: giftsRes.rows,
      you
    });

  } catch (err) {
    console.error('❌ GET /leaderboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// STARTUP
// ============================================

const PORT = process.env.PORT || 3002;

async function start() {
  try {
    await initDatabase();
    console.log('✅ PostgreSQL connected and ready');
  } catch (err) {
    console.error('❌ Cannot connect to PostgreSQL:', err.message);
    console.error('   Make sure DATABASE_URL is set.');
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log('');
    console.log('═══════════════════════════════════════════');
    console.log('🗄️  PRIZE STORE SERVICE (WITH CORS)');
    console.log('═══════════════════════════════════════════');
    console.log(`🌐 Running on port ${PORT}`);
    console.log('✅ CORS enabled for all origins');
    console.log('');
    console.log('📡 Endpoints:');
    console.log('   POST   /prizes               → store a new prize');
    console.log('   GET    /prizes?user_id=      → get user prizes');
    console.log('   GET    /prizes/:id           → get one prize');
    console.log('   PATCH  /prizes/:id           → update status');
    console.log('   POST   /prizes/:id/lock      → atomically lock for claim (V2)');
    console.log('   POST   /prizes/:id/schedule  → schedule NFT transfer (V2)');
    console.log('   GET    /prizes/queue/nft-due → due NFT transfers (V2)');
    console.log('   POST   /users/:id/cooldown   → atomic claim-cooldown check (V2)');
    console.log('   DELETE /users/:id/cooldown   → release cooldown after a failed claim (V2)');
    console.log('   DELETE /prizes/:id           → remove claimed prize');
    console.log('   PUT    /users/:id            → upsert profile/balances');
    console.log('   GET    /leaderboard          → top coins/stars/gifts + your rank');
    console.log('═══════════════════════════════════════════');
  });
}

start();
