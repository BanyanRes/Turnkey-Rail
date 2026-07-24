import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import ProjectList from './ProjectList';
import ProjectDetail from './ProjectDetail';
import ProjectForm from './ProjectForm';
import { canEdit } from '../permissions';

export default function ProjectsView({ me }) {
  const editable = canEdit(me, 'projects');
  const [projects, setProjects] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = await api.listProjects();
      setProjects(data);
      setSelectedId((prev) => {
        if (prev && data.some((p) => p.id === prev)) return prev;
        return data[0]?.id ?? null;
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const selectedProject = projects.find((p) => p.id === selectedId) || null;

  async function handleDelete() {
    if (!selectedProject) return;
    if (!confirm(`Delete project ${selectedProject.code}? This removes all budget lines too.`)) return;
    try {
      await api.deleteProject(selectedProject.id);
      setSelectedId(null);
      await refresh();
    } catch (e) {
      alert(e.message);
    }
  }

  return (
    <>
      {editable && (
        <div className="view-toolbar">
          <button className="btn-primary" onClick={() => setCreating(true)}>+ New Project</button>
        </div>
      )}

      <div className="split-body">
        <aside className="sidebar">
          <ProjectList
            projects={projects}
            selectedId={selectedId}
            onSelect={setSelectedId}
            loading={loading}
            error={error}
          />
        </aside>

        <main className="main">
          {selectedProject ? (
            <ProjectDetail
              project={selectedProject}
              onChange={refresh}
              onDelete={handleDelete}
              onEdit={() => setEditing(true)}
              editable={editable}
            />
          ) : (
            <div className="empty">
              {loading ? 'Loading…' : editable ? 'Select a project, or create a new one.' : 'Select a project to view.'}
            </div>
          )}
        </main>
      </div>

      {creating && (
        <ProjectForm
          onSubmit={async (data) => {
            const created = await api.createProject(data);
            await refresh();
            setSelectedId(created.id);
            setCreating(false);
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      {editing && selectedProject && (
        <ProjectForm
          project={selectedProject}
          onSubmit={async (data) => {
            await api.updateProject(selectedProject.id, data);
            await refresh();
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      )}
    </>
  );
}
