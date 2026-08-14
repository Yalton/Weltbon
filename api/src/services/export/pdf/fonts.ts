import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @font-face block builder for the PDF exporter (Plan 04-03).
 *
 * The exporter bundles four font families into `api/assets/fonts/`:
 *   - Inter (Regular, SemiBold, Bold) — body + headings
 *   - Noto Sans (Regular, Bold) — Latin Extended fallback
 *   - Noto Sans Symbols 2 (Regular) — misc Unicode (arrows, dingbats)
 *   - Noto Color Emoji (Regular) — colored emoji (CBDT-format woff2)
 *
 * Strategy (RESEARCH Pitfall 3 + Open Question 2):
 *   - Inline (data:font/woff2;base64) for the small Inter / Noto Sans /
 *     Symbols 2 files (~400 KB total → ~530 KB base64). Inlining sidesteps
 *     Chromium's `file://` security restrictions and avoids the
 *     `--allow-file-access-from-files` requirement for the Latin path.
 *   - file:// reference for Noto Color Emoji (10 MB woff2 → 13 MB base64
 *     would inflate the HTML payload painfully). The render.ts launch
 *     args include `--allow-file-access-from-files` specifically so this
 *     reference loads.
 *
 * Resilience: every font file is read with try/catch. Missing files are
 * SKIPPED with a stderr warning rather than crashing the exporter — the
 * test environment may not have the actual woff2 files committed; the
 * implementation tolerates that and degrades to system fallback fonts.
 *
 * Expected files in `api/assets/fonts/`:
 *   Inter-Regular.woff2
 *   Inter-SemiBold.woff2
 *   Inter-Bold.woff2
 *   NotoSans-Regular.woff2
 *   NotoSans-Bold.woff2
 *   NotoSansSymbols2-Regular.woff2
 *   NotoColorEmoji-Regular.woff2
 *
 * The user_setup field in 04-03-PLAN.md tells the operator to download
 * these from rsms.me/inter and fonts.google.com/noto.
 */

/**
 * Where the bundled woff2 files live.
 *
 * The default resolves `api/assets/fonts/` relative to this module, which works
 * from `src/` in dev and `dist/` in production because both sit at the same
 * depth below `api/`. That assumption breaks the moment the API is bundled: a
 * bundle collapses every module into one file at a different depth, and the
 * fixed `../../../../` walk then lands outside the packaged tree entirely.
 *
 * WELTBON_FONT_DIR is the escape hatch, exactly as DRIZZLE_DIR is for
 * migrations (`db/migrate.ts`) — the desktop app sets an absolute path because
 * Electron offers no useful cwd or module-layout guarantee.
 *
 * Read at CALL time rather than module load, matching DRIZZLE_DIR's idiom, so a
 * test or a late-configuring deployment is honoured. The same process-global
 * caveat applies: a test that sets it without restoring would redirect every
 * later call in the same worker.
 */
function fontDir(): string {
  const override = process.env.WELTBON_FONT_DIR;
  if (override) return override;
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../assets/fonts',
  );
}

interface FontSpec {
  family: string;
  weight?: number;
  file: string;
  mode: 'inline' | 'url';
}

const FONT_SPECS: FontSpec[] = [
  { family: 'Inter', weight: 400, file: 'Inter-Regular.woff2', mode: 'inline' },
  { family: 'Inter', weight: 600, file: 'Inter-SemiBold.woff2', mode: 'inline' },
  { family: 'Inter', weight: 700, file: 'Inter-Bold.woff2', mode: 'inline' },
  { family: 'Noto Sans', weight: 400, file: 'NotoSans-Regular.woff2', mode: 'inline' },
  { family: 'Noto Sans', weight: 700, file: 'NotoSans-Bold.woff2', mode: 'inline' },
  { family: 'Noto Sans Symbols 2', file: 'NotoSansSymbols2-Regular.woff2', mode: 'inline' },
  { family: 'Noto Color Emoji', file: 'NotoColorEmoji-Regular.woff2', mode: 'url' },
];

/**
 * Read each declared font from disk and emit @font-face declarations.
 *
 * Returns a `\n`-joined string of @font-face rules suitable to inject
 * inside a `<style>` tag in the PDF HTML template. When zero fonts are
 * found, returns an empty string and the rendered PDF will use Chromium's
 * default fonts. A stderr warning is logged for every missing file so
 * operators notice the gap during the first export attempt.
 */
export async function buildFontFaceBlock(): Promise<string> {
  const decls: string[] = [];

  // Resolved once per call, not per spec: one env read, and every font in a
  // single block comes from the same directory.
  const dir = fontDir();

  for (const spec of FONT_SPECS) {
    const fullPath = path.join(dir, spec.file);
    try {
      const stat = await fs.stat(fullPath);
      if (!stat.isFile()) continue;

      if (spec.mode === 'inline') {
        const buf = await fs.readFile(fullPath);
        const b64 = buf.toString('base64');
        const weight = spec.weight ? ` font-weight: ${spec.weight};` : '';
        decls.push(
          `@font-face { font-family: '${spec.family}';${weight} src: url(data:font/woff2;base64,${b64}) format('woff2'); }`,
        );
      } else {
        // file:// reference for Noto Color Emoji (huge file; inlining would
        // bloat the HTML). render.ts adds --allow-file-access-from-files so
        // Chromium's setContent() origin can load the file:// URL.
        decls.push(
          `@font-face { font-family: '${spec.family}'; src: url(file://${fullPath}) format('woff2'); }`,
        );
      }
    } catch {
      // Missing or unreadable font — skip this declaration. Stderr warning
      // makes the gap visible during the first export attempt.
      // eslint-disable-next-line no-console
      console.warn(`[export/pdf] font missing or unreadable: ${spec.file}`);
    }
  }

  return decls.join('\n');
}
