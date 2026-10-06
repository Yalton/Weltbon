import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Loading } from './components/ui/Loading';
import { ProtectedRoute } from './components/ProtectedRoute';
import { HomeRoute } from './components/HomeRoute';
import { Login } from './views/Login';
import { Register } from './views/Register';
import { RequestInvite } from './views/RequestInvite';
import { useAuthStore } from './store/auth';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ShareFallback } from './views/ShareFallback';
import { useRuntime } from './runtime/RuntimeProvider';

// The public pages (landing, sign-in, registration, invitation request) load
// with the entry chunk; everything behind sign-in or a share link is fetched
// when first visited, so a visitor to / does not download the whole app.
const Layout = lazy(() => import('./components/Layout').then((m) => ({ default: m.Layout })));
const UniverseLayout = lazy(() => import('./components/UniverseLayout').then((m) => ({ default: m.UniverseLayout })));
const UniverseList = lazy(() => import('./views/UniverseList').then((m) => ({ default: m.UniverseList })));
const UniverseSettings = lazy(() => import('./views/UniverseSettings').then((m) => ({ default: m.UniverseSettings })));
const EntryList = lazy(() => import('./views/EntryList').then((m) => ({ default: m.EntryList })));
const EntryDetail = lazy(() => import('./views/EntryDetail').then((m) => ({ default: m.EntryDetail })));
const EntryEditor = lazy(() => import('./views/EntryEditor').then((m) => ({ default: m.EntryEditor })));
const GraphView = lazy(() => import('./views/GraphView').then((m) => ({ default: m.GraphView })));
const StatsView = lazy(() => import('./views/StatsView').then((m) => ({ default: m.StatsView })));
const IngestImport = lazy(() => import('./views/IngestImport').then((m) => ({ default: m.IngestImport })));
const IssuesView = lazy(() => import('./views/IssuesView').then((m) => ({ default: m.IssuesView })));
const TimelineView = lazy(() => import('./views/TimelineView').then((m) => ({ default: m.TimelineView })));
const CalendarEditor = lazy(() => import('./views/CalendarEditor').then((m) => ({ default: m.CalendarEditor })));
const EventsView = lazy(() => import('./views/EventsView').then((m) => ({ default: m.EventsView })));
const DiagramList = lazy(() => import('./views/DiagramList').then((m) => ({ default: m.DiagramList })));
const AssetLibrary = lazy(() => import('./views/AssetLibrary').then((m) => ({ default: m.AssetLibrary })));
const DiagramEditor = lazy(() => import('./views/DiagramEditor').then((m) => ({ default: m.DiagramEditor })));
const MapList = lazy(() => import('./views/MapList').then((m) => ({ default: m.MapList })));
const MapEditor = lazy(() => import('./views/MapEditor').then((m) => ({ default: m.MapEditor })));
const Dictionary = lazy(() => import('./views/Dictionary').then((m) => ({ default: m.Dictionary })));
const Settings = lazy(() => import('./views/Settings'));
const SettingsLayout = lazy(() => import('./components/SettingsLayout').then((m) => ({ default: m.SettingsLayout })));
const Tokens = lazy(() => import('./views/Tokens'));
const Invites = lazy(() => import('./views/Invites'));
const LlmKeys = lazy(() => import('./views/LlmKeys'));
const Templates = lazy(() => import('./views/Templates'));
const Shares = lazy(() => import('./views/Shares'));
const SyncSettings = lazy(() => import('./views/SyncSettings'));
const AdminUsers = lazy(() => import('./views/AdminUsers'));
const ShareLayout = lazy(() => import('./components/ShareLayout').then((m) => ({ default: m.ShareLayout })));

export default function App() {
  const { authMode } = useRuntime();
  const isAdmin = useAuthStore((state) => state.user?.isAdmin === true);

  return (
    <Suspense fallback={<Loading fullPage />}>
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
    </Suspense>
  );
}
