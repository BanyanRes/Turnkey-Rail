import { useState, useEffect, useMemo } from 'react';
import { api } from '../api';
import PermissionsPicker from './PermissionsPicker';
import {
  fromPreset,
  detectPreset,
  summarizePerms,
  PRESET_LABELS,
} from '../permissions';

export default function AdminView({ me }) {
  const [users, setUsers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showInvite, setShowInvite] = useState(false);
  const [editing, setEditing] = useState(null); // user being edited

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [u, i] = await Promise.all([api.listUsers(), api.listInvitations()]);
      setUsers(u);
      setInvites(i);
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
        <button className="btn-primary" onClick={() => setShowInvite(true)}>
          + Invite User
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
      ) : (
        <>
          {invites.length > 0 && (
            <section className="admin-section">
              <h3 className="admin-section-title">
                Pending invitations <span className="muted">({invites.length})</span>
              </h3>
              <table className="vendors-table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Access</th>
                    <th>Invited by</th>
                    <th>Expires</th>
                    <th className="col-action">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {invites.map((inv) => (
                    <tr key={inv.id}>
                      <td className="strong">{inv.email}</td>
                      <td>{summarizePerms(inv.permissions)}</td>
                      <td className="muted">{inv.created_by || '—'}</td>
                      <td className="muted">{fmtDate(inv.expires_at)}</td>
                      <td className="col-action">
                        <button
                          className="btn-secondary btn-sm"
                          onClick={() => copyInviteLink(inv.token)}
                          title="Copy invite URL to clipboard"
                        >
                          Copy link
                        </button>
                        <button
                          className="btn-danger btn-sm"
                          onClick={() => handleRevoke(inv)}
                        >
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section className="admin-section">
            <h3 className="admin-section-title">
              Active users <span className="muted">({users.length})</span>
            </h3>
            {users.length === 0 ? (
              <div className="empty-state">
                No DB users yet. Click <strong>+ Invite User</strong> to send an invitation.
              </div>
            ) : (
              <table className="vendors-table">
                <thead>
                  <tr>
                    <th>Username</th>
                    <th>Email</th>
                    <th>Access</th>
                    <th>Created</th>
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
                        <td className="muted">{u.email || '—'}</td>
                        <td>
                          <AccessBadge perms={u.permissions} />
                        </td>
                        <td className="muted">{fmtDate(u.created_at)}</td>
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
          </section>
        </>
      )}

      {showInvite && (
        <InviteUserModal
          onClose={() => setShowInvite(false)}
          onCreated={() => { load(); /* keep modal open to show the link */ }}
          onDone={() => { setShowInvite(false); load(); }}
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

  async function handleRevoke(inv) {
    if (!confirm(`Revoke invitation for ${inv.email}? The existing link will stop working.`)) return;
    try {
      await api.deleteInvitation(inv.id);
      load();
    } catch (e) {
      alert(`Failed to revoke: ${e.message}`);
    }
  }
}

function AccessBadge({ perms }) {
  const preset = detectPreset(perms);
  const label = PRESET_LABELS[preset];
  const cls = preset === 'admin' ? 'badge-admin'
            : preset === 'editor' ? 'badge-editor'
            : preset === 'viewer' ? 'badge-viewer'
            : 'badge-custom';
  if (preset === 'custom') {
    return <span className={`badge ${cls}`} title={summarizePerms(perms)}>{summarizePerms(perms)}</span>;
  }
  return <span className={`badge ${cls}`}>{label}</span>;
}

function InviteUserModal({ onClose, onCreated, onDone }) {
  const [email, setEmail] = useState('');
  const [perms, setPerms] = useState(() => fromPreset('editor'));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [created, setCreated] = useState(null); // { token, email, permissions, ... }

  const inviteUrl = useMemo(() => {
    if (!created) return '';
    return `${window.location.origin}/invite/${created.token}`;
  }, [created]);

  async function submit() {
    setErr(null);
    if (!email.trim()) {
      setErr('Email is required.');
      return;
    }
    setBusy(true);
    try {
      const inv = await api.createInvitation({ email: email.trim(), permissions: perms });
      setCreated(inv);
      onCreated();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function copyToClipboard() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
    } catch {
      // older browsers — fall back to selecting the input
      const el = document.getElementById('invite-link-input');
      if (el) { el.select(); document.execCommand('copy'); }
    }
  }

  return (
    <div className="modal-backdrop" onClick={created ? onDone : onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        {!created ? (
          <>
            <h2>Invite User</h2>
            <p className="muted">
              We'll generate a one-time signup link. Send it to the invitee — when they
              open it they'll pick their own username and password.
            </p>

            <label>Email address</label>
            <input
              autoFocus
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="alice@company.com"
              disabled={busy}
            />

            <label className="perms-picker-label">Access level</label>
            <PermissionsPicker value={perms} onChange={setPerms} disabled={busy} />

            {err && <div className="admin-error">{err}</div>}
            <div className="modal-actions">
              <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="btn-primary" onClick={submit} disabled={busy}>
                {busy ? 'Generating link…' : 'Generate invite link'}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>Invite link ready</h2>
            <p className="muted">
              Send this link to <strong>{created.email}</strong>. It expires{' '}
              {fmtDate(created.expires_at)} and can only be used once.
            </p>
            <label>Signup link</label>
            <div className="invite-link-row">
              <input
                id="invite-link-input"
                type="text"
                readOnly
                value={inviteUrl}
                onFocus={(e) => e.target.select()}
              />
              <button className="btn-primary" onClick={copyToClipboard}>
                Copy
              </button>
            </div>
            <div className="muted invite-link-note">
              Paste this into your email or messaging app. The link grants the access level
              you chose: <strong>{summarizePerms(created.permissions)}</strong>.
            </div>
            <div className="modal-actions">
              <button className="btn-primary" onClick={onDone}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function EditUserModal({ user, isSelf, onClose, onSaved }) {
  const [password, setPassword] = useState('');
  const [perms, setPerms] = useState(() => user.permissions || fromPreset('viewer'));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const permsChanged = useMemo(
    () => JSON.stringify(perms) !== JSON.stringify(user.permissions),
    [perms, user.permissions]
  );

  async function submit() {
    setErr(null);
    const patch = {};
    if (password) patch.password = password;
    if (permsChanged) patch.permissions = perms;
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
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2>Edit <code>{user.username}</code></h2>
        {user.email && <p className="muted">{user.email}</p>}

        <label>Reset password <span className="muted">(leave blank to keep current)</span></label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="at least 8 characters"
          disabled={busy}
        />

        <label className="perms-picker-label">Access level</label>
        {isSelf && (
          <div className="admin-note admin-note-sm">
            You can't remove your own admin access. Other access levels can still be changed.
          </div>
        )}
        <PermissionsPicker value={perms} onChange={setPerms} disabled={busy} />

        {err && <div className="admin-error">{err}</div>}
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

async function copyInviteLink(token) {
  const url = `${window.location.origin}/invite/${token}`;
  try {
    await navigator.clipboard.writeText(url);
    // Brief feedback. A toast system would be nicer; alert is fine for now.
    // Using a tiny inline approach: window's title flash would be intrusive,
    // so just a quick confirm.
    // Could swap for a toast later.
  } catch {
    // fallback
    window.prompt('Copy this invite link:', url);
    return;
  }
  // Lightweight inline feedback: briefly change the button text by re-rendering
  // is overkill for now — let the user trust the copy. If they want feedback,
  // we can wire a toast later.
}

function fmtDate(s) {
  if (!s) return '';
  // Server returns "YYYY-MM-DD HH:MM:SS" UTC
  const d = new Date(s.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
