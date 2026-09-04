/* ==========================================================================
   api.js — the server calls. fetch only; axios and its CDN <script> are gone.
   ========================================================================== */

import { sessionToken } from './auth.js';

export class ApiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ApiError';
    this.code = code || 'unknown';
  }
}

/* The server distinguishes no-key / bad-key / rate-limited / model-gone /
   bad-JSON, because each one needs a different action from the person holding
   the phone. Anything unmapped falls through to the server's own message. */
const FALLBACK = {
  no_key: 'The server has no Gemini API key configured yet.',
  bad_key: 'The server’s API key was rejected. It may need to be regenerated.',
  rate_limited: 'Hit the free-tier rate limit. Wait a minute and try again.',
  model_missing: 'The configured vision model no longer exists. The server needs a new VISION_MODEL.',
  bad_response: 'The model returned something unreadable. Try that photo again.',
  no_image: 'No photo reached the server.',
  too_large: 'That photo was too large to upload.',
  no_session: 'Photo analysis needs a signed-in account. Guests can still add meals by hand.',
  bad_session: 'That sign-in could not be verified. Sign in again.',
  session_expired: 'Your sign-in has expired. Sign in again.',
  not_configured: 'This server cannot verify sign-ins yet, so photo analysis is unavailable.',
};

async function post(path, body, { timeoutMs = 90000, auth = false } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  /* Header, not a field in the form: a token in the body would be logged by
     any proxy that records request bodies, and copied into every retry. */
  const headers = {};
  if (auth) {
    const token = sessionToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let res;
  try {
    res = await fetch(path, { method: 'POST', body, headers, signal: ctrl.signal });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new ApiError('That took too long. Check your connection and try again.', 'timeout');
    }
    throw new ApiError('Could not reach the server.', 'offline');
  }
  clearTimeout(timer);

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    throw new ApiError(`Server returned ${res.status} with no usable body.`, 'bad_response');
  }

  if (!res.ok || payload?.ok === false) {
    const code = payload?.error?.code || 'unknown';
    throw new ApiError(payload?.error?.message || FALLBACK[code] || `Request failed (${res.status}).`, code);
  }
  return payload;
}

export async function analyzeMeal({ blob, notes, slot, localTimeLabel, plateDiameterCm }) {
  const form = new FormData();
  form.append('image', blob, 'meal.jpg');
  if (notes) form.append('notes', notes);
  if (slot) form.append('slot', slot);
  if (localTimeLabel) form.append('localTimeLabel', localTimeLabel);
  if (plateDiameterCm) form.append('plateDiameterCm', String(plateDiameterCm));
  return post('/api/analyze', form, { auth: true });
}

export async function health() {
  const res = await fetch('/api/health');
  return res.json();
}
