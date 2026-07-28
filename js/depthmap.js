/**
 * depthmap.js — image → depth-map conversion utilities.
 *
 * Pipeline:  draw image (cover-fit, centered) → luminance → brightness/contrast
 *            → optional invert → optional Gaussian blur (separable, two-pass).
 * Also provides emboss-style relief shading used by the 2D previews.
 *
 * Classic script: exposes window.DepthMap so the app works when index.html
 * is opened directly from the file system (no module/CORS restrictions).
 */

window.DepthMap = window.DepthMap || {};

/** Load an image from a File/Blob. @returns {Promise<HTMLImageElement>} */
DepthMap.loadImageFromFile = function (file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode image')); };
    img.src = url;
  });
}

/** Standard 1-D Gaussian kernel. */
function gaussianKernel(sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  return { kernel, radius };
}

/** Two-pass separable Gaussian blur on a Float32Array of size w*h. */
DepthMap.gaussianBlur = function (data, w, h, sigma) {
  if (sigma <= 0) return data;
  const { kernel, radius } = gaussianKernel(sigma);
  const tmp = new Float32Array(data.length);
  const out = new Float32Array(data.length);

  // Horizontal pass
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const sx = Math.min(w - 1, Math.max(0, x + k)); // clamp-to-edge
        acc += data[row + sx] * kernel[k + radius];
      }
      tmp[row + x] = acc;
    }
  }
  // Vertical pass
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const sy = Math.min(h - 1, Math.max(0, y + k));
        acc += tmp[sy * w + x] * kernel[k + radius];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

/**
 * Edge-preserving bilateral filter on a normalized Float32Array (values 0..1).
 * Smooths flat noisy regions while keeping genuine relief edges crisp —
 * unlike a Gaussian, weights fall off with *range* (value) difference too.
 *
 * @param {Float32Array} data
 * @param {number} w
 * @param {number} h
 * @param {number} sigmaSpatial  Spatial Gaussian sigma (px) — window size.
 * @param {number} sigmaRange    Range sigma (0..1) — edge sensitivity. Smaller
 *                               = preserves finer edges; larger = smoother.
 */
DepthMap.bilateralFilter = function (data, w, h, sigmaSpatial, sigmaRange) {
  if (sigmaSpatial <= 0) return data;
  const radius = Math.max(1, Math.ceil(sigmaSpatial * 2));
  const spatial = new Float32Array(radius * 2 + 1);
  const twoSs = 2 * sigmaSpatial * sigmaSpatial;
  for (let k = -radius; k <= radius; k++) spatial[k + radius] = Math.exp(-(k * k) / twoSs);

  const sr = Math.max(0.01, sigmaRange);
  const twoRs = 2 * sr * sr;
  // Precompute range-weight LUT over the 0..1 value domain (256 steps).
  const LUT = 256;
  const rangeW = new Float32Array(LUT);
  for (let i = 0; i < LUT; i++) {
    const d = i / (LUT - 1);
    rangeW[i] = Math.exp(-(d * d) / twoRs);
  }

  const out = new Float32Array(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const center = data[y * w + x];
      let wsum = 0, acc = 0;
      for (let ky = -radius; ky <= radius; ky++) {
        const sy = Math.min(h - 1, Math.max(0, y + ky));
        const wy = spatial[ky + radius];
        for (let kx = -radius; kx <= radius; kx++) {
          const sx = Math.min(w - 1, Math.max(0, x + kx));
          const v = data[sy * w + sx];
          const rw = rangeW[Math.min(LUT - 1, (Math.abs(v - center) * (LUT - 1)) | 0)];
          const weight = wy * spatial[kx + radius] * rw;
          acc += v * weight;
          wsum += weight;
        }
      }
      out[y * w + x] = wsum > 0 ? acc / wsum : center;
    }
  }
  return out;
}

/**
 * 3×3 median filter — removes salt-and-pepper / speckle noise without the
 * edge-smearing of a mean filter.
 */
DepthMap.medianFilter3x3 = function (data, w, h) {
  const out = new Float32Array(data.length);
  const win = new Float32Array(9);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let ky = -1; ky <= 1; ky++) {
        const sy = Math.min(h - 1, Math.max(0, y + ky));
        for (let kx = -1; kx <= 1; kx++) {
          const sx = Math.min(w - 1, Math.max(0, x + kx));
          win[n++] = data[sy * w + sx];
        }
      }
      // partial sort to the median (5th of 9)
      for (let i = 0; i < 5; i++) {
        let m = i;
        for (let j = i + 1; j < 9; j++) if (win[j] < win[m]) m = j;
        const tmp = win[i]; win[i] = win[m]; win[m] = tmp;
      }
      out[y * w + x] = win[4];
    }
  }
  return out;
}

/**
 * Histogram stretch: remap the used [pLow..pHigh] percentile range of the
 * depth values to the full 0..1 range. Low-contrast sources then produce
 * full-height relief without cranking contrast (which amplifies noise).
 * Percentiles avoid being skewed by a few outlier pixels.
 */
DepthMap.normalizeDepth = function (data, pLow = 2, pHigh = 98) {
  const hist = new Int32Array(256);
  for (let i = 0; i < data.length; i++) {
    hist[Math.min(255, Math.max(0, (data[i] * 255) | 0))]++;
  }
  const total = data.length;
  const lowCut = (pLow / 100) * total;
  const highCut = (pHigh / 100) * total;
  let acc = 0, lo = 0, hi = 255;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= lowCut) { lo = i; break; } }
  acc = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= highCut) { hi = i; break; } }
  const span = Math.max(1, hi - lo);
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = Math.min(1, Math.max(0, (data[i] * 255 - lo) / span));
  }
  return out;
}

/** Bilinear downsample of a Float32Array grid to a smaller size. */
DepthMap.downsample = function (data, srcSize, dstSize) {
  if (dstSize >= srcSize) return data;
  const out = new Float32Array(dstSize * dstSize);
  const scale = srcSize / dstSize;
  for (let y = 0; y < dstSize; y++) {
    for (let x = 0; x < dstSize; x++) {
      const fx = (x + 0.5) * scale - 0.5;
      const fy = (y + 0.5) * scale - 0.5;
      const x0 = Math.max(0, Math.floor(fx));
      const y0 = Math.max(0, Math.floor(fy));
      const x1 = Math.min(srcSize - 1, x0 + 1);
      const y1 = Math.min(srcSize - 1, y0 + 1);
      const tx = Math.min(1, Math.max(0, fx - x0));
      const ty = Math.min(1, Math.max(0, fy - y0));
      const a = data[y0 * srcSize + x0], b = data[y0 * srcSize + x1];
      const c = data[y1 * srcSize + x0], d = data[y1 * srcSize + x1];
      out[y * dstSize + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  return out;
}

/** Bilinear upsample of a Float32Array grid to a larger size. */
DepthMap.upsample = function (data, srcSize, dstSize) {
  if (dstSize <= srcSize) return data;
  const out = new Float32Array(dstSize * dstSize);
  const scale = srcSize / dstSize;
  for (let y = 0; y < dstSize; y++) {
    for (let x = 0; x < dstSize; x++) {
      const fx = (x + 0.5) * scale - 0.5;
      const fy = (y + 0.5) * scale - 0.5;
      const x0 = Math.max(0, Math.floor(fx));
      const y0 = Math.max(0, Math.floor(fy));
      const x1 = Math.min(srcSize - 1, x0 + 1);
      const y1 = Math.min(srcSize - 1, y0 + 1);
      const tx = Math.min(1, Math.max(0, fx - x0));
      const ty = Math.min(1, Math.max(0, fy - y0));
      const a = data[y0 * srcSize + x0], b = data[y0 * srcSize + x1];
      const c = data[y1 * srcSize + x0], d = data[y1 * srcSize + x1];
      out[y * dstSize + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  return out;
}

/**
 * Bilinear resample of a rectangular grid to another rectangle.
 * @returns {Float32Array}
 */
function resampleRect(data, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  const sx = sw / dw, sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const fy = (y + 0.5) * sy - 0.5;
    const y0 = Math.max(0, Math.floor(fy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = Math.min(1, Math.max(0, fy - y0));
    for (let x = 0; x < dw; x++) {
      const fx = (x + 0.5) * sx - 0.5;
      const x0 = Math.max(0, Math.floor(fx));
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = Math.min(1, Math.max(0, fx - x0));
      const a = data[y0 * sw + x0], b = data[y0 * sw + x1];
      const c = data[y1 * sw + x0], d = data[y1 * sw + x1];
      out[y * dw + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  return out;
}

/** Downsample a rectangular grid so its long edge ≈ maxEdge. Returns {data,width,height}. */
DepthMap.downsampleRect = function (data, w, h, maxEdge) {
  const long = Math.max(w, h);
  if (long <= maxEdge) return { data, width: w, height: h };
  const s = maxEdge / long;
  const dw = Math.max(2, Math.round(w * s));
  const dh = Math.max(2, Math.round(h * s));
  return { data: resampleRect(data, w, h, dw, dh), width: dw, height: dh };
}

/** Upsample a rectangular grid to a target width/height. */
DepthMap.upsampleRect = function (data, sw, sh, dw, dh) {
  return resampleRect(data, sw, sh, dw, dh);
}

/**
 * Resample an AI depth grid (cover-fit square of the *untransformed* image)
 * into the coin depth grid, applying the same user transform (scale, offset,
 * rotation) that `imageToDepthMap` applies when drawing the source image —
 * so the AI depth aligns 1:1 with the luminance path.
 *
 * Mapping: because both grids are cover-fits of the same image, a depth-grid
 * pixel maps into the AI grid with a plain rotate + uniform scale of
 * (aiSize / dstSize) / tScale about the grid centres. Samples that fall
 * outside the AI grid are treated as far (0).
 *
 * @param {Float32Array} ai      AI depth values (aiSize × aiSize, 0..1).
 * @param {number} aiSize        AI grid resolution.
 * @param {number} dstW          Destination grid width.
 * @param {number} dstH          Destination grid height (defaults to dstW).
 * @param {object} t             { scale, ox, oy, rot } user transform.
 * @returns {Float32Array} dstW × dstH
 */
DepthMap.resampleAIDepth = function (ai, aiSize, dstW, dstH, t, fit) {
  t = t || {};
  const tScale = t.scale != null ? t.scale : 1;
  const tOx = t.ox || 0;
  const tOy = t.oy || 0;
  const tRot = ((t.rot || 0) * Math.PI) / 180;
  const cos = Math.cos(-tRot);
  const sin = Math.sin(-tRot);
  const dstSize = Math.max(dstW, dstH);
  const k = (aiSize / dstSize) / Math.max(0.01, tScale);
  const halfW = dstW / 2, halfH = dstH / 2;
  const aiHalf = aiSize / 2;

  const out = new Float32Array(dstW * dstH);
  for (let y = 0; y < dstH; y++) {
    const dy = y - halfH - tOy;
    for (let x = 0; x < dstW; x++) {
      const dx = x - halfW - tOx;
      let u, v;
      if (fit) {
        // Fit mode: the AI grid spans the whole (uncropped) image, so map the
        // destination pixel by normalized position — no cover-fit scale/crop.
        const nu = (dx * cos - dy * sin) / (tScale * dstW);
        const nv = (dx * sin + dy * cos) / (tScale * dstH);
        u = aiHalf + nu * aiSize;
        v = aiHalf + nv * aiSize;
      } else {
        // Cover mode: undo rotation, then scale into the cover-fit AI grid.
        u = aiHalf + (dx * cos - dy * sin) * k;
        v = aiHalf + (dx * sin + dy * cos) * k;
      }
      if (u < 0 || v < 0 || u > aiSize - 1 || v > aiSize - 1) continue; // far
      // Bilinear sample.
      const x0 = Math.floor(u), y0 = Math.floor(v);
      const x1 = Math.min(aiSize - 1, x0 + 1);
      const y1 = Math.min(aiSize - 1, y0 + 1);
      const fx = u - x0, fy = v - y0;
      const a = ai[y0 * aiSize + x0], b = ai[y0 * aiSize + x1];
      const c = ai[y1 * aiSize + x0], d = ai[y1 * aiSize + x1];
      out[y * dstW + x] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return out;
}

/**
 * Convert an image into a normalized depth map.
 *
 * The image is drawn "cover"-fit (scaled to fill, centered, cropped) into a
 * square grid so it maps cleanly onto the circular coin face.
 *
 * @param {HTMLImageElement|HTMLCanvasElement} image
 * @param {object} opts
 * @param {number} opts.size        Grid resolution (size × size).
 * Pipeline (noise-aware ordering):
 *   draw (cover-fit) → luminance → median (denoise) → smoothing
 *   (gaussian | bilateral edge-preserving) → optional histogram normalize →
 *   brightness/contrast/gamma → invert.
 * Smoothing runs *before* contrast so contrast doesn't amplify noise, and
 * the default bilateral mode cleans noise while preserving relief edges.
 *
 * @param {number} opts.brightness  -100..100
 * @param {number} opts.contrast    -100..100
 * @param {boolean} opts.invert     Invert depth (dark = raised).
 * @param {number} opts.blurSigma   Smoothing strength (px) — 0 = off.
 * @param {string} [opts.smoothMode] 'gaussian' | 'bilateral' (default).
 * @param {number} [opts.edgePreserve] Bilateral range sensitivity 1..100
 *        (maps to range sigma 0.01..0.5). Higher = preserve finer edges.
 * @param {boolean} [opts.normalize]  Histogram-stretch depth to full range.
 * @param {number} [opts.gamma]       Mid-tone curve (default 1).
 * @param {object} [opts.transform] Image placement against the coin:
 *        { scale (multiplier, 1 = 100%), ox (px), oy (px), rot (degrees) }.
 * @param {string} [opts.depthSource] 'luminance' (default) | 'ai' | 'hybrid'.
 * @param {{data: Float32Array, size: number}} [opts.aiDepth] Object-aware
 *        depth from AIDepth.estimate() (cover-fit of the raw image). Required
 *        for 'ai' and 'hybrid' sources.
 * @param {number} [opts.aiDetail] Hybrid only: how much high-frequency
 *        luminance detail to engrave on top of the AI base shape (0..1).
 * @param {number} [opts.fitAspect] When > 0, the grid is rectangular with
 *        this width/height aspect (matching the source image) and the image
 *        is *fit* (not cropped) so nothing is clipped. Used for plaques.
 * @returns {{ data: Float32Array, size: number, width: number, height: number }}
 *        depth values in [0,1]; width/height equal size unless fitAspect is set.
 */
DepthMap.imageToDepthMap = function (image, opts) {
  const {
    size,
    brightness = 0,
    contrast = 0,
    invert = false,
    blurSigma = 0,
    smoothMode = 'bilateral',
    edgePreserve = 40,
    normalize = false,
    gamma = 1,
    depthSource = 'luminance',
    aiDepth = null,
    aiDetail = 0.25,
    fitAspect = 0,
  } = opts;
  const t = opts.transform || {};
  const tScale = t.scale != null ? t.scale : 1;
  const tOx = t.ox || 0;
  const tOy = t.oy || 0;
  const tRot = ((t.rot || 0) * Math.PI) / 180;

  // Grid resolution: square for coins, image-aspect rectangle for plaques.
  let W = size, H = size;
  if (fitAspect > 0) {
    if (fitAspect >= 1) { W = size; H = Math.max(2, Math.round(size / fitAspect)); }
    else { H = size; W = Math.max(2, Math.round(size * fitAspect)); }
  }

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;
  // fitAspect: the grid already matches the image aspect, so a plain fill
  // draws the whole image with no crop. Otherwise cover-fit (crop overflow).
  const scale = fitAspect > 0
    ? Math.max(W / iw, H / ih)
    : Math.max(size / iw, size / ih);
  const dw = iw * scale * tScale;
  const dh = ih * scale * tScale;

  // Draw centered, then apply the user's translate + rotate about the centre.
  ctx.save();
  ctx.translate(W / 2 + tOx, H / 2 + tOy);
  ctx.rotate(tRot);
  ctx.drawImage(image, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();

  const pixels = ctx.getImageData(0, 0, W, H).data;

  // 1) Base depth signal.
  //    'luminance' — Rec. 601 luminance (bright = raised). Classic.
  //    'ai'        — object-aware scene depth (near = raised) from the model.
  //    'hybrid'    — AI base shape + high-pass luminance detail on top.
  let depth = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const r = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const b = pixels[i * 4 + 2];
    depth[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  const useAI = (depthSource === 'ai' || depthSource === 'hybrid') && aiDepth && aiDepth.data;
  if (useAI) {
    const aiGrid = DepthMap.resampleAIDepth(aiDepth.data, aiDepth.size, W, H, {
      scale: tScale, ox: tOx, oy: tOy, rot: t.rot || 0,
    }, fitAspect > 0);
    if (depthSource === 'ai') {
      depth = aiGrid;
    } else {
      // Hybrid: AI macro shape + high-frequency luminance detail.
      // High-pass = luminance − low-pass(luminance), computed on a small
      // working grid for speed (detail extraction is scale-tolerant).
      const HP_WORK = 512;
      const hpSigma = 6; // px at HP_WORK — splits "shape" from "engraving"
      let lp;
      if (Math.max(W, H) > HP_WORK) {
        const smallLum = DepthMap.downsampleRect(depth, W, H, HP_WORK);
        const sw = smallLum.width, sh = smallLum.height;
        lp = DepthMap.upsampleRect(
          DepthMap.gaussianBlur(smallLum.data, sw, sh, hpSigma), sw, sh, W, H);
      } else {
        lp = DepthMap.gaussianBlur(depth, W, H, hpSigma * (Math.max(W, H) / HP_WORK));
      }
      const amt = Math.min(1, Math.max(0, aiDetail));
      for (let i = 0; i < depth.length; i++) {
        const hi = depth[i] - lp[i]; // signed detail, roughly -0.5..0.5
        let v = aiGrid[i] + hi * amt;
        depth[i] = v < 0 ? 0 : v > 1 ? 1 : v;
      }
    }
  }

  // 2+3) Denoise + smoothing run on a capped working grid (≤ WORK on the long
  //      edge) so the expensive per-pixel filters stay fast at full
  //      resolution, then the result is upsampled back.
  const WORK = 512;
  const needSmooth = blurSigma > 0;
  if (needSmooth && Math.max(W, H) > WORK) {
    const scaledSigma = blurSigma * (WORK / Math.max(W, H));
    let w = DepthMap.downsampleRect(depth, W, H, WORK);
    const sw = w.width, sh = w.height;
    let wd = DepthMap.medianFilter3x3(w.data, sw, sh);
    if (smoothMode === 'gaussian') {
      wd = DepthMap.gaussianBlur(wd, sw, sh, scaledSigma);
    } else {
      const rangeSigma = 0.5 - (Math.min(100, Math.max(1, edgePreserve)) / 100) * 0.49;
      wd = DepthMap.bilateralFilter(wd, sw, sh, Math.max(0.5, scaledSigma), rangeSigma);
    }
    const smoothed = DepthMap.upsampleRect(wd, sw, sh, W, H);
    // Blend: keep full-res detail but apply the low-frequency smoothing.
    for (let i = 0; i < depth.length; i++) depth[i] = smoothed[i];
  } else if (needSmooth) {
    depth = DepthMap.medianFilter3x3(depth, W, H);
    if (smoothMode === 'gaussian') {
      depth = DepthMap.gaussianBlur(depth, W, H, blurSigma);
    } else {
      const rangeSigma = 0.5 - (Math.min(100, Math.max(1, edgePreserve)) / 100) * 0.49;
      depth = DepthMap.bilateralFilter(depth, W, H, blurSigma, rangeSigma);
    }
  } else {
    // No smoothing: still apply a light median to kill speckle, at full res.
    depth = DepthMap.medianFilter3x3(depth, W, H);
  }

  // 4) Histogram stretch to full range (helps low-contrast sources).
  if (normalize) {
    depth = DepthMap.normalizeDepth(depth);
  }

  // 5) Brightness / contrast / gamma — now safe, noise already suppressed.
  const bright = brightness * 2.55;                       // → -255..255
  const c = Math.max(-100, Math.min(100, contrast));
  const factor = (259 * (c + 255)) / (255 * (259 - c));   // standard contrast curve
  const g = Math.max(0.1, gamma);

  for (let i = 0; i < depth.length; i++) {
    let v = depth[i] * 255;
    v = factor * (v - 128) + 128 + bright;
    v = Math.min(255, Math.max(0, v));
    v = 255 * Math.pow(v / 255, g);
    depth[i] = v / 255;
  }

  // 6) Invert (engrave vs relief).
  if (invert) {
    for (let i = 0; i < depth.length; i++) depth[i] = 1 - depth[i];
  }

  return { data: depth, size: Math.max(W, H), width: W, height: H };
}

/**
 * Render a coin face (2D top-down) onto a canvas.
 *
 * Draws a metallic disc; where a depth map exists it is emboss-shaded with a
 * fixed key light (or drawn as a raw grayscale depth map for inspection).
 *
 * @param {HTMLCanvasElement} canvas   Target canvas (square).
 * @param {Float32Array|null} depth    Normalized depth values, or null.
 * @param {number} gridSize            Resolution of the depth grid.
 * @param {object} opts
 * @param {boolean} opts.showDepthMap  Draw raw depth map instead of relief.
 * @param {number}  opts.relief        Relief strength for the shading.
 */
DepthMap.renderCoinFace2D = function (canvas, depth, gridSize, opts = {}) {
  const {
    showDepthMap = false, relief = 2, edgeFrac = 0, tint = [219, 176, 96],
    shape = 'coin', aspect = 1, gridW = 0, gridH = 0,
  } = opts;
  // Rectangular depth grids (plaques) carry their own dims; square otherwise.
  const gW = gridW || gridSize;
  const gH = gridH || gridSize;
  const [tintR, tintG, tintB] = tint;
  const size = canvas.width;
  const ctx = canvas.getContext('2d');
  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2;
  // The raised edge is a display/embossing concept, not part of the depth map
  // itself — suppress it in the raw depth-map view.
  const edgePx = showDepthMap ? 0 : edgeFrac * radius;

  // Plaque: rectangle footprint (aspect = width/height) fit to the square.
  const rectHW = aspect >= 1 ? cx : cx * aspect; // half-width in px
  const rectHH = aspect >= 1 ? cy / aspect : cy; // half-height in px

  // Inside-object test. Coin = disc, plaque = rectangle.
  const inside = shape === 'rect'
    ? (dx, dy) => Math.abs(dx) <= rectHW && Math.abs(dy) <= rectHH
    : (dx, dy) => Math.sqrt(dx * dx + dy * dy) <= radius;

  // The depth grid may be non-square (fit to the image). For a coin's square
  // face, center-crop it: the face samples the central square of the grid.
  // For a plaque the grid is already the rectangle's aspect → sample directly.
  const cropX0 = shape === 'coin' ? (gW - Math.min(gW, gH)) / 2 : 0;
  const cropY0 = shape === 'coin' ? (gH - Math.min(gW, gH)) / 2 : 0;
  const cropW = shape === 'coin' ? Math.min(gW, gH) : gW;
  const cropH = shape === 'coin' ? Math.min(gW, gH) : gH;

  // Hard rim-band mask: image relief applies only within the inner face; the
  // outer band is a full-height raised edge at 90° to the face, so the image
  // never affects the edge (matches the 3D preview). Coin only.
  const applyEdge = (d, dist) => {
    if (edgePx <= 0 || shape !== 'coin') return d;
    return dist < radius - edgePx ? d : 1.0;
  };

  const img = ctx.createImageData(size, size);
  const px = img.data;

  // Emboss light direction (upper-left).
  const L = { x: -0.55, y: -0.62, z: 0.62 };
  const strength = 14 * (relief / 2); // depth gradient → normal scale

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const idx = (y * size + x) * 4;

      if (!inside(dx, dy)) {
        px[idx + 3] = 0; // transparent outside the object
        continue;
      }

      // Sample depth grid with true bilinear interpolation (removes blockiness).
      let d = 0.5, gxGrad = 0, gyGrad = 0;
      if (depth) {
        // Normalized position within the sampled region (rect = whole grid,
        // coin = center-cropped square of the grid).
        const u = shape === 'rect' ? (dx + rectHW) / (2 * rectHW) : x / size;
        const w = shape === 'rect' ? (dy + rectHH) / (2 * rectHH) : y / size;
        // Map into the sampled grid region (coin: center-cropped square).
        const gx = cropX0 + u * (cropW - 1);
        const gy = cropY0 + w * (cropH - 1);
        const x0 = Math.min(gW - 1, Math.max(0, Math.floor(gx)));
        const y0 = Math.min(gH - 1, Math.max(0, Math.floor(gy)));
        const x1 = Math.min(gW - 1, x0 + 1);
        const y1 = Math.min(gH - 1, y0 + 1);
        const tx = Math.min(1, Math.max(0, gx - x0));
        const ty = Math.min(1, Math.max(0, gy - y0));

        const s00 = depth[y0 * gW + x0];
        const s10 = depth[y0 * gW + x1];
        const s01 = depth[y1 * gW + x0];
        const s11 = depth[y1 * gW + x1];

        d = (s00 * (1 - tx) + s10 * tx) * (1 - ty) + (s01 * (1 - tx) + s11 * tx) * ty;

        // Gradient of the bilinear surface (for smooth shading normals).
        gxGrad = ((s10 - s00) * (1 - ty) + (s11 - s01) * ty);
        gyGrad = ((s01 - s00) * (1 - tx) + (s11 - s10) * tx);
      }

      // Apply the raised-edge mask to the height value.
      d = applyEdge(d, dist);

      if (showDepthMap && depth) {
        const v = Math.round(d * 255);
        px[idx] = v; px[idx + 1] = v; px[idx + 2] = v; px[idx + 3] = 255;
        continue;
      }

      // Surface normal from the bilinear depth gradient.
      gxGrad *= strength;
      gyGrad *= strength;
      let nx = -gxGrad, ny = -gyGrad, nz = 1;
      const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= nLen; ny /= nLen; nz /= nLen;

      const diffuse = Math.max(0, nx * L.x + ny * L.y + nz * L.z);

      // Cheap specular (half-vector against a fixed view dir of +Z).
      const hx = L.x, hy = L.y, hz = L.z + 1;
      const hLen = Math.sqrt(hx * hx + hy * hy + hz * hz);
      const ndh = Math.max(0, nx * (hx / hLen) + ny * (hy / hLen) + nz * (hz / hLen));
      const spec = Math.pow(ndh, 28) * 0.55;

      // Base metal tint, modulated by depth so relief reads well.
      const base = 0.62 + 0.28 * d;
      const shade = 0.35 + 0.65 * diffuse;
      let r = tintR * base * shade + 255 * spec;
      let g = tintG * base * shade + 255 * spec;
      let b = tintB * base * shade + 255 * spec;

      // Darken rim edge slightly for a raised-border feel.
      const edge = radius - dist;
      if (edge < 3) {
        const f = edge / 3;
        r *= 0.75 + 0.25 * f; g *= 0.75 + 0.25 * f; b *= 0.75 + 0.25 * f;
      }

      px[idx]     = Math.min(255, r);
      px[idx + 1] = Math.min(255, g);
      px[idx + 2] = Math.min(255, b);
      px[idx + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
}

/**
 * Draw the source image cover-fit (centered, cropped) into a square canvas —
 * the same placement the depth grid uses, so it lines up with the depth and
 * final-result 2D panels. Clears to a dark panel when there is no image.
 */
DepthMap.renderSourceImage = function (canvas, image, gridSize, opts = {}) {
  const { fit = false } = opts;
  const size = canvas.width;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  if (!image) {
    ctx.fillStyle = '#0a0d12';
    ctx.fillRect(0, 0, size, size);
    return;
  }
  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;
  // fit: whole image visible (letterbox) — matches the plaque's no-crop depth
  // grid. cover: fill the square (coin) — matches its cover-fit depth grid.
  const scale = fit ? Math.min(size / iw, size / ih) : Math.max(size / iw, size / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, (size - dw) / 2, (size - dh) / 2, dw, dh);
}
