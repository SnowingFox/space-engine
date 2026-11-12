// Frame-rate profile of a list of views: node scripts/perf.mjs [view ...]
// For each view: load the page, place the camera, wait for it to settle, then record over several windows
// the frame rate, frame-time percentiles, the dynamic-resolution ratio, JS time per frame and GPU time per pass
// (EXT_disjoint_timer_query_webgl2 around every renderer.render call).
// Env: W, H, DPR (default 2000 x 1144 @ 2), RUNS (windows per view, 3), SAMPLE (ms per window, 4000),
// SETTLE (ms, 9000), OFF (js run before measuring, e.g. to hide a feature), LOCK=1 (hold full resolution),
// SHOT=prefix (screenshot each view to shots/<prefix><view>.png), JSON=file (append results).
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const HELPERS = fs.readFileSync(new URL('./perfViews.js', import.meta.url), 'utf8');

// Views: [name, setup js, optional per-frame js (runs every animation frame, dt in seconds)].
const VIEWS = {
  disc: ["viewB('Earth', 15000, 30)"],
  e400: ["poseAt({ kind: 'body', star: 'sol', planet: 2, alt: 400, sun: 0.9, az: 2.4, turn: 3.0, pitch: -0.35 }, 'Earth', 15)"],
  eorbit: ["se.scenic('earth-orbit')"],
  night: ["poseAt({ kind: 'body', star: 'sol', planet: 2, alt: 400, sun: 2.3, az: 2.5, turn: 0, pitch: -0.45 }, 'Earth', 10)"],
  alps25: ["poseLL({ kind: 'body', star: 'sol', planet: 2, alt: 25, sun: 1.05, az: 2.6, turn: 1.2, pitch: -0.25 }, 'Earth', 46.4, 8.2)"],
  ground: ["poseLL({ kind: 'body', star: 'sol', planet: 2, alt: 1.5, sun: 1.05, az: 2.6, turn: 1.2, pitch: -0.06 }, 'Earth', 46.4, 8.2)"],
  sunset: ["poseLL({ kind: 'body', star: 'sol', planet: 2, alt: 0.4, sun: 1.5, az: 2.3, turn: 3.0, pitch: 0.02 }, 'Earth', 46.6, 10.5)"],
  sunsetsea: ["poseAt({ kind: 'body', star: 'sol', planet: 2, alt: 0.4, sun: 1.52, az: 2.3, turn: 3.0, pitch: 0.02 }, 'Earth', 10)"],
  moon: ["poseLL({ kind: 'body', star: 'sol', planet: 2, moon: 0, alt: 3, sun: 1.2, az: 0.5, turn: 1.4, pitch: -0.08 }, 'Moon', -43, -11)"],
  marsground: ["poseLL({ kind: 'body', star: 'sol', planet: 3, alt: 2, sun: 0.9, az: 0.3, turn: 1.4, pitch: -0.08 }, 'Mars', -8, -72)"],
  saturn: ["se.scenic('saturn-rings')"],
  gen: ["se.scenic('terra-dusk')"],
  // Fast and low over the Alps: 3 km/s at 2 km, so the terrain patches churn.
  fly: [
    "poseLL({ kind: 'body', star: 'sol', planet: 2, alt: 2, sun: 1.05, az: 2.6, turn: 1.2, pitch: -0.12 }, 'Earth', 46.4, 8.2)",
    `{ const st = se.getView().bodies.find((b) => b.body.name === 'Earth');
       const V = p.local.constructor;
       const up = p.local.clone().sub(st.pos).normalize();
       const f = new V(0, 0, -1).applyQuaternion(p.quat);
       const axis = up.clone().cross(f).normalize();
       const a = 3 * dt / 6373;
       p.local.sub(st.pos).applyAxisAngle(axis, a).add(st.pos);
       p.quat.premultiply(new p.quat.constructor().setFromAxisAngle(axis, a)); }`,
  ],
};

// Lighting shots (not in the default list). Dates are real: the Solar System follows its ephemerides.

Object.assign(VIEWS, {
  // Total solar eclipse of 2024-04-08 from the centre line in Durango, Mexico, looking at the Sun.
  Lsolar: ["sunFrom('Earth', 25.29, -104.14, 0.4, 50, '2024-04-08T18:18:00Z')"],
  Lsolarwide: ["sunFromLow('Earth', 25.29, -104.14, 0.4, 100, '2024-04-08T18:18:00Z', 52)"],
  // The same moment from 25 000 km above the sunlit side: the Moon's shadow on Earth.
  Lsolarspace: ["viewFrom('Earth', 'sun', 25000, 45, '2024-04-08T18:18:00Z')"],
  // Total lunar eclipse of 2025-03-14, the Moon seen from 30 000 km on Earth's side.
  Llunar: ["viewFrom('Moon', 'Earth', 30000, 35, '2025-03-14T06:59:00Z')"],
  // Three days after new moon: a thin crescent with Earthshine on the rest, from Earth's side.
  Learthshine: ["viewFrom('Moon', 'Earth', 40000, 40, '2024-04-11T06:00:00Z')"],
  // Io's shadow on Jupiter, from the sunward side.
  Ljupiter: ["viewFrom('Jupiter', 'sun', 450000, 40, transit('Jupiter', 'Io', '2025-02-01T00:00:00Z', 2))"],
  // Saturn's shadow across the rings (seen from behind and above), and the rings' shadow on Saturn (from the Sun's side).
  Lsatshadow: ["orbitView('Saturn', 125, 28, 420000, 50, '2020-03-01T00:00:00Z')"],
  Lringshadow: ["orbitView('Saturn', 15, 22, 330000, 50, '2020-03-01T00:00:00Z')"],
  // Backlit: the Sun just off Saturn's limb, the night side lit by the rings.
  Lbacklit: ["behind('Saturn', 600000, 9, 55, '2020-03-01T00:00:00Z')"],
  // Night and twilight on the ground, looking along the horizon away from the Sun (sun: radians from the zenith).
  Lnight: ["poseAt({ kind: 'body', star: 'sol', planet: 2, alt: 0.35, sun: 2.7, az: 2.3, turn: 0.4, pitch: 0.12 }, 'Earth', 20)"],
  Ltw6: ["poseAt({ kind: 'body', star: 'sol', planet: 2, alt: 0.35, sun: 1.676, az: 2.3, turn: 0.0, pitch: 0.12 }, 'Earth', 20)"],
  Ltw12: ["poseAt({ kind: 'body', star: 'sol', planet: 2, alt: 0.35, sun: 1.78, az: 2.3, turn: 0.0, pitch: 0.12 }, 'Earth', 20)"],
  Ltw6anti: ["poseAt({ kind: 'body', star: 'sol', planet: 2, alt: 0.35, sun: 1.676, az: 2.3, turn: 3.14, pitch: 0.12 }, 'Earth', 20)"],
  // The user's night view: Vela and Carina low over the horizon, from 350 m.
  Lvela: ["nightToward('Carina', 0.35, 4)"],
  // Orbital sunrise from 1 636 km: the Sun just over the limb (the user's seam report).
  Lsunrise: ["limbSun(1636, 20, 28, 60, 35)"],
  Lsunrise400: ["limbSun(400, 15, 22, 60, 35)"],
  // Dusk from high up (30 km, the Sun 5 degrees below the horizon): the twilight band along the horizon.
  Lduskhigh: ["poseAt({ kind: 'body', star: 'sol', planet: 2, alt: 30, sun: 1.66, az: 2.3, turn: 3.14, pitch: -0.04 }, 'Earth', 20)"],
  Lduskhigh2: ["poseAt({ kind: 'body', star: 'sol', planet: 2, alt: 40, sun: 1.7, az: 2.3, turn: 1.57, pitch: -0.05 }, 'Earth', 20)"],
  // The night limb from ISS altitude.
  Llimb: ["poseAt({ kind: 'body', star: 'sol', planet: 2, alt: 420, sun: 2.6, az: 2.3, turn: 0.0, pitch: -0.2 }, 'Earth', 20)"],
  // Mercury from 43 km: the Sun 5 degrees up, in view; and high (40 degrees from the zenith), looking at the ground away from it.
  Lmerclow: ["orbitB('Mercury', 43, 85, 0, -2)"],
  Lmerchigh: ["orbitB('Mercury', 3, 40, 180, -70)"],
  // Close-ups of a generated world's ground, looking down from 20 m and 2 m.
  Lgen20: ["se.scenic('terra-dusk'); setTimeout(() => lookDown(0.02, 80), 3000)"],
  Lgen2: ["se.scenic('terra-dusk'); setTimeout(() => lookDown(0.002, 60), 3000)"],
  // Saturn backlit from 200 000 km, the Sun 15 degrees off the line through it (the coordinator's test).
  Lsatback: ["behind('Saturn', 200000, 15, 70, '2020-03-01T00:00:00Z')"],
  Lsatback2: ["behind('Saturn', 260000, 25, 70, '2025-11-01T00:00:00Z')"],
  // The Alps by geography at fixed moments (summer morning, low sun in the evening), for shadows and ground detail.
  Lalpsam: ["at('2025-07-01T07:30:00Z', () => geoB('Earth', 46.45, 8.1, 1.5, 120, -7))"],
  Lalpspm: ["at('2025-07-01T18:30:00Z', () => geoB('Earth', 46.45, 8.1, 1.2, 240, -5))"],
  // From 70 AU (and 5 AU) looking back at the inner Solar System: the Sun a point, the planets wandering stars.
  Lfar70: ["at('2025-06-01T00:00:00Z', () => { se.getView().showOrbits = false; p.local.set(0, 2.0e9, 1.03e10); aimAt(p.local.clone().set(0, 0, 0)); }, 40)"],
  Lfar5: ["at('2025-06-01T00:00:00Z', () => { se.getView().showOrbits = false; p.local.set(0, 1.5e8, 7.4e8); aimAt(p.local.clone().set(0, 0, 0)); }, 60)"],
  // Earth and the Moon seen from near Mars: two points of light.
  Learthmars: ["at('2025-06-01T00:00:00Z', () => { se.getView().showOrbits = false; const t = se.state().simTime; const c = bodyAt('Mars', t), e = bodyAt('Earth', t); se.placeAt({ kind: 'body', star: se.earth.star, body: bodyState('Mars').body }); p.local.copy(c).addScaledVector(e.clone().sub(c).normalize(), 20000); aimAt(e); }, 20)"],
  // Earth's ground at noon and at dusk (cloud shadows, sky light).
  Lnoon: ["poseLL({ kind: 'body', star: 'sol', planet: 2, alt: 2.5, sun: 0.5, az: 2.6, turn: 1.2, pitch: -0.2 }, 'Earth', 46.4, 8.2)"],
  Ldusk: ["poseLL({ kind: 'body', star: 'sol', planet: 2, alt: 1.0, sun: 1.45, az: 2.6, turn: 2.2, pitch: -0.05 }, 'Earth', 46.4, 8.2)"],
});
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(VIEWS).filter((k) => !k.startsWith('L'));
const W = Number(process.env.W ?? 2000), H = Number(process.env.H ?? 1144), DPR = Number(process.env.DPR ?? 2);
const RUNS = Number(process.env.RUNS ?? 3), SAMPLE = Number(process.env.SAMPLE ?? 4000), SETTLE = Number(process.env.SETTLE ?? 9000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const others = () => {
  try {
    return execSync('pgrep -f "Google Chrome.*--headless" | wc -l').toString().trim();
  } catch { return '?'; }
};

// Installed before the app loads: times every animation-frame callback (JS cost per frame).
const PRELUDE = `(() => {
  const raf = window.requestAnimationFrame.bind(window);
  window.__perf = { cpu: 0, cpuFrames: 0, render: 0, readback: 0, readbacks: 0 };
  window.requestAnimationFrame = (cb) => raf((t) => {
    const t0 = performance.now();
    // (Held still for A/B screenshots, so animated water and clouds do not show up as differences.)
    cb(window.__freezeT ?? t);
    window.__perf.cpu += performance.now() - t0;
    window.__perf.cpuFrames++;
  });
})();`;

// Installed after load: GPU timer queries around each renderer.render, per-frame sampling.
const INSTRUMENT = `(() => {
  const P = window.__perf, pl = se.pipeline, r = pl.renderer, gl = r.getContext();
  const ext = window.__gpuTiming ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
  P.gpu = {}; P.gpuOk = !!ext; P.frames = []; P.ratios = []; P.pending = [];
  const label = (scene, cam) => {
    if (scene === pl.bgScene) return cam.layers.mask === 2 ? 'soft' : 'bg';
    if (scene === pl.scene) return 'main';
    const t = r.getRenderTarget();
    if (!t) return 'post';
    if (t.width === 1 && t.height === 1) return 'probe';
    if (t.depthTexture && t.width === 2 * t.height) return 'shadow';
    if (t === pl.composer?.readBuffer || t === pl.composer?.writeBuffer) return 'post';
    if (t.width === 48) return 'meter';
    return scene.isMesh ? 'post' : 'other';
  };
  const render = r.render.bind(r);
  let active = false;
  r.render = (scene, cam) => {
    if (!ext || active) return render(scene, cam);
    const q = gl.createQuery();
    active = true;
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    render(scene, cam);
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    active = false;
    P.pending.push([q, label(scene, cam)]);
  };
  const rt = r.readRenderTargetPixels.bind(r);
  r.readRenderTargetPixels = (...a) => { const t0 = performance.now(); rt(...a); P.readback += performance.now() - t0; P.readbacks++; };
  const pr = pl.render.bind(pl);
  pl.render = () => { const t0 = performance.now(); pr(); P.render += performance.now() - t0; };
  P.collect = () => {
    const keep = [];
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) { for (const [q] of P.pending) gl.deleteQuery(q); P.pending = []; return; }
    for (const e of P.pending) {
      if (!gl.getQueryParameter(e[0], gl.QUERY_RESULT_AVAILABLE)) { keep.push(e); continue; }
      if (P.recording) P.gpu[e[1]] = (P.gpu[e[1]] ?? 0) + gl.getQueryParameter(e[0], gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(e[0]);
    }
    P.pending = keep;
  };
  let last = 0;
  const tick = (t) => {
    if (P.recording) { if (last) P.frames.push(t - last); P.ratios.push(pl.pixelRatio); }
    last = t;
    if (ext) P.collect();
    if (P.perFrame) P.perFrame((t - (P.lastT ?? t)) / 1000);
    P.lastT = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // Milliseconds per pipeline.render at full resolution, back to back with a pixel read after each
  // (so each waits for the GPU): the GPU cost of the frame free of vsync and dynamic resolution.
  P.cost = (n = 20) => {
    const s = pl.resScale, c = pl.resCheck;
    pl.resScale = 1; pl.resCheck = Infinity; pl.applyScale();
    const px = new Uint8Array(4);
    const one = () => { pr(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
    for (let i = 0; i < 4; i++) one();
    const t0 = performance.now();
    for (let i = 0; i < n; i++) one();
    const ms = (performance.now() - t0) / n;
    pl.resScale = s; pl.resCheck = c; pl.applyScale();
    return +ms.toFixed(2);
  };
  P.start = () => { P.frames = []; P.ratios = []; P.gpu = {}; P.cpu = 0; P.cpuFrames = 0; P.render = 0; P.readback = 0; P.readbacks = 0; P.recording = true; };
  P.stop = () => {
    P.recording = false;
    const f = [...P.frames].sort((a, b) => a - b), n = f.length;
    const pct = (q) => f[Math.min(n - 1, Math.floor(q * n))];
    const total = P.frames.reduce((a, b) => a + b, 0);
    const gpu = {}; let sum = 0;
    for (const k in P.gpu) { gpu[k] = +(P.gpu[k] / n).toFixed(2); sum += P.gpu[k] / n; }
    return {
      fps: +(1000 * n / total).toFixed(1), p50: +pct(0.5).toFixed(1), p95: +pct(0.95).toFixed(1), max: +f[n - 1].toFixed(1),
      ratio: +(P.ratios.reduce((a, b) => a + b, 0) / P.ratios.length / pl.baseRatio).toFixed(2), base: +pl.baseRatio.toFixed(2),
      cpu: +(P.cpu / Math.max(P.cpuFrames, 1)).toFixed(2), submit: +(P.render / Math.max(P.cpuFrames, 1)).toFixed(2),
      readback: +(P.readback / Math.max(P.cpuFrames, 1)).toFixed(2), gpu, gpuSum: +sum.toFixed(2),
      patches: se.stats().patches, alt: +se.stats().altitude.toFixed(2),
      // Frames that took two vsyncs or more, as a share of all frames.
      slow: +(f.filter((x) => x > 25).length / n).toFixed(2),
      trace: window.__trace ? P.frames.map((x) => Math.round(x)).join(' ') : undefined,
    };
  };
})()`;

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', `--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H, deviceScaleFactor: DPR },
});
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const results = [];
for (const name of names) {
  const [setup, perFrame] = VIEWS[name] ?? [name];
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if ((m.type() === 'error' || (process.env.WARN && m.type() === 'warning')) && !m.text().includes('404')) errors.push(m.text().slice(0, 400)); });
  // No hot reloads in the middle of a measurement (other edits land while this runs).
  await page.setRequestInterception(true);
  page.on('request', (rq) => (rq.url().includes('/@vite/client') ? rq.abort() : rq.continue()));
  await page.evaluateOnNewDocument(PRELUDE);
  // A fresh tab: no flight restored from an earlier one.
  await page.evaluateOnNewDocument('sessionStorage.clear()');
  await page.goto(process.env.URL ?? 'http://localhost:5173/', { waitUntil: 'load' });
  await sleep(1500);
  // The app's own orbit and spin model, for the camera helpers.
  await page.evaluate("import('/src/universe/bodies.ts').then((m) => { window.__bodies = m; }, () => {})");
  await page.evaluate("import('/src/render/lighting.ts').then((m) => { window.__light = m.lightSwitches; }, () => {})");
  await page.evaluate("import('/src/universe/nebulae.ts').then((m) => { window.__nebulae = m; }, () => {})");
  if (process.env.GPU) await page.evaluate('window.__gpuTiming = true');
  if (process.env.TRACE) await page.evaluate('window.__trace = true');
  await page.evaluate(INSTRUMENT);
  await page.evaluate(`(() => {
    const p = se.player;
    const look = (x, y, z) => { const l = Math.hypot(x, y, z); const f = p.local.clone().set(x / l, y / l, z / l); p.quat.setFromUnitVectors(p.local.clone().set(0, 0, -1), f); };
    document.querySelectorAll('body > *:not(canvas)').forEach((e) => { e.style.display = 'none'; });
    ${HELPERS};
    ${setup};
    ${perFrame ? `window.__perf.perFrame = (dt) => { ${perFrame} };` : ''}
  })()`);
  await sleep(SETTLE);
  if (process.env.SHOT) await page.screenshot({ path: `shots/${process.env.SHOT}${name}.png` });
  if (process.env.OFF) await page.evaluate(process.env.OFF);
  if (process.env.EVAL) {
    // A script of one's own, run with the camera helpers in scope.
    const js = fs.readFileSync(process.env.EVAL, 'utf8');
    const got = await page.evaluate(`(() => { const p = se.player; const look = (x, y, z) => { const l = Math.hypot(x, y, z); const f = p.local.clone().set(x / l, y / l, z / l); p.quat.setFromUnitVectors(p.local.clone().set(0, 0, -1), f); }; ${HELPERS}; return ${js}; })()`);
    console.log(name, got, errors.length ? `ERRORS ${errors.join(' | ')}` : '');
    await page.close();
    continue;
  }
  if (process.env.COST) {
    // GPU cost only: the fastest of several back-to-back timings at full resolution (the least disturbed by other work on the GPU).
    const c = [];
    for (let i = 0; i < Number(process.env.COST); i++) { c.push(await page.evaluate('window.__perf.cost(8)')); await sleep(250); }
    const res = { view: name, tag: process.env.TAG ?? '', costMin: Math.min(...c), costMed: median(c), others: others() };
    console.log(JSON.stringify(res));
    if (process.env.JSON) fs.appendFileSync(process.env.JSON, JSON.stringify(res) + '\n');
    await page.close();
    continue;
  }
  if (process.env.SHOTAB) {
    // The same frame with the toggled part on (a) and off (b), with time held still, for a pixel diff.
    await page.evaluate('se.time("pause"); window.__freezeT = performance.now(); { const p = se.pipeline; p.resScale = 1; p.resCheck = Infinity; p.applyScale(); }');
    for (const [on, tag] of [[true, 'a'], [false, 'b']]) {
      await page.evaluate(`window.__toggle(${on})`);
      await sleep(1500);
      await page.screenshot({ path: `shots/${process.env.SHOTAB}${name}_${tag}.png` });
    }
    await page.close();
    continue;
  }
  if (process.env.AB) {
    // Alternate the frame with and without the toggled part, timing each at full resolution.
    const on = [], off = [];
    for (let i = 0; i < Number(process.env.AB_N ?? 6); i++) {
      await page.evaluate('window.__toggle(true)'); await sleep(350);
      on.push(await page.evaluate('window.__perf.cost(10)'));
      await page.evaluate('window.__toggle(false)'); await sleep(350);
      off.push(await page.evaluate('window.__perf.cost(10)'));
    }
    const diffs = on.map((a, i) => a - off[i]);
    const res = { view: name, tag: process.env.TAG ?? '', onMin: Math.min(...on), offMin: Math.min(...off), onMed: median(on), offMed: median(off), saved: +median(diffs).toFixed(2), savedMin: +(Math.min(...on) - Math.min(...off)).toFixed(2), others: others() };
    console.log(JSON.stringify(res));
    if (process.env.JSON) fs.appendFileSync(process.env.JSON, JSON.stringify(res) + '\n');
    await page.close();
    continue;
  }
  if (process.env.OFF) await page.evaluate('window.__toggle(false)');
  if (process.env.LOCK) {
    await page.evaluate('(() => { const p = se.pipeline; p.resScale = 1; p.resCheck = Infinity; p.applyScale(); })()');
    await sleep(1000);
  }
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    const contention = others();
    await page.evaluate('window.__perf.start()');
    await sleep(SAMPLE);
    runs.push({ ...(await page.evaluate('window.__perf.stop()')), others: contention });
    await sleep(300);
  }
  const costs = [];
  for (let i = 0; i < RUNS; i++) {
    costs.push(await page.evaluate('window.__perf.cost()'));
    await sleep(400);
  }
  const pick = (k) => median(runs.map((r) => r[k]));
  const gpuKeys = [...new Set(runs.flatMap((r) => Object.keys(r.gpu)))];
  const gpu = Object.fromEntries(gpuKeys.map((k) => [k, median(runs.map((r) => r.gpu[k] ?? 0))]));
  const res = {
    view: name, fps: pick('fps'), p50: pick('p50'), p95: pick('p95'), ratio: pick('ratio'), cpu: pick('cpu'), submit: pick('submit'),
    readback: pick('readback'), slow: pick('slow'), cost: median(costs), costMin: Math.min(...costs), costRuns: costs, gpuSum: pick('gpuSum'), gpu, patches: pick('patches'), alt: runs[0].alt,
    fpsRuns: runs.map((r) => r.fps), others: runs.map((r) => r.others).join('/'), errors: errors.slice(0, 3),
  };
  results.push(res);
  console.log(JSON.stringify(res));
  await page.close();
}
await browser.close();
if (process.env.JSON) fs.appendFileSync(process.env.JSON, results.map((r) => JSON.stringify({ ...r, tag: process.env.TAG ?? '' })).join('\n') + '\n');
console.log('\nview         fps   p50   p95  slow ratio  cost  cpu  rdbk patches');
for (const r of results) {
  const gpu = Object.entries(r.gpu).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(`${r.view.padEnd(11)} ${String(r.fps).padStart(5)} ${String(r.p50).padStart(5)} ${String(r.p95).padStart(5)}  ${r.slow.toFixed(2)} ${r.ratio.toFixed(2)} ${r.cost.toFixed(1).padStart(5)} ${r.cpu.toFixed(1).padStart(4)} ${r.readback.toFixed(1).padStart(5)} ${String(r.patches).padStart(6)}  runs ${r.fpsRuns.join(',')} cost ${r.costRuns.join(',')} procs ${r.others} ${gpu}`);
}
