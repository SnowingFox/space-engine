// How far the galaxy on screen is from what it converges to, in flight: GalaxyHost.measureError every 20 frames
// of a flight at a fixed 1/60 s per frame (so the views do not depend on how long the measurements take).
//   node scripts/gerror.mjs [url] [scenario names, comma-separated]
// (env PRE: js run before the setup, e.g. to change se.cloud.host.cfg)
import puppeteer from 'puppeteer-core';

const [url = 'http://localhost:5173/', only = ''] = process.argv.slice(2);
const K = 'const L=[-0.75,0.12,0.65]; at(17000,30,0); look(...L);';
const side = (v) => `window.__v=[-L[2]*${v}/Math.hypot(L[0],L[2]),0,L[0]*${v}/Math.hypot(L[0],L[2])]`;
const scenarios = [
  ['rest, 17 kly', `${K} window.__v=[0,0,0]`],
  ['strafe 1 kly/s, 17 kly', `${K} ${side(1000)}`],
  ['strafe 6.48 kly/s, 17 kly', `${K} ${side(6480)}`],
  ['forward 6.48 kly/s, 17 kly', `${K} window.__v=L.map((v)=>v*6480/Math.hypot(...L))`],
  ['Sol, 5 kly/s', 'at(26000,18.00002,900); look(-0.7,0.03,0.7); window.__v=[-5000,0,-170]'],
].filter(([n]) => !only || only.split(',').some((o) => n.startsWith(o)));
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 2000, height: 1144, deviceScaleFactor: 2 },
});
console.log('scenario | error % vs converged, per pixel (median, max over the flight) | on 4 x 4 blocks (median, max) | brightness shown / converged');
for (const [name, setup] of scenarios) {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 2000));
  const out = await page.evaluate(`new Promise((done) => {
    const p = se.player, LY = 9.4607e12;
    const at = (x, y, z) => { const g = { x: 0, y: 0, z: 0 }; p.galactic(g); p.local.x += (x - g.x) * LY; p.local.y += (y - g.y) * LY; p.local.z += (z - g.z) * LY; };
    const look = (x, y, z) => { const l = Math.hypot(x, y, z); const f = p.local.clone().set(x / l, y / l, z / l); p.quat.setFromUnitVectors(p.local.clone().set(0, 0, -1), f); };
    document.querySelectorAll('body > *:not(canvas)').forEach((e) => { e.style.display = 'none'; });
    ${process.env.PRE ?? ''};
    ${setup};
    let n = 0;
    const errs = [];
    const f = () => {
      n++;
      // (Two seconds at rest first, then the flight.)
      if (n > 120) { p.local.x += __v[0] / 60 * LY; p.local.y += __v[1] / 60 * LY; p.local.z += __v[2] / 60 * LY; }
      if (n > 150 && n % 40 === 0) { const e = se.cloud.host.measureError(); if (e) errs.push([e.error, e.low, e.ratio, se.cloud.host.march.uniforms.uSteps.value]); }
      if (n < 400) requestAnimationFrame(f); else done(errs);
    };
    requestAnimationFrame(f);
  })`);
  const col = (k) => out.map((e) => e[k]).sort((a, b) => a - b);
  const med = (v) => v[v.length >> 1], max = (v) => v[v.length - 1];
  const e = col(0), lo = col(1), br = col(2);
  console.log(`${name} | ${(100 * med(e)).toFixed(2)}, ${(100 * max(e)).toFixed(2)} | ${(100 * med(lo)).toFixed(2)}, ${(100 * max(lo)).toFixed(2)} | ${med(br).toFixed(3)} | steps ${med(col(3))}`);
  await page.close();
}
await browser.close();
