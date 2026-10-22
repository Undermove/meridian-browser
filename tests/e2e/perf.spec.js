// Performance with a synthetic big profile: 250 pinned tabs in 20 folders + 40 Today tabs (+3000
// history entries). Times are measured in the UI renderer: performance.now() around the action plus
// the next two animation frames (≈ "the user sees the result"). Numbers are attached to the test
// results and printed; budgets are deliberately loose — they catch regressions, not perfection.
const { test, expect, runUnattached, openTabDirect, waitTabLoaded } = require('../fixtures/meridian');
const S = require('../fixtures/state');

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, median: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +s.at(-1).toFixed(1) };
};

function bigSeed(server) {
  const st = S.bigProfile(server.base);
  for (let i = 0; i < 3000; i++) st.history[`${server.base}/h/${i}`] = { url: `${server.base}/h/${i}`, title: `History page ${i} about topic ${i % 97}`, count: 1 + (i % 7), last: Date.now() - i * 60000 };
  return st;
}

// Measure fn() + two frames, `runs` times, inside the renderer.
async function measure(page, fnSource, runs, arg) {
  return page.evaluate(async ([src, runs, arg]) => {
    const fn = new Function('i', 'arg', src);
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const out = [];
    await frames();
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      fn(i, arg);
      await frames();
      out.push(performance.now() - t0);
      await new Promise((r) => setTimeout(r, 30));
    }
    return out;
  }, [fnSource, runs, arg]);
}

function report(testInfo, name, s) {
  testInfo.annotations.push({ type: `perf: ${name}`, description: JSON.stringify(s) });
  console.log(`[perf] ${name}: median ${s.median} ms, p95 ${s.p95} ms, max ${s.max} ms (n=${s.n})`);
}

test.describe('perf: big profile', () => {
  test.use({ seed: async ({ server }, use) => use(bigSeed(server)) });

  test('space switch time', async ({ page }, testInfo) => {
    await page.evaluate(() => { runCommand('space-index', 1); runCommand('space-index', 2); runCommand('space-index', 0); }); // warm: load each space's tab once
    await page.waitForTimeout(1500);
    const both = await measure(page, `runCommand('space-step', i % 2 ? -1 : 1)`, 30);
    const intoBig = both.filter((_, i) => i % 2 === 1);
    const outOfBig = both.filter((_, i) => i % 2 === 0);
    report(testInfo, 'space switch into big space', stats(intoBig));
    report(testInfo, 'space switch out of big space', stats(outOfBig));
    const renderOnly = await page.evaluate(() => { const xs = []; for (let i = 0; i < 30; i++) { const t = performance.now(); render(); xs.push(performance.now() - t); } return xs; });
    report(testInfo, 'render() of big space (sync JS only)', stats(renderOnly));
    expect(stats(intoBig).median).toBeLessThan(100);
  });

  test('tab switch time (loaded and unloaded tabs)', async ({ page, server }, testInfo) => {
    const ids = await page.evaluate(() => space().today.slice(0, 6).map((t) => t.id));
    for (const id of ids) { await page.evaluate((id) => activate(id), id); await waitTabLoaded(page, id); }
    const loaded = await measure(page, `activate(arg[i % arg.length])`, 30, ids);
    report(testInfo, 'tab switch (loaded tabs)', stats(loaded));
    const unloadedIds = await page.evaluate(() => { const ids = []; walk(space().pinned, (n, _l, p) => { if (n.type === 'tab' && !(p && p.collapsed) && !rt.views.has(n.id)) ids.push(n.id); }); return ids.slice(0, 15); });
    const unloaded = await measure(page, `activate(arg[i])`, unloadedIds.length, unloadedIds);
    report(testInfo, 'tab switch (unloaded pinned tab → creates webview)', stats(unloaded));
    expect(stats(loaded).median).toBeLessThan(100);
    void server;
  });

  test('clicking a sidebar row (real click → next frames)', async ({ page }, testInfo) => {
    const ids = await page.evaluate(() => space().today.slice(0, 6).map((t) => t.id));
    for (const id of ids) { await page.evaluate((id) => activate(id), id); await waitTabLoaded(page, id); }
    await page.waitForTimeout(500);
    const xs = [];
    for (let i = 0; i < 12; i++) {
      const row = page.locator('#today .row.tab').nth(i % 6);
      await row.scrollIntoViewIfNeeded();
      const box = await row.boundingBox();
      await page.evaluate(() => {
        window.__clickT = new Promise((resolve) => {
          addEventListener('mousedown', () => {
            const t0 = performance.now();
            addEventListener('click', () => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t0))), { once: true });
          }, { once: true, capture: true });
        });
      });
      await page.mouse.click(box.x + 60, box.y + box.height / 2);
      xs.push(await page.evaluate(() => window.__clickT));
      await page.waitForTimeout(100);
    }
    report(testInfo, 'sidebar row click → frame', stats(xs));
  });

  test('command bar: keystroke → results drawn', async ({ page }, testInfo) => {
    await page.evaluate(() => runCommand('command-bar'));
    const xs = await page.evaluate(async () => {
      const input = document.querySelector('#cmd-input');
      const out = [];
      const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (const q of ['t', 'to', 'top', 'topi', 'topic', 'topic 4', 'pinned 1', 'today 3', 'fold', 'history page 12']) {
        input.value = q;
        const t0 = performance.now();
        input.dispatchEvent(new Event('input'));
        await frames();
        out.push(performance.now() - t0);
      }
      return out;
    });
    report(testInfo, 'command bar keystroke → results', stats(xs));
    expect(stats(xs).median).toBeLessThan(100);
  });

  test('state save cost (serialize + IPC + disk) and size', async ({ page }, testInfo) => {
    const r = await page.evaluate(async () => {
      const size = JSON.stringify(state).length;
      const xs = [];
      for (let i = 0; i < 10; i++) { const t = performance.now(); await api.saveState(saveParts()); xs.push(performance.now() - t); }
      return { size, xs };
    });
    report(testInfo, `state.json save (${(r.size / 1024).toFixed(0)} KB)`, stats(r.xs));
  });

  test('sidebar re-render per page title update', async ({ page, server }, testInfo) => {
    // Every page-title-updated / did-navigate / favicon schedules a full sidebar render (innerHTML of 290 rows).
    const id = await page.evaluate(() => space().activeTabId);
    await waitTabLoaded(page, id);
    const n = await page.evaluate(async (id) => {
      let renders = 0;
      const orig = window.renderSpacePage;
      const page = document.querySelector('#space-pages');
      const mo = new MutationObserver(() => renders++);
      mo.observe(page, { childList: true });
      await rt.views.get(id).executeJavaScript(`(async () => { for (let i = 0; i < 20; i++) { document.title = 'T' + i; await new Promise((r) => setTimeout(r, 20)); } })()`);
      await new Promise((r) => setTimeout(r, 300));
      mo.disconnect();
      void orig;
      return renders;
    }, id);
    testInfo.annotations.push({ type: 'perf: full sidebar rebuilds for 20 title changes', description: String(n) });
    console.log(`[perf] full sidebar rebuilds for 20 title changes in one tab: ${n}`);
    void server;
  });
});

test.describe('background tabs', () => {
  // QA reported background tabs at ~120 rAF/s with document.visibilityState 'visible'. That was measured
  // under Playwright, whose CDP attach marks every webContents as being captured, which pins pages visible
  // (see runUnattached in fixtures/meridian.js). Without a debugger attached, a tab that isn't shown
  // (`.view.hidden`) is hidden to its page and gets no animation frames. The first test pins that the
  // harness caveat still holds (so a passing visibility check below can't come from the harness), the
  // second measures the real app.
  test('harness caveat: under Playwright every webContents reports being captured', async ({ meridian, page, server }) => {
    const id = await openTabDirect(page, server.url('/p/captured'));
    const wcId = await page.evaluate((id) => rt.views.get(id).getWebContentsId(), id);
    expect(await meridian.app.evaluate(({ webContents }, wcId) => webContents.fromId(wcId).isBeingCaptured(), wcId)).toBe(true);
  });

  const RAF = `new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); }; requestAnimationFrame(f); setTimeout(() => res({ visibility: document.visibilityState, rafPerSec: n }), 1100); })`;

  test('a background tab is hidden to its page and does not render frames', async ({ userDataDir, server }, testInfo) => {
    const a = S.tab(server.url('/p/bg-a'));
    const b = S.tab(server.url('/p/bg-b'));
    const c = S.tab(server.url('/p/bg-c'));
    const sp = S.space('Main', { today: [b, a, c], activeTabId: b.id });
    const loaded = (id) => `(async () => { for (let i = 0; i < 200; i++) { const wv = rt.views.get(${JSON.stringify(id)}); try { if (wv && !wv.isLoading() && rt.nav.get(${JSON.stringify(id)})?.loading === false) return true; } catch {} await new Promise((r) => setTimeout(r, 50)); } return false; })()`;
    const results = await runUnattached({
      userDataDir,
      state: S.seedState({ spaces: [sp] }),
      steps: [
        { wait: 1500 },
        // load A and C, then show B: A and C are background tabs
        { js: `(async () => { activate(${JSON.stringify(a.id)}); await ${loaded(a.id)}; activate(${JSON.stringify(c.id)}); await ${loaded(c.id)}; activate(${JSON.stringify(b.id)}); return ${loaded(b.id)}; })()`, wait: 600 },
        { js: `Promise.all([rt.views.get(${JSON.stringify(a.id)}).executeJavaScript(${JSON.stringify(RAF)}), rt.views.get(${JSON.stringify(b.id)}).executeJavaScript(${JSON.stringify(RAF)})]).then(([bg, fg]) => ({ bg, fg }))`, wait: 100 },
        // agent tools still read a background tab (isolated world, like hub.js read_page)
        { js: `rt.views.get(${JSON.stringify(a.id)}).executeJavaScript('document.querySelector("#content").textContent')`, wait: 100 },
        // switching to it is instant and it becomes visible again
        { js: `(async () => { activate(${JSON.stringify(a.id)}); await new Promise((r) => setTimeout(r, 300)); return rt.views.get(${JSON.stringify(a.id)}).executeJavaScript(${JSON.stringify(RAF)}); })()`, wait: 100 },
      ],
    });
    testInfo.annotations.push({ type: 'background tab (unattached run)', description: JSON.stringify(results) });
    console.log('[perf] background tab (no debugger attached):', JSON.stringify(results));
    expect(results[0]).toBe(true);
    const { bg, fg } = results[1];
    expect(fg.visibility).toBe('visible');
    expect(fg.rafPerSec).toBeGreaterThan(20); // control: the shown tab renders
    expect(bg.visibility).toBe('hidden');
    expect(bg.rafPerSec).toBeLessThan(5);
    expect(results[2]).toBe('content-bg-a');
    expect(results[3].visibility).toBe('visible');
    expect(results[3].rafPerSec).toBeGreaterThan(20);
  });
});

test.describe('perf: small profile (baseline)', () => {
  test.use({
    seed: async ({ server }, use) => use((() => {
      const a = S.space('A', { today: [S.tab(server.url('/p/a'))] }); a.activeTabId = a.today[0].id;
      const b = S.space('B', { today: [S.tab(server.url('/p/b'))] }); b.activeTabId = b.today[0].id;
      return S.seedState({ spaces: [a, b] });
    })()),
  });

  test('space switch time (baseline)', async ({ page }, testInfo) => {
    await page.evaluate(() => { runCommand('space-index', 1); runCommand('space-index', 0); });
    await page.waitForTimeout(1000);
    const xs = await measure(page, `runCommand('space-step', i % 2 ? -1 : 1)`, 30);
    report(testInfo, 'space switch (small profile)', stats(xs));
  });
});
