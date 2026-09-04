/* ==========================================================================
   jose.js — one lazy, memoized handle on an ESM-only dependency.

   jose v6 ships ESM only ("type": "module", no CJS build). Stock Node 20.19+
   and 22.12+ will happily `require()` that, which is why it worked locally and
   in the test suite — and why it was wrongly ruled out while debugging a
   production crash.

   Vercel does not use stock Node's module loader. Its launcher (visible in a
   stack trace as /opt/rust/nodejs.js and /opt/rust/bytecode.js) implements its
   own _load with bytecode caching, and that path does not support require(esm)
   on any Node version. The result was ERR_REQUIRE_ESM thrown during module
   init, which means the platform never receives the exported app and EVERY
   request 500s as FUNCTION_INVOCATION_FAILED — including ones that never touch
   sign-in.

   Dynamic import() is the fix Vercel's own error message recommends, and it
   works identically under both loaders. Everything that needs jose is already
   async, so this costs nothing but an await.
   ========================================================================== */

let loaded = null;
let pending = null;

/* Memoized on the resolved module, not just the promise, so the common case is
   a plain property read. `pending` collapses a burst of concurrent first calls
   into a single import rather than several. */
async function jose() {
  if (loaded) return loaded;
  if (!pending) {
    pending = import('jose').then(
      (mod) => {
        loaded = mod;
        pending = null;
        return mod;
      },
      (err) => {
        /* Let the next call retry rather than caching a rejected promise
           forever — a transient loader failure should not poison the process. */
        pending = null;
        throw err;
      }
    );
  }
  return pending;
}

module.exports = { jose };
