import { app, BrowserWindow, dialog } from 'electron';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { loadOrCreateSecrets, secretsPath } from './secrets.js';
import { exportBuildInfoEnv } from './build-info.js';

// DV-15: two processes over one PGlite directory is the corruption case.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;
  const SHUTDOWN_TIMEOUT_MS = 5_000;



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
  const apiRoot = dirname(dirname(apiEntry));

  // This handler is process-wide. Once startServer() imports the API module
  // in-process, it also catches
  // not just this file's own post-startup failures. A synchronous dialog
  // here would block the main process on an API-internal promise rejection
  // suppress Node's default crash-on-unhandled-rejection behavior for that
  process.on('unhandledRejection', (err) => {
    console.error('[weltbon] unhandled rejection:', err);
  });

  async function main(): Promise<void> {
    await app.whenReady();

    const userData = app.getPath('userData');
    const secrets = await loadOrCreateSecrets(secretsPath(userData));

    process.env.WELTBON_DB_DRIVER = 'pglite';
    process.env.WELTBON_DATA_DIR = join(userData, 'db');
    process.env.UPLOADS_DIR = join(userData, 'uploads');
    process.env.WELTBON_LOCAL_MODE = '1';
    process.env.WELTBON_WEB_DIST = webDist;   // absolute: serveStatic is cwd-relative
    process.env.JWT_SECRET = secrets.jwtSecret;
    process.env.LLM_KEY_ENCRYPTION_KEY = secrets.llmKeyEncryptionKey;
    process.env.PORT = '0';                   // kernel picks; startServer reports it
    // With no hostname, @hono/node-server binds all interfaces. That is fine for the Docker container (its published port
    // credential-free local sessions and must never be reachable from the LAN.
    process.env.WELTBON_BIND_HOST = '127.0.0.1';
    // can POST /api/auth/local-session, read the token cross-origin out of
    // the response body (it is not cookie-only), and use it as a bearer
    // (browsers omit the default port), so any other locally-hosted app on
    process.env.WELTBON_PUBLIC_ORIGIN = 'http://weltbon.invalid';
    // future asar-packaged app/ and, unlike this var, would have silently
    process.env.DRIZZLE_DIR = join(apiRoot, 'drizzle');
    process.env.WELTBON_FONT_DIR = join(apiRoot, 'assets', 'fonts');
    delete process.env.DATABASE_URL;          // must never reach a real Postgres

    // writes <apiRoot>/version.json; see build-info.ts for why this is a file
    // read at boot rather than an esbuild --define at stage time. A dev run has
    const buildInfo = exportBuildInfoEnv(apiRoot);
    if (buildInfo) {
      console.log(`[weltbon] build ${buildInfo.version}${buildInfo.commit ? ` (${buildInfo.commit})` : ''}`);
    }

    const { startServer, closeDb } = await import(pathToFileURL(apiEntry).href);
    const { port } = await startServer();

    // so `wireSigtermDrain` (api/src/services/audit-shutdown.ts) never fires,
    // do), so it closes the module-scope PGlite handle this process's own
    let closing: Promise<void> | null = null;
    app.on('before-quit', (event) => {
      if (closing) return; // already closing (or closed) — do not double-close
      event.preventDefault();
      closing = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          // HANG was not — and closeDb() first awaits any in-flight initDb()
          await Promise.race([
            closeDb(),
            new Promise<void>((resolve) => {
              timer = setTimeout(() => {
                console.error(
                  `[weltbon] closeDb() did not settle within ${SHUTDOWN_TIMEOUT_MS}ms — quitting anyway. ` +
                  'PGlite will recover from its WAL on the next launch.'
                );
                resolve();
              }, SHUTDOWN_TIMEOUT_MS);
              timer.unref?.();
            }),
          ]);
        } catch (err) {
          console.error('[weltbon] closeDb() failed during shutdown:', err);
        } finally {
          if (timer) clearTimeout(timer);
          app.quit();
        }
      })();
    });

    mainWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // Restrict the blocking native modal to meaningful main-frame failures.
      // (-3), which Chromium fires routinely for a navigation superseded by
      if (!isMainFrame || errorCode === -3) return;
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

    // sandboxed Wayland session has no working OS-level screenshot path (X11
    // `import` fails; the GNOME D-Bus screenshot portal returns
    // entirely IN-PROCESS over Electron's own compositor and CDP — no
    // here. Opt-in only, via env vars an ordinary user never sets, so none
    if (process.env.WELTBON_DESKTOP_CAPTURE || process.env.WELTBON_DESKTOP_CAPTURE_TEXT) {
      // instant loadURL() resolves — which is 'did-finish-load', i.e. the
      // painted anything. Poll for a steady, logged-in state (no login form
      const steadyDeadline = Date.now() + 15_000;
      let steadyState: { hasLoginForm: boolean; text: string } | null = null;
      for (;;) {
        const state: { hasLoginForm: boolean; text: string } = await mainWindow.webContents.executeJavaScript(
          `({ hasLoginForm: !!document.querySelector('#email'), text: document.body.innerText.slice(0, 300) })`
        );
        // "Loading..." is real non-empty body text too (the isLoading branch
        // bare non-empty check while telling us nothing about whether the
        const trimmed = state.text.trim();
        if (!state.hasLoginForm && trimmed.length > 0 && !/^Loading/i.test(trimmed)) {
          steadyState = state;
          break;
        }
        if (Date.now() >= steadyDeadline) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (!steadyState) {
        console.error('[weltbon] capture: UI never reached a steady, logged-in state within 15s');
      } else if (process.env.WELTBON_DESKTOP_CAPTURE_TEXT) {
        console.log('[weltbon] capture text:', JSON.stringify(steadyState.text));
        console.log('[weltbon] capture hasLoginForm:', steadyState.hasLoginForm);
      }
      if (process.env.WELTBON_DESKTOP_CAPTURE) {
        const image = await mainWindow.webContents.capturePage();
        const size = image.getSize();
        const png = image.toPNG();
        await writeFile(process.env.WELTBON_DESKTOP_CAPTURE, png);
        console.log(
          `[weltbon] capture: wrote ${process.env.WELTBON_DESKTOP_CAPTURE} (${size.width}x${size.height}, ${png.length} bytes)`
        );
      }
    }
  }

  main().catch((err) => {
    // most likely first-run failure and the least self-explanatory. Say what
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
