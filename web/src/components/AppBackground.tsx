import { useEffect, useRef } from 'react';
import { useMatch } from 'react-router-dom';
import { createCanvas2dRenderer } from '../lib/sim/canvas2dRenderer';
import { createLcg } from '../lib/sim/lcg';
import { DEFAULT_SIM_CONFIG } from '../lib/sim/renderer';
import { useSimSettings } from '../store/simSettings';
import { useEntries } from '../hooks/useEntries';
import type { Canvas2dRenderer } from '../lib/sim/canvas2dRenderer';

export function AppBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Canvas2dRenderer | null>(null);
  const rafIdRef = useRef<number>(0);
  const lastFrameTimeRef = useRef<number>(0);
  const reducedMotionRef = useRef<boolean>(false);
  const isHiddenRef = useRef<boolean>(false);
  const initErrorRef = useRef<boolean>(false);

  // POL-03: subscribe to entries-as-bodies toggle
  const showEntriesAsBodies = useSimSettings((s) => s.showEntriesAsBodies);

  // POL-03: detect if we're inside a /universes/:uid/* route
  const universeMatch = useMatch('/universes/:uid/*');
  const universeId = universeMatch?.params?.uid ?? null;

  // POL-03: fetch entries for current universe (only when inside a universe route)
  const { data: entries } = useEntries(universeId ?? '');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const isDark = document.documentElement.classList.contains('dark');

    // Detect reduced-motion preference
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotionRef.current = mq.matches;

    // Create renderer with deterministic WELT seed (per UI-SPEC §6.2)
    const renderer = createCanvas2dRenderer({
      config: DEFAULT_SIM_CONFIG,
      lcg: createLcg(0x57454c54),
    });
    rendererRef.current = renderer;

    // Initialize renderer — catch errors to avoid crashing React tree (UI-SPEC §10)
    try {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      renderer.init(canvas, isDark, reducedMotionRef.current);
    } catch (err) {
      console.warn('Background couldn\'t load — that\'s cosmetic; the app still works.', err);
      initErrorRef.current = true;
      return;
    }

    // --- rAF loop helpers ---
    const frameInterval = 1000 / DEFAULT_SIM_CONFIG.fpsCap; // 33.33ms at 30fps

    function tick(now: number) {
      if (reducedMotionRef.current || isHiddenRef.current) return;
      rafIdRef.current = requestAnimationFrame(tick);
      if (now - lastFrameTimeRef.current < frameInterval) return;
      lastFrameTimeRef.current = now;
      renderer.step();
      renderer.draw();
    }

    function startLoop() {
      if (!reducedMotionRef.current && !isHiddenRef.current) {
        rafIdRef.current = requestAnimationFrame(tick);
      }
    }

    function stopLoop() {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = 0;
      }
    }

    // --- Reduced-motion initial branch ---
    if (reducedMotionRef.current) {
      renderer.draw(); // single static deterministic frame
    } else {
      startLoop();
    }

    // --- visibilitychange listener (T-08-04: pause when hidden) ---
    function handleVisibilityChange() {
      if (document.hidden) {
        isHiddenRef.current = true;
        stopLoop();
      } else {
        isHiddenRef.current = false;
        if (!reducedMotionRef.current) {
          startLoop();
        }
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // --- matchMedia change listener ---
    function handleMqChange(e: { matches: boolean }) {
      reducedMotionRef.current = e.matches;
      if (e.matches) {
        stopLoop();
        renderer.draw(); // static frame
      } else {
        startLoop();
      }
    }
    mq.addEventListener('change', handleMqChange);

    // --- MutationObserver for theme class changes on documentElement ---
    const observer = new MutationObserver(() => {
      const dark = document.documentElement.classList.contains('dark');
      renderer.setTheme(dark);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    // --- window.resize (debounced 100ms) ---
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    function handleResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        renderer.resize(window.innerWidth, window.innerHeight);
      }, 100);
    }
    window.addEventListener('resize', handleResize);

    // --- Cleanup on unmount (T-08-05: memory leak prevention) ---
    return () => {
      stopLoop();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      mq.removeEventListener('change', handleMqChange);
      observer.disconnect();
      window.removeEventListener('resize', handleResize);
      clearTimeout(resizeTimer);
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []); // mount once

  // POL-03: update renderer entry layer when toggle state, universe context, or entries change.
  // populated by the time this effect runs (React guarantees intra-commit effect ordering).
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || initErrorRef.current) return;

    if (showEntriesAsBodies && universeId && entries) {
      // Per T-08-09: only id + entryType cross to renderer — no titles, bodies, or sensitive fields.
      const mapped = entries.map((e) => ({ id: e.id, type: e.entryType }));
      renderer.setEntries(mapped);
    } else {
      renderer.setEntries([]);
    }
  }, [showEntriesAsBodies, universeId, entries]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      role="presentation"
      data-testid="app-background"
      className="fixed inset-0 -z-10 pointer-events-none w-full h-full"
    />
  );
}
