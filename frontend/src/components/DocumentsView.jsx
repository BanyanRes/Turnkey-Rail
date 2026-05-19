import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api';

const CATEGORIES = ['plans', 'contract', 'permit', 'photo', 'invoice', 'insurance', 'other'];

function fmtBytes(n) {
  if (n == null) return '—';
  const num = Number(n);
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  if (num < 1024 * 1024 * 1024) return `${(num / 1024 / 1024).toFixed(1)} MB`;
  return `${(num / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

export default function DocumentsView() {
  const [docs, setDocs] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listDocuments({
        q: query, project_id: projectFilter, category: categoryFilter,
      });
      setDocs(data);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [query, projectFilter, categoryFilter]);

  useEffect(() => {
    api.listProjects().then(setProjects).catch(() => {});
  }, []);

  useEffect(() => {
    const t = setTimeout(refresh, 200);
    return () => clearTimeout(t);
  }, [refresh]);

  async function handleFiles(files, { project_id, category } = {}) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of files) {
        await api.uploadDocument({
          file,
          project_id: project_id ?? projectFilter ?? null,
          category: category ?? categoryFilter ?? null,
        });
      }
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(doc) {
    if (!confirm(`Delete "${doc.filename}"?`)) return;
    try {
      await api.deleteDocument(doc.id);
      await refresh();
    } catch (e) {
      alert(e.message);
    }
  }

  async function handleCategoryChange(doc, category) {
    try {
      await api.updateDocument(doc.id, { category: category || null });
      await refresh();
    } catch (e) {
      alert(e.message);
    }
  }

  async function handleProjectChange(doc, project_id) {
    try {
      await api.updateDocument(doc.id, { project_id: project_id ? Number(project_id) : null });
      await refresh();
    } catch (e) {
      alert(e.message);
    }
  }

  return (
    <>
      <div className="view-toolbar">
        <div className="filter-bar">
          <input
            type="search"
            className="search-input"
            placeholder="Search filename or notes…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className="select-input"
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
            ))}
          </select>
          <select
            className="select-input"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
          >
            <option value="">All categories</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <UploadButton onUpload={handleFiles} uploading={uploading} />
      </div>

      <main
        className="vendors-main"
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        }}
      >
        {dragOver && (
          <div className="drop-overlay">Drop to upload</div>
        )}
        {error && <div className="error">{error}</div>}
        {loading ? (
          <div className="muted">Loading…</div>
        ) : docs.length === 0 ? (
          <div className="empty-state">
            {query || projectFilter || categoryFilter
              ? 'No documents match your filters.'
              : 'No documents yet. Drag files anywhere on this page, or click "Upload".'}
          </div>
        ) : (
          <table className="vendors-table">
            <thead>
              <tr>
                <th>Filename</th>
                <th>Project</th>
                <th>Category</th>
                <th>Size</th>
                <th>Uploaded</th>
                <th>Notes</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id}>
                  <td className="strong">
                    <a
                      href={api.documentUrl(d.id)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="doc-link"
                    >
                      {d.filename}
                    </a>
                  </td>
                  <td>
                    <select
                      className="inline-select"
                      value={d.project_id || ''}
                      onChange={(e) => handleProjectChange(d, e.target.value)}
                    >
                      <option value="">— Unassigned —</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>{p.code}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      className="inline-select"
                      value={d.category || ''}
                      onChange={(e) => handleCategoryChange(d, e.target.value)}
                    >
                      <option value="">—</option>
                      {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </td>
                  <td className="muted">{fmtBytes(d.size_bytes)}</td>
                  <td className="muted">{fmtDate(d.created_at)}</td>
                  <td className="muted">{d.notes || '—'}</td>
                  <td className="col-action" style={{ whiteSpace: 'nowrap' }}>
                    <a
                      href={api.documentUrl(d.id, { download: true })}
                      className="btn-icon"
                      title="Download"
                      style={{ display: 'inline-block', textDecoration: 'none' }}
                    >↓</a>
                    <button className="btn-icon" title="Delete" onClick={() => handleDelete(d)}>×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </>
  );
}

function UploadButton({ onUpload, uploading }) {
  const inputRef = useRef(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          onUpload(e.target.files);
          e.target.value = '';
        }}
      />
      <button
        className="btn-primary"
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
      >
        {uploading ? 'Uploading…' : '+ Upload'}
      </button>
    </>
  );
}
