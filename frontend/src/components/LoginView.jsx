import { useState, useRef, useEffect } from 'react';
import { api } from '../api';

/**
 * Full-page login view. Mounted by App.jsx when the user is not authenticated.
 *
 * The HTML form is intentionally standard (real <form>, type="password", name
 * attributes, autocomplete hints) so Chrome / Safari / 1Password / etc. all
 * recognize it and offer to save the credentials.
 */
export default function LoginView({ onLoggedIn }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [showForgot, setShowForgot] = useState(false);

  const usernameRef = useRef(null);
  useEffect(() => {
    // Autofocus username on mount (unless the browser already filled it in)
    if (usernameRef.current && !usernameRef.current.value) {
      usernameRef.current.focus();
    }
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;
    setErr(null);
    setBusy(true);
    try {
      const { user } = await api.login({
        username: username.trim(),
        password,
        rememberMe,
      });
      // Hand control back to App.jsx so it can swap the UI to the main app.
      if (typeof onLoggedIn === 'function') {
        onLoggedIn(user);
      }
    } catch (e2) {
      setErr(e2.message || 'Login failed');
      setBusy(false);
    }
  }

  return (
    <div className="invite-page">
      <div className="invite-card">
        <div className="invite-brand">Turnkey Rail</div>
        <h1>Sign in</h1>
        <p className="muted">Enter your credentials to continue.</p>

        <form onSubmit={handleSubmit} autoComplete="on">
          <label htmlFor="login-username">Username</label>
          <input
            id="login-username"
            ref={usernameRef}
            type="text"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            disabled={busy}
          />

          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={busy}
          />

          <label className="login-remember">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
              disabled={busy}
            />
            <span>Remember me for 30 days</span>
          </label>

          {err && <div className="login-error">{err}</div>}

          <button type="submit" className="login-submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <div className="login-forgot-row">
            <button
              type="button"
              className="login-forgot-link"
              onClick={() => setShowForgot(true)}
            >
              Forgot password?
            </button>
          </div>
        </form>

        {showForgot && (
          <ForgotPasswordDialog onClose={() => setShowForgot(false)} />
        )}
      </div>
    </div>
  );
}

/**
 * Password reset is admin-mediated — there's no email infrastructure on the
 * server, so users contact an admin who resets the password via /api/users.
 * (See AdminView -> Users section.)
 */
function ForgotPasswordDialog({ onClose }) {
  const adminEmail = 'jyun@banyanres.com';
  const subject = encodeURIComponent('Turnkey Rail — password reset request');
  const body = encodeURIComponent(
    'Hi,\n\nI need my Turnkey Rail password reset.\n\n' +
    'Username: \n\nThanks.'
  );
  const mailto = `mailto:${adminEmail}?subject=${subject}&body=${body}`;

  return (
    <div className="forgot-overlay" role="dialog" aria-modal="true">
      <div className="forgot-card">
        <h2>Forgot your password?</h2>
        <p>
          Password resets are handled by your administrator. Email{' '}
          <a href={`mailto:${adminEmail}`}>{adminEmail}</a> with your username
          and they'll send you a new one.
        </p>
        <div className="forgot-actions">
          <a href={mailto} className="login-submit forgot-email-btn">
            Email administrator
          </a>
          <button type="button" className="forgot-close-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
