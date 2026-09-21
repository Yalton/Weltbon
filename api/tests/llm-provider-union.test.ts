import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The provider union is re-declared in many files rather than derived from one
 * place. This test is the derivation we do not have: if a file still enumerates
 * exactly the two original providers, it was missed, and the failure would
 * otherwise surface as a 400 from a route rather than anywhere near a provider.
 */
const FILES = [
  '../src/services/llm-key.ts',
  '../src/routes/universes.ts',
  '../src/routes/llm-keys.ts',
  '../src/routes/llm-models.ts',
  '../src/routes/audits.ts',
  '../src/services/audit-estimator.ts',
  '../src/scripts/list-provider-models.ts',
  '../../web/src/hooks/useUniverse.ts',

  // this list even though its `useListModels` union was widened by hand in

  // and stayed two-provider. That is precisely the pattern this test exists to
  // catch, so the file it happened in now gets checked. types/audit.ts joins it
  // for the same reason: `AuditEstimate.model.provider` echoes back whatever
  // provider was requested, 'ollama' included.
  '../../web/src/hooks/useAudits.ts',
  '../../web/src/types/audit.ts',
];


// KEY_PROVIDER_NAMES = ['anthropic', 'openai'] as const — the BYOK-key-only
// constant used by llm-keys.ts / llm-models.ts, which never gets an
// llm_api_keys row for 'ollama' and so must NOT advertise it. That is a
// deliberate, documented two-provider set, not a missed touchpoint, so the
// array-pattern check below must not flag it. Every other candidate line in
// the file (LlmProvider, PROVIDER_NAMES) is still checked at full strength —
// only this one named declaration is excluded, and only from THIS file.
const KEY_PROVIDER_NAMES_DECL = /export const KEY_PROVIDER_NAMES = \[[^\]]*\] as const;/;

describe('provider union is widened everywhere it is re-declared', () => {
  for (const rel of FILES) {
    it(`${rel} does not enumerate only anthropic and openai`, () => {
      const rawSrc = readFileSync(resolve(here, rel), 'utf8');
      const src =
        rel === '../src/services/llm-key.ts'
          ? rawSrc.replace(KEY_PROVIDER_NAMES_DECL, '/* KEY_PROVIDER_NAMES: allow-listed above */')
          : rawSrc;
      const twoOnly = [
        // Bug found while running Step 2 (task-2 brief): the brief's original
        // lookahead was `(?!\s*\|)`, which also blocks a match when the two
        // providers are followed by `| null` (e.g. useUniverse.ts's
        // `'anthropic' | 'openai' | null`) — not just by a third provider
        // literal. That let a genuinely unwidened nullable field pass. The
        // lookahead must only exclude a following quoted-string alternative
        // (`| 'ollama'`), not any `|` at all.
        /'anthropic'\s*\|\s*'openai'(?!\s*\|\s*')/,
        /\[\s*'anthropic'\s*,\s*'openai'\s*\]/,
      ];
      for (const re of twoOnly) {
        expect(re.test(src), `${rel} still has ${re}`).toBe(false);
      }
    });
  }
});
