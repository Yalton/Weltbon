import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useCalendar } from '../hooks/useCalendar';
import { formatCalendar } from '../lib/calendarFormat';
import type { Calendar } from '../lib/calendarFormat';
import { parsePosition } from '../lib/parsePosition';
import { EmptyState } from '../components/EmptyState';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Loading } from '../components/ui/Loading';

const COPY = {
  PAGE_HEADING: 'Calendar',
  PAGE_SUBTITLE:
    "Define this universe's in-world calendar. Timeline positions will display as dates everywhere they appear. Editing is non-destructive — your event positions never change.",
  CTA_ADD: 'Add calendar',
  CTA_SAVE: 'Save calendar',
  CTA_DISCARD: 'Discard changes',
  SECTION_ERAS: 'Eras',
  SECTION_MONTHS: 'Months',
  SECTION_WEEKDAYS: 'Weekdays',
  SECTION_MOONS: 'Moons (optional)',
  ADD_ERA: 'Add era',
  ADD_MONTH: 'Add month',
  ADD_WEEKDAY: 'Add weekday',
  ADD_MOON: 'Add moon',
  LABEL_NAME: 'Name',
  LABEL_ABBR: 'Abbreviation',
  LABEL_START_POSITION: 'Start position',
  LABEL_LENGTH_DAYS: 'Length (days)',
  LABEL_CYCLE_DAYS: 'Cycle (days)',
  LABEL_BEFORE_ERA_ABBR: 'Before-era abbreviation',
  BEFORE_ERA_HINT:
    'Shown for dates before the earliest era, counting down (e.g. "250 BE").',
  PREVIEW_LABEL: 'Preview',
  PREVIEW_LINE: (position: number, formatted: string) =>
    `Position ${position} → ${formatted}`,
  EMPTY_HEADING: 'No calendar yet',
  EMPTY_BODY:
    'This universe uses the abstract numeric timeline. Define a calendar to show in-world dates like "14 Frostmoon, 412 TE" wherever a position appears.',
  EMPTY_ACTION: 'Add calendar',
  VALIDATION_EMPTY_MONTHS: 'Add at least one month before saving.',
  VALIDATION_LENGTH_POSITIVE: 'Length must be a positive whole number.',
  VALIDATION_ERA_ORDER: 'Era start positions must increase in order.',
  VALIDATION_INVALID_NUMBER: 'Enter a valid number (e.g. 412 or -10000).',
  SAVE_FAILED: "Couldn't save calendar. Try again.",
  REMOVE_CONFIRM_TITLE: 'Remove calendar?',
  REMOVE_CONFIRM_BODY:
    'Dates will revert to raw numbers everywhere. Your event positions are not affected.',
  REMOVE_CONFIRM_LABEL: 'Remove calendar',
  REMOVE_CANCEL_LABEL: 'Keep calendar',
} as const;


function newRowId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

interface EraRow {
  rowId: string;
  name: string;
  abbr: string;
  startPosition: string;
}

interface MonthRow {
  rowId: string;
  name: string;
  lengthDays: string;
}

interface WeekdayRow {
  rowId: string;
  name: string;
}

interface MoonRow {
  rowId: string;
  name: string;
  cycleDays: string;
}

// ─── Array-move helper (for reorder controls) ───────────────────────────────

function arrayMove<T>(arr: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) {
    return arr;
  }
  const result = [...arr];
  const [item] = result.splice(from, 1);
  result.splice(to, 0, item);
  return result;
}


function draftToCalendar(
  eras: EraRow[],
  months: MonthRow[],
  weekdays: WeekdayRow[],
  moons: MoonRow[],
  beforeEraAbbr: string,
): Calendar {
  return {
    eras: eras.map((r) => ({
      name: r.name,
      abbr: r.abbr,
      startPosition: Number(r.startPosition) || 0,
    })),
    months: months.map((r) => ({
      name: r.name,
      lengthDays: Number(r.lengthDays) || 1,
    })),
    weekdays: weekdays.map((r) => r.name).filter(Boolean),
    moons: moons.map((r) => ({
      name: r.name,
      cycleDays: Number(r.cycleDays) || 1,
    })),
    beforeEraAbbr,
  };
}


function calendarToDraft(cal: Calendar): {
  eras: EraRow[];
  months: MonthRow[];
  weekdays: WeekdayRow[];
  moons: MoonRow[];
  beforeEraAbbr: string;
} {
  return {
    eras: cal.eras.map((e) => ({
      rowId: newRowId(),
      name: e.name,
      abbr: e.abbr,
      startPosition: String(e.startPosition),
    })),
    months: cal.months.map((m) => ({
      rowId: newRowId(),
      name: m.name,
      lengthDays: String(m.lengthDays),
    })),
    weekdays: cal.weekdays.map((w) => ({ rowId: newRowId(), name: w })),
    moons: cal.moons.map((m) => ({
      rowId: newRowId(),
      name: m.name,
      cycleDays: String(m.cycleDays),
    })),
    beforeEraAbbr: cal.beforeEraAbbr,
  };
}


export function CalendarEditor() {
  const { uid } = useParams<{ uid: string }>();
  const { calendar, setCalendar, isLoading, isPending } = useCalendar(uid ?? '');

  const [editing, setEditing] = useState(false);

  const [eras, setEras] = useState<EraRow[]>([]);
  const [months, setMonths] = useState<MonthRow[]>([]);
  const [weekdays, setWeekdays] = useState<WeekdayRow[]>([]);
  const [moons, setMoons] = useState<MoonRow[]>([]);
  const [beforeEraAbbr, setBeforeEraAbbr] = useState('');

  const [monthsError, setMonthsError] = useState<string | null>(null);
  const [eraOrderError, setEraOrderError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Per-field parse errors (keyed by rowId)
  const [eraStartErrors, setEraStartErrors] = useState<Record<string, string>>({});
  const [monthLengthErrors, setMonthLengthErrors] = useState<Record<string, string>>({});
  const [moonCycleErrors, setMoonCycleErrors] = useState<Record<string, string>>({});

  const [previewInput, setPreviewInput] = useState('412');

  // Remove-calendar confirm dialog
  const [removeOpen, setRemoveOpen] = useState(false);

  useEffect(() => {
    if (calendar !== null) {
      const draft = calendarToDraft(calendar);
      setEras(draft.eras);
      setMonths(draft.months);
      setWeekdays(draft.weekdays);
      setMoons(draft.moons);
      setBeforeEraAbbr(draft.beforeEraAbbr);
      setEditing(true);
    } else {
      setEditing(false);
    }
  }, [calendar]);

  const startEditing = () => {
    setEras([{ rowId: newRowId(), name: '', abbr: '', startPosition: '0' }]);
    setMonths([{ rowId: newRowId(), name: '', lengthDays: '30' }]);
    setWeekdays([]);
    setMoons([]);
    setBeforeEraAbbr('BE');
    setMonthsError(null);
    setEraOrderError(null);
    setSaveError(null);
    setEraStartErrors({});
    setMonthLengthErrors({});
    setMoonCycleErrors({});
    setEditing(true);
  };

  const handleDiscard = () => {
    if (calendar !== null) {
      const draft = calendarToDraft(calendar);
      setEras(draft.eras);
      setMonths(draft.months);
      setWeekdays(draft.weekdays);
      setMoons(draft.moons);
      setBeforeEraAbbr(draft.beforeEraAbbr);
    } else {
      setEditing(false);
    }
    setMonthsError(null);
    setEraOrderError(null);
    setSaveError(null);
    setEraStartErrors({});
    setMonthLengthErrors({});
    setMoonCycleErrors({});
  };

  const validate = (): boolean => {
    let valid = true;

    const newEraErrors: Record<string, string> = {};
    for (const row of eras) {
      const p = parsePosition(row.startPosition);
      if (!p.ok) {
        newEraErrors[row.rowId] = COPY.VALIDATION_INVALID_NUMBER;
        valid = false;
      }
    }
    setEraStartErrors(newEraErrors);

    const newMonthErrors: Record<string, string> = {};
    for (const row of months) {
      const n = Number(row.lengthDays);
      if (!Number.isInteger(n) || n <= 0) {
        newMonthErrors[row.rowId] = COPY.VALIDATION_LENGTH_POSITIVE;
        valid = false;
      }
    }
    setMonthLengthErrors(newMonthErrors);

    const newMoonErrors: Record<string, string> = {};
    for (const row of moons) {
      const n = Number(row.cycleDays);
      if (!Number.isInteger(n) || n <= 0) {
        newMoonErrors[row.rowId] = COPY.VALIDATION_INVALID_NUMBER;
        valid = false;
      }
    }
    setMoonCycleErrors(newMoonErrors);

    if (months.length === 0) {
      setMonthsError(COPY.VALIDATION_EMPTY_MONTHS);
      valid = false;
    } else {
      setMonthsError(null);
    }

    if (Object.keys(newEraErrors).length === 0 && eras.length > 1) {
      const positions = eras.map((e) => parsePosition(e.startPosition))
        .filter((r): r is { ok: true; value: number } => r.ok)
        .map((r) => r.value);
      let monotonic = true;
      for (let i = 1; i < positions.length; i++) {
        if (positions[i] <= positions[i - 1]) {
          monotonic = false;
          break;
        }
      }
      if (!monotonic) {
        setEraOrderError(COPY.VALIDATION_ERA_ORDER);
        valid = false;
      } else {
        setEraOrderError(null);
      }
    } else if (Object.keys(newEraErrors).length === 0) {
      setEraOrderError(null);
    }

    return valid;
  };

  const handleSave = async () => {
    setSaveError(null);
    if (!validate()) return;
    const draft = draftToCalendar(eras, months, weekdays, moons, beforeEraAbbr);
    try {
      await setCalendar(draft);
    } catch {
      setSaveError(COPY.SAVE_FAILED);
    }
  };

  const handleRemove = async () => {
    try {
      await setCalendar(null);
      setEditing(false);
    } catch {
      setSaveError(COPY.SAVE_FAILED);
    }
  };

  const previewPosition = parsePosition(previewInput);
  const draftCalendar: Calendar | null =
    editing && months.length > 0 && eras.length > 0
      ? draftToCalendar(eras, months, weekdays, moons, beforeEraAbbr)
      : null;
  const previewFormatted =
    previewPosition.ok && draftCalendar
      ? formatCalendar(previewPosition.value, draftCalendar)?.compact ?? String(previewPosition.value)
      : previewPosition.ok
        ? String(previewPosition.value)
        : '';

  if (isLoading) {
    return <Loading />;
  }

  if (!editing && calendar === null) {
    return (
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-semibold tracking-tight">{COPY.PAGE_HEADING}</h1>
        <p className="mt-2 text-sm text-ink-secondary">{COPY.PAGE_SUBTITLE}</p>
        <EmptyState
          title={COPY.EMPTY_HEADING}
          body={COPY.EMPTY_BODY}
          action={
            <button
              type="button"
              onClick={startEditing}
              className="px-3 py-1.5 text-sm rounded-md btn-accent"
            >
              {COPY.EMPTY_ACTION}
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-semibold tracking-tight">{COPY.PAGE_HEADING}</h1>
      <p className="mt-2 text-sm text-ink-secondary">{COPY.PAGE_SUBTITLE}</p>

      <div className="mt-6 space-y-6">

        {/* ── Eras section ──────────────────────────────────────────── */}
        <div>
          <h2 className="text-lg font-medium mb-2">{COPY.SECTION_ERAS}</h2>
          <div className="space-y-2">
            {eras.map((row, idx) => (
              <div key={row.rowId} className="flex items-center gap-2">
                <input
                  type="text"
                  value={row.name}
                  onChange={(e) =>
                    setEras((rs) =>
                      rs.map((r) => r.rowId === row.rowId ? { ...r, name: e.target.value } : r)
                    )
                  }
                  placeholder={COPY.LABEL_NAME}
                  aria-label={`${COPY.LABEL_NAME} for era ${idx + 1}`}
                  className="flex-1 rounded-md border border-line bg-transparent px-2 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)]"
                />
                <input
                  type="text"
                  value={row.abbr}
                  onChange={(e) =>
                    setEras((rs) =>
                      rs.map((r) => r.rowId === row.rowId ? { ...r, abbr: e.target.value } : r)
                    )
                  }
                  placeholder={COPY.LABEL_ABBR}
                  aria-label={`${COPY.LABEL_ABBR} for era ${idx + 1}`}
                  className="w-20 rounded-md border border-line bg-transparent px-2 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)]"
                />
                <input
                  type="text"
                  value={row.startPosition}
                  onChange={(e) => {
                    setEras((rs) =>
                      rs.map((r) => r.rowId === row.rowId ? { ...r, startPosition: e.target.value } : r)
                    );
                    setEraStartErrors((prev) => { const n = { ...prev }; delete n[row.rowId]; return n; });
                  }}
                  placeholder={COPY.LABEL_START_POSITION}
                  aria-label={`${COPY.LABEL_START_POSITION} for era ${idx + 1}`}
                  className="w-28 rounded-md border border-line bg-transparent px-2 py-1.5 text-sm font-mono outline-none focus:border-[color:var(--color-accent)]"
                />
                <button
                  type="button"
                  onClick={() =>
                    setEras((rs) => arrayMove(rs, idx, idx - 1))
                  }
                  disabled={idx === 0}
                  aria-label="Move era up"
                  className="shrink-0 text-ink-muted hover:text-ink text-sm disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setEras((rs) => arrayMove(rs, idx, idx + 1))
                  }
                  disabled={idx === eras.length - 1}
                  aria-label="Move era down"
                  className="shrink-0 text-ink-muted hover:text-ink text-sm disabled:opacity-30"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setEras((rs) => rs.filter((r) => r.rowId !== row.rowId))
                  }
                  aria-label="Remove era"
                  className="shrink-0 text-ink-muted hover:text-red-500 text-sm"
                >
                  &times;
                </button>
                {eraStartErrors[row.rowId] && (
                  <p className="text-xs text-red-500 mt-0.5" role="alert">
                    {eraStartErrors[row.rowId]}
                  </p>
                )}
              </div>
            ))}
          </div>
          {eraOrderError && (
            <p className="mt-1 text-xs text-red-500" role="alert">{eraOrderError}</p>
          )}
          <button
            type="button"
            onClick={() =>
              setEras((rs) => [
                ...rs,
                { rowId: newRowId(), name: '', abbr: '', startPosition: '' },
              ])
            }
            className="mt-2 text-sm text-ink-muted hover:text-ink"
          >
            + {COPY.ADD_ERA}
          </button>
        </div>

        {/* ── Months section ────────────────────────────────────────── */}
        <div>
          <h2 className="text-lg font-medium mb-2">{COPY.SECTION_MONTHS}</h2>
          <div className="space-y-2">
            {months.map((row, idx) => (
              <div key={row.rowId} className="flex items-center gap-2">
                <input
                  type="text"
                  value={row.name}
                  onChange={(e) =>
                    setMonths((rs) =>
                      rs.map((r) => r.rowId === row.rowId ? { ...r, name: e.target.value } : r)
                    )
                  }
                  placeholder={COPY.LABEL_NAME}
                  aria-label={`${COPY.LABEL_NAME} for month ${idx + 1}`}
                  className="flex-1 rounded-md border border-line bg-transparent px-2 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)]"
                />
                <input
                  type="text"
                  value={row.lengthDays}
                  onChange={(e) => {
                    setMonths((rs) =>
                      rs.map((r) => r.rowId === row.rowId ? { ...r, lengthDays: e.target.value } : r)
                    );
                    setMonthLengthErrors((prev) => { const n = { ...prev }; delete n[row.rowId]; return n; });
                  }}
                  placeholder={COPY.LABEL_LENGTH_DAYS}
                  aria-label={`${COPY.LABEL_LENGTH_DAYS} for month ${idx + 1}`}
                  className="w-28 rounded-md border border-line bg-transparent px-2 py-1.5 text-sm font-mono outline-none focus:border-[color:var(--color-accent)]"
                />
                <button
                  type="button"
                  onClick={() =>
                    setMonths((rs) => arrayMove(rs, idx, idx - 1))
                  }
                  disabled={idx === 0}
                  aria-label="Move month up"
                  className="shrink-0 text-ink-muted hover:text-ink text-sm disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setMonths((rs) => arrayMove(rs, idx, idx + 1))
                  }
                  disabled={idx === months.length - 1}
                  aria-label="Move month down"
                  className="shrink-0 text-ink-muted hover:text-ink text-sm disabled:opacity-30"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setMonths((rs) => rs.filter((r) => r.rowId !== row.rowId))
                  }
                  aria-label="Remove month"
                  className="shrink-0 text-ink-muted hover:text-red-500 text-sm"
                >
                  &times;
                </button>
                {monthLengthErrors[row.rowId] && (
                  <p className="text-xs text-red-500 mt-0.5" role="alert">
                    {monthLengthErrors[row.rowId]}
                  </p>
                )}
              </div>
            ))}
          </div>
          {monthsError && (
            <p className="mt-1 text-xs text-red-500" role="alert">{monthsError}</p>
          )}
          <button
            type="button"
            onClick={() =>
              setMonths((rs) => [
                ...rs,
                { rowId: newRowId(), name: '', lengthDays: '30' },
              ])
            }
            className="mt-2 text-sm text-ink-muted hover:text-ink"
          >
            + {COPY.ADD_MONTH}
          </button>
        </div>

        {/* ── Weekdays section ──────────────────────────────────────── */}
        <div>
          <h2 className="text-lg font-medium mb-2">{COPY.SECTION_WEEKDAYS}</h2>
          <div className="space-y-2">
            {weekdays.map((row, idx) => (
              <div key={row.rowId} className="flex items-center gap-2">
                <input
                  type="text"
                  value={row.name}
                  onChange={(e) =>
                    setWeekdays((rs) =>
                      rs.map((r) => r.rowId === row.rowId ? { ...r, name: e.target.value } : r)
                    )
                  }
                  placeholder={COPY.LABEL_NAME}
                  aria-label={`${COPY.LABEL_NAME} for weekday ${idx + 1}`}
                  className="flex-1 rounded-md border border-line bg-transparent px-2 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)]"
                />
                <button
                  type="button"
                  onClick={() =>
                    setWeekdays((rs) => arrayMove(rs, idx, idx - 1))
                  }
                  disabled={idx === 0}
                  aria-label="Move weekday up"
                  className="shrink-0 text-ink-muted hover:text-ink text-sm disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setWeekdays((rs) => arrayMove(rs, idx, idx + 1))
                  }
                  disabled={idx === weekdays.length - 1}
                  aria-label="Move weekday down"
                  className="shrink-0 text-ink-muted hover:text-ink text-sm disabled:opacity-30"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setWeekdays((rs) => rs.filter((r) => r.rowId !== row.rowId))
                  }
                  aria-label="Remove weekday"
                  className="shrink-0 text-ink-muted hover:text-red-500 text-sm"
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() =>
              setWeekdays((rs) => [...rs, { rowId: newRowId(), name: '' }])
            }
            className="mt-2 text-sm text-ink-muted hover:text-ink"
          >
            + {COPY.ADD_WEEKDAY}
          </button>
        </div>

        {/* ── Moons section (unordered — no reorder) ────────────────── */}
        <div>
          <h2 className="text-lg font-medium mb-2">{COPY.SECTION_MOONS}</h2>
          <div className="space-y-2">
            {moons.map((row, idx) => (
              <div key={row.rowId} className="flex items-center gap-2">
                <input
                  type="text"
                  value={row.name}
                  onChange={(e) =>
                    setMoons((rs) =>
                      rs.map((r) => r.rowId === row.rowId ? { ...r, name: e.target.value } : r)
                    )
                  }
                  placeholder={COPY.LABEL_NAME}
                  aria-label={`${COPY.LABEL_NAME} for moon ${idx + 1}`}
                  className="flex-1 rounded-md border border-line bg-transparent px-2 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)]"
                />
                <input
                  type="text"
                  value={row.cycleDays}
                  onChange={(e) => {
                    setMoons((rs) =>
                      rs.map((r) => r.rowId === row.rowId ? { ...r, cycleDays: e.target.value } : r)
                    );
                    setMoonCycleErrors((prev) => { const n = { ...prev }; delete n[row.rowId]; return n; });
                  }}
                  placeholder={COPY.LABEL_CYCLE_DAYS}
                  aria-label={`${COPY.LABEL_CYCLE_DAYS} for moon ${idx + 1}`}
                  className="w-28 rounded-md border border-line bg-transparent px-2 py-1.5 text-sm font-mono outline-none focus:border-[color:var(--color-accent)]"
                />
                <button
                  type="button"
                  onClick={() =>
                    setMoons((rs) => rs.filter((r) => r.rowId !== row.rowId))
                  }
                  aria-label="Remove moon"
                  className="shrink-0 text-ink-muted hover:text-red-500 text-sm"
                >
                  &times;
                </button>
                {moonCycleErrors[row.rowId] && (
                  <p className="text-xs text-red-500 mt-0.5" role="alert">
                    {moonCycleErrors[row.rowId]}
                  </p>
                )}
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() =>
              setMoons((rs) => [
                ...rs,
                { rowId: newRowId(), name: '', cycleDays: '28' },
              ])
            }
            className="mt-2 text-sm text-ink-muted hover:text-ink"
          >
            + {COPY.ADD_MOON}
          </button>
        </div>

        {/* ── Before-era abbreviation ────────────────────────────────── */}
        <div>
          <label
            htmlFor="before-era-abbr"
            className="block text-sm font-medium mb-1"
          >
            {COPY.LABEL_BEFORE_ERA_ABBR}
          </label>
          <input
            id="before-era-abbr"
            type="text"
            value={beforeEraAbbr}
            onChange={(e) => setBeforeEraAbbr(e.target.value)}
            placeholder="BE"
            className="w-32 rounded-md border border-line bg-transparent px-2 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)]"
          />
          <p className="mt-1 text-xs text-ink-muted">{COPY.BEFORE_ERA_HINT}</p>
        </div>

        {/* ── Live preview ───────────────────────────────────────────── */}
        <div>
          <h2 className="text-lg font-medium mb-2">{COPY.PREVIEW_LABEL}</h2>
          <input
            type="text"
            value={previewInput}
            onChange={(e) => setPreviewInput(e.target.value)}
            placeholder="412"
            aria-label="Preview position"
            className="w-32 rounded-md border border-line bg-transparent px-2 py-1.5 text-sm font-mono tabular-nums outline-none focus:border-[color:var(--color-accent)]"
          />
          {previewPosition.ok && previewFormatted && (
            <p className="mt-1 text-xs text-ink-muted">
              <span className="tabular-nums">
                {COPY.PREVIEW_LINE(previewPosition.value, previewFormatted)}
              </span>
            </p>
          )}
        </div>

        {/* ── Save error ─────────────────────────────────────────────── */}
        {saveError && (
          <p className="text-xs text-red-500" role="alert">{saveError}</p>
        )}

        {/* ── Action buttons ─────────────────────────────────────────── */}
        <div className="flex items-center gap-3 pt-4 border-t border-line">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={isPending}
            className="px-3 py-1.5 text-sm rounded-md btn-accent disabled:opacity-50"
          >
            {isPending ? 'Saving…' : calendar === null ? COPY.CTA_ADD : COPY.CTA_SAVE}
          </button>
          <button
            type="button"
            onClick={handleDiscard}
            disabled={isPending}
            className="px-3 py-1.5 text-sm rounded-md border border-line-strong disabled:opacity-50"
          >
            {COPY.CTA_DISCARD}
          </button>
          {calendar !== null && (
            <button
              type="button"
              onClick={() => setRemoveOpen(true)}
              disabled={isPending}
              className="ml-auto px-3 py-1.5 text-sm rounded-md border border-line-strong text-ink-secondary hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50"
            >
              Remove calendar
            </button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={COPY.REMOVE_CONFIRM_TITLE}
        body={COPY.REMOVE_CONFIRM_BODY}
        confirmLabel={COPY.REMOVE_CONFIRM_LABEL}
        cancelLabel={COPY.REMOVE_CANCEL_LABEL}
        onConfirm={handleRemove}
      />
    </div>
  );
}
