
// ─── Types (web-side declarations — do NOT import from api) ────────────────

export interface CalendarEra {
  name: string;
  abbr: string;
  startPosition: number;
}

export interface CalendarMonth {
  name: string;
  lengthDays: number;
}

export interface CalendarMoon {
  name: string;
  cycleDays: number;
}

export interface Calendar {
  eras: CalendarEra[];
  months: CalendarMonth[];
  weekdays: string[];
  moons: CalendarMoon[];
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
  compact: string;
}


const mod = (n: number, m: number): number => ((n % m) + m) % m;

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
  const last = months[months.length - 1];
  return { monthIndex: months.length - 1, monthName: last.name, day: last.lengthDays };
};


export function formatCalendar(
  position: number,
  calendar: Calendar | null,
): CalendarDate | null {
  if (calendar === null) return null;

  const { eras, months, weekdays, moons, beforeEraAbbr } = calendar;

  const yearLen = months.reduce((sum, m) => sum + m.lengthDays, 0);

  // CR-01 self-guard: the authenticated write path enforces non-empty eras/
  // gracefully to the raw-numeric fallback (CALENDAR-03) instead of rendering
  if (eras.length === 0 || months.length === 0 || yearLen <= 0) return null;

  // Epoch is defined as the earliest era's startPosition (D-05 / CONTEXT D-08).
  const epochStart = eras[0].startPosition;

  const dayIndex = Math.floor(position) - epochStart;

  // ── Weekday (D-04, modulo guard for negative dayIndex) ──────────────────
  const weekday = weekdays.length > 0 ? weekdays[mod(dayIndex, weekdays.length)] : null;


  // CR-01: skip degenerate moons (`cycleDays <= 0`) — `mod(x, 0)` is `NaN`.
  const moonPhases = moons
    .filter((m) => m.cycleDays > 0)
    .map((m) => ({
      name: m.name,
      phase: mod(dayIndex, m.cycleDays),
    }));

  // ── Pre-epoch positions (D-08) ───────────────────────────────────────────
  if (Math.floor(position) < epochStart) {
    // yearsBefore = ceil((epochStart - floor(position)) / yearLen)
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
