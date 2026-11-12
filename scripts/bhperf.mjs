// Cost of the black-hole lens pass at the user's window size: node scripts/bhperf.mjs
// Each frame's rendering is timed to the GPU's completion (a one-pixel read waits for it), so the time follows the
// GPU work. Each scenario is placed, settles 3 s, then alternates 1 s with the pass and 1 s without (forced off)
// for 8 s; the difference of the medians is the pass's cost. Frame intervals (vsync) are reported too.
// The pixel ratio is pinned (no dynamic resolution) so both halves render the same number of pixels.
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';

const place = readFileSync(new URL('./bhplace.js', import.meta.url), 'utf8');
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const scenarios = [
  ['no black hole in view (Earth)', ''],
  ['Sgr A*, 100 r_s', "place('Sagittarius', 100, 10)"],
  ['Sgr A*, 1000 r_s', "place('Sagittarius', 1000, 25)"],
  ['Sgr A*, 1e6 r_s (lens on, nearly a copy)', "place('Sagittarius', 1e6, 25)"],
  ['Sgr A*, 4 r_s, fills the view', "place('Sagittarius', 4, 20)"],
  ['Cygnus X-1, 60 r_s, companion behind', "placeC('Cygnus X-1', 60, 8, 20)"],
  ['M87*, 300 r_s with jet', "place('M87', 300, 40, 0, 0, 10)"],
  ['orbiting Gaia BH1 at 30 r_s', "window.__orbit = (t) => place('Gaia BH1', 30, 5 + 10 * Math.sin(t / 3000), t / 60)"],
];
const launch = () => puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 2000, height: 1144, deviceScaleFactor: 2 },
});
const RATIO = Number(process.env.RATIO ?? 1.4);
console.log(`pixel ratio pinned at ${RATIO}`);
console.log('scenario | render to GPU done, median with pass ms | without ms | pass cost ms | p95 with ms | frame gaps > 25 ms with');
for (const [name, setup] of scenarios.filter(([n]) => !only || only.test(n))) {
  // (A fresh browser per scenario: nothing left over from the previous one.)
  const browser = await launch();
  const page = await browser.newPage();
  let out = null;
  for (let attempt = 0; attempt < 4 && !out; attempt++) {
    try {
      await page.goto(process.env.URL ?? 'http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 120000 });
      await page.waitForFunction('window.se && window.se.holes', { timeout: 120000 });
      await new Promise((r) => setTimeout(r, 2500));
      out = await page.evaluate(`new Promise((done) => {
        ${place};
        document.querySelectorAll('body > *:not(canvas)').forEach((e) => { e.style.display = 'none'; });
        const pl = se.pipeline;
        // Pin the resolution: the adaptive scaler would otherwise answer the pass with fewer pixels.
        pl.adaptResolution = () => {};
        pl.resScale = ${RATIO} / pl.baseRatio;
        pl.applyScale();
        let off = false;
        const gl = pl.renderer.getContext();
        const px = new Uint8Array(4);
        const rend = pl.render.bind(pl);
        let renderMs = 0;
        pl.render = () => { const a = performance.now(); rend(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); renderMs = performance.now() - a; };
        const up = se.holes.update.bind(se.holes);
        const mode = ${JSON.stringify(process.env.VARIANT ?? '')};
        se.holes.update = (...a) => {
          up(...a);
          if (off) pl.lens.enabled = false;
          // Variants, to see where the time goes: copy (no lensing), nodisc, nocube.
          for (const h of pl.lens.holes) {
            if (mode.includes('copy')) h.reachCos = 2;
            if (mode.includes('nodisc')) { h.disc.w = 0; h.opacity = 0; }
          }
          if (mode.includes('nocube')) pl.lens.useCube = false;
        };
        ${setup};
        const t0 = performance.now();
        const on = [], offT = [], gaps = [];
        let iso = 0, isoDone = false;
        let prev = t0;
        const tick = (now) => {
          if (window.__orbit) window.__orbit(now - t0);
          const t = now - t0;
          if (t > 3000) {
            const phase = Math.floor((t - 3000) / 1000) % 2;
            // (The first frames after a switch are left out.)
            if ((t - 3000) % 1000 > 150) { (phase ? offT : on).push(renderMs); if (!phase) gaps.push(now - prev); }
            off = phase === 1;
          }
          // And the pass alone, drawn 40 times back to back between two waits for the GPU.
          if (pl.lens.enabled && !isoDone && t > 9500) {
            const c = pl.composer, r = pl.renderer;
            // (Read back from the pass's own target: only that waits for its draws.)
            const hp = new Uint16Array(4);
            r.readRenderTargetPixels(c.writeBuffer, 0, 0, 1, 1, hp);
            const a = performance.now();
            for (let i = 0; i < 40; i++) pl.lens.render(r, c.writeBuffer, c.readBuffer);
            r.readRenderTargetPixels(c.writeBuffer, 0, 0, 1, 1, hp);
            iso = (performance.now() - a) / 40;
            isoDone = true;
          }
          prev = now;
          if (t < 11000) requestAnimationFrame(tick);
          else {
            const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
            const s = [...on].sort((a, b) => a - b);
            done([med(on), med(offT), s[Math.floor(s.length * 0.95)], gaps.filter((x) => x > 25).length, pl.pixelRatio, iso]);
          }
        };
        requestAnimationFrame(tick);
      })`);
    } catch (e) { console.error(String(e).slice(0, 300)); if (!/destroyed|navigation|timeout/i.test(String(e))) throw e; }
  }
  console.log(`${name} | ${out[0].toFixed(2)} | ${out[1].toFixed(2)} | ${(out[0] - out[1]).toFixed(2)} | ${out[2].toFixed(1)} | ${out[3]} (ratio ${out[4].toFixed(2)}) | pass alone ${out[5].toFixed(2)} ms`);
  await browser.close();
}
