/* ==========================================================================
   landing.js — the three buttons.

   Guest works with no configuration at all, because it needs nothing: it names
   a local namespace and leaves. Google and Apple need client ids from
   /api/auth/config, and they answer an absent one differently on purpose.
   Google is a few minutes of console setup, so its button stays put and says
   so on click. Apple wants a paid membership and a verified domain, which a
   deployment may simply never have — so that button is not rendered at all.

   Google goes through the plain OpenID Connect redirect (response_type=
   id_token), not the One Tap library: One Tap suppresses itself after a couple
   of dismissals and cannot be driven from a custom-styled button, which is
   exactly what this page has. Apple uses its own JS SDK in popup mode, which
   does support a custom button and avoids a form_post round trip.
   ========================================================================== */

import {
  startGuestSession, startSession, verifyWithServer, providerConfig,
  readSession, APP_URL,
} from './auth.js';

const $ = (id) => document.getElementById(id);
const el = { google: $('googleBtn'), apple: $('appleBtn'), guest: $('guestBtn'), toast: $('toast') };

const NONCE_KEY = 'ca:auth:nonce';
const APPLE_SDK = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';

let config = { google: null, apple: null };

/* ------------------------------------------------------------------ chrome */

function toast(msg, tone) {
  el.toast.textContent = msg;
  el.toast.className = `toast is-on${tone === 'risk' ? ' toast--risk' : ''}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.toast.className = 'toast'; }, 5000);
}

function busy(btn, on, label) {
  btn.classList.toggle('is-busy', on);
  const text = btn.querySelector('.idbtn__text');
  if (!text) return;
  if (on) {
    text.dataset.was = text.textContent;
    text.textContent = label || 'Signing in…';
  } else if (text.dataset.was) {
    text.textContent = text.dataset.was;
  }
}

function enter(session) {
  /* replace, not assign: the gate should not sit in the back stack where the
     phone's back gesture would drop someone straight back out of the app. */
  location.replace(APP_URL);
  return session;
}

function randomNonce() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
}

/* --------------------------------------------------------------- google */

function googleSignIn() {
  if (!config.google) {
    return toast('Google sign-in is not configured on this server yet.', 'risk');
  }
  const nonce = randomNonce();
  sessionStorage.setItem(NONCE_KEY, nonce);

  const params = new URLSearchParams({
    client_id: config.google,
    redirect_uri: `${location.origin}/landing.html`,
    response_type: 'id_token',
    scope: 'openid email profile',
    nonce,
    prompt: 'select_account',
  });
  location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

/* Google comes back to this same page with the token in the fragment. Reading
   it before anything else runs is what makes the redirect look like a popup. */
async function consumeGoogleRedirect() {
  if (!location.hash || location.hash.length < 2) return false;
  const frag = new URLSearchParams(location.hash.slice(1));
  const token = frag.get('id_token');
  const err = frag.get('error');
  if (!token && !err) return false;

  /* Clear the fragment first: a reload must not re-submit a spent token, and
     an id_token has no business staying in the address bar. */
  history.replaceState(null, '', location.pathname + location.search);

  if (err) {
    toast(err === 'access_denied' ? 'Google sign-in was cancelled.' : `Google returned: ${err}`, 'risk');
    return true;
  }

  const nonce = sessionStorage.getItem(NONCE_KEY);
  sessionStorage.removeItem(NONCE_KEY);

  busy(el.google, true, 'Checking…');
  try {
    const claims = await verifyWithServer('google', token);
    /* The nonce this browser generated has to be the one inside the verified
       token, or the token came from somewhere other than the button. */
    if (nonce && claims.nonce && claims.nonce !== nonce) {
      throw new Error('That sign-in did not match this browser session. Try again.');
    }
    enter(startSession({ kind: 'google', sub: claims.sub, name: claims.name, email: claims.email }));
  } catch (e) {
    toast(e.message || 'Google sign-in failed.', 'risk');
    busy(el.google, false);
  }
  return true;
}

/* ---------------------------------------------------------------- apple */

let appleSdk = null;
function loadAppleSdk() {
  if (appleSdk) return appleSdk;
  appleSdk = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = APPLE_SDK;
    s.onload = () => resolve(globalThis.AppleID);
    s.onerror = () => reject(new Error('Could not load Apple’s sign-in script.'));
    document.head.appendChild(s);
  });
  return appleSdk;
}

async function appleSignIn() {
  if (!config.apple) {
    return toast('Apple sign-in is not configured on this server yet.', 'risk');
  }
  busy(el.apple, true, 'Signing in…');
  try {
    const AppleID = await loadAppleSdk();
    const nonce = randomNonce();
    AppleID.auth.init({
      clientId: config.apple,
      scope: 'name email',
      redirectURI: `${location.origin}/landing.html`,
      usePopup: true,
      nonce,
    });

    const res = await AppleID.auth.signIn();
    const token = res?.authorization?.id_token;
    if (!token) throw new Error('Apple returned no identity token.');

    const claims = await verifyWithServer('apple', token);
    if (claims.nonce && claims.nonce !== nonce) {
      throw new Error('That sign-in did not match this browser session. Try again.');
    }

    /* Apple sends the name exactly once, on the very first authorization, and
       never again — so take it from the SDK response when it is there. */
    const name = [res?.user?.name?.firstName, res?.user?.name?.lastName].filter(Boolean).join(' ');
    enter(startSession({
      kind: 'apple',
      sub: claims.sub,
      name: name || claims.name || '',
      email: res?.user?.email || claims.email || '',
    }));
  } catch (e) {
    const cancelled = e?.error === 'popup_closed_by_user' || e?.error === 'user_cancelled_authorize';
    if (!cancelled) toast(e.message || 'Apple sign-in failed.', 'risk');
    busy(el.apple, false);
  }
}

/* ---------------------------------------------------------------- guest */

function guestSignIn() {
  enter(startGuestSession());
}

/* ------------------------------------------------------------------ boot */

el.google.onclick = googleSignIn;
el.apple.onclick = appleSignIn;
el.guest.onclick = guestSignIn;

(async function boot() {
  /* The inline head script already bounced a signed-in visitor; this covers
     the case where it was blocked or the session appeared mid-load. */
  if (readSession()) return enter();

  config = await providerConfig();

  /* Apple needs a paid developer account and a verified HTTPS domain, so an
     unset APPLE_SERVICE_ID is an ordinary state, not a misconfiguration — the
     button stays out of the page entirely rather than sitting there dead. */
  el.apple.hidden = !config.apple;

  await consumeGoogleRedirect();
})();
