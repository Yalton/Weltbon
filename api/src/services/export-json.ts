// Compatibility re-export. The implementation moved to ./export/json.ts so
// the four Phase 4 exporters can share `loadUniverseExportPayload`. Existing
// imports from `services/export-json.js` continue to resolve here unchanged.
export { exportUniverseJson } from './export/json.js';
