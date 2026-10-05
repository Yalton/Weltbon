import { Navigate, Outlet } from 'react-router-dom';
import { useSessionCheck } from '../hooks/useSessionCheck';
import { Loading } from './ui/Loading';

export function ProtectedRoute() {
  const state = useSessionCheck();

  if (state === 'checking') {
    return <Loading fullPage />;
  }
  if (state === 'anonymous') {
    return <Navigate to="/login" replace />;
  }
  return <Outlet />;
}
