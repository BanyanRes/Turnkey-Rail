import { useState, useEffect } from 'react';
import { api, setOn401Handler } from './api';
import ProjectsView from './components/ProjectsView';
import BudgetModsView from './components/BudgetModsView';
import VendorsView from './components/VendorsView';
import PayAppsView from './components/PayAppsView';
import ChangeOrdersView from './components/ChangeOrdersView';
import DocumentsView from './components/DocumentsView';
import ScheduleView from './components/ScheduleView';
import LiensView from './components/LiensView';
import AdminView from './components/AdminView';
import InviteAcceptView from './components/InviteAcceptView';
import LoginView from './components/LoginView';
import { canView } from './permissions';
import './App.css';

const BASE_TABS = [
  { id: 'projects', label: 'Projects', perm: 'projects' },
  { id: 'budgetmods', label: 'Budget Mods', perm: 'projects' },
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
  // phase: 'loading' (initial /api/me probe) | 'login' (show LoginView) | 'main'
  const [phase, setPhase] = useState('loading');

  // Initial auth probe. On 401, fall through to login. On success, go straight
  // to the main app. (`me` may already be the dev-mode anonymous user if the
  // server has no users configured; that still counts as authenticated.)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const user = await api.getMe();
        if (cancelled) return;
        setMe(user);
        setPhase('main');
      } catch (e) {
        if (cancelled) return;
        // 401 → not signed in; anything else → still show login so user can retry
        setMe(null);
        setPhase('login');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // If a later API call returns 401, the session expired mid-use — bounce
  // back to the login screen. api.js calls this through setOn401Handler.
  useEffect(() => {
    setOn401Handler(() => {
      setMe(null);
      setPhase('login');
    });
    return () => setOn401Handler(null);
  }, []);

  async function handleLogout() {
    try {
      await api.logout();
    } catch {
      // Even if the network call fails, clear local state and show login.
    }
    setMe(null);
    setPhase('login');
  }

  function handleLoggedIn(user) {
    setMe(user);
    setPhase('main');
  }

  if (phase === 'loading') {
    return <div className="app-loading">Loading…</div>;
  }

  if (phase === 'login') {
    return <LoginView onLoggedIn={handleLoggedIn} />;
  }

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
            <span>{me.username}</span>
            {me.is_admin && <span className="badge badge-admin">admin</span>}
            {me.source !== 'none' && (
              <button
                type="button"
                className="logout-btn"
                onClick={handleLogout}
                title="Sign out"
              >
                Sign out
              </button>
            )}
          </div>
        )}
      </header>

      <div className="app-body">
        {tab === 'projects' && <ProjectsView me={me} />}
        {tab === 'budgetmods' && <BudgetModsView me={me} />}
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
