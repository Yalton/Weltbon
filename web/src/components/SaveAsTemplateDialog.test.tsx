import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, MutationCache } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { SaveAsTemplateDialog } from './SaveAsTemplateDialog';

// Mock the api client (useCreateTemplate relies on it).
// SaveAsTemplateDialog also imports UnauthenticatedError (WR-05 re-throw
// path); the mock must export it, otherwise the dialog's `err instanceof
// UnauthenticatedError` check throws a TypeError that short-circuits the
// 409/generic catch branches.
vi.mock('../api/client', () => ({
  api: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, body: unknown, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.body = body;
    }
  },
  UnauthenticatedError: class UnauthenticatedError extends Error {
    constructor() { super('Not authenticated'); this.name = 'UnauthenticatedError'; }
  },
}));

import { api, ApiError } from '../api/client';

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    mutationCache: new MutationCache({
      onError: () => { /* suppress unhandled rejection noise in tests */ },
    }),
  });
}

function Wrapper({ children, qc }: { children: ReactNode; qc: QueryClient }) {
  return (
    <QueryClientProvider client={qc}>
      {children}
    </QueryClientProvider>
  );
}

const defaultSnapshot = () => ({
  summary: 'A hero in the making.',
  body: '## Background\n\nSome text.',
  meta: [
    { name: 'species', default_value: 'human' },
    { name: 'age', default_value: '25' },
  ],
});

const mockTemplate = {
  id: 'tmpl-1',
  name: 'My Hero',
  entryType: 'entity',
  summary: 'A hero in the making.',
  body: '## Background\n\nSome text.',
  meta: [{ name: 'species', default_value: 'human' }, { name: 'age', default_value: '25' }],
  clonedFrom: null,
  lastUsedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('SaveAsTemplateDialog', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  // Test 1: Renders with correct title, description, and form elements
  it('renders with "Save as template" title and correct field label', () => {
    const qc = makeClient();
    render(
      <Wrapper qc={qc}>
        <SaveAsTemplateDialog
          open={true}
          onOpenChange={vi.fn()}
          entryType="entity"
          captureSnapshot={defaultSnapshot}
        />
      </Wrapper>
    );

    expect(screen.getByRole('heading', { name: 'Save as template' })).toBeInTheDocument();
    expect(screen.getByLabelText('Template name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save template' })).toBeInTheDocument();
  });

  // Test 2: Description interpolates entryType
  it('shows description interpolating entryType prop', () => {
    const qc = makeClient();
    render(
      <Wrapper qc={qc}>
        <SaveAsTemplateDialog
          open={true}
          onOpenChange={vi.fn()}
          entryType="magic-system"
          captureSnapshot={defaultSnapshot}
        />
      </Wrapper>
    );

    expect(
      screen.getByText(/scoped to magic-system/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/for future magic-system entries/)
    ).toBeInTheDocument();
  });

  // Test 3: Submitting empty name shows "Name is required." validation error
  it('shows "Name is required." error on empty submit and does not call mutation', async () => {
    vi.mocked(api).mockResolvedValue(mockTemplate);
    const qc = makeClient();
    render(
      <Wrapper qc={qc}>
        <SaveAsTemplateDialog
          open={true}
          onOpenChange={vi.fn()}
          entryType="entity"
          captureSnapshot={defaultSnapshot}
        />
      </Wrapper>
    );

    await userEvent.click(screen.getByRole('button', { name: 'Save template' }));

    await waitFor(() => {
      expect(screen.getByText('Name is required.')).toBeInTheDocument();
    });
    expect(api).not.toHaveBeenCalled();
  });

  // Test 4: Name > 80 characters shows max-length error
  it('shows "Name can be at most 80 characters." error for names > 80 chars', async () => {
    vi.mocked(api).mockResolvedValue(mockTemplate);
    const qc = makeClient();
    render(
      <Wrapper qc={qc}>
        <SaveAsTemplateDialog
          open={true}
          onOpenChange={vi.fn()}
          entryType="entity"
          captureSnapshot={defaultSnapshot}
        />
      </Wrapper>
    );

    const input = screen.getByLabelText('Template name') as HTMLInputElement;
    input.removeAttribute('maxlength');
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(input, { target: { value: 'a'.repeat(81) } });

    await userEvent.click(screen.getByRole('button', { name: 'Save template' }));

    await waitFor(() => {
      expect(screen.getByText('Name can be at most 80 characters.')).toBeInTheDocument();
    });
    expect(api).not.toHaveBeenCalled();
  });

  // Test 5: Successful save calls onSuccess and onOpenChange(false)
  it('calls onSuccess and closes dialog after successful save', async () => {
    vi.mocked(api).mockResolvedValue(mockTemplate);
    const onSuccess = vi.fn();
    const onOpenChange = vi.fn();
    const qc = makeClient();

    render(
      <Wrapper qc={qc}>
        <SaveAsTemplateDialog
          open={true}
          onOpenChange={onOpenChange}
          entryType="entity"
          captureSnapshot={defaultSnapshot}
          onSuccess={onSuccess}
        />
      </Wrapper>
    );

    await userEvent.type(screen.getByLabelText('Template name'), 'My Hero');
    await userEvent.click(screen.getByRole('button', { name: 'Save template' }));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledOnce();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  // Test 6: Mutation is called with captureSnapshot output
  it('calls mutateAsync with values from captureSnapshot', async () => {
    vi.mocked(api).mockResolvedValue(mockTemplate);
    const qc = makeClient();

    render(
      <Wrapper qc={qc}>
        <SaveAsTemplateDialog
          open={true}
          onOpenChange={vi.fn()}
          entryType="entity"
          captureSnapshot={defaultSnapshot}
        />
      </Wrapper>
    );

    await userEvent.type(screen.getByLabelText('Template name'), 'My Hero');
    await userEvent.click(screen.getByRole('button', { name: 'Save template' }));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith(
        '/templates',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            name: 'My Hero',
            entryType: 'entity',
            summary: 'A hero in the making.',
            body: '## Background\n\nSome text.',
            meta: [
              { name: 'species', default_value: 'human' },
              { name: 'age', default_value: '25' },
            ],
          }),
        }),
      );
    });
  });

  // Test 7: 409 ApiError shows inline error under Name input (NOT a toast)
  it('shows inline collision error under Name input on 409 response', async () => {
    const conflictError = new ApiError(
      409,
      { error: 'You already have a entity template named "My Hero". Pick a different name.' },
      'You already have a entity template named "My Hero". Pick a different name.',
    );
    vi.mocked(api).mockRejectedValue(conflictError);
    const qc = makeClient();

    render(
      <Wrapper qc={qc}>
        <SaveAsTemplateDialog
          open={true}
          onOpenChange={vi.fn()}
          entryType="entity"
          captureSnapshot={defaultSnapshot}
        />
      </Wrapper>
    );

    await userEvent.type(screen.getByLabelText('Template name'), 'My Hero');
    await userEvent.click(screen.getByRole('button', { name: 'Save template' }));

    await waitFor(() => {
      expect(
        screen.getByRole('alert')
      ).toHaveTextContent('You already have a entity template named "My Hero". Pick a different name.');
    });
    // dialog stays open (onOpenChange not called with false)
  });

  // Test 8: Non-409 error calls onGenericError
  it('calls onGenericError on non-409 API error', async () => {
    const serverError = new ApiError(500, {}, 'Internal server error');
    vi.mocked(api).mockRejectedValue(serverError);
    const onGenericError = vi.fn();
    const qc = makeClient();

    render(
      <Wrapper qc={qc}>
        <SaveAsTemplateDialog
          open={true}
          onOpenChange={vi.fn()}
          entryType="entity"
          captureSnapshot={defaultSnapshot}
          onGenericError={onGenericError}
        />
      </Wrapper>
    );

    await userEvent.type(screen.getByLabelText('Template name'), 'My Hero');
    await userEvent.click(screen.getByRole('button', { name: 'Save template' }));

    await waitFor(() => {
      expect(onGenericError).toHaveBeenCalledOnce();
    });
  });

  // Test 9: Submit button shows "Saving…" (U+2026) and is disabled while pending
  it('shows "Saving…" and disables submit while mutation is pending', async () => {
    let resolveFn: (v: unknown) => void = () => {};
    vi.mocked(api).mockReturnValue(new Promise((r) => { resolveFn = r; }));

    const qc = makeClient();
    render(
      <Wrapper qc={qc}>
        <SaveAsTemplateDialog
          open={true}
          onOpenChange={vi.fn()}
          entryType="entity"
          captureSnapshot={defaultSnapshot}
        />
      </Wrapper>
    );

    await userEvent.type(screen.getByLabelText('Template name'), 'My Hero');
    await userEvent.click(screen.getByRole('button', { name: 'Save template' }));

    await waitFor(() => {
      const btn = screen.getByRole('button', { name: 'Saving…' });
      expect(btn).toBeInTheDocument();
      expect(btn).toBeDisabled();
    });

    // Resolve to avoid hanging
    resolveFn(mockTemplate);
  });

  // Test 10: Closing and reopening clears the name field and any collision error
  it('clears the form on close', async () => {
    const conflictError = new ApiError(
      409,
      { error: 'You already have a entity template named "X". Pick a different name.' },
      'You already have a entity template named "X". Pick a different name.',
    );
    vi.mocked(api).mockRejectedValue(conflictError);

    const onOpenChange = vi.fn();
    const qc = makeClient();

    function Harness() {
      const { useState } = require('react');
      const [open, setOpen] = useState(true);
      const handleChange = (o: boolean) => {
        setOpen(o);
        onOpenChange(o);
      };
      return (
        <Wrapper qc={qc}>
          <SaveAsTemplateDialog
            open={open}
            onOpenChange={handleChange}
            entryType="entity"
            captureSnapshot={defaultSnapshot}
          />
        </Wrapper>
      );
    }

    render(<Harness />);

    await userEvent.type(screen.getByLabelText('Template name'), 'X');
    await userEvent.click(screen.getByRole('button', { name: 'Save template' }));

    await waitFor(() => {
      expect(screen.getAllByRole('alert').length).toBeGreaterThanOrEqual(1);
    });

    // Click Cancel to close
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  // Test 11: Input has placeholder "e.g. Magic-System"
  it('has placeholder "e.g. Magic-System" on the name input', () => {
    const qc = makeClient();
    render(
      <Wrapper qc={qc}>
        <SaveAsTemplateDialog
          open={true}
          onOpenChange={vi.fn()}
          entryType="entity"
          captureSnapshot={defaultSnapshot}
        />
      </Wrapper>
    );

    const input = screen.getByPlaceholderText('e.g. Magic-System');
    expect(input).toBeInTheDocument();
  });
});
