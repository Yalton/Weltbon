

export interface DiagramMeta {
  id: string;
  name: string;
  description?: string;
}

export interface DiagramNode {
  id: string;
  entryId: string;
  x: number;
  y: number;
  [key: string]: unknown; // allow extra fields to pass through
}

export interface DiagramEdge {
  id: string;
  source: string;
  target: string;
  label: string | null;
  lineStyle: 'solid' | 'dashed' | 'dotted';
  color: string;
  [key: string]: unknown; // allow extra fields to pass through
}

export interface SerializedDiagram {
  version: 1;
  diagram: DiagramMeta;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}


export function serializeDiagram(
  diagram: DiagramMeta,
  nodes: DiagramNode[],
  edges: DiagramEdge[],
): SerializedDiagram {
  return {
    version: 1,
    diagram: { ...diagram },
    nodes: nodes.map((n) => ({ ...n })),
    edges: edges.map((e) => ({ ...e })),
  };
}


/**
 * Validates and normalizes an untrusted parsed-JSON payload.
 *
 * Returns a `SerializedDiagram` if the payload is well-formed (or normalizable),
 * or `null` if it cannot be recovered (e.g. completely missing required fields).
 *
 * Shape validation rules (Threat T-31-05 — never eval, never dangerouslySetInnerHTML):
 *   - Must have `version === 1`.
 *   - Must have a `diagram` object with `id` and `name` strings.
 *   - `nodes` and `edges` are normalized to empty arrays if absent.
 *   - Individual node/edge fields are preserved as-is (the editor wave is
 *     responsible for runtime type coercion on load).
 */
export function parseDiagram(obj: unknown): SerializedDiagram | null {
  if (!obj || typeof obj !== 'object') return null;

  const raw = obj as Record<string, unknown>;

  if (raw['version'] !== 1) return null;

  const diagramRaw = raw['diagram'];
  if (!diagramRaw || typeof diagramRaw !== 'object') return null;
  const diagramObj = diagramRaw as Record<string, unknown>;
  if (typeof diagramObj['id'] !== 'string' || typeof diagramObj['name'] !== 'string') {
    return null;
  }

  const diagram: DiagramMeta = {
    id: diagramObj['id'] as string,
    name: diagramObj['name'] as string,
    ...(typeof diagramObj['description'] === 'string'
      ? { description: diagramObj['description'] }
      : {}),
  };

  const nodes: DiagramNode[] = Array.isArray(raw['nodes'])
    ? (raw['nodes'] as DiagramNode[])
    : [];

  const edges: DiagramEdge[] = Array.isArray(raw['edges'])
    ? (raw['edges'] as DiagramEdge[])
    : [];

  return { version: 1, diagram, nodes, edges };
}
