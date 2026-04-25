import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../api/client', () => ({
  getAccessToken: vi.fn(() => 'TOKEN'),
}));

import { ExportMenu } from '../ExportMenu';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

interface CapturedAnchor {
  href: string;
  download: string;
  clicks: number;
}

let anchorClicks: CapturedAnchor[] = [];
let originalCreateElement: typeof document.createElement;

function installAnchorCapture() {
  anchorClicks = [];
  originalCreateElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = originalCreateElement(tag) as HTMLElement;
    if (tag === 'a') {
      const a = el as HTMLAnchorElement;
      const captured: CapturedAnchor = { href: '', download: '', clicks: 0 };
      Object.defineProperty(a, 'href', {
        configurable: true,
        get: () => captured.href,
        set: (v: string) => {
          captured.href = v;
        },
      });
      Object.defineProperty(a, 'download', {
        configurable: true,
        get: () => captured.download,
        set: (v: string) => {
          captured.download = v;
        },
      });
      a.click = () => {
        captured.clicks += 1;
      };
      anchorClicks.push(captured);
    }
    return el as HTMLElement;
  });
}

function makeBlobResponse(
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const headers = new Headers(init.headers ?? {});
  if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream');
  return new Response(new Blob([body]), {
    status: init.status ?? 200,
    headers,
  });
}

beforeEach(() => {
  installAnchorCapture();
  // jsdom lacks URL.createObjectURL/revokeObjectURL
  if (!('createObjectURL' in URL)) {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 'blob:mock'),
    });
  } else {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
  }
  if (!('revokeObjectURL' in URL)) {
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  } else {
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  anchorClicks = [];
});

describe('ExportMenu', () => {
  it('renders trigger and 4 items in order: JSON, Markdown ZIP, PDF, DOCX', async () => {
    render(<ExportMenu universeId="u1" fallbackFilename="test" onToast={() => {}} />);

    const trigger = screen.getByRole('button', { name: /^Export/ });
    await userEvent.click(trigger);

    expect(await screen.findByText('JSON')).toBeInTheDocument();
    expect(screen.getByText('Markdown ZIP')).toBeInTheDocument();
    expect(screen.getByText('PDF')).toBeInTheDocument();
    expect(screen.getByText('DOCX')).toBeInTheDocument();
  });

  it('clicking JSON triggers fetch with format=json + Bearer auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeBlobResponse('{}', {
        headers: { 'content-disposition': 'attachment; filename="test-2026-04-25.json"' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<ExportMenu universeId="u1" fallbackFilename="test" onToast={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /^Export/ }));
    await userEvent.click(await screen.findByText('JSON'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [FetchInput, FetchInit];
    expect(String(url)).toBe('/api/universes/u1/export?format=json');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer TOKEN');
    expect(init?.credentials).toBe('include');
  });

  it.each<['markdown' | 'pdf' | 'docx', string]>([
    ['markdown', 'Markdown ZIP'],
    ['pdf', 'PDF'],
    ['docx', 'DOCX'],
  ])('clicking %s hits ?format=%s URL', async (format, label) => {
    const fetchMock = vi.fn().mockResolvedValue(makeBlobResponse('x'));
    vi.stubGlobal('fetch', fetchMock);

    render(<ExportMenu universeId="u9" fallbackFilename="fb" onToast={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /^Export/ }));
    await userEvent.click(await screen.findByText(label));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url] = fetchMock.mock.calls[0] as [FetchInput];
    expect(String(url)).toBe(`/api/universes/u9/export?format=${format}`);
  });

  it('shows spinner on clicked item only while in flight', async () => {
    let resolveFetch!: (r: Response) => void;
    const pending = new Promise<Response>((res) => {
      resolveFetch = res;
    });
    const fetchMock = vi.fn().mockReturnValue(pending);
    vi.stubGlobal('fetch', fetchMock);

    render(<ExportMenu universeId="u1" fallbackFilename="t" onToast={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /^Export/ }));
    await userEvent.click(await screen.findByText('PDF'));

    await screen.findByText(/Exporting PDF/i);
    // Other items unchanged
    expect(screen.getByText('JSON')).toBeInTheDocument();
    expect(screen.getByText('Markdown ZIP')).toBeInTheDocument();
    expect(screen.getByText('DOCX')).toBeInTheDocument();
    expect(screen.queryByText(/Exporting JSON/i)).not.toBeInTheDocument();

    resolveFetch(makeBlobResponse('x'));
    await waitFor(() => expect(screen.queryByText(/Exporting PDF/i)).not.toBeInTheDocument());
  });

  it('fires onToast on non-2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('boom', { status: 503 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onToast = vi.fn();
    // Silence expected console.error from the failure path
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<ExportMenu universeId="u1" fallbackFilename="t" onToast={onToast} />);
    await userEvent.click(screen.getByRole('button', { name: /^Export/ }));
    await userEvent.click(await screen.findByText('PDF'));

    await waitFor(() => expect(onToast).toHaveBeenCalled());
    expect(onToast.mock.calls[0][0]).toMatch(/failed/i);
    errSpy.mockRestore();
  });

  it('uses Content-Disposition filename when present', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeBlobResponse('{}', {
        headers: {
          'content-disposition': 'attachment; filename="cool-universe-2026-04-25.json"',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<ExportMenu universeId="u1" fallbackFilename="fallback" onToast={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /^Export/ }));
    await userEvent.click(await screen.findByText('JSON'));

    await waitFor(() => expect(anchorClicks.some((a) => a.clicks > 0)).toBe(true));
    const clicked = anchorClicks.find((a) => a.clicks > 0);
    expect(clicked?.download).toBe('cool-universe-2026-04-25.json');
  });

  it('falls back to {fallback}.{ext} when Content-Disposition is missing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeBlobResponse('x'));
    vi.stubGlobal('fetch', fetchMock);

    render(<ExportMenu universeId="u1" fallbackFilename="myverse" onToast={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /^Export/ }));
    await userEvent.click(await screen.findByText('PDF'));

    await waitFor(() => expect(anchorClicks.some((a) => a.clicks > 0)).toBe(true));
    const clicked = anchorClicks.find((a) => a.clicks > 0);
    expect(clicked?.download).toBe('myverse.pdf');
  });

  it('keeps menu open during async export (does not auto-close on item select)', async () => {
    let resolveFetch!: (r: Response) => void;
    const pending = new Promise<Response>((res) => {
      resolveFetch = res;
    });
    const fetchMock = vi.fn().mockReturnValue(pending);
    vi.stubGlobal('fetch', fetchMock);

    render(<ExportMenu universeId="u1" fallbackFilename="t" onToast={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /^Export/ }));
    await userEvent.click(await screen.findByText('PDF'));

    // Menu items still rendered while fetch is pending.
    expect(screen.getByText(/Exporting PDF/i)).toBeInTheDocument();
    expect(screen.getByText('JSON')).toBeInTheDocument();

    resolveFetch(makeBlobResponse('x'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});
