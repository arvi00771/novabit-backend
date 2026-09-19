/**
 * NovaBit Exchange — Test/Demo Seeder for PostgreSQL
 *
 * Idempotently seeds the demo admin user (arvi00772@gmail.com / Test1234!) and
 * their wallets into a PostgreSQL database. This exists so CI can exercise the
 * real PostgreSQL path (migrate → seed → test) instead of the SQLite adapter.
 *
 * Safety: refuses to run unless NODE_ENV=test — it seeds a known-password demo
 * user and must NEVER run against a production database.
 *
 * Usage: NODE_ENV=test DATABASE_URL=... tsx src/db/seed-test.ts
 */
import pg from 'pg';
import bcrypt from 'bcryptjs';

const DEMO_EMAIL = 'arvi00772@gmail.com';
const DEMO_PASSWORD = 'Test1234!';

async function main() {
  if (process.env.NODE_ENV !== 'test') {
    console.error(
      '❌ seed-test refuses to run: NODE_ENV must be "test". This seeder creates a ' +
      'known-password demo ADMIN user and must never run against production.',
    );
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('❌ seed-test requires DATABASE_URL (PostgreSQL).');
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const now = new Date();
    const hash = bcrypt.hashSync(DEMO_PASSWORD, 10);

    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, role, kyc_status, is_active, created_at, updated_at)
       VALUES ($1, $2, 'ADMIN', 'UNVERIFIED', TRUE, $3, $3)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [DEMO_EMAIL, hash, now],
    );
    let userId = rows[0]?.id;
    if (!userId) {
      const existing = await pool.query(`SELECT id FROM users WHERE email = $1`, [DEMO_EMAIL]);
      userId = existing.rows[0].id;
    }
    // Wallets (idempotent via the (user_id, asset, wallet_type) unique constraint)
    const wallets: Array<[string, string]> = [
      ['BTC', '5.0'],
      ['ETH', '100.0'],
      ['USDT', '500000.0'],
    ];
    for (const [asset, balance] of wallets) {
      await pool.query(
        `INSERT INTO wallets (user_id, asset, balance, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT (user_id, asset, wallet_type) DO NOTHING`,
        [userId, asset, balance, now],
      );
    }
    console.log(
      `[seed-test] Demo user ensured: ${DEMO_EMAIL} (id=${userId}) with ${wallets.length} wallets.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[seed-test] Failed:', err);
  process.exit(1);
});