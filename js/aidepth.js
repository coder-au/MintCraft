/**
 * aidepth.js — object-aware monocular depth estimation, fully local.
 *
 * Runs Depth Anything V2 Small (quantized ONNX, ~26 MB, vendored in /models)
 * through ONNX Runtime Web (vendored in /lib). Prefers the WebGPU execution
 * provider, falls back to multi-threaded WASM automatically.
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
  // ImageNet normalization used by Depth Anything.
  const MEAN = [0.485, 0.456, 0.406];
  const STD = [0.229, 0.224, 0.225];

  let sessionPromise = null;         // lazy singleton
  let activeProvider = null;         // 'webgpu' | 'wasm' once created

  /** Cache: per-image inference results keyed by a WeakMap on the element. */
  const resultCache = new WeakMap();

  function configureOrt() {
    // All runtime artifacts are vendored — never fetch from a CDN.
    // Fully-qualified URLs are required (ORT dynamic-imports the loader).
    // The loader module uses a .mjs.js name: many simple static servers
    // (e.g. Python http.server on Windows) serve .mjs as text/plain, which
    // browsers reject for module scripts under strict MIME checking.
    const lib = new URL('lib/', window.location.href).href;
    const hasWebGPU = !!navigator.gpu;
    ort.env.wasm.wasmPaths = {
      mjs: lib + (hasWebGPU ? 'ort-wasm-simd-threaded.jsep.mjs.js' : 'ort-wasm-simd-threaded.mjs.js'),
      wasm: lib + (hasWebGPU ? 'ort-wasm-simd-threaded.jsep.wasm' : 'ort-wasm-simd-threaded.wasm'),
    };
    ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 1);
    // SharedArrayBuffer needs cross-origin isolation; degrade gracefully.
    if (typeof SharedArrayBuffer === 'undefined') ort.env.wasm.numThreads = 1;
  }

  async function createSession() {
    configureOrt();
    const attempts = [];
    if (navigator.gpu) attempts.push(['webgpu', 'wasm']); // webgpu w/ wasm fallback ops
    attempts.push(['wasm']);

    let lastErr = null;
    for (const providers of attempts) {
      try {
        const session = await ort.InferenceSession.create(MODEL_URL, {
          executionProviders: providers,
          graphOptimizationLevel: 'all',
        });
        activeProvider = providers[0];
        return session;
      } catch (err) {
        lastErr = err;
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
   * Preprocess: draw the image square-cover into 518×518, convert to
   * normalized CHW float32 (ImageNet mean/std).
   */
  function preprocess(image) {
    const s = INPUT_SIZE;
    const canvas = document.createElement('canvas');
    canvas.width = s;
    canvas.height = s;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // Cover-fit centered — matches how the depth grid crops the source, so
    // the AI depth aligns 1:1 with the luminance path.
    const iw = image.naturalWidth || image.width;
    const ih = image.naturalHeight || image.height;
    const scale = Math.max(s / iw, s / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    ctx.drawImage(image, (s - dw) / 2, (s - dh) / 2, dw, dh);

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
  async function estimate(image) {
    const cached = resultCache.get(image);
    if (cached) return cached;

    const promise = (async () => {
      const session = await getSession();
      const chw = preprocess(image);
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
    })();

    resultCache.set(image, promise);
    promise.catch(() => resultCache.delete(image)); // don't cache failures
    return promise;
  }

  /** Whether a result for this image is already computed/in flight. */
  function isCached(image) {
    return resultCache.has(image);
  }

  function provider() {
    return activeProvider;
  }

  return { estimate, isCached, provider, INPUT_SIZE };
})();
