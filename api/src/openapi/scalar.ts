/**
 * Scalar API reference HTML page for /api/docs.
 *
 * D-06: Uses Scalar (MIT-licensed) served via CDN at:
 *   https://cdn.jsdelivr.net/npm/@scalar/api-reference
 * T-10-03 (accepted risk): CDN script is operator-facing only, same trust level as other
 *   CDN-loaded assets in the project. Operators who want supply-chain isolation can
 *   self-host by downloading @scalar/api-reference and updating the src URL here.
 *
 * D-07: Mounted as a Hono GET route — NOT via SPA static fallback — so /api/docs
 *   resolves consistently regardless of React Router state.
 */
export const scalarHtml = `<!doctype html>
<html lang="en">
  <head>
    <title>Weltbon API Reference</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <!-- D-08: data-url points to /api/openapi.json (same /api prefix) -->
    <script
      id="api-reference"
      data-url="/api/openapi.json"
      data-configuration='{"theme":"default","hideClientButton":false}'
    ></script>
    <!-- T-10-03: CDN URL is https://cdn.jsdelivr.net/npm/@scalar/api-reference -->
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>
`;
