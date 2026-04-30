/**
 * A 32-bit Linear Congruential Generator (LCG) using Numerical Recipes constants.
 *
 * Algorithm: seed = (seed * 1664525 + 1013904223) >>> 0
 * Returns values in [0, 1).
 *
 * The canonical seed for the ambient background is 0x57454c54 ("WELT" in ASCII).
 * Per UI-SPEC §6.2: deterministic seed enables identical static frames under
 * prefers-reduced-motion: reduce across all reloads.
 */
export function createLcg(seed: number): () => number {
  let state = seed >>> 0; // ensure 32-bit unsigned
  return function (): number {
    state = Math.imul(state, 1664525) + 1013904223 >>> 0;
    return state / 0x100000000;
  };
}
