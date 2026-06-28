/**
 * NovaBit Exchange — Migration Runner
 *
 * Reads SQL migration files from src/db/migrations/ and applies them
 * in order. Usage: `tsx src/db/migrate.ts [up|down|reset|status]`
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');
const MIGRATIONS_TABLE = 'schema_migrations';

const command = process.argv[2] ?? 'up';

async function getClient() {
  const { config } = await import('../config/index.js');
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  return client;
}

async function ensureMigrationsTable(client: pg.Client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      version INTEGER PRIMARY KEY,
      name    VARCHAR(255) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      checksum VARCHAR(64) NOT NULL
    )
  `);
}

function getChecksum(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const chr = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16);
}

interface Migration {
  version: number;
  name: string;
  filename: string;
  content: string;
  checksum: string;
}

function getMigrations(): Migration[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  return files.map((filename) => {
    const match = filename.match(/^(\d+)_(.+)\.sql$/);
    if (!match) throw new Error(`Invalid migration filename: ${filename}`);
    const content = readFileSync(join(MIGRATIONS_DIR, filename), 'utf-8');
    return {
      version: parseInt(match[1], 10),
      name: match[2],
      filename,
      content,
      checksum: getChecksum(content),
    };
  });
}

async function status(client: pg.Client): Promise<void> {
  await ensureMigrationsTable(client);
  const { rows: applied } = await client.query(
    `SELECT * FROM ${MIGRATIONS_TABLE} ORDER BY version`,
  );
  const migrations = getMigrations();

  console.log('\n📋 Migration Status:\n');
  for (const m of migrations) {
    const appliedRecord = applied.find((r: { version: number }) => r.version === m.version);
    const status = appliedRecord ? '✅' : '⏳';
    const checksumOk =
      appliedRecord && appliedRecord.checksum === m.checksum ? '' : ' (checksum changed!)';
    console.log(`  ${status} [${m.version}] ${m.name}${checksumOk}`);
  }
  console.log(
    `\n  ${applied.length}/${migrations.length} migrations applied\n`,
  );
}

async function up(client: pg.Client): Promise<void> {
  await ensureMigrationsTable(client);
  const migrations = getMigrations();

  for (const m of migrations) {
    const { rows } = await client.query(
      `SELECT version FROM ${MIGRATIONS_TABLE} WHERE version = $1`,
      [m.version],
    );
    if (rows.length > 0) {
      console.log(`  ⏭️  [${m.version}] ${m.name} — already applied`);
      continue;
    }

    console.log(`  🔼 [${m.version}] ${m.name} — applying...`);
    try {
      await client.query(m.content);
      await client.query(
        `INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum) VALUES ($1, $2, $3)`,
        [m.version, m.name, m.checksum],
      );
      console.log(`  ✅ [${m.version}] ${m.name} — applied`);
    } catch (err) {
      console.error(`  ❌ [${m.version}] ${m.name} — failed:`, err);
      throw err;
    }
  }
}

async function down(client: pg.Client): Promise<void> {
  // Note: Full reversal requires writing down migrations.
  // For now, this removes the last applied migration record
  // (schema changes must be reversed manually or via a proper down migration).
  await ensureMigrationsTable(client);
  const { rows } = await client.query(
    `SELECT * FROM ${MIGRATIONS_TABLE} ORDER BY version DESC LIMIT 1`,
  );
  if (rows.length === 0) {
    console.log('  ℹ️  No migrations to revert.');
    return;
  }
  const last = rows[0];
  console.log(`  🔽 [${last.version}] ${last.name} — reverting (record only)`);
  await client.query(`DELETE FROM ${MIGRATIONS_TABLE} WHERE version = $1`, [last.version]);
  console.log(`  ✅ Reverted migration record [${last.version}]`);
  console.log('  ⚠️  SQL schema changes must be reverted manually.');
}

async function reset(client: pg.Client): Promise<void> {
  console.log('  🔄 Resetting all migrations...');
  await client.query(`DROP TABLE IF EXISTS ${MIGRATIONS_TABLE} CASCADE`);
  console.log('  ✅ Migrations table dropped. Run `up` to re-apply.');
}

async function main() {
  const client = await getClient();
  try {
    switch (command) {
      case 'status':
        await status(client);
        break;
      case 'up':
        await up(client);
        break;
      case 'down':
        await down(client);
        break;
      case 'reset':
        await reset(client);
        break;
      default:
        console.error(`Unknown command: ${command}. Use: up, down, reset, status`);
        process.exit(1);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});