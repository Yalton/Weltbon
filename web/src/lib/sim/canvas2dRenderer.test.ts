import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCanvas2dRenderer } from './canvas2dRenderer';
import { createLcg } from './lcg';
import { DEFAULT_SIM_CONFIG } from './renderer';

/**
 * Create a mock Canvas2D context that records calls.
 * jsdom's canvas support is limited — we mock getContext() to return a spy.
 */
function makeMockCanvas(width = 800, height = 600): HTMLCanvasElement {
  const ctx = {
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    arc: vi.fn(),
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    globalAlpha: 1,
  };
  const canvas = {
    width,
    height,
    getContext: vi.fn().mockReturnValue(ctx),
  } as unknown as HTMLCanvasElement;
  return canvas;
}

describe('createCanvas2dRenderer', () => {
  describe('factory and init', () => {
    it('returns an object implementing the SimRenderer interface', () => {
      const renderer = createCanvas2dRenderer({
        config: DEFAULT_SIM_CONFIG,
        lcg: createLcg(0x57454c54),
      });
      expect(typeof renderer.init).toBe('function');
      expect(typeof renderer.step).toBe('function');
      expect(typeof renderer.draw).toBe('function');
      expect(typeof renderer.resize).toBe('function');
      expect(typeof renderer.setTheme).toBe('function');
      expect(typeof renderer.setEntries).toBe('function');
      expect(typeof renderer.dispose).toBe('function');
    });

    it('init() seeds exactly ambientCount (70) ambient bodies', () => {
      const renderer = createCanvas2dRenderer({
        config: DEFAULT_SIM_CONFIG,
        lcg: createLcg(0x57454c54),
      });
      const canvas = makeMockCanvas();
      renderer.init(canvas, true, false);
      expect(renderer.getBodies().length).toBe(70);
      expect(renderer.getBodies().every(b => b.hue === 'ambient')).toBe(true);
    });

    it('two renderers with same LCG seed produce identical first-body positions', () => {
      const r1 = createCanvas2dRenderer({
        config: DEFAULT_SIM_CONFIG,
        lcg: createLcg(0x57454c54),
      });
      const r2 = createCanvas2dRenderer({
        config: DEFAULT_SIM_CONFIG,
        lcg: createLcg(0x57454c54),
      });
      const c1 = makeMockCanvas();
      const c2 = makeMockCanvas();
      r1.init(c1, true, false);
      r2.init(c2, true, false);
      const b1 = r1.getBodies()[0];
      const b2 = r2.getBodies()[0];
      expect(b1.x).toBe(b2.x);
      expect(b1.y).toBe(b2.y);
      expect(b1.vx).toBe(b2.vx);
      expect(b1.vy).toBe(b2.vy);
    });
  });

  describe('step() — physics', () => {
    it('step() with damping reduces speed monotonically (plus jitter ceiling)', () => {
      const renderer = createCanvas2dRenderer({
        config: DEFAULT_SIM_CONFIG,
        lcg: createLcg(0x57454c54),
      });
      const canvas = makeMockCanvas();
      renderer.init(canvas, true, false);
      const bodies = renderer.getBodies();

      // record speeds before step
      const speedsBefore = bodies.map(b => Math.hypot(b.vx, b.vy));
      renderer.step();
      const speedsAfter = bodies.map(b => Math.hypot(b.vx, b.vy));

      // After step: each |v_after| <= |v_before| + jitter ceiling (jitter * sqrt(2))
      const jitterCeiling = DEFAULT_SIM_CONFIG.jitter * Math.sqrt(2);
      for (let i = 0; i < bodies.length; i++) {
        expect(speedsAfter[i]).toBeLessThanOrEqual(speedsBefore[i] + jitterCeiling + 1e-9);
      }
    });

    it('step() wraps body at x > canvas.width back to ~0', () => {
      const renderer = createCanvas2dRenderer({
        config: DEFAULT_SIM_CONFIG,
        lcg: createLcg(0x57454c54),
      });
      const canvas = makeMockCanvas(800, 600);
      renderer.init(canvas, true, false);
      const bodies = renderer.getBodies();
      // Force first body outside right edge
      bodies[0].x = 801;
      bodies[0].vx = 0.04;
      renderer.step();
      expect(bodies[0].x).toBeLessThan(801);
      expect(bodies[0].x).toBeGreaterThanOrEqual(0);
    });

    it('step() is a no-op when reducedMotion=true', () => {
      const renderer = createCanvas2dRenderer({
        config: DEFAULT_SIM_CONFIG,
        lcg: createLcg(0x57454c54),
      });
      const canvas = makeMockCanvas();
      renderer.init(canvas, true, true); // reducedMotion = true
      const bodies = renderer.getBodies();
      const possBefore = bodies.map(b => ({ x: b.x, y: b.y }));
      renderer.step();
      const possAfter = bodies.map(b => ({ x: b.x, y: b.y }));
      expect(possAfter).toEqual(possBefore);
    });
  });

  describe('neighbor line drawing', () => {
    it('draw() calls arc() for each body (70 calls total)', () => {
      const renderer = createCanvas2dRenderer({
        config: DEFAULT_SIM_CONFIG,
        lcg: createLcg(0x57454c54),
      });
      const canvas = makeMockCanvas(1440, 900);
      renderer.init(canvas, true, false);
      const ctx = canvas.getContext('2d') as unknown as { arc: ReturnType<typeof vi.fn> };
      renderer.draw();
      // arc() called once per body
      expect(ctx.arc).toHaveBeenCalledTimes(70);
    });

    it('two bodies inside threshold → at least 1 line segment drawn (moveTo/lineTo pair)', () => {
      // Use a tiny canvas so ALL bodies are within threshold of each other
      const renderer = createCanvas2dRenderer({
        config: { ...DEFAULT_SIM_CONFIG, ambientCount: 2, maxLinesPerBody: 3 },
        lcg: createLcg(0x57454c54),
      });
      const canvas = makeMockCanvas(100, 100);
      renderer.init(canvas, true, false);
      const ctx = canvas.getContext('2d') as unknown as {
        moveTo: ReturnType<typeof vi.fn>;
        lineTo: ReturnType<typeof vi.fn>;
      };
      // Put both bodies very close together
      const bodies = renderer.getBodies();
      bodies[0].x = 50; bodies[0].y = 50;
      bodies[1].x = 51; bodies[1].y = 51;
      renderer.draw();
      expect(ctx.moveTo).toHaveBeenCalled();
      expect(ctx.lineTo).toHaveBeenCalled();
    });

    it('two bodies outside threshold → 0 line segments drawn', () => {
      const renderer = createCanvas2dRenderer({
        config: { ...DEFAULT_SIM_CONFIG, ambientCount: 2 },
        lcg: createLcg(0x57454c54),
      });
      const canvas = makeMockCanvas(100, 100);
      renderer.init(canvas, true, false);
      const ctx = canvas.getContext('2d') as unknown as {
        moveTo: ReturnType<typeof vi.fn>;
        lineTo: ReturnType<typeof vi.fn>;
      };
      // Put bodies far apart (outside 12% of diagonal = 0.12 * sqrt(100^2+100^2) ≈ 17px)
      const bodies = renderer.getBodies();
      bodies[0].x = 0;  bodies[0].y = 0;
      bodies[1].x = 99; bodies[1].y = 99;
      // Reset mock after init potentially draws
      (ctx.moveTo as ReturnType<typeof vi.fn>).mockClear();
      (ctx.lineTo as ReturnType<typeof vi.fn>).mockClear();
      renderer.draw();
      expect(ctx.moveTo).not.toHaveBeenCalled();
      expect(ctx.lineTo).not.toHaveBeenCalled();
    });

    it('maxLinesPerBody=3: body with many close neighbors draws at most 3 lines from it', () => {
      // 6 bodies all clustered at same point — each should get at most 3 lines
      const renderer = createCanvas2dRenderer({
        config: { ...DEFAULT_SIM_CONFIG, ambientCount: 6, maxLinesPerBody: 3 },
        lcg: createLcg(0x57454c54),
      });
      const canvas = makeMockCanvas(500, 500);
      renderer.init(canvas, true, false);
      const ctx = canvas.getContext('2d') as unknown as {
        moveTo: ReturnType<typeof vi.fn>;
        lineTo: ReturnType<typeof vi.fn>;
      };
      // Cluster all bodies at center — all within threshold
      const bodies = renderer.getBodies();
      bodies.forEach((b, i) => { b.x = 250 + i; b.y = 250; });
      (ctx.moveTo as ReturnType<typeof vi.fn>).mockClear();
      (ctx.lineTo as ReturnType<typeof vi.fn>).mockClear();
      renderer.draw();
      // With symmetric-pair guard: for 6 bodies, max unique pairs = 6*5/2 = 15
      // But max lines per body = 3, so max total unique edges = 6*3/2 = 9
      const lineCount = (ctx.moveTo as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(lineCount).toBeLessThanOrEqual(9);
    });
  });

  describe('setEntries and dispose', () => {
    it('setEntries([]) does not crash and adds zero entry bodies', () => {
      const renderer = createCanvas2dRenderer({
        config: DEFAULT_SIM_CONFIG,
        lcg: createLcg(0x57454c54),
      });
      const canvas = makeMockCanvas();
      renderer.init(canvas, true, false);
      expect(() => renderer.setEntries([])).not.toThrow();
      // Only ambient bodies remain
      expect(renderer.getBodies().filter(b => b.hue === 'entry').length).toBe(0);
    });

    it('dispose() does not throw and renders no further errors', () => {
      const renderer = createCanvas2dRenderer({
        config: DEFAULT_SIM_CONFIG,
        lcg: createLcg(0x57454c54),
      });
      const canvas = makeMockCanvas();
      renderer.init(canvas, true, false);
      expect(() => renderer.dispose()).not.toThrow();
      // dispose is idempotent
      expect(() => renderer.dispose()).not.toThrow();
    });
  });
});
