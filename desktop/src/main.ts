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
  // apiEntry is always <apiRoot>/dist/index.js (the WELTBON_API_ENTRY escape
  // hatch included — see the DRIZZLE_DIR comment below), so apiRoot is two
  // directories up.
  const apiRoot = dirname(dirname(apiEntry));

  // Failures after main() resolves (a window navigation error, a renderer
  // crash) would otherwise leave a blank, unexplained window — the exact
  // failure mode this file's main().catch() dialog already exists to avoid
  // for startup failures. Cover the post-startup cases too.
  process.on('unhandledRejection', (err) => {
    console.error('[weltbon] unhandled rejection:', err);
    dialog.showErrorBox(
      'Weltbon encountered an unexpected error',
      err instanceof Error ? (err.stack ?? err.message) : String(err)
    );
  });

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
    // Review round 1, Finding 1 (SECURITY): with WELTBON_PUBLIC_ORIGIN unset,
    // index.ts's cors() reflects ANY Origin with credentials: true. The
    // loopback bind above does not stop this — the attacker page runs in the
    // user's OWN browser, which is already loopback. A page at evil.example
    // can POST /api/auth/local-session, read the token cross-origin out of
    // the response body (it is not cookie-only), and use it as a bearer
    // token against every route. 'http://127.0.0.1' (no port) is a value a
    // real browser Origin header can NEVER equal — Origin always carries the
    // port — so cors() never reflects any actual Origin, blocking cross-
    // origin reads while leaving the same-origin SPA's own fetches
    // untouched (the Same-Origin Policy does not gate same-origin requests
    // on CORS response headers at all).
    process.env.WELTBON_PUBLIC_ORIGIN = 'http://127.0.0.1';
    // Review round 1, Finding 3: api/src/db/migrate.ts's migrationsFolder
    // and services/sync/handshake.ts's migrationHead() both resolve
    // './drizzle' against process.cwd() by default — fine in Docker, where
    // WORKDIR /app happens to be the api root, but Electron's cwd has no
    // such guarantee. DRIZZLE_DIR is the override mechanism handshake.ts
    // already defines; migrate.ts now reads it too (both call sites fixed
    // by one env var, no process.chdir() needed — chdir cannot enter a
    // future asar-packaged app/ and, unlike this var, would have silently
    // tracked apiEntry's directory even when WELTBON_API_ENTRY points
    // somewhere not shaped <root>/dist/index.js).
    process.env.DRIZZLE_DIR = join(apiRoot, 'drizzle');
    delete process.env.DATABASE_URL;          // must never reach a real Postgres

    const { startServer } = await import(pathToFileURL(apiEntry).href);
    const { port } = await startServer();

    mainWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      console.error('[weltbon] did-fail-load:', errorCode, errorDescription, validatedURL);
      dialog.showErrorBox(
        'Weltbon failed to load',
        `${errorDescription} (${errorCode})\nURL: ${validatedURL}`
      );
    });
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      console.error('[weltbon] render-process-gone:', details);
      dialog.showErrorBox(
        'Weltbon crashed',
        `The window's renderer process exited unexpectedly: ${details.reason}`
      );
    });
    await mainWindow.loadURL(`http://127.0.0.1:${port}`);
  }

  main().catch((err) => {
    // In Docker a boot failure prints to stderr and the container dies loudly.
    // In Electron it produces a BLANK WINDOW and no explanation, which is the
    // most likely first-run failure and the least self-explanatory. Say what
    // happened and where the data lives.
    //
    // console.error too, not just the dialog: twice during this task's own
    // development, a failure here surfaced as an unresponsive modal with no
    // visible content in this sandbox's display server, and nothing in the
    // terminal explained why — a log line is the only thing that actually
    // told us what had gone wrong.
    console.error('[weltbon] startup failed:', err);
    dialog.showErrorBox(
      'Weltbon could not start',
      `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n\n` +
        `Data directory: ${app.getPath('userData')}`
    );
    app.quit();
  });

  app.on('window-all-closed', () => { app.quit(); });
}
