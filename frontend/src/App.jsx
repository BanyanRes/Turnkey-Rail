import { useState, useEffect } from 'react';
import { api } from './api';
import ProjectsView from './components/ProjectsView';
import VendorsView from './components/VendorsView';
import PayAppsView from './components/PayAppsView';
import ChangeOrdersView from './components/ChangeOrdersView';
import DocumentsView from './components/DocumentsView';
import ScheduleView from './components/ScheduleView';
import LiensView from './components/LiensView';
import AdminView from './components/AdminView';
import InviteAcceptView from './components/InviteAcceptView';
import { canView } from './permissions';
import './App.css';

const BASE_TABS = [
  { id: 'projects', label: 'Projects', perm: 'projects' },
  { id: 'schedule', label: 'Schedule', perm: 'schedule' },
  { id: 'vendors', label: 'Vendors', perm: 'vendors' },
  { id: 'payapps', label: 'Pay Apps', perm: 'payapps' },
  { id: 'cos', label: 'Change Orders', perm: 'changeorders' },
  { id: 'docs', label: 'Documents', perm: 'documents' },
  { id: 'liens', label: 'Liens', perm: 'liens' },
];

// Returns the token from /invite/<token>, or null if we're not on an invite URL.
// Done at module-init time so this is settled before any auth call fires.
function getInviteTokenFromUrl() {
  const m = window.location.pathname.match(/^\/invite\/([A-Za-z0-9]+)\/?$/);
  return m ? m[1] : null;
}

// Top-level router. If the URL is /invite/<token>, show the standalone signup
// view (no /api/me call — the invitee has no creds yet). Otherwise the main app.
// Kept as a separate component so MainApp's hooks always run in the same order.
export default function App() {
  const inviteToken = getInviteTokenFromUrl();
  if (inviteToken) {
    return <InviteAcceptView token={inviteToken} />;
  }
  return <MainApp />;
}

function MainApp() {
  const [tab, setTab] = useState('projects');
  const [me, setMe] = useState(null);

  useEffect(() => {
    api.getMe().then(setMe).catch(() => setMe(null));
  }, []);

  // Filter tabs to ones the user can actually view (env-admin sees all).
  // Defaults to all tabs while `me` is still loading to avoid an empty nav flash.
  const visibleBaseTabs = me
    ? BASE_TABS.filter((t) => canView(me, t.perm))
    : BASE_TABS;

  const tabs = me?.is_admin
    ? [...visibleBaseTabs, { id: 'admin', label: 'Admin' }]
    : visibleBaseTabs;

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand-and-nav">
          <h1>Turnkey Rail</h1>
          <nav className="top-nav">
            {tabs.map((t) => (
              <button
                key={t.id}
                className={`nav-btn ${tab === t.id ? 'active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
        {me && (
          <div className="signed-in-as muted">
            {me.username}
            {me.is_admin && <span className="badge badge-admin">admin</span>}
          </div>
        )}
      </header>

      <div className="app-body">
        {tab === 'projects' && <ProjectsView me={me} />}
        {tab === 'schedule' && <ScheduleView me={me} />}
        {tab === 'vendors' && <VendorsView me={me} />}
        {tab === 'payapps' && <PayAppsView me={me} />}
        {tab === 'cos' && <ChangeOrdersView me={me} />}
        {tab === 'docs' && <DocumentsView me={me} />}
        {tab === 'liens' && <LiensView me={me} />}
        {tab === 'admin' && me?.is_admin && <AdminView me={me} />}
      </div>
    </div>
  );
}
