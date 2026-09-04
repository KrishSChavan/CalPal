/* ==========================================================================
   rate-limit.js — sliding-window ceilings for every /api route.

   One engine, several configured instances, because the routes are not alike:
   /api/analyze spends two Gemini requests and is counted per signed-in
   identity; /api/auth/* is unauthenticated by definition and can only be
   counted per client address; /api/health used to reach out to Google on
   every single hit.

   THE HONEST CAVEAT, stated once here rather than hedged everywhere: these
   counters live in this process's memory. A serverless host runs many
   instances, so the real ceiling is the configured number times however many
   are warm, and a cold start forgets everything. That is still the difference
   between "a loop drains the day's quota in a minute" and "it cannot", which
   is what this is for. A globally exact limit needs the shared datastore this
   app is deliberately built without — if that changes, swap the Map in
   createLimiter for it and nothing else here moves.
   ========================================================================== */

/* Longest window any limiter uses, for pruning. Recomputed as limiters are
   created so a custom window cannot silently outlive the sweep. */
const MAX_TRACKED_KEYS = 5000;

/* ------------------------------------------------------------ client ip */

/* Getting this wrong in either direction is a real bug: trust a header too
   readily and any caller spoofs their way past the limit by rotating it;
   ignore proxies entirely and every request behind Vercel's edge shares one
   address and one bucket.

   So: on Vercel, x-vercel-forwarded-for is set by the platform and any
   client-supplied copy is overwritten before the function sees it. Off
   platform, the socket address is the only thing not under the caller's
   control — x-forwarded-for is honoured only when TRUST_PROXY says some
   trusted hop is actually in front of us. */
function clientIp(req) {
  const header = (name) => {
    const v = req.headers?.[name];
    if (!v) return null;
    const first = String(Array.isArray(v) ? v[0] : v).split(',')[0].trim();
    return first || null;
  };

  if (process.env.VERCEL) {
    const vercel = header('x-vercel-forwarded-for') || header('x-real-ip') || header('x-forwarded-for');
    if (vercel) return vercel;
  } else if (process.env.TRUST_PROXY === '1') {
    const fwd = header('x-forwarded-for') || header('x-real-ip');
    if (fwd) return fwd;
  }

  const socket = req.socket?.remoteAddress || req.connection?.remoteAddress;
  /* Collapse IPv4-mapped IPv6 so ::ffff:1.2.3.4 and 1.2.3.4 share a bucket. */
  return socket ? String(socket).replace(/^::ffff:/, '') : 'unknown';
}

/* --------------------------------------------------------------- engine */

/* `windows` is a list of { key, ms, max }; every one must pass. Two windows is
   usually right — a short one to stop a burst, a long one to stop a slow drip
   that would never trip the short one. */
function createLimiter({ name, windows, keyBy = clientIp, message }) {
  if (!Array.isArray(windows) || !windows.length) {
    throw new Error(`rate-limit: "${name}" was created with no windows`);
  }
  const longest = Math.max(...windows.map((w) => w.ms));
  const hits = new Map(); // key -> number[] of epoch ms, ascending

  function sweep(now) {
    for (const [key, stamps] of hits) {
      const live = stamps.filter((t) => now - t < longest);
      if (live.length) hits.set(key, live);
      else hits.delete(key);
    }
  }

  /* Checks and records in one step. A check that did not consume the slot
     would let two concurrent requests both pass the same final unit. */
  function consume(key, now = Date.now()) {
    if (hits.size > MAX_TRACKED_KEYS) sweep(now);

    const stamps = (hits.get(key) || []).filter((t) => now - t < longest);

    for (const w of windows) {
      if (!Number.isFinite(w.max) || w.max <= 0) continue;
      const inWindow = stamps.filter((t) => now - t < w.ms);
      if (inWindow.length >= w.max) {
        hits.set(key, stamps);
        const retryAfter = Math.max(1, Math.ceil((w.ms - (now - inWindow[0])) / 1000));
        return { ok: false, window: w.key, limit: w.max, retryAfter, remaining: 0 };
      }
    }

    stamps.push(now);
    hits.set(key, stamps);

    /* Report headroom against whichever window is closest to tripping, so a
       client watching RateLimit-Remaining sees the binding constraint. */
    let remaining = Infinity;
    let limit = 0;
    for (const w of windows) {
      if (!Number.isFinite(w.max) || w.max <= 0) continue;
      const left = w.max - stamps.filter((t) => now - t < w.ms).length;
      if (left < remaining) { remaining = left; limit = w.max; }
    }
    return { ok: true, remaining: Number.isFinite(remaining) ? remaining : 0, limit };
  }

  /* Express middleware. `fail` is injected so this module stays ignorant of
     the app's error envelope. */
  function middleware(fail) {
    return (req, res, next) => {
      const key = keyBy(req);
      /* No key means nothing to count against — an identity-keyed limiter on
         a route whose gate let an anonymous request through. Fail closed
         rather than silently exempting it. */
      if (!key) return fail(res, 429, 'rate_limited', 'Could not identify this caller to rate limit it.');

      const verdict = consume(`${name}:${key}`);

      res.set('RateLimit-Limit', String(verdict.limit));
      res.set('RateLimit-Remaining', String(Math.max(0, verdict.remaining)));

      if (verdict.ok) return next();

      res.set('Retry-After', String(verdict.retryAfter));
      res.set('RateLimit-Reset', String(verdict.retryAfter));
      const wait = verdict.retryAfter >= 60
        ? `${Math.ceil(verdict.retryAfter / 60)} min`
        : `${verdict.retryAfter}s`;
      return fail(
        res,
        429,
        'rate_limited',
        message
          ? `${message} Try again in ${wait}.`
          : `Too many requests — that is ${verdict.limit} per ${verdict.window}. Try again in ${wait}.`
      );
    };
  }

  return { name, windows, consume, middleware, reset: () => hits.clear(), _size: () => hits.size };
}

/* ------------------------------------------------------------- limiters */

const num = (envName, fallback) => {
  const n = Number(process.env[envName]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/* Per signed-in identity, not per address: two people behind one NAT should
   not share a photo budget, and one account roaming between networks should
   not get a fresh one by moving. */
const analyze = createLimiter({
  name: 'analyze',
  keyBy: (req) => req.session?.sub || null,
  message: 'You have hit the photo-analysis limit for this account.',
  windows: [
    { key: 'hour', ms: HOUR, max: num('ANALYZE_PER_HOUR', 20) },
    { key: 'day', ms: DAY, max: num('ANALYZE_PER_DAY', 60) },
  ],
});

/* Unauthenticated and does real work — a JWKS fetch on a cold instance, then
   an RSA signature check. Nobody signs in ten times a minute honestly. */
const auth = createLimiter({
  name: 'auth',
  message: 'Too many sign-in attempts from this address.',
  windows: [
    { key: 'minute', ms: MIN, max: num('AUTH_PER_MINUTE', 10) },
    { key: 'hour', ms: HOUR, max: num('AUTH_PER_HOUR', 60) },
  ],
});

/* Cheap (reads two env vars) but public, so it still gets a ceiling — mostly
   to keep a broken client's retry loop from spinning the whole function. */
const config = createLimiter({
  name: 'config',
  windows: [{ key: 'minute', ms: MIN, max: num('CONFIG_PER_MINUTE', 60) }],
});

/* Tight, because /api/health reaches Google. The cache in index.js is the
   real fix; this is the backstop for the first hit of every cache period. */
const health = createLimiter({
  name: 'health',
  windows: [
    { key: 'minute', ms: MIN, max: num('HEALTH_PER_MINUTE', 6) },
    { key: 'hour', ms: HOUR, max: num('HEALTH_PER_HOUR', 60) },
  ],
});

/* Backstop across everything under /api, so a route added later inherits a
   ceiling instead of being wide open until someone remembers. Deliberately
   loose: it should never be what stops a legitimate client. */
const api = createLimiter({
  name: 'api',
  message: 'Too many requests from this address.',
  windows: [
    { key: 'minute', ms: MIN, max: num('API_PER_MINUTE', 120) },
    { key: 'hour', ms: HOUR, max: num('API_PER_HOUR', 1200) },
  ],
});

const all = [analyze, auth, config, health, api];

module.exports = {
  createLimiter,
  clientIp,
  limiters: { analyze, auth, config, health, api },
  /* Test seam — the windows are wall-clock, so a test needs a way back to zero. */
  resetAll: () => all.forEach((l) => l.reset()),
};
