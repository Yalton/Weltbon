import { Navigate } from 'react-router-dom';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useSessionCheck } from '../hooks/useSessionCheck';
import { Landing } from '../views/Landing';
import { Loading } from './ui/Loading';

/** `/`: signed-in users go to their universes; everyone else sees the landing page. */
export function HomeRoute() {
  const { authMode } = useRuntime();
  if (authMode === 'local') return <Navigate to="/universes" replace />;
  return <ServerHome />;
}

function ServerHome() {
  const state = useSessionCheck();
  if (state === 'checking') return <Loading fullPage />;
  if (state === 'ok') return <Navigate to="/universes" replace />;
  return <Landing />;
}
