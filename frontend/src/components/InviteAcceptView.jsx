import { useState, useEffect, useMemo } from 'react';
import { api } from '../api';
import { summarizePerms, PRESET_LABELS, detectPreset } from '../permissions';

// Full-page signup view for an invitation. Mounted by App.jsx when the URL
// matches /invite/<token>. Fetches the invitation, lets the user pick their
// own username + password, and creates the account.
export default function InviteAcceptView({ token }) {
  const [phase, setPhase] = useState('loading'); // 'loading' | 'form' | 'success' | 'invalid'
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState(null);
  const [createdUsername, setCreatedUsername] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const inv = await api.getInvitationByToken(token);
        if (cancelled) return;
        setInvite(inv);
        setPhase('form');
      } catch (e) {
        if (cancelled) return;
        setError(e.message || 'This invitation link is not valid.');
        setPhase('invalid');
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  function handleCreated(username) {
    setCreatedUsername(username);
    setPhase('success');
  }

  return (
    <div className="invite-page">
      <div className="invite-card">
        <div className="invite-brand">Turnkey Rail</div>

        {phase === 'loading' && (
          <div className="muted">Loading invitation…</div>
        )}

        {phase === 'invalid' && (
          <InvalidState message={error} />
        )}

        {phase === 'form' && invite && (
          <InviteForm invite={invite} token={token} onCreated={handleCreated} />
        )}

        {phase === 'success' && (
          <SuccessState username={createdUsername} />
        )}
      </div>
    </div>
  );
}

function InvalidState({ message }) {
  return (
    <>
      <h1>This invitation can't be used</h1>
      <p className="muted">{message || 'The link may have expired or already been used.'}</p>
      <p className="muted invite-help-text">
        Ask the person who invited you to send a new link.
      </p>
    </>
  );
}

function InviteForm({ invite, token, onCreated }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const accessLabel = useMemo(() => {
    const preset = detectPreset(invite.permissions);
    if (preset === 'custom') return summarizePerms(invite.permissions);
    return PRESET_LABELS[preset];
  }, [invite.permissions]);

  function validate() {
    if (!username.trim()) return 'Pick a username.';
    if (/[\s:,]/.test(username)) return 'Username cannot contain spaces, ":" or ",".';
    if (password.length < 8) return 'Password must be at least 8 characters.';
    if (password !== confirm) return "Passwords don't match.";
    return null;
  }

  async function submit(e) {
    e?.preventDefault();
    const v = validate();
    if (v) { setErr(v); return; }
    setErr(null);
    setBusy(true);
    try {
      await api.acceptInvitation(token, { username: username.trim(), password });
      onCreated(username.trim());
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  }

  return (
    <>
      <h1>You're invited</h1>
      <p className="muted">
        <strong>{invite.email}</strong> has been invited to Turnkey Rail.
      </p>
      <div className="invite-meta">
        <span className="invite-meta-label">Access level</span>
        <span className="invite-meta-value">{accessLabel}</span>
      </div>
      <p className="muted invite-help-text">
        Pick a username and password to finish setting up the account.
      </p>

      <form onSubmit={submit}>
        <label htmlFor="iu-username">Username</label>
        <input
          id="iu-username"
          autoFocus
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="e.g. alice"
          disabled={busy}
        />

        <label htmlFor="iu-password">Password</label>
        <input
          id="iu-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="at least 8 characters"
          disabled={busy}
        />

        <label htmlFor="iu-confirm">Confirm password</label>
        <input
          id="iu-confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="re-enter password"
          disabled={busy}
        />

        {err && <div className="admin-error">{err}</div>}

        <button
          type="submit"
          className="btn-primary invite-submit-btn"
          disabled={busy}
        >
          {busy ? 'Creating account…' : 'Create my account'}
        </button>
      </form>
    </>
  );
}

function SuccessState({ username }) {
  return (
    <>
      <h1>You're all set</h1>
      <p className="muted">
        Welcome, <strong>{username}</strong>. Your account is ready.
      </p>
      <p className="muted invite-help-text">
        Click below to sign in. You'll be prompted for the username and password
        you just chose.
      </p>
      {/*
        Reload the root so Express prompts for Basic auth fresh — there's no
        clean way to inject Basic credentials from JS, the browser dialog has
        to take them. Using window.location avoids React state staying around.
      */}
      <button
        className="btn-primary invite-submit-btn"
        onClick={() => { window.location.href = '/'; }}
      >
        Sign in to Turnkey Rail
      </button>
    </>
  );
}
