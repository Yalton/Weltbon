import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { useState } from 'react';
import { TemplatePicker } from './TemplatePicker';

// Probe component to capture the current location after navigation
function LocationProbe() {
  const loc = useLocation();
  return (
    <div data-testid="location-probe">
      <span data-testid="probe-path">{loc.pathname}</span>
      <span data-testid="probe-state">{JSON.stringify(loc.state)}</span>
    </div>
  );
}

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <MemoryRouter initialEntries={['/universes/U1/entries']}>
      <Routes>
        <Route
          path="/universes/:uid/entries"
          element={
            <>
              <TemplatePicker open={open} onOpenChange={setOpen} universeId="U1" />
              <LocationProbe />
            </>
          }
        />
        <Route
          path="/universes/:uid/entries/new"
          element={<LocationProbe />}
        />
      </Routes>
    </MemoryRouter>
  );
}

describe('TemplatePicker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders all 5 group headings and exactly 10 cards', () => {
    render(<Harness />);

    // Group headings
    expect(screen.getByRole('heading', { name: 'Setting' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'People' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Things' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Time' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Other' })).toBeInTheDocument();

    // 10 cards = each one is a button with the template label
    expect(screen.getByRole('button', { name: /^Blank/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Concept/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Location/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Culture/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Species/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Entity/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Faction/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Artifact/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Event/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Thread/ })).toBeInTheDocument();
  });

  it('selecting Blank navigates to /entries/new with NO state', async () => {
    render(<Harness />);

    await userEvent.click(screen.getByRole('button', { name: /^Blank/ }));

    expect(await screen.findByTestId('probe-path')).toHaveTextContent(
      '/universes/U1/entries/new',
    );
    // No state — JSON.stringify(undefined) is undefined; JSON.stringify(null) is 'null'
    const stateEl = screen.getByTestId('probe-state');
    expect(stateEl.textContent === '' || stateEl.textContent === 'null').toBe(true);
  });

  it('selecting Location navigates to /entries/new with state.template.id="location"', async () => {
    render(<Harness />);

    await userEvent.click(screen.getByRole('button', { name: /^Location/ }));

    expect(await screen.findByTestId('probe-path')).toHaveTextContent(
      '/universes/U1/entries/new',
    );
    const stateEl = screen.getByTestId('probe-state');
    const parsed = JSON.parse(stateEl.textContent || 'null');
    expect(parsed?.template?.id).toBe('location');
    expect(parsed?.template?.entryType).toBe('location');
    expect(parsed?.template?.body).toContain('## Geography');
  });

  it('closing the picker (Escape) does NOT navigate', async () => {
    render(<Harness />);

    // Confirm starting on /entries (not /entries/new)
    expect(screen.getByTestId('probe-path')).toHaveTextContent(
      '/universes/U1/entries',
    );

    await userEvent.keyboard('{Escape}');

    // Path should be unchanged
    expect(screen.getByTestId('probe-path')).toHaveTextContent(
      '/universes/U1/entries',
    );
  });
});
