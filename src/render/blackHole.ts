import * as THREE from 'three';
import { C_KM_S, KM_PER_LY } from '../core/units';
import type { LabelSource } from '../game/labels';
import type { Obstacle, Player } from '../game/player';
import { blackHoleTarget, targetPosition, type Target } from '../game/target';
import { BLACK_HOLES, blackHoleOffset, syncGeneratedHoles, type BlackHoleData } from '../universe/blackHoles';
import { SHADOW_BINS, iscoRadius, shadowTable } from '../universe/kerr';
import { temperatureToRgb } from '../universe/stars';
import type { LensParams, LensPass } from './lensPass';

// Per frame: which black holes are worth the lens pass (on screen and lensing by a pixel or more, or with a
// disc or jet bigger than a few pixels), what it needs to draw them, where the camera may not go, and the
// distant ones as points of light (an active nucleus far away is a star-like point, as quasars are).
//
// Brightness: a hole's accretion light is its visible luminosity seen as a disc: flux 2 |cos i| L / d^2
// (isotropic-equivalent) through the starfield's magnitude law while it is a point. Once the radius that holds
// half its light is resolved, the traced disc takes over with the same total light at the handover (matched
// face-on), after which its surface brightness stays constant, as a surface's does at any distance. Within the
// disc the intensity is the physics, uncompressed: Planck's law at 550 nm for the gas's temperature, Doppler
// and gravitationally shifted, I = g^3 B(nu / g, T): beaming like g^3.5 for a cool disc, gentler (~g) for
// one so hot that the visible is on its Rayleigh-Jeans tail.

/** The starfield's point of light (starfield.ts): intensity at the centre and size (CSS px) for a magnitude. */
function pointLight(mag: number): [number, number] {
  const intensity = Math.min(Math.pow(2.512, 0.7 * (3.6 - mag)), 9) * (1 - THREE.MathUtils.smoothstep(mag, 6.0, 8.8));
  return [intensity, THREE.MathUtils.clamp(2.7 - mag * 0.32, 1, 3.8)];
}
const magnitude = (lum: number, dLy: number): number => -2.5 * Math.log10(Math.max(lum, 1e-30) / (dLy * dLy)) - 2.74;
/** The size on screen (px) of the radius holding half a disc's light, at which the traced disc takes over from the point. */
const HANDOVER_PX = 2.75;
/** The fastest the disc's gas is shown to turn at its inner edge: a turn in 12 s (Cygnus X-1's takes 4 ms). */
const MAX_TURN = (2 * Math.PI) / 12;

/** The camera is held this many Schwarzschild radii from the centre (twice the photon sphere: the innermost stable orbit). */
export const KEEP_OUT = 3;
const MAX_HOLES = 2;

const POINT_VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aLum;
uniform float uPixelRatio;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = max(length(mv.xyz), 1e-6);
  // As the stars do (starfield.ts): apparent magnitude from L / d^2, then a compressed brightness.
  float mag = -2.5 * log(max(aLum, 1e-30) / (d * d)) / 2.302585 - 2.74;
  float intensity = clamp(pow(2.512, 0.7 * (3.6 - mag)), 0.0, 9.0) * smoothstep(8.8, 6.0, mag);
  vColor = aColor * intensity;
  gl_PointSize = clamp(2.7 - mag * 0.32, 1.0, 3.8) * uPixelRatio;
  gl_Position = projectionMatrix * mv;
  if (intensity <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;
const POINT_FRAG = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  gl_FragColor = vec4(vColor * (exp(-r2 * 5.0) - 0.0067), 1.0);
}
`;

export interface NearHole {
  bh: BlackHoleData;
  /** Distance from the centre, km, and in Schwarzschild radii. */
  dist: number;
  ro: number;
}

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const off0 = { x: 0, y: 0, z: 0 };
const off1 = { x: 0, y: 0, z: 0 };

export class BlackHoles {
  /** Those with light of their own, drawn as points while too small to trace. */
  private lit: BlackHoleData[] = [];
  /** (The list of holes as last seen: generated galaxies' come and go, syncGeneratedHoles.) */
  private listVersion = -1;
  private readonly points: THREE.Points;
  private readonly pointMat: THREE.ShaderMaterial;
  private readonly params: LensParams[] = Array.from({ length: MAX_HOLES }, () => ({
    cam: new THREE.Vector3(), axis: new THREE.Vector3(), reachCos: 1, shadowCos: 1, disc: new THREE.Vector4(), opacity: 1,
    spin: new THREE.Vector3(), shadow: new Float32Array(SHADOW_BINS * 2), phase: 0, step: 0, corona: new THREE.Vector3(),
    jet: new THREE.Vector4(), knots: Array.from({ length: 8 }, () => new THREE.Vector2()), point: new THREE.Vector4(),
    occluder: new THREE.Vector4(), shadowRect: new THREE.Vector4(),
  }));
  /** The shadow table each slot holds, by hole and inclination, so it is rebuilt only when the view changes. */
  private readonly shadowKey: string[] = [];
  /** Per hole this frame: camera distance (r_s) and how much of its point gives way to the traced disc. */
  private readonly roOf = new Map<number, number>();
  private readonly posOf = new Map<number, THREE.Vector3>();
  private pos(bh: BlackHoleData): THREE.Vector3 {
    let v = this.posOf.get(bh.id);
    if (!v) this.posOf.set(bh.id, (v = new THREE.Vector3()));
    return v;
  }
  private ro(bh: BlackHoleData): number {
    return this.roOf.get(bh.id) ?? Infinity;
  }
  private readonly inPass = new Set<number>();
  /** The lowest exposure the eye may adapt to now (pipeline.minExposure). */
  minExposure = 0.6;
  /** The nearest hole, for the HUD's place readout. */
  near: NearHole | null = null;

  constructor(bgScene: THREE.Scene, private readonly lens: LensPass, pixelRatio: number) {
    this.pointMat = new THREE.ShaderMaterial({
      vertexShader: POINT_VERT, fragmentShader: POINT_FRAG, uniforms: { uPixelRatio: { value: pixelRatio } },
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
    });
    this.points = new THREE.Points(new THREE.BufferGeometry(), this.pointMat);
    this.points.frustumCulled = false;
    this.relist();
    bgScene.add(this.points);
  }

  /** The holes with light of their own, as points: again whenever the list of holes changes. */
  private relist(): void {
    this.lit = BLACK_HOLES.filter((b) => b.lum > 0 && !b.companion);
    const n = this.lit.length;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const col = new Float32Array(n * 3);
    this.lit.forEach((b, i) => {
      const c = temperatureToRgb(b.disc ? b.disc.tMax * 0.7 : 9000);
      // A jet's synchrotron light is bluer.
      const j = b.jet ? 0.5 : 0;
      col.set([c[0] * (1 - j) + 0.62 * j, c[1] * (1 - j) + 0.74 * j, c[2] * (1 - j) + 1.0 * j], i * 3);
    });
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aLum', new THREE.BufferAttribute(new Float32Array(this.lit.map((b) => b.lum)), 1));
    this.points.geometry.dispose();
    this.points.geometry = g;
    // (Those no longer listed are forgotten.)
    const ids = new Set(BLACK_HOLES.map((b) => b.id));
    for (const id of this.posOf.keys()) if (!ids.has(id)) { this.posOf.delete(id); this.roOf.delete(id); }
  }

  /** km from the anchor star to a hole now. */
  private position(bh: BlackHoleData, player: Player, simTime: number, out: THREE.Vector3): THREE.Vector3 {
    return targetPosition(blackHoleTarget(bh), player.anchor, simTime, out);
  }

  /**
   * Close to a hole that orbits its companion, ride along with it (as with a planet one is near),
   * so it does not slip away at hundreds of km/s.
   */
  rideAlong(player: Player, before: number, now: number): void {
    if (before === now) return;
    for (const bh of BLACK_HOLES) {
      if (!bh.orbit || !bh.companion || player.anchor.id !== bh.companion.id) continue;
      const p = this.position(bh, player, before, v1);
      const d = p.distanceTo(player.local);
      if (d > bh.orbit.a * 0.3) continue;
      blackHoleOffset(bh, before, off0);
      blackHoleOffset(bh, now, off1);
      player.local.x += off1.x - off0.x;
      player.local.y += off1.y - off0.y;
      player.local.z += off1.z - off0.z;
    }
  }

  /** Holes near enough to steer around, as obstacles a few Schwarzschild radii across. */
  obstacles(player: Player, simTime: number): Obstacle[] {
    const out: Obstacle[] = [];
    const gx = player.anchor.x + player.local.x / KM_PER_LY, gy = player.anchor.y + player.local.y / KM_PER_LY, gz = player.anchor.z + player.local.z / KM_PER_LY;
    for (const bh of BLACK_HOLES) {
      // (Cheap test in light years first: only those within a million radii matter.)
      if (Math.hypot(bh.x - gx, bh.y - gy, bh.z - gz) * KM_PER_LY > bh.rs * 1e6 + (bh.orbit?.a ?? 0)) continue;
      out.push({ pos: this.position(bh, player, simTime, new THREE.Vector3()), radius: bh.rs * KEEP_OUT, ground: null, body: null });
    }
    return out;
  }

  /**
   * occluder: the star of the system loaded around the camera (km relative to the anchor, radius km), which may
   * stand in front of a hole: drawn as it is, not lensed. width / height: the frame in device pixels.
   */
  update(player: Player, simTime: number, simDt: number, fov: number, aspect: number, ppr: number, pixelRatio: number,
    occluder: { pos: THREE.Vector3; radius: number } | null, width: number, height: number): void {
    const gx = player.anchor.x + player.local.x / KM_PER_LY, gy = player.anchor.y + player.local.y / KM_PER_LY, gz = player.anchor.z + player.local.z / KM_PER_LY;
    // The holes of the generated galaxies around.
    const version = syncGeneratedHoles(gx, gy, gz);
    if (version !== this.listVersion) { this.listVersion = version; this.relist(); }
    const tanY = Math.tan(THREE.MathUtils.degToRad(fov) / 2);
    const halfDiag = Math.atan(tanY * Math.hypot(1, aspect));
    const view = v2.set(0, 0, -1).applyQuaternion(player.quat);
    const chosen: { bh: BlackHoleData; ro: number; reach: number; fade: number }[] = [];
    this.near = null;
    for (const bh of BLACK_HOLES) {
      const dLy = Math.hypot(bh.x - gx, bh.y - gy, bh.z - gz);
      // Rough distance in radii; exact (km, relative to the anchor) only for the few close enough to matter.
      let ro = (dLy * KM_PER_LY) / bh.rs;
      this.roOf.set(bh.id, ro);
      const span = Math.max(bh.disc ? bh.disc.rOut : 0, bh.jet ? bh.jet.length : 0);
      if (ro > 8 * ppr * ppr && ro > span * ppr) continue;
      const rel = this.position(bh, player, simTime, this.pos(bh)).sub(player.local);
      const dist = rel.length();
      ro = dist / bh.rs;
      this.roOf.set(bh.id, ro);
      if (!this.near || ro < this.near.ro) this.near = { bh, dist, ro };
      const einstein = Math.sqrt(2 / ro) * ppr;
      const discPx = bh.disc ? (bh.disc.rOut / ro) * ppr : 0;
      const jetPx = bh.jet ? (bh.jet.length / ro) * ppr : 0;
      if (einstein < 0.5 && discPx < 1.5 && jetPx < 3) continue;
      // Out to where the light bends by less than a third of a pixel (2 r_s / b of deflection), and past the disc.
      const reach = Math.min(Math.max((6 * ppr) / ro, bh.disc ? (bh.disc.rOut * 1.05) / ro : 0, 12 / ro), Math.PI);
      const off = view.angleTo(rel);
      let onScreen = off < halfDiag + reach;
      if (!onScreen && jetPx >= 3) onScreen = this.jetInView(bh, rel, view, halfDiag);
      if (!onScreen) continue;
      const corePx = bh.disc ? (bh.disc.light.rHalf / ro) * ppr : 0;
      chosen.push({ bh, ro, reach, fade: THREE.MathUtils.smoothstep(corePx, 1.5, 4) });
    }
    chosen.sort((a, b) => a.ro - b.ro);
    chosen.length = Math.min(chosen.length, MAX_HOLES);
    chosen.reverse();

    const holes = this.lens.holes;
    holes.length = 0;
    this.inPass.clear();
    let cube = false;
    const qInv = new THREE.Quaternion().copy(player.quat).invert();
    for (const c of chosen) {
      const slot = holes.length;
      const p = this.params[slot];
      const bh = c.bh;
      const rel = this.pos(bh);
      p.cam.copy(rel).negate().divideScalar(bh.rs);
      p.axis.set(bh.axis[0], bh.axis[1], bh.axis[2]);
      p.reachCos = c.reach >= Math.PI ? -2 : Math.cos(c.reach);
      // Spin: the Kerr shadow's edge for this inclination (rebuilt when the view of the hole changes).
      const a = Math.min(bh.spin ?? 0, 0.9999);
      const cosI = p.cam.dot(p.axis) / p.cam.length();
      const incl = Math.acos(Math.min(Math.abs(cosI), 1));
      const key = `${bh.id}:${incl.toFixed(3)}`;
      if (this.shadowKey[slot] !== key) { shadowTable(a, incl, p.shadow); this.shadowKey[slot] = key; }
      p.spin.set(a, iscoRadius(a), Math.sin(incl));
      let edge = 0;
      for (let k = 0; k < SHADOW_BINS; k++) edge = Math.max(edge, p.shadow[k * 2]);
      const shadowAngle = Math.min(Math.asin(Math.min((edge * Math.sqrt(1 - 1 / c.ro)) / c.ro, 1)) * 1.1 + 3 / ppr, Math.PI);
      p.shadowCos = Math.cos(shadowAngle);
      this.shadowRect(p.shadowRect, rel, qInv, shadowAngle, tanY, aspect, width, height);

      // Light: the point it is from afar, the disc it becomes (see the note at the top).
      const dLy = rel.length() / KM_PER_LY;
      const cosInc = Math.max(Math.abs(cosI), 0.05);
      const lumIso = bh.lum * 2 * cosInc;
      if (bh.disc) {
        const rHalf = bh.disc.light.rHalf;
        const handLy = (((rHalf * ppr) / HANDOVER_PX) * bh.rs) / KM_PER_LY;
        const [ih, sh] = pointLight(magnitude(lumIso, handLy));
        // The point's light (its profile sums to ~0.157 size^2) spread over the disc's face, seen at this tilt, at
        // the handover size. (A surface's brightness should not depend on the angle it is seen at, but the point's
        // does not fall with cos i once the starfield's law saturates; within a factor of 2 the handover wins.)
        const total = ih * 0.157 * (sh * pixelRatio) ** 2;
        const peak = (total * (rHalf / HANDOVER_PX) ** 2) / (bh.disc.light.area * Math.max(cosInc, 0.5));
        p.disc.set(2 * bh.disc.rIn, bh.disc.rOut, bh.disc.tMax, peak * c.fade);
        p.opacity = bh.disc.opacity * c.fade;
        p.corona.set(bh.disc.corona[0] * peak * c.fade, bh.disc.corona[1], bh.disc.corona[2]);
        // The gas at the inner edge turns at Omega = c^3 / (GM) / (r^1.5 + a), shown no faster than MAX_TURN.
        const omega = Math.min(C_KM_S / (bh.rs / 2) / (Math.pow(2 * bh.disc.rIn, 1.5) + a), MAX_TURN);
        // (Wrapped: a float cannot hold the phase after years of turning.)
        p.phase = (omega * simTime) % (2 * Math.PI * 1000);
        p.step = omega * Math.abs(simDt);
      } else {
        p.disc.set(6, 6, 0, 0);
        p.opacity = 0;
        p.corona.set(0, 1, 1);
        p.phase = p.step = 0;
      }
      if (bh.jet) {
        p.jet.set(bh.jet.length, bh.jet.gamma, bh.jet.power, 1);
        for (let k = 0; k < 8; k++) p.knots[k].set(...(bh.jet.knots[k] ?? [0, 0]));
      } else p.jet.set(1, 1, 0, 0);
      // Its point of light moves from the background (where the lens would bend it into a ring) into the pass.
      const li = this.lit.indexOf(bh);
      p.point.set(0, 0, 0, 0);
      if (li >= 0 && c.fade < 1) {
        const [intensity, size] = pointLight(magnitude(lumIso, dLy));
        const colour = this.points.geometry.getAttribute('aColor');
        const k = intensity * (1 - c.fade);
        p.point.set(colour.getX(li) * k, colour.getY(li) * k, colour.getZ(li) * k, size * pixelRatio);
      }
      // The system's star, if it stands between the camera and the hole, is drawn in front of the lens.
      if (occluder) {
        v1.copy(occluder.pos).sub(player.local).divideScalar(bh.rs);
        p.occluder.set(v1.x, v1.y, v1.z, occluder.radius / bh.rs);
      } else p.occluder.set(0, 0, 0, 0);
      this.inPass.add(bh.id);
      holes.push(p);
      // Strongly bent rays leave the screen: the background then comes from a cube map around the camera.
      if (c.ro < 4 * ppr) cube = true;
    }
    this.lens.enabled = holes.length > 0;
    // An accretion disc in view is far brighter than a star's surface: the eye may stop down for it.
    this.minExposure = chosen.some((c) => c.bh.disc && c.fade > 0) ? 0.03 : 0.6;
    if (!this.lens.enabled) this.lens.mask.enabled = false;
    this.lens.useCube = cube;
    this.lens.view.copy(player.quat);
    this.lens.tan.set(tanY * aspect, tanY);
    this.lens.pixelAngle = 1 / ppr;
    this.lens.pixelRatio = pixelRatio;
    this.lens.eye.set(gx, gy, gz);

    // The distant points: camera-relative, in light years; faded out as the traced disc takes over.
    const pa = this.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    const la = this.points.geometry.getAttribute('aLum') as THREE.BufferAttribute;
    const arr = pa.array as Float32Array;
    const lum = la.array as Float32Array;
    this.lit.forEach((b, i) => {
      const ro = this.ro(b);
      const discPx = b.disc ? (b.disc.light.rHalf / ro) * ppr : 0;
      const dx = b.x - gx, dy = b.y - gy, dz = b.z - gz;
      const cosI = Math.max(Math.abs(dx * b.axis[0] + dy * b.axis[1] + dz * b.axis[2]) / Math.max(Math.hypot(dx, dy, dz), 1e-30), 0.05);
      lum[i] = this.inPass.has(b.id) ? 0 : b.lum * 2 * cosI * (1 - THREE.MathUtils.smoothstep(discPx, 1.5, 4));
      arr[i * 3] = dx;
      arr[i * 3 + 1] = dy;
      arr[i * 3 + 2] = dz;
    });
    pa.needsUpdate = true;
    la.needsUpdate = true;
    this.pointMat.uniforms.uPixelRatio.value = pixelRatio;
  }

  /** The shadow's rectangle on screen (device pixels, GL origin bottom left) for the mask pass; width 0 if off screen. */
  private shadowRect(out: THREE.Vector4, rel: THREE.Vector3, qInv: THREE.Quaternion, angle: number, tanY: number, aspect: number, w: number, h: number): void {
    const v = v1.copy(rel).applyQuaternion(qInv);
    if (angle > 0.6) { out.set(0, 0, w, h); return; }
    if (v.z >= 0) { out.set(0, 0, 0, 0); return; }
    const nx = v.x / -v.z / (tanY * aspect), ny = v.y / -v.z / tanY;
    // (Generous: perspective stretches it towards the edges.)
    const r = (Math.tan(angle) / tanY) * (h / 2) * (1.3 + Math.hypot(nx, ny)) + 3;
    const cx = (nx * 0.5 + 0.5) * w, cy = (ny * 0.5 + 0.5) * h;
    const x0 = Math.max(Math.floor(cx - r), 0), y0 = Math.max(Math.floor(cy - r), 0);
    const x1 = Math.min(Math.ceil(cx + r), w), y1 = Math.min(Math.ceil(cy + r), h);
    if (x1 <= x0 || y1 <= y0) out.set(0, 0, 0, 0);
    else out.set(x0, y0, x1 - x0, y1 - y0);
  }

  private jetInView(bh: BlackHoleData, rel: THREE.Vector3, view: THREE.Vector3, halfDiag: number): boolean {
    const L = bh.jet!.length * bh.rs;
    const p = new THREE.Vector3();
    for (const side of [1, -1]) {
      for (let i = 1; i <= 24; i++) {
        p.set(bh.axis[0], bh.axis[1], bh.axis[2]).multiplyScalar(side * L * Math.pow(i / 24, 2)).add(rel);
        if (view.angleTo(p) < halfDiag) return true;
      }
    }
    return false;
  }

  /** Labels for holes close by (the selected one is labelled anyway). */
  labels(): LabelSource[] {
    const out: LabelSource[] = [];
    for (const bh of BLACK_HOLES) {
      const ro = this.ro(bh);
      if (ro > 2e6) continue;
      out.push({ target: blackHoleTarget(bh), rel: this.pos(bh).clone(), radius: bh.rs, fade: 1 - THREE.MathUtils.smoothstep(ro, 2e5, 2e6) });
    }
    return out;
  }

  /** The hole under a view direction: a close one, or a far one whose point of light is clicked. */
  pick(dir: THREE.Vector3, gal: { x: number; y: number; z: number }): Target | null {
    let best: BlackHoleData | null = null;
    let bestAng = Infinity;
    for (const bh of BLACK_HOLES) {
      const ro = this.ro(bh);
      const close = ro < 2e6;
      if (!close && !(bh.lum > 0 && !bh.companion)) continue;
      const d = close ? this.pos(bh) : v1.set(bh.x - gal.x, bh.y - gal.y, bh.z - gal.z);
      const ang = d.angleTo(dir);
      const reach = Math.max(0.01, close && bh.disc ? Math.min(bh.disc.rOut / ro, 0.3) : 0, close ? 12 / ro : 0);
      if (ang < reach && ang < bestAng && (close || this.pointVisible(bh, d.length()))) { bestAng = ang; best = bh; }
    }
    return best ? blackHoleTarget(best) : null;
  }

  private pointVisible(bh: BlackHoleData, dLy: number): boolean {
    return magnitude(bh.lum, dLy) < 7;
  }
}
