

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
}

export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
  label: string | null;
}

export interface OrgChartLayoutOptions {
  hGap?: number;
  vGap?: number;
  startX?: number;
  startY?: number;
}


export const MANAGER_TERMS: ReadonlyArray<string> = [
  'manager',
  'reports to',
  'supervises',
  'manages',
  'subordinate',
  'lead',
  'leads',
  'head of',
] as const;

// Pre-computed lowercase set for O(1) lookup.
const MANAGER_TERMS_LOWER = new Set(MANAGER_TERMS.map((t) => t.toLowerCase()));


export function isManagerEdge(edge: LayoutEdge): boolean {
  if (!edge.label) return false;
  return MANAGER_TERMS_LOWER.has(edge.label.toLowerCase());
}


export function orgChartLayout(
  nodes: ReadonlyArray<LayoutNode>,
  edges: ReadonlyArray<LayoutEdge>,
  opts: OrgChartLayoutOptions = {},
): Map<string, { x: number; y: number }> {
  const { hGap = 120, vGap = 100, startX = 0, startY = 0 } = opts;

  // ── Step 1: Collect manager-edge children map and in-degree for layout ───────
  // children: manager nodeId → Set of subordinate nodeIds (based on manager-term edges)
  const children = new Map<string, Set<string>>();
  // parentCount: nodeId → number of incoming manager-term edges (for root detection)
  const parentCount = new Map<string, number>();

  for (const node of nodes) {
    if (!children.has(node.id)) children.set(node.id, new Set());
    if (!parentCount.has(node.id)) parentCount.set(node.id, 0);
  }

  for (const edge of edges) {
    if (!isManagerEdge(edge)) continue;
    const childSet = children.get(edge.source);
    if (childSet) {
      childSet.add(edge.target);
    }
    // Increment in-degree for the target (subordinate) — tracks how many managers
    // claim this node; used for root detection (in-degree === 0 means root).
    parentCount.set(edge.target, (parentCount.get(edge.target) ?? 0) + 1);
  }

  // ── Step 2: Identify roots (nodes with zero incoming manager-term edges) ──────
  const roots: string[] = [];
  for (const node of nodes) {
    if ((parentCount.get(node.id) ?? 0) === 0) {
      roots.push(node.id);
    }
  }

  // ── Step 3: BFS to assign depths — SINGLE-PARENT enforcement ────────────────
  const depth = new Map<string, number>();
  // visited set enforces single-parent: the first BFS visit to a node determines
  // its depth level; subsequent manager edges to an already-visited node are
  // infinite loops on cyclic graphs (Threat T-31-15).
  const visited = new Set<string>();
  const queue: string[] = [...roots];

  for (const root of roots) {
    depth.set(root, 0);
    visited.add(root);
  }

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    const currentDepth = depth.get(nodeId) ?? 0;

    const childSet = children.get(nodeId);
    if (childSet) {
      for (const childId of childSet) {
        // Single-parent rule: if already visited, skip — first manager wins.
        // This is the KEY difference from familyTreeLayout which supports multi-parent.
        if (visited.has(childId)) continue;
        visited.add(childId);
        depth.set(childId, currentDepth + 1);
        queue.push(childId);
      }
    }
  }

  for (const node of nodes) {
    if (!depth.has(node.id)) {
      depth.set(node.id, 0);
    }
  }

  const levels = new Map<number, string[]>();
  for (const [nodeId, d] of depth) {
    if (!levels.has(d)) levels.set(d, []);
    levels.get(d)!.push(nodeId);
  }

  const positions = new Map<string, { x: number; y: number }>();
  const maxDepth = Math.max(...Array.from(levels.keys()));

  for (let d = 0; d <= maxDepth; d++) {
    const levelNodes = levels.get(d);
    if (!levelNodes) continue;

    levelNodes.sort();

    const totalWidth = (levelNodes.length - 1) * hGap;
    const levelStartX = startX - totalWidth / 2;

    for (let i = 0; i < levelNodes.length; i++) {
      positions.set(levelNodes[i], {
        x: levelStartX + i * hGap,
        y: startY + d * vGap,
      });
    }
  }

  // ── Step 7: Re-center managers above their direct reports ───────────────────
  // Bottom-up pass to center each manager above its subordinates' x midpoint.
  for (let d = maxDepth - 1; d >= 0; d--) {
    const levelNodes = levels.get(d);
    if (!levelNodes) continue;

    for (const nodeId of levelNodes) {
      const childSet = children.get(nodeId);
      if (!childSet || childSet.size === 0) continue;

      const childXs: number[] = [];
      for (const childId of childSet) {
        const childPos = positions.get(childId);
        if (childPos) childXs.push(childPos.x);
      }

      if (childXs.length === 0) continue;

      const avgX = childXs.reduce((a, b) => a + b, 0) / childXs.length;
      const nodePos = positions.get(nodeId)!;
      positions.set(nodeId, { x: avgX, y: nodePos.y });
    }
  }

  return positions;
}
