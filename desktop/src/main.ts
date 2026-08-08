import { app, BrowserWindow, dialog } from 'electron';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadOrCreateSecrets, secretsPath } from './secrets.js';

// DV-15: two processes over one PGlite directory is the corruption case.
// Must run before anything touches the data dir.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  const apiEntry = process.env.WELTBON_API_ENTRY
    ?? join(app.getAppPath(), '..', 'api', 'dist', 'index.js');
  const webDist = process.env.WELTBON_WEB_DIST_OVERRIDE
    ?? join(app.getAppPath(), '..', 'api', 'web-dist');

  async function main(): Promise<void> {
    await app.whenReady();

    const userData = app.getPath('userData');
    const secrets = await loadOrCreateSecrets(secretsPath(userData));

    // MUST be set before the API module is imported: api/src/index.ts calls
    // env() at module scope, so a static import would capture an empty config.
    process.env.WELTBON_DB_DRIVER = 'pglite';
    process.env.WELTBON_DATA_DIR = join(userData, 'db');
    process.env.UPLOADS_DIR = join(userData, 'uploads');
    process.env.WELTBON_LOCAL_MODE = '1';
    process.env.WELTBON_WEB_DIST = webDist;   // absolute: serveStatic is cwd-relative
    process.env.JWT_SECRET = secrets.jwtSecret;
    process.env.LLM_KEY_ENCRYPTION_KEY = secrets.llmKeyEncryptionKey;
    process.env.PORT = '0';                   // kernel picks; startServer reports it
    // Task 3 security review: with no hostname, @hono/node-server binds ALL
    // interfaces. That is fine for the Docker container (its published port
    // must be reachable from the host) but unacceptable here — this API mints
    // credential-free local sessions and must never be reachable from the LAN.
    process.env.WELTBON_BIND_HOST = '127.0.0.1';
    delete process.env.DATABASE_URL;          // must never reach a real Postgres

    // api/src/db/migrate.ts passes drizzle-orm `migrationsFolder: './drizzle'`
    // — cwd-relative, exactly like serveStatic's root above. In the Docker
    // image cwd is WORKDIR /app, which IS the api root, so it resolves by
    // accident; Electron's cwd is wherever the OS launched the app from, so
    // './drizzle' resolves to nothing and startServer() throws "Can't find
    // meta/_journal.json file" before a window ever appears. There is no env
    // var to redirect drizzle's migrator (unlike WELTBON_WEB_DIST above), so
    // the fix is to make cwd match what Docker already relies on: the
    // directory containing dist/, drizzle/, and (after Step 5) web-dist/.
    process.chdir(dirname(dirname(apiEntry)));

    const { startServer } = await import(pathToFileURL(apiEntry).href);
    const { port } = await startServer();

    mainWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    await mainWindow.loadURL(`http://127.0.0.1:${port}`);
  }

  main().catch((err) => {
    // In Docker a boot failure prints to stderr and the container dies loudly.
    // In Electron it produces a BLANK WINDOW and no explanation, which is the
    // most likely first-run failure and the least self-explanatory. Say what
    // happened and where the data lives.
    dialog.showErrorBox(
      'Weltbon could not start',
      `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n\n` +
        `Data directory: ${app.getPath('userData')}`
    );
    app.quit();
  });

  app.on('window-all-closed', () => { app.quit(); });
}
