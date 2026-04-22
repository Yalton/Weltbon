import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, useNavigate } from 'react-router-dom';
import { useRegister } from '../hooks/useAuth';

const schema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(12, 'Password must be at least 12 characters'),
  displayName: z.string().min(1, 'Display name is required').max(80),
  inviteCode: z.string().min(1, 'Invite code is required'),
});
type FormValues = z.infer<typeof schema>;

export function Register() {
  const navigate = useNavigate();
  const registerMut = useRegister();
  const { register, handleSubmit, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(schema),
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await registerMut.mutateAsync(values);
      navigate('/universes', { replace: true });
    } catch {
      // Error rendered via registerMut.error
    }
  });

  return (
    <div className="min-h-full flex items-center justify-center px-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold">Create your Weltbon account</h1>
        <div>
          <label className="block text-sm mb-1" htmlFor="displayName">Display name</label>
          <input id="displayName" {...register('displayName')}
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm" />
          {errors.displayName && <p className="mt-1 text-xs text-red-500">{errors.displayName.message}</p>}
        </div>
        <div>
          <label className="block text-sm mb-1" htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="email" {...register('email')}
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm" />
          {errors.email && <p className="mt-1 text-xs text-red-500">{errors.email.message}</p>}
        </div>
        <div>
          <label className="block text-sm mb-1" htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="new-password" {...register('password')}
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm" />
          {errors.password && <p className="mt-1 text-xs text-red-500">{errors.password.message}</p>}
        </div>
        <div>
          <label className="block text-sm mb-1" htmlFor="inviteCode">Invite code</label>
          <input id="inviteCode" {...register('inviteCode')}
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm" />
          {errors.inviteCode && <p className="mt-1 text-xs text-red-500">{errors.inviteCode.message}</p>}
        </div>
        {registerMut.isError && (
          <p role="alert" className="text-sm text-red-500">{(registerMut.error as Error).message}</p>
        )}
        <button
          type="submit"
          disabled={registerMut.isPending}
          className="w-full rounded-md bg-[color:var(--color-accent)] text-white text-sm py-2 disabled:opacity-50"
        >
          {registerMut.isPending ? 'Creating...' : 'Create account'}
        </button>
        <p className="text-center text-sm text-neutral-600 dark:text-neutral-400">
          Have an account? <Link to="/login" className="underline">Log in</Link>
        </p>
      </form>
    </div>
  );
}
