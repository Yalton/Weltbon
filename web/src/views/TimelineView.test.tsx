import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';


// Mock hooks BEFORE importing TimelineView.
const windowState: { window: { start: number; end: number } | null } = {
  window: null,
};
const windowLoadingRef = { current: false };
vi.mock('../hooks/useTimelineWindow', () => ({
  useTimelineWindow: () => ({
    window: windowState.window,
    setWindow: vi.fn(),
    isLoading: windowLoadingRef.current,
    isPending: false,
  }),
}));

const pinsState: {
  data: Array<{
    id: string;
    entryId: string;
    label: string;
    position: number;
    precision: 'exact' | 'approximate' | 'era';
  }>;
  isLoading: boolean;
} = {
  data: [],
  isLoading: false,
};
vi.mock('../hooks/useTimelinePins', () => ({
  useTimelinePins: () => ({
    data: pinsState.data,
    isLoading: pinsState.isLoading,
  }),
  useUpsertTimelinePin: () => ({
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
  }),
}));

// Content-Forward Views §6 — TimelineView resolves pin cover art from the entries LIST cache
// via useEntryMedallions (the /timeline/pins projection carries no cover). Mocked at the
// module boundary: this suite stubs no `api`, so the real hook's query would sit pending and
// tell us nothing. The hook itself is covered by useEntryMedallions.test.tsx; what
// TimelineView owes is the wiring, asserted below via the stub's data-medallion-count.
const medallionsStub = new Map<string, unknown>([
  ['E1', { title: 'Aldric', entryType: 'entity', icon: '', coverThumbUrl: '/thumb-1.png' }],
]);
vi.mock('../hooks/useEntryMedallions', () => ({
  useEntryMedallions: () => medallionsStub,
}));

// Stub the heavy children — exposes props as data-* attributes.
vi.mock('../components/TimelineCanvas', () => ({
  TimelineCanvas: (props: {
    pins: Array<{ id: string }>;
    width: number;
    height: number;
    medallions?: Map<string, unknown>;
  }) => (
    <div
      data-testid="timeline-canvas-stub"
      data-pin-count={props.pins.length}
      data-width={props.width}
      data-height={props.height}
      data-medallion-count={props.medallions?.size ?? -1}
    />
  ),
}));

vi.mock('../components/TimelineEntryPanel', () => ({
  TimelineEntryPanel: (props: { pins: Array<{ id: string }> }) => (
    <div
      data-testid="timeline-entry-panel-stub"
      data-pin-count={props.pins.length}
    />
  ),
}));

vi.mock('../components/TimelineRangeDialog', () => ({
  // The stub exposes onOpenChange so a test can dismiss the dialog the way
  // Escape, an outside click, and "Keep current range" all do — Radix routes
  // every one of them through this single callback.
  TimelineRangeDialog: (props: { open: boolean; onOpenChange: (o: boolean) => void }) =>
    props.open ? (
      <div data-testid="range-dialog-stub">
        Configure timeline range
        <button type="button" onClick={() => props.onOpenChange(false)}>
          Keep current range
        </button>
      </div>
    ) : null,
}));

vi.mock('../components/PinPopover', () => ({
  PinPopover: () => null,
}));

// Toast — keep it real so we can verify toast surfaces appear when set.
import { TimelineView } from './TimelineView';

function renderAt(path = '/universes/U1/timeline') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/universes/:uid/timeline" element={<TimelineView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('TimelineView orchestrator', () => {
  beforeEach(() => {
    windowState.window = null;
    windowLoadingRef.current = false;
    pinsState.data = [];
    pinsState.isLoading = false;
  });

  it('shows Loading… while hooks are pending', () => {
    windowLoadingRef.current = true;
    pinsState.isLoading = true;
    renderAt();
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-canvas-stub')).not.toBeInTheDocument();
  });

  it('when window is null → range dialog is rendered, canvas is not', () => {
    windowState.window = null;
    renderAt();
    expect(screen.getByTestId('range-dialog-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-canvas-stub')).not.toBeInTheDocument();
    expect(screen.queryByTestId('timeline-entry-panel-stub')).not.toBeInTheDocument();
  });

  // #30: the first-visit gate passed a no-op onOpenChange, and because Radix
  // routes Escape, outside-click, and Dialog.Close through that one callback,
  // all three were dead at once — the user could not leave the modal without
  // configuring a range.
  it('first visit: dismissing the range dialog leaves an escapable empty state', async () => {
    windowState.window = null;
    const user = userEvent.setup();
    renderAt();

    expect(screen.getByTestId('range-dialog-stub')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /keep current range/i }));

    expect(screen.queryByTestId('range-dialog-stub')).not.toBeInTheDocument();
    // Dismissing must land somewhere usable, not a blank screen.
    expect(
      screen.getByRole('button', { name: /configure timeline/i }),
    ).toBeInTheDocument();
  });

  it('first visit: the empty state can reopen the dialog', async () => {
    windowState.window = null;
    const user = userEvent.setup();
    renderAt();

    await user.click(screen.getByRole('button', { name: /keep current range/i }));
    await user.click(screen.getByRole('button', { name: /configure timeline/i }));
    expect(screen.getByTestId('range-dialog-stub')).toBeInTheDocument();
  });

  it('when window is set → canvas + entry panel are rendered, range dialog is not (initially)', () => {
    windowState.window = { start: -10000, end: 26000 };
    renderAt();
    expect(screen.getByTestId('timeline-canvas-stub')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-entry-panel-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('range-dialog-stub')).not.toBeInTheDocument();
  });

  it('pin count flows through to canvas and panel props', () => {
    windowState.window = { start: 0, end: 1000 };
    pinsState.data = [
      { id: 'p1', entryId: 'E1', label: 'A', position: 100, precision: 'exact' },
      { id: 'p2', entryId: 'E2', label: 'B', position: 200, precision: 'exact' },
      { id: 'p3', entryId: 'E3', label: 'C', position: 300, precision: 'era' },
    ];
    renderAt();
    const canvas = screen.getByTestId('timeline-canvas-stub');
    const panel = screen.getByTestId('timeline-entry-panel-stub');
    expect(canvas).toHaveAttribute('data-pin-count', '3');
    expect(panel).toHaveAttribute('data-pin-count', '3');
  });

  it('hands the canvas the entry medallions so pins can wear their cover art', () => {
    windowState.window = { start: 0, end: 1000 };
    renderAt();
    expect(screen.getByTestId('timeline-canvas-stub')).toHaveAttribute(
      'data-medallion-count',
      String(medallionsStub.size),
    );
  });

  it('clicking Configure range opens the dialog', async () => {
    windowState.window = { start: 0, end: 1000 };
    renderAt();
    expect(screen.queryByTestId('range-dialog-stub')).not.toBeInTheDocument();
    const button = screen.getByRole('button', { name: /configure range/i });
    await userEvent.click(button);
    expect(screen.getByTestId('range-dialog-stub')).toBeInTheDocument();
  });

  it('toolbar shows the Timeline heading and Configure range button when window is set', () => {
    windowState.window = { start: -1000, end: 1000 };
    renderAt();
    expect(screen.getByRole('heading', { name: /timeline/i, level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /configure range/i })).toBeInTheDocument();
  });
});
