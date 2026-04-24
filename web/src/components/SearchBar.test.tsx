import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { SearchBar } from './SearchBar';

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

  it('debounces URL writes by 250ms', () => {
    renderSearchBar();
    const input = screen.getByTestId('search-input') as HTMLInputElement;

    // Type 'dragon' synchronously (fireEvent-style through input.value + change)
    act(() => {
      input.focus();
      input.value = 'dragon';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Input reflects the typed value immediately.
    expect(input.value).toBe('dragon');
    // URL should NOT have q yet — debounce hasn't fired.
    expect(screen.getByTestId('probe').textContent).toBe('');

    // Advance past the debounce window.
    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(screen.getByTestId('probe').textContent).toContain('q=dragon');
  });

  it('initializes input value from the URL q param', () => {
    renderSearchBar('/universes/U1/entries?q=wizard');
    const input = screen.getByTestId('search-input') as HTMLInputElement;
    expect(input.value).toBe('wizard');
  });

  it('clears the URL q param when the input is emptied', () => {
    renderSearchBar('/universes/U1/entries?q=existing');
    const input = screen.getByTestId('search-input') as HTMLInputElement;

    act(() => {
      input.focus();
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(screen.getByTestId('probe').textContent).not.toContain('q=');
  });
});
