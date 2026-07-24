/**
 * preview3d.js — Three.js coin renderer.
 *
 * The coin is a cylinder of radius r and depth d whose two flat caps are
 * displaced by the depth maps: side A on +Y (top), side B on −Y (bottom).
 * A separate vertex-colored rim forms the edge. Lighting uses a procedural
 * gold-metal PBR material (no external textures).
 *
 * Classic script: uses the global THREE (lib/three.min.js +
 * lib/OrbitControls.classic.js) so the app works without a web server.
 */

window.App = window.App || {};

const CAP_SEGMENTS = 1024;  // radial segments for cap displacement grids
const RIM_SEGMENTS = 1024;  // circumferential segments for the rim cylinder

App.CoinPreview3D = class CoinPreview3D {
  /**
   * @param {HTMLElement} container  Element the canvas is appended to.
   */
  constructor(container) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x10141b, 1);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 2000);
    this.camera.up.set(0, 0, -1); // "up" on screen = −Z, so side B reads upright when flipped

    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxDistance = 600;
    this.controls.minDistance = 20;

    // ── Lighting: key + fill + rim (no HDR assets needed) ──
    const key = new THREE.DirectionalLight(0xfff2dd, 2.4);
    key.position.set(60, 120, 80);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xaac4ff, 0.9);
    fill.position.set(-90, 40, -60);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.8);
    rim.position.set(0, -100, 40);
    this.scene.add(rim);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.25));

    // ── Materials ──
    this.faceMaterial = new THREE.MeshStandardMaterial({
      color: 0xd8b25e,
      metalness: 0.85,
      roughness: 0.32,
      vertexColors: true,
      side: THREE.DoubleSide, // no backface culling
    });
    this.rimMaterial = new THREE.MeshStandardMaterial({
      color: 0xcfa64f,
      metalness: 0.9,
      roughness: 0.4,
      vertexColors: true,
      side: THREE.DoubleSide, // no backface culling
    });

    // Metal presets: [faceColor, rimColor, metalness, roughness]
    this.metals = {
      brass:     { face: 0xd8b25e, rim: 0xc9a44f, metalness: 0.85, roughness: 0.32 },
      aluminium: { face: 0xd6d9dd, rim: 0xc4c8cd, metalness: 0.9,  roughness: 0.25 },
      copper:    { face: 0xb87333, rim: 0xa8642a, metalness: 0.9,  roughness: 0.3 },
      silver:    { face: 0xc0c0c8, rim: 0xb0b0b8, metalness: 0.95, roughness: 0.18 },
      stainless: { face: 0x9aa0a8, rim: 0x8b9198, metalness: 0.95, roughness: 0.35 },
    };

    // ── Coin group (rotated when flipping) ──
    this.coinGroup = new THREE.Group();
    this.scene.add(this.coinGroup);

    this.capA = null;
    this.capB = null;
    this.rimMesh = null;
    this.edgeA = null;
    this.edgeB = null;

    // Flip animation state
    this._flip = null;

    // Camera preset tween state
    this._camTween = null;

    this._resizeObserver = new ResizeObserver(() => this._resize());
    this._resizeObserver.observe(container);
    this._resize();

    this._animate = this._animate.bind(this);
    requestAnimationFrame(this._animate);
  }

  // ────────────────────────────────────────────────────────────────────
  // Geometry
  // ────────────────────────────────────────────────────────────────────

  /** Apply a metal preset to the face + rim materials. */
  setMetal(name) {
    const m = this.metals[name] || this.metals.brass;
    this.faceMaterial.color.setHex(m.face);
    this.faceMaterial.metalness = m.metalness;
    this.faceMaterial.roughness = m.roughness;
    this.rimMaterial.color.setHex(m.rim);
    this.rimMaterial.metalness = Math.min(1, m.metalness + 0.05);
    this.rimMaterial.roughness = Math.min(1, m.roughness + 0.08);
    this.faceMaterial.needsUpdate = true;
    this.rimMaterial.needsUpdate = true;
  }

  /**
   * Rebuild the coin.
   * @param {object} p
   * @param {number} p.radius          Coin radius (mm → scene units).
   * @param {number} p.depth           Coin thickness.
   * @param {number} p.relief          Max relief displacement.
   * @param {Float32Array|null} p.depthA  Normalized depth grid for side A.
   * @param {Float32Array|null} p.depthB  Normalized depth grid for side B.
   * @param {number} p.gridSize        Resolution of the depth grids.
   */
  rebuild({ radius, depth, relief, depthA, depthB, gridSize, edgeMm = 0 }) {
    // Dispose old geometry
    for (const mesh of [this.capA, this.capB, this.rimMesh, this.edgeA, this.edgeB]) {
      if (mesh) { mesh.geometry.dispose(); this.coinGroup.remove(mesh); }
    }

    const half = depth / 2;
    const edge = Math.min(edgeMm || 0, radius); // clamp so edge can't exceed radius

    this.capA = this._buildCap(radius, half, relief, depthA, gridSize, +1, edge);
    this.capB = this._buildCap(radius, half, relief, depthB, gridSize, -1, edge);
    this.rimMesh = this._buildRim(radius, half, relief, depthA, depthB, gridSize, edge);
    // Raised edge rings (real geometry) give a crisp, smooth inner boundary.
    this.edgeA = this._buildRaisedEdge(radius, half, relief, +1, edge);
    this.edgeB = this._buildRaisedEdge(radius, half, relief, -1, edge);

    this.coinGroup.add(this.capA, this.capB, this.rimMesh);
    if (this.edgeA) this.coinGroup.add(this.edgeA);
    if (this.edgeB) this.coinGroup.add(this.edgeB);

    // Frame camera if it hasn't been placed yet relative to coin size
    this._frame(radius);
  }

  /** Sample depth grid with bilinear interpolation. */
  _sample(depth, gridSize, u, v) {
    if (!depth) return 0.5;
    const x = Math.min(gridSize - 1.001, Math.max(0, u * (gridSize - 1)));
    const y = Math.min(gridSize - 1.001, Math.max(0, v * (gridSize - 1)));
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const x1 = Math.min(gridSize - 1, x0 + 1);
    const y1 = Math.min(gridSize - 1, y0 + 1);
    const a = depth[y0 * gridSize + x0], b = depth[y0 * gridSize + x1];
    const c = depth[y1 * gridSize + x0], d = depth[y1 * gridSize + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }

  /**
   * Effective relief at radial distance `dist`. The image relief applies only
   * within the inner face (dist < radius − edge); the outer band is flattened
   * to 0 because the raised edge is modelled separately as a smooth ring
   * (see _buildRaisedEdge), so the image never affects the edge.
   */
  _applyEdge(d, dist, radius, edge) {
    if (edge <= 0) return d;
    return dist < radius - edge ? d : 0.0;
  }

  /**
   * Build the raised edge ring on one face as real geometry: an annulus from
   * (radius − edge) to radius at the full relief height, with a smooth circular
   * inner boundary (not tied to the cap's displacement grid). Returns null when
   * edge is 0.
   */
  _buildRaisedEdge(radius, half, relief, side /* +1 top, −1 bottom */, edge) {
    if (edge <= 0) return null;
    const inner = Math.max(0.0001, radius - edge);
    const topY = side * (half + relief); // raised surface height
    const baseY = side * half;           // face base height (band is flattened here)

    const parts = [];

    // Top annulus (the raised ring surface), high theta res → smooth inner edge.
    const top = new THREE.RingGeometry(inner, radius, RIM_SEGMENTS, 1);
    top.rotateX(side === 1 ? -Math.PI / 2 : Math.PI / 2);
    top.translate(0, topY, 0);
    parts.push(top);

    // Inner vertical wall (base → raised top) so the ring is solid from the side.
    const wallH = Math.abs(topY - baseY);
    const wall = new THREE.CylinderGeometry(inner, inner, wallH, RIM_SEGMENTS, 1, true);
    wall.translate(0, (topY + baseY) / 2, 0);
    parts.push(wall);

    // Merge the two into one non-indexed geometry (position/normal/color).
    const nonIndexed = parts.map((g) => g.toNonIndexed());
    let total = 0;
    for (const g of nonIndexed) total += g.attributes.position.count;

    const positions = new Float32Array(total * 3);
    const normals = new Float32Array(total * 3);
    const colors = new Float32Array(total * 3).fill(1);
    let offset = 0;
    for (const g of nonIndexed) {
      positions.set(g.attributes.position.array, offset * 3);
      normals.set(g.attributes.normal.array, offset * 3);
      offset += g.attributes.position.count;
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return new THREE.Mesh(merged, this.faceMaterial);
  }

  /**
   * Build one displaced cap.
   * PlaneGeometry lies in XY facing +Z; rotateX(+π/2) maps that normal to
   * +Y (top cap), rotateX(−π/2) maps it to −Y (bottom cap).
   */
  _buildCap(radius, half, relief, depth, gridSize, side /* +1 top, −1 bottom */, edge = 0) {
    const geo = new THREE.PlaneGeometry(radius * 2, radius * 2, CAP_SEGMENTS, CAP_SEGMENTS);
    geo.rotateX(side === 1 ? Math.PI / 2 : -Math.PI / 2);

    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const dist = Math.sqrt(x * x + z * z);

      // Vertices outside the disc are collapsed onto the rim circle; the
      // resulting degenerate ring is hidden under the rim mesh.
      let px = x, pz = z;
      if (dist > radius) {
        const s = radius / dist;
        px = x * s; pz = z * s;
      }

      // Map world (x,z) → image (u,v). Camera up is −Z, so image top (v=0)
      // sits at z = −r for side A. Side B is seen after a 180° flip about
      // the Z axis (x → −x, y → −y), so its u axis is mirrored for the
      // image to read upright.
      const u = side === 1
        ? (px + radius) / (2 * radius)
        : (radius - px) / (2 * radius);
      const v = (pz + radius) / (2 * radius);
      const dRaw = this._sample(depth, gridSize, u, v);
      // Clamp relief so the image never overwrites the raised rim band.
      const d = this._applyEdge(dRaw, Math.sqrt(px * px + pz * pz), radius, edge);

      const y = side * (half + d * relief);
      pos.setXYZ(i, px, y, pz);

      // Slight darkening with depth so relief reads without textures
      const shade = 0.72 + 0.28 * d;
      colors[i * 3] = shade;
      colors[i * 3 + 1] = shade;
      colors[i * 3 + 2] = shade;
    }

    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    return new THREE.Mesh(geo, this.faceMaterial);
  }

  /**
   * Build the coin edge (rim) as a vertical cylindrical wall perpendicular to
   * the faces, spanning from the bottom base to the full raised relief height.
   * The wall height is fixed by the coin geometry, not the image, so the image
   * never influences the edge.
   */
  _buildRim(radius, half, relief, depthA, depthB, gridSize, edge = 0) {
    // Real round geometry: an open-ended cylinder (side wall only) with smooth
    // computed normals. Height spans from the bottom base to the raised relief
    // top so the rim is a true 90° wall, independent of the image.
    const height = 2 * (half + relief);
    const geo = new THREE.CylinderGeometry(
      radius, radius,   // top / bottom radius
      height,           // wall height
      RIM_SEGMENTS,     // radial segments (circumference) — high for smoothness
      1,                // height segments
      true              // open-ended: no caps, just the side wall
    );

    // Uniform white vertex color so the PBR material tints it (no banding).
    const count = geo.attributes.position.count;
    const colors = new Float32Array(count * 3).fill(1);
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    return new THREE.Mesh(geo, this.rimMaterial);
  }

  // ────────────────────────────────────────────────────────────────────
  // Camera
  // ────────────────────────────────────────────────────────────────────

  _frame(radius) {
    if (!this._framed) {
      const dist = radius * 3.4;
      this.camera.position.set(dist * 0.55, dist * 0.75, dist * 0.55);
      this.controls.target.set(0, 0, 0);
      this.controls.update();
      this._framed = true;
    }
  }

  /** Smoothly move the camera to a preset position. */
  _tweenCamera(to, duration = 600) {
    this._camTween = {
      from: this.camera.position.clone(),
      to: to.clone(),
      start: performance.now(),
      duration,
    };
  }

  /** Top-down view of the current top face. */
  viewTopDown(radius) {
    this._tweenCamera(new THREE.Vector3(0, radius * 3.2, 0.001));
  }

  /** Look straight at side A (+Y face). */
  viewSideA(radius) {
    if (this._isFlipped()) this.flip(); // ensure A is up
    this._tweenCamera(new THREE.Vector3(0, radius * 3.2, 0.001));
  }

  /** Look straight at side B (−Y face) by flipping the coin, camera top-down. */
  viewSideB(radius) {
    if (!this._isFlipped()) this.flip();
    this._tweenCamera(new THREE.Vector3(0, radius * 3.2, 0.001));
  }

  /** Slightly angled orbit-friendly view. */
  viewOrbit(radius) {
    const dist = radius * 3.2;
    this._tweenCamera(new THREE.Vector3(dist * 0.6, dist * 0.65, dist * 0.6));
  }

  /** True when the coin is flipped (side B facing up). */
  _isFlipped() {
    return Math.abs(this.coinGroup.rotation.z) > Math.PI / 2;
  }

  /** Animated 180° flip of the coin around the Z axis (a horizontal axis
   *  in screen space — flips left-to-right, not around the depth axis). */
  flip() {
    if (this._flip) return;
    const target = this._isFlipped() ? 0 : Math.PI;
    this._flip = {
      from: this.coinGroup.rotation.z,
      to: target,
      start: performance.now(),
      duration: 700,
    };
  }

  /** Which side currently faces up: 'A' or 'B'. */
  get topSide() {
    return this._isFlipped() ? 'B' : 'A';
  }

  // ────────────────────────────────────────────────────────────────────
  // Frame loop
  // ────────────────────────────────────────────────────────────────────

  _resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  _animate(now) {
    requestAnimationFrame(this._animate);

    // Camera tween
    if (this._camTween) {
      const t = Math.min(1, (now - this._camTween.start) / this._camTween.duration);
      const e = 1 - Math.pow(1 - t, 3); // easeOutCubic
      this.camera.position.lerpVectors(this._camTween.from, this._camTween.to, e);
      if (t >= 1) this._camTween = null;
    }

    // Flip animation
    if (this._flip) {
      const t = Math.min(1, (now - this._flip.start) / this._flip.duration);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // easeInOutCubic
      this.coinGroup.rotation.z = this._flip.from + (this._flip.to - this._flip.from) * e;
      if (t >= 1) {
        this.coinGroup.rotation.z = this._flip.to;
        this._flip = null;
      }
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this._resizeObserver.disconnect();
    this.renderer.dispose();
    this.container.removeChild(this.renderer.domElement);
  }
};
