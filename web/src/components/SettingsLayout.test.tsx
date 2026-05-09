/**
 * SettingsLayout tests — Plan 09-03 must_haves truth #4.
 *
 * Asserts UI-SPEC §4.3 + §4.5 contract:
 * - <nav aria-label="Settings sections"> with two NavLinks ("Visual", "API tokens")
 * - Active state classes on the link matching the current route
 * - Container uses flex-col md:flex-row (mobile stacks above content; md: row)
 * - <Outlet /> renders nested route children
 *
 * Mirrors the MemoryRouter + Routes scaffolding from Tokens.test.tsx.
 * No QueryClient needed: SettingsLayout has no queries.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { SettingsLayout } from './SettingsLayout';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings" element={<SettingsLayout />}>
          <Route index element={<div data-testid="index-child">INDEX_CHILD</div>} />
          <Route path="tokens" element={<div data-testid="tokens-child">TOKENS_CHILD</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('SettingsLayout', () => {
  it('renders <nav> with aria-label "Settings sections"', () => {
    renderAt('/settings');
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(nav).toBeInTheDocument();
    expect(nav.tagName).toBe('NAV');
  });

  it('renders two NavLinks: "Visual" → /settings and "API tokens" → /settings/tokens', () => {
    renderAt('/settings');
    const visual = screen.getByRole('link', { name: 'Visual' });
    const apiTokens = screen.getByRole('link', { name: 'API tokens' });

    expect(visual).toBeInTheDocument();
    expect(apiTokens).toBeInTheDocument();
    expect(visual.getAttribute('href')).toBe('/settings');
    expect(apiTokens.getAttribute('href')).toBe('/settings/tokens');

    // Confirm exactly two links inside the nav
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const links = nav.querySelectorAll('a');
    expect(links.length).toBe(2);
  });

  it('applies active classes to the "Visual" link when route is /settings', () => {
    renderAt('/settings');
    const visual = screen.getByRole('link', { name: 'Visual' });
    const apiTokens = screen.getByRole('link', { name: 'API tokens' });

    const visualClass = visual.getAttribute('class') ?? '';
    const apiTokensClass = apiTokens.getAttribute('class') ?? '';

    // Active classes per UI-SPEC §4.3
    expect(visualClass).toContain('bg-[color:var(--color-accent)]/10');
    expect(visualClass).toContain('text-[color:var(--color-accent)]');
    expect(visualClass).toContain('font-medium');

    // The non-current link must NOT have active classes
    expect(apiTokensClass).not.toContain('bg-[color:var(--color-accent)]/10');
    expect(apiTokensClass).not.toContain('text-[color:var(--color-accent)]');
  });

  it('applies active classes to the "API tokens" link when route is /settings/tokens', () => {
    renderAt('/settings/tokens');
    const visual = screen.getByRole('link', { name: 'Visual' });
    const apiTokens = screen.getByRole('link', { name: 'API tokens' });

    const visualClass = visual.getAttribute('class') ?? '';
    const apiTokensClass = apiTokens.getAttribute('class') ?? '';

    // Active classes on API tokens
    expect(apiTokensClass).toContain('bg-[color:var(--color-accent)]/10');
    expect(apiTokensClass).toContain('text-[color:var(--color-accent)]');
    expect(apiTokensClass).toContain('font-medium');

    // Visual link must NOT be marked active (the `end` prop on the index NavLink
    // ensures /settings is not "matched" when the user is at /settings/tokens)
    expect(visualClass).not.toContain('bg-[color:var(--color-accent)]/10');
    expect(visualClass).not.toContain('text-[color:var(--color-accent)]');
  });

  it('container uses flex-col md:flex-row (mobile stacks; md row)', () => {
    const { container } = renderAt('/settings');
    // Outermost div in SettingsLayout
    const root = container.firstElementChild as HTMLElement | null;
    expect(root).not.toBeNull();
    const cls = root!.getAttribute('class') ?? '';
    expect(cls).toContain('flex');
    expect(cls).toContain('flex-col');
    expect(cls).toContain('md:flex-row');
  });

  it('renders <Outlet /> with the nested index route child', () => {
    renderAt('/settings');
    expect(screen.getByTestId('index-child')).toBeInTheDocument();
    expect(screen.getByText('INDEX_CHILD')).toBeInTheDocument();
    // The tokens child must NOT render at /settings
    expect(screen.queryByTestId('tokens-child')).not.toBeInTheDocument();
  });

  it('renders <Outlet /> with the nested /tokens route child', () => {
    renderAt('/settings/tokens');
    expect(screen.getByTestId('tokens-child')).toBeInTheDocument();
    expect(screen.getByText('TOKENS_CHILD')).toBeInTheDocument();
    // The index child must NOT render at /settings/tokens
    expect(screen.queryByTestId('index-child')).not.toBeInTheDocument();
  });
});
