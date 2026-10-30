// Camera access and frame capture for the scanner (browser only).

export class CameraError extends Error {
  /** @param {'permission'|'no-camera'|'insecure'|'busy'|'unknown'} code */
  constructor(code, message) {
    super(message || code);
    this.name = 'CameraError';
    this.code = code;
  }
}

/** Default crop: the book-shaped guide box, as fractions of the video element's box. */
export const DEFAULT_CROP = { x: 0.08, y: 0.18, w: 0.84, h: 0.5 };
const MAX_CAPTURE_SIDE = 1600;

function mapError(e) {
  const n = e?.name || '';
  if (n === 'NotAllowedError' || n === 'SecurityError') return new CameraError('permission', e.message);
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return new CameraError('no-camera', e.message);
  if (n === 'NotReadableError' || n === 'AbortError') return new CameraError('busy', e.message);
  return new CameraError('unknown', e?.message || String(e));
}

function waitForFrame(video, timeoutMs = 6000) {
  if (video.videoWidth && video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); reject(new CameraError('busy', 'camera produced no frames')); }, timeoutMs);
    const on = () => {
      if (video.videoWidth) { cleanup(); resolve(); }
    };
    const cleanup = () => {
      clearTimeout(t);
      video.removeEventListener('loadeddata', on);
      video.removeEventListener('loadedmetadata', on);
      video.removeEventListener('playing', on);
    };
    video.addEventListener('loadeddata', on);
    video.addEventListener('loadedmetadata', on);
    video.addEventListener('playing', on);
  });
}

/**
 * Map a crop given as fractions of the video ELEMENT's box to a rectangle in
 * video pixels, honouring `object-fit: cover` (the element shows the centre of
 * the frame scaled up, so parts of the frame are outside the element).
 */
export function cropToVideoRect(crop, elW, elH, vidW, vidH, pad = 0.04) {
  const s = Math.max(elW / vidW, elH / vidH);
  const ox = (elW - vidW * s) / 2;
  const oy = (elH - vidH * s) / 2;
  const x = (crop.x - pad) * elW;
  const y = (crop.y - pad) * elH;
  const w = (crop.w + 2 * pad) * elW;
  const h = (crop.h + 2 * pad) * elH;
  let sx = (x - ox) / s;
  let sy = (y - oy) / s;
  let sw = w / s;
  let sh = h / s;
  if (sx < 0) { sw += sx; sx = 0; }
  if (sy < 0) { sh += sy; sy = 0; }
  sw = Math.min(sw, vidW - sx);
  sh = Math.min(sh, vidH - sy);
  return { sx: Math.round(sx), sy: Math.round(sy), sw: Math.max(1, Math.round(sw)), sh: Math.max(1, Math.round(sh)) };
}

function drawToCanvas(source, sx, sy, sw, sh, maxSide = MAX_CAPTURE_SIDE) {
  const k = Math.min(1, maxSide / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * k));
  canvas.height = Math.max(1, Math.round(sh * k));
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Start the (back) camera into a <video playsinline muted>.
 * @returns {Promise<{track, hasTorch:boolean, setTorch(on:boolean):Promise<void>, capture(crop?):HTMLCanvasElement, captureFull():HTMLCanvasElement, stop():void}>}
 */
export async function openCamera(video, { facingMode = 'environment' } = {}) {
  if (typeof window !== 'undefined' && window.isSecureContext === false) throw new CameraError('insecure', 'camera needs https');
  if (!navigator.mediaDevices?.getUserMedia) throw new CameraError('no-camera', 'getUserMedia unavailable');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facingMode }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (e) {
    throw mapError(e);
  }
  video.setAttribute('playsinline', '');
  video.setAttribute('muted', '');
  video.muted = true;
  video.srcObject = stream;
  try { await video.play(); } catch { /* autoplay policies: muted inline video normally plays */ }
  try {
    await waitForFrame(video);
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    throw e;
  }
  const [track] = stream.getVideoTracks();
  const caps = track?.getCapabilities?.() || {};
  if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
    track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  }
  let stopped = false;
  return {
    track,
    hasTorch: !!caps.torch,
    async setTorch(on) {
      await track.applyConstraints({ advanced: [{ torch: !!on }] });
    },
    /** The guide-box region of the current frame (crop = fractions of the video element). */
    capture(crop = DEFAULT_CROP) {
      const r = video.getBoundingClientRect();
      const { sx, sy, sw, sh } = cropToVideoRect(crop, r.width || video.clientWidth, r.height || video.clientHeight, video.videoWidth, video.videoHeight);
      return drawToCanvas(video, sx, sy, sw, sh);
    },
    captureFull() {
      return drawToCanvas(video, 0, 0, video.videoWidth, video.videoHeight);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}

/** Decode a photo (gallery or camera app) into a canvas, upright per its EXIF. */
export function imageFileToCanvas(file, maxSide = 2000) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      try {
        // <img> applies EXIF orientation (image-orientation: from-image is the default).
        resolve(drawToCanvas(img, 0, 0, img.naturalWidth, img.naturalHeight, maxSide));
      } catch (e) {
        reject(e);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('ছবিটি খোলা যায়নি'));
    };
    img.src = url;
  });
}

/** JPEG data URL, scaled so the longest side is at most maxSide (cover thumbnails). */
export function canvasToJpegDataUrl(canvas, maxSide = 900, quality = 0.82) {
  const k = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  let src = canvas;
  if (k < 1) src = drawToCanvas(canvas, 0, 0, canvas.width, canvas.height, Math.max(canvas.width, canvas.height) * k);
  return src.toDataURL('image/jpeg', quality);
}

const WANTED = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'qr_code'];
let detectorPromise = null;

/** Barcodes (ISBN EAN-13 etc.) in an image; [] where BarcodeDetector is unavailable. */
export async function detectBarcodes(source) {
  if (typeof globalThis.BarcodeDetector === 'undefined') return [];
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const supported = await globalThis.BarcodeDetector.getSupportedFormats?.().catch(() => []) || [];
      const formats = WANTED.filter((f) => supported.includes(f));
      return formats.length ? new globalThis.BarcodeDetector({ formats }) : null;
    })();
  }
  const detector = await detectorPromise;
  if (!detector) return [];
  try {
    const found = await detector.detect(source);
    return found.map((b) => ({ rawValue: b.rawValue, format: b.format }));
  } catch {
    return [];
  }
}
