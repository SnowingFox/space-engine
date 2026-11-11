// Records the frames of a flight (CDP screencast) to measure how evenly the sky moves:
//   node scripts/grecord.mjs <outdir> "<setup js>" "<vx,vy,vz ly/s, may use t: seconds since the start>" [frames 60] [url]
// (env W, H, DPR: window size; WAIT: ms of flight before recording starts, default 2000)
// then: .texvenv/bin/python -I scripts/textures/motion.py <outdir>
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const [dir, setup, vel, count = '60', url = 'http://localhost:5173/'] = process.argv.slice(2);
fs.mkdirSync(dir, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  defaultViewport: { width: Number(process.env.W ?? 1000), height: Number(process.env.H ?? 572), deviceScaleFactor: Number(process.env.DPR ?? 1) },
});
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 1500));
await page.evaluate(`(() => {
  const p = se.player, LY = 9.4607e12;
  const at = (x, y, z) => { const g = { x: 0, y: 0, z: 0 }; p.galactic(g); p.local.x += (x - g.x) * LY; p.local.y += (y - g.y) * LY; p.local.z += (z - g.z) * LY; };
  const look = (x, y, z) => { const l = Math.hypot(x, y, z); const f = p.local.clone().set(x / l, y / l, z / l); p.quat.setFromUnitVectors(p.local.clone().set(0, 0, -1), f); };
  document.querySelectorAll('body > *:not(canvas)').forEach((e) => { e.style.display = 'none'; });
  ${setup};
  let last = performance.now(), t0 = 0;
  const f = () => {
    const n = performance.now(), dt = Math.min((n - last) / 1000, 0.1); last = n;
    if (!t0) t0 = n;
    const t = (n - t0) / 1000, V = [${vel}];
    p.local.x += V[0] * dt * LY; p.local.y += V[1] * dt * LY; p.local.z += V[2] * dt * LY;
    requestAnimationFrame(f);
  };
  setTimeout(() => requestAnimationFrame(f), 4000);
})()`);
await new Promise((r) => setTimeout(r, 4000 + Number(process.env.WAIT ?? 2000)));
const cdp = await page.createCDPSession();
let n = 0;
const done = new Promise((resolve) => {
  cdp.on('Page.screencastFrame', async (e) => {
    if (n < Number(count)) fs.writeFileSync(`${dir}/f${String(n).padStart(3, '0')}_${e.metadata.timestamp.toFixed(3)}.jpg`, Buffer.from(e.data, 'base64'));
    n++;
    await cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId });
    if (n >= Number(count)) resolve();
  });
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1, maxWidth: 1000, maxHeight: 572 });
await done;
await cdp.send('Page.stopScreencast');
console.log(dir, n, 'frames');
await browser.close();
