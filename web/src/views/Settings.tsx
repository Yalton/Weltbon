/**
 * Settings view — POL-03, §14.3 (route /settings confirmed).
 *
 * Single-section page with one toggle for the entries-as-bodies layer.
 * Per UI-SPEC §7.3 (toggle recipe), §10 (copy), §2.1 (typography), §1 (spacing).
 *
 * Route: /settings (inside Layout so AppBackground renders — §5.5 intent)
 * Linked from: UserMenu → Settings
 */

import { useSimSettings } from '../store/simSettings';
import BuildVersion from '../components/BuildVersion';

export default function Settings() {
  const showEntriesAsBodies = useSimSettings((s) => s.showEntriesAsBodies);
  const setShowEntriesAsBodies = useSimSettings((s) => s.setShowEntriesAsBodies);

  return (
    <div className="max-w-2xl">
      {/* H1 — UI-SPEC §2.1 H1 recipe: text-2xl font-semibold tracking-tight */}
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      {/* Visual section */}
      <section className="mt-8">
        {/* H2 — UI-SPEC §2.1 H2 recipe: text-xl font-semibold */}
        <h2 className="text-xl font-semibold">Visual</h2>

        {/* Helper text — UI-SPEC §10 copy */}
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400 leading-[1.5]">
          Show this universe&apos;s entries as additional bodies in the background simulation. Off by default.
        </p>

        {/* Toggle — per UI-SPEC §7.3 recipe */}
        <label className="mt-4 flex items-center gap-3">
          <input
            type="checkbox"
            checked={showEntriesAsBodies}
            onChange={(e) => setShowEntriesAsBodies(e.target.checked)}
            className="h-4 w-4 accent-[color:var(--color-accent)]"
          />
          {/* Label text — exact string from UI-SPEC §10 */}
          <span className="text-sm">Entries appear as bodies in the background</span>
        </label>
      </section>

      {/* Build identity — what a bug report needs to name the exact build. */}
      <BuildVersion />
    </div>
  );
}
