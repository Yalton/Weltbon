/**
 * #50 Task 8 — recipient shared-connection panel.
 *
 * The security-relevant assertions here are the negative ones. The panel is
 * the only place a recipient sees anything about an administrator's
 * credential, so it is the place where owner identity or key material would
 * leak if a later change widened the type. `expectNoOwnerOrKeyMaterial`
 * therefore checks the rendered DOM text rather than the props: a component
 * that never receives a secret cannot render one, and that is exactly the
 * property worth pinning against a future "just show which admin shared it".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('../api/client', async () => {
  class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, body: unknown, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.body = body;
    }
  }
  return { api: vi.fn(), ApiError };
});

import { api, ApiError } from '../api/client';
import { SharedLlmConnections } from './SharedLlmConnections';
import type { SharedGrant } from '../hooks/useLlmShares';

function Wrapper({ children, qc }: { children: ReactNode; qc: QueryClient }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderPanel() {
  const qc = makeClient();
  render(<SharedLlmConnections />, {
    wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper>,
  });
  return qc;
}

const UNCONSENTED_ANTHROPIC: SharedGrant = {
  id: 'grant-anthropic-1',
  provider: 'anthropic',
  status: 'active',
  createdAt: '2026-08-01T00:00:00.000Z',
  consentedAt: null,
  policyVersion: 'shared-llm-v1',
  disclosure: {
    providerName: 'Anthropic',
    credentialOwner: 'administrator-managed',
    contentLeavesThisInstance: true,
  },
  usage: {
    monthStart: '2026-08-01',
    settledUsd: '0.0000',
    reservedUsd: '0.0000',
    limitUsd: '1.0000',
    activeAudits: 0,
    maxConcurrentAudits: 1,
    completedAudits: 0,
    failedAudits: 0,
  },
};

const CONSENTED_OPENAI: SharedGrant = {
  id: 'grant-openai-1',
  provider: 'openai',
  status: 'active',
  createdAt: '2026-08-02T00:00:00.000Z',
  consentedAt: '2026-08-03T00:00:00.000Z',
  policyVersion: 'shared-llm-v1',
  disclosure: {
    providerName: 'OpenAI',
    credentialOwner: 'administrator-managed',
    contentLeavesThisInstance: true,
  },
  usage: {
    monthStart: '2026-08-01',
    settledUsd: '0.2500',
    reservedUsd: '0.0500',
    limitUsd: '1.0000',
    activeAudits: 1,
    maxConcurrentAudits: 1,
    completedAudits: 3,
    failedAudits: 1,
  },
};

/**
 * Nothing that identifies the owner, and nothing shaped like a credential —
 * including the masked preview the personal-key table legitimately renders.
 */
function expectNoOwnerOrKeyMaterial() {
  expect(screen.queryByText(/••••/)).not.toBeInTheDocument();
  expect(
    screen.queryByText(
      /owner@test\.example|sk-ant-test-secret|base url|ciphertext|body suffix|auth tag/i,
    ),
  ).not.toBeInTheDocument();
  const rendered = document.body.textContent ?? '';
  for (const forbidden of ['ownerUserId', 'ownerKeyId', 'credentialOwnerId', 'sharedGrantId']) {
    expect(rendered).not.toContain(forbidden);
  }
}

describe('SharedLlmConnections', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('shows the disclosure, the monthly limit and an Accept action for an unconsented grant', async () => {
    vi.mocked(api).mockResolvedValue({ grants: [UNCONSENTED_ANTHROPIC] });
    renderPanel();

    expect(await screen.findByText(/content leaves this instance/i)).toBeInTheDocument();
    expect(screen.getByText(/\$1\.0000 monthly limit/)).toBeInTheDocument();
    expect(screen.getByText(/administrator-managed/i)).toBeInTheDocument();
    expect(screen.getByText('shared-llm-v1')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Accept Anthropic shared connection' }),
    ).toBeInTheDocument();
    expectNoOwnerOrKeyMaterial();
  });

  it('renders usage counters and a Withdraw action for a consented grant', async () => {
    vi.mocked(api).mockResolvedValue({ grants: [CONSENTED_OPENAI] });
    renderPanel();

    expect(await screen.findByText(/\$0\.2500 used of \$1\.0000 monthly limit/)).toBeInTheDocument();
    expect(screen.getByText('3 completed, 1 failed')).toBeInTheDocument();
    expect(screen.getByText('1 of 1 at a time')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Withdraw consent for OpenAI shared connection' }),
    ).toBeInTheDocument();
    // No Accept button for a grant already accepted.
    expect(screen.queryByRole('button', { name: /^Accept / })).not.toBeInTheDocument();
    expectNoOwnerOrKeyMaterial();
  });

  it('renders one card per grant', async () => {
    vi.mocked(api).mockResolvedValue({ grants: [UNCONSENTED_ANTHROPIC, CONSENTED_OPENAI] });
    renderPanel();

    expect(await screen.findByTestId('shared-llm-grant-grant-anthropic-1')).toBeInTheDocument();
    expect(screen.getByTestId('shared-llm-grant-grant-openai-1')).toBeInTheDocument();
  });

  it('accepts by POSTing to the grant consent path with no body, then refetches', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.mocked(api).mockImplementation((path: string, init?: RequestInit) => {
      calls.push([path, init]);
      if (init?.method === 'POST') {
        return Promise.resolve({
          grantId: UNCONSENTED_ANTHROPIC.id,
          consentedAt: '2026-08-28T00:00:00.000Z',
          policyVersion: 'shared-llm-v1',
        });
      }
      return Promise.resolve({
        grants: [
          calls.some(([, i]) => i?.method === 'POST')
            ? { ...UNCONSENTED_ANTHROPIC, consentedAt: '2026-08-28T00:00:00.000Z' }
            : UNCONSENTED_ANTHROPIC,
        ],
      });
    });
    renderPanel();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Accept Anthropic shared connection' }),
    );

    await waitFor(() => {
      expect(calls.some(([p, i]) => p === '/llm-shares/grant-anthropic-1/consent' && i?.method === 'POST')).toBe(true);
    });
    const post = calls.find(([, i]) => i?.method === 'POST')!;
    // The server rejects a non-empty consent body; there is nothing to send.
    expect(post[1]?.body).toBeUndefined();

    // Invalidation refetched the list, and the card flipped to the accepted state.
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Withdraw consent for Anthropic shared connection' }),
      ).toBeInTheDocument();
    });
  });

  it('withdraws by DELETEing the grant consent path', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.mocked(api).mockImplementation((path: string, init?: RequestInit) => {
      calls.push([path, init]);
      if (init?.method === 'DELETE') return Promise.resolve(undefined);
      return Promise.resolve({ grants: [CONSENTED_OPENAI] });
    });
    renderPanel();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Withdraw consent for OpenAI shared connection' }),
    );

    await waitFor(() => {
      expect(calls.some(([p, i]) => p === '/llm-shares/grant-openai-1/consent' && i?.method === 'DELETE')).toBe(true);
    });
  });

  it('surfaces the server message when a mutation fails, without losing the card', async () => {
    vi.mocked(api).mockImplementation((_path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.reject(
          new ApiError(503, {}, 'Shared connection is temporarily unavailable'),
        );
      }
      return Promise.resolve({ grants: [UNCONSENTED_ANTHROPIC] });
    });
    renderPanel();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Accept Anthropic shared connection' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Shared connection is temporarily unavailable',
    );
    expect(
      screen.getByRole('button', { name: 'Accept Anthropic shared connection' }),
    ).toBeInTheDocument();
  });

  it('renders safe retry copy when the list itself fails', async () => {
    vi.mocked(api).mockRejectedValue(new ApiError(503, {}, 'upstream exploded'));
    renderPanel();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load your shared connections.',
    );
    // The raw server text is not echoed for a whole-list failure — there is
    // no action it would help the recipient take.
    expect(screen.queryByText(/upstream exploded/)).not.toBeInTheDocument();
  });

  it('renders nothing at all when the user has no shared connections', async () => {
    vi.mocked(api).mockResolvedValue({ grants: [] });
    const { container } = render(<SharedLlmConnections />, {
      wrapper: ({ children }) => <Wrapper qc={makeClient()}>{children}</Wrapper>,
    });

    await waitFor(() => {
      expect(vi.mocked(api)).toHaveBeenCalled();
    });
    // Not an empty heading: most users will never have a grant, and a
    // permanent empty section on their settings page is pure noise.
    await waitFor(() => {
      expect(container.querySelector('[data-testid="shared-llm-connections"]')).toBeNull();
    });
  });
});
