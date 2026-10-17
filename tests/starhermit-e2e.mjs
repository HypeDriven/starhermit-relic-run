// E2E helpers (puppeteer): a launch token and a stubbed StarHermit API served
// through request interception, so the signed-in UI can be driven by real
// clicks offline. Missing resources answer 204 (the SDK reads it as null) so
// the browser logs no 404 console errors.
export const launchToken = () => {
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return 'h.' + b64u({ sub: 'user-123456789', game_scope: 'gid-1', exp: Math.floor(Date.now() / 1000) + 3600 }) + '.s';
};

/** Stubs every /api/v1 call on `page`; returns the recorded calls (+ .settings, .reports). */
export async function stubStarHermit(page, overrides = {}) {
  const calls = [];
  const settings = {};
  calls.settings = settings;
  let save = null;
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (!/^\/api\/v1\//.test(url.pathname)) { req.continue(); return; }
    const p = url.pathname;
    const method = req.method();
    calls.push(method + ' ' + p);
    const body = () => JSON.parse(req.postData() || '{}');
    const json = (status, b) => req.respond({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (p.includes('/cloud-saves/')) {
      if (p.endsWith('/info')) return json(200, save ? { exists: true, etag: '"v' + calls.length + '"' } : { exists: false });
      if (method === 'PUT') { save = Buffer.from(body().dataBase64, 'base64'); return json(200, { etag: '"v' + calls.length + '"' }); }
      return save ? req.respond({ status: 200, contentType: 'application/zip', body: save }) : req.respond({ status: 204, body: '' });
    }
    if (p === '/api/v1/time') return json(200, { now: Date.now(), serverTime: Date.now(), date: new Date().toISOString().slice(0, 10) });
    if (p.endsWith('/profile')) return json(200, { username: 'pk-1', nickname: 'Al' });
    if (p === '/api/v1/me/language') return json(200, { preferredLanguage: overrides.preferredLanguage || 'en' });
    if (/\/settings\/[^/]+$/.test(p) && method === 'PUT') {
      settings[decodeURIComponent(p.split('/').pop())] = body().value;
      return json(200, {});
    }
    if (/\/reports$/.test(p) && method === 'POST') {
      calls.reports = (calls.reports || []).concat(body());
      return json(201, { id: 'r1', kind: 'bug', status: 'open', createdAt: new Date().toISOString() });
    }
    if (/\/settings$/.test(p)) {
      if (method === 'PATCH') Object.assign(settings, body().settings);
      return json(200, { settings });
    }
    if (p.endsWith('/controls')) return json(200, { actions: [] });
    if (p.endsWith('/launch-token')) return json(200, { token: launchToken() });
    return req.respond({ status: 204, body: '' });
  });
  return calls;
}
