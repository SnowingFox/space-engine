// How smoothly the galaxy sky follows the camera: per frame, how far the viewpoint the sky shows moves,
// against how far the camera moves. node scripts/gfollow.mjs [url]
// Even: the shown viewpoint advances by about the same amount every frame (max/median near 1, no still
// frames); stepping: still frames and jumps. Lag: how far behind the camera the shown viewpoint is.
import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://localhost:5173/';
const cases = [
  ['inside the disc, 10 ly/s', 'at(26700,30,200); look(0,0.02,-1)', [10, 0, 0]],
  ['inside the disc, 300 ly/s', 'at(20800,20,300); look(0,0.02,-1)', [300, 0, 0]],
  ['just above the disc, 300 ly/s', 'at(26000,1500,900); look(-0.3,-0.4,-1)', [300, 0, 0]],
  ['outside, 1.6 radii, 5 kly/s', 'at(20000,50000,60000); look(-0.2,-0.6,-0.8)', [5000, 0, 0]],
];
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 2000, height: 1144, deviceScaleFactor: 2 },
});
console.log('case | camera ly/frame | shown viewpoint ly/frame: median, p10, p90, max | still frames | lag ly (median) | drawn by');
for (const [name, setup, v] of cases) {
  // (Another change to the sources reloads the dev server's page mid-measurement: then measure again.)
  let page, out;
  for (let attempt = 0; ; attempt++) {
    try {
    page = await browser.newPage();
    await page.goto(url, { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 1500));
    out = await page.evaluate(`new Promise((done) => {
    const p = se.player, LY = 9.4607e12;
    const at = (x, y, z) => { const g = { x: 0, y: 0, z: 0 }; p.galactic(g); p.local.x += (x - g.x) * LY; p.local.y += (y - g.y) * LY; p.local.z += (z - g.z) * LY; };
    const look = (x, y, z) => { const l = Math.hypot(x, y, z); const f = p.local.clone().set(x / l, y / l, z / l); p.quat.setFromUnitVectors(p.local.clone().set(0, 0, -1), f); };
    ${setup};
    const V = ${JSON.stringify(v)};
    // (The viewpoint the galaxy around the camera is drawn from: GalaxyHost's march, or the old sky map's.)
    const shownEye = () => (se.cloud.shownEye ? se.cloud.shownEye() : se.cloud.volume.shownEye());
    let last = performance.now(), t0 = last;
    const shown = [], cam = [];
    const f = (n) => {
      const dt = Math.min((n - last) / 1000, 0.1); last = n;
      // (Read before this frame's move: what is on screen was drawn from where the camera was then.)
      if (n - t0 > 5000) { const g = { x: 0, y: 0, z: 0 }; p.galactic(g); cam.push([g.x, g.y, g.z]); shown.push(shownEye()); }
      if (n - t0 > 3000) { p.local.x += V[0] * dt * LY; p.local.y += V[1] * dt * LY; p.local.z += V[2] * dt * LY; }
      if (n - t0 < 8000) requestAnimationFrame(f); else done({ shown, cam, host: !!se.cloud.shownEye });
    };
    requestAnimationFrame(f);
  })`);
      break;
    } catch (e) {
      await page.close().catch(() => {});
      if (attempt >= 3) throw e;
    }
  }
  const drawnBy = (o) => (o.host ? 'on-screen march' : 'sky map');
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const camStep = out.cam.slice(1).map((c, i) => d(c, out.cam[i]));
  let line;
  if (out.shown.some((s) => s)) {
    // (The shown viewpoint is in the galaxy's frame; the Milky Way's frame is the universe's.)
    const steps = out.shown.slice(1).map((s, i) => (s && out.shown[i] ? d(s, out.shown[i]) : NaN)).filter((x) => !isNaN(x)).sort((a, b) => a - b);
    const q = (f) => steps[Math.floor(f * (steps.length - 1))];
    const med = q(0.5);
    const still = steps.filter((x) => x < 0.2 * Math.max(med, 1e-9)).length;
    const lags = out.shown.map((s, i) => (s ? d(s, out.cam[i]) : NaN)).filter((x) => !isNaN(x)).sort((a, b) => a - b);
    line = `${q(0.5).toFixed(2)}, ${q(0.1).toFixed(2)}, ${q(0.9).toFixed(2)}, ${steps[steps.length - 1].toFixed(2)} | ${still} of ${steps.length} | ${lags[lags.length >> 1].toFixed(1)} | ${drawnBy(out)}`;
  } else line = '- | - | - | billboard march (follows every frame)';
  camStep.sort((a, b) => a - b);
  console.log(`${name} | ${camStep[camStep.length >> 1].toFixed(2)} | ${line}`);
  await page.close();
}
await browser.close();
