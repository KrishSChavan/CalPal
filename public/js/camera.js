/* ==========================================================================
   camera.js — take the photo, then make it safe to send.

   WHY NOT getUserMedia:
   This app's target is an iOS Home Screen PWA, which is precisely the
   configuration WebKit is still broken in. Bug 282327 ("Camera doesn't start
   in PWA") has been open since Oct 2024; bug 252465 still reproduces on
   current iOS. The failure mode is the nasty one — getUserMedia *resolves*,
   you hold a real MediaStreamTrack, but track.muted is true, canplay never
   fires and every frame is black. So a promise timeout does not catch it.
   Camera permission also isn't persisted across PWA launches, which would
   cost an extra tap on every single meal.

   `capture="environment"` opens the OS camera directly — which is what "take
   a picture in the app" actually needs — with real focus, flash and HDR, no
   permission prompt, and no secure-context requirement. It is the better
   choice here, not a fallback. On desktop it degrades to a file picker, which
   is correct. getUserMedia can be layered on later if a live preview is
   wanted; the rest of this module doesn't care where the File came from.
   ========================================================================== */

/* Long edge sent to the model. Downscaling is for upload bandwidth and
   latency — Gemini 3 bills a flat token count per image regardless of pixels,
   so this does not save tokens. */
const SEND_MAX_EDGE = 1024;
const SEND_QUALITY = 0.82;

/* Stored alongside the meal record in localStorage, so it has to stay small. */
const THUMB_MAX_EDGE = 256;
const THUMB_QUALITY = 0.6;

let cameraInput = null;
let libraryInput = null;

/* Never list image/heic in accept: Safari 17+ reads that as "this app wants
   HEIC" and stops converting to JPEG on the way out. image/* alone gets a
   JPEG from the camera on every current iOS. */
function makeInput(capture) {
  const el = document.createElement('input');
  el.type = 'file';
  el.accept = 'image/*';
  if (capture) el.capture = 'environment';
  el.style.display = 'none';
  document.body.appendChild(el);
  return el;
}

function pick(el, onFile) {
  el.value = ''; // required or picking the same file twice fires no change event
  el.onchange = () => {
    const file = el.files && el.files[0];
    if (file) onFile(file);
  };
  el.click();
}

export function takePhoto(onFile) {
  cameraInput = cameraInput || makeInput(true);
  pick(cameraInput, onFile);
}

export function choosePhoto(onFile) {
  libraryInput = libraryInput || makeInput(false);
  pick(libraryInput, onFile);
}

/* --------------------------------------------------------------- encoding */

async function toBlob(canvas, quality) {
  if (canvas.convertToBlob) {
    return canvas.convertToBlob({ type: 'image/jpeg', quality });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not encode the image.'))),
      'image/jpeg',
      quality
    );
  });
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function draw(bitmap, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  return { canvas, w, h };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('Could not read the image.'));
    fr.readAsDataURL(blob);
  });
}

async function decode(file) {
  /* imageOrientation must be passed explicitly. It defaults to 'from-image'
     today, but used to default to 'none' — so any older manual EXIF-rotation
     code double-rotates. There is deliberately none in this file. */
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (err) {
    const heic = /\.hei[cf]$/i.test(file.name || '') || /hei[cf]/i.test(file.type || '');
    throw new Error(
      heic
        ? "This looks like a HEIC photo and this browser can't read that format. On iPhone, Settings › Camera › Formats › Most Compatible saves photos as JPEG."
        : "That file couldn't be read as an image. Try a JPEG or PNG."
    );
  }
}

/**
 * Re-encode a captured photo to a JPEG that is safe to upload.
 *
 * Does four jobs at once: bakes in EXIF rotation (so the model doesn't see a
 * sideways plate), converts HEIC out of existence, cuts a 12MP/6MB phone photo
 * by roughly 30x, and guarantees the MIME type — so the server can hardcode
 * image/jpeg instead of trusting the upload's filename, which is where the
 * old `path.extname(originalname)` bug came from.
 *
 * @returns {{blob: Blob, dataUrl: string, thumb: string, width: number, height: number, bytes: number}}
 */
export async function normalize(file) {
  const bitmap = await decode(file);
  try {
    const main = draw(bitmap, SEND_MAX_EDGE);
    const blob = await toBlob(main.canvas, SEND_QUALITY);

    const small = draw(bitmap, THUMB_MAX_EDGE);
    const thumbBlob = await toBlob(small.canvas, THUMB_QUALITY);

    const [dataUrl, thumb] = await Promise.all([
      blobToDataUrl(blob),
      blobToDataUrl(thumbBlob),
    ]);

    return {
      blob,
      dataUrl,
      thumb,
      width: main.w,
      height: main.h,
      bytes: blob.size,
    };
  } finally {
    bitmap.close?.();
  }
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
