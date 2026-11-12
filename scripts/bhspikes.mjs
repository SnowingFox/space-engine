// Frame-time spikes as black holes come into view, at the user's window size: node scripts/bhspikes.mjs
// Each scenario: placed, 3 s to settle, then 8 s measured while the camera does as described.
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';

const place = readFileSync(new URL('./bhplace.js', import.meta.url), 'utf8');
const scenarios = [
  // Looking away from the hole, then turning towards it over 2 s (the pass and its cube map start up mid-way).
  ['turning to Cygnus X-1 at 60 r_s', "placeC('Cygnus X-1', 60, 8, 20, 180)", "if (t > 1000 && t < 3000) placeC('Cygnus X-1', 60, 8, 20, 180 * (1 - (t - 1000) / 2000))"],
  ['turning to Sgr A* at 40 r_s', "place('Sagittarius', 40, 10, 0, 180)", "if (t > 1000 && t < 3000) place('Sagittarius', 40, 10, 0, 180 * (1 - (t - 1000) / 2000))"],
  ['Go to Sgr A* from Earth (autopilot)', '', "if (!window.__went) { window.__went = 1; se.go(se.blackHole('Sagittarius')); }"],
  ['Go to M87* from 1 Mly (autopilot)', "place('M87', 5e8, 30)", "if (!window.__went) { window.__went = 1; se.go(se.blackHole('M87')); }"],
];
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 2000, height: 1144, deviceScaleFactor: 2 },
});
console.log('scenario | mean ms | p95 ms | max ms | frames > 25 ms | long tasks (> 50 ms) | lens on at end');
for (const [name, setup, step] of scenarios) {
  const page = await browser.newPage();
  await page.goto(process.env.URL ?? 'http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction('window.se && window.se.holes', { timeout: 120000 });
  await new Promise((r) => setTimeout(r, 2500));
  const out = await page.evaluate(`new Promise((done) => {
    ${place};
    document.querySelectorAll('body > *:not(canvas)').forEach((e) => { e.style.display = 'none'; });
    let longTasks = 0;
    new PerformanceObserver((l) => { longTasks += l.getEntries().length; }).observe({ type: 'longtask', buffered: false });
    // OFF=1: the same flights with the lens pass held off, for a baseline.
    if (${JSON.stringify(process.env.OFF ?? '')}) { const up = se.holes.update.bind(se.holes); se.holes.update = (...a) => { up(...a); se.pipeline.lens.enabled = false; }; }
    ${setup};
    const t0 = performance.now();
    const times = [];
    let prev = t0;
    const tick = (now) => {
      const t = now - t0 - 3000;
      if (t > 0) { ${step}; times.push(now - prev); }
      prev = now;
      if (t < 8000) requestAnimationFrame(tick);
      else {
        const s = [...times].sort((a, b) => a - b);
        done([s.reduce((a, b) => a + b, 0) / s.length, s[Math.floor(s.length * 0.95)], s[s.length - 1], times.filter((x) => x > 25).length, longTasks, se.pipeline.lens.enabled]);
      }
    };
    requestAnimationFrame(tick);
  })`);
  console.log(`${name} | ${out[0].toFixed(1)} | ${out[1].toFixed(1)} | ${out[2].toFixed(0)} | ${out[3]} | ${out[4]} | ${out[5]}`);
  await page.close();
}
await browser.close();
