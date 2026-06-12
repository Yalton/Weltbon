import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FieldRegistrySection } from './FieldRegistrySection';
import type { Universe } from '../hooks/useUniverse';

// ---------------------------------------------------------------------------
// Mock useUpdateUniverse — all tests share this mock; individual tests
// override `mutate` / `mutateAsync` to assert call args.
// ---------------------------------------------------------------------------
const mockMutate = vi.fn();
const mockMutateAsync = vi.fn();
const mockIsPending = { current: false };

vi.mock('../hooks/useUniverse', () => ({
  useUpdateUniverse: (_id: string) => ({
    mutate: mockMutate,
    mutateAsync: mockMutateAsync,
    isPending: mockIsPending.current,
  }),
}));

// ConfirmDialog — use a minimal implementation so the "confirm" button is
// reachable without Radix portal / animation quirks in jsdom.
vi.mock('./ConfirmDialog', () => ({
  ConfirmDialog: ({
    open,
    title,
    onConfirm,
    confirmLabel = 'Confirm',
  }: {
    open: boolean;
    title: string;
    onConfirm: () => void;
    confirmLabel?: string;
  }) =>
    open ? (
      <div role="dialog">
        <p>{title}</p>
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUniverse(
  extra: Partial<Universe> = {},
): Universe {
  return {
    id: 'u1',
    userId: 'user1',
    name: 'Test Universe',
    description: '',
    entryTypes: [],
    timelineWindow: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    auditEnabled: false,
    auditProvider: null,
    auditModel: null,
    entryTemplates: [],
    linkTypes: {},
    fieldRegistry: [],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FieldRegistrySection', () => {
  beforeEach(() => {
    mockMutate.mockReset();
    mockMutateAsync.mockReset();
    mockIsPending.current = false;
  });

  // ── Test 1: empty state ────────────────────────────────────────────────
  it('renders empty state when fieldRegistry is []', () => {
    render(<FieldRegistrySection universe={makeUniverse()} />);

    expect(screen.getByText('No custom fields')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Add a field to give every entry a consistent set of typed data slots.',
      ),
    ).toBeInTheDocument();
  });

  // ── Test 2: add field calls PATCH ──────────────────────────────────────
  it('adding a field calls the universe PATCH with the new fieldRegistry array', async () => {
    mockMutateAsync.mockResolvedValue(undefined);
    render(<FieldRegistrySection universe={makeUniverse()} />);

    const nameInput = screen.getByPlaceholderText('e.g. Born in year');
    await userEvent.type(nameInput, 'Born in year');

    // Pick type
    const typeSelect = screen.getByRole('combobox', { name: /type/i });
    await userEvent.selectOptions(typeSelect, 'number');

    await userEvent.click(screen.getByRole('button', { name: /add field/i }));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({
        fieldRegistry: [{ name: 'Born in year', type: 'number' }],
      });
    });
  });

  // ── Test 3: duplicate name shows inline error and does NOT PATCH ───────
  it('duplicate name (case-insensitive) shows inline error and does not PATCH', async () => {
    const universe = makeUniverse({
      fieldRegistry: [{ name: 'Born in year', type: 'number' }],
    });
    render(<FieldRegistrySection universe={universe} />);

    const nameInput = screen.getByPlaceholderText('e.g. Born in year');
    await userEvent.type(nameInput, 'born in year'); // lowercase duplicate

    const typeSelect = screen.getByRole('combobox', { name: /type/i });
    await userEvent.selectOptions(typeSelect, 'text');

    await userEvent.click(screen.getByRole('button', { name: /add field/i }));

    // Error shown
    expect(screen.getByRole('alert')).toBeInTheDocument();
    // PATCH not called
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  // ── Test 4: delete opens ConfirmDialog and PATCHes on confirm ──────────
  it('deleting a field opens a ConfirmDialog and PATCHes without that entry on confirm', async () => {
    mockMutateAsync.mockResolvedValue(undefined);
    const universe = makeUniverse({
      fieldRegistry: [
        { name: 'Born in year', type: 'number' },
        { name: 'Region', type: 'text' },
      ],
    });
    render(<FieldRegistrySection universe={universe} />);

    // Click delete button for first field
    await userEvent.click(
      screen.getByRole('button', { name: /delete born in year/i }),
    );

    // ConfirmDialog should be open
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Delete this field?')).toBeInTheDocument();

    // Click the confirm button
    await userEvent.click(screen.getByRole('button', { name: /delete field/i }));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({
        fieldRegistry: [{ name: 'Region', type: 'text' }],
      });
    });
  });
});
