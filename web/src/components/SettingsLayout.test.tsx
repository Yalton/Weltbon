
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { SettingsLayout } from './SettingsLayout';
import { useAuthStore } from '../store/auth';

vi.mock('../runtime/RuntimeProvider', () => ({
  useRuntime: () => ({ authMode: 'server' }),
}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings" element={<SettingsLayout />}>
          <Route index element={<div data-testid="index-child">INDEX_CHILD</div>} />
          <Route path="tokens" element={<div data-testid="tokens-child">TOKENS_CHILD</div>} />
          <Route path="invites" element={<div data-testid="invites-child">INVITES_CHILD</div>} />
          <Route path="templates" element={<div data-testid="templates-child">TEMPLATES_CHILD</div>} />
          <Route path="shares" element={<div data-testid="shares-child">SHARES_CHILD</div>} />
          <Route path="llm" element={<div data-testid="llm-child">LLM_CHILD</div>} />
          <Route path="sync" element={<div data-testid="sync-child">SYNC_CHILD</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('SettingsLayout', () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: { id: 'admin-1', email: 'admin@test.dev', displayName: 'Admin', isAdmin: true },
    });
  });

  it('renders <nav> with aria-label "Settings sections"', () => {
    renderAt('/settings');
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(nav).toBeInTheDocument();
    expect(nav.tagName).toBe('NAV');
  });

  it('renders administrator NavLinks, including Users and invite management', () => {
    renderAt('/settings');
    const visual = screen.getByRole('link', { name: 'Visual' });
    const apiTokens = screen.getByRole('link', { name: 'API tokens' });
    const inviteCodes = screen.getByRole('link', { name: 'Invite codes' });
    const users = screen.getByRole('link', { name: 'Users' });
    const templates = screen.getByRole('link', { name: 'Templates' });
    const shares = screen.getByRole('link', { name: 'Shares' });
    const llmKeys = screen.getByRole('link', { name: 'LLM keys' });

    const sync = screen.getByRole('link', { name: 'Sync' });

    expect(visual.getAttribute('href')).toBe('/settings');
    expect(apiTokens.getAttribute('href')).toBe('/settings/tokens');
    expect(inviteCodes.getAttribute('href')).toBe('/settings/invites');
    expect(users.getAttribute('href')).toBe('/settings/users');
    expect(templates.getAttribute('href')).toBe('/settings/templates');
    expect(shares.getAttribute('href')).toBe('/settings/shares');
    expect(llmKeys.getAttribute('href')).toBe('/settings/llm');
    expect(sync.getAttribute('href')).toBe('/settings/sync');

    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(nav.querySelectorAll('a').length).toBe(8);
  });

  it('hides administrator-only settings links for a non-administrator', () => {
    useAuthStore.setState({ user: { id: 'member-1', email: 'member@test.dev', displayName: 'Member', isAdmin: false } });
    renderAt('/settings');
    expect(screen.queryByRole('link', { name: 'API tokens' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Invite codes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Users' })).not.toBeInTheDocument();
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

  it('applies active classes to "Invite codes" link when route is /settings/invites', () => {
    renderAt('/settings/invites');
    const inviteCodes = screen.getByRole('link', { name: 'Invite codes' });
    const cls = inviteCodes.getAttribute('class') ?? '';
    expect(cls).toContain('bg-[color:var(--color-accent)]/10');
    expect(cls).toContain('text-[color:var(--color-accent)]');
    expect(cls).toContain('font-medium');
    // Other links must NOT carry the active classes
    const visual = screen.getByRole('link', { name: 'Visual' });
    expect(visual.getAttribute('class') ?? '').not.toContain('bg-[color:var(--color-accent)]/10');
    const apiTokens = screen.getByRole('link', { name: 'API tokens' });
    expect(apiTokens.getAttribute('class') ?? '').not.toContain('bg-[color:var(--color-accent)]/10');
  });

  it('renders Outlet with the nested /invites route child', () => {
    renderAt('/settings/invites');
    expect(screen.getByTestId('invites-child')).toBeInTheDocument();
    expect(screen.queryByTestId('index-child')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tokens-child')).not.toBeInTheDocument();
  });

  it('applies active classes to "Shares" link when route is /settings/shares', () => {
    renderAt('/settings/shares');
    const shares = screen.getByRole('link', { name: 'Shares' });
    const cls = shares.getAttribute('class') ?? '';
    expect(cls).toContain('bg-[color:var(--color-accent)]/10');
    expect(cls).toContain('text-[color:var(--color-accent)]');
    expect(cls).toContain('font-medium');
    // The other links must NOT carry the active classes.
    const visual = screen.getByRole('link', { name: 'Visual' });
    expect(visual.getAttribute('class') ?? '').not.toContain('bg-[color:var(--color-accent)]/10');
    const llmKeys = screen.getByRole('link', { name: 'LLM keys' });
    expect(llmKeys.getAttribute('class') ?? '').not.toContain('bg-[color:var(--color-accent)]/10');
  });

  it('renders Outlet with the nested /shares route child', () => {
    renderAt('/settings/shares');
    expect(screen.getByTestId('shares-child')).toBeInTheDocument();
    expect(screen.queryByTestId('index-child')).not.toBeInTheDocument();
    expect(screen.queryByTestId('llm-child')).not.toBeInTheDocument();
  });

  it('applies active classes to "LLM keys" link when route is /settings/llm', () => {
    renderAt('/settings/llm');
    const llmKeys = screen.getByRole('link', { name: 'LLM keys' });
    const cls = llmKeys.getAttribute('class') ?? '';
    expect(cls).toContain('bg-[color:var(--color-accent)]/10');
    expect(cls).toContain('text-[color:var(--color-accent)]');
    expect(cls).toContain('font-medium');
    // The other links must NOT carry the active classes.
    const visual = screen.getByRole('link', { name: 'Visual' });
    expect(visual.getAttribute('class') ?? '').not.toContain('bg-[color:var(--color-accent)]/10');
    const apiTokens = screen.getByRole('link', { name: 'API tokens' });
    expect(apiTokens.getAttribute('class') ?? '').not.toContain('bg-[color:var(--color-accent)]/10');
    const inviteCodes = screen.getByRole('link', { name: 'Invite codes' });
    expect(inviteCodes.getAttribute('class') ?? '').not.toContain('bg-[color:var(--color-accent)]/10');
    const shares = screen.getByRole('link', { name: 'Shares' });
    expect(shares.getAttribute('class') ?? '').not.toContain('bg-[color:var(--color-accent)]/10');
  });

  it('applies active classes to "Sync" link when route is /settings/sync', () => {
    renderAt('/settings/sync');
    const sync = screen.getByRole('link', { name: 'Sync' });
    const cls = sync.getAttribute('class') ?? '';
    expect(cls).toContain('bg-[color:var(--color-accent)]/10');
    expect(cls).toContain('text-[color:var(--color-accent)]');
    expect(cls).toContain('font-medium');
    // The other links must NOT carry the active classes.
    const visual = screen.getByRole('link', { name: 'Visual' });
    expect(visual.getAttribute('class') ?? '').not.toContain('bg-[color:var(--color-accent)]/10');
    const llmKeys = screen.getByRole('link', { name: 'LLM keys' });
    expect(llmKeys.getAttribute('class') ?? '').not.toContain('bg-[color:var(--color-accent)]/10');
  });

  it('renders Outlet with the nested /sync route child', () => {
    renderAt('/settings/sync');
    expect(screen.getByTestId('sync-child')).toBeInTheDocument();
    expect(screen.queryByTestId('index-child')).not.toBeInTheDocument();
    expect(screen.queryByTestId('llm-child')).not.toBeInTheDocument();
  });

  it('renders Outlet with the nested /llm route child', () => {
    renderAt('/settings/llm');
    expect(screen.getByTestId('llm-child')).toBeInTheDocument();
    expect(screen.queryByTestId('index-child')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tokens-child')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invites-child')).not.toBeInTheDocument();
    expect(screen.queryByTestId('shares-child')).not.toBeInTheDocument();
  });
});
