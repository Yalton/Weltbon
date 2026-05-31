import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { UniverseLayout } from './components/UniverseLayout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Login } from './views/Login';
import { Register } from './views/Register';
import { UniverseList } from './views/UniverseList';
import { UniverseSettings } from './views/UniverseSettings';
import { EntryList } from './views/EntryList';
import { EntryDetail } from './views/EntryDetail';
import { EntryEditor } from './views/EntryEditor';
import { GraphView } from './views/GraphView';
import { IngestImport } from './views/IngestImport';
import { IssuesView } from './views/IssuesView';
import { TimelineView } from './views/TimelineView';
import { CalendarEditor } from './views/CalendarEditor';
import Settings from './views/Settings';
import { SettingsLayout } from './components/SettingsLayout';
import Tokens from './views/Tokens';
import Invites from './views/Invites';
import LlmKeys from './views/LlmKeys';
import Templates from './views/Templates';
import Shares from './views/Shares';
import { ShareLayout } from './components/ShareLayout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ShareFallback } from './views/ShareFallback';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/universes" replace />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route element={<ProtectedRoute />}>
        {/* Header-only shell for the universe picker, per-universe settings, and app settings. */}
        <Route element={<Layout />}>
          <Route path="/universes" element={<UniverseList />} />
          <Route path="/universes/:id/settings" element={<UniverseSettings />} />
          {/* /settings placed after /universes/:id/settings so the more-specific route still matches first */}
          <Route path="/settings" element={<SettingsLayout />}>
            <Route index element={<Settings />} />
            <Route path="tokens" element={<Tokens />} />
            <Route path="invites" element={<Invites />} />
            <Route path="templates" element={<Templates />} />
            {/* Phase 29 — global owner audit view for all share links. */}
            <Route path="shares" element={<Shares />} />
            <Route path="llm" element={<LlmKeys />} />
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
          <Route path="/universes/:uid/calendar" element={<CalendarEditor />} />
          <Route path="/universes/:uid/issues" element={<IssuesView />} />
          <Route path="/universes/:uid/import" element={<IngestImport />} />
        </Route>
      </Route>
      {/*
        Phase 29 — public read-only share-link visitor subtree. Mounted
        OUTSIDE <ProtectedRoute> so an unauthenticated visitor can reach
        these routes; the api-client share-mode seam (web/src/api/client.ts)
        rewrites every fetch to /api/share/* with a share-token header for
        the lifetime of ShareLayout mount. The four reused views adapt via
        useShareMode() rather than being duplicated as Shared* variants.
      */}
      <Route path="/share/:token" element={<ErrorBoundary fallback={<ShareFallback />}><ShareLayout /></ErrorBoundary>}>
        <Route index element={<EntryList />} />
        <Route path="entries/:entryId" element={<EntryDetail />} />
        <Route path="graph" element={<GraphView />} />
        <Route path="timeline" element={<TimelineView />} />
      </Route>
      <Route path="*" element={<Navigate to="/universes" replace />} />
    </Routes>
  );
}
