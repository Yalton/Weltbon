/**
 * diagramExport — pure JSON serialize/parse for Export JSON + import round-trip.
 *
 * DIAGRAM-03 requirement.
 *
 * Threat T-31-05: parseDiagram validates shape without eval/dangerouslySetInnerHTML.
 * Content is opaque data; the canvas wave renders it as SVG text with escaping.
 *
 * No React, no DOM, no I/O. Pure data transforms.
 *
 * Export JSON shape:
 *   { version: 1, diagram: DiagramMeta, nodes: DiagramNode[], edges: DiagramEdge[] }
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** Diagram-level metadata. */
export interface DiagramMeta {
  id: string;
  name: string;
  description?: string;
}

/** A node in the diagram (entry placed at a position). */
export interface DiagramNode {
  id: string;
  entryId: string;
  x: number;
  y: number;
  [key: string]: unknown; // allow extra fields to pass through
}

/** An edge in the diagram (styled relation between two nodes). */
export interface DiagramEdge {
  id: string;
  source: string;
  target: string;
  label: string | null;
  lineStyle: 'solid' | 'dashed' | 'dotted';
  color: string;
  [key: string]: unknown; // allow extra fields to pass through
}

/** The serialized payload shape (version 1). */
export interface SerializedDiagram {
  version: 1;
  diagram: DiagramMeta;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

// ─── serializeDiagram ─────────────────────────────────────────────────────────

/**
 * Serializes a diagram to a plain JSON-stringifiable object.
 *
 * Returns `{ version: 1, diagram, nodes, edges }`.
 * The actual file download (URL.createObjectURL + anchor click) is wired in
 * the editor wave — this function is pure data transformation only.
 */
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

// ─── parseDiagram ─────────────────────────────────────────────────────────────

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

  // Version check
  if (raw['version'] !== 1) return null;

  // Diagram metadata required
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

  // Nodes — normalize to empty array if absent or not an array
  const nodes: DiagramNode[] = Array.isArray(raw['nodes'])
    ? (raw['nodes'] as DiagramNode[])
    : [];

  // Edges — normalize to empty array if absent or not an array
  const edges: DiagramEdge[] = Array.isArray(raw['edges'])
    ? (raw['edges'] as DiagramEdge[])
    : [];

  return { version: 1, diagram, nodes, edges };
}
