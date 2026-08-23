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
];

describe('provider union is widened everywhere it is re-declared', () => {
  for (const rel of FILES) {
    it(`${rel} does not enumerate only anthropic and openai`, () => {
      const src = readFileSync(resolve(here, rel), 'utf8');
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
