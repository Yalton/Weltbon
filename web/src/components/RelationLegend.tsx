import { useCallback, useRef, useState } from 'react';
import type { GraphEdge } from '../hooks/useGraphData';
import {
  getLinkTypeColor,
  formatLinkType,
  NEUTRAL_EDGE_COLOR,
  type LinkTypeRegistry,
} from '../lib/linkTypeColor';

export interface RelationLegendProps {
  edges: GraphEdge[];
  registry: LinkTypeRegistry;
  visible: boolean;
  onToggle: () => void;
  onColorChange?: (linkType: string, color: string) => void;
}

function deriveRows(
  edges: GraphEdge[],
  registry: LinkTypeRegistry,
): Array<{ type: string | null; color: string; label: string }> {
  const seen = new Set<string | null>();
  const rows: Array<{ type: string | null; color: string; label: string }> = [];

  for (const e of edges) {
    const key = e.linkType ?? null;
    if (seen.has(key)) continue;
    seen.add(key);

    if (key === null) {
      rows.push({ type: null, color: NEUTRAL_EDGE_COLOR, label: 'Untyped' });
    } else {
      rows.push({
        type: key,
        color: getLinkTypeColor(key, registry),
        label: formatLinkType(key),
      });
    }
  }

  return rows.sort((a, b) => {
    if (a.type === null) return 1;
    if (b.type === null) return -1;
    return a.label.localeCompare(b.label);
  });
}

export function RelationLegend({
  edges,
  registry,
  visible,
  onToggle,
  onColorChange,
}: RelationLegendProps) {
  const rows = deriveRows(edges, registry);
  const hasTypedEdges = rows.length > 0;

  const [editingType, setEditingType] = useState<string | null | 'none'>('none');
  const colorInputRef = useRef<HTMLInputElement>(null);

  const handleSwatchClick = useCallback(
    (type: string | null, currentColor: string) => {
      if (!onColorChange || type === null) return; // Untyped cannot be overridden
      setEditingType(type);
      setTimeout(() => {
        if (colorInputRef.current) {
          colorInputRef.current.value = currentColor;
          colorInputRef.current.click();
        }
      }, 0);
    },
    [onColorChange],
  );

  const handleColorInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (typeof editingType === 'string' && editingType !== 'none' && onColorChange) {
        onColorChange(editingType, e.target.value);
      }
    },
    [editingType, onColorChange],
  );

  return (
    // Pointer-events-none wrapper so the d3-zoom SVG below is never blocked.
    // The toggle button has been moved to GraphView's toolbar flex group (28-06).
    <div className="pointer-events-none absolute inset-0">
      {/* Panel — only rendered when visible */}
      {visible && (
        <div
          role="region"
          aria-label="Relation type legend"
          className="pointer-events-auto absolute top-14 right-3 z-50 w-48 max-h-64 overflow-y-auto rounded-md border border-neutral-200 bg-white shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
        >
          {/* Panel header */}
          <div className="flex items-center justify-between px-3 pt-2 pb-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Relation types
            </span>
            <button
              type="button"
              onClick={onToggle}
              aria-label="Close legend"
              className="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
            >
              ×
            </button>
          </div>

          {/* Type rows */}
          {!hasTypedEdges ? (
            <p className="px-3 py-2 text-xs text-neutral-400">
              No typed edges in this view.
            </p>
          ) : (
            <ul role="list" className="pb-2">
              {rows.map((row) => (
                <li
                  key={row.type ?? '__untyped__'}
                  className="group flex items-center gap-2 px-3 py-1"
                >
                  {/* Color swatch */}
                  <button
                    type="button"
                    aria-label={
                      row.type
                        ? `${row.label}: ${row.color} — click to edit color`
                        : `${row.label}: ${row.color}`
                    }
                    title={
                      row.type && onColorChange
                        ? 'Edit color'
                        : row.label
                    }
                    onClick={() => handleSwatchClick(row.type, row.color)}
                    className={[
                      'w-3 h-3 rounded-full flex-shrink-0 border-0 p-0',
                      row.type && onColorChange
                        ? 'cursor-pointer hover:ring-2 hover:ring-offset-1 hover:ring-neutral-400'
                        : 'cursor-default',
                    ].join(' ')}
                    style={{ backgroundColor: row.color }}
                    tabIndex={row.type && onColorChange ? 0 : -1}
                  />

                  {/* Type label */}
                  <span className="flex-1 truncate text-xs text-neutral-700 dark:text-neutral-300">
                    {row.label}
                  </span>

                  {/* Edit color hint (hover only, preset types only) */}
                  {row.type && onColorChange && (
                    <span className="text-xs text-neutral-400 opacity-0 group-hover:opacity-100">
                      Edit color
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Hidden color input — shared across all swatch rows */}
      {onColorChange && (
        <input
          ref={colorInputRef}
          type="color"
          aria-label="Edit link type color"
          className="pointer-events-auto sr-only"
          onChange={handleColorInputChange}
          onBlur={() => setEditingType('none')}
        />
      )}
    </div>
  );
}
