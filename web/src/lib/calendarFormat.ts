/**
 * Pure position→date renderer for fictional calendar systems.
 *
 * Per CONTEXT.md D-04..D-09: one timeline position unit = one day. All
 * arithmetic uses integer floor/mod — no floating-point date semantics.
 * No DOM, no React, no module-level side effects.
 *
 * Caller contract:
 *   - `calendar` is expected to have >= 1 era and >= 1 month with positive
 *     month lengths (enforced by the API's `calendarSchema` .refine() guards on
 *     the write path). The public share path does NOT enforce these, so as of
 *     CR-01 `formatCalendar` self-guards: a structurally unusable calendar
 *     (no eras, no months, or zero total year length) returns `null` and the
 *     caller falls back to the raw numeric position (CALENDAR-03).
 *   - `calendar === null` → returns `null` (CALENDAR-03 raw-numeric fallback).
 *   - Era `startPosition` values must be strictly increasing (D-05); the
 *     active era is the one with the greatest `startPosition <= position`.
 *   - Pre-epoch positions (before the earliest era) count DOWN via
 *     `beforeEraAbbr` (D-08): `position == epochStart - 1 → year 1 BE`.
 *   - The returned `.compact` string is `"{day} {monthName}, {year} {eraAbbr}"`.
 *     Weekday and moon phases are only in the structured parts (D-07).
 */

// ─── Types (web-side declarations — do NOT import from api) ────────────────

export interface CalendarEra {
  name: string;
  abbr: string;
  /** Absolute day-number position where this era begins (D-05). */
  startPosition: number;
}

export interface CalendarMonth {
  name: string;
  /** Fixed number of days in this month (no leap years in v1, D-04). */
  lengthDays: number;
}

export interface CalendarMoon {
  name: string;
  /** Orbital cycle in days; moon phase = dayIndex mod cycleDays (D-04). */
  cycleDays: number;
}

export interface Calendar {
  /** Ordered list of eras; must have >= 1 entry. startPosition values must be strictly increasing. */
  eras: CalendarEra[];
  /** Ordered list of months in a year; must have >= 1 entry. */
  months: CalendarMonth[];
  /** Optional weekday names in cycle order; empty = no weekday display. */
  weekdays: string[];
  /** Optional moons; empty = no moon-phase display. */
  moons: CalendarMoon[];
  /** Abbreviation for pre-epoch dates (e.g. "BE" for "Before Era"). */
  beforeEraAbbr: string;
}

export interface CalendarDate {
  era: string;
  eraAbbr: string;
  year: number;
  monthName: string;
  monthIndex: number;
  day: number;
  weekday: string | null;
  moonPhases: { name: string; phase: number }[];
  /** Compact display string, e.g. "14 Frostmoon, 412 TE" (D-07). */
  compact: string;
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

/**
 * JavaScript's `%` operator can return negative values for negative operands.
 * This always-positive modulo is required for weekday and moon-phase indices
 * when `dayIndex < 0` (pre-epoch positions, D-04 modulo guard).
 */
const mod = (n: number, m: number): number => ((n % m) + m) % m;

/**
 * Walk the ordered month list to resolve a `doy` (day-of-year, 0-indexed)
 * into `{ monthIndex, monthName, day }` (1-indexed day, per D-04).
 *
 * `doy` is always in `[0, yearLen-1]` because the caller uses
 * `dayIndex mod yearLen` — month overflow is structurally impossible (D-09).
 */
const resolveDoy = (
  doy: number,
  months: CalendarMonth[],
): { monthIndex: number; monthName: string; day: number } => {
  let remaining = doy;
  for (let i = 0; i < months.length; i++) {
    if (remaining < months[i].lengthDays) {
      return { monthIndex: i, monthName: months[i].name, day: remaining + 1 };
    }
    remaining -= months[i].lengthDays;
  }
  // Structurally unreachable: doy < yearLen by construction (D-09 lock).
  // Fallback to last day of last month to satisfy the compiler.
  const last = months[months.length - 1];
  return { monthIndex: months.length - 1, monthName: last.name, day: last.lengthDays };
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Convert a raw numeric `position` (abstract timeline day-count) to a
 * structured fictional date using the universe's `calendar` definition.
 *
 * Returns `null` when `calendar` is `null` — callers should fall back to
 * formatting the raw numeric position (CALENDAR-03).
 *
 * Example: `formatCalendar(30563, calendar)` → `{ compact: "14 Frostmoon, 412 TE", … }`
 */
export function formatCalendar(
  position: number,
  calendar: Calendar | null,
): CalendarDate | null {
  if (calendar === null) return null;

  const { eras, months, weekdays, moons, beforeEraAbbr } = calendar;

  // yearLen = total days in one year (sum of all month lengths).
  const yearLen = months.reduce((sum, m) => sum + m.lengthDays, 0);

  // CR-01 self-guard: the authenticated write path enforces non-empty eras/
  // months and positive lengths via `calendarSchema`, but the public share path
  // (`calendarResponseSchema` in routes/share.ts) does NOT. Trusting those
  // invariants here let malformed data produce literal `NaN`/`Infinity` dates
  // for unauthenticated visitors (`% 0 === NaN`, `/ 0 === Infinity`). Degrade
  // gracefully to the raw-numeric fallback (CALENDAR-03) instead of rendering
  // garbage, on both the authenticated and share surfaces.
  if (eras.length === 0 || months.length === 0 || yearLen <= 0) return null;

  // Epoch is defined as the earliest era's startPosition (D-05 / CONTEXT D-08).
  const epochStart = eras[0].startPosition;

  // Raw integer day index from the epoch.
  const dayIndex = Math.floor(position) - epochStart;

  // ── Weekday (D-04, modulo guard for negative dayIndex) ──────────────────
  const weekday = weekdays.length > 0 ? weekdays[mod(dayIndex, weekdays.length)] : null;

  // ── Moon phases (D-04, modulo guard for negative dayIndex) ───────────────
  // CR-01: skip degenerate moons (`cycleDays <= 0`) — `mod(x, 0)` is `NaN`.
  // The write path requires positive cycleDays; the share path does not.
  const moonPhases = moons
    .filter((m) => m.cycleDays > 0)
    .map((m) => ({
      name: m.name,
      phase: mod(dayIndex, m.cycleDays),
    }));

  // ── Pre-epoch positions (D-08) ───────────────────────────────────────────
  if (Math.floor(position) < epochStart) {
    // Days before the epoch are counted down using beforeEraAbbr.
    // yearsBefore = ceil((epochStart - floor(position)) / yearLen)
    // This gives year 1 BE for the last year before the epoch.
    const daysBefore = epochStart - Math.floor(position);
    const yearsBefore = Math.ceil(daysBefore / yearLen);

    // Day-of-year within the before-epoch year:
    // The Nth before-epoch year spans positions [epochStart - N*yearLen, epochStart - (N-1)*yearLen - 1].
    // doy = (yearLen - daysBefore mod yearLen) mod yearLen
    const doyRaw = mod(-daysBefore, yearLen);
    const { monthIndex, monthName, day } = resolveDoy(doyRaw, months);

    const compact = `${day} ${monthName}, ${yearsBefore} ${beforeEraAbbr}`;
    return {
      era: beforeEraAbbr,
      eraAbbr: beforeEraAbbr,
      year: yearsBefore,
      monthName,
      monthIndex,
      day,
      weekday,
      moonPhases,
      compact,
    };
  }

  // ── Active era (D-05): greatest startPosition <= position ────────────────
  let activeEra = eras[0];
  for (const era of eras) {
    if (era.startPosition <= Math.floor(position)) {
      activeEra = era;
    }
  }

  // Days elapsed since the era began.
  const daysInEra = Math.floor(position) - activeEra.startPosition;

  // yearInEra is 1-indexed (D-05): year 1 is the first year of the era.
  const yearInEra = Math.floor(daysInEra / yearLen) + 1;

  // doy = day-of-year, 0-indexed within the current year.
  const doy = daysInEra % yearLen;
  const { monthIndex, monthName, day } = resolveDoy(doy, months);

  const compact = `${day} ${monthName}, ${yearInEra} ${activeEra.abbr}`;
  return {
    era: activeEra.name,
    eraAbbr: activeEra.abbr,
    year: yearInEra,
    monthName,
    monthIndex,
    day,
    weekday,
    moonPhases,
    compact,
  };
}
