// Render-only test page: one camera pose over one body, no game layer.
// /bench.html?body=2&moon=0&alt=0.3&sun=1.0&az=0.4&pitch=-0.1&turn=0&fov=60&seed=<star id for a generated system>
// alt: km above the ground (or above the datum beyond 5% of a radius). sun: angle between zenith and sun.
// seek=aurora: the night side at colat=<radians> from the pole. seek=high|low|land|lake|at: move to the highest / lowest / nearest dry spot, the nearest level stretch above the sea (a crater lake)
// or the spot nearest to h=<km> within 'reach' radians; stats() reports the sun/az it chose.
// se.cost(n): milliseconds per frame at full resolution with vsync out of the way.
import * as THREE from 'three';
import { Pipeline } from './render/pipeline';
import { initProbe } from './render/probe';
import { SystemView } from './render/systemView';
import { shadowStats } from './render/terrainShadow';
import { makeSolSystem } from './universe/sol';
import { makeSol, makeStar } from './universe/stars';
import { generateSystem } from './universe/system';
import { simTimeAt } from './universe/bodies';
import { SCENIC_EPOCH_MS } from './game/scenic';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);

const pipeline = new Pipeline(document.getElementById('view') as HTMLCanvasElement);
initProbe(pipeline.renderer);
const system = q.has('seed') ? generateSystem(makeStar(num('seed', 1), 0, 0, 0, 0)) : makeSolSystem(makeSol(0, 0, 0));
const view = new SystemView(system);
view.showOrbits = false;
pipeline.scene.add(view.group);

const planet = system.planets[num('body', 2)];
const body = q.has('moon') ? planet.moons[num('moon', 0)] : planet;
// t counts from the scenic epoch, so a pose found here pastes into src/game/scenic.ts.
const simTime = simTimeAt(SCENIC_EPOCH_MS) + num('t', 0);
view.advance(simTime);
const state = view.bodies.find((b) => b.body === body)!;

// Local frame at the chosen spot: zenith tilted away from the sun by 'sun', swung around the sun axis by 'az'.
const toSun = state.pos.clone().normalize().negate();
const side = new THREE.Vector3(0, 1, 0).cross(toSun).normalize();
let sunAngle = num('sun', 1.0), az = num('az', 0.4);
const spot = (s: number, a: number) => toSun.clone().applyAxisAngle(side, s).applyAxisAngle(toSun, a);
if (q.has('seek')) {
  const mode = q.get('seek'), reach = num('reach', 0.25), n = mode === 'lake' ? 140 : 24;
  let best = -Infinity;
  const s0 = sunAngle, a0 = az;
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
    const s = s0 + (i / n - 0.5) * 2 * reach, a = a0 + ((j / n - 0.5) * 2 * reach) / Math.max(Math.sin(s0), 0.2);
    const h = state.view.heightAlong(spot(s, a), simTime) ?? 0;
    const off = Math.hypot(i / n - 0.5, j / n - 0.5);
    if (mode === 'aurora') {
      // Under the auroral oval, on the night side.
      const p = spot(1.75 + (i / n) * 1.2, (j / n) * 2 * Math.PI);
      const score = -Math.abs(Math.acos(Math.abs(p.dot(state.view.axis))) - num('colat', 0.5));
      if (score > best) { best = score; sunAngle = 1.75 + (i / n) * 1.2; az = (j / n) * 2 * Math.PI; }
      continue;
    }
    if (mode === 'lake') {
      const e = 2 / body.radius;
      const level = h > 0.02 && state.view.heightAlong(spot(s + e, a), simTime) === h && state.view.heightAlong(spot(s, a + e), simTime) === h;
      if (level && 1 - off > best) { best = 1 - off; sunAngle = s; az = a; }
      continue;
    }
    const score = mode === 'high' ? h : mode === 'low' ? -h : mode === 'at' ? -Math.abs(h - num('h', 2)) - off : (h > 0.05 ? 1 : 0) - off;
    if (score > best) { best = score; sunAngle = s; az = a; }
  }
}
const zenith = spot(sunAngle, az);
const north = side.clone().applyAxisAngle(toSun, az);
const heading = north.clone().cross(zenith).normalize().applyAxisAngle(zenith, num('turn', 0));
const right = heading.clone().cross(zenith).normalize();
const forward = heading.clone().applyAxisAngle(right, num('pitch', -0.1)).normalize();
const up = right.clone().cross(forward).normalize();
const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, forward.clone().negate()));

const alt = num('alt', 1);
const fov = num('fov', 60);
const cam = new THREE.Vector3();
let fps = 0;
let last = performance.now();
let frames = 0;

function frame(now: number): void {
  const dt = (now - last) / 1000;
  last = now;
  if (dt > 0) fps += (1 / dt - fps) * 0.05;
  frames++;
  draw(now);
  requestAnimationFrame(frame);
}

function draw(now: number): void {
  // The first frames sit a little above the datum until the ground probe has answered.
  const ground = state.view.ground;
  const r = alt > body.radius * 0.05 ? body.radius + alt : (ground ?? body.radius * 1.02) + alt;
  cam.copy(state.pos).addScaledVector(zenith, r);
  view.advance(simTime);
  pipeline.setView(quat, fov);
  const half = Math.atan(Math.tan(THREE.MathUtils.degToRad(fov) / 2) * Math.hypot(1, pipeline.camera.aspect)) + 0.05;
  view.update(cam, simTime, now / 1000, forward, half);
  pipeline.render();
}
requestAnimationFrame(frame);

/** Milliseconds of GPU work per frame at the display's full pixel ratio, free of vsync and of dynamic resolution. */
function cost(n = 60): number {
  const p = pipeline as unknown as { resScale: number; resCheck: number; applyScale(): void };
  p.resScale = 1;
  p.resCheck = Infinity;
  p.applyScale();
  const gl = pipeline.renderer.getContext();
  const px = new Uint8Array(4);
  const run = () => {
    draw(performance.now());
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  };
  for (let i = 0; i < 8; i++) run();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) run();
  return (performance.now() - t0) / n;
}

Object.assign(window, {
  se: { pipeline, view, state, cost, spot, stats: () => ({ fps, patches: state.view.patchCount, altitude: cam.distanceTo(state.pos) - (state.view.ground ?? body.radius), frames, ratio: pipeline.pixelRatio, exposure: pipeline.exposure, shadowDraws: shadowStats.draws, sun: sunAngle, az }) },
});
