/**
 * Issue #48 Task 7 — OllamaConnectionSection.
 *
 * Pins:
 *   - renders nothing off local mode (presentation only — the server enforces
 *     desktop-only independently, twice; see llm-connections.ts file header).
 *   - a tool-incapable model is listed and DISABLED with the reason, never
 *     hidden (a hidden model reads as "where did it go?").
 *   - a tools-capable model stays selectable.
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

  it('lists a tool-incapable model as disabled with the reason, rather than hiding it', () => {
    // Hiding it makes the user wonder where their model went; disabling it
    // with a reason answers the question before they ask.
    mockLocalMode = true;
    render(<OllamaConnectionSection />);
    const option = screen.getByRole('option', { name: /llava/i }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
    expect(option.textContent).toMatch(/tool/i);
  });

  it('leaves a tools-capable model selectable', () => {
    mockLocalMode = true;
    render(<OllamaConnectionSection />);
    const option = screen.getByRole('option', { name: /qwen3:32b/i }) as HTMLOptionElement;
    expect(option.disabled).toBe(false);
  });
});
