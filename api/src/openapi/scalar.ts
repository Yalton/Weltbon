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
