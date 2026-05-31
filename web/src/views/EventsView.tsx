import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useEvents, type EventFilters } from '../hooks/useEvents';
import { useCalendar } from '../hooks/useCalendar';
import { useEntries } from '../hooks/useEntries';
import { formatCalendar } from '../lib/calendarFormat';
import { EmptyState } from '../components/EmptyState';
import { FilterChip } from '../components/FilterChip';
import { AddEventDialog } from '../components/AddEventDialog';
import { useShareMode } from '../contexts/ShareModeContext';
import { parsePosition } from '../lib/parsePosition';

// Raw position formatter matching TimelineCanvas (CALENDAR-03 fallback).
const POSITION_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

export function EventsView() {
  // Phase 29 share-mode awareness — mirrors EntryList.
  const { uid: paramUid } = useParams<{ uid: string }>();
  const isShareMode = useShareMode();
  const uid = paramUid ?? (isShareMode ? 'share' : undefined);

  const { calendar } = useCalendar(uid!);
  const { data: entries } = useEntries(uid!);

  // ── Filter state ──────────────────────────────────────────────────────────
  const [participantId, setParticipantId] = useState<string | undefined>(undefined);
  const [eraIndex, setEraIndex] = useState<number | undefined>(undefined);
  const [fromPositionInput, setFromPositionInput] = useState('');
  const [toPositionInput, setToPositionInput] = useState('');
  const [addEventOpen, setAddEventOpen] = useState(false);

  // Participant filter dropdown state.
  const [participantDropdownOpen, setParticipantDropdownOpen] = useState(false);

  // Parse numeric range filter values.
  const fromParsed = parsePosition(fromPositionInput);
  const toParsed = parsePosition(toPositionInput);

  // Build the filters object to pass to useEvents.
  const filters: EventFilters = {};
  if (participantId) filters.participantId = participantId;

  // Era filter: map the selected era to from/to position using calendar eras.
  if (eraIndex !== undefined && calendar) {
    const era = calendar.eras[eraIndex];
    if (era) {
      filters.fromPosition = era.startPosition;
      // toPosition = next era's startPosition - 1, or undefined (open-ended) for last era.
      const nextEra = calendar.eras[eraIndex + 1];
      if (nextEra) {
        filters.toPosition = nextEra.startPosition - 1;
      }
    }
  } else {
    // Explicit range overrides era filter.
    if (fromParsed.ok) filters.fromPosition = fromParsed.value;
    if (toParsed.ok) filters.toPosition = toParsed.value;
  }

  const { data: events, isLoading } = useEvents(uid!, Object.keys(filters).length > 0 ? filters : undefined);

  const hasActiveFilters =
    !!participantId ||
    eraIndex !== undefined ||
    fromParsed.ok ||
    toParsed.ok;

  const isEmpty = !events || events.length === 0;

  // Participant name for chip display.
  const participantEntry = entries?.find((e) => e.id === participantId);
  const participantLabel = participantEntry
    ? `Participant: ${participantEntry.title}`
    : 'Participant';

  // Era label for chip display.
  const eraLabel =
    eraIndex !== undefined && calendar
      ? `Era: ${calendar.eras[eraIndex]?.name ?? String(eraIndex)}`
      : 'Era';

  const clearAllFilters = () => {
    setParticipantId(undefined);
    setEraIndex(undefined);
    setFromPositionInput('');
    setToPositionInput('');
  };

  return (
    <div className="max-w-4xl mx-auto">
      {/* Page heading + Add event CTA */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Events</h1>
        {!isShareMode && (
          <button
            type="button"
            onClick={() => setAddEventOpen(true)}
            className="rounded-md bg-[color:var(--color-accent)] text-white text-sm px-3 py-1.5"
          >
            Add event
          </button>
        )}
      </div>

      {/* Filter chips row */}
      <div className="mb-4 flex flex-wrap gap-2 items-center">
        {participantId && (
          <FilterChip
            label={participantLabel}
            onRemove={() => setParticipantId(undefined)}
          />
        )}
        {eraIndex !== undefined && (
          <FilterChip
            label={eraLabel}
            onRemove={() => setEraIndex(undefined)}
          />
        )}
        {fromParsed.ok && eraIndex === undefined && (
          <FilterChip
            label={`From: ${POSITION_FORMAT.format(fromParsed.value)}`}
            onRemove={() => setFromPositionInput('')}
          />
        )}
        {toParsed.ok && eraIndex === undefined && (
          <FilterChip
            label={`To: ${POSITION_FORMAT.format(toParsed.value)}`}
            onRemove={() => setToPositionInput('')}
          />
        )}

        {/* Filter controls (participant selector + era selector + range inputs) */}
        <div className="flex flex-wrap gap-2 items-center">
          {/* Participant filter */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setParticipantDropdownOpen((v) => !v)}
              className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 border border-dashed border-neutral-300 dark:border-neutral-700 rounded-full px-3 py-1"
            >
              Filter by participant
            </button>
            {participantDropdownOpen && (
              <div className="absolute left-0 top-full mt-1 z-10 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-md shadow-lg min-w-[200px] max-h-64 overflow-y-auto">
                {entries && entries.length > 0 ? (
                  entries.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      className="block w-full text-left px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
                      onClick={() => {
                        setParticipantId(entry.id);
                        setParticipantDropdownOpen(false);
                      }}
                    >
                      {entry.icon ? `${entry.icon} ` : ''}{entry.title}
                    </button>
                  ))
                ) : (
                  <p className="px-3 py-2 text-sm text-neutral-500">No entries</p>
                )}
              </div>
            )}
          </div>

          {/* Era filter — only visible when a calendar is defined */}
          {calendar && calendar.eras.length > 0 && (
            <select
              value={eraIndex !== undefined ? String(eraIndex) : ''}
              onChange={(e) =>
                setEraIndex(e.target.value !== '' ? Number(e.target.value) : undefined)
              }
              className="text-sm text-neutral-500 border border-dashed border-neutral-300 dark:border-neutral-700 rounded-full px-3 py-1 bg-transparent"
              aria-label="Filter by era"
            >
              <option value="">Filter by era</option>
              {calendar.eras.map((era, idx) => (
                <option key={idx} value={idx}>
                  {era.name}
                </option>
              ))}
            </select>
          )}

          {/* From / To position range inputs (hidden when era filter active) */}
          {eraIndex === undefined && (
            <>
              <input
                type="text"
                value={fromPositionInput}
                onChange={(e) => setFromPositionInput(e.target.value)}
                placeholder="From position"
                className="text-sm border border-dashed border-neutral-300 dark:border-neutral-700 rounded-full px-3 py-1 bg-transparent font-mono w-32"
              />
              <input
                type="text"
                value={toPositionInput}
                onChange={(e) => setToPositionInput(e.target.value)}
                placeholder="To position"
                className="text-sm border border-dashed border-neutral-300 dark:border-neutral-700 rounded-full px-3 py-1 bg-transparent font-mono w-32"
              />
            </>
          )}
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <p className="text-sm text-neutral-500">Loading...</p>
      ) : isEmpty && hasActiveFilters ? (
        <EmptyState
          title="No events match"
          body="Try removing a filter to see more events."
        />
      ) : isEmpty ? (
        <EmptyState
          title="No events yet"
          body="Pin an entry to the timeline, or add an event to start building your universe's chronology."
          action={
            !isShareMode ? (
              <button
                type="button"
                onClick={() => setAddEventOpen(true)}
                className="bg-[color:var(--color-accent)] text-white text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
              >
                Add event
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-1">
          {/* Table header */}
          <div className="flex items-center gap-4 px-3 py-1 text-xs text-neutral-500 border-b border-neutral-200 dark:border-neutral-800">
            <span className="flex-1">Event</span>
            <span className="w-40 text-right tabular-nums">Date / Position</span>
          </div>
          {events!.map((event) => {
            const dateStr =
              formatCalendar(event.position, calendar)?.compact ??
              POSITION_FORMAT.format(event.position);

            return (
              <Link
                key={event.id}
                to={`/universes/${uid}/entries/${event.entryId}`}
                className="flex items-center gap-4 px-3 py-2 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
              >
                <span className="flex-1 text-sm">
                  {event.entryIcon && (
                    <span className="mr-1">{event.entryIcon}</span>
                  )}
                  {event.entryTitle ?? event.label}
                </span>
                <span
                  className={`w-40 text-right text-sm text-neutral-500${
                    !formatCalendar(event.position, calendar) ? ' tabular-nums font-mono' : ''
                  }`}
                >
                  {dateStr}
                </span>
              </Link>
            );
          })}
        </div>
      )}

      {/* Add event dialog */}
      {!isShareMode && (
        <AddEventDialog
          open={addEventOpen}
          onOpenChange={setAddEventOpen}
          universeId={uid!}
          mode="create"
        />
      )}

      {/* Close participant dropdown when clicking outside */}
      {participantDropdownOpen && (
        <div
          className="fixed inset-0 z-[9]"
          onClick={() => setParticipantDropdownOpen(false)}
        />
      )}
    </div>
  );
}
