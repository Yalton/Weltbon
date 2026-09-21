
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { WordPopover } from './WordPopover';
import { ShareModeProvider } from '../contexts/ShareModeContext';

// ---------------------------------------------------------------------------
// navigate spy — captures calls so we can assert click-navigation behavior.
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function AuthWrapper({ children }: { children: ReactNode }) {
  // Outside ShareModeProvider → useShareMode() returns false (authenticated mode).
  return <MemoryRouter>{children}</MemoryRouter>;
}

function ShareWrapper({ children }: { children: ReactNode }) {
  // Inside ShareModeProvider → useShareMode() returns true (share mode).
  return (
    <MemoryRouter>
      <ShareModeProvider>{children}</ShareModeProvider>
    </MemoryRouter>
  );
}

function makeProps() {
  return {
    word: 'mellon',
    displayLabel: 'mellon',
    gloss: 'friend',
    ipa: 'ˈmɛlɒn',
    universeId: 'u1',
    languageEntryId: null,
  };
}

// ---------------------------------------------------------------------------
// S1 — Share mode: trigger has NO button role
// ---------------------------------------------------------------------------

describe('S1: share mode — trigger has no button role (T-33-07)', () => {
  it('renders without role="button" inside ShareModeProvider', () => {
    render(
      <ShareWrapper>
        <WordPopover {...makeProps()} />
      </ShareWrapper>,
    );

    // In share mode the trigger span must not be a button — visitors should not
    // receive a clickable affordance that leads to /login.
    expect(
      screen.queryByRole('button', { name: /hover to see gloss/i }),
      'share-mode trigger must NOT have role="button"',
    ).toBeNull();

    // The span should still be rendered (hover affordance preserved)
    expect(screen.getByLabelText(/mellon: hover to see gloss/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// S2 — Share mode: clicking the trigger does NOT navigate
// ---------------------------------------------------------------------------

describe('S2: share mode — click does NOT navigate (T-33-07)', () => {
  it('does not call navigate on click in share mode', () => {
    mockNavigate.mockClear();

    render(
      <ShareWrapper>
        <WordPopover {...makeProps()} />
      </ShareWrapper>,
    );

    const trigger = screen.getByLabelText(/mellon: hover to see gloss/i);
    fireEvent.click(trigger);

    expect(
      mockNavigate,
      'navigate must NOT be called when clicking the WordPopover in share mode',
    ).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// S3 — Authenticated mode: clicking navigates to dictionary
// ---------------------------------------------------------------------------

describe('S3: authenticated mode — click navigates to dictionary', () => {
  it('renders role=button and clicking calls navigate with correct URL', () => {
    mockNavigate.mockClear();

    render(
      <AuthWrapper>
        <WordPopover {...makeProps()} />
      </AuthWrapper>,
    );

    // Trigger must have role=button in authenticated mode
    const trigger = screen.getByRole('button', { name: /mellon: hover to see gloss/i });
    expect(trigger).toBeInTheDocument();

    fireEvent.click(trigger);

    expect(
      mockNavigate,
      'navigate must be called when clicking the WordPopover in authenticated mode',
    ).toHaveBeenCalledOnce();
    // URL includes the word as ?highlight= param
    const calledUrl = mockNavigate.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('/universes/u1/dictionary');
    expect(calledUrl).toContain('highlight=mellon');
  });
});

// ---------------------------------------------------------------------------
// S4 — Authenticated mode: keyboard Enter navigates
// ---------------------------------------------------------------------------

describe('S4: authenticated mode — keyboard Enter navigates', () => {
  it('calls navigate on Enter keydown in authenticated mode', () => {
    mockNavigate.mockClear();

    render(
      <AuthWrapper>
        <WordPopover {...makeProps()} />
      </AuthWrapper>,
    );

    const trigger = screen.getByRole('button', { name: /mellon: hover to see gloss/i });
    fireEvent.keyDown(trigger, { key: 'Enter' });

    expect(
      mockNavigate,
      'navigate must be called on Enter keydown in authenticated mode',
    ).toHaveBeenCalledOnce();
  });
});
