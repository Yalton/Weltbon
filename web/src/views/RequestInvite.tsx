import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { z } from 'zod';
import { Link, Navigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { useRuntime } from '../runtime/RuntimeProvider';
import { Panel } from '../components/ui/Panel';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';

const schema = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(100, 'Keep your name under 100 characters'),
  email: z.string().trim().email('Enter a valid email').max(254),
  note: z.string().max(1000, 'Keep the note under 1000 characters'),
  // Honeypot: hidden from people, so only bots fill it in.
  website: z.string(),
});
type FormValues = z.infer<typeof schema>;

function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 429) return 'Too many requests, try again later.';
  return 'Could not send your request. Check your connection and try again.';
}

export function RequestInvite() {
  const { landing } = useRuntime();
  const send = useMutation({
    mutationFn: (body: FormValues) =>
      api('/invite-requests', { method: 'POST', body: JSON.stringify(body) }),
  });
  const { register, handleSubmit, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', email: '', note: '', website: '' },
  });

  if (!landing.inviteRequestsEnabled) return <Navigate to="/" replace />;

  const onSubmit = handleSubmit(async (values) => {
    try {
      await send.mutateAsync(values);
    } catch {
      // Rendered from send.error below.
    }
  });

  return (
    <div className="min-h-full flex items-center justify-center px-4 py-10">
      <Panel className="w-full max-w-md p-8 shadow-ambient">
        <div className="mb-6">
          <Link to="/" className="wordmark text-2xl">Weltbon</Link>
        </div>

        {send.isSuccess ? (
          <div aria-live="polite">
            <h1 className="font-display text-2xl font-medium text-ink">Request sent</h1>
            <p className="mt-3 text-sm leading-relaxed text-ink-secondary">
              Thanks. The person who runs this server will review your request and, if they can
              make room for you, email you an invitation code.
            </p>
            <Link
              to="/"
              className="mt-6 inline-block text-sm text-accent-ink underline decoration-accent-strong/50 underline-offset-4 hover:decoration-accent-ink"
            >
              Back to the start
            </Link>
          </div>
        ) : (
          <form onSubmit={onSubmit} noValidate className="space-y-4">
            <div>
              <h1 className="font-display text-2xl font-medium text-ink">Request an invitation</h1>
              <p className="mt-2 text-sm leading-relaxed text-ink-secondary">
                Accounts on this server are invite-only. Tell the operator who you are and they can
                send you a code by email.
              </p>
            </div>
            <div>
              <label className="block text-sm mb-1 text-ink-secondary" htmlFor="name">Name</label>
              <Input id="name" autoComplete="name" aria-invalid={!!errors.name} {...register('name')} />
              {errors.name && <p className="mt-1 text-xs text-rose-400">{errors.name.message}</p>}
            </div>
            <div>
              <label className="block text-sm mb-1 text-ink-secondary" htmlFor="email">Email</label>
              <Input id="email" type="email" autoComplete="email" aria-invalid={!!errors.email} {...register('email')} />
              {errors.email && <p className="mt-1 text-xs text-rose-400">{errors.email.message}</p>}
            </div>
            <div>
              <label className="block text-sm mb-1 text-ink-secondary" htmlFor="note">
                What would you like to build? <span className="text-ink-muted">(optional)</span>
              </label>
              <textarea
                id="note"
                rows={4}
                maxLength={1000}
                aria-invalid={!!errors.note}
                className="w-full rounded-lg bg-white/5 border border-glass-border px-3 py-2 text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:border-transparent"
                {...register('note')}
              />
              {errors.note && <p className="mt-1 text-xs text-rose-400">{errors.note.message}</p>}
            </div>
            <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
              <label htmlFor="website">Website</label>
              <input id="website" type="text" tabIndex={-1} autoComplete="off" {...register('website')} />
            </div>
            {send.isError && (
              <p role="alert" className="text-sm text-rose-400">{errorMessage(send.error)}</p>
            )}
            <Button type="submit" disabled={send.isPending} className="w-full">
              {send.isPending ? 'Sending…' : 'Send request'}
            </Button>
            <p className="text-center text-sm text-ink-secondary">
              <Link to="/" className="text-indigo-300 hover:text-indigo-200 underline">Back</Link>
            </p>
          </form>
        )}
      </Panel>
    </div>
  );
}
