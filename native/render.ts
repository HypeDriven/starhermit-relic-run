// The overgrown ruins on starhermit:scene, as the browser build's src/render.js
// drew them with three.js r185: the theme's sky colour and exponential fog,
// the sky dome with its horizon haze and sun glow (detailed; WGSL), the base
// plane under the gaps, the instanced stone tiles (one a lane a cell, none over
// gaps), the barrier walls with their vine drapes, the spinning relic
// fragments, the twin fork arrows, the risk-route strips, crumbling pillars,
// bushes and trees swaying in the wind (detailed: a vertex hook), fireflies,
// and the runner — body, head and, detailed, satchel and lantern — with the
// damped chase camera, the barrier shake and the slow glide behind the menus.
//
// From three.js r185: punctual light intensities are the page's (minor 23+);
// the RoomEnvironment reflections are r185's (the renderer's room,
// moved down 3.5 m as r183+ does) at the old environmentIntensity 0.4; the sky
// ShaderMaterial is WGSL and the foliage's onBeforeCompile wind a material
// hook; the GPU-animated Points motes are instanced camera-facing quads (Points
// take no shaders) of the same size and motion; the post chain (GTAOPass,
// UnrealBloomPass threshold 0.9, the grade shader, FXAA / SMAA / MSAA) is
// renderer.ao / bloom / grade / antialias; the key light's fitted 28 m shadow
// box is the page's own, snapped to texels; the canvas-painted stone,
// block and moss textures are baked PNGs (tools/bake-textures.mjs). The canvas
// between the old rails is a view offset of the window. Cosmetic randomness
// never touches the rules.
import {
  ACESFilmicToneMapping, AdditiveBlending, BackSide, BoxGeometry, CapsuleGeometry, Color, ConeGeometry, CylinderGeometry, DirectionalLight, DynamicDrawUsage,
  FogExp2, Group, HemisphereLight, InstancedMesh, Matrix4, Mesh, MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial,
  OctahedronGeometry, PerspectiveCamera, OrthographicCamera, PlaneGeometry, PMREMGenerator, Quaternion, RepeatWrapping, RoomEnvironment, ShaderMaterial,
  SphereGeometry, SRGBColorSpace, TextureLoader, Vector3, Vector4, renderer, scene, type Material, type MaterialHooks, type Object3D, type Texture,
} from "starhermit:scene";
import { Rules, type State, type Theme, type Cell } from "./game.ts";
import { mulberry32 } from "../src/rules.js";
import { MOTE_MAX, type Look } from "./quality.ts";

const PI = Math.PI;
const rand = mulberry32 as (seed: number) => () => number;
const { UNITS_PER_CELL, LANES } = Rules;
// The chase camera looks toward +Z, so positive world X is screen-left.
const LANE_SPACING = 2.2;
const LANE_X = [LANE_SPACING, 0, -LANE_SPACING];
const CELL_DEPTH = 2.0;
const GROUND_Y = 0;
export const CAMERA = { fov: 50, back: 7.5, height: 4.2, lookAhead: 6.0, lateralFollow: 0.45, damp: 6.0 };
const FOLIAGE = {
  sparse: { vegetationPerSide: 40, pillarEvery: 6 },
  normal: { vegetationPerSide: 90, pillarEvery: 4 },
  dense: { vegetationPerSide: 160, pillarEvery: 3 },
};

// -- renderer, camera ---------------------------------------------------------------------------
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const camera = new PerspectiveCamera(CAMERA.fov, 4 / 3, 0.1, 120);
camera.position.set(0, CAMERA.height, -CAMERA.back);
renderer.camera = camera;

// -- state --------------------------------------------------------------------------------------
let look: Look | null = null;
let reducedMotion = false;
let colorblind = false;
let theme: Theme | null = null;
let cells: Cell[] | null = null;
let decorSeed = 0;
let world: Group | null = null;
let keyLight: DirectionalLight | null = null;
let envTex: Texture | null = null;
let sky: Mesh | null = null;
let player: Group | null = null;
let motes: InstancedMesh | null = null;
interface Pools {
  relics: InstancedMesh; relicBase: [number, number, number][]; relicCell: number[]; relicGone: boolean[];
  relicMat: Material & { color: Color; emissive?: Color }; branchMat: Material & { emissiveIntensity?: number };
}
let pools: Pools | null = null;
const camPos = new Vector3(0, CAMERA.height, -CAMERA.back);
let shakeAmp = 0;
let time = 0;
let idleZ = 6;
const windU = { uTime: { value: 0 }, uWind: { value: 0 } };

const motionOn = (): boolean => !reducedMotion;
const detailed = (): boolean => !!look?.detailed;

// -- textures (baked; tools/bake-textures.mjs) ---------------------------------------------------
const loader = new TextureLoader();
const texCache = new Map<string, Texture>();
function tex(name: "tile" | "blocks" | "moss", size: number): Texture {
  const key = `${name}-${size}`;
  let t = texCache.get(key);
  if (!t) {
    t = loader.load(`assets/textures/${key}.png`, undefined, undefined, (e: unknown) => console.warn(`texture ${key}: ${e instanceof Error ? e.message : String(e)}`));
    t.colorSpace = SRGBColorSpace;
    t.wrapS = t.wrapT = RepeatWrapping;
    t.anisotropy = 4;
    texCache.set(key, t);
  }
  return t;
}
function environment(): Texture | null {
  if (envTex) return envTex;
  try {
    const room = new RoomEnvironment(renderer);
    room.position.y = -3.5; // three r183+
    envTex = new PMREMGenerator(renderer).fromScene(room, 0.04).texture;
  } catch (e) { console.warn("environment:", e instanceof Error ? e.message : String(e)); envTex = null; }
  return envTex;
}

// -- shaders ----------------------------------------------------------------------------------------
const SKY_FRAG = /* wgsl */ `
fn fragment(f: Fragment) -> vec4f {
  let d = normalize(f.world - camera_position());
  let h = clamp(d.y, -1.0, 1.0);
  var c = mix(uniforms.uHorizon, uniforms.uTop, smoothstep(0.0, 0.55, h));
  let sun = max(dot(d, normalize(uniforms.uSunDir)), 0.0);
  c = c + uniforms.uGlow * (pow(sun, 6.0) * 0.35 + pow(sun, 64.0) * 0.6) * smoothstep(-0.1, 0.2, h);
  c = mix(c, uniforms.uHorizon, 1.0 - smoothstep(-0.2, 0.02, h));
  return vec4f(c, 1.0);
}`;
/** addWind(): bushes and trees sway with height above their base (onBeforeCompile → a vertex hook). */
const WIND_VERT = /* wgsl */ `
fn vertex(v: Vertex) -> Vertex {
  var o = v;
  let ip = (model_matrix() * vec4f(0.0, 0.0, 0.0, 1.0)).xyz;
  let hw = max(v.position.y + 0.8, 0.0);
  o.position.x = v.position.x + sin(uniforms.uTime * 1.6 + ip.z * 0.35 + ip.x * 0.7) * 0.07 * hw * uniforms.uWind;
  o.position.z = v.position.z + cos(uniforms.uTime * 1.2 + ip.x * 0.5) * 0.045 * hw * uniforms.uWind;
  return o;
}`;
// MOTE_VERT / MOTE_FRAG: each mote's base point and seed in instanceCustom slot 0; its drift, wrap
// along the course, edge and distance fades and twinkle as before. gl_PointSize was
// (0.10 + 0.08 fract(seed 7.3)) × 0.9 × the drawing height / depth: a quad of that times
// 0.9 × 2 tan(fov / 2) world units draws the same size.
const MOTE_VERT = /* wgsl */ `
fn vertex(v: Vertex) -> Vertex {
  var o = v;
  let seed = v.instance.w;
  let t = uniforms.uTime;
  var p = v.instance.xyz;
  p.x = p.x + sin(t * 0.55 + seed * 6.283) * 0.7;
  p.y = p.y + sin(t * 0.8 + seed * 12.0) * 0.4;
  let z0 = uniforms.uOriginZ - 6.0;
  let rel = p.z + t * 0.25 - z0;
  p.z = z0 + (rel - 44.0 * floor(rel / 44.0));
  let toCam = normalize(camera_position() - p);
  let right = normalize(cross(vec3f(0.0, 1.0, 0.0), toCam));
  let up = cross(toCam, right);
  let size = (0.10 + 0.08 * fract(seed * 7.3)) * uniforms.uSize;
  let wp = p + (right * v.position.x + up * v.position.y) * size;
  o.clip = view_projection() * vec4f(wp, 1.0);
  let dz = p.z - z0;
  let edge = smoothstep(0.0, 4.0, dz) * (1.0 - smoothstep(36.0, 44.0, dz));
  let twinkle = 0.55 + 0.45 * sin(t * 2.7 + seed * 40.0);
  let depth = view_depth(p);
  o.v0 = vec4f(v.position.x + 0.5, v.position.y + 0.5, edge * twinkle * (1.0 - smoothstep(12.0, 40.0, depth)), 0.0);
  return o;
}`;
const MOTE_FRAG = /* wgsl */ `
fn fragment(f: Fragment) -> vec4f {
  let c = f.v0.xy - vec2f(0.5, 0.5);
  let a = (1.0 - smoothstep(0.0, 0.5, length(c))) * f.v0.z;
  if (a < 0.01) { discard; }
  return vec4f(uniforms.uColor * 2.2 * a, a);
}`;
const moteU = { uTime: windU.uTime, uOriginZ: { value: 0 }, uSize: { value: 0.9 * 2 * Math.tan((CAMERA.fov * PI) / 360) }, uColor: { value: new Color() } };

// -- materials -------------------------------------------------------------------------------------
type Std = MeshLambertMaterial | MeshStandardMaterial | MeshPhysicalMaterial;
interface SurfaceParams {
  color: number; map?: Texture; bumpMap?: Texture; bumpScale?: number; emissive?: number; emissiveIntensity?: number;
  roughness?: number; metalness?: number; clearcoat?: number; clearcoatRoughness?: number; sheen?: number; sheenColor?: number;
  envMapIntensity?: number; flatShading?: boolean;
}
/** Shading per the budget: Lambert on Low, standard on Balanced, physical (clear-coated relics, sheen tunic) on High / Ultra; bump maps where the budget allows. */
function surface(p: SurfaceParams): Std {
  const { roughness, metalness, clearcoat, clearcoatRoughness, sheen, sheenColor, envMapIntensity, bumpMap, bumpScale, ...base } = p;
  const bud = look!.budget;
  if (bud.material === "lambert") return new MeshLambertMaterial(base);
  const std: Record<string, unknown> = { ...base, roughness: roughness ?? 1, metalness: metalness ?? 0 };
  if (envMapIntensity !== undefined) std.envMapIntensity = envMapIntensity;
  if (bumpMap && bud.bump) Object.assign(std, { bumpMap, bumpScale });
  if (bud.material === "standard" || !(clearcoat || sheen)) return new MeshStandardMaterial(std);
  // sheen (the runner's tunic on High / Ultra) is not drawn by the engine: that tunic is a standard surface
  if (!clearcoat) { void sheenColor; return new MeshStandardMaterial(std); }
  return new MeshPhysicalMaterial({ ...std, clearcoat, clearcoatRoughness: clearcoatRoughness ?? 0 });
}
function addWind(m: Std): void {
  const hooks: MaterialHooks = { uniforms: windU, vertex: WIND_VERT };
  m.hooks = hooks;
}

function disposeTree(root: Object3D): void {
  root.traverse((o) => {
    const m = o as Mesh;
    if (m.geometry) m.geometry.dispose();
    if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x: Material) => x.dispose());
  });
}

// -- the look -----------------------------------------------------------------------------------------
function applyPost(): void {
  if (!look) return;
  renderer.shadowMap.enabled = look.shadows > 0;
  if (keyLight) {
    keyLight.castShadow = look.shadows > 0;
    if (look.shadows > 0) keyLight.shadow.mapSize = look.shadows;
  }
  const hi = look.ao === "high";
  renderer.ao = look.ao === "off" ? null : {
    blendIntensity: 0.7, radius: 0.9, distanceExponent: 1.5, thickness: 1.5, scale: 1.0, samples: hi ? 16 : 8, resolution: look.budget.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: hi ? 6 : 4, rings: 2, samples: hi ? 16 : 8 },
  };
  // high threshold: only relics, the lantern, fork markers and fireflies bloom
  renderer.bloom = look.bloom ? { strength: 0.55, radius: 0.4, threshold: 0.9, resolution: look.budget.bloomRes } : null;
  // GradeShader on the linear HDR before the output: a 0.22 S-curve, 1.1 saturation, cool-green shadows / warm highlights, the 0.24 vignette
  renderer.grade = look.grade ? {
    space: "linear", contrastCurve: "s", contrast: 0.22, saturation: 1.1, shadows: [0.95, 1.0, 1.02], highlights: [1.04, 1.01, 0.95], split: [0.2, 0.8],
    vignette: { amount: 0.24, inner: 0.38, outer: 0.9 },
    levels: [0.975, 0.018], // s * 0.975 + 0.018
    overRange: "keep", // minor 29: mix(c, s + max(c - 1, 0), amount) as the page's grade
  } : null;
  renderer.antialias = look.antialias;
}
function applyWind(): void { windU.uWind.value = look?.wind && motionOn() ? 1 : 0; }

/** A new look (graphics level): effects, then the course again when its assets changed (setGraphics). */
export function applyLook(next: Look): void {
  const prev = look;
  if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
  look = next;
  applyPost();
  applyWind();
  const rebuild = !prev || prev.foliage !== next.foliage || prev.detailed !== next.detailed || prev.budget.material !== next.budget.material ||
    prev.budget.texture !== next.budget.texture || prev.budget.bump !== next.budget.bump || prev.budget.seg !== next.budget.seg;
  if (cells && theme && rebuild) build();
  else if (prev && prev.moteCount !== next.moteCount) buildMotes();
}
export function setReducedMotion(on: boolean): void { reducedMotion = on; applyWind(); }
export function setColorblind(on: boolean): void {
  colorblind = on;
  if (pools && theme) {
    // colorblind-safe: fragments become bright cyan/white
    pools.relicMat.color.setHex(on ? 0x9ff5ff : theme.relic);
    pools.relicMat.emissive?.setHex(on ? 0x2a6a77 : theme.relic);
  }
}

// -- the course ----------------------------------------------------------------------------------------
/** buildCourseScene(course, theme, seed): the course's meshes; collected relics follow the state each frame. */
export function buildCourse(courseCells: Cell[], th: Theme, seed: number): void {
  cells = courseCells;
  theme = th;
  decorSeed = seed >>> 0;
  build();
}

function build(): void {
  if (!look || !cells || !theme) return;
  if (world) { scene.remove(world); disposeTree(world); }
  world = new Group();
  const th = theme, q = look, bud = q.budget, det = q.detailed;
  const fol = FOLIAGE[q.foliage];
  const shadowsOn = q.shadows > 0;
  const nCells = cells.length;

  scene.background = new Color(th.sky);
  scene.fog = new FogExp2(th.fog, th.fogDensity);
  scene.environment = det ? environment() : null;
  scene.environmentIntensity = 0.4;

  // lighting: warm key (its shadow follows the runner) + hemisphere fill (+ cool rim when detailed)
  world.add(new HemisphereLight(th.sky, th.stoneDark, det ? 0.75 : 0.9));
  const key = new DirectionalLight(0xffe6b8, 2.2);
  key.position.set(-6, 10, -4);
  key.castShadow = shadowsOn;
  if (shadowsOn) key.shadow.mapSize = q.shadows;
  // the page's fitted box: 28 m around the stretch ahead, near 1, far 50
  const cam = key.shadow.camera as OrthographicCamera;
  cam.left = -SHADOW_EXTENT; cam.right = SHADOW_EXTENT; cam.top = SHADOW_EXTENT; cam.bottom = -SHADOW_EXTENT;
  cam.near = 1; cam.far = 50;
  cam.updateProjectionMatrix();
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.03;
  world.add(key, key.target);
  keyLight = key;
  if (det) {
    const rim = new DirectionalLight(0xbfe0ff, 0.45);
    rim.position.set(7, 5, 12);
    world.add(rim);
  }

  const seg = (n: number, min = 3): number => Math.max(min, Math.round(n * bud.seg));
  let mats: Record<string, Std>;
  if (det) {
    const tileTex = tex("tile", bud.texture), blockTex = tex("blocks", bud.texture), mossTex = tex("moss", bud.texture);
    blockTex.repeat.set(2, 1);
    mossTex.repeat.set(6, Math.max(1, nCells / 3));
    mats = {
      stone: surface({ color: th.stone, map: tileTex, bumpMap: tileTex, bumpScale: 1.2, roughness: 0.85 }),
      pillarStone: surface({ color: th.stone, map: blockTex, bumpMap: blockTex, bumpScale: 1.5, roughness: 0.9 }),
      stoneDark: surface({ color: th.stoneDark, map: mossTex, roughness: 1.0 }),
      foliage: surface({ color: th.foliage, roughness: 0.8, flatShading: true }),
      foliageAlt: surface({ color: th.foliageAlt, roughness: 0.8, flatShading: true }),
      trunk: surface({ color: 0x5a4632, roughness: 1.0 }),
      relic: surface({
        color: colorblind ? 0x9ff5ff : th.relic, emissive: colorblind ? 0x2a6a77 : th.relic, emissiveIntensity: 0.9,
        roughness: 0.12, metalness: 0.0, clearcoat: 1.0, clearcoatRoughness: 0.06, envMapIntensity: 1.6,
      }),
      barrier: surface({ color: 0x6b4f2e, map: blockTex, bumpMap: blockTex, bumpScale: 1.0, roughness: 0.95 }),
      branch: surface({ color: th.accent, emissive: th.accent, emissiveIntensity: 0.6, roughness: 0.35 }),
      risk: surface({ color: 0xff8c5a, emissive: 0xb04018, emissiveIntensity: 0.5 }),
      player: surface({ color: 0xf0e2c0, roughness: 0.55, sheen: 0.6, sheenColor: 0xfff2d0 }),
      playerAccent: surface({ color: 0x3a6a4f, roughness: 0.45 }),
      lantern: surface({ color: 0xffd98a, emissive: 0xffc860, emissiveIntensity: 2.2 }),
    };
  } else {
    mats = {
      stone: surface({ color: th.stone, roughness: 0.9 }),
      stoneDark: surface({ color: th.stoneDark, roughness: 1.0 }),
      foliage: surface({ color: th.foliage, roughness: 1.0 }),
      foliageAlt: surface({ color: th.foliageAlt, roughness: 1.0 }),
      trunk: surface({ color: 0x5a4632, roughness: 1.0 }),
      relic: surface({ color: colorblind ? 0x9ff5ff : th.relic, emissive: colorblind ? 0x2a6a77 : th.relic, emissiveIntensity: 0.5, roughness: 0.3 }),
      barrier: surface({ color: 0x6b4f2e, roughness: 0.95 }),
      branch: surface({ color: th.accent, emissive: th.accent, emissiveIntensity: 0.35 }),
      risk: surface({ color: 0xff8c5a, emissive: 0x903010, emissiveIntensity: 0.3 }),
      player: surface({ color: 0xf0e2c0, roughness: 0.6 }),
      playerAccent: surface({ color: 0x3a6a4f, roughness: 0.5 }),
    };
    mats.pillarStone = mats.stone!;
  }
  const M = mats as Record<string, Std>;
  addWind(M.foliage!);
  addWind(M.foliageAlt!);

  const tint = new Color();
  const deco = rand((decorSeed ^ 0xdec0) >>> 0);
  const tintRnd = rand((decorSeed ^ 0x7117) >>> 0); // separate stream: layout stays identical across detail tiers
  const hsl = { h: 0, s: 0, l: 0 };
  const vary = (mesh: InstancedMesh, idx: number, lo: number, hi: number, hueJitter = 0): void => {
    if (!det) return;
    const v = lo + tintRnd() * (hi - lo);
    tint.setRGB(v, v, v);
    if (hueJitter) {
      // Color.offsetHSL(h, s, 0)
      const dh = (tintRnd() - 0.5) * hueJitter, ds = (tintRnd() - 0.5) * 0.1;
      tint.getHSL(hsl);
      tint.setHSL(hsl.h + dh, hsl.s + ds, hsl.l);
    }
    mesh.setColorAt(idx, tint);
  };

  // sky dome with a soft horizon haze (detailed); flat background otherwise
  if (det) {
    const skyMat = new ShaderMaterial({
      fragmentShader: SKY_FRAG, side: BackSide, depthWrite: false, fog: false,
      uniforms: {
        uTop: { value: new Color(th.sky).lerp(new Color(0x3d6e8a), 0.35) },
        uHorizon: { value: new Color(th.fog) },
        uGlow: { value: new Color(0xfff0c8) },
        uSunDir: { value: new Vector3(-0.35, 0.3, 1) },
      },
    });
    sky = new Mesh(new SphereGeometry(90, seg(32, 12), seg(16, 8)), skyMat);
    sky.frustumCulled = false;
    sky.renderOrder = -1;
    sky.noAO = true;
    world.add(sky);
  } else sky = null;

  // ground base plane (under everything, visible through gaps)
  const base = new Mesh(new PlaneGeometry(80, nCells * CELL_DEPTH + 80), M.stoneDark!);
  base.rotation.x = -PI / 2;
  base.position.set(0, GROUND_Y - 2.2, (nCells * CELL_DEPTH) / 2);
  base.receiveShadow = true;
  world.add(base);

  // track tiles: one instance per (cell, lane) that is not a gap
  const tilePositions: [number, number, number][] = [];
  for (let i = 0; i < nCells; i++) {
    if (cells[i]!.gap) continue;
    for (let l = 0; l < LANES; l++) tilePositions.push([LANE_X[l]!, GROUND_Y - 0.2, i * CELL_DEPTH]);
  }
  const tiles = new InstancedMesh(new BoxGeometry(2.05, 0.4, CELL_DEPTH * 0.96), M.stone!, Math.max(1, tilePositions.length));
  const m4 = new Matrix4();
  tilePositions.forEach((p, idx) => {
    m4.makeTranslation(p[0], p[1], p[2]);
    tiles.setMatrixAt(idx, m4);
    vary(tiles, idx, 0.86, 1.06, 0.03);
  });
  tiles.count = tilePositions.length;
  tiles.receiveShadow = true;
  world.add(tiles);

  // low barriers and the vine drape on top
  const lowCells: number[] = [];
  for (let i = 0; i < nCells; i++) if (cells[i]!.low) lowCells.push(i);
  const bars = new InstancedMesh(new BoxGeometry(LANE_SPACING * LANES, 1.0, 0.4), M.barrier!, Math.max(1, lowCells.length));
  lowCells.forEach((ci, idx) => { m4.makeTranslation(0, GROUND_Y + 1.1, ci * CELL_DEPTH); bars.setMatrixAt(idx, m4); });
  bars.castShadow = shadowsOn;
  bars.receiveShadow = det;
  bars.count = lowCells.length;
  world.add(bars);
  const vines = new InstancedMesh(new ConeGeometry(0.35, 1.2, 5), M.foliage!, Math.max(1, lowCells.length * 2));
  lowCells.forEach((ci, idx) => {
    m4.makeTranslation(-1.5, GROUND_Y + 1.9, ci * CELL_DEPTH); vines.setMatrixAt(idx * 2, m4);
    m4.makeTranslation(1.5, GROUND_Y + 1.9, ci * CELL_DEPTH); vines.setMatrixAt(idx * 2 + 1, m4);
  });
  vines.count = lowCells.length * 2;
  world.add(vines);

  // relics (hidden when collected by scaling to 0)
  const relicCell: number[] = [];
  for (let i = 0; i < nCells; i++) if (cells[i]!.relicLane >= 0) relicCell.push(i);
  const relics = new InstancedMesh(new OctahedronGeometry(0.42), M.relic!, Math.max(1, relicCell.length));
  relics.instanceMatrix.setUsage(DynamicDrawUsage);
  const relicBase = relicCell.map((ci): [number, number, number] => [LANE_X[cells![ci]!.relicLane]!, GROUND_Y + 0.9, ci * CELL_DEPTH]);
  relicBase.forEach((b, idx) => { m4.makeTranslation(b[0], b[1], b[2]); relics.setMatrixAt(idx, m4); });
  relics.count = relicCell.length;
  relics.castShadow = det && shadowsOn;
  world.add(relics);

  // branch indicators: twin arrow markers at each fork
  const forkCells: number[] = [];
  for (let i = 0; i < nCells; i++) if (cells[i]!.branch) forkCells.push(i);
  const arrows = new InstancedMesh(new ConeGeometry(0.5, 1.0, 4), M.branch!, Math.max(1, forkCells.length * 2));
  forkCells.forEach((ci, idx) => {
    const a = new Matrix4().makeRotationZ(PI / 2);
    a.premultiply(new Matrix4().makeTranslation(-3.4, GROUND_Y + 1.0, ci * CELL_DEPTH));
    arrows.setMatrixAt(idx * 2, a);
    const b = new Matrix4().makeRotationZ(-PI / 2);
    b.premultiply(new Matrix4().makeTranslation(3.4, GROUND_Y + 1.0, ci * CELL_DEPTH));
    arrows.setMatrixAt(idx * 2 + 1, b);
  });
  arrows.count = forkCells.length * 2;
  world.add(arrows);

  // risk-route tint strips after each fork
  let stripCount = 0;
  for (const b of forkCells) stripCount += Math.min(cells[b]!.branch, 12);
  const strips = new InstancedMesh(new BoxGeometry(1.8, 0.06, CELL_DEPTH * 0.9), M.risk!, Math.max(1, stripCount));
  let si = 0;
  for (const b of forkCells) {
    const span = Math.min(cells[b]!.branch, 12);
    for (let k = 1; k <= span && b + k < nCells; k++) {
      if (cells[b + k]!.gap) continue;
      m4.makeTranslation(LANE_X[2]! - 0.4, GROUND_Y + 0.03, (b + k) * CELL_DEPTH);
      strips.setMatrixAt(si++, m4);
    }
  }
  strips.count = si;
  world.add(strips);

  // decoration: pillars + vegetation, from the deterministic decoration stream
  const nPillars = Math.floor(nCells / fol.pillarEvery) * 2;
  const pillars = new InstancedMesh(new CylinderGeometry(0.45, 0.55, 3.4, seg(det ? 10 : 7, 5)), M.pillarStone!, Math.max(1, nPillars));
  let pi = 0;
  for (let i = 4; i < nCells && pi < nPillars; i += fol.pillarEvery) {
    for (const side of [-1, 1]) {
      const h = 0.6 + deco() * 0.5; // crumbling height variance
      const m = new Matrix4().makeScale(1, h, 1);
      m.premultiply(new Matrix4().makeTranslation(side * (4.6 + deco() * 1.2), GROUND_Y + 1.7 * h, i * CELL_DEPTH + (deco() - 0.5)));
      vary(pillars, pi, 0.8, 1.05, 0.02);
      pillars.setMatrixAt(pi++, m);
    }
  }
  pillars.count = pi;
  pillars.castShadow = shadowsOn;
  pillars.receiveShadow = det;
  world.add(pillars);

  const nVeg = fol.vegetationPerSide * 2;
  const veg = new InstancedMesh(new ConeGeometry(0.9, 1.6, seg(det ? 7 : 6, 5), det ? seg(2, 1) : 1), M.foliage!, Math.max(1, nVeg));
  for (let k = 0; k < nVeg; k++) {
    const side = k % 2 === 0 ? -1 : 1;
    const z = deco() * nCells * CELL_DEPTH;
    const s = 0.5 + deco() * 1.3;
    const m = new Matrix4().makeScale(s, s, s);
    m.premultiply(new Matrix4().makeTranslation(side * (3.8 + deco() * 4.5), GROUND_Y + 0.8 * s - 0.4, z));
    veg.setMatrixAt(k, m);
    vary(veg, k, 0.75, 1.15, 0.06);
  }
  veg.count = nVeg;
  veg.castShadow = q.shadows >= 4096;
  world.add(veg);

  const nTrees = Math.floor(nVeg / 3);
  const trees = new InstancedMesh(new ConeGeometry(1.1, 2.6, seg(det ? 8 : 6, 5), det ? seg(3, 1) : 1), M.foliageAlt!, Math.max(1, nTrees));
  const trunks = new InstancedMesh(new CylinderGeometry(0.18, 0.24, 1.6, 5), M.trunk!, Math.max(1, nTrees));
  for (let k = 0; k < nTrees; k++) {
    const side = k % 2 === 0 ? -1 : 1;
    const z = deco() * nCells * CELL_DEPTH;
    const x = side * (5.5 + deco() * 5);
    const s = 0.9 + deco() * 1.1;
    const m = new Matrix4().makeScale(s, s, s);
    m.premultiply(new Matrix4().makeTranslation(x, GROUND_Y + 1.6 + 1.3 * s, z));
    trees.setMatrixAt(k, m);
    vary(trees, k, 0.75, 1.15, 0.07);
    trunks.setMatrixAt(k, new Matrix4().makeTranslation(x, GROUND_Y + 0.8, z));
  }
  trees.count = nTrees;
  trunks.count = nTrees;
  trees.castShadow = shadowsOn;
  world.add(trees, trunks);

  // the runner: body + head (+ satchel and lantern when detailed)
  player = new Group();
  const body = new Mesh(new CapsuleGeometry(0.34, 0.6, seg(det ? 6 : 3, 2), seg(det ? 16 : 8, 6)), M.player!);
  body.position.y = 0.75;
  const head = new Mesh(new SphereGeometry(0.26, seg(det ? 20 : 10, 8), seg(det ? 14 : 8, 6)), M.playerAccent!);
  head.position.y = 1.45;
  player.add(body, head);
  if (det) {
    const satchel = new Mesh(new SphereGeometry(0.2, seg(14, 8), seg(10, 6)), M.trunk!);
    satchel.scale.set(1.1, 1.25, 0.6);
    satchel.position.set(0, 0.92, -0.3);
    const lantern = new Mesh(new SphereGeometry(0.1, seg(12, 8), seg(8, 6)), M.lantern!);
    lantern.position.set(0.36, 0.72, 0.12);
    player.add(satchel, lantern);
  }
  player.traverse((o) => { if (o instanceof Mesh) o.castShadow = shadowsOn; });
  world.add(player);

  pools = {
    relics, relicBase, relicCell, relicGone: relicCell.map(() => false),
    relicMat: M.relic! as Material & { color: Color; emissive?: Color }, branchMat: M.branch! as Material & { emissiveIntensity?: number },
  };
  scene.add(world);
  buildMotes();
  placeKeyLight(0);
}

/** Fireflies / pollen motes: one instanced draw, animated entirely on the GPU. */
function buildMotes(): void {
  if (motes) { world?.remove(motes); motes.geometry.dispose(); (motes.material as Material).dispose(); motes = null; }
  const n = Math.min(MOTE_MAX, look?.moteCount ?? 0);
  if (!n || !world || !theme) return;
  const r = rand((decorSeed ^ 0xf1f1) >>> 0);
  moteU.uColor.value = new Color(theme.accent).lerp(new Color(0xfff6c0), 0.5);
  const mat = new ShaderMaterial({ uniforms: moteU, vertexShader: MOTE_VERT, fragmentShader: MOTE_FRAG, transparent: true, depthWrite: false, fog: false, blending: AdditiveBlending });
  const im = new InstancedMesh(new PlaneGeometry(1, 1), mat, n);
  im.customSlots = 1;
  const v4 = new Vector4();
  for (let i = 0; i < n; i++) {
    const side = r() < 0.5 ? -1 : 1;
    const x = r() < 0.3 ? (r() - 0.5) * 7 : side * (3.2 + r() * 7);
    const y = 0.4 + r() * 4.5;
    const z = r() * 44;
    im.setCustomAt(i, v4.set(x, y, z, r()));
  }
  im.frustumCulled = false;
  im.noAO = true;
  im.count = n;
  motes = im;
  world.add(im);
}

const SHADOW_EXTENT = 14;
function placeKeyLight(focusZ: number): void {
  if (!keyLight) return;
  // snapped to whole texels so the shadows do not shimmer as the camera advances
  const ms = keyLight.shadow.mapSize;
  const texel = (SHADOW_EXTENT * 2) / ((typeof ms === "number" ? ms : ms.x) || 1024);
  const zc = Math.round((focusZ + 9) / texel) * texel;
  keyLight.target.position.set(0, 0, zc);
  keyLight.position.set(-6, 10, zc - 4);
}

// -- per-frame update ------------------------------------------------------------------------------
const tmpM = new Matrix4(), tmpQ = new Quaternion(), tmpV = new Vector3(), tmpS = new Vector3(1, 1, 1);
const UP = new Vector3(0, 1, 0);
function writeRelic(k: number, animate: boolean): void {
  const p = pools!, b = p.relicBase[k]!;
  if (p.relicGone[k]) { tmpM.makeScale(0.001, 0.001, 0.001); tmpM.setPosition(b[0], b[1], b[2]); }
  else if (animate) {
    tmpQ.setFromAxisAngle(UP, time * 1.4 + k * 0.7);
    tmpV.set(b[0], b[1] + Math.sin(time * 2.2 + k) * 0.1, b[2]);
    tmpM.compose(tmpV, tmpQ, tmpS);
  } else tmpM.makeTranslation(b[0], b[1], b[2]);
  p.relics.setMatrixAt(k, tmpM);
}

function animateAmbient(dt: number, focusZ: number): void {
  if (motionOn()) time += dt;
  windU.uTime.value = time;
  moteU.uOriginZ.value = focusZ;
  if (sky) sky.position.copy(camera.position);
  if (detailed() && pools && pools.branchMat.emissiveIntensity !== undefined) {
    pools.branchMat.emissiveIntensity = 0.45 + (motionOn() ? 0.35 * (0.5 + 0.5 * Math.sin(time * 3)) : 0.2);
  }
  placeKeyLight(focusZ);
}

/** The window rect the old canvas filled (between the status bar and rails), in window pixels. */
export function setView(fullW: number, fullH: number, x: number, y: number, w: number, h: number): void {
  if (w < 2 || h < 2) return;
  camera.setViewOffset(w, h, -x, -y, fullW, fullH);
}

/** updateFrame: the runner's pose from the rules state, `frac` of the way to the next tick; the damped chase camera. */
export function drawRun(state: State, frac: number, dt: number): void {
  if (!player || !pools) return;
  const moving = state.terminal ? 0 : frac;
  const z = ((state.distUnits + state.speed * moving) / UNITS_PER_CELL) * CELL_DEPTH;
  const x = LANE_X[state.lane]!;
  const det = detailed();
  let y = GROUND_Y;
  if (state.airTicks > 0) {
    const total = Math.max(1, Math.ceil((3 * UNITS_PER_CELL) / state.speed));
    const t = Math.min(1, 1 - (state.airTicks - moving) / total);
    y += Math.sin(t * PI) * 1.6;
  } else if (det && motionOn() && state.slideTicks === 0 && !state.terminal) {
    y += Math.abs(Math.sin((state.tick + moving) * 0.35)) * 0.06; // running stride bob
  }
  player.position.set(x, y, z);
  player.scale.y = state.slideTicks > 0 ? 0.45 : 1;
  player.rotation.y = reducedMotion ? 0 : Math.sin(state.tick * 0.2) * 0.06;

  // relic collection: hide collected instances (the cell list is authoritative); detailed + motion: spin and bob
  const p = pools;
  const animate = det && motionOn();
  let dirty = false;
  for (let k = 0; k < p.relicCell.length; k++) {
    const c = state.course.cells[p.relicCell[k]!];
    const gone = !c || c.relicLane < 0;
    const changed = p.relicGone[k] !== gone;
    p.relicGone[k] = gone;
    if (changed || (animate && !gone && Math.abs(p.relicBase[k]![2] - z) < 60)) { writeRelic(k, animate); dirty = true; }
  }
  if (dirty) p.relics.instanceMatrix.needsUpdate = true;

  // camera: smoothed follow; reduced motion = no shake
  const targetX = x * CAMERA.lateralFollow;
  const targetY = CAMERA.height + (state.airTicks > 0 ? 0.4 : 0);
  const targetZ = z - CAMERA.back;
  const k = 1 - Math.exp(-CAMERA.damp * dt);
  camPos.x += (targetX - camPos.x) * k;
  camPos.y += (targetY - camPos.y) * k;
  camPos.z += (targetZ - camPos.z) * k;
  if (shakeAmp > 0 && !reducedMotion) {
    camPos.x += (Math.random() - 0.5) * shakeAmp;
    camPos.y += (Math.random() - 0.5) * shakeAmp;
    shakeAmp = Math.max(0, shakeAmp - dt * 2);
  }
  camera.position.copy(camPos);
  camera.lookAt(x * 0.6, GROUND_Y + 1.0, z + CAMERA.lookAhead);
  animateAmbient(dt, z);
  idleZ = Math.max(6, z);
}

/** updateIdle: the title backdrop, a slow glide along the course (static under reduced motion). */
export function drawIdle(dt: number): void {
  if (!player || !cells) return;
  const len = cells.length * CELL_DEPTH;
  if (motionOn()) idleZ += dt * 1.6;
  if (idleZ > len - 30) idleZ = 6;
  const z = idleZ;
  player.position.set(0, GROUND_Y, z);
  player.scale.y = 1;
  camPos.set(Math.sin(time * 0.15) * 0.8, CAMERA.height, z - CAMERA.back);
  camera.position.copy(camPos);
  camera.lookAt(0, GROUND_Y + 1.0, z + CAMERA.lookAhead);
  animateAmbient(dt, z);
}

/** The Reset camera key (C): the camera snaps behind the runner. */
export function recenter(state: State): void {
  camPos.set(0, CAMERA.height, (state.distUnits / UNITS_PER_CELL) * CELL_DEPTH - CAMERA.back);
}
export function addShake(amp: number): void { if (!reducedMotion) shakeAmp = Math.min(0.4, amp); }
