/**
 * aidepth.js — object-aware monocular depth estimation, fully local.
 *
 * Runs Depth Anything V2 Small (quantized ONNX, ~26 MB) through ONNX Runtime
 * Web. Prefers WebGPU, falls back to WASM automatically.
 *
 * Works from BOTH http:// and file://:
 *  - http://  → model + WASM binaries are fetched from models/ and lib/.
 *  - file://  → browsers block fetch()/import() of local files, so the model
 *               and WASM are loaded from generated base64 bundles
 *               (models/model-bundle.js, lib/ort-wasm-bundle.js) and the
 *               loader module is blob-imported (lib/ort-jsep-loader-inline.js).
 *               Regenerate bundles with: node tools/gen-bundles.js
 *
 * The model returns *relative scene depth* (near = large). We normalize it to
 * 0..1 with near = high so it plugs straight into the existing depth pipeline
 * (raised subject, receding background) — the opposite of luminance guessing.
 *
 * Classic script: exposes window.AIDepth.
 */

window.AIDepth = (function () {
  'use strict';

  const MODEL_URL = 'models/depth-anything-v2-small-q8.onnx';
  const INPUT_SIZE = 518;            // ViT-S patch grid: 518 = 37 × 14
  const IS_FILE = window.location.protocol === 'file:';
  // ImageNet normalization used by Depth Anything.
  const MEAN = [0.485, 0.456, 0.406];
  const STD = [0.229, 0.224, 0.225];

  let sessionPromise = null;         // lazy singleton
  let activeProvider = null;         // 'webgpu' | 'wasm' once created
  let modelBytesPromise = null;      // ArrayBuffer of the model (file:// only)
  // ONNX Runtime sessions are not re-entrant: concurrent run() calls corrupt
  // state. Serialize inference through a simple promise chain.
  let runQueue = Promise.resolve();
  function enqueue(fn) {
    const p = runQueue.then(fn, fn);
    runQueue = p.catch(() => {});
    return p;
  }

  /** Cache: per-image inference results keyed by a WeakMap on the element. */
  const resultCache = new WeakMap();

  // ── Utilities ─────────────────────────────────────────────────────────

  /** Decode base64 to Uint8Array (chunked — one giant atob() is slow). */
  function base64ToBytes(b64) {
    const CHUNK = 1 << 20; // 1 MiB of base64 → 768 KiB binary
    const parts = [];
    let total = 0;
    for (let i = 0; i < b64.length; i += CHUNK) {
      const bin = atob(b64.slice(i, i + CHUNK));
      const u8 = new Uint8Array(bin.length);
      for (let j = 0; j < bin.length; j++) u8[j] = bin.charCodeAt(j);
      parts.push(u8);
      total += u8.length;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  /** Yield to the event loop so the UI can paint a status update. */
  const tick = () => new Promise((r) => setTimeout(r, 0));

  // ── file:// asset access ──────────────────────────────────────────────

  /** Model bytes from the embedded base64 bundle (file:// only). */
  async function getModelBytes() {
    if (!modelBytesPromise) {
      modelBytesPromise = (async () => {
        if (!window.DEPTH_MODEL_B64) throw new Error('models/model-bundle.js not loaded');
        await tick(); // let "Loading model…" paint before the decode jank
        return base64ToBytes(window.DEPTH_MODEL_B64).buffer;
      })();
    }
    return modelBytesPromise;
  }

  /**
   * Blob-import an inlined loader module from its generated source string.
   * Blob URLs work under file://; relative import() does not.
   */
  const loaderUrls = new Map();
  function getLoaderUrl(srcVar) {
    if (!loaderUrls.has(srcVar)) {
      const src = window[srcVar];
      if (!src) throw new Error(srcVar + ' not loaded (generated bundle missing)');
      loaderUrls.set(srcVar, URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    }
    return loaderUrls.get(srcVar);
  }

  // ── ONNX Runtime configuration ────────────────────────────────────────

  /**
   * Configure ORT's wasmPaths for the current protocol. On file:// we can't
   * fetch() anything, so both the loader module and the .wasm binary come
   * from the embedded bundles.
   *
   * @param {boolean} useJsep  true → WebGPU-capable (jsep) build;
   *                           false → plain single-thread WASM build.
   */
  function configureOrt(useJsep) {
    if (IS_FILE) {
      // file:// constraints: no fetch() (so the model + wasm must come from
      // the embedded base64 bundles), no module import() of local files (so
      // the loader module is blob-imported), and no SharedArrayBuffer/
      // workers (so single-threaded, plain WASM — WebGPU's jsep build and
      // ORT's worker bootstrap are unavailable). ORT's backend init is also
      // sticky-fail per page, so we go straight to the one backend that
      // works here instead of trying WebGPU first.
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.wasmPaths = { mjs: getLoaderUrl('ORT_ST_LOADER_SRC') };
      // Supplying the binary directly avoids all file-path resolution.
      ort.env.wasm.wasmBinary = base64ToBytes(window.ORT_WASM_ST_B64);
    } else {
      // http://: stream binaries straight from disk. The loader module uses
      // a .mjs.js name because simple static servers (e.g. Python
      // http.server on Windows) serve .mjs as text/plain, which browsers
      // reject for module scripts.
      const lib = new URL('lib/', window.location.href).href;
      ort.env.wasm.wasmPaths = {
        mjs: lib + (useJsep ? 'ort-wasm-simd-threaded.jsep.mjs.js' : 'ort-wasm-simd-threaded.mjs.js'),
        wasm: lib + (useJsep ? 'ort-wasm-simd-threaded.jsep.wasm' : 'ort-wasm-simd-threaded.wasm'),
      };
      ort.env.wasm.numThreads = useJsep
        ? Math.min(4, navigator.hardwareConcurrency || 1)
        : 1;
      if (typeof SharedArrayBuffer === 'undefined') ort.env.wasm.numThreads = 1;
    }
  }

  async function createSession() {
    // On file:// the model must come from the embedded bundle (ArrayBuffer
    // input); on http:// ORT streams it from disk by URL.
    const source = IS_FILE ? await getModelBytes() : MODEL_URL;

    // Backend choice: http:// prefers WebGPU (fast) with WASM fallback;
    // file:// goes straight to single-thread WASM (see configureOrt).
    const attempts = [];
    if (!IS_FILE && navigator.gpu) attempts.push({ providers: ['webgpu', 'wasm'], jsep: true });
    attempts.push({ providers: ['wasm'], jsep: false });

    let lastErr = null;
    for (const { providers, jsep } of attempts) {
      try {
        configureOrt(jsep);
        const session = await ort.InferenceSession.create(source, {
          executionProviders: providers,
          graphOptimizationLevel: 'all',
        });
        activeProvider = providers[0];
        return session;
      } catch (err) {
        lastErr = err;
        console.warn('AI depth: backend attempt failed (' + providers[0] + '):', err);
      }
    }
    throw lastErr || new Error('Could not initialize ONNX Runtime');
  }

  /** Lazily create (and memoize) the inference session. */
  function getSession() {
    if (!sessionPromise) {
      sessionPromise = createSession().catch((err) => {
        sessionPromise = null; // allow retry on next call
        throw err;
      });
    }
    return sessionPromise;
  }

  /**
   * Preprocess: draw the image into 518×518, convert to normalized CHW
   * float32 (ImageNet mean/std).
   *
   * fit=false (coin): cover-fit centered — matches the cover-fit depth grid.
   * fit=true  (plaque): stretch the whole image onto the square — matches the
   * fit (no-crop) rectangular depth grid, so AI depth aligns 1:1 with it.
   */
  function preprocess(image, fit) {
    const s = INPUT_SIZE;
    const canvas = document.createElement('canvas');
    canvas.width = s;
    canvas.height = s;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const iw = image.naturalWidth || image.width;
    const ih = image.naturalHeight || image.height;
    if (fit) {
      ctx.drawImage(image, 0, 0, s, s); // whole image, stretched to the square
    } else {
      const scale = Math.max(s / iw, s / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      ctx.drawImage(image, (s - dw) / 2, (s - dh) / 2, dw, dh);
    }

    const rgba = ctx.getImageData(0, 0, s, s).data;
    const chw = new Float32Array(3 * s * s);
    const plane = s * s;
    for (let i = 0; i < plane; i++) {
      chw[i]             = (rgba[i * 4]     / 255 - MEAN[0]) / STD[0];
      chw[plane + i]     = (rgba[i * 4 + 1] / 255 - MEAN[1]) / STD[1];
      chw[2 * plane + i] = (rgba[i * 4 + 2] / 255 - MEAN[2]) / STD[2];
    }
    return chw;
  }

  /** Min-max normalize to 0..1 (near = high, as the model outputs). */
  function normalize(data) {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < data.length; i++) {
      if (data[i] < min) min = data[i];
      if (data[i] > max) max = data[i];
    }
    const range = max - min || 1;
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = (data[i] - min) / range;
    return out;
  }

  /**
   * Run object-aware depth estimation for an image element.
   * Results are cached per image element — sliders that only change the
   * post-processing never re-run the network.
   *
   * @param {HTMLImageElement} image
   * @returns {Promise<{data: Float32Array, size: number}>} depth 0..1,
   *          518×518, near = high (raised).
   */
  async function estimate(image, fit = false) {
    const cacheKey = fit ? '_fit' : '_cover';
    let perMode = resultCache.get(image);
    if (perMode && perMode[cacheKey]) return perMode[cacheKey];

    const promise = enqueue(async () => {
      const session = await getSession();
      const chw = preprocess(image, fit);
      const inputName = session.inputNames[0];
      const outputName = session.outputNames[0];
      const tensor = new ort.Tensor('float32', chw, [1, 3, INPUT_SIZE, INPUT_SIZE]);
      const results = await session.run({ [inputName]: tensor });
      const out = results[outputName];
      // Output is [1, H, W] (or [1, 1, H, W]); H = W = INPUT_SIZE.
      const dims = out.dims;
      const h = dims[dims.length - 2];
      const w = dims[dims.length - 1];
      const depth = normalize(out.data);
      return { data: depth, size: w, height: h };
    });

    if (!perMode) { perMode = {}; resultCache.set(image, perMode); }
    perMode[cacheKey] = promise;
    promise.catch(() => { delete perMode[cacheKey]; }); // don't cache failures
    return promise;
  }

  /** Whether a result for this image is already computed/in flight. */
  function isCached(image, fit = false) {
    const perMode = resultCache.get(image);
    return !!(perMode && perMode[fit ? '_fit' : '_cover']);
  }

  function provider() {
    return activeProvider;
  }

  return { estimate, isCached, provider, INPUT_SIZE };
})();
