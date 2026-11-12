// Frame-time spikes in nebula scenarios at the user's window size: node scripts/nspikes.mjs [repeats] [url]
// Each scenario: placed, 2 s to settle in, then 10 s measured while the camera moves as described.
import puppeteer from 'puppeteer-core';

const repeats = Number(process.argv[2] ?? 1);
const url = process.argv[3] ?? 'http://localhost:5173/';
// Helpers in the page: N(name) a nebula's data; lookLB(l, b) aims along galactic longitude / latitude from Sol.
const H = `const N = (q) => se.nebula(q).nebula; const D = Math.PI / 180, T = Math.atan2(900, 26000);
  const lookLB = (l, b) => look(-Math.cos(b * D) * Math.cos(l * D + T), Math.sin(b * D), -Math.cos(b * D) * Math.sin(l * D + T));`;
const scenarios = [
  ['Sol, looking at Orion', `${H} at(26000.8, 18, 900); lookLB(207, -12)`, ''],
  ['Sol, looking at Sagittarius', `${H} at(26000.8, 18, 900); lookLB(8, -1)`, ''],
  ['flying into Orion, 3 R to the far side, 5 ly/s', `${H} const n = N('orion'); const s = n.sight; window.__s = s;
    at(n.x + s[6] * 36, n.y + s[7] * 36, n.z + s[8] * 36); look(-s[6], -s[7], -s[8])`, 'move(-window.__s[6] * 5, -window.__s[7] * 5, -window.__s[8] * 5)'],
  ['resting inside the Rosette', `${H} const n = N('rosette'); const s = n.sight;
    at(n.x + s[0] * 12, n.y + s[1] * 12, n.z + s[2] * 12); look(-s[6] + 0.3 * s[0], -s[7] + 0.3 * s[1], -s[8] + 0.3 * s[2])`, ''],
  ['flying past the Crab, 1.2 R off, 6 ly/s', `${H} const n = N('crab'); const s = n.sight; window.__s = s;
    at(n.x + s[6] * 7 - s[0] * 30, n.y + s[7] * 7 - s[1] * 30, n.z + s[8] * 7 - s[2] * 30); look(-s[6], -s[7], -s[8])`, 'move(window.__s[0] * 6, window.__s[1] * 6, window.__s[2] * 6)'],
];
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 2000, height: 1144, deviceScaleFactor: 2 },
});
console.log('scenario | mean ms | p95 ms | max ms | frames > 25 ms | long tasks (> 50 ms) | pixel ratio at end');
for (let rep = 0; rep < repeats; rep++) {
  for (const [name, setup, step] of scenarios) {
   // (A reload of the dev server in the middle of a run spoils it: run that scenario again.)
   for (let attempt = 0; attempt < 3; attempt++) {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 2500));
    let out;
    try {
    out = await page.evaluate(`new Promise((done) => {
      const p = se.player;
      const LY = 9.4607e12;
      const at = (x, y, z) => { const g = { x: 0, y: 0, z: 0 }; p.galactic(g); p.local.x += (x - g.x) * LY; p.local.y += (y - g.y) * LY; p.local.z += (z - g.z) * LY; };
      const look = (x, y, z) => { const l = Math.hypot(x, y, z); const f = p.local.clone().set(x / l, y / l, z / l); p.quat.setFromUnitVectors(p.local.clone().set(0, 0, -1), f); };
      let last = performance.now();
      const move = (x, y, z) => { const now = performance.now(), dt = Math.min((now - last) / 1000, 0.1); last = now; p.local.x += x * dt * LY; p.local.y += y * dt * LY; p.local.z += z * dt * LY; };
      document.querySelectorAll('body > *:not(canvas)').forEach((e) => { e.style.display = 'none'; });
      let longTasks = 0;
      new PerformanceObserver((l) => { longTasks += l.getEntries().length; }).observe({ type: 'longtask', buffered: false });
      ${setup};
      const t0 = performance.now();
      const times = [];
      let prev = t0;
      const tick = (now) => {
        if (now - t0 > 2000) { ${step}; times.push(now - prev); }
        else last = now;
        prev = now;
        if (now - t0 < 12000) requestAnimationFrame(tick);
        else {
          const s = [...times].sort((a, b) => a - b);
          done([s.reduce((a, b) => a + b, 0) / s.length, s[Math.floor(s.length * 0.95)], s[s.length - 1], times.filter((t) => t > 25).length, longTasks, se.pipeline.pixelRatio]);
        }
      };
      requestAnimationFrame(tick);
    })`);
    } catch (e) {
      await page.close();
      continue;
    }
    console.log(`${name} | ${out[0].toFixed(1)} | ${out[1].toFixed(1)} | ${out[2].toFixed(0)} | ${out[3]} | ${out[4]} | ${out[5].toFixed(2)}`);
    await page.close();
    break;
   }
  }
}
await browser.close();
