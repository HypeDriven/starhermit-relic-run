// Relic Run - Three.js renderer: lush overgrown ruins.
// Pooled/instanced meshes only - no per-frame geometry/material allocation.
// Graphics quality comes from gfx.js (presets + per-category overrides) and is
// applied live through setGraphics().
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mulberry32, UNITS_PER_CELL, LANES } from './rules.js';
import { detectPreset, describe, resolve, SHADOW_MAP } from './gfx.js';

// The chase camera looks toward +Z, so positive world X is screen-left.
const LANE_SPACING = 2.2;
export const LANE_X = [LANE_SPACING, 0, -LANE_SPACING];
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

// foliage density tiers (vegetation per side, pillar spacing in cells)
const FOLIAGE = {
  sparse: { vegetationPerSide: 40, pillarEvery: 6 },
  normal: { vegetationPerSide: 90, pillarEvery: 4 },
  dense: { vegetationPerSide: 160, pillarEvery: 3 },
};
const PARTICLES = { off: 0, low: 70, high: 200 };
const SHADOW_EXTENT = 14;

export class WebGLUnavailableError extends Error {
  constructor(msg) { super(msg); this.code = 'webgl-unavailable'; }
}

function isMobileDevice() {
  try {
    if (globalThis.matchMedia && globalThis.matchMedia('(pointer: coarse)').matches) return true;
  } catch { /* ignore */ }
  return /Mobi|Android|iPhone|iPad/i.test(globalThis.navigator ? navigator.userAgent : '');
}

function osReducedMotion() {
  try { return !!(globalThis.matchMedia && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { return false; }
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
  renderer.shadowMap.type = THREE.PCFShadowMap;

  let gpu = '';
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '');
  } catch { gpu = ''; }

  const R = {
    renderer,
    canvas,
    scene: null,
    camera: null,
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
    // graphics state
    gpu,
    detected: detectPreset(gpu, { mobile: isMobileDevice() }),
    saved: {},
    q: null,
    size: [canvas.clientWidth || 640, canvas.clientHeight || 480],
    pixelRatio: 0,
    adaptiveScale: 1,
    frames: [],
    fps: 0,
    composer: null,
    postKey: null,
    postFailed: false,
    lastTs: 0,
    time: 0,
    idleZ: 6,
    envTex: null,
    u: { uTime: { value: 0 }, uWind: { value: 0 } },
  };
  R.q = resolve(opts.gfx || {}, R.detected);
  applyShadowState(R);

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    R.contextLost = true;
  });
  canvas.addEventListener('webglcontextrestored', () => {
    R.contextLost = false;
    R.envTex = null;
    R.postKey = null;
    if (R.course) buildCourseScene(R, R.course, R.theme, R.decorSeed);
  });

  return R;
}

// --- graphics settings ------------------------------------------------------------
function motionOn(R) { return !R.reducedMotion && !osReducedMotion(); }

function applyShadowState(R) {
  const size = SHADOW_MAP[R.q.shadows];
  R.renderer.shadowMap.enabled = size > 0;
  const key = R.keyLight;
  if (!key) return;
  key.castShadow = size > 0;
  if (size > 0 && key.shadow.mapSize.x !== size) {
    key.shadow.mapSize.set(size, size);
    if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
  }
  if (R.pools) {
    const p = R.pools;
    const on = size > 0;
    p.bars.castShadow = on; p.pillars.castShadow = on; p.trees.castShadow = on;
    p.veg.castShadow = on && R.q.shadows === 'high';
    R.player.traverse((o) => { if (o.isMesh) o.castShadow = on; });
    R.scene.traverse((o) => {
      const m = o.material;
      if (m) (Array.isArray(m) ? m : [m]).forEach((x) => { x.needsUpdate = true; });
    });
  }
}

/** Apply saved graphics settings ({ preset, render_scale, adaptive, show_fps, <category> }) live. */
export function setGraphics(R, saved) {
  const json = JSON.stringify(saved || {});
  if (json === R.gfxJson) return; // an unrelated setting changed
  R.gfxJson = json;
  const prev = R.q;
  R.saved = { ...(saved || {}) };
  R.q = resolve(R.saved, R.detected);
  const q = R.q;
  applyShadowState(R);
  R.adaptiveScale = 1;
  R.frames = [];
  R.postKey = null; // rebuild the post chain on the next frame
  R.postFailed = false;
  R.u.uWind.value = q.wind === 'on' && motionOn(R) ? 1 : 0;
  if (R.course && (prev.foliage !== q.foliage || prev.detail !== q.detail)) {
    buildCourseScene(R, R.course, R.theme, R.decorSeed);
  } else if (R.scene && prev.particles !== q.particles) {
    buildParticles(R);
  }
  fpsVisible(q.showFps);
  if (globalThis.document && document.body) {
    document.body.dataset.gfxPreset = q.preset;
    document.body.dataset.gfxAuto = String(q.auto);
  }
}

/** What the Graphics panel shows: GPU, auto choice, resolved tiers, cost summary, fps. */
export function graphicsInfo(R) {
  const pr = R.pixelRatio || 1;
  const px = [Math.round(R.size[0] * pr), Math.round(R.size[1] * pr)];
  return {
    gpu: R.gpu || 'unknown GPU',
    detected: R.detected,
    resolved: R.q,
    pixels: px,
    summary: describe(R.q, px),
    fps: Math.round(R.fps || 0),
    adaptiveScale: Math.round(R.adaptiveScale * 100) / 100,
    postFailed: !!R.postFailed,
  };
}

function fpsVisible(on) {
  const el = globalThis.document && document.getElementById('fps-meter');
  if (el) el.hidden = !on;
}

export function setReducedMotion(R, v) {
  R.reducedMotion = !!v;
  R.u.uWind.value = R.q.wind === 'on' && motionOn(R) ? 1 : 0;
}
export function setColorblind(R, v) {
  R.colorblind = !!v;
  if (R.pools && R.pools.relicMat) {
    // colorblind-safe: fragments become bright cyan/white, risk route marked by shape
    R.pools.relicMat.color.set(v ? 0x9ff5ff : (R.theme ? R.theme.relic : 0x7fe3c0));
    R.pools.relicMat.emissive.set(v ? 0x2a6a77 : (R.theme ? R.theme.relic : 0x7fe3c0));
  }
}

export function resize(R, width, height) {
  R.size = [Math.max(1, width | 0), Math.max(1, height | 0)];
  if (!R.camera) return;
  R.camera.aspect = R.size[0] / R.size[1];
  R.camera.updateProjectionMatrix();
}

// --- procedural textures (detail: detailed) ----------------------------------------
function canvasTex(size, draw, repeat) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  if (repeat) t.repeat.set(repeat[0], repeat[1]);
  return t;
}

function speckle(g, s, rnd, n, lo, hi, rmax) {
  for (let i = 0; i < n; i++) {
    const v = lo + rnd() * (hi - lo);
    g.fillStyle = `rgba(${v},${v},${v * 0.97},${0.25 + rnd() * 0.35})`;
    const r = 1 + rnd() * rmax;
    g.beginPath(); g.arc(rnd() * s, rnd() * s, r, 0, Math.PI * 2); g.fill();
  }
}

function drawTile(seed) {
  return (g, s) => {
    const rnd = mulberry32(seed);
    g.fillStyle = '#e4e2d8'; g.fillRect(0, 0, s, s);
    speckle(g, s, rnd, 900, 175, 245, 5);
    // cracks
    g.strokeStyle = 'rgba(70,64,52,0.4)'; g.lineWidth = 1;
    for (let k = 0; k < 3; k++) {
      let x = rnd() * s, y = rnd() * s;
      g.beginPath(); g.moveTo(x, y);
      for (let j = 0; j < 7; j++) { x += (rnd() - 0.5) * 36; y += (rnd() - 0.2) * 30; g.lineTo(x, y); }
      g.stroke();
    }
    // moss creeping in from the edges, in soft clumps
    for (let i = 0; i < 14; i++) {
      const edge = rnd() * 4 | 0;
      const t = rnd() * s, d = rnd() * 18;
      const cx = edge === 0 ? d : edge === 1 ? s - d : t;
      const cy = edge === 2 ? d : edge === 3 ? s - d : t;
      for (let j = 0; j < 10; j++) {
        const x = cx + (rnd() - 0.5) * 34, y = cy + (rnd() - 0.5) * 34, r = 3 + rnd() * 8;
        const grad = g.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, `rgba(${80 + rnd() * 40},${140 + rnd() * 50},${60 + rnd() * 30},0.5)`);
        grad.addColorStop(1, 'rgba(90,150,70,0)');
        g.fillStyle = grad;
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      }
    }
    // bevelled edge: light inner rim, dark outer seam
    g.strokeStyle = 'rgba(255,255,245,0.35)'; g.lineWidth = 4; g.strokeRect(8, 8, s - 16, s - 16);
    g.strokeStyle = 'rgba(40,36,28,0.7)'; g.lineWidth = 6; g.strokeRect(0, 0, s, s);
  };
}

function drawBlocks(seed) {
  return (g, s) => {
    const rnd = mulberry32(seed);
    g.fillStyle = '#dcdad0'; g.fillRect(0, 0, s, s);
    speckle(g, s, rnd, 700, 170, 240, 4);
    g.strokeStyle = 'rgba(50,46,38,0.6)'; g.lineWidth = 3;
    const rows = 4;
    for (let r = 0; r <= rows; r++) {
      const y = (r / rows) * s;
      g.beginPath(); g.moveTo(0, y); g.lineTo(s, y); g.stroke();
      const off = r % 2 ? s / 4 : 0;
      for (let x = off; x < s; x += s / 2) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + s / rows); g.stroke(); }
    }
    for (let i = 0; i < 50; i++) {
      g.fillStyle = `rgba(${80 + rnd() * 40},${140 + rnd() * 50},${60 + rnd() * 30},0.45)`;
      g.beginPath(); g.arc(rnd() * s, s - rnd() * rnd() * s, 3 + rnd() * 8, 0, Math.PI * 2); g.fill();
    }
  };
}

function drawMoss(seed) {
  return (g, s) => {
    const rnd = mulberry32(seed);
    g.fillStyle = '#c8d0b8'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 600; i++) {
      const v = rnd();
      g.fillStyle = v < 0.5
        ? `rgba(${70 + rnd() * 40},${120 + rnd() * 60},${60 + rnd() * 30},0.4)`
        : `rgba(${150 + rnd() * 60},${150 + rnd() * 50},${130 + rnd() * 40},0.35)`;
      g.beginPath(); g.arc(rnd() * s, rnd() * s, 2 + rnd() * 10, 0, Math.PI * 2); g.fill();
    }
  };
}

function environmentTexture(R) {
  if (!R.envTex) {
    const pmrem = new THREE.PMREMGenerator(R.renderer);
    const room = new RoomEnvironment();
    R.envTex = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
  }
  return R.envTex;
}

// --- shaders ------------------------------------------------------------------------
const SKY_VERT = `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }`;
const SKY_FRAG = `
  uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uGlow; uniform vec3 uSunDir;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    float h = clamp(d.y, -1.0, 1.0);
    vec3 c = mix(uHorizon, uTop, smoothstep(0.0, 0.55, h));
    float sun = max(dot(d, normalize(uSunDir)), 0.0);
    c += uGlow * (pow(sun, 6.0) * 0.35 + pow(sun, 64.0) * 0.6) * smoothstep(-0.1, 0.2, h);
    c = mix(c, uHorizon, smoothstep(0.02, -0.2, h));
    gl_FragColor = vec4(c, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

const MOTE_VERT = `
  uniform float uTime; uniform vec3 uOrigin; uniform float uScale;
  attribute float aSeed;
  varying float vAlpha;
  void main() {
    vec3 p = position;
    float t = uTime;
    p.x += sin(t * 0.55 + aSeed * 6.283) * 0.7;
    p.y += sin(t * 0.8 + aSeed * 12.0) * 0.4;
    float z0 = uOrigin.z - 6.0;
    p.z = z0 + mod(p.z + t * 0.25 - z0, 44.0);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float edge = smoothstep(0.0, 4.0, p.z - z0) * smoothstep(44.0, 36.0, p.z - z0);
    float twinkle = 0.55 + 0.45 * sin(t * 2.7 + aSeed * 40.0);
    vAlpha = edge * twinkle * smoothstep(40.0, 12.0, -mv.z);
    gl_PointSize = (0.10 + 0.08 * fract(aSeed * 7.3)) * uScale / max(0.5, -mv.z);
    gl_Position = projectionMatrix * mv;
  }`;
const MOTE_FRAG = `
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float a = smoothstep(0.5, 0.0, length(c)) * vAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(uColor * 2.2 * a, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

// Colour grade + vignette, applied to the linear HDR frame before OutputPass tone-maps it.
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.24 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = src.rgb;
      vec3 lc = clamp(c, 0.0, 1.0);
      // gentle S-curve, a touch more saturation, warm highlights / cool-green shadows
      vec3 s = mix(lc, lc * lc * (3.0 - 2.0 * lc), 0.22);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.1);
      s *= mix(vec3(0.95, 1.0, 1.02), vec3(1.04, 1.01, 0.95), smoothstep(0.2, 0.8, l));
      s = s * 0.975 + 0.018;
      c = mix(c, s + max(c - 1.0, 0.0), uAmount);
      float d = length(vUv - 0.5);
      c *= 1.0 - uVignette * smoothstep(0.38, 0.9, d);
      gl_FragColor = vec4(c, src.a);
    }`,
};

function addWind(R, mat) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = R.u.uTime;
    shader.uniforms.uWind = R.u.uWind;
    shader.vertexShader = 'uniform float uTime;\nuniform float uWind;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
      #else
        vec3 ip = vec3(0.0);
      #endif
      float hw = max(position.y + 0.8, 0.0);
      transformed.x += sin(uTime * 1.6 + ip.z * 0.35 + ip.x * 0.7) * 0.07 * hw * uWind;
      transformed.z += cos(uTime * 1.2 + ip.x * 0.5) * 0.045 * hw * uWind;`,
    );
  };
  mat.customProgramCacheKey = () => 'relic-wind';
}

// --- scene construction ---------------------------------------------------------
export function buildCourseScene(R, course, theme, seed) {
  disposeScene(R);
  R.course = course;
  R.theme = theme;
  R.decorSeed = seed >>> 0;
  const q = R.q;
  const fol = FOLIAGE[q.foliage] || FOLIAGE.normal;
  const detailed = q.detail === 'detailed';
  const shadowsOn = SHADOW_MAP[q.shadows] > 0;
  const cells = course.cells;
  const nCells = cells.length;
  const textures = [];
  R.sceneTextures = textures;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(theme.sky);
  scene.fog = new THREE.FogExp2(theme.fog, theme.fogDensity);
  if (detailed) {
    scene.environment = environmentTexture(R);
    scene.environmentIntensity = 0.4;
  }
  R.scene = scene;

  R.camera = new THREE.PerspectiveCamera(CAMERA.fov, 4 / 3, 0.1, 120);
  R.camera.position.set(0, CAMERA.height, -CAMERA.back);

  // lighting: warm key (shadow box follows the runner) + hemisphere fill (+ cool rim when detailed)
  const hemi = new THREE.HemisphereLight(theme.sky, theme.stoneDark, detailed ? 0.75 : 0.9);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffe6b8, 2.2);
  key.position.set(-6, 10, -4);
  key.castShadow = shadowsOn;
  const sm = SHADOW_MAP[q.shadows] || 1024;
  key.shadow.mapSize.set(sm, sm);
  Object.assign(key.shadow.camera, { left: -SHADOW_EXTENT, right: SHADOW_EXTENT, top: SHADOW_EXTENT, bottom: -SHADOW_EXTENT, near: 1, far: 50 });
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.03;
  scene.add(key, key.target);
  R.keyLight = key;
  if (detailed) {
    const rim = new THREE.DirectionalLight(0xbfe0ff, 0.45);
    rim.position.set(7, 5, 12);
    scene.add(rim);
  }

  let mats;
  if (detailed) {
    const tileTex = canvasTex(256, drawTile(R.decorSeed ^ 0x51));
    const blockTex = canvasTex(256, drawBlocks(R.decorSeed ^ 0x77), [2, 1]);
    const mossTex = canvasTex(256, drawMoss(R.decorSeed ^ 0x99), [6, Math.max(1, nCells / 3)]);
    textures.push(tileTex, blockTex, mossTex);
    mats = {
      stone: new THREE.MeshStandardMaterial({ color: theme.stone, map: tileTex, bumpMap: tileTex, bumpScale: 1.2, roughness: 0.85 }),
      pillarStone: new THREE.MeshStandardMaterial({ color: theme.stone, map: blockTex, bumpMap: blockTex, bumpScale: 1.5, roughness: 0.9 }),
      stoneDark: new THREE.MeshStandardMaterial({ color: theme.stoneDark, map: mossTex, roughness: 1.0 }),
      foliage: new THREE.MeshStandardMaterial({ color: theme.foliage, roughness: 0.8, flatShading: true }),
      foliageAlt: new THREE.MeshStandardMaterial({ color: theme.foliageAlt, roughness: 0.8, flatShading: true }),
      trunk: new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 1.0 }),
      relic: new THREE.MeshPhysicalMaterial({
        color: R.colorblind ? 0x9ff5ff : theme.relic,
        emissive: R.colorblind ? 0x2a6a77 : theme.relic, emissiveIntensity: 0.9,
        roughness: 0.12, metalness: 0.0, clearcoat: 1.0, clearcoatRoughness: 0.06, envMapIntensity: 1.6,
      }),
      barrier: new THREE.MeshStandardMaterial({ color: 0x6b4f2e, map: blockTex, bumpMap: blockTex, bumpScale: 1.0, roughness: 0.95 }),
      branch: new THREE.MeshStandardMaterial({ color: theme.accent, emissive: theme.accent, emissiveIntensity: 0.6, roughness: 0.35 }),
      risk: new THREE.MeshStandardMaterial({ color: 0xff8c5a, emissive: 0xb04018, emissiveIntensity: 0.5 }),
      player: new THREE.MeshPhysicalMaterial({ color: 0xf0e2c0, roughness: 0.55, sheen: 0.6, sheenColor: 0xfff2d0 }),
      playerAccent: new THREE.MeshStandardMaterial({ color: 0x3a6a4f, roughness: 0.45 }),
      lantern: new THREE.MeshStandardMaterial({ color: 0xffd98a, emissive: 0xffc860, emissiveIntensity: 2.2 }),
    };
  } else {
    mats = {
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
    mats.pillarStone = mats.stone;
  }
  addWind(R, mats.foliage);
  addWind(R, mats.foliageAlt);
  R.u.uWind.value = q.wind === 'on' && motionOn(R) ? 1 : 0;

  const tint = new THREE.Color();
  const deco = mulberry32((R.decorSeed ^ 0xdec0) >>> 0);
  const tintRnd = mulberry32((R.decorSeed ^ 0x7117) >>> 0); // separate stream: layout stays identical across detail tiers
  const vary = (mesh, idx, lo, hi, hueJitter = 0) => {
    if (!detailed) return;
    const v = lo + tintRnd() * (hi - lo);
    tint.setRGB(v, v, v);
    if (hueJitter) tint.offsetHSL((tintRnd() - 0.5) * hueJitter, (tintRnd() - 0.5) * 0.1, 0);
    mesh.setColorAt(idx, tint);
  };

  // sky dome with a soft horizon haze (detailed); flat background otherwise
  if (detailed) {
    const skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        uTop: { value: new THREE.Color(theme.sky).lerp(new THREE.Color(0x3d6e8a), 0.35) },
        uHorizon: { value: new THREE.Color(theme.fog) },
        uGlow: { value: new THREE.Color(0xfff0c8) },
        uSunDir: { value: new THREE.Vector3(-0.35, 0.3, 1) },
      },
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(90, 32, 16), skyMat);
    sky.frustumCulled = false;
    sky.renderOrder = -1;
    scene.add(sky);
    R.sky = sky;
  } else {
    R.sky = null;
  }

  // ground base plane (under everything, visible through gaps)
  const baseGeo = new THREE.PlaneGeometry(80, nCells * CELL_DEPTH + 80);
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
  const tiles = new THREE.InstancedMesh(tileGeo, mats.stone, Math.max(1, tilePositions.length));
  const m4 = new THREE.Matrix4();
  tilePositions.forEach((p, idx) => {
    m4.makeTranslation(p[0], p[1], p[2]);
    tiles.setMatrixAt(idx, m4);
    vary(tiles, idx, 0.86, 1.06, 0.03);
  });
  tiles.count = tilePositions.length;
  tiles.receiveShadow = true;
  scene.add(tiles);

  // low barriers
  const lowCells = [];
  for (let i = 0; i < nCells; i++) if (cells[i].low) lowCells.push(i);
  const barGeo = new THREE.BoxGeometry(LANE_SPACING * LANES, 1.0, 0.4);
  const bars = new THREE.InstancedMesh(barGeo, mats.barrier, Math.max(1, lowCells.length));
  lowCells.forEach((ci, idx) => {
    m4.makeTranslation(0, GROUND_Y + 1.1, ci * CELL_DEPTH);
    bars.setMatrixAt(idx, m4);
  });
  bars.castShadow = shadowsOn;
  bars.receiveShadow = detailed;
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
  relics.userData.base = relicCells.map((ci) => [LANE_X[cells[ci].relicLane], GROUND_Y + 0.9, ci * CELL_DEPTH]);
  relics.userData.gone = relicCells.map(() => false);
  relicCells.forEach((ci, idx) => {
    const b = relics.userData.base[idx];
    m4.makeTranslation(b[0], b[1], b[2]);
    relics.setMatrixAt(idx, m4);
  });
  relics.count = relicCells.length;
  relics.castShadow = detailed && shadowsOn;
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
      m4.makeTranslation(LANE_X[2] - 0.4, GROUND_Y + 0.03, (b + k) * CELL_DEPTH);
      strips.setMatrixAt(si++, m4);
    }
  }
  strips.count = si;
  scene.add(strips);

  // decoration: pillars + vegetation, from the deterministic decoration stream
  const pillarGeo = new THREE.CylinderGeometry(0.45, 0.55, 3.4, detailed ? 10 : 7);
  const nPillars = Math.floor(nCells / fol.pillarEvery) * 2;
  const pillars = new THREE.InstancedMesh(pillarGeo, mats.pillarStone, Math.max(1, nPillars));
  let pi = 0;
  for (let i = 4; i < nCells && pi < nPillars; i += fol.pillarEvery) {
    for (const side of [-1, 1]) {
      const h = 0.6 + deco() * 0.5; // crumbling height variance
      const m = new THREE.Matrix4().makeScale(1, h, 1);
      m.premultiply(new THREE.Matrix4().makeTranslation(side * (4.6 + deco() * 1.2), GROUND_Y + 1.7 * h, i * CELL_DEPTH + (deco() - 0.5)));
      vary(pillars, pi, 0.8, 1.05, 0.02);
      pillars.setMatrixAt(pi++, m);
    }
  }
  pillars.count = pi;
  pillars.castShadow = shadowsOn;
  pillars.receiveShadow = detailed;
  scene.add(pillars);

  const bushGeo = new THREE.ConeGeometry(0.9, 1.6, detailed ? 7 : 6, detailed ? 2 : 1);
  const nVeg = fol.vegetationPerSide * 2;
  const veg = new THREE.InstancedMesh(bushGeo, mats.foliage, Math.max(1, nVeg));
  for (let k = 0; k < nVeg; k++) {
    const side = k % 2 === 0 ? -1 : 1;
    const z = deco() * nCells * CELL_DEPTH;
    const s = 0.5 + deco() * 1.3;
    const m = new THREE.Matrix4().makeScale(s, s, s);
    m.premultiply(new THREE.Matrix4().makeTranslation(side * (3.8 + deco() * 4.5), GROUND_Y + 0.8 * s - 0.4, z));
    veg.setMatrixAt(k, m);
    vary(veg, k, 0.75, 1.15, 0.06);
  }
  veg.count = nVeg;
  veg.castShadow = q.shadows === 'high';
  scene.add(veg);

  const leafGeo = new THREE.ConeGeometry(1.1, 2.6, detailed ? 8 : 6, detailed ? 3 : 1);
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
    vary(trees, k, 0.75, 1.15, 0.07);
    m = new THREE.Matrix4().makeTranslation(x, GROUND_Y + 0.8, z);
    trunks.setMatrixAt(k, m);
  }
  trees.count = nTrees;
  trunks.count = nTrees;
  trees.castShadow = shadowsOn;
  scene.add(trees, trunks);

  // player: body + head (+ satchel and lantern when detailed), reused forever
  const player = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.6, detailed ? 6 : 3, detailed ? 16 : 8), mats.player);
  body.position.y = 0.75;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, detailed ? 20 : 10, detailed ? 14 : 8), mats.playerAccent);
  head.position.y = 1.45;
  player.add(body, head);
  if (detailed) {
    const satchel = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 10), mats.trunk);
    satchel.scale.set(1.1, 1.25, 0.6);
    satchel.position.set(0, 0.92, -0.3);
    const lantern = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 8), mats.lantern);
    lantern.position.set(0.36, 0.72, 0.12);
    player.add(satchel, lantern);
  }
  player.traverse((o) => { if (o.isMesh) o.castShadow = shadowsOn; });
  scene.add(player);
  R.player = player;

  R.pools = { tiles, bars, vines, relics, arrows, strips, pillars, veg, trees, trunks, mats, relicMat: mats.relic, base, baseGeo };
  buildParticles(R);
  placeKeyLight(R, 0);
  resize(R, R.size[0], R.size[1]);
  R.postKey = null; // passes hold scene/camera references
  return scene;
}

// fireflies / pollen motes: one Points draw, animated entirely on the GPU
function buildParticles(R) {
  if (R.motes) {
    R.scene && R.scene.remove(R.motes);
    R.motes.geometry.dispose();
    R.motes.material.dispose();
    R.motes = null;
  }
  const n = PARTICLES[R.q.particles] || 0;
  if (!n || !R.scene) return;
  const rnd = mulberry32((R.decorSeed ^ 0xf1f1) >>> 0);
  const pos = new Float32Array(n * 3);
  const seed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const side = rnd() < 0.5 ? -1 : 1;
    pos[i * 3] = rnd() < 0.3 ? (rnd() - 0.5) * 7 : side * (3.2 + rnd() * 7);
    pos[i * 3 + 1] = 0.4 + rnd() * 4.5;
    pos[i * 3 + 2] = rnd() * 44;
    seed[i] = rnd();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const mat = new THREE.ShaderMaterial({
    vertexShader: MOTE_VERT, fragmentShader: MOTE_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: R.u.uTime, uOrigin: { value: new THREE.Vector3() }, uScale: { value: 600 },
      uColor: { value: new THREE.Color(R.theme.accent).lerp(new THREE.Color(0xfff6c0), 0.5) },
    },
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  R.scene.add(pts);
  R.motes = pts;
}

function placeKeyLight(R, focusZ) {
  const key = R.keyLight;
  if (!key) return;
  // fit the shadow box to the visible stretch of track ahead of the runner and
  // snap to whole texels so the shadows do not shimmer as the camera advances
  const texel = (SHADOW_EXTENT * 2) / (key.shadow.mapSize.x || 1024);
  const zc = Math.round((focusZ + 9) / texel) * texel;
  key.target.position.set(0, 0, zc);
  key.position.set(-6, 10, zc - 4);
  key.target.updateMatrixWorld();
}

// --- per-frame update -------------------------------------------------------------
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function writeRelic(relics, k, t, animate) {
  const b = relics.userData.base[k];
  if (relics.userData.gone[k]) {
    tmpM.makeScale(0.001, 0.001, 0.001);
    tmpM.setPosition(b[0], b[1], b[2]);
  } else if (animate) {
    tmpQ.setFromAxisAngle(UP, t * 1.4 + k * 0.7);
    tmpV.set(b[0], b[1] + Math.sin(t * 2.2 + k) * 0.1, b[2]);
    tmpS.set(1, 1, 1);
    tmpM.compose(tmpV, tmpQ, tmpS);
  } else {
    tmpM.makeTranslation(b[0], b[1], b[2]);
  }
  relics.setMatrixAt(k, tmpM);
}

function animateAmbient(R, dt, focusZ) {
  const moving = motionOn(R);
  if (moving) R.time += dt;
  R.u.uTime.value = R.time;
  const detailed = R.q.detail === 'detailed';
  if (R.motes) R.motes.material.uniforms.uOrigin.value.set(0, 0, focusZ);
  if (R.sky) R.sky.position.copy(R.camera.position);
  if (detailed && R.pools) {
    R.pools.mats.branch.emissiveIntensity = 0.45 + (moving ? 0.35 * (0.5 + 0.5 * Math.sin(R.time * 3)) : 0.2);
  }
  placeKeyLight(R, focusZ);
}

export function updateFrame(R, state, alpha, dt) {
  if (!R.scene || !R.player || R.contextLost || R.disposed) return;

  const distUnits = state.distUnits;
  const z = (distUnits / UNITS_PER_CELL) * CELL_DEPTH;
  const x = LANE_X[state.lane];
  const moving = motionOn(R);
  const detailed = R.q.detail === 'detailed';

  // player pose from sim state
  let y = GROUND_Y;
  if (state.airTicks > 0) {
    const total = Math.max(1, Math.ceil((3 * UNITS_PER_CELL) / state.speed));
    const t = 1 - state.airTicks / total;
    y += Math.sin(t * Math.PI) * 1.6;
  } else if (detailed && moving && state.slideTicks === 0 && !state.terminal) {
    y += Math.abs(Math.sin(state.tick * 0.35)) * 0.06; // running stride bob
  }
  R.player.position.set(x, y, z);
  R.player.scale.y = state.slideTicks > 0 ? 0.45 : 1;
  if (!R.reducedMotion) R.player.rotation.y = Math.sin(state.tick * 0.2) * 0.06;
  else R.player.rotation.y = 0;

  // relic collection: hide collected instances (cell list is authoritative);
  // detailed + motion: relics spin and bob in place
  const relics = R.pools.relics;
  const cellOf = relics.userData.cellOf;
  const gone = relics.userData.gone;
  const animate = detailed && moving;
  let relicDirty = false;
  for (let k = 0; k < relics.count; k++) {
    const c = state.course.cells[cellOf[k]];
    const g = !c || c.relicLane < 0;
    const changed = gone[k] !== g;
    gone[k] = g;
    if (changed || (animate && !g && Math.abs(relics.userData.base[k][2] - z) < 60)) {
      writeRelic(relics, k, R.time, animate);
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
  animateAmbient(R, dt, z);
  R.idleZ = Math.max(6, z);
}

// Title/menu backdrop: a slow glide along the course (static under reduced motion).
export function updateIdle(R, dt) {
  if (!R.scene || !R.player || R.contextLost || R.disposed || !R.course) return;
  const len = R.course.cells.length * CELL_DEPTH;
  if (motionOn(R)) R.idleZ += dt * 1.6;
  if (R.idleZ > len - 30) R.idleZ = 6;
  const z = R.idleZ;
  R.player.position.set(0, GROUND_Y, z);
  R.player.scale.y = 1;
  R.camPos.set(Math.sin(R.time * 0.15) * 0.8, CAMERA.height, z - CAMERA.back);
  R.camera.position.copy(R.camPos);
  R.camera.lookAt(0, GROUND_Y + 1.0, z + CAMERA.lookAhead);
  animateAmbient(R, dt, z);
}

export function addShake(R, amp) {
  if (!R.reducedMotion) R.shakeAmp = Math.min(0.4, amp);
}

// --- post-processing + frame --------------------------------------------------------
function postKey(R) {
  const q = R.q;
  return q.post ? [q.ao, q.bloom, q.grade, q.antialias, R.size[0], R.size[1], R.pixelRatio].join('|') : 'none';
}

function buildPost(R) {
  const q = R.q;
  if (R.composer) { R.composer.renderTarget1.dispose(); R.composer.renderTarget2.dispose(); R.composer.dispose(); }
  R.composer = null;
  if (!q.post || !R.scene) return;
  const [w, h] = R.size;
  const pr = R.pixelRatio;
  try {
    const target = new THREE.WebGLRenderTarget(w * pr, h * pr, {
      type: THREE.HalfFloatType, samples: q.antialias === 'msaa' ? 4 : 0,
    });
    const composer = new EffectComposer(R.renderer, target);
    composer.setPixelRatio(pr);
    composer.setSize(w, h);
    composer.addPass(new RenderPass(R.scene, R.camera));
    if (q.ao !== 'off') {
      const ao = new GTAOPass(R.scene, R.camera, w * pr, h * pr);
      ao.output = GTAOPass.OUTPUT.Default;
      ao.blendIntensity = 0.7;
      ao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.5, thickness: 1.5, scale: 1.0, samples: q.ao === 'high' ? 16 : 8 });
      ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: q.ao === 'high' ? 6 : 4, rings: 2, samples: q.ao === 'high' ? 16 : 8 });
      composer.addPass(ao);
    }
    if (q.bloom === 'on') {
      // high threshold: only relics, the lantern, fork markers and fireflies bloom
      composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.55, 0.4, 0.9));
    }
    if (q.grade === 'on') composer.addPass(new ShaderPass(GradeShader));
    composer.addPass(new OutputPass());
    if (q.antialias === 'smaa') composer.addPass(new SMAAPass());
    if (q.antialias === 'fxaa') composer.addPass(new FXAAPass());
    composer.setSize(w, h); // sizes the AA passes
    R.composer = composer;
  } catch (e) {
    // post-processing is an enhancement: render directly if the chain cannot be built
    R.postFailed = true;
    R.composer = null;
  }
}

// adaptive resolution: step the render scale down when frames are slow, back up when fast
function adapt(R, dt) {
  const f = R.frames;
  f.push(dt);
  if (f.length < 90) return false;
  const avg = f.reduce((a, b) => a + b, 0) / f.length;
  f.length = 0;
  R.fps = 1000 / avg;
  const el = globalThis.document && document.getElementById('fps-meter');
  if (el && !el.hidden) el.textContent = `${Math.round(R.fps)} fps`;
  if (!R.q.adaptive) {
    if (R.adaptiveScale !== 1) { R.adaptiveScale = 1; return true; }
    return false;
  }
  const before = R.adaptiveScale;
  if (avg > 26) R.adaptiveScale = Math.max(0.6, R.adaptiveScale - 0.1);
  else if (avg < 14 && R.adaptiveScale < 1) R.adaptiveScale = Math.min(1, R.adaptiveScale + 0.05);
  return before !== R.adaptiveScale;
}

export function render(R) {
  if (!R.scene || R.contextLost || R.disposed) return;
  const now = performance.now();
  const dt = R.lastTs ? Math.min(250, now - R.lastTs) : 16;
  R.lastTs = now;
  adapt(R, dt);
  const q = R.q;
  const dpr = Math.min(globalThis.devicePixelRatio || 1, q.cap);
  const ratio = Math.max(0.25, dpr * q.scale * R.adaptiveScale);
  const [w, h] = R.size;
  const cur = R.renderer.getSize(tmpSize);
  if (ratio !== R.pixelRatio || cur.x !== w || cur.y !== h) {
    R.pixelRatio = ratio;
    R.renderer.setPixelRatio(ratio);
    R.renderer.setSize(w, h, false);
  }
  if (R.motes) R.motes.material.uniforms.uScale.value = h * ratio * 0.9;
  const key = postKey(R);
  if (key !== R.postKey) {
    R.postKey = key;
    buildPost(R);
  }
  if (R.composer) {
    try {
      R.composer.render(dt / 1000);
      return;
    } catch (e) {
      R.postFailed = true;
      R.composer = null;
    }
  }
  R.renderer.render(R.scene, R.camera);
}
const tmpSize = new THREE.Vector2();

// --- disposal ---------------------------------------------------------------------
function disposeScene(R) {
  if (!R.scene) return;
  if (R.motes) { R.motes.geometry.dispose(); R.motes.material.dispose(); R.motes = null; }
  R.scene.traverse((o) => {
    if (o.isMesh || o.isInstancedMesh) {
      if (o.geometry) o.geometry.dispose();
      const m = o.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else if (m) m.dispose();
    }
  });
  for (const t of R.sceneTextures || []) t.dispose();
  R.sceneTextures = [];
  R.scene = null;
  R.player = null;
  R.pools = null;
  R.sky = null;
}

export function disposeRenderer(R) {
  disposeScene(R);
  if (R.composer) R.composer.dispose();
  if (R.envTex) R.envTex.dispose();
  R.disposed = true;
  R.renderer.dispose();
}
