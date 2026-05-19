import { useState } from 'react';
import ProjectsView from './components/ProjectsView';
import VendorsView from './components/VendorsView';
import PayAppsView from './components/PayAppsView';
import ChangeOrdersView from './components/ChangeOrdersView';
import DocumentsView from './components/DocumentsView';
import ScheduleView from './components/ScheduleView';
import './App.css';

const TABS = [
  { id: 'projects', label: 'Projects' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'vendors', label: 'Vendors' },
  { id: 'payapps', label: 'Pay Apps' },
  { id: 'cos', label: 'Change Orders' },
  { id: 'docs', label: 'Documents' },
];

export default function App() {
  const [tab, setTab] = useState('projects');

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand-and-nav">
          <h1>Turnkey Rail</h1>
          <nav className="top-nav">
            {TABS.map((t) => (
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
      </header>

      <div className="app-body">
        {tab === 'projects' && <ProjectsView />}
        {tab === 'schedule' && <ScheduleView />}
        {tab === 'vendors' && <VendorsView />}
        {tab === 'payapps' && <PayAppsView />}
        {tab === 'cos' && <ChangeOrdersView />}
        {tab === 'docs' && <DocumentsView />}
      </div>
    </div>
  );
}
