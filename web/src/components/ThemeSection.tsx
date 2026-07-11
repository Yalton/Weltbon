import { useState } from 'react';
import { useUpdateUniverse, type Universe } from '../hooks/useUniverse';
import type { UniverseTheme } from '../types/theme';
import { PALETTES, FONT_STACKS } from '../lib/theme/palettes';
import { ThemeScope } from './theme/ThemeScope';
import { AssetPickerModal } from './AssetPickerModal';
import { Button } from './ui/Button';
import { Panel } from './ui/Panel';

const PALETTE_LABELS: Record<keyof typeof PALETTES, string> = {
  observatory: 'Observatory',
  ember: 'Ember',
  verdant: 'Verdant',
  abyssal: 'Abyssal',
  parchment: 'Parchment',
};

const FONT_LABELS: Record<keyof typeof FONT_STACKS, string> = {
  spectral: 'Spectral',
  cormorant: 'Cormorant Garamond',
  cinzel: 'Cinzel',
  crimson: 'Crimson Pro',
};

/** Strip undefined keys so the saved theme object is minimal and stable. */
function compact(t: UniverseTheme): UniverseTheme {
  return Object.fromEntries(
    Object.entries(t).filter(([, v]) => v !== undefined),
  ) as UniverseTheme;
}

export function ThemeSection({ universe }: { universe: Universe }) {
  const update = useUpdateUniverse(universe.id);
  const [draft, setDraft] = useState<UniverseTheme>(universe.theme ?? {});
  const [pickerOpen, setPickerOpen] = useState(false);

  const set = (patch: Partial<UniverseTheme>) =>
    setDraft((d) => compact({ ...d, ...patch }));

  const save = () => update.mutateAsync({ theme: compact(draft) });
  const reset = () => {
    setDraft({});
    return update.mutateAsync({ theme: null });
  };

  return (
    <section>
      <h2 className="text-lg font-medium mb-2">Theme</h2>
      <p className="text-sm text-ink-secondary mb-4">
        Give this universe its own look — palette, accent, heading font, and an
        optional backdrop image.
      </p>

      <h3 className="text-[10px] uppercase tracking-[0.14em] text-ink-muted mb-2">Palette</h3>
      <div className="flex flex-wrap gap-2 mb-5">
        {(Object.keys(PALETTES) as (keyof typeof PALETTES)[]).map((key) => {
          const p = PALETTES[key];
          const selected = (draft.palette ?? 'observatory') === key;
          return (
            <button
              key={key}
              type="button"
              aria-label={PALETTE_LABELS[key]}
              aria-pressed={selected}
              onClick={() => set({ palette: key })}
              className={[
                'w-24 rounded-lg border p-2 text-left transition-colors',
                selected
                  ? 'border-accent-strong/60 [box-shadow:var(--shadow-glow-soft)]'
                  : 'border-glass-border hover:border-white/25',
              ].join(' ')}
            >
              <span
                aria-hidden="true"
                className="block h-8 w-full rounded-md"
                style={{
                  background: `radial-gradient(120% 120% at 30% 0%, ${p['--color-canvas-hi']}, ${p['--color-canvas-lo']})`,
                }}
              >
                <span
                  className="ml-1.5 mt-1.5 block h-2.5 w-2.5 rounded-full"
                  style={{ background: p['--color-accent-strong'] }}
                />
              </span>
              <span className="mt-1 block text-xs text-ink-secondary">{PALETTE_LABELS[key]}</span>
            </button>
          );
        })}
      </div>

      <h3 className="text-[10px] uppercase tracking-[0.14em] text-ink-muted mb-2">Accent</h3>
      <div className="flex items-center gap-3 mb-5">
        <input
          type="color"
          aria-label="Custom accent color"
          value={draft.accent ?? PALETTES[draft.palette ?? 'observatory']['--color-accent']}
          onChange={(e) => set({ accent: e.target.value })}
          className="h-8 w-12 cursor-pointer rounded border border-glass-border bg-transparent"
        />
        {draft.accent && (
          <Button variant="ghost" onClick={() => setDraft((d) => compact({ ...d, accent: undefined }))}>
            Reset to palette
          </Button>
        )}
      </div>

      <h3 className="text-[10px] uppercase tracking-[0.14em] text-ink-muted mb-2">Heading font</h3>
      <div className="flex flex-col gap-1.5 mb-5">
        {(Object.keys(FONT_STACKS) as (keyof typeof FONT_STACKS)[]).map((key) => (
          <label key={key} className="flex items-baseline gap-3 cursor-pointer">
            <input
              type="radio"
              name="displayFont"
              aria-label={FONT_LABELS[key]}
              checked={(draft.displayFont ?? 'spectral') === key}
              onChange={() => set({ displayFont: key })}
            />
            <span className="text-lg text-ink" style={{ fontFamily: FONT_STACKS[key] }}>
              {FONT_LABELS[key]}
            </span>
          </label>
        ))}
      </div>

      <h3 className="text-[10px] uppercase tracking-[0.14em] text-ink-muted mb-2">Backdrop</h3>
      <div className="flex items-center gap-3 mb-5">
        {draft.backdropAssetId && universe.backdropThumbUrl && (
          <img
            src={universe.backdropThumbUrl}
            alt="Current backdrop"
            className="h-14 w-24 rounded-md object-cover border border-glass-border"
          />
        )}
        <Button variant="ghost" onClick={() => setPickerOpen(true)}>Choose image</Button>
        {draft.backdropAssetId && (
          <Button
            variant="ghost"
            onClick={() => setDraft((d) => compact({ ...d, backdropAssetId: undefined }))}
          >
            Remove backdrop
          </Button>
        )}
      </div>

      <h3 className="text-[10px] uppercase tracking-[0.14em] text-ink-muted mb-2">Preview</h3>
      <ThemeScope
        theme={compact(draft)}
        backdropMode="contained"
        className="relative overflow-hidden rounded-[10px] border border-glass-border mb-5"
      >
        <div className="p-4 flex flex-col gap-3">
          <span className="font-display text-lg font-semibold text-ink">{universe.name}</span>
          <Panel className="p-3">
            <span className="font-display text-sm font-semibold text-ink">Aldenmark</span>
            <p className="text-xs text-ink-secondary">The imperial capital.</p>
          </Panel>
          <Button className="self-start">Create entry</Button>
        </div>
      </ThemeScope>

      <div className="flex gap-2">
        <Button onClick={save} disabled={update.isPending}>Save theme</Button>
        <Button variant="ghost" onClick={reset} disabled={update.isPending}>
          Reset to default
        </Button>
      </div>

      <AssetPickerModal
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        universeId={universe.id}
        mode="set-backdrop"
        onSelect={(assetId) => {
          set({ backdropAssetId: assetId });
          setPickerOpen(false);
        }}
      />
    </section>
  );
}
