// Relic Run - Three.js renderer: lush overgrown ruins.
// Pooled/instanced meshes only - no per-frame geometry/material allocation.
import * as THREE from 'three';
import { mulberry32, UNITS_PER_CELL, LANES, activeBranch, cellIndex } from './rules.js';

export const LANE_X = [-2.2, 0, 2.2];
const CELL_DEPTH = 2.0;
const GROUND_Y = 0;

// authored camera framing constants
export const CAMERA = {
  fov: 50,
  back: 7.5,
  height: 4.2,
  lookAhead: 6.0,
  lateralFollow: 0.45,
  damp: 6.0, // critically-damped-ish smoothing rate
};

const QUALITY_TIERS = {
  low: { pixelRatioCap: 1.0, shadows: false, vegetationPerSide: 40, pillarEvery: 6 },
  medium: { pixelRatioCap: 1.5, shadows: true, vegetationPerSide: 90, pillarEvery: 4 },
  high: { pixelRatioCap: 2.0, shadows: true, vegetationPerSide: 160, pillarEvery: 3 },
};

export class WebGLUnavailableError extends Error {
  constructor(msg) { super(msg); this.code = 'webgl-unavailable'; }
}

export function createRenderer(canvas, opts = {}) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (e) {
    throw new WebGLUnavailableError('WebGL is unavailable in this browser.');
  }
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const R = {
    renderer,
    canvas,
    scene: null,
    camera: null,
    quality: QUALITY_TIERS[opts.quality] ? opts.quality : 'medium',
    reducedMotion: !!opts.reducedMotion,
    colorblind: !!opts.colorblind,
    theme: null,
    pools: null,
    player: null,
    camPos: new THREE.Vector3(0, CAMERA.height, -CAMERA.back),
    shakeAmp: 0,
    contextLost: false,
    disposed: false,
    course: null,
  };

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    R.contextLost = true;
  });
  canvas.addEventListener('webglcontextrestored', () => {
    R.contextLost = false;
    if (R.course) buildCourseScene(R, R.course, R.theme, R.decorSeed);
  });

  return R;
}

export function setQuality(R, tier) {
  if (!QUALITY_TIERS[tier]) return;
  R.quality = tier;
  const q = QUALITY_TIERS[tier];
  R.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, q.pixelRatioCap));
  R.renderer.shadowMap.enabled = q.shadows;
  if (R.keyLight) R.keyLight.castShadow = q.shadows;
  if (R.course) buildCourseScene(R, R.course, R.theme, R.decorSeed);
}

export function setReducedMotion(R, v) { R.reducedMotion = !!v; }
export function setColorblind(R, v) {
  R.colorblind = !!v;
  if (R.pools && R.pools.relicMat) {
    // colorblind-safe: fragments become bright cyan/white, risk route marked by shape
    R.pools.relicMat.color.set(v ? 0x9ff5ff : (R.theme ? R.theme.relic : 0x7fe3c0));
  }
}

export function resize(R, width, height) {
  if (!R.camera) return;
  R.renderer.setSize(Math.max(1, width | 0), Math.max(1, height | 0), false);
  R.camera.aspect = width / Math.max(1, height);
  R.camera.updateProjectionMatrix();
}

// --- scene construction ---------------------------------------------------------
export function buildCourseScene(R, course, theme, seed) {
  disposeScene(R);
  R.course = course;
  R.theme = theme;
  R.decorSeed = seed >>> 0;
  const q = QUALITY_TIERS[R.quality];
  const cells = course.cells;
  const nCells = cells.length;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(theme.sky);
  scene.fog = new THREE.FogExp2(theme.fog, theme.fogDensity);
  R.scene = scene;

  R.camera = new THREE.PerspectiveCamera(CAMERA.fov, 4 / 3, 0.1, 120);
  R.camera.position.set(0, CAMERA.height, -CAMERA.back);

  // lighting: warm key + hemisphere fill
  const hemi = new THREE.HemisphereLight(theme.sky, theme.stoneDark, 0.9);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffe6b8, 2.2);
  key.position.set(-6, 10, -4);
  key.castShadow = q.shadows;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -15; key.shadow.camera.right = 15;
  key.shadow.camera.top = 20; key.shadow.camera.bottom = -20;
  scene.add(key);
  R.keyLight = key;

  const mats = {
    stone: new THREE.MeshStandardMaterial({ color: theme.stone, roughness: 0.9 }),
    stoneDark: new THREE.MeshStandardMaterial({ color: theme.stoneDark, roughness: 1.0 }),
    foliage: new THREE.MeshStandardMaterial({ color: theme.foliage, roughness: 1.0 }),
    foliageAlt: new THREE.MeshStandardMaterial({ color: theme.foliageAlt, roughness: 1.0 }),
    trunk: new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 1.0 }),
    relic: new THREE.MeshStandardMaterial({
      color: R.colorblind ? 0x9ff5ff : theme.relic,
      emissive: R.colorblind ? 0x2a6a77 : theme.relic, emissiveIntensity: 0.5, roughness: 0.3,
    }),
    barrier: new THREE.MeshStandardMaterial({ color: 0x6b4f2e, roughness: 0.95 }),
    branch: new THREE.MeshStandardMaterial({ color: theme.accent, emissive: theme.accent, emissiveIntensity: 0.35 }),
    risk: new THREE.MeshStandardMaterial({ color: 0xff8c5a, emissive: 0x903010, emissiveIntensity: 0.3 }),
    player: new THREE.MeshStandardMaterial({ color: 0xf0e2c0, roughness: 0.6 }),
    playerAccent: new THREE.MeshStandardMaterial({ color: 0x3a6a4f, roughness: 0.5 }),
  };

  // ground base plane (under everything, visible through gaps)
  const baseGeo = new THREE.PlaneGeometry(40, nCells * CELL_DEPTH + 80);
  const base = new THREE.Mesh(baseGeo, mats.stoneDark);
  base.rotation.x = -Math.PI / 2;
  base.position.set(0, GROUND_Y - 2.2, nCells * CELL_DEPTH / 2);
  base.receiveShadow = true;
  scene.add(base);

  // track tiles: one instanced mesh, one instance per (cell, lane) that is not a gap
  const tileGeo = new THREE.BoxGeometry(2.05, 0.4, CELL_DEPTH * 0.96);
  const tilePositions = [];
  for (let i = 0; i < nCells; i++) {
    if (cells[i].gap) continue;
    for (let l = 0; l < LANES; l++) tilePositions.push([LANE_X[l], GROUND_Y - 0.2, i * CELL_DEPTH]);
  }
  const tiles = new THREE.InstancedMesh(tileGeo, mats.stone, tilePositions.length);
  const m4 = new THREE.Matrix4();
  tilePositions.forEach((p, idx) => {
    m4.makeTranslation(p[0], p[1], p[2]);
    tiles.setMatrixAt(idx, m4);
  });
  tiles.receiveShadow = true;
  scene.add(tiles);

  // low barriers
  const lowCells = [];
  for (let i = 0; i < nCells; i++) if (cells[i].low) lowCells.push(i);
  const barGeo = new THREE.BoxGeometry(LANE_X[2] * 2 + 2.2, 1.0, 0.4);
  const bars = new THREE.InstancedMesh(barGeo, mats.barrier, Math.max(1, lowCells.length));
  lowCells.forEach((ci, idx) => {
    m4.makeTranslation(0, GROUND_Y + 1.1, ci * CELL_DEPTH);
    bars.setMatrixAt(idx, m4);
  });
  bars.castShadow = q.shadows;
  bars.count = lowCells.length;
  scene.add(bars);

  // vine drape on top of barriers
  const vineGeo = new THREE.ConeGeometry(0.35, 1.2, 5);
  const vines = new THREE.InstancedMesh(vineGeo, mats.foliage, Math.max(1, lowCells.length * 2));
  lowCells.forEach((ci, idx) => {
    m4.makeTranslation(-1.5, GROUND_Y + 1.9, ci * CELL_DEPTH);
    vines.setMatrixAt(idx * 2, m4);
    m4.makeTranslation(1.5, GROUND_Y + 1.9, ci * CELL_DEPTH);
    vines.setMatrixAt(idx * 2 + 1, m4);
  });
  vines.count = lowCells.length * 2;
  scene.add(vines);

  // relics (instanced; hidden when collected by scaling to 0)
  const relicCells = [];
  for (let i = 0; i < nCells; i++) if (cells[i].relicLane >= 0) relicCells.push(i);
  const relicGeo = new THREE.OctahedronGeometry(0.42);
  const relics = new THREE.InstancedMesh(relicGeo, mats.relic, Math.max(1, relicCells.length));
  relics.userData.cellOf = relicCells;
  relicCells.forEach((ci, idx) => {
    m4.makeTranslation(LANE_X[cells[ci].relicLane], GROUND_Y + 0.9, ci * CELL_DEPTH);
    relics.setMatrixAt(idx, m4);
  });
  relics.count = relicCells.length;
  scene.add(relics);

  // branch indicators: twin arrow markers at each fork
  const forkCells = [];
  for (let i = 0; i < nCells; i++) if (cells[i].branch) forkCells.push(i);
  const arrowGeo = new THREE.ConeGeometry(0.5, 1.0, 4);
  const arrows = new THREE.InstancedMesh(arrowGeo, mats.branch, Math.max(1, forkCells.length * 2));
  forkCells.forEach((ci, idx) => {
    const m2 = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
    m2.premultiply(new THREE.Matrix4().makeTranslation(-3.4, GROUND_Y + 1.0, ci * CELL_DEPTH));
    arrows.setMatrixAt(idx * 2, m2);
    const m3 = new THREE.Matrix4().makeRotationZ(-Math.PI / 2);
    m3.premultiply(new THREE.Matrix4().makeTranslation(3.4, GROUND_Y + 1.0, ci * CELL_DEPTH));
    arrows.setMatrixAt(idx * 2 + 1, m3);
  });
  arrows.count = forkCells.length * 2;
  scene.add(arrows);

  // risk-route tint strips after each fork
  const stripGeo = new THREE.BoxGeometry(1.8, 0.06, CELL_DEPTH * 0.9);
  let stripCount = 0;
  for (const b of forkCells) stripCount += Math.min(cells[b].branch, 12);
  const strips = new THREE.InstancedMesh(stripGeo, mats.risk, Math.max(1, stripCount));
  let si = 0;
  for (const b of forkCells) {
    const span = Math.min(cells[b].branch, 12);
    for (let k = 1; k <= span && b + k < nCells; k++) {
      if (cells[b + k].gap) continue;
      m4.makeTranslation(LANE_X[2] + 0.4, GROUND_Y + 0.03, (b + k) * CELL_DEPTH);
      strips.setMatrixAt(si++, m4);
    }
  }
  strips.count = si;
  scene.add(strips);

  // decoration: pillars + vegetation, from the deterministic decoration stream
  const deco = mulberry32((R.decorSeed ^ 0xdec0) >>> 0);
  const pillarGeo = new THREE.CylinderGeometry(0.45, 0.55, 3.4, 7);
  const nPillars = Math.floor(nCells / q.pillarEvery) * 2;
  const pillars = new THREE.InstancedMesh(pillarGeo, mats.stone, Math.max(1, nPillars));
  let pi = 0;
  for (let i = 4; i < nCells && pi < nPillars; i += q.pillarEvery) {
    for (const side of [-1, 1]) {
      const h = 0.6 + deco() * 0.5; // crumbling height variance
      const m = new THREE.Matrix4().makeScale(1, h, 1);
      m.premultiply(new THREE.Matrix4().makeTranslation(side * (4.6 + deco() * 1.2), GROUND_Y + 1.7 * h, i * CELL_DEPTH + (deco() - 0.5)));
      pillars.setMatrixAt(pi++, m);
    }
  }
  pillars.count = pi;
  pillars.castShadow = q.shadows;
  scene.add(pillars);

  const bushGeo = new THREE.ConeGeometry(0.9, 1.6, 6);
  const nVeg = q.vegetationPerSide * 2;
  const veg = new THREE.InstancedMesh(bushGeo, mats.foliage, Math.max(1, nVeg));
  for (let k = 0; k < nVeg; k++) {
    const side = k % 2 === 0 ? -1 : 1;
    const z = deco() * nCells * CELL_DEPTH;
    const s = 0.5 + deco() * 1.3;
    const m = new THREE.Matrix4().makeScale(s, s, s);
    m.premultiply(new THREE.Matrix4().makeTranslation(side * (3.8 + deco() * 4.5), GROUND_Y + 0.8 * s - 0.4, z));
    veg.setMatrixAt(k, m);
  }
  veg.count = nVeg;
  scene.add(veg);

  const leafGeo = new THREE.ConeGeometry(1.1, 2.6, 6);
  const trees = new THREE.InstancedMesh(leafGeo, mats.foliageAlt, Math.max(1, Math.floor(nVeg / 3)));
  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.24, 1.6, 5);
  const trunks = new THREE.InstancedMesh(trunkGeo, mats.trunk, Math.max(1, Math.floor(nVeg / 3)));
  const nTrees = Math.floor(nVeg / 3);
  for (let k = 0; k < nTrees; k++) {
    const side = k % 2 === 0 ? -1 : 1;
    const z = deco() * nCells * CELL_DEPTH;
    const x = side * (5.5 + deco() * 5);
    const s = 0.9 + deco() * 1.1;
    let m = new THREE.Matrix4().makeScale(s, s, s);
    m.premultiply(new THREE.Matrix4().makeTranslation(x, GROUND_Y + 1.6 + 1.3 * s, z));
    trees.setMatrixAt(k, m);
    m = new THREE.Matrix4().makeTranslation(x, GROUND_Y + 0.8, z);
    trunks.setMatrixAt(k, m);
  }
  trees.count = nTrees;
  trunks.count = nTrees;
  trees.castShadow = q.shadows;
  scene.add(trees, trunks);

  // player: body + head, reused forever
  const player = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.6, 3, 8), mats.player);
  body.position.y = 0.75;
  body.castShadow = true;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 8), mats.playerAccent);
  head.position.y = 1.45;
  player.add(body, head);
  scene.add(player);
  R.player = player;

  R.pools = { tiles, bars, vines, relics, arrows, strips, pillars, veg, trees, trunks, mats, relicMat: mats.relic, base, baseGeo };
  resize(R, R.canvas.clientWidth || 640, R.canvas.clientHeight || 480);
  return scene;
}

// --- per-frame update -------------------------------------------------------------
const tmpM = new THREE.Matrix4();
const ZERO_SCALE = new THREE.Matrix4().makeScale(0.001, 0.001, 0.001);

export function updateFrame(R, state, alpha, dt) {
  if (!R.scene || !R.player || R.contextLost || R.disposed) return;
  const q = QUALITY_TIERS[R.quality];

  const distUnits = state.distUnits;
  const z = (distUnits / UNITS_PER_CELL) * CELL_DEPTH;
  const x = LANE_X[state.lane];

  // player pose from sim state
  let y = GROUND_Y;
  if (state.airTicks > 0) {
    const total = Math.max(1, Math.ceil((3 * UNITS_PER_CELL) / state.speed));
    const t = 1 - state.airTicks / total;
    y += Math.sin(t * Math.PI) * 1.6;
  }
  R.player.position.set(x, y, z);
  R.player.scale.y = state.slideTicks > 0 ? 0.45 : 1;
  if (!R.reducedMotion) R.player.rotation.y = Math.sin(state.tick * 0.2) * 0.06;
  else R.player.rotation.y = 0;

  // relic collection: hide collected instances (cell list is authoritative)
  const relics = R.pools.relics;
  const cellOf = relics.userData.cellOf;
  let relicDirty = false;
  for (let k = 0; k < relics.count; k++) {
    const c = state.course.cells[cellOf[k]];
    const gone = !c || c.relicLane < 0;
    if (relics.userData['g' + k] !== gone) {
      relics.userData['g' + k] = gone;
      relics.getMatrixAt(k, tmpM);
      if (gone) {
        tmpM.multiply(ZERO_SCALE);
      }
      relics.setMatrixAt(k, tmpM);
      relicDirty = true;
    }
  }
  if (relicDirty) relics.instanceMatrix.needsUpdate = true;

  // camera: smoothed follow, interruptible; reduced motion = no shake
  const targetX = x * CAMERA.lateralFollow;
  const targetY = CAMERA.height + (state.airTicks > 0 ? 0.4 : 0);
  const targetZ = z - CAMERA.back;
  const k = 1 - Math.exp(-CAMERA.damp * dt);
  R.camPos.x += (targetX - R.camPos.x) * k;
  R.camPos.y += (targetY - R.camPos.y) * k;
  R.camPos.z += (targetZ - R.camPos.z) * k;
  if (R.shakeAmp > 0 && !R.reducedMotion) {
    R.camPos.x += (Math.random() - 0.5) * R.shakeAmp;
    R.camPos.y += (Math.random() - 0.5) * R.shakeAmp;
    R.shakeAmp = Math.max(0, R.shakeAmp - dt * 2);
  }
  R.camera.position.copy(R.camPos);
  R.camera.lookAt(x * 0.6, GROUND_Y + 1.0, z + CAMERA.lookAhead);
}

export function addShake(R, amp) {
  if (!R.reducedMotion) R.shakeAmp = Math.min(0.4, amp);
}

export function render(R) {
  if (!R.scene || R.contextLost || R.disposed) return;
  R.renderer.render(R.scene, R.camera);
}

// --- disposal ---------------------------------------------------------------------
function disposeScene(R) {
  if (!R.scene) return;
  R.scene.traverse((o) => {
    if (o.isMesh || o.isInstancedMesh) {
      if (o.geometry) o.geometry.dispose();
      const m = o.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else if (m) m.dispose();
    }
  });
  R.scene = null;
  R.player = null;
  R.pools = null;
}

export function disposeRenderer(R) {
  disposeScene(R);
  R.disposed = true;
  R.renderer.dispose();
}
