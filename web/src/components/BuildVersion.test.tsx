/**
 * Tests for BuildVersion — the build identity line on the settings screen.
 *
 * The job this component exists for is a bug report that names the exact build.
 * That makes two behaviours load-bearing beyond "it renders": the commit sha
 * must appear when the server knows it, and a failure to reach /api/version
 * must NOT take the settings page down with it. A version line is a nicety; the
 * settings around it are not.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import BuildVersion from './BuildVersion';

function renderWith(response: () => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(response));
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <BuildVersion />
    </QueryClientProvider>,
  );
}

const json = (body: unknown, status = 200) => () =>
  Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }));

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('BuildVersion', () => {
  it('shows the version prefixed with v', async () => {
    renderWith(json({ version: '0.2.0', commit: null, builtAt: null }));
    expect(await screen.findByText(/v0\.2\.0/)).toBeInTheDocument();
  });

  it('shows the commit sha alongside the version when the server knows it', async () => {
    renderWith(json({ version: '0.2.0', commit: 'a1b2c3d', builtAt: null }));
    expect(await screen.findByText(/v0\.2\.0 \(a1b2c3d\)/)).toBeInTheDocument();
  });

  /**
   * A dev server reports commit: null. Rendering "v0.2.0 (null)" or an empty
   * pair of parentheses is worse than rendering nothing extra, because it looks
   * like a real value in a pasted bug report.
   */
  it('omits the parentheses entirely when there is no commit', async () => {
    renderWith(json({ version: '0.2.0', commit: null, builtAt: null }));
    const el = await screen.findByText(/v0\.2\.0/);
    expect(el.textContent).not.toContain('(');
  });

  it('renders nothing rather than an error when the endpoint is unreachable', async () => {
    const { container } = renderWith(() => Promise.reject(new Error('offline')));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(screen.queryByText(/error/i)).toBeNull();
  });

  it('renders nothing when the endpoint answers with an error status', async () => {
    const { container } = renderWith(json({ error: 'nope' }, 500));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('requests the version endpoint without an Authorization header', async () => {
    renderWith(json({ version: '0.2.0', commit: null, builtAt: null }));
    await screen.findByText(/v0\.2\.0/);

    const [, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = new Headers(init?.headers ?? {});
    expect(headers.has('authorization')).toBe(false);
  });
});
