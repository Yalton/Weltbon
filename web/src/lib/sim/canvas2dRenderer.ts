/**
 * Canvas2D implementation of SimRenderer.
 *
 * Per UI-SPEC §5.2 + §5.3 + §5.4: Canvas2D chosen as primary renderer
 * (§14.2 adopted in plan 08-02). three.js dependency deferred (§14.4).
 *
 * Design choices recorded per plan output requirement:
 * - Color encoding: per-body L-jitter via raw oklab-equivalent string computation.
 *   Each ambient body gets a color string computed at init time:
 *   dark: oklch(0.7 + rand*0.15, 0.18, 270) mixed fraction 0.0–0.4 toward oklch(0.85 0.05 270)
 *   light: oklch(0.55 - rand*0.15, 0.18, 270) mixed fraction 0.0–0.4 toward oklch(0.4 0.10 270)
 *   The "simpler" encoding from §5.3: direct oklch() CSS string with jittered L value.
 *   This avoids implementing color mixing math; the browser interprets oklch() natively.
 */

import type { SimBody, SimConfig, SimRenderer } from './renderer';

type Lcg = () => number;

interface Canvas2dRendererOptions {
  config: SimConfig;
  lcg: Lcg;
}

/**
 * Exported for tests — exposes getBodies() beyond the standard SimRenderer interface.
 */
export interface Canvas2dRenderer extends SimRenderer {
  getBodies(): SimBody[];
}

/**
 * Compute per-body ambient color string using UI-SPEC §5.3 encoding.
 * Simpler approach: jitter L in oklch() directly.
 * dark:  base L=0.70, mix toward 0.85 at low chroma (simulated by L jitter + chroma reduction)
 * light: base L=0.55, mix toward 0.40 at low chroma
 *
 * Chosen encoding: plain L jitter (simplest correct approach; recorded in SUMMARY).
 */
function ambientBodyColor(rand1: number, rand2: number, isDark: boolean): string {
  // rand1: L jitter [0,1) → scale to 0.0–0.15
  // rand2: mix factor [0,1) → scale to 0.0–0.4 for chroma reduction
  if (isDark) {
    const L = 0.70 + rand1 * 0.15;
    const C = 0.18 - rand2 * 0.13; // 0.18 → 0.05 (matches §5.3 mix toward oklch(0.85 0.05 270))
    return `oklch(${L.toFixed(3)} ${C.toFixed(3)} 270)`;
  } else {
    const L = 0.55 - rand1 * 0.15;
    const C = 0.18 - rand2 * 0.08; // 0.18 → 0.10 (matches §5.3 mix toward oklch(0.4 0.10 270))
    return `oklch(${L.toFixed(3)} ${C.toFixed(3)} 270)`;
  }
}

/**
 * Compute the distance threshold for near-neighbor lines.
 * Per UI-SPEC §5.2: 12% of viewport diagonal.
 */
export function computeThreshold(width: number, height: number, ratio: number): number {
  return ratio * Math.sqrt(width * width + height * height);
}

/**
 * Find neighbor pairs for line drawing.
 * Per UI-SPEC §5.2: max 3 lines per body, closest neighbors by distance.
 * Uses symmetric-pair guard: each pair drawn at most once.
 *
 * Returns an array of [i, j] index pairs to draw lines between.
 */
export function findNeighborPairs(
  bodies: SimBody[],
  threshold: number,
  maxLinesPerBody: number
): Array<[number, number]> {
  const n = bodies.length;
  const lineCounts = new Array<number>(n).fill(0);
  const pairs: Array<[number, number]> = [];
  const drawnPairs = new Set<string>();

  // For each body, find all neighbors within threshold, sorted by distance
  for (let i = 0; i < n; i++) {
    if (lineCounts[i] >= maxLinesPerBody) continue;

    // Gather neighbors with distances
    const neighbors: Array<{ j: number; dist: number }> = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const dx = bodies[i].x - bodies[j].x;
      const dy = bodies[i].y - bodies[j].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < threshold) {
        neighbors.push({ j, dist });
      }
    }

    // Sort by distance ascending, keep closest maxLinesPerBody
    neighbors.sort((a, b) => a.dist - b.dist);

    for (const { j } of neighbors) {
      if (lineCounts[i] >= maxLinesPerBody) break;
      if (lineCounts[j] >= maxLinesPerBody) continue;

      // Symmetric pair guard: use canonical key min-max
      const key = `${Math.min(i, j)}-${Math.max(i, j)}`;
      if (drawnPairs.has(key)) continue;
      drawnPairs.add(key);

      lineCounts[i]++;
      lineCounts[j]++;
      pairs.push([i, j]);
    }
  }

  return pairs;
}

/**
 * Wrap a coordinate at the given boundary (toroidal wrap per UI-SPEC §5.2).
 */
export function toroidalWrap(v: number, size: number): number {
  if (v < 0) return v + size;
  if (v >= size) return v - size;
  return v;
}

export function createCanvas2dRenderer(options: Canvas2dRendererOptions): Canvas2dRenderer {
  const { config, lcg } = options;

  let bodies: SimBody[] = [];
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let isDark = true;
  let reducedMotion = false;
  let disposed = false;

  function seedBodies(w: number, h: number, dark: boolean): SimBody[] {
    const result: SimBody[] = [];
    for (let i = 0; i < config.ambientCount; i++) {
      const x = lcg() * w;
      const y = lcg() * h;
      const vx = (lcg() * 2 - 1) * config.initialVelocity;
      const vy = (lcg() * 2 - 1) * config.initialVelocity;
      const r = config.ambientRadiusRange[0] +
        lcg() * (config.ambientRadiusRange[1] - config.ambientRadiusRange[0]);
      const rand1 = lcg();
      const rand2 = lcg();
      result.push({
        x, y, vx, vy, r,
        hue: 'ambient',
        color: ambientBodyColor(rand1, rand2, dark),
      });
    }
    return result;
  }

  const renderer: Canvas2dRenderer = {
    getBodies() {
      return bodies;
    },

    init(canvasEl: HTMLCanvasElement, dark: boolean, rm: boolean): void {
      canvas = canvasEl;
      isDark = dark;
      reducedMotion = rm;
      ctx = canvasEl.getContext('2d') as CanvasRenderingContext2D;
      bodies = seedBodies(canvasEl.width, canvasEl.height, dark);
    },

    step(): void {
      if (reducedMotion || disposed || !canvas) return;
      const w = canvas.width;
      const h = canvas.height;
      for (const b of bodies) {
        // Apply Brownian jitter
        b.vx += (lcg() * 2 - 1) * config.jitter;
        b.vy += (lcg() * 2 - 1) * config.jitter;
        // Apply damping
        b.vx *= config.damping;
        b.vy *= config.damping;
        // Update position
        b.x += b.vx;
        b.y += b.vy;
        // Toroidal wrap
        b.x = toroidalWrap(b.x, w);
        b.y = toroidalWrap(b.y, h);
      }
    },

    draw(): void {
      if (disposed || !canvas || !ctx) return;
      const w = canvas.width;
      const h = canvas.height;

      // Clear canvas
      ctx.clearRect(0, 0, w, h);

      if (bodies.length === 0) return;

      // Compute threshold
      const threshold = computeThreshold(w, h, config.neighborThresholdRatio);

      // Find neighbor pairs for line drawing
      const pairs = findNeighborPairs(bodies, threshold, config.maxLinesPerBody);

      // Draw lines first (behind bodies)
      if (pairs.length > 0) {
        ctx.lineWidth = 0.5;
        if (isDark) {
          ctx.strokeStyle = `oklch(0.7 0.18 270 / 0.18)`;
        } else {
          ctx.strokeStyle = `oklch(0.55 0.18 270 / 0.22)`;
        }
        ctx.beginPath();
        for (const [i, j] of pairs) {
          ctx.moveTo(bodies[i].x, bodies[i].y);
          ctx.lineTo(bodies[j].x, bodies[j].y);
        }
        ctx.stroke();
      }

      // Draw bodies
      const opacity = isDark ? 0.65 : 0.55;
      for (const b of bodies) {
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fillStyle = b.color ?? (isDark
          ? `oklch(0.7 0.18 270)`
          : `oklch(0.55 0.18 270)`);
        ctx.globalAlpha = opacity;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    },

    resize(width: number, height: number): void {
      if (disposed || !canvas) return;
      const oldW = canvas.width;
      const oldH = canvas.height;
      canvas.width = width;
      canvas.height = height;
      // Rescale positions proportionally
      if (oldW > 0 && oldH > 0) {
        const scaleX = width / oldW;
        const scaleY = height / oldH;
        for (const b of bodies) {
          b.x *= scaleX;
          b.y *= scaleY;
        }
      }
    },

    setTheme(dark: boolean): void {
      isDark = dark;
      // Recompute body colors for new theme
      for (const b of bodies) {
        if (b.hue === 'ambient') {
          const rand1 = lcg();
          const rand2 = lcg();
          b.color = ambientBodyColor(rand1, rand2, dark);
        }
      }
    },

    setEntries(entries: Array<{ id: string; type: string }>): void {
      // Plan 08-02 stub: accept array but do not add entry bodies.
      // Plan 08-03 will implement the full entry-body layer.
      // Remove any existing entry bodies
      bodies = bodies.filter(b => b.hue !== 'entry');
      // entries parameter intentionally unused in 08-02 (POL-03 deferred)
      void entries;
    },

    dispose(): void {
      disposed = true;
      bodies = [];
      canvas = null;
      ctx = null;
    },
  };

  return renderer;
}
