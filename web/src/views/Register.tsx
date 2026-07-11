import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, useNavigate } from 'react-router-dom';
import { useRegister } from '../hooks/useAuth';
import { Panel } from '../components/ui/Panel';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';

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
      <Panel className="w-full max-w-sm p-8 shadow-ambient">
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="text-center mb-6">
            <span className="wordmark text-3xl">Weltbon</span>
            <h1 className="mt-2 text-sm text-ink-secondary">Create your account</h1>
          </div>
          <div>
            <label className="block text-sm mb-1 text-ink-secondary" htmlFor="displayName">Display name</label>
            <Input id="displayName" {...register('displayName')} />
            {errors.displayName && <p className="mt-1 text-xs text-rose-400">{errors.displayName.message}</p>}
          </div>
          <div>
            <label className="block text-sm mb-1 text-ink-secondary" htmlFor="email">Email</label>
            <Input id="email" type="email" autoComplete="email" {...register('email')} />
            {errors.email && <p className="mt-1 text-xs text-rose-400">{errors.email.message}</p>}
          </div>
          <div>
            <label className="block text-sm mb-1 text-ink-secondary" htmlFor="password">Password</label>
            <Input id="password" type="password" autoComplete="new-password" {...register('password')} />
            {errors.password && <p className="mt-1 text-xs text-rose-400">{errors.password.message}</p>}
          </div>
          <div>
            <label className="block text-sm mb-1 text-ink-secondary" htmlFor="inviteCode">Invite code</label>
            <Input id="inviteCode" {...register('inviteCode')} />
            {errors.inviteCode && <p className="mt-1 text-xs text-rose-400">{errors.inviteCode.message}</p>}
          </div>
          {registerMut.isError && (
            <p role="alert" className="text-sm text-rose-400">{(registerMut.error as Error).message}</p>
          )}
          <Button type="submit" disabled={registerMut.isPending} className="w-full">
            {registerMut.isPending ? 'Creating...' : 'Create account'}
          </Button>
          <p className="text-center text-sm text-ink-secondary">
            Have an account? <Link to="/login" className="text-indigo-300 hover:text-indigo-200 underline">Log in</Link>
          </p>
        </form>
      </Panel>
    </div>
  );
}
