import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Login } from './views/Login';
import { Register } from './views/Register';
import { UniverseList } from './views/UniverseList';
import { UniverseSettings } from './views/UniverseSettings';
import { EntryList } from './views/EntryList';
import { EntryDetail } from './views/EntryDetail';
import { EntryEditor } from './views/EntryEditor';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/universes" replace />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<Layout />}>
          <Route path="/universes" element={<UniverseList />} />
          <Route path="/universes/:id/settings" element={<UniverseSettings />} />
          <Route path="/universes/:uid/entries" element={<EntryList />} />
          <Route path="/universes/:uid/entries/new" element={<EntryEditor />} />
          <Route path="/universes/:uid/entries/:entryId" element={<EntryDetail />} />
          <Route path="/universes/:uid/entries/:entryId/edit" element={<EntryEditor />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/universes" replace />} />
    </Routes>
  );
}
