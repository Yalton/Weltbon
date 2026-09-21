export function createLcg(seed: number): () => number {
  let state = seed >>> 0; // ensure 32-bit unsigned
  return function (): number {
    state = Math.imul(state, 1664525) + 1013904223 >>> 0;
    return state / 0x100000000;
  };
}
