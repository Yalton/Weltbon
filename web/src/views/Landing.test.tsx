import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { RuntimeValue } from '../runtime/RuntimeProvider';
import { Landing } from './Landing';

const { mockUseRuntime } = vi.hoisted(() => ({
  mockUseRuntime: vi.fn<() => RuntimeValue>(),
}));
vi.mock('../runtime/RuntimeProvider', () => ({ useRuntime: mockUseRuntime }));

function renderLanding(landing: RuntimeValue['landing']) {
  mockUseRuntime.mockReturnValue({ authMode: 'server', landing });
  return render(
    <MemoryRouter>
      <Landing />
    </MemoryRouter>,
  );
}

describe('Landing view', () => {
  beforeEach(() => mockUseRuntime.mockReset());

  it('describes the app and offers both ways in', () => {
    renderLanding({ inviteRequestsEnabled: true, repoUrl: 'https://git.example.com/me/weltbon' });

    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/self-hosted workspace for worldbuilding/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /request an invitation/i })).toHaveAttribute('href', '/request-invite');

    const source = screen.getByRole('link', { name: /get the source/i });
    expect(source).toHaveAttribute('href', 'https://git.example.com/me/weltbon');
    expect(source).toHaveAttribute('target', '_blank');
    expect(source).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('links to sign-in and to registration for people who already have a code', () => {
    renderLanding({ inviteRequestsEnabled: true, repoUrl: 'https://github.com/Citreum-LLC/Weltbon' });

    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('link', { name: /create your account/i })).toHaveAttribute('href', '/register');
  });

  it('hides the invitation request when the operator turned it off', () => {
    renderLanding({ inviteRequestsEnabled: false, repoUrl: 'https://github.com/Citreum-LLC/Weltbon' });

    expect(screen.queryByRole('link', { name: /request an invitation/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /request an invitation/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /get the source/i })).toBeInTheDocument();
  });
});
