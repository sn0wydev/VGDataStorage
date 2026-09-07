// ============================================
// PRIZE STORE SERVICE - WITH CORS ENABLED
// ============================================
// Deploy as its own Railway service.
// Link your PostgreSQL addon to it —
// the DATABASE_URL variable will be set
// automatically via ${{ Postgres.DATABASE_URL }}
// ============================================

const express = require('express');
const cors = require('cors'); // ← ADDED: CORS module
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
      error_message   TEXT
    );
  `;

  const createIndexUser = `
    CREATE INDEX IF NOT EXISTS idx_prizes_user_id ON prizes (user_id);
  `;

  const createIndexStatus = `
    CREATE INDEX IF NOT EXISTS idx_prizes_status ON prizes (status);
  `;

  // ── Leaderboard support ──
  // Coins/Stars used to live only in Telegram CloudStorage (per-device),
  // so there was nothing server-side to rank. This table is the shared
  // source of truth the webapp pushes to on every balance change.
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
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  const createIndexCoins = `
    CREATE INDEX IF NOT EXISTS idx_users_coins ON users (coins DESC);
  `;

  const createIndexStars = `
    CREATE INDEX IF NOT EXISTS idx_users_stars ON users (stars DESC);
  `;

  await pool.query(createTable);
  await pool.query(createIndexUser);
  await pool.query(createIndexStatus);
  await pool.query(createUsersTable);
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

  const allowed = ['pending', 'claiming', 'claimed', 'failed'];
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
    console.log('   POST   /prizes          → store a new prize');
    console.log('   GET    /prizes?user_id= → get user prizes');
    console.log('   GET    /prizes/:id      → get one prize');
    console.log('   PATCH  /prizes/:id      → update status');
    console.log('   DELETE /prizes/:id      → remove claimed prize');
    console.log('   PUT    /users/:id       → upsert profile/balances');
    console.log('   GET    /leaderboard     → top coins/stars/gifts + your rank');
    console.log('═══════════════════════════════════════════');
  });
}

start();
