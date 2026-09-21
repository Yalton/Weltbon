// (web parses it in MapCanvas RoutePolyline). Without server-side structure
// import-json.ts) so both unprivileged-input surfaces validate identically.

export const ROUTE_POINTS_ERROR =
  'points must be a non-empty JSON array of {x,y} numbers in [0,1]';

export const isValidRoutePoints = (raw: string): boolean => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return false;
  return parsed.every((pt) => {
    if (typeof pt !== 'object' || pt === null) return false;
    const { x, y } = pt as { x?: unknown; y?: unknown };
    return (
      typeof x === 'number' &&
      typeof y === 'number' &&
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      x >= 0 &&
      x <= 1 &&
      y >= 0 &&
      y <= 1
    );
  });
};
