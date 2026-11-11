import * as THREE from 'three';
import { C_KM_S, KM_PER_LY } from '../core/units';
import type { LabelSource } from '../game/labels';
import type { Obstacle, Player } from '../game/player';
import { blackHoleTarget, targetPosition, type Target } from '../game/target';
import { BLACK_HOLES, blackHoleOffset, type BlackHoleData } from '../universe/blackHoles';
import { temperatureToRgb } from '../universe/stars';
import type { LensParams, LensPass } from './lensPass';

// Per frame: which black holes are worth the lens pass (on screen and lensing by a pixel or more, or with a
// disc or jet bigger than a few pixels), what it needs to draw them, where the camera may not go, and the
// distant ones as points of light (an active nucleus far away is a star-like point, as quasars are).

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
  private readonly lit = BLACK_HOLES.filter((b) => b.lumVis > 0 && !b.companion);
  private readonly points: THREE.Points;
  private readonly pointMat: THREE.ShaderMaterial;
  private readonly params: LensParams[] = Array.from({ length: MAX_HOLES }, () => ({
    cam: new THREE.Vector3(), axis: new THREE.Vector3(), reachCos: 1, disc: new THREE.Vector4(), opacity: 1, time: 0, step: 0,
    jet: new THREE.Vector4(), knots: Array.from({ length: 8 }, () => new THREE.Vector2()), point: new THREE.Vector4(),
  }));
  /** Per hole this frame: camera distance (r_s) and how much of its point gives way to the traced disc. */
  private readonly ro = new Float64Array(BLACK_HOLES.length);
  private readonly pos = BLACK_HOLES.map(() => new THREE.Vector3());
  private readonly inPass = new Set<number>();
  /** The nearest hole, for the HUD's place readout. */
  near: NearHole | null = null;

  constructor(bgScene: THREE.Scene, private readonly lens: LensPass, pixelRatio: number) {
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
    g.setAttribute('aLum', new THREE.BufferAttribute(new Float32Array(this.lit.map((b) => b.lumVis)), 1));
    this.pointMat = new THREE.ShaderMaterial({
      vertexShader: POINT_VERT, fragmentShader: POINT_FRAG, uniforms: { uPixelRatio: { value: pixelRatio } },
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
    });
    this.points = new THREE.Points(g, this.pointMat);
    this.points.frustumCulled = false;
    bgScene.add(this.points);
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

  update(player: Player, simTime: number, simDt: number, fov: number, aspect: number, ppr: number, pixelRatio: number): void {
    const gx = player.anchor.x + player.local.x / KM_PER_LY, gy = player.anchor.y + player.local.y / KM_PER_LY, gz = player.anchor.z + player.local.z / KM_PER_LY;
    const tanY = Math.tan(THREE.MathUtils.degToRad(fov) / 2);
    const halfDiag = Math.atan(tanY * Math.hypot(1, aspect));
    const view = v2.set(0, 0, -1).applyQuaternion(player.quat);
    const chosen: { bh: BlackHoleData; ro: number; reach: number; fade: number }[] = [];
    this.near = null;
    for (const bh of BLACK_HOLES) {
      const dLy = Math.hypot(bh.x - gx, bh.y - gy, bh.z - gz);
      // Rough distance in radii; exact (km, relative to the anchor) only for the few close enough to matter.
      let ro = (dLy * KM_PER_LY) / bh.rs;
      this.ro[bh.id] = ro;
      const span = Math.max(bh.disc ? bh.disc.rOut : 0, bh.jet ? bh.jet.length : 0);
      if (ro > 8 * ppr * ppr && ro > span * ppr) continue;
      const rel = this.position(bh, player, simTime, this.pos[bh.id]).sub(player.local);
      const dist = rel.length();
      ro = dist / bh.rs;
      this.ro[bh.id] = ro;
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
      chosen.push({ bh, ro, reach, fade: THREE.MathUtils.smoothstep(discPx, 1.5, 4) });
    }
    chosen.sort((a, b) => a.ro - b.ro);
    chosen.length = Math.min(chosen.length, MAX_HOLES);
    chosen.reverse();

    const holes = this.lens.holes;
    holes.length = 0;
    this.inPass.clear();
    let cube = false;
    for (const c of chosen) {
      const p = this.params[holes.length];
      const bh = c.bh;
      p.cam.copy(this.pos[bh.id]).negate().divideScalar(bh.rs);
      p.axis.set(bh.axis[0], bh.axis[1], bh.axis[2]);
      p.reachCos = c.reach >= Math.PI ? -2 : Math.cos(c.reach);
      p.opacity = bh.disc ? bh.disc.opacity * c.fade : 0;
      if (bh.disc) p.disc.set(bh.disc.rIn, bh.disc.rOut, bh.disc.tMax, bh.disc.peak * c.fade);
      else p.disc.set(3, 3, 0, 0);
      // (Wrapped: only the pattern's phase matters, and a float cannot hold years in units of milliseconds.)
      p.time = ((simTime * C_KM_S) / bh.rs) % 1e5;
      p.step = Math.abs(simDt * C_KM_S) / bh.rs;
      if (bh.jet) {
        p.jet.set(bh.jet.length, bh.jet.gamma, bh.jet.power, 1);
        for (let k = 0; k < 8; k++) p.knots[k].set(...(bh.jet.knots[k] ?? [0, 0]));
      } else p.jet.set(1, 1, 0, 0);
      // Its point of light moves from the background (where the lens would bend it into a ring) into the pass.
      const li = this.lit.indexOf(bh);
      p.point.set(0, 0, 0, 0);
      if (li >= 0 && c.fade < 1) {
        const dLy = this.pos[bh.id].length() / KM_PER_LY;
        const mag = -2.5 * Math.log10(bh.lumVis / (dLy * dLy)) - 2.74;
        const intensity = Math.min(Math.pow(2.512, 0.7 * (3.6 - mag)), 9) * (1 - THREE.MathUtils.smoothstep(mag, 6.0, 8.8)) * (1 - c.fade);
        const colour = this.points.geometry.getAttribute('aColor');
        p.point.set(colour.getX(li) * intensity, colour.getY(li) * intensity, colour.getZ(li) * intensity, THREE.MathUtils.clamp(2.7 - mag * 0.32, 1, 3.8) * pixelRatio);
      }
      this.inPass.add(bh.id);
      holes.push(p);
      // Strongly bent rays leave the screen: the background then comes from a cube map around the camera.
      if (c.ro < 4 * ppr) cube = true;
    }
    this.lens.enabled = holes.length > 0;
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
      const ro = this.ro[b.id];
      const discPx = b.disc ? (b.disc.rOut / ro) * ppr : 0;
      lum[i] = this.inPass.has(b.id) ? 0 : b.lumVis * (1 - THREE.MathUtils.smoothstep(discPx, 1.5, 4));
      arr[i * 3] = b.x - gx;
      arr[i * 3 + 1] = b.y - gy;
      arr[i * 3 + 2] = b.z - gz;
    });
    pa.needsUpdate = true;
    la.needsUpdate = true;
    this.pointMat.uniforms.uPixelRatio.value = pixelRatio;
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
      const ro = this.ro[bh.id];
      if (ro > 2e6) continue;
      out.push({ target: blackHoleTarget(bh), rel: this.pos[bh.id].clone(), radius: bh.rs, fade: 1 - THREE.MathUtils.smoothstep(ro, 2e5, 2e6) });
    }
    return out;
  }

  /** The hole under a view direction: a close one, or a far one whose point of light is clicked. */
  pick(dir: THREE.Vector3, gal: { x: number; y: number; z: number }): Target | null {
    let best: BlackHoleData | null = null;
    let bestAng = Infinity;
    for (const bh of BLACK_HOLES) {
      const ro = this.ro[bh.id];
      const close = ro < 2e6;
      if (!close && !(bh.lumVis > 0 && !bh.companion)) continue;
      const d = close ? this.pos[bh.id] : v1.set(bh.x - gal.x, bh.y - gal.y, bh.z - gal.z);
      const ang = d.angleTo(dir);
      const reach = Math.max(0.01, close && bh.disc ? Math.min(bh.disc.rOut / ro, 0.3) : 0, close ? 12 / ro : 0);
      if (ang < reach && ang < bestAng && (close || this.pointVisible(bh, d.length()))) { bestAng = ang; best = bh; }
    }
    return best ? blackHoleTarget(best) : null;
  }

  private pointVisible(bh: BlackHoleData, dLy: number): boolean {
    const mag = -2.5 * Math.log10(bh.lumVis / (dLy * dLy)) - 2.74;
    return mag < 7;
  }
}
