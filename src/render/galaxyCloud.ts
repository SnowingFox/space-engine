import * as THREE from 'three';
import { Rng } from '../core/rng';
import { GALAXIES, armStrengthOf, toGalaxy, type GalaxyData } from '../universe/universe';
import { GALAXY_GLSL, galaxyKnotUniforms, galaxyNoise } from './galaxyShader';
import { GalaxyVolume, NEAR_GALAXIES, galaxyParams, type NearGalaxy } from './galaxyVolume';
import { HomeSky } from './homeSky';
import { SOFT_LAYER, softLayer } from './pipeline';

// A galaxy is marched where it is drawn, every frame, whenever the camera is outside its disc.
// Inside a disc the view is the surveyed sky (HomeSky); where that does not apply, in the core,
// the galaxy is marched into a sky map instead, a few strips per frame.
const NEAR_START = 6, NEAR_END = 8;
// A galaxy this many pixels in radius (fading in over the range) is drawn on the soft layer, at reduced
// resolution: it fills much of the view, and its clouds are soft enough not to show the difference.
const BIG_PX = [650, 1000];
/**
 * The glow of a galaxy in the starfield's own units, from its surface brightness. A star of magnitude m is
 * drawn with 2.512^(0.7 (3.6 - m)) over a point of ~1.4 px (starfield.ts), all of 0.034 at m = 7, where the
 * stars fade out and their unresolved light, the glow, takes over. A patch of sky of mu mag/arcsec^2 then
 * gives each pixel (of 21,550 arcsec^2 at the reference view: 1144 px tall at ratio 1.42, 60 deg) the light
 * of a star of mu - 10.83: 729 x 10^(-0.4 (mu - 7)). Calibrated on the Milky Way from Sol: the Cygnus star
 * cloud at 21.3 mag/arcsec^2 (the brightest band, Sagittarius, comes out at ~20.2, the anticentre ~22.1),
 * which is ~0.0014 per pixel at exposure 1: faint, as the real one is; the dark-adapted exposure in open space
 * (pipeline.ts) brings it out. The same factor from inside and outside: a galaxy's surface brightness does
 * not depend on where it is seen from (only how bright the view as a whole is, which the eye adapts to).
 */
// (Then raised 2.6 times, as if anchored on stars of magnitude ~8 rather than 7, so that the dark-adapted
// band reads between the old, too bright one and the strictly anchored one, which was too dark to enjoy.)
const INSIDE_GAIN = 0.0125 * 2.6, OUTSIDE_GAIN = INSIDE_GAIN;
/** Brightness of the surveyed sky inside a disc, matched to the model in the Cygnus star cloud. */
const HOME_GAIN = 0.0275 * 2.6;

const FIELD_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iX;
attribute vec3 iY;
attribute vec3 iZ;
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 iC;
attribute vec4 iD;
attribute vec4 iGlow;   // rgb: light of the whole galaxy as one soft spot; a: its id
uniform vec3 uCam;
uniform float uPixelsPerRadian;
uniform float uFullPpr;   // pixels per radian of the full-resolution view, whichever pass this is
uniform vec2 uBig;
uniform float uBrightness;
uniform vec2 uNearId;
uniform vec2 uNearWeight;
uniform float uHideClouds;
varying vec3 vEye;
varying vec3 vRay;
varying vec4 vA;
varying vec4 vB;
varying vec4 vC;
varying vec4 vD;
varying vec4 vSpot;   // rgb: colour, a: falloff across the quad
varying vec3 vMode;   // weight, 0 marched .. 1 spot, march steps
varying vec2 vQuad;
void main() {
  vec3 c = iPos - uCam;
  float d = length(c);
  float bound = iA.x * 1.2;
  float px = iA.x / d * uPixelsPerRadian;
  float weight = smoothstep(1.2, 1.8, d / bound);
  if (iGlow.a == uNearId.x) weight = uNearWeight.x;
  if (iGlow.a == uNearId.y) weight = uNearWeight.y;
  float big = smoothstep(uBig.x, uBig.y, iA.x / d * uFullPpr);
#ifdef SOFT_PASS
  weight *= big;
#else
  weight *= 1.0 - big;
#endif
  // The surveyed sky has the Magellanic Clouds in it already.
  if (iGlow.a == 1.0 || iGlow.a == 2.0) weight *= 1.0 - uHideClouds;
  // Too small to show any structure: a soft spot carrying the same light, never smaller than a pixel.
  float spot = smoothstep(12.0, 5.0, px);
  float sigma = max(0.3 * px, 1.1);
  float cover = bound * 1.02 * d / sqrt(max(d * d - bound * bound, 0.05 * d * d));
  float halfPx = max(cover / d * uPixelsPerRadian, 3.2 * sigma * spot);
  float size = halfPx * d / uPixelsPerRadian;
  vec3 f = c / d;
  vec3 right = normalize(cross(f, abs(f.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 up = cross(right, f);
  vec3 world = c + (right * position.x + up * position.y) * size;
  mat3 frame = transpose(mat3(iX, iY, iZ));
  vEye = frame * -c;
  vA = iA; vB = iB; vC = iC;
  vD = vec4(iD.xy, iD.z * uBrightness, iD.w);
  float dim = 0.3 * px / sigma;
  vSpot = vec4(iGlow.rgb * (uBrightness * dim * dim), halfPx * halfPx / (2.0 * sigma * sigma));
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
  // With the camera inside the bounding sphere, or close to it, a billboard cannot cover the galaxy: the whole view does.
  if (d < bound * 1.3) {
    clip = vec4(position.xy, 0.0, 1.0);
    vec4 v = inverse(projectionMatrix) * clip;
    world = transpose(mat3(modelViewMatrix)) * (v.xyz / v.w);
  }
  vRay = frame * world;
  vMode = vec3(weight, spot, clamp(iA.x / d * uFullPpr * 0.1, 8.0, 24.0));
  vQuad = position.xy;
  gl_Position = weight > 0.0 ? clip : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const FIELD_FRAG = /* glsl */ `
${GALAXY_GLSL}
uniform float uPixelsPerRadian;
varying vec3 vEye;
varying vec3 vRay;
varying vec4 vA;
varying vec4 vB;
varying vec4 vC;
varying vec4 vD;
varying vec4 vSpot;
varying vec3 vMode;
varying vec2 vQuad;
void main() {
  vec4 col = vec4(0.0);
  if (vMode.y < 1.0) {
    col = galaxyMarch(vEye, normalize(vRay), vA, vB, vC, vD, int(vMode.z), marchJitter(gl_FragCoord.xy), 1.0 / uPixelsPerRadian) * (1.0 - vMode.y);
  }
  if (vMode.y > 0.0) col.rgb += vSpot.rgb * (exp(-dot(vQuad, vQuad) * vSpot.a) * vMode.y);
  gl_FragColor = col * vMode.x;
}
`;

const SPARKLE_VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
uniform float uPixelsPerRadian;
uniform float uGain;
varying vec3 vColor;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uPixelsPerRadian / 900.0;
  vColor = aColor * uGain;
}
`;

const SPARKLE_FRAG = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float a = exp(-dot(p, p) * 3.5) - 0.03;
  if (a <= 0.0) discard;
  gl_FragColor = vec4(vColor * a, 1.0);
}
`;

const NO_GALAXIES: NearGalaxy[] = [];

/** The light of a whole galaxy gathered into one spot of 0.3 radii: what it looks like from too far to resolve. */
function glowOf(g: GalaxyData): number[] {
  const area = 0.09 * g.radius * g.radius;
  // The same weighting of disc and bulge light as the march.
  const disc = (2.4 * g.discLum * 2 * g.height * 0.6 * g.discScale * g.discScale) / area;
  const bulge = (0.6 * g.bulgeLum * 4 * g.bulgeScale ** 3) / (g.bulgeFlat * area);
  const young = 0.5 * g.blue;
  return [
    disc * (1 - 0.4 * young) + bulge,
    disc * (0.84 - 0.09 * young) + bulge * 0.82,
    disc * (0.66 + 0.34 * young) + bulge * 0.58,
  ];
}

/** 0..1, how much of a dust lane a point of a disc is in (the march's gLane, with its lead on the arms). */
function laneOf(g: GalaxyData, x: number, z: number): number {
  const r = Math.max(Math.hypot(x, z), 1);
  const th = Math.atan2(z, x);
  const warped = th + 0.2 * Math.sin(r / (g.radius * 0.1) + g.seed) + 0.08 * Math.sin(3 * th + r / (g.radius * 0.048));
  const phase = g.arms * (warped + 0.16 - g.pitchK * Math.log(r / (g.radius * 0.077)));
  const major = Math.pow(0.5 + 0.5 * Math.cos(phase), 8);
  const minor = Math.pow(0.5 + 0.5 * Math.cos(2 * phase + 1.3), 10) * 0.5;
  const core = THREE.MathUtils.clamp((r - g.radius * 0.048) / (g.radius * 0.096), 0, 1);
  return THREE.MathUtils.lerp(0.35, THREE.MathUtils.lerp(0.3, Math.min(1, major + minor), g.armContrast), core);
}

function gamma(rng: Rng, k: number, scale: number): number {
  let s = 0;
  for (let i = 0; i < k; i++) s -= Math.log(Math.max(rng.next(), 1e-9));
  return s * scale;
}

/** Every galaxy of the universe: a marched sky for the ones around the camera, billboards for the rest. */
export class GalaxyCloud {
  readonly group = new THREE.Group();
  private readonly volume = new GalaxyVolume();
  private readonly home = new HomeSky();
  /** Around the Sun, show the Milky Way as surveyed from Earth instead of the model (off: every galaxy is the model). */
  survey = false;
  private readonly field: THREE.ShaderMaterial;
  private readonly fieldSoft: THREE.ShaderMaterial;
  private readonly sparkle: THREE.ShaderMaterial;
  private sparklePoints: THREE.Points | null = null;
  private sparkleOf = -1;
  /** The galaxy whose sparkle is being built in idle time (building it takes a frame's worth of work). */
  private sparkleBuilding = -1;
  /** Frames left to draw the sparkle even unseen, so its shader is compiled before it is first needed. */
  private sparkleWarm = 2;
  private readonly near: NearGalaxy[] = [];
  private readonly eyes = GALAXIES.map(() => ({ x: 0, y: 0, z: 0 }));
  /** The camera's speed, ly/s, smoothed; and where and when it was last. */
  private speed = 0;
  private lastCam = { x: 0, y: 0, z: 0, t: 0 };
  /** How much the host is the on-screen march's because the camera is too fast for the sky map, smoothed. */
  private fast = 0;
  state = { direct: 0, mapped: 0, gain: 0, speed: 0 };

  constructor() {
    const n = GALAXIES.length;
    const quad = new THREE.PlaneGeometry(2, 2);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', quad.getAttribute('position'));
    geometry.setIndex(quad.getIndex());
    geometry.instanceCount = n;
    const attribute = (name: string, width: number, of: (g: GalaxyData) => number[]): void => {
      const data = new Float32Array(n * width);
      GALAXIES.forEach((g, i) => data.set(of(g), i * width));
      geometry.setAttribute(name, new THREE.InstancedBufferAttribute(data, width));
    };
    attribute('iPos', 3, (g) => [g.x, g.y, g.z]);
    attribute('iX', 3, (g) => g.axes.slice(0, 3));
    attribute('iY', 3, (g) => g.axes.slice(3, 6));
    attribute('iZ', 3, (g) => g.axes.slice(6, 9));
    ['iA', 'iB', 'iC', 'iD'].forEach((name, k) => attribute(name, 4, (g) => galaxyParams(g, 1)[k]));
    attribute('iGlow', 4, (g) => [...glowOf(g), g.id]);

    const make = (uniforms: Record<string, THREE.IUniform>, defines: Record<string, number>): THREE.ShaderMaterial => new THREE.ShaderMaterial({
      vertexShader: FIELD_VERT, fragmentShader: FIELD_FRAG, uniforms, defines,
      transparent: true, premultipliedAlpha: true, depthTest: false, depthWrite: false,
    });
    this.field = make({
      uCam: { value: new THREE.Vector3() }, uPixelsPerRadian: { value: 1000 }, uFullPpr: { value: 1000 }, uBig: { value: new THREE.Vector2(...BIG_PX) },
      uBrightness: { value: 1 }, uNearId: { value: new THREE.Vector2(-1, -1) }, uNearWeight: { value: new THREE.Vector2() },
      uHideClouds: { value: 0 }, uNoise: { value: galaxyNoise }, ...galaxyKnotUniforms,
    }, {});
    // The same galaxies on the soft layer; only the resolution differs.
    this.fieldSoft = make({ ...this.field.uniforms, uPixelsPerRadian: { value: 1000 } }, { SOFT_PASS: 1 });
    const billboards = new THREE.Mesh(geometry, this.field);
    billboards.frustumCulled = false;
    billboards.renderOrder = -4;
    const large = new THREE.Mesh(geometry, this.fieldSoft);
    large.frustumCulled = false;
    large.layers.set(SOFT_LAYER);
    this.group.add(large);
    this.volume.mesh.renderOrder = -3;
    this.home.mesh.renderOrder = -3;
    this.group.add(billboards, this.volume.mesh, this.home.mesh);

    this.sparkle = new THREE.ShaderMaterial({
      vertexShader: SPARKLE_VERT,
      fragmentShader: SPARKLE_FRAG,
      uniforms: { uPixelsPerRadian: { value: 1000 }, uGain: { value: 0 } },
      blending: THREE.AdditiveBlending, transparent: true, depthTest: false, depthWrite: false,
    });
  }

  /**
   * The brightest stars and clusters of a disc, which stay sharp when the galaxy fills the view from outside.
   * They are drawn from the same model as the glow: young blue ones along the arms, old yellow ones between
   * them and in the bulge and bar, none past the disc's edge; and those in the dust lanes are dimmed and
   * reddened as the glow is there.
   */
  private makeSparkle(g: GalaxyData): THREE.Points {
    const rng = new Rng(7001 + g.id);
    const count = Math.round(26000 * Math.min(1, g.radius / 40000));
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const size = new Float32Array(count);
    // (Along the bar's axis, as gBulge has it.)
    const turn = g.barAngle ?? 0;
    const bar = g.bar ?? (g.kind === 'barred spiral' ? 1.8 : 1);
    for (let i = 0; i < count; i++) {
      let x = 0, y = 0, z = 0, young = 0;
      if (rng.next() < 0.14) {
        // The bulge and bar: old stars, an exponential ellipsoid along the bar.
        const r = gamma(rng, 3, g.bulgeScale);
        const u = rng.range(-1, 1), ph = rng.range(0, Math.PI * 2), sq = Math.sqrt(1 - u * u);
        const bx = r * sq * Math.cos(ph) * bar, bz = r * sq * Math.sin(ph);
        x = bx * Math.cos(turn) - bz * Math.sin(turn);
        z = bx * Math.sin(turn) + bz * Math.cos(turn);
        y = (r * u) / g.bulgeFlat;
      } else {
        let rad = 0, th = 0, arm = 0;
        for (let tries = 0; tries < 20; tries++) {
          rad = gamma(rng, 2, g.discScale);
          if (rad > g.radius) continue;
          th = rng.range(0, Math.PI * 2);
          // The same wobble the march gives the arms.
          const warped = th + 0.2 * Math.sin(rad / (g.radius * 0.1) + g.seed) + 0.08 * Math.sin(3 * th + rad / (g.radius * 0.048));
          arm = armStrengthOf(g, rad * Math.cos(warped), rad * Math.sin(warped));
          if (rng.next() < 0.05 + 0.95 * arm) break;
        }
        const blur = g.radius * 0.006;
        x = rad * Math.cos(th) + rng.gauss() * blur;
        z = rad * Math.sin(th) + rng.gauss() * blur;
        young = arm * THREE.MathUtils.smoothstep(rad / g.radius, 0.05, 0.3) * g.blue;
        y = rng.gauss() * g.height * (0.25 + 0.5 * (1 - young));
      }
      pos.set([x, y, z], i * 3);
      // Few are bright, most barely show.
      const gain = Math.min(0.13 * Math.pow(Math.max(rng.next(), 1e-4), -0.5), 1.8);
      // Behind the dust of the lanes (on the inner edges of the arms, as the march has them).
      const r = Math.hypot(x, z);
      const lane = r > g.radius * 0.03 ? laneOf(g, x, z) : 0;
      const veil = Math.exp(-2.2 * g.dust * lane * Math.exp(-Math.abs(y) / (g.height * 0.3)));
      const tint = rng.next() < young ? [0.62, 0.78, 1.0] : rng.next() < 0.5 ? [1.0, 0.92, 0.8] : [1.0, 0.72, 0.45];
      col.set([tint[0] * gain * Math.pow(veil, 0.8), tint[1] * gain * veil, tint[2] * gain * Math.pow(veil, 1.35)], i * 3);
      size[i] = rng.range(0.8, 1.3) + 0.5 * Math.min(gain, 1.2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    const points = new THREE.Points(geometry, this.sparkle);
    points.frustumCulled = false;
    points.renderOrder = -2;
    points.matrixAutoUpdate = false;
    return points;
  }

  /**
   * Tuning aid (scripts/gpano.mjs): the model's whole sky from `cam` in galactic coordinates, the projection of the
   * NASA survey maps, in linear light as the sky map would show it inside the disc (before exposure). The frame is
   * that of the first galaxy listed: l = 0 towards its centre, b = 90 deg along its pole.
   */
  panorama(cam: { x: number; y: number; z: number }, width = 1024, passes = 12, ids = [0, 1, 2]): Float32Array | null {
    const frame = GALAXIES[ids[0]];
    const list: NearGalaxy[] = ids.map((id) => {
      const eye = { x: 0, y: 0, z: 0 };
      toGalaxy(GALAXIES[id], cam.x, cam.y, cam.z, eye);
      return { galaxy: GALAXIES[id], eye, weight: 1 };
    });
    const a = frame.axes;
    const toC = new THREE.Vector3(frame.x - cam.x, frame.y - cam.y, frame.z - cam.z);
    const pole = new THREE.Vector3(a[3], a[4], a[5]);
    const centre = toC.addScaledVector(pole, -toC.dot(pole));
    const out = this.volume.panorama(list, centre, pole, width, passes);
    if (out) for (let i = 0; i < out.length; i++) if (i % 4 !== 3) out[i] *= INSIDE_GAIN;
    return out;
  }

  /** cam: position in the universe (ly); gain: brightness of all galaxy light, 1 = as calibrated. */
  update(cam: { x: number; y: number; z: number }, pixelsPerRadian: number, gain: number): void {
    // The galaxies near enough for the sky map, nearest (in their own radii) first.
    const near = this.near;
    near.length = 0;
    for (const g of GALAXIES) {
      const d = Math.hypot(g.x - cam.x, g.y - cam.y, g.z - cam.z) / g.radius;
      if (d >= NEAR_END) continue;
      const eye = this.eyes[g.id];
      toGalaxy(g, cam.x, cam.y, cam.z, eye);
      near.push({ galaxy: g, eye, weight: 1 - THREE.MathUtils.smoothstep(d, NEAR_START, NEAR_END) });
    }
    const span = (n: NearGalaxy): number => Math.hypot(n.eye.x, n.eye.y, n.eye.z) / n.galaxy.radius;
    near.sort((a, b) => span(a) - span(b));
    near.length = Math.min(near.length, NEAR_GALAXIES);
    // The eye adapts: inside a disc its light is all around and reads dimmer than the same galaxy seen whole from outside.
    const host = near[0];
    let out = 1;
    if (host) {
      const g = host.galaxy;
      out = THREE.MathUtils.smoothstep(Math.max(Math.abs(host.eye.y) - g.height, Math.hypot(host.eye.x, host.eye.z) - g.radius), 0, g.radius * 0.35);
    }
    gain *= THREE.MathUtils.lerp(INSIDE_GAIN, OUTSIDE_GAIN, out);
    // (Towards a galaxy's core the sky is many times brighter: the light meter turns the exposure down there.)
    const surveyed = this.home.update(host, pixelsPerRadian, this.survey ? HOME_GAIN : 0);
    // Inside a galaxy, in its disc, above it and in its outskirts, it is the sky map's: one march of one model,
    // so leaving the disc changes the perspective and nothing else. Only well outside, where the whole galaxy
    // is in view and a march of its few layers on screen draws the same thing sharper, does that take over.
    // (What the survey shows, the map leaves.)
    // (Likewise high above the disc, where the whole of it is below the camera: the on-screen march moves with
    // the camera every frame and is as sharp as the screen, where the map would trail it in steps.)
    // And whenever the camera flies so fast that the sky map would fall behind it (it takes a fraction of a
    // second to march): then the march on screen follows every frame. (Speeds up and down are smoothed over a
    // second, so the hand-over is a fade, not a switch.)
    const t = performance.now() / 1000, dtc = t - this.lastCam.t;
    if (dtc > 0 && dtc < 0.5) {
      const v = Math.hypot(cam.x - this.lastCam.x, cam.y - this.lastCam.y, cam.z - this.lastCam.z) / dtc;
      this.speed += ((host && v > host.galaxy.radius * 2 ? 0 : v) - this.speed) * Math.min(1, dtc * 3);
    }
    this.lastCam = { x: cam.x, y: cam.y, z: cam.z, t };
    // (Not inside the disc: there the march on screen sees far less of the dust and arms than the map, and the
    // galaxy would fade as the camera speeds up. Inside it, the map keeps up by marching ahead of the camera.)
    const tooFast = host
      ? THREE.MathUtils.smoothstep(this.speed, host.galaxy.radius * 0.0125, host.galaxy.radius * 0.05) * THREE.MathUtils.smoothstep(Math.abs(host.eye.y), 1.5 * host.galaxy.height, 4 * host.galaxy.height)
      : 0;
    this.fast += (tooFast - this.fast) * Math.min(1, Math.max(dtc, 0) * 4);
    const direct = host
      ? Math.max(THREE.MathUtils.smoothstep(span(host), 1.5, 2.1), THREE.MathUtils.smoothstep(Math.abs(host.eye.y) / host.galaxy.radius, 0.25, 0.42), this.fast)
      : 0;
    const mapped = Math.max(0, 1 - direct - (this.survey ? HomeSky.cover(host) : 0));
    /** (For measuring hand-overs: what draws the host, and how bright.) */
    this.state = { direct, mapped, gain, speed: this.speed };
    this.volume.update(mapped > 0.002 ? near : NO_GALAXIES, gain * mapped, pixelsPerRadian, mapped);

    const f = this.field.uniforms;
    f.uCam.value.set(cam.x, cam.y, cam.z);
    f.uPixelsPerRadian.value = pixelsPerRadian;
    f.uFullPpr.value = pixelsPerRadian;
    this.fieldSoft.uniforms.uPixelsPerRadian.value = pixelsPerRadian * softLayer.scale;
    f.uBrightness.value = gain;
    for (let i = 0; i < NEAR_GALAXIES; i++) {
      f.uNearId.value.setComponent(i, near[i] ? near[i].galaxy.id : -1);
      f.uNearWeight.value.setComponent(i, near[i] ? 1 - near[i].weight * (i === 0 ? 1 - direct : mapped) : 0);
    }
    f.uHideClouds.value = host?.galaxy.id === 0 ? surveyed : 0;

    // Sparkle belongs to the nearest disc galaxy and shows once the camera is out of its disc.
    let show = 0;
    if (host && host.galaxy.discLum > 0) {
      const g = host.galaxy;
      const outside = Math.max(Math.abs(host.eye.y), Math.hypot(host.eye.x, host.eye.z) - g.radius);
      // (Seen edge-on they would pile up into sand along the far side of the disc.)
      const steep = Math.abs(host.eye.y) / Math.max(Math.hypot(host.eye.x, host.eye.z), g.radius * 0.3);
      show = THREE.MathUtils.smoothstep(outside, g.radius * 0.03, g.radius * 0.4) * (1 - THREE.MathUtils.smoothstep(span(host), 1.2, 3.2)) * THREE.MathUtils.smoothstep(steep, 0.12, 0.4);
      // Built ahead, while the camera is still inside the disc, in idle time: never in the frame it is needed.
      if (this.sparkleOf !== g.id && this.sparkleBuilding !== g.id) {
        this.sparkleBuilding = g.id;
        const build = (): void => {
          if (this.sparkleBuilding !== g.id) return;
          if (this.sparklePoints) {
            this.group.remove(this.sparklePoints);
            this.sparklePoints.geometry.dispose();
          }
          this.sparklePoints = this.makeSparkle(g);
          this.sparkleOf = g.id;
          this.sparkleBuilding = -1;
          this.group.add(this.sparklePoints);
        };
        if ('requestIdleCallback' in window) requestIdleCallback(build, { timeout: 1500 });
        else setTimeout(build, 50);
      }
      if (this.sparklePoints && this.sparkleOf === g.id) {
        const a = g.axes;
        this.sparklePoints.matrix.set(
          a[0], a[3], a[6], g.x - cam.x,
          a[1], a[4], a[7], g.y - cam.y,
          a[2], a[5], a[8], g.z - cam.z,
          0, 0, 0, 1,
        );
        this.sparklePoints.matrixWorldNeedsUpdate = true;
      }
    }
    const warm = this.sparklePoints !== null && this.sparkleWarm > 0;
    if (warm) this.sparkleWarm--;
    if (this.sparklePoints) this.sparklePoints.visible = warm || (show > 0.01 && this.sparkleOf === host?.galaxy.id);
    this.sparkle.uniforms.uPixelsPerRadian.value = pixelsPerRadian;
    this.sparkle.uniforms.uGain.value = show * 0.6 * gain;
  }
}
