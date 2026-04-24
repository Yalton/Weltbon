import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock useNavigate BEFORE importing GraphView.
const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

// Mock api client — GraphView uses useGraphData (GET) and two mutations.
vi.mock('../api/client', () => ({ api: vi.fn() }));
import { api } from '../api/client';
import { GraphView } from './GraphView';
import type { GraphDataResponse, GraphNode, GraphEdge } from '../hooks/useGraphData';

function makeNode(id: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    title: `Node ${id}`,
    entryType: 'concept',
    summary: '',
    icon: '',
    ...overrides,
  };
}

function makeEdge(id: string, source: string, target: string): GraphEdge {
  return { id, source, target, label: '', bidirectional: false };
}

function renderGraphView(universeId = 'UNI') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/universes/${universeId}/graph`]}>
        <Routes>
          <Route path="/universes/:uid/graph" element={<GraphView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('GraphView', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
    navigateMock.mockReset();
  });

  it('renders EmptyState when the universe has zero nodes', async () => {
    const response: GraphDataResponse = { nodes: [], edges: [], positions: [] };
    vi.mocked(api).mockResolvedValue(response);

    renderGraphView();

    expect(await screen.findByText(/no entries yet/i)).toBeInTheDocument();
  });

  it('renders the GraphCanvas with every node when the universe is small', async () => {
    const response: GraphDataResponse = {
      nodes: [makeNode('A'), makeNode('B'), makeNode('C')],
      edges: [makeEdge('e1', 'A', 'B'), makeEdge('e2', 'B', 'C')],
      positions: [],
    };
    vi.mocked(api).mockResolvedValue(response);

    const { container } = renderGraphView();

    await waitFor(() => {
      expect(container.querySelectorAll('circle')).toHaveLength(3);
    });
    expect(container.querySelectorAll('line')).toHaveLength(2);
  });

  it('renders the subgraph filter banner when the universe has more than 300 nodes', async () => {
    const nodes = Array.from({ length: 301 }, (_, i) => makeNode(`n${i}`));
    const response: GraphDataResponse = { nodes, edges: [], positions: [] };
    vi.mocked(api).mockResolvedValue(response);

    renderGraphView();

    // Banner text lives inside a <p> inside the filter region; the full
    // string ("This universe has 301 entries — too many to render at once.")
    // is one match. We look up the banner by the "too many to render" phrase
    // which only appears in the subgraph filter.
    expect(await screen.findByText(/too many to render at once/i)).toBeInTheDocument();
    // And the count is embedded in that same node:
    expect(screen.getByText(/this universe has 301 entries/i)).toBeInTheDocument();
  });

  it('renders a reduced node set after the user picks a focus entry in the subgraph filter', async () => {
    // 301 nodes: n0 is connected to n1 and n2 only; the rest are isolated.
    const nodes = Array.from({ length: 301 }, (_, i) => makeNode(`n${i}`));
    const edges = [makeEdge('e1', 'n0', 'n1'), makeEdge('e2', 'n0', 'n2')];
    vi.mocked(api).mockResolvedValue({ nodes, edges, positions: [] });

    const { container } = renderGraphView();

    const focusSelect = await screen.findByRole('combobox', { name: /focus entry/i });
    await userEvent.selectOptions(focusSelect, 'n0');

    // After picking n0 with default hops=1, GraphCanvas should render only n0,n1,n2 (3 circles).
    await waitFor(() => {
      expect(container.querySelectorAll('circle')).toHaveLength(3);
    });
  });

  it('navigates to the entry detail route when a node is clicked without shift', async () => {
    const response: GraphDataResponse = {
      nodes: [makeNode('A'), makeNode('B')],
      edges: [makeEdge('e1', 'A', 'B')],
      positions: [],
    };
    vi.mocked(api).mockResolvedValue(response);

    const { container } = renderGraphView('U42');

    await waitFor(() => {
      expect(container.querySelectorAll('circle')).toHaveLength(2);
    });

    const firstCircle = container.querySelectorAll('circle')[0] as SVGCircleElement;
    firstCircle.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: false }));

    expect(navigateMock).toHaveBeenCalledWith(
      expect.stringMatching(/^\/universes\/U42\/entries\/[AB]$/),
    );
  });

  it('calls the pin mutation when a node is shift+clicked', async () => {
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (!init || init.method === undefined || init.method === 'GET') {
        return {
          nodes: [makeNode('A'), makeNode('B')],
          edges: [makeEdge('e1', 'A', 'B')],
          positions: [],
        } as GraphDataResponse;
      }
      if (init.method === 'POST') return { entryId: 'A', x: 0, y: 0 };
      return undefined;
    });

    const { container } = renderGraphView();

    await waitFor(() => {
      expect(container.querySelectorAll('circle')).toHaveLength(2);
    });

    const firstCircle = container.querySelectorAll('circle')[0] as SVGCircleElement;
    firstCircle.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));

    await waitFor(() => {
      const calls = vi.mocked(api).mock.calls;
      const posted = calls.some(
        ([p, init]) => p.endsWith('/graph-positions') && init?.method === 'POST',
      );
      expect(posted).toBe(true);
    });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('fires the reset-layout DELETE when the Reset layout button is clicked', async () => {
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (!init || init.method === undefined || init.method === 'GET') {
        return {
          nodes: [makeNode('A'), makeNode('B')],
          edges: [],
          positions: [],
        } as GraphDataResponse;
      }
      if (init.method === 'DELETE') return undefined;
      return undefined;
    });

    renderGraphView();

    const resetButton = await screen.findByRole('button', { name: /reset layout/i });
    await userEvent.click(resetButton);

    await waitFor(() => {
      const calls = vi.mocked(api).mock.calls;
      const deleted = calls.some(
        ([p, init]) => p.endsWith('/graph-positions') && init?.method === 'DELETE',
      );
      expect(deleted).toBe(true);
    });
  });
});
