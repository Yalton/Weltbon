import { useQuery } from '@tanstack/react-query';

interface BuildInfo {
  version: string;
  commit: string | null;
  builtAt: string | null;
}

async function fetchBuildInfo(): Promise<BuildInfo> {
  const res = await fetch('/api/version');
  if (!res.ok) throw new Error(`/api/version returned ${res.status}`);
  return (await res.json()) as BuildInfo;
}

export default function BuildVersion() {
  const { data } = useQuery({
    queryKey: ['build-version'],
    queryFn: fetchBuildInfo,
    // noise, and a stale-time of Infinity keeps this to one request per session.
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });

  if (!data) return null;

  const label = data.commit ? `v${data.version} (${data.commit})` : `v${data.version}`;

  return (
    <p
      className="mt-8 text-xs text-ink-muted"
      title={data.builtAt ? `Built ${data.builtAt}` : undefined}
    >
      {label}
    </p>
  );
}
