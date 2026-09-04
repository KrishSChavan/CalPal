/* ==========================================================================
   session.js — the server's own bearer tokens.

   The quota that rides on them lives in rate-limit.js; this file is only
   concerned with who someone is, not how often they may ask.

   The app has no database, and this file does not add one. It closes a
   different hole: /api/analyze spends the operator's Gemini quota, two
   requests per photo, and until now anyone who found the URL could spend it.
   The sign-in gate was client-side only — localStorage and a redirect — which
   stops nobody holding curl.

   So the server issues its own token. /api/auth/:provider already verifies a
   real Google or Apple id_token; on success it now also mints a short-lived
   JWT signed with a secret only this server knows, and /api/analyze demands
   one. That is stateless — no session table, nothing to store — and it moves
   the cost of abuse from "find the URL" to "own a Google account, and even
   then only N photos an hour".

   What this deliberately does NOT do: identify anyone to the app. The token
   carries the provider's `sub` so the quota can be counted per person, and
   nothing else. No food log ever reaches the server, before or after this.
   ========================================================================== */

const crypto = require('crypto');
const { SignJWT, jwtVerify } = require('jose');

const ISSUER = 'calpal';
const AUDIENCE = 'calpal-api';
const TTL = process.env.SESSION_TTL || '30d';

class SessionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SessionError';
    this.code = code || 'unauthorized';
  }
}

/* ----------------------------------------------------------------- secret */

let _secret = null;
let _secretSource = null;

/* Three cases, and the difference between them matters more than it looks.

   A secret from the environment is the only one that works on a serverless
   host: every instance derives the same key, so a token minted by one is
   accepted by the next. A random per-process secret is fine on a laptop and
   actively broken on Vercel, where instances come and go and a user would be
   signed out at random. So the fallback is allowed off-platform only, and on
   Vercel a missing secret fails closed rather than half-working. */
function secret() {
  if (_secret) return _secret;

  const raw = process.env.AUTH_SECRET;
  if (raw) {
    if (raw.length < 32) {
      throw new SessionError(
        'AUTH_SECRET is set but shorter than 32 characters. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
        'bad_secret'
      );
    }
    _secret = new TextEncoder().encode(raw);
    _secretSource = 'env';
    return _secret;
  }

  if (process.env.VERCEL) {
    throw new SessionError(
      'AUTH_SECRET is not set. Sign-in cannot issue tokens without it — add it in Project Settings → Environment Variables and redeploy.',
      'no_secret'
    );
  }

  _secret = crypto.randomBytes(32);
  _secretSource = 'ephemeral';
  console.warn(
    '[session] AUTH_SECRET is not set — using a random per-process secret. ' +
    'Fine for local development; every restart signs everyone out, and it would ' +
    'break outright across serverless instances.'
  );
  return _secret;
}

/* Exposed for /api/health so a deployment can be checked without a sign-in. */
function secretStatus() {
  try {
    secret();
    return { ok: true, source: _secretSource };
  } catch (err) {
    return { ok: false, source: null, error: err.message };
  }
}

/* ------------------------------------------------------------------ mint */

/* `sub` is the provider's stable subject claim, already signature-verified by
   the caller. `kind` is 'google' or 'apple' — never 'guest': a guest identity
   is self-asserted, so signing one would only be laundering an unverified
   claim through our own key. */
async function issue({ sub, kind }) {
  if (!sub) throw new SessionError('Cannot issue a session with no subject.', 'bad_request');
  if (kind !== 'google' && kind !== 'apple') {
    throw new SessionError(`Refusing to issue a session for kind "${kind}".`, 'bad_request');
  }
  return new SignJWT({ kind })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(sub))
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(TTL)
    .sign(secret());
}

/* ---------------------------------------------------------------- verify */

async function verify(token) {
  if (!token) throw new SessionError('This request carried no session token.', 'no_session');
  let payload;
  try {
    ({ payload } = await jwtVerify(token, secret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      clockTolerance: 60,
    }));
  } catch (err) {
    /* A secret that could not be resolved is a server fault, not the caller's,
       and must not be reported as a bad token. */
    if (err instanceof SessionError) throw err;
    const expired = err && err.code === 'ERR_JWT_EXPIRED';
    throw new SessionError(
      expired ? 'Your sign-in has expired. Sign in again.' : 'That session token is not valid.',
      expired ? 'session_expired' : 'bad_session'
    );
  }
  return { sub: payload.sub, kind: payload.kind };
}

/* Pulls the bearer token out of an Express request. Header only — never a
   query parameter, which would end up in access logs and Referer headers. */
function bearer(req) {
  const raw = req.get ? req.get('authorization') : req.headers?.authorization;
  if (!raw) return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1].trim() : null;
}

module.exports = {
  issue,
  verify,
  bearer,
  secretStatus,
  SessionError,
};
