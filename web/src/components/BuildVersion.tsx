/**
 * Build identity line for the settings screen: `v0.2.0 (a1b2c3d)`.
 *
 * Exists so a bug report can name the exact build. Before this, every desktop
 * artifact ever produced was called `0.1.0` and the running app displayed no
 * version at all, so "which build are you on?" had no answer a user could give.
 *
 * Reads /api/version with a bare `fetch` rather than the `api()` helper in
 * src/api/client.ts. That helper attaches the bearer and drives the refresh
 * dance; this endpoint is deliberately unauthenticated (see the module comment
 * in api/src/routes/version.ts), and sending a token to it would both be
 * pointless and make the component fail while logged out.
 */
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
    // The build cannot change under a running client: a new build means a new
    // page load (hosted) or a restarted app (desktop). Refetching would be pure
    // noise, and a stale-time of Infinity keeps this to one request per session.
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    // One attempt. This is decoration on a settings page — retrying a dead
    // endpoint three times to render a version string helps nobody.
    retry: false,
  });

  // Render nothing at all while loading or after a failure. An error state here
  // would be louder than the information is worth, and the settings controls
  // around it must not be disturbed by a version line that could not load.
  if (!data) return null;

  // `(null)` or an empty `()` in a pasted bug report looks like a real value,
  // so the parentheses appear only when there is genuinely a sha to put in them.
  const label = data.commit ? `v${data.version} (${data.commit})` : `v${data.version}`;

  return (
    <p
      className="mt-8 text-xs text-neutral-500"
      // Lets a support conversation say "hover the version" for the exact build
      // time without spending a line of the settings page on it.
      title={data.builtAt ? `Built ${data.builtAt}` : undefined}
    >
      {label}
    </p>
  );
}
