// Frame times of galaxy views at the user's window size: node scripts/gperf.mjs [url]
// Each view: placed (and, for "moving" ones, flown on every frame), 6 s to settle in, then 4 s of frame times.
import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://localhost:5173/';
const views = [
  ['Sol, toward the centre', 'at(26000,18.00002,900); look(-1,-0.0007,-0.035)', ''],
  ['9.8 kly, 400 ly up', 'at(7864,400,5898); look(-0.8,-0.1,-0.6)', ''],
  ['20.8 kly in the plane', 'at(20800,20,300); look(-1,0,0.05)', ''],
  ['flying along the plane, 300 ly/s', 'at(20800,20,300); look(-1,0,0.05)', 'move(-300, 0, 0)'],
  ['flying out, 2 kly/s', 'at(26000,300,900); look(-1,-0.25,-0.03)', 'move(0, 2000, 0)'],
  ['Milky Way from 134 kly', 'at(0,120000,60000); look(0,-0.9,-0.45)', ''],
  ['Andromeda from 120 kly', 'const g=se.galaxy("andromeda").galaxy; const dx=26000-g.x,dy=18-g.y,dz=900-g.z,l=Math.hypot(dx,dy,dz); at(g.x+dx/l*120000,g.y+dy/l*120000,g.z+dz/l*120000); look(-dx,-dy,-dz)', ''],
  ['Milky Way from 70 kly, oblique', 'at(-30000,40000,50000); look(30000,-40000,-50000)', ''],
  ['NGC 5697, 18.9 kly from centre', 'const g=se.galaxy(window.__SPIRAL ?? "NGC 5697").galaxy; const a=g.axes; at(g.x+a[0]*18900+a[3]*700, g.y+a[1]*18900+a[4]*700, g.z+a[2]*18900+a[5]*700); look(-a[0]-a[3]*0.08,-a[1]-a[4]*0.08,-a[2]-a[5]*0.08)', ''],
];
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 2000, height: 1144, deviceScaleFactor: 2 },
});
console.log('view | mean ms | p95 ms | fps | pixel ratio (max 1.42, floor 0.8)');
for (const [name, setup, step] of views) {
  // (Another change to the sources reloads the dev server's page mid-measurement: then measure again.)
  let page, out;
  for (let attempt = 0; ; attempt++) {
    try {
    page = await browser.newPage();
    await page.goto(url, { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 1500));
    out = await page.evaluate(`new Promise((done) => {
    const p = se.player;
    const LY = 9.4607e12;
    const at = (x, y, z) => { const g = { x: 0, y: 0, z: 0 }; p.galactic(g); p.local.x += (x - g.x) * LY; p.local.y += (y - g.y) * LY; p.local.z += (z - g.z) * LY; };
    const look = (x, y, z) => { const l = Math.hypot(x, y, z); const f = p.local.clone().set(x / l, y / l, z / l); p.quat.setFromUnitVectors(p.local.clone().set(0, 0, -1), f); };
    let last = performance.now();
    const move = (x, y, z) => { const now = performance.now(), dt = (now - last) / 1000; last = now; p.local.x += x * dt * LY; p.local.y += y * dt * LY; p.local.z += z * dt * LY; };
    document.querySelectorAll('body > *:not(canvas)').forEach((e) => { e.style.display = 'none'; });
    // (A generated spiral of the cosmos, 19 Mly out; before it the old generated NGC 5697.)
    window.__SPIRAL = se.cosmos ? 'PGC 34630273004' : 'NGC 5697';
    ${setup};
    const t0 = performance.now();
    const times = [];
    let prev = t0;
    const tick = (now) => {
      ${step};
      if (now - t0 > 6000) times.push(now - prev);
      prev = now;
      if (now - t0 < 10000) requestAnimationFrame(tick);
      else {
        times.sort((a, b) => a - b);
        const mean = times.reduce((a, b) => a + b, 0) / times.length;
        done([mean, times[Math.floor(times.length * 0.95)], 1000 / mean, se.pipeline.pixelRatio, (se.cloud.host ? se.cloud.host.cfg.steps : se.cloud.volume.texels)]);
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
  console.log(`${name} | ${out[0].toFixed(1)} | ${out[1].toFixed(1)} | ${out[2].toFixed(0)} | ${out[3].toFixed(2)} | ${out[4] < 1000 ? `${Math.round(out[4])} march steps` : `${(out[4] / 1000).toFixed(0)}k texels/frame`}`);
  await page.close();
}
await browser.close();
