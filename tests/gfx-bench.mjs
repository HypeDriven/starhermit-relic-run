// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics, starts
// the hardest Practice course and keeps the runner alive with real arrow-key jumps and slides (the e2e's
// look-ahead survival policy), retrying from the results screen — the camera, foliage, wind sway, relics,
// fireflies and post chain animate all the time.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForFunction(() => document.getElementById('screen-title').classList.contains('active'), null, { timeout: 30000 });
  await page.click('#btn-settings');
  await page.waitForFunction(() => document.getElementById('screen-settings').classList.contains('active'));
  await page.selectOption('#gfx-preset', preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await page.click('#screen-settings [data-nav-back]');
  await page.waitForFunction(() => document.getElementById('screen-title').classList.contains('active'));
}

// Next input from the visible course ahead of the runner (same policy as tests/e2e.mjs).
const nextAction = (page) => page.evaluate(() => {
  const app = window.__rr;
  if (!app) return null;
  if (app.machine === 'results') return 'retry';
  if (app.machine !== 'active' || !app.sess) return null;
  const s = app.sess.state;
  if (s.terminal) return null;
  const ci = Math.floor(s.distUnits / 24), cells = s.course.cells;
  for (let d = 1; d <= 3; d++) {
    const c = cells[Math.min(ci + d, cells.length - 1)];
    if (!c) continue;
    if (c.gap && s.airTicks === 0) return 'jump';
    if (c.low && s.slideTicks === 0 && s.stunTicks === 0) return 'slide';
  }
  return null;
});

export async function start(page) {
  await page.click('#btn-play');
  await page.waitForFunction(() => document.getElementById('screen-mode').classList.contains('active'));
  await page.click('#screen-mode [data-mode="practice"]');
  await page.locator('#practice-list .item button').last().click();
  await page.waitForFunction(() => window.__rr && window.__rr.machine === 'active', null, { timeout: 20000 });
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try {
        const act = await nextAction(page);
        if (act === 'retry') await page.click('#btn-retry', { timeout: 3000 });
        else if (act) await page.keyboard.press(act === 'jump' ? 'ArrowUp' : 'ArrowDown');
      } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error(e.message); }
      await page.waitForTimeout(90).catch(() => {});
    }
  })();
  await page.waitForTimeout(1500);
}
