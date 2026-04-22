import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, useNavigate } from 'react-router-dom';
import { useLogin } from '../hooks/useAuth';

const schema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
});
type FormValues = z.infer<typeof schema>;

export function Login() {
  const navigate = useNavigate();
  const login = useLogin();
  const { register, handleSubmit, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(schema),
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await login.mutateAsync(values);
      navigate('/universes', { replace: true });
    } catch {
      // Error rendered below via login.error
    }
  });

  return (
    <div className="min-h-full flex items-center justify-center px-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold">Log in to Weltbon</h1>
        <div>
          <label className="block text-sm mb-1" htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="email"
            {...register('email')}
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
          />
          {errors.email && <p className="mt-1 text-xs text-red-500">{errors.email.message}</p>}
        </div>
        <div>
          <label className="block text-sm mb-1" htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="current-password"
            {...register('password')}
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
          />
          {errors.password && <p className="mt-1 text-xs text-red-500">{errors.password.message}</p>}
        </div>
        {login.isError && (
          <p role="alert" className="text-sm text-red-500">{(login.error as Error).message}</p>
        )}
        <button
          type="submit"
          disabled={login.isPending}
          className="w-full rounded-md bg-[color:var(--color-accent)] text-white text-sm py-2 disabled:opacity-50"
        >
          {login.isPending ? 'Logging in...' : 'Log in'}
        </button>
        <p className="text-center text-sm text-neutral-600 dark:text-neutral-400">
          No account? <Link to="/register" className="underline">Register</Link>
        </p>
      </form>
    </div>
  );
}
