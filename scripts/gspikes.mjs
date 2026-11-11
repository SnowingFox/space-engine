// Frame-time spikes in galaxy scenarios at the user's window size: node scripts/gspikes.mjs [url]
// Each scenario: placed, 2 s to settle in, then 10 s measured while the camera moves as described.
import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://localhost:5173/';
const N = 'const g=se.galaxy(window.__SPIRAL ?? "NGC 5697").galaxy; const a=g.axes;';
const scenarios = [
  ['flying through the disc, 300 ly/s', 'at(20800,20,300); look(-1,0,0.05)', 'move(-300,0,0)'],
  ['flying out of the Milky Way, 2 kly/s', 'at(26000,300,900); look(-1,-0.25,-0.03)', 'move(0,2000,0)'],
  ['approaching Andromeda, 1.5 Mly to 0.2 Mly', 'const g=se.galaxy("andromeda").galaxy; window.__g=g; const d=[26000-g.x,18-g.y,900-g.z]; const l=Math.hypot(...d); window.__u=d.map(v=>v/l); at(g.x+window.__u[0]*1.5e6,g.y+window.__u[1]*1.5e6,g.z+window.__u[2]*1.5e6); look(-d[0],-d[1],-d[2])', 'move(-window.__u[0]*130000,-window.__u[1]*130000,-window.__u[2]*130000)'],
  ['arrived at rest, 20.8 kly (fine map refining)', 'at(20800,20,300); look(-1,0,0.05)', ''],
  ['through the Local Sheet, 1 Mly/s', 'at(26000,300,900); look(0.95,0.2,0.3)', 'move(0.95e6,0.2e6,0.3e6)'],
  ['a jump of 150 Mly, then 300 kly/s', 'window.__t0=performance.now(); look(0.6,0.3,0.7)', 'if(!window.__j && performance.now()-window.__t0>5000){window.__j=1; at(1.2e8,5e7,6e7);} if(window.__j) move(3e5,0,0)'],
  ['inside NGC 5697, 500 ly/s', `${N} at(g.x+a[0]*12000+a[3]*100, g.y+a[1]*12000+a[4]*100, g.z+a[2]*12000+a[5]*100); look(-a[0],-a[1],-a[2]); window.__a=a`, 'move(window.__a[6]*500,window.__a[7]*500,window.__a[8]*500)'],
];
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 2000, height: 1144, deviceScaleFactor: 2 },
});
console.log('scenario | mean ms | p95 ms | max ms | frames > 25 ms | long tasks (> 50 ms) | pixel ratio at end');
for (const [name, setup, step] of scenarios) {
  // (Another change to the sources reloads the dev server's page mid-measurement: then measure again.)
  let page, out;
  for (let attempt = 0; ; attempt++) {
    try {
    page = await browser.newPage();
    await page.goto(url, { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 2500));
    out = await page.evaluate(`new Promise((done) => {
    const p = se.player;
    const LY = 9.4607e12;
    const at = (x, y, z) => { const g = { x: 0, y: 0, z: 0 }; p.galactic(g); p.local.x += (x - g.x) * LY; p.local.y += (y - g.y) * LY; p.local.z += (z - g.z) * LY; };
    const look = (x, y, z) => { const l = Math.hypot(x, y, z); const f = p.local.clone().set(x / l, y / l, z / l); p.quat.setFromUnitVectors(p.local.clone().set(0, 0, -1), f); };
    let last = performance.now();
    const move = (x, y, z) => { const now = performance.now(), dt = Math.min((now - last) / 1000, 0.1); last = now; p.local.x += x * dt * LY; p.local.y += y * dt * LY; p.local.z += z * dt * LY; };
    document.querySelectorAll('body > *:not(canvas)').forEach((e) => { e.style.display = 'none'; });
    // (A generated spiral of the cosmos, 19 Mly out; before it the old generated NGC 5697.)
    window.__SPIRAL = se.cosmos ? 'PGC 34630273004' : 'NGC 5697';
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
      break;
    } catch (e) {
      await page.close().catch(() => {});
      if (attempt >= 3) throw e;
    }
  }
  console.log(`${name} | ${out[0].toFixed(1)} | ${out[1].toFixed(1)} | ${out[2].toFixed(0)} | ${out[3]} | ${out[4]} | ${out[5].toFixed(2)}`);
  await page.close();
}
await browser.close();
