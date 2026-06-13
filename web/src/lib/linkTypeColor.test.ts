import { describe, it, expect } from 'vitest';
import {
  getLinkTypeColor,
  hashColor,
  getInverseLabel,
  formatLinkType,
  NEUTRAL_EDGE_COLOR,
  PRESET_LINK_TYPES,
} from './linkTypeColor';

describe('NEUTRAL_EDGE_COLOR', () => {
  it('is #6b7280', () => {
    expect(NEUTRAL_EDGE_COLOR).toBe('#6b7280');
  });
});

describe('PRESET_LINK_TYPES', () => {
  it('contains all 11 preset types', () => {
    const keys = Object.keys(PRESET_LINK_TYPES);
    expect(keys).toHaveLength(11);
    expect(keys).toContain('parent_of');
    expect(keys).toContain('child_of');
    expect(keys).toContain('spouse_of');
    expect(keys).toContain('sibling_of');
    expect(keys).toContain('member_of');
    expect(keys).toContain('located_in');
    expect(keys).toContain('ally_of');
    expect(keys).toContain('enemy_of');
    expect(keys).toContain('created_by');
    expect(keys).toContain('owns');
    expect(keys).toContain('related_to');
  });

  it('parent_of has correct color and direction', () => {
    expect(PRESET_LINK_TYPES.parent_of.color).toBe('#3b82f6');
    expect(PRESET_LINK_TYPES.parent_of.direction).toBe('directed');
  });
});

describe('getLinkTypeColor', () => {
  it('returns NEUTRAL_EDGE_COLOR for null', () => {
    expect(getLinkTypeColor(null, {})).toBe(NEUTRAL_EDGE_COLOR);
  });

  it('returns NEUTRAL_EDGE_COLOR for null without registry argument', () => {
    expect(getLinkTypeColor(null)).toBe(NEUTRAL_EDGE_COLOR);
  });

  it('returns preset color for parent_of', () => {
    expect(getLinkTypeColor('parent_of', {})).toBe('#3b82f6');
  });

  it('registry override wins over preset', () => {
    expect(getLinkTypeColor('parent_of', { parent_of: { color: '#000000' } })).toBe('#000000');
  });

  it('returns hashed color for custom type rival_of', () => {
    const color = getLinkTypeColor('rival_of', {});
    expect(color).toMatch(/^hsl\(\d+, 60%, 55%\)$/);
  });

  it('returns deterministic hashed color for same input', () => {
    const color1 = getLinkTypeColor('rival_of', {});
    const color2 = getLinkTypeColor('rival_of', {});
    expect(color1).toBe(color2);
  });

  it('returns preset color for all 11 presets', () => {
    const expected: Record<string, string> = {
      parent_of: '#3b82f6',
      child_of: '#3b82f6',
      spouse_of: '#ec4899',
      sibling_of: '#a855f7',
      member_of: '#f97316',
      located_in: '#22c55e',
      ally_of: '#06b6d4',
      enemy_of: '#ef4444',
      created_by: '#78716c',
      owns: '#d97706',
      related_to: '#94a3b8',
    };
    for (const [type, color] of Object.entries(expected)) {
      expect(getLinkTypeColor(type, {})).toBe(color);
    }
  });
});

describe('hashColor', () => {
  it('returns a valid hsl string', () => {
    const color = hashColor('rival_of');
    expect(color).toMatch(/^hsl\(\d+, 60%, 55%\)$/);
  });

  it('is deterministic — same input, same output', () => {
    expect(hashColor('custom_type')).toBe(hashColor('custom_type'));
  });

  it('produces different colors for different strings', () => {
    const a = hashColor('type_a');
    const b = hashColor('type_b');
    // Not guaranteed but very likely for distinct strings
    expect(a).not.toBe(b);
  });

  it('hue is in range 0-359', () => {
    const color = hashColor('test_type');
    const match = color.match(/^hsl\((\d+), 60%, 55%\)$/);
    expect(match).not.toBeNull();
    const hue = parseInt(match![1], 10);
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
  });
});

describe('getInverseLabel', () => {
  it('returns null for null linkType', () => {
    expect(getInverseLabel(null, {})).toBeNull();
  });

  it('returns null for null without registry argument', () => {
    expect(getInverseLabel(null)).toBeNull();
  });

  it('returns child_of for parent_of', () => {
    expect(getInverseLabel('parent_of', {})).toBe('child_of');
  });

  it('returns parent_of for child_of', () => {
    expect(getInverseLabel('child_of', {})).toBe('parent_of');
  });

  it('returns null for custom type rival_of', () => {
    expect(getInverseLabel('rival_of', {})).toBeNull();
  });

  it('returns registry inverseLabel when set', () => {
    expect(
      getInverseLabel('custom_type', { custom_type: { inverseLabel: 'inverse_custom' } }),
    ).toBe('inverse_custom');
  });

  it('returns has_member for member_of', () => {
    expect(getInverseLabel('member_of', {})).toBe('has_member');
  });

  it('returns contains for located_in', () => {
    expect(getInverseLabel('located_in', {})).toBe('contains');
  });

  it('returns owns for created_by', () => {
    expect(getInverseLabel('created_by', {})).toBe('owns');
  });

  it('returns created_by for owns', () => {
    expect(getInverseLabel('owns', {})).toBe('created_by');
  });
});

describe('formatLinkType', () => {
  it('formats parent_of as Parent Of', () => {
    expect(formatLinkType('parent_of')).toBe('Parent Of');
  });

  it('formats single word type', () => {
    expect(formatLinkType('ally')).toBe('Ally');
  });

  it('formats multi-word type', () => {
    expect(formatLinkType('located_in')).toBe('Located In');
  });

  it('formats created_by', () => {
    expect(formatLinkType('created_by')).toBe('Created By');
  });
});
