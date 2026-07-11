import { useEffect, useRef } from 'react';
import { useMatch } from 'react-router-dom';
import { createCanvas2dRenderer } from '../lib/sim/canvas2dRenderer';
import { createLcg } from '../lib/sim/lcg';
import { DEFAULT_SIM_CONFIG } from '../lib/sim/renderer';
import { useSimSettings } from '../store/simSettings';
import { useEntries } from '../hooks/useEntries';
import type { Canvas2dRenderer } from '../lib/sim/canvas2dRenderer';

/**
 * AppBackground — fixed-position Canvas2D constellation sim behind every authenticated route.
 *
 * Mount strategy: first child of Layout.tsx (authenticated layout).
 * The canvas is fixed + z-index -10 + pointer-events:none — never blocks UI.
 *
 * Lifecycle:
 * - On mount: init renderer, detect prefers-reduced-motion.
 *   - If reduced: single static draw; rAF loop never starts.
 *   - If not reduced: start 30fps-capped rAF loop.
 * - visibilitychange: pause loop when hidden, resume when visible + not reduced.
 * - matchMedia change: if reduce fires → cancel rAF + static draw; if no-reduce → start rAF.
 * - MutationObserver on documentElement.class: legacy hook only — the app is dark-only now, no toggle triggers it.
 * - window.resize (debounced 100ms): renderer.resize(innerWidth, innerHeight).
 * - On unmount: cancelAnimationFrame + remove all listeners + disconnect observer + renderer.dispose().
 *
 * Plan 08-03 extension:
 * - Subscribes to useSimSettings (showEntriesAsBodies toggle).
 * - Subscribes to useEntries(universeId) when inside /universes/:uid/* routes.
 * - When toggle ON + universeId present: calls renderer.setEntries(mapped entries).
 * - Otherwise: calls renderer.setEntries([]) to clear entry layer.
 *
 * Error handling: renderer.init() errors are caught; console.warn'd; component stays mounted
 * with an invisible canvas (never crashes the React tree). Per UI-SPEC §10.
 *
 * Accessibility: aria-hidden="true" + role="presentation" + pointer-events-none. Per UI-SPEC §11.5.
 * Threat model: T-08-04 (rAF runaway), T-08-05 (memory leak), T-08-06 (screen reader noise) — all mitigated.
 * Threat model: T-08-09 (only id + entryType cross to renderer; no titles/bodies/sensitive fields) — mitigated.
 * Threat model: T-08-10 (hard cap 80 via renderer.setEntries entryCap) — mitigated.
 */
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
  // useMatch('/universes/:uid/*') returns a match object with params.uid, or null outside.
  const universeMatch = useMatch('/universes/:uid/*');
  const universeId = universeMatch?.params?.uid ?? null;

  // POL-03: fetch entries for current universe (only when inside a universe route)
  // useEntries is disabled when universeId is null via its own `enabled: !!universeId` guard.
  const { data: entries } = useEntries(universeId ?? '');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Detect initial theme
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
  // This effect runs AFTER the mount effect above (React runs effects in declaration order).
  // rendererRef.current is set during the mount effect, so it's available here on
  // subsequent renders triggered by dependency changes.
  // On first mount: both effects run in order within the same commit, so rendererRef is
  // populated by the time this effect runs (React guarantees intra-commit effect ordering).
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || initErrorRef.current) return;

    if (showEntriesAsBodies && universeId && entries) {
      // Map Entry objects to the minimal shape the renderer needs.
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
      style={{ filter: 'blur(0.5px)' }}
    />
  );
}
