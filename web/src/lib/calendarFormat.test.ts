import { describe, it, expect } from 'vitest';
import { formatCalendar } from './calendarFormat';
import type { Calendar } from './calendarFormat';

// ─── Fixture calendar ────────────────────────────────────────────────────────

/**
 * Canonical test calendar:
 *   Eras:    [First Age @ pos 0, Third Era @ pos 10000]
 *   Months:  [Frostmoon (30 days), Harvestmoon (20 days)]  → yearLen = 50
 *   Weekdays: ['Mon', 'Tue', 'Wed']
 *   Moons:   [{ name: 'Luna', cycleDays: 7 }]
 *   beforeEraAbbr: 'BE'
 *
 * Epoch (implicit) = earliestEra.startPosition = 0.
 */
const CALENDAR: Calendar = {
  eras: [
    { name: 'First Age', abbr: 'FA', startPosition: 0 },
    { name: 'Third Era', abbr: 'TE', startPosition: 10000 },
  ],
  months: [
    { name: 'Frostmoon', lengthDays: 30 },
    { name: 'Harvestmoon', lengthDays: 20 },
  ],
  weekdays: ['Mon', 'Tue', 'Wed'],
  moons: [{ name: 'Luna', cycleDays: 7 }],
  beforeEraAbbr: 'BE',
};

// yearLen = 50 days
// Third Era starts at position 10000
// Position 10000 → TE year 1, day 1 of Frostmoon
// Position 10013 → TE year 1, day 14 of Frostmoon (1-indexed day = dayInYear+1 = 13+1 = 14)
// Position 10013: dayIndex=10013, daysFromEraStart = 10013-10000 = 13
//   yearInEra = floor(13/50)+1 = 1, doy = 13 mod 50 = 13
//   month 0 (Frostmoon=30): doy 13 < 30, day = 14 (1-indexed)
// Position 10013 + 412*50 - 50 = 10013 + 20600 - 50 = 20563
// For "14 Frostmoon, 412 TE": position must give daysFromEraStart = (412-1)*50 + 13 = 20563
// totalPosition = 10000 + 20563 = 30563

describe('formatCalendar', () => {
  // ─── CALENDAR-03: null calendar fallback ────────────────────────────────────

  it('returns null when calendar is null (CALENDAR-03 raw-numeric fallback)', () => {
    expect(formatCalendar(0, null)).toBeNull();
    expect(formatCalendar(12345, null)).toBeNull();
    expect(formatCalendar(-999, null)).toBeNull();
  });

  // ─── D-09: required fixtures ─────────────────────────────────────────────────

  it('era-boundary exact hit: position == era.startPosition → that era, year 1 (D-09)', () => {
    // position == 10000 exactly → Third Era, year 1
    const result = formatCalendar(10000, CALENDAR);
    expect(result).not.toBeNull();
    expect(result!.eraAbbr).toBe('TE');
    expect(result!.era).toBe('Third Era');
    expect(result!.year).toBe(1);
    expect(result!.monthName).toBe('Frostmoon');
    expect(result!.monthIndex).toBe(0);
    expect(result!.day).toBe(1);
  });

  it('era-boundary exact hit: position == first era start (pos=0) → FA, year 1 (D-09)', () => {
    const result = formatCalendar(0, CALENDAR);
    expect(result).not.toBeNull();
    expect(result!.eraAbbr).toBe('FA');
    expect(result!.year).toBe(1);
    expect(result!.day).toBe(1);
    expect(result!.monthIndex).toBe(0);
  });

  it('month-overflow is structurally impossible: doy = dayIndex mod yearLen is always < yearLen (D-09)', () => {
    // yearLen = 50; test last day of a year: day = position at daysFromEraStart = 49
    // position 49: FA, year 1, doy 49, second month (Harvestmoon), day 20
    const result = formatCalendar(49, CALENDAR);
    expect(result).not.toBeNull();
    // doy 49 → Frostmoon takes 0..29 (30 days), Harvestmoon 30..49 (20 days)
    // doy 49 → 49-30 = 19 → day 20 (1-indexed) in Harvestmoon
    expect(result!.monthName).toBe('Harvestmoon');
    expect(result!.day).toBe(20);
    // next position wraps cleanly to year 2
    const nextYear = formatCalendar(50, CALENDAR);
    expect(nextYear!.year).toBe(2);
    expect(nextYear!.monthName).toBe('Frostmoon');
    expect(nextYear!.day).toBe(1);
  });

  it('empty weekdays → weekday is null (D-09)', () => {
    const cal: Calendar = { ...CALENDAR, weekdays: [] };
    const result = formatCalendar(0, cal);
    expect(result).not.toBeNull();
    expect(result!.weekday).toBeNull();
  });

  it('empty moons → moonPhases is empty array (D-09)', () => {
    const cal: Calendar = { ...CALENDAR, moons: [] };
    const result = formatCalendar(0, cal);
    expect(result).not.toBeNull();
    expect(result!.moonPhases).toEqual([]);
  });

  // ─── D-08: pre-epoch boundary ────────────────────────────────────────────────

  it('pre-epoch: position == epochStart - 1 → day in year 1 BE (D-08)', () => {
    // epochStart = 0 (earliestEra.startPosition)
    // position = -1 → yearsBefore: ceil((0 - (-1)) / 50) = ceil(1/50) = 1
    // year 1 BE; doy within that year: dayIndex relative to start of last before-epoch year
    const result = formatCalendar(-1, CALENDAR);
    expect(result).not.toBeNull();
    expect(result!.eraAbbr).toBe('BE');
    expect(result!.year).toBe(1);
  });

  it('pre-epoch: negative position uses beforeEraAbbr and counts down (D-08)', () => {
    // position = -50: yearsBefore = ceil(50/50) = 1 → year 1 BE (the last before-epoch year ends at -1)
    // position = -51: yearsBefore = ceil(51/50) = 2 → year 2 BE
    const r1 = formatCalendar(-50, CALENDAR);
    const r2 = formatCalendar(-51, CALENDAR);
    expect(r1!.eraAbbr).toBe('BE');
    expect(r1!.year).toBe(1);
    expect(r2!.year).toBe(2);
  });

  // ─── CALENDAR-02: canonical "14 Frostmoon, 412 TE" happy path ───────────────

  it('canonical "14 Frostmoon, 412 TE" happy path: compact and structured parts (D-07)', () => {
    // For year 412 TE, day 14 of Frostmoon:
    // daysFromEraStart = (412-1)*50 + (14-1) = 411*50 + 13 = 20563
    // position = 10000 + 20563 = 30563
    const result = formatCalendar(30563, CALENDAR);
    expect(result).not.toBeNull();
    expect(result!.eraAbbr).toBe('TE');
    expect(result!.era).toBe('Third Era');
    expect(result!.year).toBe(412);
    expect(result!.monthName).toBe('Frostmoon');
    expect(result!.monthIndex).toBe(0);
    expect(result!.day).toBe(14);
    expect(result!.compact).toBe('14 Frostmoon, 412 TE');
  });

  // ─── D-04: moon phase arithmetic ─────────────────────────────────────────────

  it('moonPhases are computed correctly (dayIndex mod cycleDays)', () => {
    // position 7 → dayIndex=7, Luna cycleDays=7, phase = 7 mod 7 = 0
    const r7 = formatCalendar(7, CALENDAR);
    expect(r7!.moonPhases).toEqual([{ name: 'Luna', phase: 0 }]);
    // position 3 → dayIndex=3, phase = 3
    const r3 = formatCalendar(3, CALENDAR);
    expect(r3!.moonPhases).toEqual([{ name: 'Luna', phase: 3 }]);
  });

  // ─── D-04: weekday arithmetic (modulo guard for negative positions) ──────────

  it('weekday cycles correctly for positive positions', () => {
    // dayIndex 0 → weekdays[0] = 'Mon', dayIndex 3 → weekdays[0] again
    expect(formatCalendar(0, CALENDAR)!.weekday).toBe('Mon');
    expect(formatCalendar(1, CALENDAR)!.weekday).toBe('Tue');
    expect(formatCalendar(2, CALENDAR)!.weekday).toBe('Wed');
    expect(formatCalendar(3, CALENDAR)!.weekday).toBe('Mon');
  });

  it('weekday and moon phase handle negative dayIndex without producing negative indices (D-04 modulo guard)', () => {
    // position -1 → dayIndex = floor(-1) - 0 = -1
    // weekday = (((-1) mod 3) + 3) mod 3 = ((-1+3)) mod 3 = 2 → 'Wed'
    // moon phase = (((-1) mod 7) + 7) mod 7 = 6
    const result = formatCalendar(-1, CALENDAR);
    expect(result).not.toBeNull();
    expect(['Mon', 'Tue', 'Wed']).toContain(result!.weekday);
    expect(result!.moonPhases[0].phase).toBeGreaterThanOrEqual(0);
    expect(result!.moonPhases[0].phase).toBeLessThan(7);
  });

  // ─── D-07: structured return shape ──────────────────────────────────────────

  it('returns all required CalendarDate fields', () => {
    const result = formatCalendar(5, CALENDAR);
    expect(result).not.toBeNull();
    expect(typeof result!.era).toBe('string');
    expect(typeof result!.eraAbbr).toBe('string');
    expect(typeof result!.year).toBe('number');
    expect(typeof result!.monthName).toBe('string');
    expect(typeof result!.monthIndex).toBe('number');
    expect(typeof result!.day).toBe('number');
    // weekday is string or null
    expect(result!.weekday === null || typeof result!.weekday === 'string').toBe(true);
    expect(Array.isArray(result!.moonPhases)).toBe(true);
    expect(typeof result!.compact).toBe('string');
  });

  // ─── D-05: active era selection ─────────────────────────────────────────────

  it('selects the era with greatest startPosition <= position (D-05)', () => {
    // position 9999 → still First Age (FA), not Third Era (starts at 10000)
    const r = formatCalendar(9999, CALENDAR);
    expect(r!.eraAbbr).toBe('FA');
    // position 10001 → Third Era
    const r2 = formatCalendar(10001, CALENDAR);
    expect(r2!.eraAbbr).toBe('TE');
  });

  // ─── Edge: single-era calendar ───────────────────────────────────────────────

  it('works with a single-era calendar', () => {
    const singleEra: Calendar = {
      eras: [{ name: 'Common Era', abbr: 'CE', startPosition: 0 }],
      months: [{ name: 'Bloom', lengthDays: 365 }],
      weekdays: [],
      moons: [],
      beforeEraAbbr: 'BCE',
    };
    const result = formatCalendar(365, singleEra);
    expect(result).not.toBeNull();
    expect(result!.eraAbbr).toBe('CE');
    expect(result!.year).toBe(2);
  });

  // ─── CR-01: malformed-calendar self-guard (public share path) ────────────────
  // The public share schema does not enforce non-empty arrays / positive lengths;
  // formatCalendar must degrade to null (raw-numeric fallback) rather than emit
  // NaN/Infinity dates to an unauthenticated visitor.

  it('CR-01: returns null when months is empty (yearLen === 0 → no NaN/Infinity)', () => {
    const bad: Calendar = {
      eras: [{ name: 'Era', abbr: 'E', startPosition: 0 }],
      months: [],
      weekdays: [],
      moons: [],
      beforeEraAbbr: 'BE',
    };
    expect(formatCalendar(100, bad)).toBeNull();
    expect(formatCalendar(-100, bad)).toBeNull();
  });

  it('CR-01: returns null when all month lengths sum to zero', () => {
    const bad: Calendar = {
      eras: [{ name: 'Era', abbr: 'E', startPosition: 0 }],
      months: [{ name: 'Void', lengthDays: 0 }],
      weekdays: [],
      moons: [],
      beforeEraAbbr: 'BE',
    };
    expect(formatCalendar(5, bad)).toBeNull();
  });

  it('CR-01: returns null when eras is empty', () => {
    const bad: Calendar = {
      eras: [],
      months: [{ name: 'Frostmoon', lengthDays: 30 }],
      weekdays: [],
      moons: [],
      beforeEraAbbr: 'BE',
    };
    expect(formatCalendar(10, bad)).toBeNull();
  });

  it('CR-01: skips degenerate moons (cycleDays <= 0) without emitting NaN phases', () => {
    const withBadMoon: Calendar = {
      eras: [{ name: 'Era', abbr: 'E', startPosition: 0 }],
      months: [{ name: 'Frostmoon', lengthDays: 30 }],
      weekdays: [],
      moons: [
        { name: 'Dead', cycleDays: 0 },
        { name: 'Luna', cycleDays: 7 },
      ],
      beforeEraAbbr: 'BE',
    };
    const result = formatCalendar(10, withBadMoon);
    expect(result).not.toBeNull();
    expect(result!.moonPhases).toHaveLength(1);
    expect(result!.moonPhases[0].name).toBe('Luna');
    expect(Number.isFinite(result!.moonPhases[0].phase)).toBe(true);
  });
});
