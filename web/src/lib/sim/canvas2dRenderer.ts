
import type { SimBody, SimConfig, SimRenderer } from './renderer';
import { entryTypeBodyColor } from './entryBodyColor';

type Lcg = () => number;

interface Canvas2dRendererOptions {
  config: SimConfig;
  lcg: Lcg;
}

export interface Canvas2dRenderer extends SimRenderer {
  getBodies(): SimBody[];
}

function ambientBodyColor(rand1: number, rand2: number, isDark: boolean): string {
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

export function computeThreshold(width: number, height: number, ratio: number): number {
  return ratio * Math.sqrt(width * width + height * height);
}

export function findNeighborPairs(
  bodies: SimBody[],
  threshold: number,
  maxLinesPerBody: number
): Array<[number, number]> {
  const n = bodies.length;
  const lineCounts = new Array<number>(n).fill(0);
  const pairs: Array<[number, number]> = [];
  const drawnPairs = new Set<string>();

  for (let i = 0; i < n; i++) {
    if (lineCounts[i] >= maxLinesPerBody) continue;

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

export function toroidalWrap(v: number, size: number): number {
  if (v < 0) return v + size;
  if (v >= size) return v - size;
  return v;
}

export function createCanvas2dRenderer(options: Canvas2dRendererOptions): Canvas2dRenderer {
  const { config, lcg } = options;

  let ambientBodies: SimBody[] = [];
  let entryBodies: SimBody[] = [];
  let entryBodyIds: string[] = [];

  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let isDark = true;
  let reducedMotion = false;
  let disposed = false;

  function allBodies(): SimBody[] {
    return [...ambientBodies, ...entryBodies];
  }

  function seedAmbientBody(w: number, h: number, dark: boolean): SimBody {
    const x = lcg() * w;
    const y = lcg() * h;
    const vx = (lcg() * 2 - 1) * config.initialVelocity;
    const vy = (lcg() * 2 - 1) * config.initialVelocity;
    const r = config.ambientRadiusRange[0] +
      lcg() * (config.ambientRadiusRange[1] - config.ambientRadiusRange[0]);
    const rand1 = lcg();
    const rand2 = lcg();
    return {
      x, y, vx, vy, r,
      hue: 'ambient',
      color: ambientBodyColor(rand1, rand2, dark),
    };
  }

  function seedEntryBody(w: number, h: number, type: string): SimBody {
    const x = lcg() * w;
    const y = lcg() * h;
    const vx = (lcg() * 2 - 1) * config.initialVelocity;
    const vy = (lcg() * 2 - 1) * config.initialVelocity;
    // Entry bodies: radius range [2.5, 3.5] per UI-SPEC §5.2 + §7.2
    const r = config.entryRadiusRange[0] +
      lcg() * (config.entryRadiusRange[1] - config.entryRadiusRange[0]);
    return {
      x, y, vx, vy, r,
      hue: 'entry',
      color: entryTypeBodyColor(type, isDark),
    };
  }

  const renderer: Canvas2dRenderer = {
    getBodies() {
      return allBodies();
    },

    init(canvasEl: HTMLCanvasElement, dark: boolean, rm: boolean): void {
      canvas = canvasEl;
      isDark = dark;
      reducedMotion = rm;
      ctx = canvasEl.getContext('2d') as CanvasRenderingContext2D;

      ambientBodies = [];
      for (let i = 0; i < config.ambientCount; i++) {
        ambientBodies.push(seedAmbientBody(canvasEl.width, canvasEl.height, dark));
      }
      entryBodies = [];
      entryBodyIds = [];
    },

    step(): void {
      if (reducedMotion || disposed || !canvas) return;
      const w = canvas.width;
      const h = canvas.height;
      // Step all bodies (ambient + entry participate in same physics — D-08)
      for (const b of ambientBodies) {
        b.vx += (lcg() * 2 - 1) * config.jitter;
        b.vy += (lcg() * 2 - 1) * config.jitter;
        b.vx *= config.damping;
        b.vy *= config.damping;
        b.x += b.vx;
        b.y += b.vy;
        b.x = toroidalWrap(b.x, w);
        b.y = toroidalWrap(b.y, h);
      }
      for (const b of entryBodies) {
        b.vx += (lcg() * 2 - 1) * config.jitter;
        b.vy += (lcg() * 2 - 1) * config.jitter;
        b.vx *= config.damping;
        b.vy *= config.damping;
        b.x += b.vx;
        b.y += b.vy;
        b.x = toroidalWrap(b.x, w);
        b.y = toroidalWrap(b.y, h);
      }
    },

    draw(): void {
      if (disposed || !canvas || !ctx) return;
      const w = canvas.width;
      const h = canvas.height;
      const bodies = allBodies();

      ctx.clearRect(0, 0, w, h);

      if (bodies.length === 0) return;

      const threshold = computeThreshold(w, h, config.neighborThresholdRatio);

      // Ambient + entry bodies participate in the same neighbor graph (UI-SPEC §7.2 — mixed lines OK).
      const pairs = findNeighborPairs(bodies, threshold, config.maxLinesPerBody);

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

      // Draw ambient bodies first, then entry bodies on top (D-06: additive layering, entry on top)
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
      if (oldW > 0 && oldH > 0) {
        const scaleX = width / oldW;
        const scaleY = height / oldH;
        for (const b of allBodies()) {
          b.x *= scaleX;
          b.y *= scaleY;
        }
      }
    },

    setTheme(dark: boolean): void {
      isDark = dark;
      for (const b of ambientBodies) {
        const rand1 = lcg();
        const rand2 = lcg();
        b.color = ambientBodyColor(rand1, rand2, dark);
      }
    },

    setEntries(entries: Array<{ id: string; type: string }>): void {
      if (disposed) return;

      // Caller is responsible for pre-sorting by recency; renderer just truncates.
      const capped = entries.length > config.entryCap
        ? entries.slice(entries.length - config.entryCap)
        : entries;

      if (!canvas) {
        entryBodies = [];
        entryBodyIds = [];
        return;
      }

      const w = canvas.width;
      const h = canvas.height;

      const existingMap = new Map<string, SimBody>();
      for (let i = 0; i < entryBodyIds.length; i++) {
        existingMap.set(entryBodyIds[i], entryBodies[i]);
      }

      const newEntryBodies: SimBody[] = [];
      const newEntryBodyIds: string[] = [];

      const incomingIds = new Set(capped.map(e => e.id));

      for (const entry of capped) {
        if (existingMap.has(entry.id)) {
          newEntryBodies.push(existingMap.get(entry.id)!);
        } else {
          newEntryBodies.push(seedEntryBody(w, h, entry.type));
        }
        newEntryBodyIds.push(entry.id);
      }

      void incomingIds; // used as a guard above via existingMap + capped iteration

      entryBodies = newEntryBodies;
      entryBodyIds = newEntryBodyIds;
    },

    dispose(): void {
      disposed = true;
      ambientBodies = [];
      entryBodies = [];
      entryBodyIds = [];
      canvas = null;
      ctx = null;
    },
  };

  return renderer;
}
