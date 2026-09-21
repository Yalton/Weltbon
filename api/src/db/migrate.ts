import { pathToFileURL } from 'node:url';
import { env } from '../config.js';
import { initDb, closeDb, type AppDatabase } from './client.js';

export async function runMigrations(database: AppDatabase): Promise<void> {
  // WARNING: DRIZZLE_DIR is a process-global env var, and the integration
  // test lane runs DB-gated files with pool:'forks' + singleFork:true — one
  // process, many files in sequence. Today only tests/sync-handshake.test.ts
  // files. A future DB-gated test that sets DRIZZLE_DIR without restoring it
  const migrationsFolder = process.env.DRIZZLE_DIR ?? './drizzle';
  if (env().dbDriver === 'pglite') {
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    await migrate(database as never, { migrationsFolder });
    return;
  }
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  await migrate(database, { migrationsFolder });
}

async function main() {
  const database = await initDb();
  await runMigrations(database);
  await closeDb();
  console.log('Migrations applied');
}

// with spaces, non-ASCII characters, or `%`, which would silently skip
// main() and exit 0. That looks like success to `set -e` in
// docker-entrypoint.sh, starting the API against an unmigrated database with
// adopted to close a silent-mismatch class (spaces, non-ASCII, %), and in
const entryArg = process.argv[1];
if (entryArg !== undefined && import.meta.url === pathToFileURL(entryArg).href) {
  main().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
