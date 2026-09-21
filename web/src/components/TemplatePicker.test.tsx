import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, useEffect } from 'react';
import { TemplatePicker } from './TemplatePicker';
import { TEMPLATES } from '../lib/entryTemplates';



// pattern follows web/src/api/client.test.ts (vitest spyOn; the project does
// not use MSW). The Harness also fixes 28-REVIEW.md §IN-01 in passing by
// wrapping the QueryClient construction in useState so a Harness re-render
// no longer discards the QueryClient.
//
// What's covered (UI-SPEC §A/§E):
//   - 3-section layout (Empty entry / Default templates / Your templates)
//   - default-card navigation with state.template (no templateId)
//   - personal-card navigation with state.template + state.templateId — this
//     is the load-bearing D-16 wire per 28-REVIEW.md §WR-03; if it regresses
//     the entire last_used_at stamp feature silently breaks
//   - Clone-to-personal button presence on each default card (jsdom does not
//     render CSS hover transitions; visual opacity is covered by the manual

//   - Escape closes the picker without navigating

type LocationSnapshot = { pathname: string; state: unknown };

function LocationReader({
  onLocationChange,
}: {
  onLocationChange?: (loc: LocationSnapshot) => void;
}) {
  const loc = useLocation();
  useEffect(() => {
    onLocationChange?.({ pathname: loc.pathname, state: loc.state });
  }, [loc.pathname, loc.state, onLocationChange]);
  return <div data-testid="location-reader" />;
}

type HarnessProps = {
  initialEntries?: string[];
  onLocationChange?: (loc: LocationSnapshot) => void;
  onOpenChangeCallback?: (open: boolean) => void;
};

function Harness({
  initialEntries = ['/universes/U1/entries'],
  onLocationChange,
  onOpenChangeCallback,
}: HarnessProps) {
  const [open, setOpen] = useState(true);
  // IN-01 fix: construct QueryClient exactly once per mount.
  // prettier-ignore
  const [qc] = useState(() => new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  }));
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route
            path="/universes/:uid/entries"
            element={
              <>
                <TemplatePicker
                  open={open}
                  onOpenChange={(o) => {
                    setOpen(o);
                    onOpenChangeCallback?.(o);
                  }}
                  universeId="U1"
                />
                <LocationReader onLocationChange={onLocationChange} />
              </>
            }
          />
          <Route
            path="/universes/:uid/entries/new"
            element={<LocationReader onLocationChange={onLocationChange} />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function mockTemplatesFetch(payload: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

describe('TemplatePicker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Default fetch mock — empty personal-template list. Individual tests
    // override before render() if they need a populated list.
    mockTemplatesFetch([]);
  });

  it('renders without throwing (smoke)', () => {
    render(<Harness />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('renders 3 sections (Empty entry / Default templates / Your templates)', async () => {
    mockTemplatesFetch([
      {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        name: 'My Hero',
        entryType: 'entity',
        summary: '',
        body: '',
        meta: [],
        clonedFrom: null,
        lastUsedAt: null,
        createdAt: '2026-05-29T00:00:00.000Z',
        updatedAt: '2026-05-29T00:00:00.000Z',
      },
    ]);

    render(<Harness />);

    // Wait for the personal card text (proves the populated-state branch
    // rendered — the loading-state placeholder also includes a "Your
    // templates" header, so we anchor on the card text instead).
    await screen.findByText('My Hero');
    expect(screen.getByText('Empty entry')).toBeInTheDocument();
    expect(screen.getByText('Default templates')).toBeInTheDocument();
    expect(screen.getByText('Your templates')).toBeInTheDocument();
  });

  it('clicking a default card navigates with state.template set', async () => {
    // Empty personal-template list — only Default cards are present.
    mockTemplatesFetch([]);

    const captures: LocationSnapshot[] = [];
    render(
      <Harness
        onLocationChange={(loc) => {
          captures.push(loc);
        }}
      />,
    );

    const firstDefault = TEMPLATES[0];
    // The outer default card has its label as accessible name. This query
    // resolves the outer container whether it is a <button> (pre-CR-01) or
    // a <div role="button"> (post-CR-01) — both expose role="button" with
    // the label as accessible name.
    const outerCard = await screen.findByRole('button', {
      name: new RegExp(firstDefault.label, 'i'),
    });
    fireEvent.click(outerCard);

    await waitFor(() => {
      const last = captures[captures.length - 1];
      expect(last?.pathname).toBe('/universes/U1/entries/new');
    });

    const last = captures[captures.length - 1]!;
    const state = last.state as {
      template?: { id: string; label: string; entryType: string };
      templateId?: unknown;
    };
    expect(state.template?.id).toBe(firstDefault.id);
    expect(state.template?.label).toBe(firstDefault.label);
    expect(state.template?.entryType).toBe(firstDefault.entryType);
    // Default cards omit templateId because the kebab id is not a UUID
    // (D-16 — only personal cards include templateId for the stamp wire).
    expect(state.templateId).toBeUndefined();
  });

  it('clicking a personal card navigates with state.templateId set (D-16)', async () => {
    const personalId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    mockTemplatesFetch([
      {
        id: personalId,
        name: 'My Hero',
        entryType: 'entity',
        summary: '',
        body: '',
        meta: [],
        clonedFrom: null,
        lastUsedAt: null,
        createdAt: '2026-05-29T00:00:00.000Z',
        updatedAt: '2026-05-29T00:00:00.000Z',
      },
    ]);

    const captures: LocationSnapshot[] = [];
    render(
      <Harness
        onLocationChange={(loc) => {
          captures.push(loc);
        }}
      />,
    );

    // Wait for the personal card itself to render — the section heading
    // text appears in both the loading-state placeholder <p> and the
    // populated-state <h3>, so we wait for the card text directly.
    // The accessible name aggregates child text ("My Hero" + "Type: entity"),
    // so we match by substring and climb to the clickable host. Personal
    // cards are <button> elements (only the Default cards are touched by
    // CR-01); but we use a role-tolerant climb to be defensive.
    const personalCardName = await screen.findByText('My Hero');
    const personalCard =
      personalCardName.closest('button, [role="button"]');
    expect(personalCard).not.toBeNull();
    fireEvent.click(personalCard!);

    await waitFor(() => {
      const last = captures[captures.length - 1];
      expect(last?.pathname).toBe('/universes/U1/entries/new');
    });

    const last = captures[captures.length - 1]!;
    const state = last.state as {
      template?: { id: string; label: string };
      templateId?: string;
    };
    // CRITICAL — D-16 wire: the personal card forwards templateId so the
    // API's last_used_at stamp can fire. If this assertion regresses, the
    // entire stamp feature silently breaks.
    expect(state.templateId).toBe(personalId);
    expect(state.template?.id).toBe(personalId);
    expect(state.template?.label).toBe('My Hero');
  });

  it('renders a Clone-to-personal button on each default card', async () => {
    // Empty personal-template list.
    mockTemplatesFetch([]);

    render(<Harness />);

    await screen.findByText('Default templates');
    // The Clone-to-personal control is one <button> per Default card.
    // Visual opacity (hover state) is verified by the manual browser smoke

    // CSS transitions, so this test asserts DOM presence only.
    //
    // We query by literal text rather than by role+name because the outer
    // Default card (currently a <button> pre-CR-01) inherits its child
    // text into its accessible name — a role+name query would match BOTH
    // the inner Clone button AND the outer Default card. Text-node count
    // is the unambiguous signal here.
    const cloneTexts = screen.getAllByText('Clone to personal');
    expect(cloneTexts).toHaveLength(TEMPLATES.length); // 6 defaults
    // And each one is a button (not a div or span).
    for (const node of cloneTexts) {
      expect(node.closest('button')).not.toBeNull();
    }
  });

  it('Escape closes the picker without navigating', async () => {
    mockTemplatesFetch([]);

    const onOpenChangeSpy = vi.fn();
    const captures: LocationSnapshot[] = [];
    render(
      <Harness
        onOpenChangeCallback={onOpenChangeSpy}
        onLocationChange={(loc) => {
          captures.push(loc);
        }}
      />,
    );

    // Wait for the dialog to mount.
    const dialog = await screen.findByRole('dialog');
    // Radix Dialog listens for Escape via DOM keydown; dispatch on the dialog.
    fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });

    await waitFor(() => {
      expect(onOpenChangeSpy).toHaveBeenCalledWith(false);
    });
    // No navigation occurred — every captured location should still be the
    // initial entries list path, never /entries/new.
    const navigatedAway = captures.some(
      (c) => c.pathname === '/universes/U1/entries/new',
    );
    expect(navigatedAway).toBe(false);
  });
});
