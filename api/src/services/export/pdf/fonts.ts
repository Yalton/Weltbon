import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
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

export async function buildFontFaceBlock(): Promise<string> {
  const decls: string[] = [];

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
        // bloat the HTML). render.ts adds --allow-file-access-from-files so
        decls.push(
          `@font-face { font-family: '${spec.family}'; src: url(file://${fullPath}) format('woff2'); }`,
        );
      }
    } catch {
      // eslint-disable-next-line no-console
      console.warn(`[export/pdf] font missing or unreadable: ${spec.file}`);
    }
  }

  return decls.join('\n');
}
