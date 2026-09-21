import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuthStore } from '../store/auth';

export function useInstanceConfig(): { localMode: boolean | undefined } {
  const user = useAuthStore((s) => s.user);
  const { data } = useQuery({
    queryKey: ['instance-config'],
    queryFn: () => api<{ localMode: boolean }>('/config'),
    enabled: user !== null,
    staleTime: Infinity,
  });
  return { localMode: data?.localMode };
}
