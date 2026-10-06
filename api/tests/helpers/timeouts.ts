/**
 * Per-test timeout for tests whose body does heavy one-off work on purpose:
 * a cold `import('../src/index.js')` after `vi.resetModules()` (transforms the
 * whole app module graph) or booting a PGlite instance (loads its WASM build).
 * Each takes 1-4s on an idle machine but 10-20s when the machine is busy, so
 * the default 10s testTimeout fails them for reasons unrelated to the code.
 */
export const COLD_START_TIMEOUT = 60_000;
