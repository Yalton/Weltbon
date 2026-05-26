import type { AuditRunStatus } from '../types/audit';

/**
 * Phase 26 — small status pill for audit runs.
 *
 * Visual analog of SeverityPill: glyph + label inline. The glyph spans are
 * aria-hidden; the readable status word is conveyed both visually and to
 * screen readers via an sr-only span plus aria-label on the wrapper.
 *
 * `role="status" aria-live="polite"` so AT users hear the transition
 * (e.g. "Audit status: Running" → "Audit status: Succeeded") when the
 * component re-renders inside AuditProgressPanel.
 *
 * `animate-spin` is scoped to the running glyph ONLY (not the pill wrapper)
 * per 26-UI-SPEC §Motion lock — the label text must remain stable so screen
 * readers do not announce phantom transitions and reduced-motion users see a
 * static pill except for the small spinner glyph.
 */

const glyphMap: Record<AuditRunStatus, string> = {
  pending: '⌛',
  running: '⟳',
  succeeded: '✓',
  failed: '✗',
};

const labelMap: Record<AuditRunStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
};

const colorMap: Record<AuditRunStatus, string> = {
  pending: 'text-neutral-600',
  running: 'text-neutral-600',
  succeeded: 'text-green-700 dark:text-green-300',
  failed: 'text-red-600 dark:text-red-400',
};

const glyphClassMap: Record<AuditRunStatus, string> = {
  pending: '',
  running: 'animate-spin inline-block',
  succeeded: '',
  failed: '',
};

export interface AuditStatusPillProps {
  status: AuditRunStatus;
}

export function AuditStatusPill({ status }: AuditStatusPillProps) {
  const label = labelMap[status];
  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={`Audit status: ${label}`}
      className="inline-flex items-center gap-1 text-xs font-medium"
    >
      <span aria-hidden="true" className={glyphClassMap[status]}>
        {glyphMap[status]}
      </span>
      <span className="sr-only">{label}</span>
      <span aria-hidden="true" className={colorMap[status]}>
        {label}
      </span>
    </span>
  );
}
