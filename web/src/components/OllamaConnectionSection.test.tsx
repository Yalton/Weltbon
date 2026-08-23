/**
 * Issue #48 Task 7 — OllamaConnectionSection.
 *
 * Pins:
 *   - renders nothing off local mode (presentation only — the server enforces
 *     desktop-only independently, twice; see llm-connections.ts file header).
 *   - a tool-incapable model is listed WITH the reason, never hidden (a
 *     hidden model reads as "where did it go?").
 *   - a tools-capable model is listed plainly, with no such caveat.
 *   - the installed-model display is not an interactive control (fix round 2,
 *     Minor 8): it used to be a `<select>` with no `value` and no `onChange`.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OllamaConnectionSection } from './OllamaConnectionSection';

let mockLocalMode = true;
vi.mock('../hooks/useInstanceConfig', () => ({
  useInstanceConfig: () => ({ localMode: mockLocalMode }),
}));

vi.mock('../hooks/useLlmConnection', () => ({
  useLlmConnection: () => ({ data: null, isLoading: false }),
  useSaveLlmConnection: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useTestLlmConnection: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useOllamaModels: () => ({
    data: [
      { name: 'qwen3:32b', supportsTools: true, contextLength: 40960 },
      { name: 'llava:latest', supportsTools: false, contextLength: 4096 },
    ],
    isLoading: false,
  }),
}));

describe('OllamaConnectionSection', () => {
  it('renders nothing when the instance is not in local mode', () => {
    mockLocalMode = false;
    const { container } = render(<OllamaConnectionSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists a tool-incapable model with the reason, rather than hiding it', () => {
    // Hiding it makes the user wonder where their model went; listing it with
    // a reason answers the question before they ask.
    mockLocalMode = true;
    render(<OllamaConnectionSection />);
    // `listitem` has no accessible name derived from its content, so the row
    // is located by the model name it displays and then walked up to its <li>.
    const item = screen.getByText('llava:latest').closest('li');
    expect(item).not.toBeNull();
    expect(item!.textContent).toMatch(/no tool support/i);
  });

  it('lists a tools-capable model with no caveat attached', () => {
    mockLocalMode = true;
    render(<OllamaConnectionSection />);
    const item = screen.getByText('qwen3:32b').closest('li');
    expect(item).not.toBeNull();
    expect(item!.textContent).not.toMatch(/no tool support/i);
  });

  it('renders installed models as a list, not as a control that does nothing', () => {
    // Fix round 2 (#48 whole-branch review, Minor 8). The section used to
    // render a real `<select>` here with neither `value` nor `onChange` — it
    // looked like it chose the audit model and chose nothing; the actual
    // choice is made per universe. Asserting the absence of a combobox is
    // what stops a later "let's make this a dropdown again" from restoring
    // the inert control without wiring it.
    mockLocalMode = true;
    render(<OllamaConnectionSection />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});
