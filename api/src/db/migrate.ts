import { env } from '../config.js';
import { initDb, closeDb, type AppDatabase } from './client.js';

/**
 * Apply the migration chain using the migrator that matches the active driver
 * (DV-07). Exported so tests can drive it without spawning a process.
 *
 * The two migrators are imported dynamically so that a pglite-only deployment
 * never loads the node-postgres one and vice versa.
 */
export async function runMigrations(database: AppDatabase): Promise<void> {
  if (env().dbDriver === 'pglite') {
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    // Same cast rationale as AppDatabase in client.ts: the runtime handle IS a
    // PgliteDatabase, only the declared type is unified.
    await migrate(database as never, { migrationsFolder: './drizzle' });
    return;
  }
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  await migrate(database, { migrationsFolder: './drizzle' });
}

async function main() {
  const database = await initDb();
  await runMigrations(database);
  await closeDb();
  console.log('Migrations applied');
}

// Only run when executed directly, so importing this module in a test does not
// migrate and exit the process.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
