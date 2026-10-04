// Platform adapter (src/platform.js) over the shipped StarHermit SDK with a
// stubbed fetch and launch fragment: token read, profile nickname, cloud save
// round trip on `game:<slug>`, settings KV, control bindings, and no network
// traffic standalone.
import { test, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const SDK = (() => {
  const m = { exports: {} };
  new Function('module', 'exports', readFileSync(new URL('../starhermit-sdk.js', import.meta.url), 'utf8'))(m, m.exports);
  return m.exports;
})();

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `${b64u({ alg: 'none' })}.${b64u({ sub: 'u-1234567890', game_scope: 'relic-run', exp: 9999999999 })}.sig`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timers = { setTimeout: (fn, ms) => (ms > 5000 ? 0 : setTimeout(fn, ms)), clearTimeout: (t) => t && clearTimeout(t) };

function fakeWindow(hash, hostname = 'localhost') {
  const loc = { hash, pathname: '/', search: '', hostname, href: `https://${hostname}/${hash}`, origin: `https://${hostname}` };
  return { location: loc, history: { state: null, replaceState(_s, _t, url) { loc.hash = url.includes('#') ? url.slice(url.indexOf('#')) : ''; } } };
}

function stubNet() {
  const calls = [];
  const store = { save: null, patches: [] };
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ method, url, auth: init.headers && init.headers.Authorization });
    const json = (code, body) => new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } });
    if (url === '/api/v1/users/u-1234567890/profile') return json(200, { nickname: 'Rel Ana' });
    if (url === '/api/v1/me/cloud-saves/game%3Arelic-run') {
      if (method === 'GET') return store.save ? new Response(store.save, { status: 200 }) : json(404, {});
      if (method === 'PUT') { store.save = Buffer.from(JSON.parse(init.body).dataBase64, 'base64'); return json(200, {}); }
    }
    if (url === '/api/v1/games/relic-run/settings') {
      if (method === 'GET') return json(200, { settings: { audio: { music: 0.1 } } });
      if (method === 'PATCH') { store.patches.push(JSON.parse(init.body).settings); return json(200, {}); }
    }
    if (url === '/api/v1/games/relic-run/controls') return json(200, { actions: [{ action: 'jump', codes: ['KeyJ'] }] });
    return json(404, {});
  };
  return { calls, store, fetch };
}

async function load(win, net) {
  globalThis.StarHermit = SDK.create({ window: win, fetch: net.fetch, ...timers });
  vi.resetModules();
  return import('../src/platform.js');
}

test('hosted: token, nickname, cloud save, settings KV, bindings', async () => {
  const net = stubNet();
  const P = await load(fakeWindow(`#game_token=${JWT}`), net);
  expect(P.hasIdentity()).toBe(true);
  expect(globalThis.StarHermit.slug).toBe('relic-run');
  expect(await P.fetchNickname()).toBe('Rel Ana');

  expect(await P.cloudLoad()).toBe(null); // empty slot
  P.scheduleCloudSave({ totals: { runs: 3 } });
  await P.flushCloudSave();
  expect(net.calls.some((c) => c.method === 'PUT' && c.url === '/api/v1/me/cloud-saves/game%3Arelic-run')).toBe(true);
  expect(await P.cloudLoad()).toEqual({ totals: { runs: 3 } });

  const settings = { audio: { music: 0.7, effects: 0.8 }, controls: { leftHanded: false } };
  expect(await P.loadSettings(settings)).toBe(true);
  expect(settings.audio).toEqual({ music: 0.1, effects: 0.8 });
  settings.controls.leftHanded = true;
  P.mirrorSettings(settings);
  await sleep(700);
  expect(net.store.patches.at(-1)).toEqual({ controls: { leftHanded: true } });

  await P.loadBindings();
  expect(P.actionFor('KeyJ')).toBe('jump');
  expect(P.actionFor('Space')).toBe(null);
  expect(P.actionFor('ArrowLeft')).toBe('left');

  expect(net.calls.every((c) => c.auth === `Bearer ${JWT}`)).toBe(true);
  expect(P.inviteLink()).toContain('/game-invite/u-1234567890/relic-run');
});

test('standalone: no network, local defaults', async () => {
  const net = stubNet();
  const P = await load(fakeWindow('', 'relic-run.starhermit.com'), net);
  const orig = globalThis.fetch;
  const local = [];
  globalThis.fetch = (u) => { local.push(u); return Promise.reject(new Error('offline')); };
  try {
    expect(P.hasIdentity()).toBe(false);
    expect(P.canSignIn()).toBe(true);
    expect(await P.cloudLoad()).toBe(null);
    P.scheduleCloudSave({ a: 1 });
    expect(await P.loadSettings({ audio: {} })).toBe(false);
    await P.loadBindings();
    expect(P.actionFor('Space')).toBe('jump');
    expect(await P.fetchLeaderboard()).toBe(null);
    expect(P.inviteLink()).toBe(null);
    expect(net.calls).toEqual([]);
    expect(local).toEqual([]);
  } finally {
    globalThis.fetch = orig;
  }
});
