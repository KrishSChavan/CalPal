/* ==========================================================================
   auth.js — who the log belongs to.

   There is no server-side database and this file does not add one. Signing in
   fetches nothing and syncs nothing: it decides WHICH localStorage namespace
   the app opens. A Google or Apple identity resolves to a stable `sub` claim,
   and that sub names the namespace. Sign out, sign back in on the same device,
   and the same bytes come back.

   The honest consequence, stated here so no screen has to imply otherwise:
   the account is a key, not an account. A log does not follow anyone to a
   second device, and the server is never told that a meal was eaten. Guest
   gets a namespace of its own — never the same one an identity opens.
   ========================================================================== */

const SESSION_KEY = 'ca:session';

export const LANDING_URL = '/landing.html';
export const APP_URL = '/';

/* ---------------------------------------------------------------- session */

/* Shape: { kind: 'google'|'apple'|'guest', sub, name, email, since } */
export function readSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || typeof s !== 'object') return null;
    if (!['google', 'apple', 'guest'].includes(s.kind)) return null;
    if (!s.sub) return null;
    return s;
  } catch {
    return null;
  }
}

/* The namespace is the whole point of sign-in, so it is derived — never
   stored and never sent by the server. A provider that reissued a different
   sub for the same person would open a different (empty) log rather than
   silently merging two people's food into one. */
export function namespaceFor(session) {
  if (!session) return null;
  const sub = String(session.sub).replace(/[^A-Za-z0-9_.-]/g, '');
  return session.kind === 'guest' ? 'guest' : `${session.kind}.${sub}`;
}

export function startSession({ kind, sub, name = '', email = '', token = '' }) {
  /* `token` is the server's own bearer token, issued only after Google or
     Apple vouched for this person. It is what /api/analyze checks. A guest
     session has none, and cannot be given one — that is the whole point. */
  const session = { kind, sub: String(sub), name, email, token, since: Date.now() };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

/* One guest log per device. Not a random id: a fresh id on every "continue as
   guest" would strand yesterday's meals behind a namespace nothing points to. */
export function startGuestSession() {
  return startSession({ kind: 'guest', sub: 'local', name: 'Guest' });
}

/* Clears the session only. The food logs stay where they are — that is what
   makes signing back in feel like unlocking rather than starting over. */
export function signOut() {
  localStorage.removeItem(SESSION_KEY);
}

/* ------------------------------------------------------------- provider */

/* The server's only job here is to verify the provider's signature and hand
   back the sub. It stores nothing. A 404 (no route wired yet) and a rejected
   token are both failures, but they need different words on the screen. */
export async function verifyWithServer(kind, token) {
  let res;
  try {
    res = await fetch(`/api/auth/${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch {
    throw new AuthError('Could not reach the server to check that sign-in.', 'offline');
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* The SPA fallback answers every unmatched GET with index.html, and an
       unwired POST route 404s into HTML too — so unparseable means unwired. */
    throw new AuthError('Sign-in is not wired up on this server yet.', 'not_configured');
  }

  if (!res.ok || payload?.ok === false) {
    throw new AuthError(payload?.error?.message || 'That sign-in was rejected.', payload?.error?.code || 'rejected');
  }
  if (!payload.sub) throw new AuthError('The server verified the token but returned no account id.', 'bad_response');
  return payload;
}

export class AuthError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AuthError';
    this.code = code || 'unknown';
  }
}

/* Which providers this deployment can actually offer. Unconfigured is the
   normal state before the client ids exist, so it is a value, not an error. */
export async function providerConfig() {
  const blank = { google: null, apple: null };
  try {
    const res = await fetch('/api/auth/config');
    if (!res.ok) return blank;
    const cfg = await res.json();
    return { google: cfg.google || null, apple: cfg.apple || null };
  } catch {
    return blank;
  }
}

/* The bearer token for API calls that cost the operator money, or '' when
   this session has none (guest, or a sign-in that predates server tokens). */
export function sessionToken() {
  return readSession()?.token || '';
}

/* ------------------------------------------------------------- guarding */

/* Called by the app before it renders anything. Returns null after starting a
   redirect, so the caller can skip the render instead of painting a log that
   is about to be replaced. */
export function requireSession() {
  const session = readSession();
  if (!session) {
    location.replace(LANDING_URL);
    return null;
  }
  return session;
}
