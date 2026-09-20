import { type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LinkSection } from './LinkSection';
import { ShareModeProvider } from '../contexts/ShareModeContext';

vi.mock('../hooks/useLinks', () => ({
  useDeleteLink: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('./LinkEditor', () => ({
  LinkEditor: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const outboundLinks = [{
  id: 'L1',
  targetEntryId: 'E2',
  targetTitle: 'Aragorn',
  targetIcon: '⚔️',
  label: 'foster parent',
  linkType: 'guardian',
  direction: 'directed',
}];

function renderSection(shareMode = false) {
  const section = (
    <MemoryRouter>
      <LinkSection
        outboundLinks={outboundLinks}
        backlinks={[]}
        universeId="U1"
        entryId="E1"
        onLinkCreated={vi.fn()}
      />
    </MemoryRouter>
  );
  return render(shareMode ? <ShareModeProvider>{section}</ShareModeProvider> : section);
}

describe('LinkSection edit controls', () => {
  it('shows Edit beside Remove for an owner’s existing outbound link', () => {
    renderSection();

    expect(screen.getByRole('button', { name: 'Edit link to Aragorn' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove link' })).toBeInTheDocument();
  });

  it('keeps existing links read-only in share mode', () => {
    renderSection(true);

    expect(screen.queryByRole('button', { name: /edit link/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /remove link/i })).toBeNull();
  });
});
