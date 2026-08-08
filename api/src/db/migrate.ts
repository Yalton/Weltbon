import { pathToFileURL } from 'node:url';
import { env } from '../config.js';
import { initDb, closeDb, type AppDatabase } from './client.js';

/**
 * Apply the migration chain using the migrator that matches the active driver
 * (DV-07). Exported so tests can drive it without spawning a process.
 *
 * The two migrators are imported dynamically so that a pglite-only deployment
 * never loads the node-postgres one and vice versa.
 *
 * migrationsFolder defaults to './drizzle', resolved by drizzle-orm against
 * process.cwd() — matches the DRIZZLE_DIR fallback in
 * services/sync/handshake.ts's migrationHead(), the repo's existing
 * mechanism for redirecting this lookup. Docker's WORKDIR /app happens to
 * equal the api root, so the default resolves there without needing the
 * override; desktop/src/main.ts sets DRIZZLE_DIR to an absolute path
 * because Electron has no such cwd guarantee.
 */
export async function runMigrations(database: AppDatabase): Promise<void> {
  // WARNING: DRIZZLE_DIR is a process-global env var, and the integration
  // test lane runs DB-gated files with pool:'forks' + singleFork:true — one
  // process, many files in sequence. Today only tests/sync-handshake.test.ts
  // sets DRIZZLE_DIR, it's in the unit lane (no DB), and it always restores
  // the original value in afterEach, so nothing currently leaks across
  // files. A future DB-gated test that sets DRIZZLE_DIR without restoring it
  // would silently redirect every sibling test's runMigrations() call in
  // the same fork afterward.
  const migrationsFolder = process.env.DRIZZLE_DIR ?? './drizzle';
  if (env().dbDriver === 'pglite') {
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    // Same cast rationale as AppDatabase in client.ts: the runtime handle IS a
    // PgliteDatabase, only the declared type is unified.
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

// Only run when executed directly, so importing this module in a test does not
// migrate and exit the process. Uses pathToFileURL rather than a bare
// `file://${...}` template — the naive string comparison mismatches on paths
// with spaces, non-ASCII characters, or `%`, which would silently skip
// main() and exit 0. That looks like success to `set -e` in
// docker-entrypoint.sh, starting the API against an unmigrated database with
// a green healthcheck.
// `process.argv[1]` is undefined when this module is IMPORTED by a host that
// was not launched with a script path — most importantly a packaged Electron
// app, where argv[0] is the binary and there is no script argument. Calling
// pathToFileURL(undefined) throws ERR_INVALID_ARG_TYPE, which crashed the
// packaged desktop app at startup before the window ever appeared.
//
// Note the direction of that regression: the ORIGINAL string comparison
// (`import.meta.url === `file://${process.argv[1]}``) never threw — it
// evaluated to `file://undefined` and was correctly false. pathToFileURL was
// adopted to close a silent-mismatch class (spaces, non-ASCII, %), and in
// doing so converted a benign false into a crash in a context nothing tested.
// Keep both properties: exact URL comparison AND no throw when there is no
// script argument at all.
const entryArg = process.argv[1];
if (entryArg !== undefined && import.meta.url === pathToFileURL(entryArg).href) {
  main().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
