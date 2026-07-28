/**
 * app.js — MintCraft application wiring.
 *
 * Owns application state, image upload (drag & drop + file picker),
 * depth-map regeneration (debounced), and the 2D + 3D preview refresh.
 *
 * Classic script: uses window.DepthMap and window.App namespaces so the
 * app works when index.html is opened directly from the file system.
 */

const { loadImageFromFile, imageToDepthMap, renderCoinFace2D } = window.DepthMap;
const { CoinPreview3D } = window.App;

const DEPTH_GRID_SIZE = 2048; // depth-map resolution per side (offset sliders use this px space)
const MAX_OFFSET = DEPTH_GRID_SIZE / 2;

const defaultTransform = () => ({ scale: 1, ox: 0, oy: 0, rot: 0 });
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/bmp', 'image/x-ms-bmp', 'image/webp'];
const defaultConversion = () => ({
  brightness: 0, contrast: 0, invert: false, blurSigma: 0,
  smoothMode: 'bilateral', edgePreserve: 40, normalize: false, gamma: 1,
  depthSource: 'luminance', // 'luminance' | 'ai' | 'hybrid'
  aiDetail: 0.25,           // hybrid: luminance detail blend 0..1
});

// 2D preview tints per metal [r,g,b] (3D uses its own PBR presets).
const METAL_TINTS = {
  brass:     [219, 178, 94],
  aluminium: [214, 217, 221],
  copper:    [184, 115, 51],
  silver:    [192, 192, 200],
  stainless: [154, 160, 168],
};

// ── State ───────────────────────────────────────────────────────────────
const state = {
  shape: 'coin',       // 'coin' (cylinder) | 'plaque' (rectangular cuboid)
  radius: 30,          // mm (coin)
  depth: 3,            // mm (coin thickness)
  plaque: { x: 80, y: 50, z: 4, bevel: 1 }, // mm (cuboid width/height/thickness/edge bevel)
  relief: 2,           // mm
  edge: 2,             // mm — raised rim thickness on both faces (coin)
  metal: 'brass',      // coin material
  showDepthMap: false,
  gridW: DEPTH_GRID_SIZE, // current depth-grid dims (square for coin, image-aspect for plaque)
  gridH: DEPTH_GRID_SIZE,
  lit: true,           // 3D preview: lit (PBR) vs unlit (flat) rendering
  lightIntensity: 1,   // 3D preview: key/fill/rim light scale 0..3
  // Single working side. Kept as sides.A so per-side helpers stay generic.
  sides: {
    A: { image: null, depth: null, transform: defaultTransform(), conv: defaultConversion(), ai: null },
  },
};

// ── DOM ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const els = {
  radiusSlider: $('radiusSlider'), radiusVal: $('radiusVal'),
  depthSlider: $('depthSlider'), depthVal: $('depthVal'),
  reliefSlider: $('reliefSlider'), reliefVal: $('reliefVal'),
  edgeSlider: $('edgeSlider'), edgeVal: $('edgeVal'), edgeRow: $('edgeRow'),
  coinDims: $('coinDims'), plaqueDims: $('plaqueDims'),
  plaqueX: $('plaqueX'), plaqueXVal: $('plaqueXVal'),
  plaqueY: $('plaqueY'), plaqueYVal: $('plaqueYVal'),
  plaqueZ: $('plaqueZ'), plaqueZVal: $('plaqueZVal'),
  bevelSlider: $('bevelSlider'), bevelVal: $('bevelVal'),
  metalSelect: $('metalSelect'),
  showDepthCheck: $('showDepthCheck'),
  litCheck: $('litCheck'),
  lightIntensity: $('lightIntensity'), lightIntensityVal: $('lightIntensityVal'),
  dropzoneA: $('dropzoneA'),
  fileA: $('fileA'),
  thumbA: $('thumbA'),
  panelA: $('panelA'),
  clearA: $('clearA'),
  scaleA: $('scaleA'), scaleAVal: $('scaleAVal'),
  offsetXA: $('offsetXA'), offsetXAVal: $('offsetXAVal'),
  offsetYA: $('offsetYA'), offsetYAVal: $('offsetYAVal'),
  rotA: $('rotA'), rotAVal: $('rotAVal'), resetA: $('resetA'),
  brightnessA: $('brightnessA'), brightnessAVal: $('brightnessAVal'),
  contrastA: $('contrastA'), contrastAVal: $('contrastAVal'),
  invertA: $('invertA'), blurA: $('blurA'), blurAVal: $('blurAVal'), resetDepthA: $('resetDepthA'),
  smoothModeA: $('smoothModeA'), edgeA: $('edgeA'), edgeAVal: $('edgeAVal'), edgeRowA: $('edgeRowA'),
  normalizeA: $('normalizeA'), gammaA: $('gammaA'), gammaAVal: $('gammaAVal'),
  depthSourceA: $('depthSourceA'), aiStatusA: $('aiStatusA'),
  aiDetailA: $('aiDetailA'), aiDetailAVal: $('aiDetailAVal'), aiDetailRowA: $('aiDetailRowA'),
  canvasOrig: $('canvasOrig'), canvasDepth: $('canvasDepth'),
  dlPngA: $('dlPngA'), dlTiffA: $('dlTiffA'),
  canvasWrap: $('canvasWrap'),
  viewABtn: $('viewABtn'),
  viewHint: $('viewHint'),
};

// ── 3D preview ──────────────────────────────────────────────────────────
const preview3d = new CoinPreview3D(els.canvasWrap);

// ── AI depth (object-aware, local ONNX inference) ───────────────────────
function setAIStatus(side, text, isError = false) {
  const el = els['aiStatus' + side];
  el.textContent = text || '';
  el.hidden = !text;
  el.classList.toggle('ai-error', isError);
}

/**
 * Ensure an AI depth result exists for a side. Kicks off async inference
 * (once per image — AIDepth caches internally) and re-renders when ready.
 * @returns {boolean} true if the AI result is ready now.
 */
function ensureAIDepth(side, fit) {
  const s = state.sides[side];
  if (!s.image) return false;
  if (s.ai && s.ai.image === s.image && s.ai.fit === fit) return true; // ready

  setAIStatus(side, AIDepth.isCached(s.image, fit) ? 'Analyzing…' : 'Loading model & analyzing…');
  const imageAtRequest = s.image;
  AIDepth.estimate(imageAtRequest, fit)
    .then((res) => {
      if (state.sides[side].image !== imageAtRequest) return; // stale
      s.ai = { image: imageAtRequest, data: res.data, size: res.size, fit };
      setAIStatus(side, `Object-aware depth ready (${AIDepth.provider()})`);
      setTimeout(() => setAIStatus(side, ''), 2500);
      refreshAll();
    })
    .catch((err) => {
      console.error('AI depth failed:', err);
      if (state.sides[side].image !== imageAtRequest) return;
      setAIStatus(side, 'AI depth unavailable — using luminance. (Reload the page and try again)', true);
    });
  return false;
}

// ── Rendering ───────────────────────────────────────────────────────────
function refreshAll() {
  const s = state.sides.A;
  const isPlaque = state.shape === 'plaque';
  // The depth MAP is always computed fit (uncropped) at the image's aspect,
  // so medallion / token / plaque share the identical map. Only the viewport
  // previews crop it (coin's circular face, 3D mesh).
  const imgAspect = s.image
    ? (s.image.naturalWidth || s.image.width) / (s.image.naturalHeight || s.image.height)
    : 0;
  const fitAspect = s.image ? imgAspect : 0;

  let aiDepth = null;
  if (s.image && s.conv.depthSource !== 'luminance') {
    if (ensureAIDepth('A', fitAspect > 0)) aiDepth = s.ai; // else luminance now, re-render when ready
  }
  const res = s.image
    ? imageToDepthMap(s.image, {
        size: DEPTH_GRID_SIZE,
        brightness: s.conv.brightness,
        contrast: s.conv.contrast,
        invert: s.conv.invert,
        blurSigma: s.conv.blurSigma,
        smoothMode: s.conv.smoothMode,
        edgePreserve: s.conv.edgePreserve,
        normalize: s.conv.normalize,
        gamma: s.conv.gamma,
        transform: s.transform,
        depthSource: aiDepth ? s.conv.depthSource : 'luminance',
        aiDepth,
        aiDetail: s.conv.aiDetail,
        fitAspect,
      })
    : null;
  s.depth = res ? res.data : null;
  const gW = res ? res.width : DEPTH_GRID_SIZE;
  const gH = res ? res.height : DEPTH_GRID_SIZE;
  state.gridW = gW;
  state.gridH = gH;

  const tint = METAL_TINTS[state.metal] || METAL_TINTS.brass;
  const shapeOpts = isPlaque
    ? { shape: 'rect', aspect: state.plaque.x / state.plaque.y, gridW: gW, gridH: gH }
    : { shape: 'coin' };
  const edgeFrac = state.shape === 'coin' ? state.edge / state.radius : 0;

  // 2D panel 1 — original image, always shown uncropped (matches the depth map).
  DepthMap.renderSourceImage(els.canvasOrig, s.image, DEPTH_GRID_SIZE, { fit: true });
  // 2D panel 2 — final depth map (grayscale, shaped by the object).
  renderCoinFace2D(els.canvasDepth, s.depth, DEPTH_GRID_SIZE, {
    showDepthMap: true, relief: state.relief, edgeFrac, tint, ...shapeOpts,
  });

  updateDownloadButtons();

  preview3d.rebuild({
    shape: state.shape,
    radius: state.radius,
    depth: state.depth,
    plaque: state.plaque,
    relief: state.relief,
    depthA: s.depth,
    depthB: null,
    gridSize: DEPTH_GRID_SIZE,
    gridW: gW,
    gridH: gH,
    edgeMm: state.edge,
  });
}

/** Debounced refresh for slider drags (geometry rebuild is not free). */
let refreshTimer = null;
function scheduleRefresh(delay = 120) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshAll, delay);
}

// ── Image upload ────────────────────────────────────────────────────────
async function setImage(side, file) {
  if (!file) return;
  const isAccepted =
    ACCEPTED_TYPES.includes(file.type) ||
    /\.(jpe?g|png|bmp|webp)$/i.test(file.name);
  if (!isAccepted) {
    alert('Unsupported format. Please use JPEG, PNG, BMP or WebP.');
    return;
  }
  try {
    const image = await loadImageFromFile(file);
    applyImage(side, image);
  } catch {
    alert('Could not read that image file.');
  }
}

function applyImage(side, image) {
  state.sides[side].image = image;
  els.thumbA.src = image.src || image.toDataURL?.() || '';
  els.thumbA.hidden = false;
  els.panelA.classList.add('has-image');
  els.clearA.disabled = false;
  if (state.shape === 'plaque') fitPlaqueToImage(); // keep cuboid aspect = image aspect
  scheduleRefresh(0);
}

function clearSide(side) {
  state.sides[side].image = null;
  state.sides[side].depth = null;
  state.sides[side].ai = null;
  setAIStatus(side, '');
  els.thumbA.hidden = true;
  els.thumbA.removeAttribute('src');
  els.panelA.classList.remove('has-image');
  els.clearA.disabled = true;
  scheduleRefresh(0);
}

// ── Depth-map download (16-bit grayscale PNG / TIFF) ────────────────────
function updateDownloadButtons() {
  els.dlPngA.disabled = els.dlTiffA.disabled = !state.sides.A.depth;
}

function downloadDepthMap(format) {
  const depth = state.sides.A.depth;
  if (!depth) return;
  const w = state.gridW || DEPTH_GRID_SIZE;
  const h = state.gridH || DEPTH_GRID_SIZE;
  const { encodePNG16, encodeTIFF16, downloadBlob } = window.DepthMapExport;
  const blob = format === 'png'
    ? encodePNG16(depth, w, h)
    : encodeTIFF16(depth, w, h);
  downloadBlob(blob, `depthmap-16bit.${format === 'png' ? 'png' : 'tif'}`);
}

els.dlPngA.addEventListener('click', () => downloadDepthMap('png'));
els.dlTiffA.addEventListener('click', () => downloadDepthMap('tiff'));

function wireDropzone(zone, fileInput, side) {
  zone.addEventListener('click', () => fileInput.click());
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) setImage(side, fileInput.files[0]);
    fileInput.value = '';
  });
  ['dragenter', 'dragover'].forEach((ev) =>
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.add('dragover');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
    })
  );
  zone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files?.[0];
    if (file) setImage(side, file);
  });
}

wireDropzone(els.dropzoneA, els.fileA, 'A');
els.clearA.addEventListener('click', () => clearSide('A'));

// ── Dimension sliders & presets ─────────────────────────────────────────
function setDimensions(r, d) {
  state.radius = r;
  state.depth = d;
  els.radiusSlider.value = r;
  els.depthSlider.value = d;
  els.radiusVal.textContent = `${r} mm`;
  els.depthVal.textContent = `${d} mm`;
  scheduleRefresh();
}

els.radiusSlider.addEventListener('input', () =>
  setDimensions(parseFloat(els.radiusSlider.value), state.depth)
);
els.depthSlider.addEventListener('input', () =>
  setDimensions(state.radius, parseFloat(els.depthSlider.value))
);

/** Show/hide the dimension rows appropriate for the active shape. */
function syncShapeUI() {
  const plaque = state.shape === 'plaque';
  els.coinDims.hidden = plaque;
  els.plaqueDims.hidden = !plaque;
  els.edgeRow.style.display = plaque ? 'none' : '';
  document.querySelectorAll('.preset-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.shape === state.shape && b.dataset.active === '1')
  );
}

function setPlaqueDim(key, val) {
  state.plaque[key] = val;
  const labels = { x: els.plaqueXVal, y: els.plaqueYVal, z: els.plaqueZVal, bevel: els.bevelVal };
  labels[key].textContent = `${val} mm`;
  scheduleRefresh();
}
/** Sync the plaque X/Y slider UI from state. */
function syncPlaqueXYUI() {
  els.plaqueX.value = state.plaque.x; els.plaqueXVal.textContent = `${state.plaque.x} mm`;
  els.plaqueY.value = state.plaque.y; els.plaqueYVal.textContent = `${state.plaque.y} mm`;
}

/**
 * Fit the plaque's X/Y footprint to the source image's aspect ratio, keeping
 * the current area (so its visual size doesn't jump). Only meaningful when an
 * image is loaded; otherwise the stored aspect is kept.
 */
function fitPlaqueToImage() {
  const img = state.sides.A.image;
  if (!img) return;
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const imageAspect = iw / ih;
  const currentAspect = state.plaque.x / state.plaque.y;
  if (Math.abs(imageAspect - currentAspect) < 0.005) return; // already matches
  const area = state.plaque.x * state.plaque.y;
  state.plaque.x = clampDim(Math.sqrt(area * imageAspect));
  state.plaque.y = clampDim(Math.sqrt(area / imageAspect));
  syncPlaqueXYUI();
}

const clampDim = (v) => Math.round(Math.min(200, Math.max(20, v)));

/** Adjust one plaque axis and, if an image is loaded, keep the other axis in proportion. */
function setPlaqueAxis(axis, val) {
  state.plaque[axis] = val;
  const img = state.sides.A.image;
  if (img) {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const imageAspect = iw / ih;
    if (axis === 'x') state.plaque.y = clampDim(val / imageAspect);
    else state.plaque.x = clampDim(val * imageAspect);
  }
  syncPlaqueXYUI();
  scheduleRefresh();
}

els.plaqueX.addEventListener('input', () => setPlaqueAxis('x', parseFloat(els.plaqueX.value)));
els.plaqueY.addEventListener('input', () => setPlaqueAxis('y', parseFloat(els.plaqueY.value)));
els.plaqueZ.addEventListener('input', () => setPlaqueDim('z', parseFloat(els.plaqueZ.value)));
els.bevelSlider.addEventListener('input', () => setPlaqueDim('bevel', parseFloat(els.bevelSlider.value)));

function setShape(shape) {
  if (shape === 'plaque') fitPlaqueToImage(); // match footprint to the image
  state.shape = shape;
  syncShapeUI();
  // Re-frame the camera for the new shape's footprint.
  preview3d.resetFrame();
  preview3d.viewSideA(viewRadius());
  scheduleRefresh(0);
}

document.querySelectorAll('.preset-btn').forEach((btn) =>
  btn.addEventListener('click', () => {
    // Mark the active preset so the shape toggle highlight follows it.
    document.querySelectorAll('.preset-btn').forEach((b) => (b.dataset.active = '0'));
    btn.dataset.active = '1';
    if (btn.dataset.shape === 'plaque') {
      setPlaqueDim('z', parseFloat(btn.dataset.z));
      // X/Y come from the image aspect if an image is loaded, else the preset.
      if (state.sides.A.image) {
        fitPlaqueToImage();
      } else {
        state.plaque.x = parseFloat(btn.dataset.x);
        state.plaque.y = parseFloat(btn.dataset.y);
        syncPlaqueXYUI();
      }
      setShape('plaque');
    } else {
      setDimensions(parseFloat(btn.dataset.r), parseFloat(btn.dataset.d));
      setShape('coin');
    }
  })
);

// ── Global: relief height & depth-map view toggle ───────────────────────
els.reliefSlider.addEventListener('input', () => {
  state.relief = parseFloat(els.reliefSlider.value);
  els.reliefVal.textContent = `${state.relief} mm`;
  scheduleRefresh();
});
els.edgeSlider.addEventListener('input', () => {
  state.edge = parseFloat(els.edgeSlider.value);
  els.edgeVal.textContent = `${state.edge} mm`;
  scheduleRefresh();
});
els.metalSelect.addEventListener('change', () => {
  state.metal = els.metalSelect.value;
  preview3d.setMetal(state.metal);
  scheduleRefresh();
});
els.showDepthCheck.addEventListener('change', () => {
  state.showDepthMap = els.showDepthCheck.checked;
  preview3d.setShowDepthMap(state.showDepthMap);
});

// ── 3D lighting: lit/unlit + intensity ──────────────────────────────────
function applyLighting() {
  preview3d.setLighting(state.lit, state.lightIntensity);
  els.lightIntensity.disabled = !state.lit;
  els.lightIntensityVal.textContent = `${Math.round(state.lightIntensity * 100)}%`;
}
els.litCheck.addEventListener('change', () => {
  state.lit = els.litCheck.checked;
  applyLighting();
});
els.lightIntensity.addEventListener('input', () => {
  state.lightIntensity = parseFloat(els.lightIntensity.value);
  applyLighting();
});

// ── Per-side depth-map conversion ───────────────────────────────────────
function wireConversion(side) {
  const c = () => state.sides[side].conv;
  const e = {
    brightness: els['brightness' + side], brightnessVal: els['brightness' + side + 'Val'],
    contrast: els['contrast' + side],     contrastVal: els['contrast' + side + 'Val'],
    invert: els['invert' + side],
    blur: els['blur' + side],             blurVal: els['blur' + side + 'Val'],
    smoothMode: els['smoothMode' + side],
    edge: els['edge' + side],             edgeVal: els['edge' + side + 'Val'],
    edgeRow: els['edgeRow' + side],
    normalize: els['normalize' + side],
    gamma: els['gamma' + side],           gammaVal: els['gamma' + side + 'Val'],
    reset: els['resetDepth' + side],
    depthSource: els['depthSource' + side],
    aiDetail: els['aiDetail' + side],     aiDetailVal: els['aiDetail' + side + 'Val'],
    aiDetailRow: els['aiDetailRow' + side],
  };

  const syncEdgeVisibility = () => {
    e.edgeRow.style.display = c().smoothMode === 'bilateral' ? '' : 'none';
  };

  const syncAIDetailVisibility = () => {
    e.aiDetailRow.style.display = c().depthSource === 'hybrid' ? '' : 'none';
  };

  e.depthSource.addEventListener('change', () => {
    c().depthSource = e.depthSource.value;
    syncAIDetailVisibility();
    scheduleRefresh(0);
  });
  e.aiDetail.addEventListener('input', () => {
    c().aiDetail = parseInt(e.aiDetail.value, 10) / 100;
    e.aiDetailVal.textContent = `${e.aiDetail.value}%`;
    scheduleRefresh();
  });

  e.brightness.addEventListener('input', () => {
    c().brightness = parseInt(e.brightness.value, 10);
    e.brightnessVal.textContent = e.brightness.value;
    scheduleRefresh();
  });
  e.contrast.addEventListener('input', () => {
    c().contrast = parseInt(e.contrast.value, 10);
    e.contrastVal.textContent = e.contrast.value;
    scheduleRefresh();
  });
  e.invert.addEventListener('change', () => {
    c().invert = e.invert.checked;
    scheduleRefresh();
  });
  e.blur.addEventListener('input', () => {
    c().blurSigma = parseFloat(e.blur.value);
    e.blurVal.textContent = `${e.blur.value} px`;
    scheduleRefresh();
  });
  e.smoothMode.addEventListener('change', () => {
    c().smoothMode = e.smoothMode.value;
    syncEdgeVisibility();
    scheduleRefresh();
  });
  e.edge.addEventListener('input', () => {
    c().edgePreserve = parseInt(e.edge.value, 10);
    e.edgeVal.textContent = e.edge.value;
    scheduleRefresh();
  });
  e.normalize.addEventListener('change', () => {
    c().normalize = e.normalize.checked;
    scheduleRefresh();
  });
  e.gamma.addEventListener('input', () => {
    c().gamma = parseFloat(e.gamma.value);
    e.gammaVal.textContent = parseFloat(e.gamma.value).toFixed(2);
    scheduleRefresh();
  });
  e.reset.addEventListener('click', () => {
    state.sides[side].conv = defaultConversion();
    e.brightness.value = 0; e.brightnessVal.textContent = '0';
    e.contrast.value = 0;   e.contrastVal.textContent = '0';
    e.invert.checked = false;
    e.blur.value = 0;       e.blurVal.textContent = '0 px';
    e.smoothMode.value = 'bilateral';
    e.edge.value = 40;      e.edgeVal.textContent = '40';
    e.normalize.checked = false;
    e.gamma.value = 1;      e.gammaVal.textContent = '1.00';
    e.depthSource.value = 'luminance';
    e.aiDetail.value = 25;  e.aiDetailVal.textContent = '25%';
    syncEdgeVisibility();
    syncAIDetailVisibility();
    scheduleRefresh(0);
  });

  syncEdgeVisibility();
  syncAIDetailVisibility();
}

wireConversion('A');

// ── Per-side image transform (position & scale) ─────────────────────────
function wireTransform(side) {
  const t = () => state.sides[side].transform;
  const e = {
    scale: els['scale' + side],     scaleVal: els['scale' + side + 'Val'],
    ox: els['offsetX' + side],      oxVal: els['offsetX' + side + 'Val'],
    oy: els['offsetY' + side],      oyVal: els['offsetY' + side + 'Val'],
    rot: els['rot' + side],         rotVal: els['rot' + side + 'Val'],
    reset: els['reset' + side],
  };

  e.scale.addEventListener('input', () => {
    t().scale = parseFloat(e.scale.value) / 100;
    e.scaleVal.textContent = `${e.scale.value}%`;
    scheduleRefresh();
  });
  e.ox.addEventListener('input', () => {
    t().ox = parseFloat(e.ox.value);
    e.oxVal.textContent = `${e.ox.value} px`;
    scheduleRefresh();
  });
  e.oy.addEventListener('input', () => {
    t().oy = parseFloat(e.oy.value);
    e.oyVal.textContent = `${e.oy.value} px`;
    scheduleRefresh();
  });
  e.rot.addEventListener('input', () => {
    t().rot = parseFloat(e.rot.value);
    e.rotVal.textContent = `${e.rot.value}°`;
    scheduleRefresh();
  });
  e.reset.addEventListener('click', () => {
    state.sides[side].transform = defaultTransform();
    e.scale.value = 100; e.scaleVal.textContent = '100%';
    e.ox.value = 0;      e.oxVal.textContent = '0 px';
    e.oy.value = 0;      e.oyVal.textContent = '0 px';
    e.rot.value = 0;     e.rotVal.textContent = '0°';
    scheduleRefresh(0);
  });
}

wireTransform('A');

// ── View controls ───────────────────────────────────────────────────────
function setActiveViewButton(btn) {
  document.querySelectorAll('.view-btn').forEach((b) => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
}

/** Fit radius for the active shape (used by the view presets). */
function viewRadius() {
  return state.shape === 'plaque' ? Math.max(state.plaque.x, state.plaque.y) / 2 : state.radius;
}

els.viewABtn.addEventListener('click', () => {
  preview3d.viewSideA(viewRadius());
  setActiveViewButton(els.viewABtn);
  els.viewHint.textContent = 'Drag to orbit · scroll to zoom';
});

// ── Boot ────────────────────────────────────────────────────────────────
syncShapeUI();
preview3d.setMetal(state.metal);
preview3d.setShowDepthMap(state.showDepthMap);
applyLighting();
preview3d.viewSideA(viewRadius());
refreshAll();
