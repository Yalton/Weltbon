/**
 * entryBodyColor — wrapper around entryTypeColor.ts hex palette for sim entry-body fills.
 *
 * Per UI-SPEC §3.3 + §7.2:
 * - Dark theme: hex unchanged (returns hex from entryTypeHexColor directly).
 * - Light theme: L * 0.85 adjustment — we convert hex → HSL, multiply L by 0.85, convert back.
 *
 * Luma encoding choice: HSL L * 0.85
 * Rationale: simpler than a full oklch pipeline; avoids new deps; acceptable per plan §action.
 * Trade-off: HSL is not perceptually uniform (oklch would be more accurate), but for a subtle
 * darkening pass on already-vivid 500-weight swatches the difference is imperceptible.
 * This choice is recorded here per PLAN §output requirement.
 *
 * Does NOT mutate ENTRY_TYPE_HEX in entryTypeColor.ts — pure function.
 */

import { entryTypeHexColor } from '../entryTypeColor';

/**
 * Parse a 6-char hex string into [r, g, b] components in [0, 255].
 */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return [r, g, b];
}

/**
 * Convert [r, g, b] (0–255) to [h, s, l] where h ∈ [0, 360), s ∈ [0, 1], l ∈ [0, 1].
 */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;

  if (max === min) {
    return [0, 0, l]; // achromatic
  }

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

  let h: number;
  switch (max) {
    case rn:
      h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
      break;
    case gn:
      h = ((bn - rn) / d + 2) / 6;
      break;
    default: // bn
      h = ((rn - gn) / d + 4) / 6;
      break;
  }

  return [h * 360, s, l];
}

function hue2rgb(p: number, q: number, t: number): number {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

/**
 * Convert [h, s, l] (h ∈ [0, 360), s/l ∈ [0, 1]) back to [r, g, b] (0–255).
 */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hn = h / 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = hue2rgb(p, q, hn + 1 / 3);
  const g = hue2rgb(p, q, hn);
  const b = hue2rgb(p, q, hn - 1 / 3);
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/**
 * Convert [r, g, b] (0–255) to a 6-char hex string.
 */
function rgbToHex(r: number, g: number, b: number): string {
  return '#' +
    r.toString(16).padStart(2, '0') +
    g.toString(16).padStart(2, '0') +
    b.toString(16).padStart(2, '0');
}

/**
 * Adjust a hex color's lightness by a factor using HSL conversion.
 * factor < 1.0 darkens; factor > 1.0 lightens.
 * Returns a valid 6-char lowercase hex string.
 */
function adjustLumaHsl(hex: string, factor: number): string {
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  const newL = Math.min(1, Math.max(0, l * factor));
  const [nr, ng, nb] = hslToRgb(h, s, newL);
  return rgbToHex(nr, ng, nb);
}

/**
 * entryTypeBodyColor — returns a hex color for an entry body in the sim.
 *
 * - Dark theme (isDark=true): returns the raw hex from entryTypeHexColor, unchanged.
 * - Light theme (isDark=false): returns the hex with L * 0.85 (HSL adjustment).
 *
 * Case-insensitive; unknown types fall back to the entryTypeHexColor fallback (#6b7280).
 * Pure function; does NOT mutate entryTypeColor.ts.
 *
 * Exported as the primary API of this module (per PLAN §artifacts).
 */
export function entryTypeBodyColor(type: string, isDark: boolean): string {
  const hex = entryTypeHexColor(type);
  if (isDark) {
    return hex;
  }
  // Light theme: darken by factor 0.85 to prevent glare on neutral-50 background
  return adjustLumaHsl(hex, 0.85);
}
