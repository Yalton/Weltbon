import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Per-file mock of api/client — mirrors useDiagrams.test.ts convention
vi.mock('../api/client', () => ({ api: vi.fn() }));

import { api } from '../api/client';
import { DiagramList } from './DiagramList';
import type { DiagramSummary } from '../hooks/useDiagrams';

const UNIVERSE_ID = 'UNI-1';

const fixtureDiagram: DiagramSummary = {
  id: 'D1',
  universeId: UNIVERSE_ID,
  name: 'Targaryen family tree',
  description: 'The main lineage',
  createdAt: '2026-05-31T00:00:00Z',
};

const fixtureDiagram2: DiagramSummary = {
  id: 'D2',
  universeId: UNIVERSE_ID,
  name: 'Org chart',
  description: null,
  createdAt: '2026-05-31T00:01:00Z',
};

function renderDiagramList(universeId = UNIVERSE_ID) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/universes/${universeId}/diagrams`]}>
        <Routes>
          <Route path="/universes/:uid/diagrams" element={<DiagramList />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, qc };
}

describe('DiagramList', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('renders empty state with "No diagrams yet" when the universe has no diagrams', async () => {
    vi.mocked(api).mockResolvedValue([]);

    renderDiagramList();

    expect(await screen.findByText('No diagrams yet')).toBeInTheDocument();
    expect(screen.getByText(/Create a diagram to hand-position/)).toBeInTheDocument();
  });

  it('renders a row per diagram with a link to the editor route when diagrams exist', async () => {
    vi.mocked(api).mockResolvedValue([fixtureDiagram, fixtureDiagram2]);

    renderDiagramList();

    // Both diagram names appear
    expect(await screen.findByText('Targaryen family tree')).toBeInTheDocument();
    expect(screen.getByText('Org chart')).toBeInTheDocument();

    // Description of diagram 1 appears; diagram 2 has no description
    expect(screen.getByText('The main lineage')).toBeInTheDocument();

    // Each row is an anchor linking to /universes/:uid/diagrams/:did
    const links = screen.getAllByRole('link');
    const editorLinks = links.filter((l) =>
      l.getAttribute('href')?.includes('/diagrams/'),
    );
    expect(editorLinks).toHaveLength(2);
    expect(editorLinks[0].getAttribute('href')).toContain(
      `/universes/${UNIVERSE_ID}/diagrams/D1`,
    );
    expect(editorLinks[1].getAttribute('href')).toContain(
      `/universes/${UNIVERSE_ID}/diagrams/D2`,
    );
  });

  it('shows empty-name inline validation error "Enter a name for this diagram." when submitting blank', async () => {
    vi.mocked(api).mockResolvedValue([]);

    const user = userEvent.setup();
    renderDiagramList();

    // Wait for the page to load (empty state)
    await screen.findByText('No diagrams yet');

    // Open the New diagram dialog — use the page-heading CTA (first one found)
    const newBtns = screen.getAllByRole('button', { name: 'New diagram' });
    await user.click(newBtns[0]);

    // Dialog should be open — submit without entering a name
    const submitBtn = await screen.findByRole('button', { name: 'Create diagram' });
    await user.click(submitBtn);

    // Inline validation error should appear
    expect(
      await screen.findByText('Enter a name for this diagram.'),
    ).toBeInTheDocument();
  });

  it('triggers the destructive ConfirmDialog and fires the delete mutation on confirm', async () => {
    // First call: list query; second call: delete mutation (returns undefined)
    vi.mocked(api).mockImplementation(async (_path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'DELETE') {
        return undefined;
      }
      // GET — return list
      return [fixtureDiagram] as DiagramSummary[];
    });

    const user = userEvent.setup();
    renderDiagramList();

    // Wait for the diagram to render
    await screen.findByText('Targaryen family tree');

    // Click the Delete button on the row
    const deleteBtn = screen.getByRole('button', {
      name: 'Delete Targaryen family tree',
    });
    await user.click(deleteBtn);

    // The ConfirmDialog should open with the right title
    expect(
      await screen.findByText('Delete "Targaryen family tree"?'),
    ).toBeInTheDocument();

    // The dialog body confirms scope
    expect(
      screen.getByText(
        /This removes the diagram and its node positions/,
      ),
    ).toBeInTheDocument();

    // Click the confirm (destructive) Delete button inside the dialog
    const confirmBtns = screen.getAllByRole('button', { name: 'Delete' });
    // The last Delete button is the one in the ConfirmDialog (after the row's Delete btn)
    const confirmDeleteBtn = confirmBtns.find(
      (b) => b.className.includes('red-600') || b.className.includes('bg-red'),
    );
    expect(confirmDeleteBtn).toBeDefined();
    await user.click(confirmDeleteBtn!);

    // Verify the DELETE mutation was fired
    await waitFor(() => {
      const calls = vi.mocked(api).mock.calls;
      const deleted = calls.some(
        ([p, init]) =>
          typeof p === 'string' &&
          p.includes('/diagrams/D1') &&
          (init as RequestInit | undefined)?.method === 'DELETE',
      );
      expect(deleted).toBe(true);
    });
  });
});
