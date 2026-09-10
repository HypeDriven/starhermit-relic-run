// Relic Run - end-to-end smoke test (plain node script, not vitest).
// Starts server.js on a test port, checks static resources + API, then drives
// the real page in headless Chrome and verifies play updates the DOM.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

import * as S from '../src/session.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 18923;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!ok) failures++;
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => null);
  return { status: res.status, body, headers: res.headers };
}

async function main() {
  // --- start server ---
  // scratch data dir: the smoke run must not rewrite the checked-in board files
  const dataDir = mkdtempSync(path.join(tmpdir(), 'relic-run-smoke-'));
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), RELIC_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  await new Promise((r) => setTimeout(r, 800));

  try {
    // --- static resources ---
    const index = await fetch(BASE + '/');
    check('GET / returns 200', index.status === 200);
    check('index MIME is html', (index.headers.get('content-type') || '').includes('text/html'));
    const html = await index.text();
    const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1])
      .filter((u) => !u.startsWith('/api'));
    for (const ref of refs) {
      const res = await fetch(BASE + ref);
      check(`GET ${ref}`, res.status === 200, res.headers.get('content-type') || '');
    }
    // module graph: fetch all /src/*.js and vendored three
    for (const f of ['rules', 'session', 'content', 'render', 'audio', 'ui', 'store', 'platform', 'main']) {
      const res = await fetch(`${BASE}/src/${f}.js`);
      check(`GET /src/${f}.js`, res.status === 200 && (res.headers.get('content-type') || '').includes('javascript'));
    }
    for (const f of ['three.module.js', 'three.core.js']) {
      const res = await fetch(`${BASE}/vendor/${f}`);
      check(`GET vendor/${f}`, res.status === 200);
    }
    // path traversal
    const trav = await fetch(BASE + '/..%2f..%2fetc%2fpasswd');
    check('path traversal blocked', [403, 404].includes(trav.status));
    for (const privatePath of ['/.git/config', '/data/leaderboard.json', '/node_modules/vitest/package.json']) {
      check('private path blocked: ' + privatePath, (await fetch(BASE + privatePath)).status === 403);
    }
    check('malformed URL rejected', (await fetch(BASE + '/%ZZ')).status === 400);
    // 404 / 405
    const nf = await fetch(BASE + '/nope.js');
    check('404 for missing file', nf.status === 404);
    const na = await fetch(BASE + '/api/v1/nope');
    check('API 404 structured', na.status === 404 && (await na.json()).error);

    // --- API ---
    const time = await fetchJson(BASE + '/api/v1/time');
    check('time endpoint', time.status === 200 && Number.isFinite(time.body.serverTime));
    const daily = await fetchJson(BASE + '/api/v1/daily');
    check('daily endpoint deterministic', daily.status === 200 && Number.isInteger(daily.body.seed));
    const daily2 = await fetchJson(BASE + '/api/v1/daily');
    check('daily seed stable', daily.body.seed === daily2.body.seed);

    // honest replayed score
    const sess = S.startSession(S.newSession(daily.body.seed, daily.body.genOpts));
    let guard = 0;
    while (!sess.over && guard++ < 30000) {
      const a = S.autoAction(sess.state);
      if (a) S.applySessionCommand(sess, { id: sess.nextCmdId, action: a });
      S.advance(sess, 1);
    }
    const env = S.replayEnvelope(sess);
    const post = await fetchJson(BASE + '/api/v1/scores', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ruleset: env.schemaVersion, contentVersion: env.contentVersion, seed: env.seed,
        genOpts: env.genOpts, durationTicks: sess.state.tick, commands: env.commands,
        scoreBreakdown: env.score, board: 'daily', player: 'smoke-runner',
      }),
    });
    check('score accepted after replay validation', post.status === 200 && post.body.accepted === true,
      JSON.stringify(post.body).slice(0, 120));

    const cheat = await fetchJson(BASE + '/api/v1/scores', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ruleset: env.schemaVersion, contentVersion: env.contentVersion, seed: env.seed,
        genOpts: env.genOpts, durationTicks: sess.state.tick, commands: env.commands,
        scoreBreakdown: { ...env.score, total: env.score.total + 500 }, board: 'daily',
      }),
    });
    check('inflated score rejected 422', cheat.status === 422 && cheat.body.error === 'score-mismatch');

    const stale = await fetchJson(BASE + '/api/v1/scores', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ruleset: 999, contentVersion: 1, seed: 1, durationTicks: 10, commands: [], scoreBreakdown: { total: 0 } }),
    });
    check('stale ruleset rejected', stale.status === 422);

    const board = await fetchJson(BASE + '/api/v1/leaderboard?board=daily');
    check('leaderboard has entry', board.status === 200 && board.body.entries.some((e) => e.player === 'smoke-runner'));
    const friendsBoard = await fetchJson(BASE + '/api/v1/leaderboard?board=daily&friends=smoke-runner');
    check('friends filter works', friendsBoard.body.entries.length >= 1 &&
      friendsBoard.body.entries.every((e) => e.player === 'smoke-runner'));

    const ach1 = await fetchJson(BASE + '/api/v1/achievements', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'first-finish' }),
    });
    const ach2 = await fetchJson(BASE + '/api/v1/achievements', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'first-finish' }),
    });
    check('achievement idempotent', ach1.body.unlocked === true && ach2.body.unlocked === true && ach2.body.firstUnlock === false);
    const achBad = await fetchJson(BASE + '/api/v1/achievements', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'not-a-key' }),
    });
    check('unknown achievement rejected', achBad.status === 422);

    // --- browser ---
    await browserChecks();
  } finally {
    srv.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

// Practice seeds are time-random and some generated courses drop a gap in the
// opening cells, which ends an unattended run within a second. To keep the
// browser checks deterministic, drive survival inputs through real key events
// using the same look-ahead policy as the content validator: read the course
// from the debug handle and jump/slide before the next hazard.
let driveTimer = null;
function startSurvivalDriver(page) {
  const tick = async () => {
    try {
      const act = await page.evaluate(() => {
        const app = window.__rr;
        if (!app || app.machine !== 'active' || !app.sess) return null;
        const s = app.sess.state;
        if (s.terminal) return null;
        const ci = Math.floor(s.distUnits / 24);
        const cells = s.course.cells;
        for (let d = 1; d <= 3; d++) {
          const c = cells[Math.min(ci + d, cells.length - 1)];
          if (!c) continue;
          if (c.gap && s.airTicks === 0) return 'jump';
          if (c.low && s.slideTicks === 0 && s.stunTicks === 0) return 'slide';
        }
        return null;
      });
      if (act) await page.keyboard.press(act === 'jump' ? 'ArrowUp' : 'ArrowDown');
    } catch { /* page closed or navigating; driver stops on next tick */ }
    driveTimer = setTimeout(tick, 90);
  };
  driveTimer = setTimeout(tick, 90);
}
function stopSurvivalDriver() {
  if (driveTimer) clearTimeout(driveTimer);
  driveTimer = null;
}

async function browserChecks() {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--headless=new', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(BASE + '/', { waitUntil: 'networkidle0', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1500));

    const titleVisible = await page.$eval('#screen-title', (el) => el.classList.contains('active'));
    check('title screen shown', titleVisible);
    const compat = await page.$eval('#compat', (el) => el.classList.contains('active'));
    if (compat) {
      check('WebGL unavailable - compat message shown instead (acceptable path)', true);
    }

    // Play -> mode select -> practice easy -> run
    await page.click('#btn-play');
    await new Promise((r) => setTimeout(r, 300));
    const modeVisible = await page.$eval('#screen-mode', (el) => el.classList.contains('active'));
    check('mode select shown after Play', modeVisible);

    await page.click('#screen-mode [data-mode="practice"]');
    await new Promise((r) => setTimeout(r, 300));
    await page.click('#practice-list .item button');

    // Wait for the run to actually reach 'active' (countdown length varies under swiftshader)
    let becameActive = false;
    for (let i = 0; i < 150; i++) {
      const m = await page.evaluate(() => window.__rr && window.__rr.machine);
      if (m === 'active') { becameActive = true; break; }
      if (m === 'results') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    check('run reaches active state', becameActive);
    const hud = await page.$eval('#hud', (el) => el.classList.contains('active'));
    check('HUD active during run', hud);
    startSurvivalDriver(page);

    // Score accrues with distance automatically; sample until it advances
    // while the run is still active (HUD refreshes every 10 ticks).
    let score1 = 0, score2 = 0, scoreOk = false;
    for (let i = 0; i < 12 && !scoreOk; i++) {
      score1 = await page.$eval('#hud-score', (el) => parseInt(el.textContent, 10));
      await new Promise((r) => setTimeout(r, 400));
      const stillActive = (await page.evaluate(() => window.__rr.machine)) === 'active';
      score2 = await page.$eval('#hud-score', (el) => parseInt(el.textContent, 10));
      scoreOk = stillActive && score2 > score1;
    }
    check('score DOM updates during run', scoreOk, `${score1} -> ${score2}`);

    // keyboard inputs: turn + jump (accepted without page errors)
    await page.keyboard.press('ArrowLeft');
    await new Promise((r) => setTimeout(r, 300));
    await page.keyboard.press('ArrowUp');
    await new Promise((r) => setTimeout(r, 800));
    const mirror = await page.$eval('#mirror', (el) => el.textContent);
    check('accessibility mirror has content', mirror.length > 10);

    if (!compat) {
      // canvas region of the composited page must contain rendered scenery
      const box = await (await page.$('#game')).boundingBox();
      const shot = await page.screenshot({
        clip: { x: box.x, y: box.y, width: Math.min(box.width, 400), height: Math.min(box.height, 300) },
      });
      // PNG bytes: a flat single-color region compresses tiny; real scenery is bigger
      check('canvas rendered non-trivial pixels', shot.length > 4000, `png bytes ${shot.length}`);
    }

    // pause / resume (the survival driver keeps the run alive; it idles while paused)
    let machine = await page.evaluate(() => window.__rr && window.__rr.machine);
    if (machine !== 'active') {
      await page.click('#btn-retry').catch(() => {});
      await page.waitForFunction(() => window.__rr && window.__rr.machine === 'active', { timeout: 15000 });
    }
    await page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 300));
    const paused = await page.$eval('#screen-pause', (el) => el.classList.contains('active'));
    check('Esc pauses', paused);
    await page.click('#btn-resume').catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    const resumed = await page.$eval('#hud', (el) => el.classList.contains('active'));
    const resumeState = await page.evaluate(() => window.__rr && `${window.__rr.machine}/${window.__rr.reason}`);
    check('resume returns to play', resumed, resumeState);

    const fatal = errors.filter((e) => !/favicon|Autoplay|AudioContext|WebGL.*fallback|GroupMarkerNotSet/i.test(e));
    check('no page console errors', fatal.length === 0, fatal.slice(0, 3).join(' | '));
  } finally {
    stopSurvivalDriver();
    await browser.close();
  }
}

main().catch((e) => { console.error('SMOKE CRASH', e); process.exit(1); });
