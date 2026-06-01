/**
 * orgChartLayout — pure top-down hierarchical layout for single-parent org charts.
 *
 * Algorithm: BFS from root nodes (nodes with no incoming "manager-term" edge),
 * assigning depth levels then spreading siblings horizontally with a fixed gap.
 * A visited set prevents infinite loops on cyclic graphs.
 *
 * Structural rule: SINGLE-PARENT enforcement.
 * Unlike familyTreeLayout which supports multi-parent hierarchies, orgChartLayout
 * enforces that each node has at most one manager in the layout. When a node has
 * manager edges from multiple sources, the first-encountered manager (in
 * deterministic BFS order) wins, and subsequent manager edges to an already-placed
 * node are ignored for layout purposes. The node is still present once in the
 * output — it is never dropped.
 *
 * Directionality conventions (LOCKED — document for callers):
 *
 *   Manager-role terms (source IS the manager of target):
 *     "manages", "supervises", "leads", "manager", "lead", "head of"
 *     source --"manages"--> target  means  source is the manager of target
 *
 *   Subordinate-role term (source IS subordinate to target):
 *     "subordinate"
 *     source --"subordinate"--> target  means  target is the manager of source
 *     BUT: for layout uniformity, we apply the unified convention — source is
 *     placed one level deeper than in the manager-to-subordinate direction.
 *     Implementation: all MANAGER_TERMS make `target` one level deeper than
 *     `source` in the BFS (source is "above" target) — same as familyTreeLayout.
 *
 *   Reporting-role term (source REPORTS TO target):
 *     "reports to"
 *     source --"reports to"--> target  means  target is the manager of source
 *     For layout purposes this is treated the same as "manages" edge direction:
 *     source (subordinate) is one level deeper than would be expected literally,
 *     but we apply unified treatment: target is one level deeper than source.
 *     This simplifies dispatch and keeps orgChartLayout and familyTreeLayout
 *     interchangeable in DiagramEditor.
 *
 * Summary: ALL MANAGER_TERMS edges make `target` one level deeper than `source`.
 * This mirrors familyTreeLayout's unified ancestor-at-source convention exactly.
 *
 * No React, no d3, no DOM. Pure TypeScript.
 *
 * DIAGRAM-04 / D-06 requirement. Threat T-31-15 mitigated by the visited-set BFS
 * (cycles are terminated; complexity is O(nodes+edges) with no recursion).
 * Threat T-31-16 mitigated: labels only select layout participation, never
 * used in attribute strings or eval paths.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Minimal node shape required by the layout function.
 * Identical to LayoutNode in familyTreeLayout.ts — intentional: both functions
 * accept the same node shape so DiagramEditor can call either without adaptation.
 */
export interface LayoutNode {
  id: string;
  x: number;
  y: number;
}

/**
 * Minimal edge shape required by the layout function.
 * Identical to LayoutEdge in familyTreeLayout.ts — intentional.
 */
export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
  label: string | null;
}

/** Optional configuration for the layout. */
export interface OrgChartLayoutOptions {
  /** Horizontal gap between sibling nodes (default: 120). */
  hGap?: number;
  /** Vertical gap between levels (default: 100). */
  vGap?: number;
  /** Starting x coordinate for the root level (default: 0). */
  startX?: number;
  /** Starting y coordinate for the root level (default: 0). */
  startY?: number;
}

// ─── MANAGER_TERMS ────────────────────────────────────────────────────────────

/**
 * Recognized manager-term labels for org-chart layout.
 * Case-insensitive matching is performed at runtime (see `isManagerEdge`).
 * Distinct from familyTreeLayout's PARENT_TERMS because org hierarchy is
 * reporting-line based, not kinship based.
 *
 * Planner-confirmed set (D-06, 2026-05-31):
 *   - "manager"      — general manager-role label
 *   - "reports to"   — subordinate-to-manager direction label
 *   - "supervises"   — manager-role synonym (direct reports)
 *   - "manages"      — manager-role synonym (direct reports)
 *   - "subordinate"  — marks subordinate relationship
 *   - "lead"         — team-lead manager designation
 *   - "leads"        — team-lead verb form
 *   - "head of"      — department/org head designation
 */
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

// ─── isManagerEdge ────────────────────────────────────────────────────────────

/**
 * Returns true if the edge label is a recognized manager term (case-insensitive).
 * Returns false for null, empty string, or any non-matching label.
 */
export function isManagerEdge(edge: LayoutEdge): boolean {
  if (!edge.label) return false;
  return MANAGER_TERMS_LOWER.has(edge.label.toLowerCase());
}

// ─── orgChartLayout ───────────────────────────────────────────────────────────

/**
 * Computes a top-down hierarchical layout for a single-parent org chart.
 *
 * Returns a `Map<nodeId, { x, y }>` with new positions for every input node.
 * The return type is identical to familyTreeLayout so DiagramEditor can apply
 * positions through one shared code path.
 *
 * Single-parent rule: each node is placed under AT MOST ONE manager. When a
 * node has manager edges from multiple sources, the first-BFS-encountered
 * manager wins and later manager edges to the same node are ignored for layout.
 * The node still appears exactly once in the output.
 *
 * Non-manager edges are ignored for layout. Input nodes connected only by such
 * edges are still assigned positions (they become root nodes at depth 0).
 *
 * Cyclic manager edges are handled by the visited-set BFS: already-visited
 * nodes are skipped (no throw, no infinite loop) — Threat T-31-15 mitigated.
 *
 * @param nodes  Input nodes — only their `id` fields are used.
 * @param edges  Input edges — only manager-term edges affect positioning.
 * @param opts   Optional layout tuning (hGap, vGap, startX, startY).
 */
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
    // source is the manager, target is the subordinate (unified convention)
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
  // depth: nodeId → depth level (0 = root/no manager)
  const depth = new Map<string, number>();
  // visited set enforces single-parent: the first BFS visit to a node determines
  // its depth level; subsequent manager edges to an already-visited node are
  // ignored for layout (but the node remains in the output). This also prevents
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

  // ── Step 4: Assign any remaining nodes (disconnected from BFS) at depth 0 ───
  for (const node of nodes) {
    if (!depth.has(node.id)) {
      depth.set(node.id, 0);
    }
  }

  // ── Step 5: Group nodes by level ─────────────────────────────────────────────
  const levels = new Map<number, string[]>();
  for (const [nodeId, d] of depth) {
    if (!levels.has(d)) levels.set(d, []);
    levels.get(d)!.push(nodeId);
  }

  // ── Step 6: Assign x positions within each level (sorted for determinism) ────
  const positions = new Map<string, { x: number; y: number }>();
  const maxDepth = Math.max(...Array.from(levels.keys()));

  for (let d = 0; d <= maxDepth; d++) {
    const levelNodes = levels.get(d);
    if (!levelNodes) continue;

    // Sort for deterministic ordering
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

      // Collect x positions of subordinates that were laid out
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
