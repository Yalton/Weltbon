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
import { IssuesView } from './views/IssuesView';
import { TimelineView } from './views/TimelineView';
import Settings from './views/Settings';

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
          <Route path="/settings" element={<Settings />} />
        </Route>
        {/* Sidebar shell for everything scoped inside a single universe. */}
        <Route element={<UniverseLayout />}>
          <Route path="/universes/:uid/entries" element={<EntryList />} />
          <Route path="/universes/:uid/entries/new" element={<EntryEditor />} />
          <Route path="/universes/:uid/entries/:entryId" element={<EntryDetail />} />
          <Route path="/universes/:uid/entries/:entryId/edit" element={<EntryEditor />} />
          <Route path="/universes/:uid/graph" element={<GraphView />} />
          <Route path="/universes/:uid/timeline" element={<TimelineView />} />
          <Route path="/universes/:uid/issues" element={<IssuesView />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/universes" replace />} />
    </Routes>
  );
}
