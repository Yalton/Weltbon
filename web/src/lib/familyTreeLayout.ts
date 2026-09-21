

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

export interface FamilyTreeLayoutOptions {
  hGap?: number;
  vGap?: number;
  startX?: number;
  startY?: number;
}


export const PARENT_TERMS: ReadonlyArray<string> = [
  'parent',
  'child',
  'mother',
  'father',
  'son',
  'daughter',
  'sibling',
  'step-parent',
  'step-mother',
  'step-father',
] as const;

// Pre-computed lowercase set for O(1) lookup.
const PARENT_TERMS_LOWER = new Set(PARENT_TERMS.map((t) => t.toLowerCase()));


export function isParentEdge(edge: LayoutEdge): boolean {
  if (!edge.label) return false;
  return PARENT_TERMS_LOWER.has(edge.label.toLowerCase());
}


export function familyTreeLayout(
  nodes: ReadonlyArray<LayoutNode>,
  edges: ReadonlyArray<LayoutEdge>,
  opts: FamilyTreeLayoutOptions = {},
): Map<string, { x: number; y: number }> {
  const { hGap = 120, vGap = 100, startX = 0, startY = 0 } = opts;

  // ── Step 1: Collect parent-edge children map and in-degree for layout ────────
  // children: parent nodeId → Set of child nodeIds (based on parent-term edges only)
  const children = new Map<string, Set<string>>();
  // parentCount: nodeId → number of incoming parent-term edges
  const parentCount = new Map<string, number>();

  for (const node of nodes) {
    if (!children.has(node.id)) children.set(node.id, new Set());
    if (!parentCount.has(node.id)) parentCount.set(node.id, 0);
  }

  for (const edge of edges) {
    if (!isParentEdge(edge)) continue;
    const childSet = children.get(edge.source);
    if (childSet) {
      childSet.add(edge.target);
    }
    // increment in-degree for the target (descendant)
    parentCount.set(edge.target, (parentCount.get(edge.target) ?? 0) + 1);
  }

  // ── Step 2: Identify roots (nodes with zero incoming parent-term edges) ───────
  const roots: string[] = [];
  for (const node of nodes) {
    if ((parentCount.get(node.id) ?? 0) === 0) {
      roots.push(node.id);
    }
  }

  const depth = new Map<string, number>();
  // visited set prevents cycles from causing infinite loops (T-31-04)
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
        if (visited.has(childId)) continue; // cycle or multi-parent already processed
        visited.add(childId);
        const existing = depth.get(childId);
        const newDepth = currentDepth + 1;
        // first visited; multi-parent nodes are guaranteed to be at least 1 below
        // the first-encountered parent. The test asserts y > both parents, which
        if (existing === undefined || newDepth > existing) {
          depth.set(childId, newDepth);
        }
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

  // ── Step 7: Re-center parents above their children ───────────────────────────
  // Do a second pass bottom-up to center each parent above its children's
  // in the simple-tree test case.
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
