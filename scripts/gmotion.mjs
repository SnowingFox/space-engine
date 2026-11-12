// The galaxy in motion, scenario by scenario: frames of a flight recorded (CDP screencast) together with frame
// times, long tasks and, per frame, the camera and the viewpoint the galaxy is drawn from.
//   node scripts/gmotion.mjs <outdir> [url] [scenario names, comma-separated]
// (env W, H, DPR: window size, default 2000 x 1144 at 2; FRAMES: frames recorded, default 120)
// then: .texvenv/bin/python -I scripts/textures/gmotion.py <outdir>
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const [dir, url = 'http://localhost:5173/', only = ''] = process.argv.slice(2);
const N = 'const g=se.galaxy(window.__SPIRAL ?? "NGC 5697").galaxy; const a=g.axes;';
const K = 'const L=[-0.75,0.12,0.65]; at(17000,30,0); look(...L);';
const A = 'const g=se.galaxy("andromeda").galaxy; const d=[26000-g.x,18-g.y,900-g.z]; const l=Math.hypot(...d); window.__u=d.map(v=>v/l);';
// name, setup, velocity (ly/s; may use t, seconds since the flight began)
const scenarios = [
  ['sol-10', 'at(26000,18.00002,900); look(-0.7,0.03,0.7)', '-10,0,-0.35'],
  ['sol-300', 'at(26000,18.00002,900); look(-0.7,0.03,0.7)', '-300,0,-10'],
  ['sol-5k', 'at(26000,18.00002,900); look(-0.7,0.03,0.7)', '-5000,0,-170'],
  ['flyout', 'at(26000,18.00002,900); look(-1,-0.25,-0.03)', '0,Math.min(1500*Math.exp(1.6*t),60000),0'],
  ['andromeda', `${A} at(g.x+__u[0]*1.5e6,g.y+__u[1]*1.5e6,g.z+__u[2]*1.5e6); look(-__u[0],-__u[1],-__u[2])`, '-__u[0]*130000,-__u[1]*130000,-__u[2]*130000'],
  ['ngc5697', `${N} at(g.x+a[0]*12000+a[3]*100, g.y+a[1]*12000+a[4]*100, g.z+a[2]*12000+a[5]*100); look(-a[0]+a[6],-a[1]+a[7],-a[2]+a[8]); window.__a=a`, '__a[6]*500,__a[7]*500,__a[8]*500'],
  ['rest', 'at(26000,18.00002,900); look(-0.7,0.03,0.7)', '0,0,0'],
  // The user's case: 17 kly from the centre in the plane, a big near dark cloud in view, 6.48 kly/s, strafing and forward.
  ['k17-strafe', `${K} window.__v=[-L[2]*6480/Math.hypot(L[0],L[2]),0,L[0]*6480/Math.hypot(L[0],L[2])]`, '...__v'],
  ['k17-strafe1k', `${K} window.__v=[-L[2]*1000/Math.hypot(L[0],L[2]),0,L[0]*1000/Math.hypot(L[0],L[2])]`, '...__v'],
  // Between the galaxies, 30 Mly out, flying through them at 3 Mly/s.
  ['intergalactic', 'at(2e6,3e7,1e6); look(0.3,-1,0.2)', '0.86e6,-2.86e6,0.57e6'],
  ['k17-fwd', `${K} window.__v=L.map((v)=>v*6480/Math.hypot(...L))`, '...__v'],
].filter(([n]) => !only || only.split(',').includes(n));

const W = Number(process.env.W ?? 2000), H = Number(process.env.H ?? 1144), DPR = Number(process.env.DPR ?? 2);
const FRAMES = Number(process.env.FRAMES ?? 120);
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  defaultViewport: { width: W, height: H, deviceScaleFactor: DPR },
});
for (const [name, setup, vel] of scenarios) {
  const out = `${dir}/${name}`;
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 2000));
  await page.evaluate(`(() => {
    const p = se.player, LY = 9.4607e12;
    const at = (x, y, z) => { const g = { x: 0, y: 0, z: 0 }; p.galactic(g); p.local.x += (x - g.x) * LY; p.local.y += (y - g.y) * LY; p.local.z += (z - g.z) * LY; };
    const look = (x, y, z) => { const l = Math.hypot(x, y, z); const f = p.local.clone().set(x / l, y / l, z / l); p.quat.setFromUnitVectors(p.local.clone().set(0, 0, -1), f); };
    document.querySelectorAll('body > *:not(canvas)').forEach((e) => { e.style.display = 'none'; });
    // (A generated spiral of the cosmos, 19 Mly out; before it the old generated NGC 5697.)
    window.__SPIRAL = se.cosmos ? 'PGC 34630273004' : 'NGC 5697';
    ${process.env.PRE ?? ''};
    ${setup};
    window.__rec = { times: [], cams: [], shown: [], long: 0, go: false };
    new PerformanceObserver((l) => { window.__rec.long += l.getEntries().length; }).observe({ type: 'longtask', buffered: false });
    let last = performance.now(), t0 = 0;
    const f = (n) => {
      // (FIXED: the camera moves by 1/60 s of flight every frame, however long the frame took: a slow reference
      // render then shows the same views as a real-time one.)
      const dt = ${process.env.FIXED ? '1 / 60' : 'Math.min((n - last) / 1000, 0.1)'}; last = n;
      const r = window.__rec;
      if (r.go) {
        if (!t0) t0 = n;
        // (Read before this frame's move: what is on screen was drawn from where the camera was then.)
        const g = { x: 0, y: 0, z: 0 }; p.galactic(g);
        r.times.push(n); r.cams.push([g.x, g.y, g.z]);
        const s = se.cloud.shownEye ? se.cloud.shownEye() : se.cloud.volume?.shownEye?.();
        r.shown.push(s ?? null);
        const h = se.cloud.host;
        if (h) (r.host ??= []).push([h.resolve.uniforms.uBlend.value, h.march.uniforms.uSteps.value, h.resolve.uniforms.uDelta.value.length(), se.pipeline.pixelRatio, se.pipeline.exposure]);
        const t = (n - t0) / 1000, V = [${vel}];
        p.local.x += V[0] * dt * LY; p.local.y += V[1] * dt * LY; p.local.z += V[2] * dt * LY;
      }
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  })()`);
  // Settle in at the start point, then fly and record.
  await new Promise((r) => setTimeout(r, 4000));
  const cdp = await page.createCDPSession();
  let n = 0;
  const done = new Promise((resolve) => {
    cdp.on('Page.screencastFrame', async (e) => {
      if (n < FRAMES) fs.writeFileSync(`${out}/f${String(n).padStart(3, '0')}_${e.metadata.timestamp.toFixed(3)}.jpg`, Buffer.from(e.data, 'base64'));
      n++;
      await cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {});
      if (n >= FRAMES) resolve();
    });
  });
  await page.evaluate('window.__rec.go = true');
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1, maxWidth: 1000, maxHeight: 572 });
  await Promise.race([done, new Promise((r) => setTimeout(r, 20000))]);
  await cdp.send('Page.stopScreencast');
  const rec = await page.evaluate('JSON.stringify(window.__rec)');
  fs.writeFileSync(`${out}/rec.json`, rec);
  const r = JSON.parse(rec);
  const dts = r.times.slice(1).map((t, i) => t - r.times[i]).sort((a, b) => a - b);
  console.log(`${name}: ${n} frames recorded, ${dts.length} rAF frames, max ${dts.at(-1)?.toFixed(1)} ms, >25 ms ${dts.filter((x) => x > 25).length}, long tasks ${r.long}`);
  await page.close();
}
await browser.close();
