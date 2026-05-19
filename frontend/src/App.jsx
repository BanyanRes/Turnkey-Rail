import { useState, useEffect } from 'react';
import { api } from './api';
import ProjectsView from './components/ProjectsView';
import VendorsView from './components/VendorsView';
import PayAppsView from './components/PayAppsView';
import ChangeOrdersView from './components/ChangeOrdersView';
import DocumentsView from './components/DocumentsView';
import ScheduleView from './components/ScheduleView';
import AdminView from './components/AdminView';
import './App.css';

const BASE_TABS = [
  { id: 'projects', label: 'Projects' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'vendors', label: 'Vendors' },
  { id: 'payapps', label: 'Pay Apps' },
  { id: 'cos', label: 'Change Orders' },
  { id: 'docs', label: 'Documents' },
];

export default function App() {
  const [tab, setTab] = useState('projects');
  const [me, setMe] = useState(null);

  useEffect(() => {
    api.getMe().then(setMe).catch(() => setMe(null));
  }, []);

  const tabs = me?.is_admin
    ? [...BASE_TABS, { id: 'admin', label: 'Admin' }]
    : BASE_TABS;

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
        {tab === 'projects' && <ProjectsView />}
        {tab === 'schedule' && <ScheduleView />}
        {tab === 'vendors' && <VendorsView />}
        {tab === 'payapps' && <PayAppsView />}
        {tab === 'cos' && <ChangeOrdersView />}
        {tab === 'docs' && <DocumentsView />}
        {tab === 'admin' && me?.is_admin && <AdminView me={me} />}
      </div>
    </div>
  );
}
