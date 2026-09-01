// Barcode scanning. iOS Safari has no BarcodeDetector API, so we use the
// ZXing JS library from a CDN (runtime-cached by the service worker).
// Camera requires HTTPS and must be started from a user tap.

const ZXING_URL = 'https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js';

let reader = null;
let overlay = null;

function ensureZXing() {
  if (window.ZXing) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = ZXING_URL;
    s.onload = res;
    s.onerror = () => rej(new Error('Could not load the barcode library (are you online?)'));
    document.head.appendChild(s);
  });
}

function buildOverlay() {
  const el = document.createElement('div');
  el.id = 'scan-overlay';
  el.innerHTML = `
    <div class="scan-top">
      <span>Point at a barcode</span>
      <button class="icon-btn" id="scan-cancel" aria-label="Cancel">✕</button>
    </div>
    <video id="scan-video" playsinline muted></video>
    <div class="scan-frame"></div>
    <div class="scan-hint">UPC / EAN — works best with good light</div>`;
  document.body.appendChild(el);
  return el;
}

export function stopScan() {
  if (reader) { try { reader.reset(); } catch (e) { /* already stopped */ } reader = null; }
  if (overlay) { overlay.remove(); overlay = null; }
}

// Opens the camera overlay; resolves with the decoded barcode string,
// or null if the user cancelled. Rejects on camera/library failure.
export async function scanBarcode() {
  await ensureZXing();
  stopScan();
  overlay = buildOverlay();
  const video = overlay.querySelector('#scan-video');

  return new Promise((resolve, reject) => {
    overlay.querySelector('#scan-cancel').onclick = () => { stopScan(); resolve(null); };

    reader = new ZXing.BrowserMultiFormatReader();
    const onResult = (result, err) => {
      if (result) {
        const text = result.getText();
        if (navigator.vibrate) navigator.vibrate(60);
        stopScan();
        resolve(text);
      }
      // err is a NotFoundException on every frame with no code — ignore it
    };

    const constraints = { video: { facingMode: 'environment' } };
    let started;
    if (typeof reader.decodeFromConstraints === 'function') {
      started = reader.decodeFromConstraints(constraints, video, onResult);
    } else {
      started = reader.decodeFromVideoDevice(undefined, video, onResult);
    }
    Promise.resolve(started).catch(err => {
      stopScan();
      reject(new Error('Camera failed to start: ' + (err && err.message ? err.message : err)));
    });
  });
}
