/**
 * Tests for Settings view (POL-03, §14.3).
 *
 * Covers:
 * - Renders h1 "Settings" and h2 "Visual" section
 * - Shows exact label text from UI-SPEC §10
 * - Checkbox starts unchecked (default OFF per D-09)
 * - Toggling checkbox calls setShowEntriesAsBodies
 * - Checkbox checked state mirrors showEntriesAsBodies from store
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// --- Mock useSimSettings ---
const mockSetShowEntriesAsBodies = vi.fn();
let mockShowEntriesAsBodies = false;

vi.mock('../store/simSettings', () => ({
  useSimSettings: (selector: (s: { showEntriesAsBodies: boolean; setShowEntriesAsBodies: (v: boolean) => void }) => unknown) =>
    selector({
      showEntriesAsBodies: mockShowEntriesAsBodies,
      setShowEntriesAsBodies: mockSetShowEntriesAsBodies,
    }),
}));

import Settings from './Settings';

function renderSettings() {
  return render(
    <MemoryRouter>
      <Settings />
    </MemoryRouter>
  );
}

describe('Settings view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockShowEntriesAsBodies = false;
  });

  it('renders h1 "Settings"', () => {
    renderSettings();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Settings');
  });

  it('renders h2 "Visual" section', () => {
    renderSettings();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Visual');
  });

  it('renders the exact label text from UI-SPEC §10', () => {
    renderSettings();
    expect(screen.getByText('Entries appear as bodies in the background')).toBeTruthy();
  });

  it('renders the helper text from UI-SPEC §10', () => {
    renderSettings();
    // Helper text from UI-SPEC §10: "Show this universe's entries..."
    expect(screen.getByText(/show this universe.*entries.*additional bodies/i)).toBeTruthy();
  });

  it('checkbox is unchecked by default (showEntriesAsBodies=false)', () => {
    mockShowEntriesAsBodies = false;
    renderSettings();
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).not.toBeChecked();
  });

  it('checkbox is checked when showEntriesAsBodies=true', () => {
    mockShowEntriesAsBodies = true;
    renderSettings();
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toBeChecked();
  });

  it('calls setShowEntriesAsBodies(true) when checkbox toggled on', () => {
    mockShowEntriesAsBodies = false;
    renderSettings();
    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);
    expect(mockSetShowEntriesAsBodies).toHaveBeenCalledWith(true);
  });

  it('calls setShowEntriesAsBodies(false) when checkbox toggled off', () => {
    mockShowEntriesAsBodies = true;
    renderSettings();
    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);
    expect(mockSetShowEntriesAsBodies).toHaveBeenCalledWith(false);
  });
});
