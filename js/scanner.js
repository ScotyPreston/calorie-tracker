// Barcode scanning — ported from the Clash Sourcing phone app's proven reader (8-21).
// Three decoders, best-first, with live diagnostics in the hint line:
//   1. native BarcodeDetector — Android Chrome (skipped on iOS: Safari's is absent/unreliable)
//   2. zxing-wasm — zxing-cpp compiled to WebAssembly, self-hosted in ./zxing-wasm/.
//      On-device, ~40-70 ms a frame, alternating full frame / 2x middle band.
//      This is the iPhone's real reader: ZXing-js rarely locks onto a UPC.
//   3. ZXing-js from the CDN — only if the wasm fails to load/run.
// Camera: environment lens at 1920x1080 ideal, continuous autofocus, torch button
// when the hardware has one, beep + vibrate on a hit.

const ZXINGJS_URL = 'https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js';
const NATIVE_FORMATS = ['upc_a', 'upc_e', 'ean_13', 'ean_8', 'code_128', 'itf'];
const WASM_OPTS = {
  formats: ['UPC-A', 'UPC-E', 'EAN-13', 'EAN-8', 'Code128', 'ITF'],
  tryHarder: true, tryRotate: true, tryInvert: false, tryDownscale: true,
  maxNumberOfSymbols: 1,
};
const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let overlay = null, stream = null, camTrack = null, zxReader = null;
let scanning = false, scanTimer = null, diagTimer = null, scanStart = 0;
let diag = { engine: '', frames: 0, err: '' };

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[data-src="${src}"]`)) return res();
    const s = document.createElement('script');
    s.src = src; s.dataset.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error('failed to load ' + src));
    document.head.appendChild(s);
  });
}

function beep(ok = true) {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = ok ? 1480 : 300; g.gain.value = 0.15;
    o.connect(g); g.connect(ac.destination);
    o.start(); o.stop(ac.currentTime + (ok ? 0.09 : 0.25));
    setTimeout(() => ac.close(), 400);
  } catch (e) { /* audio not available */ }
  if (navigator.vibrate) navigator.vibrate(ok ? 40 : [60, 40, 60]);
}

// UPC-E (8 digits) -> UPC-A (12)
function upceToUpca(u) {
  if (!/^\d{8}$/.test(u)) return u;
  const ns = u[0], d = u.slice(1, 7), c = u[7];
  if (ns !== '0' && ns !== '1') return u;
  const last = d[5];
  let m;
  if (last === '0' || last === '1' || last === '2') m = d.slice(0, 2) + last + '0000' + d.slice(2, 5);
  else if (last === '3') m = d.slice(0, 3) + '00000' + d.slice(3, 5);
  else if (last === '4') m = d.slice(0, 4) + '00000' + d[4];
  else m = d.slice(0, 5) + '0000' + last;
  return ns + m + c;
}

// zxing-cpp reports UPC-A as EAN-13 "0"+UPC even with UPC-A in formats.
// Returns [normalized, raw] candidate codes for lookups (deduped, normalized first).
export function codeCandidates(text, fmt) {
  const raw = String(text || '').replace(/\D/g, '');
  let t = raw;
  const f = String(fmt || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (t.length === 8 && (f.includes('upce') || t[0] === '0')) t = upceToUpca(t);
  if (t.length === 13 && t[0] === '0') t = t.slice(1);
  return [...new Set([t, raw])].filter(Boolean);
}

// ---- overlay ----

function buildOverlay() {
  const el = document.createElement('div');
  el.id = 'scan-overlay';
  el.innerHTML = `
    <div class="scan-top">
      <span id="scan-title">Scan barcode</span>
      <span>
        <button class="icon-btn" id="scan-torch" style="display:none" aria-label="Flashlight">🔦</button>
        <button class="icon-btn" id="scan-cancel" aria-label="Cancel">✕</button>
      </span>
    </div>
    <video id="scan-video" playsinline muted autoplay></video>
    <div class="scan-frame"></div>
    <div class="scan-hint" id="scan-hint">Point the camera at the barcode</div>`;
  document.body.appendChild(el);
  return el;
}

function hint() {
  if (!overlay) return;
  const t = (Date.now() - scanStart) / 1000;
  let s = 'Point the camera at the barcode';
  if (diag.engine) s += `  ·  ${diag.engine} ${diag.frames}f`;
  if (diag.err) s += `  ⚠ ${diag.err}`;
  if (t > 8) s += '  —  hold steady, fill the box' + (camTrack?.getCapabilities?.().torch ? ', try the 🔦' : '');
  overlay.querySelector('#scan-hint').textContent = s;
}

export function stopScan() {
  scanning = false;
  clearTimeout(scanTimer);
  clearInterval(diagTimer);
  if (zxReader) { try { zxReader.reset(); } catch (e) { /* already stopped */ } zxReader = null; }
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  camTrack = null;
  if (overlay) { overlay.remove(); overlay = null; }
}

// Opens the camera overlay; resolves with the decoded barcode DIGITS (normalized
// candidates joined by the caller via codeCandidates — we resolve {text, format}),
// or null if the user cancelled. Rejects on camera failure.
export async function scanBarcode() {
  stopScan();
  overlay = buildOverlay();
  const video = overlay.querySelector('#scan-video');

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  } catch (e) {
    stopScan();
    throw new Error('Camera unavailable (' + (e.name || e) + ').' +
      (location.protocol !== 'https:' && location.hostname !== 'localhost'
        ? ' The camera only works over HTTPS.'
        : ' Allow camera access for this site in Settings → Safari → Camera.'));
  }

  video.srcObject = stream;
  try { await video.play(); } catch (e) { /* iOS resolves via autoplay */ }
  camTrack = stream.getVideoTracks()[0];
  const caps = camTrack.getCapabilities ? camTrack.getCapabilities() : {};
  if (caps.torch) overlay.querySelector('#scan-torch').style.display = '';
  try {
    if (caps.focusMode && caps.focusMode.includes('continuous')) {
      await camTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    }
  } catch (e) { /* focus hint only */ }

  return new Promise((resolve) => {
    overlay.querySelector('#scan-cancel').onclick = () => { stopScan(); resolve(null); };
    overlay.querySelector('#scan-torch').onclick = async (ev) => {
      const btn = ev.currentTarget;
      const on = btn.dataset.on === '1';
      try {
        await camTrack.applyConstraints({ advanced: [{ torch: !on }] });
        btn.dataset.on = on ? '' : '1';
        btn.style.background = on ? '' : '#f59e0b';
      } catch (e) { /* no torch after all */ }
    };

    const onCode = (text, format) => {
      if (!scanning) return;
      beep(true);
      stopScan();
      resolve({ text, format });
    };

    scanning = true;
    scanStart = Date.now();
    diag = { engine: '', frames: 0, err: '' };
    diagTimer = setInterval(hint, 500);
    startDecoding(video, onCode);
  });
}

// ---- decoder chain ----

async function startDecoding(video, onCode) {
  let nativeOk = false;
  if (!IS_IOS && 'BarcodeDetector' in window) {
    try {
      const sup = await window.BarcodeDetector.getSupportedFormats();
      const fmts = NATIVE_FORMATS.filter(f => sup.includes(f));
      if (fmts.length) {
        const det = new window.BarcodeDetector({ formats: fmts });
        diag.engine = 'native';
        nativeOk = true;
        let fails = 0;
        const tick = async () => {
          if (!scanning || diag.engine !== 'native') return;
          if (video.readyState >= 2) {
            try {
              const codes = await det.detect(video);
              diag.frames++;
              if (codes && codes.length) { onCode(codes[0].rawValue, codes[0].format); return; }
            } catch (e) {
              if (++fails >= 5) { diag.err = 'native failed, using wasm'; diag.engine = ''; startWasm(video, onCode); return; }
            }
          }
          scanTimer = setTimeout(tick, 120);
        };
        tick();
      }
    } catch (e) { nativeOk = false; }
  }
  if (!nativeOk) startWasm(video, onCode);
}

// zxing-wasm: the same zxing-cpp reader as Clash Sourcing, self-hosted so the
// service worker can cache it and scanning known foods works offline.
let wasmReady = null, wasmCanvas = null;

function loadWasmReader() {
  if (!wasmReady) {
    wasmReady = (async () => {
      await loadScript('zxing-wasm/zxing-reader.js');
      // the library defaults to fetching its .wasm from a CDN — keep it local
      await window.ZXingWASM.prepareZXingModule({
        overrides: { locateFile: (p) => 'zxing-wasm/' + p },
        fireImmediately: true,
      });
    })();
    wasmReady.catch(() => { wasmReady = null; });
  }
  return wasmReady;
}

// pass 0 = whole frame at ~800px; pass 1 = the middle band blown up 2x
// (small / far-away barcodes). Same two passes as the Clash Sourcing reader.
async function wasmDecodeFrame(video, pass) {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return null;
  if (!wasmCanvas) wasmCanvas = document.createElement('canvas');
  const c = wasmCanvas, ctx = c.getContext('2d', { willReadFrequently: true });
  if (pass % 2 === 0) {
    const s = Math.min(1, 800 / Math.max(w, h));
    c.width = Math.round(w * s); c.height = Math.round(h * s);
    ctx.drawImage(video, 0, 0, c.width, c.height);
  } else {
    const y0 = Math.round(h * 0.22), bh = Math.round(h * 0.5);
    const s = Math.min(2, 1600 / w);
    c.width = Math.round(w * s); c.height = Math.round(bh * s);
    ctx.drawImage(video, 0, y0, w, bh, 0, 0, c.width, c.height);
  }
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const res = await window.ZXingWASM.readBarcodes(img, WASM_OPTS);
  return (res || []).find(r => r && r.isValid && r.text) || null;
}

async function startWasm(video, onCode) {
  try {
    diag.engine = 'wasm…';
    await loadWasmReader();
    if (!scanning) return;
    diag.engine = 'wasm';
    diag.frames = 0;
    let pass = 0, errs = 0;
    const tick = async () => {
      if (!scanning || diag.engine !== 'wasm') return;
      if (video.readyState >= 2) {
        try {
          const r = await wasmDecodeFrame(video, pass++);
          diag.frames++;
          if (r) { onCode(r.text, r.format); return; }
        } catch (e) {
          if (++errs >= 5) { diag.err = 'wasm failed, using ZXing-js'; diag.engine = ''; startZxingJs(video, onCode); return; }
        }
      }
      scanTimer = setTimeout(tick, 40);
    };
    tick();
  } catch (e) {
    diag.err = 'wasm load failed, using ZXing-js';
    startZxingJs(video, onCode);
  }
}

// ZXing-js — last resort. NOT decodeFromVideoDevice/decodeFromStream: those wait
// for the video's "playing" event, which has ALREADY fired on our running <video>,
// so the loop never starts. Drive decodeContinuously directly.
async function startZxingJs(video, onCode) {
  try {
    await loadScript(ZXINGJS_URL);
    if (!scanning) return;
    const ZX = window.ZXing;
    const hints = new Map();
    hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, [
      ZX.BarcodeFormat.UPC_A, ZX.BarcodeFormat.UPC_E, ZX.BarcodeFormat.EAN_13,
      ZX.BarcodeFormat.EAN_8, ZX.BarcodeFormat.CODE_128, ZX.BarcodeFormat.ITF,
    ]);
    hints.set(ZX.DecodeHintType.TRY_HARDER, true);
    zxReader = new ZX.BrowserMultiFormatReader(hints, 150);
    diag.engine = 'ZXing';
    diag.frames = 0;
    zxReader.videoElement = video;
    zxReader.decodeContinuously(video, (result, err) => {
      if (!scanning) return;
      diag.frames++;
      if (result) { onCode(result.getText(), String(result.getBarcodeFormat())); return; }
      if (err && !(err instanceof ZX.NotFoundException) && !(err instanceof ZX.ChecksumException)
        && !(err instanceof ZX.FormatException)) diag.err = String(err.message || err).slice(0, 60);
    });
  } catch (e) {
    diag.err = 'ZXing: ' + String(e.message || e).slice(0, 60);
  }
}
