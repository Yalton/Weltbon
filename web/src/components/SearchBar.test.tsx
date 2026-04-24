import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { SearchBar } from './SearchBar';

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

/**
 * Harness that exposes the current URLSearchParams so tests can assert that
 * the SearchBar wrote (or deliberately did not yet write) `?q=` into the URL.
 */
function UrlProbe() {
  const [params] = useSearchParams();
  return <div data-testid="probe">{params.toString()}</div>;
}

function renderSearchBar(initialPath = '/universes/U1/entries') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <SearchBar />
      <UrlProbe />
    </MemoryRouter>,
  );
}

describe('SearchBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces URL writes by 250ms', async () => {
    renderSearchBar();
    const input = screen.getByTestId('search-input') as HTMLInputElement;

    // Type 'dragon' via fireEvent.change so React's synthetic event tracker
    // picks up the value mutation.
    fireEvent.change(input, { target: { value: 'dragon' } });

    // Input reflects the typed value immediately.
    expect(input.value).toBe('dragon');
    // URL should NOT have q yet — debounce hasn't fired.
    expect(screen.getByTestId('probe').textContent).toBe('');

    // Advance past the debounce window, then flush microtasks so the
    // setParams state update commits into the UrlProbe render.
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    await flush();

    expect(screen.getByTestId('probe').textContent).toContain('q=dragon');
  });

  it('initializes input value from the URL q param', () => {
    renderSearchBar('/universes/U1/entries?q=wizard');
    const input = screen.getByTestId('search-input') as HTMLInputElement;
    expect(input.value).toBe('wizard');
  });

  it('clears the URL q param when the input is emptied', async () => {
    renderSearchBar('/universes/U1/entries?q=existing');
    const input = screen.getByTestId('search-input') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '' } });

    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    await flush();

    expect(screen.getByTestId('probe').textContent).not.toContain('q=');
  });
});
