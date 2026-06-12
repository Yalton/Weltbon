/**
 * Tests for the AddFilterChip Status (three-state WIP) and Fields groups
 * added in Plan 29-04. The existing Type/Tag/Category groups are not re-tested
 * here — those are covered by the existing integration behavior.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// Mock the api client so no real requests are made
vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return { ...actual, api: vi.fn() };
});

import { AddFilterChip } from './AddFilterChip';
import type { EntryFilters } from '../hooks/useFilterParams';
import type { FieldRegistryEntry } from '../types/fieldRegistry';

function makeQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

const BASE_FILTERS: EntryFilters = {
  q: '',
  type: null,
  tags: [],
  category: null,
  wip: null,
  fieldFilters: {},
};

const SAMPLE_FIELDS: FieldRegistryEntry[] = [
  { name: 'Born in year', type: 'number', hint: 'In-world year' },
  { name: 'Faction', type: 'text' },
  { name: 'Is alive', type: 'boolean' },
];

describe('AddFilterChip — Status group', () => {
  it('renders a "Status" group label in the popover after opening', async () => {
    const user = userEvent.setup();
    const updateFilters = vi.fn();
    const qc = makeQc();
    render(
      <AddFilterChip
        universeId="U1"
        filters={BASE_FILTERS}
        updateFilters={updateFilters}
        types={[]}
        categories={[]}
        registeredFields={[]}
      />,
      { wrapper: wrapper(qc) }
    );

    await user.click(screen.getByRole('button', { name: /add filter/i }));
    expect(screen.getByText('Status')).toBeInTheDocument();
  });

  it('renders Status select with "All entries", "WIP only", "Finished only" options', async () => {
    const user = userEvent.setup();
    const updateFilters = vi.fn();
    const qc = makeQc();
    render(
      <AddFilterChip
        universeId="U1"
        filters={BASE_FILTERS}
        updateFilters={updateFilters}
        types={[]}
        categories={[]}
        registeredFields={[]}
      />,
      { wrapper: wrapper(qc) }
    );

    await user.click(screen.getByRole('button', { name: /add filter/i }));
    expect(screen.getByText('All entries')).toBeInTheDocument();
    expect(screen.getByText('WIP only')).toBeInTheDocument();
    expect(screen.getByText('Finished only')).toBeInTheDocument();
  });

  it('selecting "WIP only" calls updateFilters({ wip: true })', async () => {
    const user = userEvent.setup();
    const updateFilters = vi.fn();
    const qc = makeQc();
    render(
      <AddFilterChip
        universeId="U1"
        filters={BASE_FILTERS}
        updateFilters={updateFilters}
        types={[]}
        categories={[]}
        registeredFields={[]}
      />,
      { wrapper: wrapper(qc) }
    );

    await user.click(screen.getByRole('button', { name: /add filter/i }));
    await user.selectOptions(screen.getByLabelText(/add status filter/i), 'true');
    expect(updateFilters).toHaveBeenCalledWith({ wip: true });
  });

  it('selecting "Finished only" calls updateFilters({ wip: false })', async () => {
    const user = userEvent.setup();
    const updateFilters = vi.fn();
    const qc = makeQc();
    render(
      <AddFilterChip
        universeId="U1"
        filters={BASE_FILTERS}
        updateFilters={updateFilters}
        types={[]}
        categories={[]}
        registeredFields={[]}
      />,
      { wrapper: wrapper(qc) }
    );

    await user.click(screen.getByRole('button', { name: /add filter/i }));
    await user.selectOptions(screen.getByLabelText(/add status filter/i), 'false');
    expect(updateFilters).toHaveBeenCalledWith({ wip: false });
  });

  it('selecting "All entries" calls updateFilters({ wip: null })', async () => {
    const user = userEvent.setup();
    // Start with wip=true so "All entries" is a meaningful change
    const updateFilters = vi.fn();
    const qc = makeQc();
    render(
      <AddFilterChip
        universeId="U1"
        filters={{ ...BASE_FILTERS, wip: true }}
        updateFilters={updateFilters}
        types={[]}
        categories={[]}
        registeredFields={[]}
      />,
      { wrapper: wrapper(qc) }
    );

    await user.click(screen.getByRole('button', { name: /add filter/i }));
    await user.selectOptions(screen.getByLabelText(/add status filter/i), '');
    expect(updateFilters).toHaveBeenCalledWith({ wip: null });
  });
});

describe('AddFilterChip — Fields group', () => {
  it('does NOT render the "Fields" group when registeredFields is empty', async () => {
    const user = userEvent.setup();
    const updateFilters = vi.fn();
    const qc = makeQc();
    render(
      <AddFilterChip
        universeId="U1"
        filters={BASE_FILTERS}
        updateFilters={updateFilters}
        types={[]}
        categories={[]}
        registeredFields={[]}
      />,
      { wrapper: wrapper(qc) }
    );

    await user.click(screen.getByRole('button', { name: /add filter/i }));
    expect(screen.queryByText('Fields')).not.toBeInTheDocument();
    expect(screen.queryByText('Select field...')).not.toBeInTheDocument();
  });

  it('renders the "Fields" group when registeredFields is non-empty', async () => {
    const user = userEvent.setup();
    const updateFilters = vi.fn();
    const qc = makeQc();
    render(
      <AddFilterChip
        universeId="U1"
        filters={BASE_FILTERS}
        updateFilters={updateFilters}
        types={[]}
        categories={[]}
        registeredFields={SAMPLE_FIELDS}
      />,
      { wrapper: wrapper(qc) }
    );

    await user.click(screen.getByRole('button', { name: /add filter/i }));
    expect(screen.getByText('Fields')).toBeInTheDocument();
    expect(screen.getByText('Select field...')).toBeInTheDocument();
  });

  it('renders all registered field names in the field picker', async () => {
    const user = userEvent.setup();
    const updateFilters = vi.fn();
    const qc = makeQc();
    render(
      <AddFilterChip
        universeId="U1"
        filters={BASE_FILTERS}
        updateFilters={updateFilters}
        types={[]}
        categories={[]}
        registeredFields={SAMPLE_FIELDS}
      />,
      { wrapper: wrapper(qc) }
    );

    await user.click(screen.getByRole('button', { name: /add filter/i }));
    expect(screen.getByRole('option', { name: 'Born in year' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Faction' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Is alive' })).toBeInTheDocument();
  });

  it('shows a text input for a text-typed field after picking it', async () => {
    const user = userEvent.setup();
    const updateFilters = vi.fn();
    const qc = makeQc();
    render(
      <AddFilterChip
        universeId="U1"
        filters={BASE_FILTERS}
        updateFilters={updateFilters}
        types={[]}
        categories={[]}
        registeredFields={SAMPLE_FIELDS}
      />,
      { wrapper: wrapper(qc) }
    );

    await user.click(screen.getByRole('button', { name: /add filter/i }));
    const fieldPicker = screen.getByLabelText(/select field to filter/i);
    await user.selectOptions(fieldPicker, 'Faction');
    // A text input should appear for value entry
    expect(screen.getByPlaceholderText('Filter value...')).toBeInTheDocument();
  });

  it('shows a Yes/No select for a boolean-typed field after picking it', async () => {
    const user = userEvent.setup();
    const updateFilters = vi.fn();
    const qc = makeQc();
    render(
      <AddFilterChip
        universeId="U1"
        filters={BASE_FILTERS}
        updateFilters={updateFilters}
        types={[]}
        categories={[]}
        registeredFields={SAMPLE_FIELDS}
      />,
      { wrapper: wrapper(qc) }
    );

    await user.click(screen.getByRole('button', { name: /add filter/i }));
    const fieldPicker = screen.getByLabelText(/select field to filter/i);
    await user.selectOptions(fieldPicker, 'Is alive');
    // A Yes/No select (with these exact option values) should appear
    expect(screen.getByRole('option', { name: 'Yes' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'No' })).toBeInTheDocument();
  });

  it('shows a number input for a number-typed field after picking it', async () => {
    const user = userEvent.setup();
    const updateFilters = vi.fn();
    const qc = makeQc();
    render(
      <AddFilterChip
        universeId="U1"
        filters={BASE_FILTERS}
        updateFilters={updateFilters}
        types={[]}
        categories={[]}
        registeredFields={SAMPLE_FIELDS}
      />,
      { wrapper: wrapper(qc) }
    );

    await user.click(screen.getByRole('button', { name: /add filter/i }));
    const fieldPicker = screen.getByLabelText(/select field to filter/i);
    await user.selectOptions(fieldPicker, 'Born in year');
    // A number input should appear
    const inputs = screen.getAllByRole('spinbutton');
    expect(inputs.length).toBeGreaterThan(0);
  });

  it('pressing Enter on a text field value calls updateFilters with fieldFilters', async () => {
    const user = userEvent.setup();
    const updateFilters = vi.fn();
    const qc = makeQc();
    render(
      <AddFilterChip
        universeId="U1"
        filters={BASE_FILTERS}
        updateFilters={updateFilters}
        types={[]}
        categories={[]}
        registeredFields={SAMPLE_FIELDS}
      />,
      { wrapper: wrapper(qc) }
    );

    await user.click(screen.getByRole('button', { name: /add filter/i }));
    const fieldPicker = screen.getByLabelText(/select field to filter/i);
    await user.selectOptions(fieldPicker, 'Faction');
    const valueInput = screen.getByPlaceholderText('Filter value...');
    await user.type(valueInput, 'Mordor{Enter}');
    expect(updateFilters).toHaveBeenCalledWith({
      fieldFilters: { Faction: 'Mordor' },
    });
  });

  it('selecting a boolean value (Yes) calls updateFilters with fieldFilters', async () => {
    const user = userEvent.setup();
    const updateFilters = vi.fn();
    const qc = makeQc();
    render(
      <AddFilterChip
        universeId="U1"
        filters={BASE_FILTERS}
        updateFilters={updateFilters}
        types={[]}
        categories={[]}
        registeredFields={SAMPLE_FIELDS}
      />,
      { wrapper: wrapper(qc) }
    );

    await user.click(screen.getByRole('button', { name: /add filter/i }));
    const fieldPicker = screen.getByLabelText(/select field to filter/i);
    await user.selectOptions(fieldPicker, 'Is alive');
    // Select "Yes"
    const boolSelect = screen.getByLabelText(/add boolean field value/i);
    await user.selectOptions(boolSelect, 'true');
    expect(updateFilters).toHaveBeenCalledWith({
      fieldFilters: { 'Is alive': 'true' },
    });
  });
});
