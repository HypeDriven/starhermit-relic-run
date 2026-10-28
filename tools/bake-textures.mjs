// Bakes the browser build's procedural stone textures (src/render.js before the
// engine port: drawTile, drawBlocks, drawMoss, speckle — copied below
// verbatim) into assets/textures/{tile,blocks,moss}-<px>.png by running that
// canvas code in Chrome (~/games/tools/gpu-chrome.mjs). Hundreds of arcs and
// radial gradients per texture paint far too slowly on the engine's canvas,
// so the engine client loads these images (native/render.ts). The old build
// painted them per course from its decoration seed; the bake uses the first
// Journey stage's (the variation between seeds is speckle placement only).
// Sizes: the old budgets' 256 (Balanced, High) and 512 (Ultra); Low drew
// plain colours. Run once; commit the PNGs.   node tools/bake-textures.mjs
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAGES } from '../src/content.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
function findPlaywright() {
  const roots = [root, resolve(root, '..'), ...readdirSync(resolve(root, '..')).map((d) => resolve(root, '..', d))];
  for (const r of roots) {
    const p = join(r, 'node_modules', 'playwright-core');
    if (existsSync(p)) return createRequire(join(r, 'package.json'))('playwright-core');
  }
  throw new Error('playwright-core not found');
}
const { chromium } = findPlaywright();

// The painters, as real functions; their source goes to the page (fn.toString()).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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


function paint(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.scale(size / 256, size / 256);
  draw(g, 256);
  return c.toDataURL('image/png');
}
const painters = [mulberry32, speckle, drawTile, drawBlocks, drawMoss, paint].map((f) => f.toString()).join('\n');

// buildScene's decoration seed for the first stage: (seed ^ 0xdec0) >>> 0
const decor = (STAGES[0].seed ^ 0xdec0) >>> 0;
const { launchChrome } = await import('/home/albert/games/tools/gpu-chrome.mjs');
const { browser, close } = await launchChrome(chromium);
try {
  const page = await browser.newPage();
  await page.setContent('<html><body></body></html>');
  await page.addScriptTag({ content: painters });
  const out = join(root, 'assets', 'textures');
  mkdirSync(out, { recursive: true });
  for (const size of [256, 512]) {
    const urls = await page.evaluate(([size, decor]) => ({
      tile: paint(size, drawTile(decor ^ 0x51)),
      blocks: paint(size, drawBlocks(decor ^ 0x77)),
      moss: paint(size, drawMoss(decor ^ 0x99)),
    }), [size, decor]);
    for (const [name, url] of Object.entries(urls)) {
      writeFileSync(join(out, `${name}-${size}.png`), Buffer.from(url.split(',')[1], 'base64'));
      console.log(`assets/textures/${name}-${size}.png`);
    }
  }
} finally { await close(); }
