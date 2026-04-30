/**
 * Simulation renderer interface and configuration types.
 *
 * Per UI-SPEC §5.2 + §5.4: Canvas2D first, SimRenderer interface defined so
 * a WebGL/three.js renderer could be substituted without changing AppBackground.tsx.
 *
 * Plan 08-02 ships the Canvas2D implementation only; three.js deferred (§14.4).
 */

export interface SimBody {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;            // radius in CSS px
  hue: 'ambient' | 'entry';
  color?: string;       // for entry bodies (POL-03); undefined for ambient
}

export interface SimConfig {
  ambientCount: number;           // 70
  entryCap: number;               // 80
  totalCap: number;               // 150
  fpsCap: number;                 // 30
  neighborThresholdRatio: number; // 0.12 of viewport diagonal
  maxLinesPerBody: number;        // 3
  ambientRadiusRange: [number, number]; // [1.0, 2.5]
  entryRadiusRange: [number, number];   // [2.5, 3.5]
  initialVelocity: number;        // 0.04 px/frame max abs
  damping: number;                // 0.998
  jitter: number;                 // 0.005 px/frame max abs
  edgeBehavior: 'wrap';
}

export interface SimRenderer {
  init(canvas: HTMLCanvasElement, isDark: boolean, reducedMotion: boolean): void;
  step(): void;                   // advance physics one tick (no-op if reducedMotion)
  draw(): void;                   // paint current state
  resize(width: number, height: number): void;
  setTheme(isDark: boolean): void;
  setEntries(entries: Array<{ id: string; type: string }>): void; // POL-03 — accepts empty array in plan 08-02
  dispose(): void;
}

/**
 * DEFAULT_SIM_CONFIG — exact values per UI-SPEC §5.2.
 */
export const DEFAULT_SIM_CONFIG: SimConfig = {
  ambientCount: 70,
  entryCap: 80,
  totalCap: 150,
  fpsCap: 30,
  neighborThresholdRatio: 0.12,
  maxLinesPerBody: 3,
  ambientRadiusRange: [1.0, 2.5],
  entryRadiusRange: [2.5, 3.5],
  initialVelocity: 0.04,
  damping: 0.998,
  jitter: 0.005,
  edgeBehavior: 'wrap',
};
