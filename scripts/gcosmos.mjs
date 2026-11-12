// The generated universe as streamed around the camera: how many galaxies are loaded over time, how long a frame
// takes while they come in, and a sample of them.  node scripts/gcosmos.mjs [url] ["<setup js>"]
import puppeteer from 'puppeteer-core';

const [url = 'http://localhost:5173/', setup = 'at(26000,18.00002,900); look(-0.7,0.03,0.7)'] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 2000, height: 1144, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => logs.push(e.message));
await page.goto(url, { waitUntil: 'load' });
const out = await page.evaluate(`new Promise((done) => {
  const p = se.player, LY = 9.4607e12;
  const at = (x, y, z) => { const g = { x: 0, y: 0, z: 0 }; p.galactic(g); p.local.x += (x - g.x) * LY; p.local.y += (y - g.y) * LY; p.local.z += (z - g.z) * LY; };
  const look = (x, y, z) => { const l = Math.hypot(x, y, z); const f = p.local.clone().set(x / l, y / l, z / l); p.quat.setFromUnitVectors(p.local.clone().set(0, 0, -1), f); };
  ${setup};
  let long = 0;
  new PerformanceObserver((l) => { long += l.getEntries().length; }).observe({ type: 'longtask', buffered: false });
  const t0 = performance.now(); let prev = t0; const times = []; const counts = [];
  const f = (n) => {
    times.push(n - prev); prev = n;
    if (times.length % 30 === 0) counts.push([Math.round((n - t0) / 100) / 10, se.cloud.state.galaxies]);
    if (n - t0 < Number(${JSON.stringify(process.env.MS ?? '8000')})) requestAnimationFrame(f);
    else {
      const s = times.slice(5).sort((a, b) => a - b);
      const kinds = {}; let lit = 0;
      se.cloud && window.__cosmos;
      done({ counts, max: s[s.length - 1], over25: s.filter((t) => t > 25).length, p95: s[Math.floor(s.length * 0.95)], long, heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null });
    }
  };
  requestAnimationFrame(f);
})`);
console.log(JSON.stringify(out));
console.log(logs.slice(0, 5).join('\n'));
await browser.close();
