import { useState, useEffect, useMemo } from 'react';
import { api } from '../api';

export default function AdminView({ me }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState(null); // user being edited

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const rows = await api.listUsers();
      setUsers(rows);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const meIsEnv = me?.source === 'env';
  const meUsername = me?.username;

  return (
    <div className="admin-view">
      <div className="admin-header">
        <div>
          <h2>Admin · Users</h2>
          <p className="muted">
            Signed in as <strong>{meUsername || 'unknown'}</strong>
            {' '}
            <span className="badge badge-source">{me?.source || '?'}</span>
            {' '}— manage who can sign in to Turnkey Rail.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowAdd(true)}>
          + Add User
        </button>
      </div>

      {meIsEnv && (
        <div className="admin-note">
          You're signed in as a <strong>root (env-var) user</strong>. Root users are managed
          in Railway → Variables → <code>BASIC_AUTH_USERS</code> and never appear in this
          table. The list below is only DB-managed users.
        </div>
      )}

      {error && <div className="admin-error">{error}</div>}

      {loading ? (
        <div className="muted">Loading…</div>
      ) : users.length === 0 ? (
        <div className="empty-state">
          No DB users yet. Click <strong>+ Add User</strong> to create one.
        </div>
      ) : (
        <table className="vendors-table">
          <thead>
            <tr>
              <th>Username</th>
              <th>Role</th>
              <th>Created</th>
              <th>Updated</th>
              <th className="col-action">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const isSelf = !meIsEnv && u.username === meUsername;
              return (
                <tr key={u.id}>
                  <td className="strong">
                    {u.username}
                    {isSelf && <span className="badge badge-self">you</span>}
                  </td>
                  <td>
                    {u.is_admin
                      ? <span className="badge badge-admin">admin</span>
                      : <span className="badge badge-user">user</span>}
                  </td>
                  <td className="muted">{fmtDate(u.created_at)}</td>
                  <td className="muted">{fmtDate(u.updated_at)}</td>
                  <td className="col-action">
                    <button className="btn-secondary btn-sm" onClick={() => setEditing(u)}>
                      Edit
                    </button>
                    <button
                      className="btn-danger btn-sm"
                      onClick={() => handleDelete(u)}
                      disabled={isSelf}
                      title={isSelf ? "Can't delete yourself" : 'Delete user'}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {showAdd && (
        <AddUserModal
          onClose={() => setShowAdd(false)}
          onCreated={() => { setShowAdd(false); load(); }}
        />
      )}
      {editing && (
        <EditUserModal
          user={editing}
          isSelf={!meIsEnv && editing.username === meUsername}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );

  async function handleDelete(u) {
    if (!confirm(`Delete user "${u.username}"? This cannot be undone.`)) return;
    try {
      await api.deleteUser(u.id);
      load();
    } catch (e) {
      alert(`Failed to delete: ${e.message}`);
    }
  }
}

function AddUserModal({ onClose, onCreated }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function submit() {
    setErr(null);
    if (!username || !password) {
      setErr('Username and password are required.');
      return;
    }
    setBusy(true);
    try {
      await api.createUser({ username, password, is_admin: isAdmin });
      onCreated();
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add User</h2>
        <label>Username</label>
        <input
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="e.g. alice"
        />
        <label>Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="at least 8 characters"
        />
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={isAdmin}
            onChange={(e) => setIsAdmin(e.target.checked)}
          />
          {' '}Grant admin privileges (can manage users)
        </label>
        {err && <div className="admin-error">{err}</div>}
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={busy}>
            {busy ? 'Creating…' : 'Create User'}
          </button>
        </div>
      </div>
    </div>
  );
}

function EditUserModal({ user, isSelf, onClose, onSaved }) {
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(!!user.is_admin);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function submit() {
    setErr(null);
    const patch = {};
    if (password) patch.password = password;
    if (isAdmin !== !!user.is_admin) patch.is_admin = isAdmin;
    if (Object.keys(patch).length === 0) {
      setErr('No changes to save.');
      return;
    }
    setBusy(true);
    try {
      await api.updateUser(user.id, patch);
      onSaved();
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Edit <code>{user.username}</code></h2>
        <label>Reset password (leave blank to keep current)</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="at least 8 characters"
        />
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={isAdmin}
            onChange={(e) => setIsAdmin(e.target.checked)}
            disabled={isSelf}
          />
          {' '}Admin privileges {isSelf && <em className="muted">(can't change for yourself)</em>}
        </label>
        {err && <div className="admin-error">{err}</div>}
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function fmtDate(s) {
  if (!s) return '';
  // Server returns "YYYY-MM-DD HH:MM:SS" UTC
  const d = new Date(s.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
