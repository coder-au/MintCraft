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
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/bmp', 'image/x-ms-bmp'];
const defaultConversion = () => ({
  brightness: 0, contrast: 0, invert: false, blurSigma: 0,
  smoothMode: 'bilateral', edgePreserve: 40, normalize: false, gamma: 1,
  finishSmooth: 0,
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
  radius: 30,          // mm
  depth: 3,            // mm
  relief: 2,           // mm
  edge: 2,             // mm — raised rim thickness on both faces
  metal: 'brass',      // coin material
  showDepthMap: false,
  sides: {
    A: { image: null, depth: null, transform: defaultTransform(), conv: defaultConversion() },
    B: { image: null, depth: null, transform: defaultTransform(), conv: defaultConversion() },
  },
};

// ── DOM ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const els = {
  radiusSlider: $('radiusSlider'), radiusVal: $('radiusVal'),
  depthSlider: $('depthSlider'), depthVal: $('depthVal'),
  reliefSlider: $('reliefSlider'), reliefVal: $('reliefVal'),
  edgeSlider: $('edgeSlider'), edgeVal: $('edgeVal'),
  metalSelect: $('metalSelect'),
  showDepthCheck: $('showDepthCheck'),
  dropzoneA: $('dropzoneA'), dropzoneB: $('dropzoneB'),
  fileA: $('fileA'), fileB: $('fileB'),
  thumbA: $('thumbA'), thumbB: $('thumbB'),
  panelA: $('panelA'), panelB: $('panelB'),
  clearA: $('clearA'), clearB: $('clearB'),
  copyAtoB: $('copyAtoB'), copyBtoA: $('copyBtoA'),
  scaleA: $('scaleA'), scaleAVal: $('scaleAVal'),
  offsetXA: $('offsetXA'), offsetXAVal: $('offsetXAVal'),
  offsetYA: $('offsetYA'), offsetYAVal: $('offsetYAVal'),
  rotA: $('rotA'), rotAVal: $('rotAVal'), resetA: $('resetA'),
  scaleB: $('scaleB'), scaleBVal: $('scaleBVal'),
  offsetXB: $('offsetXB'), offsetXBVal: $('offsetXBVal'),
  offsetYB: $('offsetYB'), offsetYBVal: $('offsetYBVal'),
  rotB: $('rotB'), rotBVal: $('rotBVal'), resetB: $('resetB'),
  brightnessA: $('brightnessA'), brightnessAVal: $('brightnessAVal'),
  contrastA: $('contrastA'), contrastAVal: $('contrastAVal'),
  invertA: $('invertA'), blurA: $('blurA'), blurAVal: $('blurAVal'), resetDepthA: $('resetDepthA'),
  smoothModeA: $('smoothModeA'), edgeA: $('edgeA'), edgeAVal: $('edgeAVal'), edgeRowA: $('edgeRowA'),
  normalizeA: $('normalizeA'), gammaA: $('gammaA'), gammaAVal: $('gammaAVal'),
  finishA: $('finishA'), finishAVal: $('finishAVal'),
  brightnessB: $('brightnessB'), brightnessBVal: $('brightnessBVal'),
  contrastB: $('contrastB'), contrastBVal: $('contrastBVal'),
  invertB: $('invertB'), blurB: $('blurB'), blurBVal: $('blurBVal'), resetDepthB: $('resetDepthB'),
  smoothModeB: $('smoothModeB'), edgeB: $('edgeB'), edgeBVal: $('edgeBVal'), edgeRowB: $('edgeRowB'),
  normalizeB: $('normalizeB'), gammaB: $('gammaB'), gammaBVal: $('gammaBVal'),
  finishB: $('finishB'), finishBVal: $('finishBVal'),
  canvasA: $('canvasA'), canvasB: $('canvasB'),
  canvasWrap: $('canvasWrap'),
  viewABtn: $('viewABtn'), viewBBtn: $('viewBBtn'),
  flipBtn: $('flipBtn'), orbitBtn: $('orbitBtn'),
  viewHint: $('viewHint'),
};

// ── 3D preview ──────────────────────────────────────────────────────────
const preview3d = new CoinPreview3D(els.canvasWrap);

// ── Rendering ───────────────────────────────────────────────────────────
function refreshAll() {
  for (const side of ['A', 'B']) {
    const s = state.sides[side];
    s.depth = s.image
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
          finishSmooth: s.conv.finishSmooth,
          transform: s.transform,
        }).data
      : null;
  }

  const edgeFrac = state.edge / state.radius; // rim band as a fraction of radius
  const tint = METAL_TINTS[state.metal] || METAL_TINTS.brass;
  renderCoinFace2D(els.canvasA, state.sides.A.depth, DEPTH_GRID_SIZE, {
    showDepthMap: state.showDepthMap,
    relief: state.relief,
    edgeFrac,
    tint,
  });
  renderCoinFace2D(els.canvasB, state.sides.B.depth, DEPTH_GRID_SIZE, {
    showDepthMap: state.showDepthMap,
    relief: state.relief,
    edgeFrac,
    tint,
  });

  preview3d.rebuild({
    radius: state.radius,
    depth: state.depth,
    relief: state.relief,
    depthA: state.sides.A.depth,
    depthB: state.sides.B.depth,
    gridSize: DEPTH_GRID_SIZE,
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
    /\.(jpe?g|png|bmp)$/i.test(file.name);
  if (!isAccepted) {
    alert('Unsupported format. Please use JPEG, PNG or BMP.');
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

  const thumb = side === 'A' ? els.thumbA : els.thumbB;
  const panel = side === 'A' ? els.panelA : els.panelB;
  const clearBtn = side === 'A' ? els.clearA : els.clearB;

  thumb.src = image.src || image.toDataURL?.() || '';
  thumb.hidden = false;
  panel.classList.add('has-image');
  clearBtn.disabled = false;

  updateCopyButtons();
  scheduleRefresh(0);
}

function clearSide(side) {
  state.sides[side].image = null;
  state.sides[side].depth = null;

  const thumb = side === 'A' ? els.thumbA : els.thumbB;
  const panel = side === 'A' ? els.panelA : els.panelB;
  const clearBtn = side === 'A' ? els.clearA : els.clearB;

  thumb.hidden = true;
  thumb.removeAttribute('src');
  panel.classList.remove('has-image');
  clearBtn.disabled = true;

  updateCopyButtons();
  scheduleRefresh(0);
}

function updateCopyButtons() {
  els.copyAtoB.disabled = !state.sides.A.image;
  els.copyBtoA.disabled = !state.sides.B.image;
}

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
wireDropzone(els.dropzoneB, els.fileB, 'B');
els.clearA.addEventListener('click', () => clearSide('A'));
els.clearB.addEventListener('click', () => clearSide('B'));

// ── Apply to both sides ─────────────────────────────────────────────────
els.copyAtoB.addEventListener('click', () => {
  if (state.sides.A.image) applyImage('B', state.sides.A.image);
});
els.copyBtoA.addEventListener('click', () => {
  if (state.sides.B.image) applyImage('A', state.sides.B.image);
});

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

document.querySelectorAll('.preset-btn').forEach((btn) =>
  btn.addEventListener('click', () =>
    setDimensions(parseFloat(btn.dataset.r), parseFloat(btn.dataset.d))
  )
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
  scheduleRefresh(0);
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
    finish: els['finish' + side],         finishVal: els['finish' + side + 'Val'],
    reset: els['resetDepth' + side],
  };

  const syncEdgeVisibility = () => {
    e.edgeRow.style.display = c().smoothMode === 'bilateral' ? '' : 'none';
  };

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
  e.finish.addEventListener('input', () => {
    c().finishSmooth = parseFloat(e.finish.value);
    e.finishVal.textContent = `${e.finish.value} px`;
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
    e.finish.value = 0;     e.finishVal.textContent = '0 px';
    syncEdgeVisibility();
    scheduleRefresh(0);
  });

  syncEdgeVisibility();
}

wireConversion('A');
wireConversion('B');

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
wireTransform('B');

// ── View controls ───────────────────────────────────────────────────────
function setActiveViewButton(btn) {
  document.querySelectorAll('.view-btn').forEach((b) => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
}

/** Switch the 3D preview to show the given side (used when editing params). */
function focusSide(side) {
  if (side === 'A') preview3d.viewSideA(state.radius);
  else preview3d.viewSideB(state.radius);
  setActiveViewButton(side === 'A' ? els.viewABtn : els.viewBBtn);
  els.viewHint.textContent = `Viewing side ${side}`;
}

/**
 * When the user interacts with a side's parameter panel, ensure the 3D
 * preview is mostly facing that side — if not, tween the view to it.
 */
function wireSideFocus(side, panelEl) {
  const maybeFocus = () => {
    if (!preview3d.isSideMostlyFacing(side)) focusSide(side);
  };
  panelEl.addEventListener('pointerdown', maybeFocus, true);
  panelEl.addEventListener('focusin', maybeFocus);
}

wireSideFocus('A', els.panelA);
wireSideFocus('B', els.panelB);

/** Show exactly one side's parameters at a time ('A' | 'B'). Never both. */
function showSidePanel(view) {
  els.panelA.classList.toggle('hidden', view !== 'A');
  els.panelB.classList.toggle('hidden', view !== 'B');
}

els.viewABtn.addEventListener('click', () => { focusSide('A'); showSidePanel('A'); });
els.viewBBtn.addEventListener('click', () => { focusSide('B'); showSidePanel('B'); });
els.flipBtn.addEventListener('click', () => {
  preview3d.flip();
  // After the flip animation completes, show the side now facing up.
  setTimeout(() => {
    const top = preview3d.topSide; // 'A' or 'B'
    showSidePanel(top);
    setActiveViewButton(top === 'A' ? els.viewABtn : els.viewBBtn);
    els.viewHint.textContent = `Viewing side ${top}`;
  }, 720);
  els.viewHint.textContent = 'Flipping…';
});
els.orbitBtn.addEventListener('click', () => {
  preview3d.viewOrbit(state.radius);
  setActiveViewButton(els.orbitBtn);
  // Keep a single side panel visible — the one currently facing up.
  showSidePanel(preview3d.topSide);
  els.viewHint.textContent = 'Drag to orbit · scroll to zoom';
});

// ── Boot ────────────────────────────────────────────────────────────────
preview3d.setMetal(state.metal);
preview3d.viewSideA(state.radius); // default to Side A
showSidePanel('A');
refreshAll();
