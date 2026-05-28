// Session-based authentication for Turnkey Rail.
//
// Strategy: stateless HMAC-signed session cookies. No DB session table needed.
//
// Cookie format: base64url(payload).base64url(hmacSig)
//   payload = JSON { u: username, src: 'env'|'db', iat: epochSec, exp: epochSec }
//   sig     = HMAC-SHA256(payload, SESSION_SECRET)
//
// Server restart does NOT invalidate sessions (because state lives in the cookie
// itself), as long as SESSION_SECRET stays the same. Rotating the secret
// invalidates all sessions.

const crypto = require('crypto');

const COOKIE_NAME = 'tkr_session';
const REMEMBER_ME_TTL_DAYS = 30;
const SESSION_TTL_DAYS = 1; // when Remember Me is NOT checked

function getSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    // Helpful loud failure rather than silently insecure.
    throw new Error(
      '[sessionAuth] SESSION_SECRET env var is required and must be at least 16 chars. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return s;
}

function b64urlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(str) {
  // Restore padding
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function sign(payloadStr) {
  return crypto.createHmac('sha256', getSecret()).update(payloadStr).digest();
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Create a signed session token.
 * @param {object} sessionData - { u: username, src: 'env'|'db' }
 * @param {boolean} rememberMe - if true, 30-day expiry; else 1-day
 * @returns {{ token: string, maxAgeSec: number }}
 */
function createToken(sessionData, rememberMe = false) {
  const nowSec = Math.floor(Date.now() / 1000);
  const ttlDays = rememberMe ? REMEMBER_ME_TTL_DAYS : SESSION_TTL_DAYS;
  const expSec = nowSec + ttlDays * 24 * 60 * 60;
  const payload = { ...sessionData, iat: nowSec, exp: expSec };
  const payloadStr = JSON.stringify(payload);
  const payloadB64 = b64urlEncode(payloadStr);
  const sig = sign(payloadB64);
  const sigB64 = b64urlEncode(sig);
  return {
    token: `${payloadB64}.${sigB64}`,
    maxAgeSec: ttlDays * 24 * 60 * 60,
  };
}

/**
 * Verify and decode a session token.
 * @param {string} token
 * @returns {object|null} payload (with iat/exp) or null if invalid/expired
 */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;

  let expectedSig;
  try {
    expectedSig = sign(payloadB64);
  } catch {
    return null;
  }

  let providedSig;
  try {
    providedSig = b64urlDecode(sigB64);
  } catch {
    return null;
  }

  if (!timingSafeEqual(expectedSig, providedSig)) return null;

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  } catch {
    return null;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < nowSec) return null;

  return payload;
}

/**
 * Set the session cookie on the response.
 * Secure flag is enabled in production (req.secure check), HttpOnly always.
 */
function setSessionCookie(req, res, token, maxAgeSec) {
  const isProd = process.env.NODE_ENV === 'production' || req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    maxAge: maxAgeSec * 1000,
    path: '/',
  });
}

function clearSessionCookie(req, res) {
  const isProd = process.env.NODE_ENV === 'production' || req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
  });
}

module.exports = {
  COOKIE_NAME,
  createToken,
  verifyToken,
  setSessionCookie,
  clearSessionCookie,
};
