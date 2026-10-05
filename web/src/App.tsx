import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { UniverseLayout } from './components/UniverseLayout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { HomeRoute } from './components/HomeRoute';
import { Login } from './views/Login';
import { Register } from './views/Register';
import { RequestInvite } from './views/RequestInvite';
import { UniverseList } from './views/UniverseList';
import { UniverseSettings } from './views/UniverseSettings';
import { EntryList } from './views/EntryList';
import { EntryDetail } from './views/EntryDetail';
import { EntryEditor } from './views/EntryEditor';
import { GraphView } from './views/GraphView';
import { StatsView } from './views/StatsView';
import { IngestImport } from './views/IngestImport';
import { IssuesView } from './views/IssuesView';
import { TimelineView } from './views/TimelineView';
import { CalendarEditor } from './views/CalendarEditor';
import { EventsView } from './views/EventsView';
import { DiagramList } from './views/DiagramList';
import { AssetLibrary } from './views/AssetLibrary';
import { DiagramEditor } from './views/DiagramEditor';
import { MapList } from './views/MapList';
import { MapEditor } from './views/MapEditor';
import { Dictionary } from './views/Dictionary';
import Settings from './views/Settings';
import { SettingsLayout } from './components/SettingsLayout';
import Tokens from './views/Tokens';
import Invites from './views/Invites';
import LlmKeys from './views/LlmKeys';
import Templates from './views/Templates';
import Shares from './views/Shares';
import SyncSettings from './views/SyncSettings';
import AdminUsers from './views/AdminUsers';
import { useAuthStore } from './store/auth';
import { ShareLayout } from './components/ShareLayout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ShareFallback } from './views/ShareFallback';
import { useRuntime } from './runtime/RuntimeProvider';

export default function App() {
  const { authMode } = useRuntime();
  const isAdmin = useAuthStore((state) => state.user?.isAdmin === true);

  return (
    <Routes>
      <Route path="/" element={<HomeRoute />} />
      <Route path="/login" element={authMode === 'local' ? <Navigate to="/universes" replace /> : <Login />} />
      <Route path="/register" element={authMode === 'local' ? <Navigate to="/universes" replace /> : <Register />} />
      <Route path="/request-invite" element={authMode === 'local' ? <Navigate to="/universes" replace /> : <RequestInvite />} />
      <Route element={<ProtectedRoute />}>
        {/* Header-only shell for the universe picker, per-universe settings, and app settings. */}
        <Route element={<Layout />}>
          <Route path="/universes" element={<UniverseList />} />
          <Route path="/universes/:id/settings" element={<UniverseSettings />} />
          {/* /settings placed after /universes/:id/settings so the more-specific route still matches first */}
          <Route path="/settings" element={<SettingsLayout />}>
            <Route index element={<Settings />} />
            <Route path="tokens" element={authMode === 'local' ? <Navigate to="/settings" replace /> : <Tokens />} />
            <Route path="invites" element={authMode === 'local' || !isAdmin ? <Navigate to="/settings" replace /> : <Invites />} />
            <Route path="users" element={authMode === 'local' || !isAdmin ? <Navigate to="/settings" replace /> : <AdminUsers />} />
            <Route path="templates" element={<Templates />} />

            <Route path="shares" element={<Shares />} />
            <Route path="llm" element={<LlmKeys />} />

            <Route path="sync" element={<SyncSettings />} />
          </Route>
        </Route>
        {/* Sidebar shell for everything scoped inside a single universe. */}
        <Route element={<UniverseLayout />}>
          <Route path="/universes/:uid/entries" element={<EntryList />} />
          <Route path="/universes/:uid/entries/new" element={<EntryEditor />} />
          <Route path="/universes/:uid/entries/:entryId" element={<EntryDetail />} />
          <Route path="/universes/:uid/entries/:entryId/edit" element={<EntryEditor />} />
          <Route path="/universes/:uid/graph" element={<GraphView />} />
          <Route path="/universes/:uid/timeline" element={<TimelineView />} />
          <Route path="/universes/:uid/stats" element={<StatsView />} />
          <Route path="/universes/:uid/calendar" element={<CalendarEditor />} />
          <Route path="/universes/:uid/events" element={<EventsView />} />
          <Route path="/universes/:uid/diagrams" element={<DiagramList />} />
          <Route path="/universes/:uid/diagrams/:did" element={<DiagramEditor />} />
          <Route path="/universes/:uid/maps" element={<MapList />} />
          <Route path="/universes/:uid/maps/:mid" element={<MapEditor />} />
          <Route path="/universes/:uid/assets" element={<AssetLibrary />} />
          <Route path="/universes/:uid/dictionary" element={<Dictionary />} />
          <Route path="/universes/:uid/languages/:lid/dictionary" element={<Dictionary />} />
          <Route path="/universes/:uid/issues" element={<IssuesView />} />
          <Route path="/universes/:uid/import" element={<IngestImport />} />
        </Route>
      </Route>

      <Route path="/share/:token" element={<ErrorBoundary fallback={<ShareFallback />}><ShareLayout /></ErrorBoundary>}>
        <Route index element={<EntryList />} />
        <Route path="entries/:entryId" element={<EntryDetail />} />
        <Route path="graph" element={<GraphView />} />
        <Route path="timeline" element={<TimelineView />} />

        <Route path="maps" element={<MapList />} />
        <Route path="maps/:mid" element={<MapEditor />} />
      </Route>
      <Route path="*" element={<Navigate to="/universes" replace />} />
    </Routes>
  );
}
