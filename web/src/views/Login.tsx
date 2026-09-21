import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, useNavigate } from 'react-router-dom';
import { useLogin } from '../hooks/useAuth';
import { Panel } from '../components/ui/Panel';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';

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
    }
  });

  return (
    <div className="min-h-full flex items-center justify-center px-4">
      <Panel className="w-full max-w-sm p-8 shadow-ambient">
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="text-center mb-6">
            <span className="wordmark text-3xl">Weltbon</span>
            <h1 className="mt-2 text-sm text-ink-secondary">Log in to your worlds</h1>
          </div>
          <div>
            <label className="block text-sm mb-1 text-ink-secondary" htmlFor="email">Email</label>
            <Input id="email" type="email" autoComplete="email" {...register('email')} />
            {errors.email && <p className="mt-1 text-xs text-rose-400">{errors.email.message}</p>}
          </div>
          <div>
            <label className="block text-sm mb-1 text-ink-secondary" htmlFor="password">Password</label>
            <Input id="password" type="password" autoComplete="current-password" {...register('password')} />
            {errors.password && <p className="mt-1 text-xs text-rose-400">{errors.password.message}</p>}
          </div>
          {login.isError && (
            <p role="alert" className="text-sm text-rose-400">{(login.error as Error).message}</p>
          )}
          <Button type="submit" disabled={login.isPending} className="w-full">
            {login.isPending ? 'Logging in...' : 'Log in'}
          </Button>
          <p className="text-center text-sm text-ink-secondary">
            No account? <Link to="/register" className="text-indigo-300 hover:text-indigo-200 underline">Register</Link>
          </p>
        </form>
      </Panel>
    </div>
  );
}
