import { describe, it, expect } from 'vitest';
import { serializeDiagram, parseDiagram } from './diagramExport';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const META = { id: 'diag-001', name: 'Targaryen family tree', description: 'Test diagram' };

interface TestNode {
  id: string;
  entryId: string;
  x: number;
  y: number;
}

interface TestEdge {
  id: string;
  source: string;
  target: string;
  label: string | null;
  lineStyle: 'solid' | 'dashed' | 'dotted';
  color: string;
}

const NODES: TestNode[] = [
  { id: 'node-1', entryId: 'entry-a', x: 100, y: 200 },
  { id: 'node-2', entryId: 'entry-b', x: 300, y: 400 },
];

const EDGES: TestEdge[] = [
  { id: 'edge-1', source: 'node-1', target: 'node-2', label: 'parent', lineStyle: 'solid', color: '#6b7280' },
  { id: 'edge-2', source: 'node-2', target: 'node-1', label: null, lineStyle: 'dashed', color: '#3b82f6' },
];

// ─── serializeDiagram ────────────────────────────────────────────────────────

describe('serializeDiagram', () => {
  it('returns a plain object (JSON-stringifiable)', () => {
    const result = serializeDiagram(META, NODES, EDGES);
    // Must serialize to JSON without throwing
    expect(() => JSON.stringify(result)).not.toThrow();
    // Must be a plain object, not a class instance
    expect(typeof result).toBe('object');
    expect(result).not.toBeNull();
  });

  it('includes version: 1 at the top level', () => {
    const result = serializeDiagram(META, NODES, EDGES);
    expect(result.version).toBe(1);
  });

  it('includes diagram metadata (id, name, description)', () => {
    const result = serializeDiagram(META, NODES, EDGES);
    expect(result.diagram).toEqual(META);
  });

  it('includes nodes array', () => {
    const result = serializeDiagram(META, NODES, EDGES);
    expect(Array.isArray(result.nodes)).toBe(true);
    expect(result.nodes).toHaveLength(2);
  });

  it('includes edges array', () => {
    const result = serializeDiagram(META, NODES, EDGES);
    expect(Array.isArray(result.edges)).toBe(true);
    expect(result.edges).toHaveLength(2);
  });
});

// ─── parseDiagram ────────────────────────────────────────────────────────────

describe('parseDiagram', () => {
  it('accepts a well-formed serialized object and returns the structure', () => {
    const serialized = serializeDiagram(META, NODES, EDGES);
    const parsed = parseDiagram(serialized);
    expect(parsed).not.toBeNull();
    expect(parsed!.version).toBe(1);
  });

  it('returns null (or normalized) for missing nodes array', () => {
    const malformed = { version: 1, diagram: META, edges: [] };
    // Should not throw; return null or a normalized structure
    expect(() => parseDiagram(malformed)).not.toThrow();
    const result = parseDiagram(malformed);
    // Either null (rejected) or normalized with empty nodes
    if (result !== null) {
      expect(Array.isArray(result.nodes)).toBe(true);
    }
  });

  it('returns null (or normalized) for missing edges array', () => {
    const malformed = { version: 1, diagram: META, nodes: [] };
    expect(() => parseDiagram(malformed)).not.toThrow();
    const result = parseDiagram(malformed);
    if (result !== null) {
      expect(Array.isArray(result.edges)).toBe(true);
    }
  });

  it('accepts a well-formed-but-empty diagram without throwing', () => {
    const empty = serializeDiagram(META, [], []);
    expect(() => parseDiagram(empty)).not.toThrow();
    const result = parseDiagram(empty);
    expect(result).not.toBeNull();
    expect(result!.nodes).toHaveLength(0);
    expect(result!.edges).toHaveLength(0);
  });
});

// ─── Round-trip ───────────────────────────────────────────────────────────────

describe('serializeDiagram + parseDiagram round-trip', () => {
  it('round-trips to a deep-equal structure through JSON.stringify + JSON.parse', () => {
    const serialized = serializeDiagram(META, NODES, EDGES);
    const jsonCopy = JSON.parse(JSON.stringify(serialized));
    const parsed = parseDiagram(jsonCopy);
    expect(parsed).not.toBeNull();
    // The parsed structure should equal the serialized input
    expect(parsed).toEqual(serialized);
  });

  it('preserves edge style fields (lineStyle, color) through the round-trip', () => {
    const serialized = serializeDiagram(META, NODES, EDGES);
    const parsed = parseDiagram(JSON.parse(JSON.stringify(serialized)))!;
    expect(parsed.edges[0].lineStyle).toBe('solid');
    expect(parsed.edges[0].color).toBe('#6b7280');
    expect(parsed.edges[1].lineStyle).toBe('dashed');
    expect(parsed.edges[1].color).toBe('#3b82f6');
  });

  it('preserves null edge label through the round-trip', () => {
    const serialized = serializeDiagram(META, NODES, EDGES);
    const parsed = parseDiagram(JSON.parse(JSON.stringify(serialized)))!;
    // EDGES[1].label is null
    expect(parsed.edges[1].label).toBeNull();
  });

  it('preserves non-null edge label through the round-trip', () => {
    const serialized = serializeDiagram(META, NODES, EDGES);
    const parsed = parseDiagram(JSON.parse(JSON.stringify(serialized)))!;
    // EDGES[0].label is 'parent'
    expect(parsed.edges[0].label).toBe('parent');
  });

  it('preserves node positions through the round-trip', () => {
    const serialized = serializeDiagram(META, NODES, EDGES);
    const parsed = parseDiagram(JSON.parse(JSON.stringify(serialized)))!;
    expect(parsed.nodes[0].x).toBe(100);
    expect(parsed.nodes[0].y).toBe(200);
    expect(parsed.nodes[1].x).toBe(300);
    expect(parsed.nodes[1].y).toBe(400);
  });
});
