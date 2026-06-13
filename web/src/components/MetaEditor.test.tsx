import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MetaEditor } from './MetaEditor';

/**
 * Wrapper harness that lets MetaEditor manage rows internally and surfaces
 * the parent's last `onChange` value + the latest validity flag for assertions.
 */
function Harness({
  initial = {},
  onChangeSpy,
  onValiditySpy,
}: {
  initial?: Record<string, string>;
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
    />
  );
}

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
