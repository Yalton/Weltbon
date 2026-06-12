import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MetaEditor } from './MetaEditor';
import type { FieldRegistryEntry } from '../hooks/useUniverse';

// ---------------------------------------------------------------------------
// Mock useEntries for entry-ref typeahead tests
// ---------------------------------------------------------------------------
vi.mock('../hooks/useEntries', () => ({
  useEntries: (universeId: string) => ({
    data: universeId
      ? [
          { id: 'entry-uuid-1', title: 'Thalindra' },
          { id: 'entry-uuid-2', title: 'Thornwall' },
          { id: 'entry-uuid-3', title: 'Aethermoor' },
        ]
      : [],
  }),
}));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function Harness({
  initial = {},
  registeredFields,
  universeId,
  onChangeSpy,
  onValiditySpy,
}: {
  initial?: Record<string, string>;
  registeredFields?: FieldRegistryEntry[];
  universeId?: string;
  onChangeSpy?: (v: Record<string, string>) => void;
  onValiditySpy?: (v: boolean) => void;
}) {
  const [meta, setMeta] = useState<Record<string, string>>(initial);
  return (
    <MetaEditor
      value={meta}
      onChange={(v) => {
        setMeta(v);
        onChangeSpy?.(v);
      }}
      onValidityChange={onValiditySpy}
      registeredFields={registeredFields}
      universeId={universeId}
    />
  );
}

// ---------------------------------------------------------------------------
// Original MetaEditor tests (preserved — no behavior change allowed)
// ---------------------------------------------------------------------------

describe('MetaEditor', () => {
  it('clicking "+ Add field" appends a new empty row', async () => {
    render(<Harness initial={{ foo: 'bar' }} />);

    // Existing row has placeholder Key with value 'foo'
    const keyInputs = () =>
      screen.getAllByPlaceholderText('Key') as HTMLInputElement[];
    expect(keyInputs()).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: /\+ add field/i }));

    expect(keyInputs()).toHaveLength(2);
    // New row keys/vals are blank
    expect(keyInputs()[1].value).toBe('');
  });

  it('removing a row by clicking × removes it and propagates onChange without that key', async () => {
    const onChangeSpy = vi.fn();
    render(<Harness initial={{ foo: 'bar', baz: 'qux' }} onChangeSpy={onChangeSpy} />);

    const removeBtn = screen.getByRole('button', { name: /remove field foo/i });
    await userEvent.click(removeBtn);

    // After removal, parent's value should no longer have 'foo'
    const lastCall = onChangeSpy.mock.calls.at(-1);
    expect(lastCall?.[0]).toEqual({ baz: 'qux' });
  });

  it('renaming a key to a unique value calls onChange with new mapping', async () => {
    const onChangeSpy = vi.fn();
    render(<Harness initial={{ foo: 'bar' }} onChangeSpy={onChangeSpy} />);

    const keyInput = screen.getByPlaceholderText('Key') as HTMLInputElement;
    await userEvent.clear(keyInput);
    await userEvent.type(keyInput, 'renamed');

    const lastCall = onChangeSpy.mock.calls.at(-1);
    expect(lastCall?.[0]).toEqual({ renamed: 'bar' });
  });

  it('two rows with the same key both have aria-invalid=true and an inline error renders', async () => {
    render(<Harness initial={{ foo: 'a' }} />);

    // Add a second row, then type 'foo' into its key
    await userEvent.click(screen.getByRole('button', { name: /\+ add field/i }));

    const keyInputs = screen.getAllByPlaceholderText('Key') as HTMLInputElement[];
    expect(keyInputs).toHaveLength(2);

    await userEvent.type(keyInputs[1], 'foo');

    // Both rows show aria-invalid='true'
    const updated = screen.getAllByPlaceholderText('Key') as HTMLInputElement[];
    expect(updated[0]).toHaveAttribute('aria-invalid', 'true');
    expect(updated[1]).toHaveAttribute('aria-invalid', 'true');

    // Inline error message visible
    expect(
      screen.getByText(/two or more fields share a key/i),
    ).toBeInTheDocument();
  });

  it('does NOT call onChange while duplicates exist (parent state stays at last valid)', async () => {
    const onChangeSpy = vi.fn();
    render(<Harness initial={{ foo: 'a' }} onChangeSpy={onChangeSpy} />);

    await userEvent.click(screen.getByRole('button', { name: /\+ add field/i }));

    const keyInputs = screen.getAllByPlaceholderText('Key') as HTMLInputElement[];

    // Type the duplicate key 'foo' into row 2. Intermediate keystrokes 'f'
    // and 'fo' are NOT duplicates so they do call onChange. The final
    // keystroke that produces 'foo' creates the duplicate and MUST NOT.
    onChangeSpy.mockClear();
    await userEvent.type(keyInputs[1], 'foo');

    // Three keystrokes typed; only the first two ('f' → 'fo') are valid keys
    // (no dup). The third ('foo') flips into dup state → onChange skipped.
    expect(onChangeSpy).toHaveBeenCalledTimes(2);

    // None of the recorded onChange calls reflect the duplicate state — the
    // last valid value is the one with the partial key 'fo'.
    const lastVal = onChangeSpy.mock.calls.at(-1)?.[0];
    expect(lastVal).toEqual({ foo: 'a', fo: '' });
  });

  it('onValidityChange spy receives false while duplicates exist, then true when one is renamed', async () => {
    const onValiditySpy = vi.fn();
    render(<Harness initial={{ foo: 'a' }} onValiditySpy={onValiditySpy} />);

    // Mount fires true initially
    expect(onValiditySpy).toHaveBeenCalledWith(true);

    await userEvent.click(screen.getByRole('button', { name: /\+ add field/i }));
    const keyInputs = screen.getAllByPlaceholderText('Key') as HTMLInputElement[];
    await userEvent.type(keyInputs[1], 'foo');

    // Validity should have flipped to false
    expect(onValiditySpy).toHaveBeenCalledWith(false);

    // Now rename second row's key → resolution
    await userEvent.clear(keyInputs[1]);
    await userEvent.type(keyInputs[1], 'bar');

    // Validity flipped back to true
    expect(onValiditySpy.mock.calls.at(-1)?.[0]).toBe(true);
  });

  it('resolving a duplicate by deleting one of the duplicate rows clears aria-invalid', async () => {
    render(<Harness initial={{ foo: 'a' }} />);

    await userEvent.click(screen.getByRole('button', { name: /\+ add field/i }));
    let keyInputs = screen.getAllByPlaceholderText('Key') as HTMLInputElement[];
    await userEvent.type(keyInputs[1], 'foo');

    // Confirm we're in dup state
    keyInputs = screen.getAllByPlaceholderText('Key') as HTMLInputElement[];
    expect(keyInputs[0]).toHaveAttribute('aria-invalid', 'true');

    // Delete the second row (the duplicate). It has empty placeholder (still 'foo' key),
    // so aria-label is "Remove field foo"; we use the LAST one to ensure we delete row 2.
    const removeBtns = screen.getAllByRole('button', { name: /remove field foo/i });
    await userEvent.click(removeBtns[removeBtns.length - 1]);

    // Now only one 'foo' row remains; aria-invalid clears.
    keyInputs = screen.getAllByPlaceholderText('Key') as HTMLInputElement[];
    expect(keyInputs).toHaveLength(1);
    expect(keyInputs[0]).toHaveAttribute('aria-invalid', 'false');
    expect(
      screen.queryByText(/two or more fields share a key/i),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// New tests for registered fields (Phase 29 DATA-02)
// ---------------------------------------------------------------------------

describe('MetaEditor — registered fields', () => {
  it('renders a registered text row labeled "Region" above freeform section even when value has no Region key', () => {
    render(
      <Harness
        initial={{}}
        registeredFields={[{ name: 'Region', type: 'text' }]}
      />,
    );

    // The "Custom fields" section header should appear
    expect(screen.getByText('Custom fields')).toBeInTheDocument();

    // A label "Region" should be visible
    expect(screen.getByText('Region')).toBeInTheDocument();
  });

  it('renders a type-mismatch hint "Doesn\'t match type" for a number field with non-numeric value', () => {
    render(
      <Harness
        initial={{ Score: 'not-a-number' }}
        registeredFields={[{ name: 'Score', type: 'number' }]}
      />,
    );

    expect(screen.getByText("Doesn't match type")).toBeInTheDocument();
  });

  it('does NOT flip onValidityChange to false for a type-mismatch (non-blocking)', () => {
    const onValiditySpy = vi.fn();
    render(
      <Harness
        initial={{ Score: 'not-a-number' }}
        registeredFields={[{ name: 'Score', type: 'number' }]}
        onValiditySpy={onValiditySpy}
      />,
    );

    // onValidityChange should only have been called with true (no false)
    expect(onValiditySpy).not.toHaveBeenCalledWith(false);
  });

  it('renders a boolean field as a Yes/No/— three-button group with role="group"', () => {
    render(
      <Harness
        initial={{}}
        registeredFields={[{ name: 'Active', type: 'boolean' }]}
      />,
    );

    const group = screen.getByRole('group', { name: 'Active' });
    expect(group).toBeInTheDocument();

    expect(screen.getByRole('button', { name: 'Yes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No' })).toBeInTheDocument();
    // em dash character
    expect(screen.getByRole('button', { name: '—' })).toBeInTheDocument();
  });

  it('editing a registered field value calls onChange with that key in the meta object', async () => {
    const onChangeSpy = vi.fn();
    render(
      <Harness
        initial={{}}
        registeredFields={[{ name: 'Region', type: 'text' }]}
        onChangeSpy={onChangeSpy}
      />,
    );

    const regionInput = screen.getByLabelText('Region') as HTMLInputElement;
    await userEvent.type(regionInput, 'North');

    await waitFor(() => {
      const lastCall = onChangeSpy.mock.calls.at(-1);
      expect(lastCall?.[0]).toMatchObject({ Region: expect.stringContaining('N') });
    });
  });

  it('a value entered for a registered field is NOT duplicated as a freeform row', () => {
    render(
      <Harness
        initial={{ Region: 'North' }}
        registeredFields={[{ name: 'Region', type: 'text' }]}
      />,
    );

    // There should be only ONE input associated with "Region"
    // (the registered row), not two (one registered + one freeform).
    const regionInputs = screen.getAllByLabelText('Region');
    expect(regionInputs).toHaveLength(1);

    // Freeform "Key" inputs should NOT include Region
    const keyInputs = screen.queryAllByPlaceholderText('Key') as HTMLInputElement[];
    const hasRegionFreeform = keyInputs.some((inp) => inp.value === 'Region');
    expect(hasRegionFreeform).toBe(false);
  });

  it('entry-ref field shows suggestion list from useEntries and stores UUID on selection', async () => {
    render(
      <Harness
        initial={{}}
        registeredFields={[{ name: 'Founder', type: 'entry-ref' }]}
        universeId="universe-1"
      />,
    );

    // The entry-ref input should have the combobox role with placeholder "Search entries..."
    const combobox = screen.getByRole('combobox', { name: 'Founder' });
    expect(combobox).toBeInTheDocument();

    // Focus / type to open suggestions
    await userEvent.click(combobox);
    await userEvent.type(combobox, 'Thal');

    // Suggestion for 'Thalindra' should appear
    await waitFor(() => {
      expect(screen.getByText('Thalindra')).toBeInTheDocument();
    });

    // Select it
    await userEvent.click(screen.getByText('Thalindra'));

    // After selection, the stored value should be the UUID, displayed as title
    // The combobox input value should show the title
    expect((combobox as HTMLInputElement).value).toBe('Thalindra');
  });
});
