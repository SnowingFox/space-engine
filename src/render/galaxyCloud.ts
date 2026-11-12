import * as THREE from 'three';
import { Rng } from '../core/rng';
import { GALAXIES, armStrengthOf, toGalaxy, type GalaxyData } from '../universe/universe';
import { COSMOS, D_STAR, FAINT } from '../universe/cosmos';
import { GALAXY_GLSL, galaxyKnotUniforms, galaxyNoise } from './galaxyShader';
import { GalaxyHost } from './galaxyHost';
import { GalaxyVolume, NEAR_GALAXIES, galaxyParams, type NearGalaxy } from './galaxyVolume';
import { HomeSky } from './homeSky';
import { SOFT_LAYER, softLayer } from './pipeline';

// Every galaxy is marched where it is drawn, every frame, from where the camera is: the ones around the camera
// (inside, above or near them) on screen by GalaxyHost, with many frames averaged; every other one on a
// billboard. (Inside the disc of a spiral the surveyed sky, HomeSky, may stand in for the model.)
const NEAR_START = 6, NEAR_END = 8;
/**
 * How far the eye dark-adapts in intergalactic space, as a floor on the exposure (pipeline.darkAdapt; the
 * light meter still caps the frame's mean at a dim night sky, so a galaxy that fills the view does not glare).
 * Open space inside or near a galaxy adapts to DARK_ADAPTED (16); between the galaxies, with none within eight of
 * its radii, to this: so far that a typical view shows hundreds of faint galaxies, small smudges and points,
 * as SpaceEngine's does, and nearer ones as small spirals and ellipticals. (A deliberate choice: real dark-adapted
 * eyes would see almost none of them; this is the view of a long exposure.)
 */
const INTERGALACTIC_ADAPT = 128;
/** Billboard slots: the catalogue and every generated galaxy loaded around the camera. */
const CAPACITY = 131072;
/** Billboard slots written per frame at most, so that a burst of generated galaxies never makes a frame late. */
const WRITES_PER_FRAME = 600;
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

/** Light of a star of magnitude 8 as the starfield draws it (0.034 at magnitude 7, x 2.512^-0.7): there the glow's linear scale meets the stars' law. */
const STAR_ANCHOR = '0.0178';

const FIELD_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iX;
attribute vec3 iY;
attribute vec3 iZ;
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 iC;
attribute vec4 iD;
attribute vec4 iE;
attribute vec4 iF;
attribute vec4 iG;
attribute vec4 iGlow;   // rgb: light of the whole galaxy as one soft spot; a: its slot
attribute float iLum;   // luminosity (the Milky Way's) of a generated galaxy, for its fade at the edge of what is generated
uniform vec3 uCam;
uniform float uPixelsPerRadian;
uniform float uFullPpr;   // pixels per radian of the full-resolution view, whichever pass this is
uniform vec2 uBig;
uniform float uBrightness;
uniform vec2 uNearId;
uniform vec2 uNearWeight;
uniform float uHideClouds;
uniform float uFaint;
varying vec3 vEye;
varying vec3 vRay;
varying vec4 vA;
varying vec4 vB;
varying vec4 vC;
varying vec4 vD;
varying vec4 vE;
varying vec4 vF;
varying vec4 vG;
varying vec4 vSpot;   // rgb: colour, a: falloff across the quad
varying vec3 vMode;   // weight, 0 marched .. 1 spot, march steps
varying vec2 vQuad;
void main() {
  // (A free slot.)
  if (iA.x <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
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
  // A generated galaxy comes into being where it is still too faint to show (cosmos.ts faintestAt): and fades in
  // from there, over a factor of 1.6 in brightness, as the camera comes nearer, so that none appears all at once.
  // (uFaint: FAINT, times four for each level the far cells are drawn shallower, beyond 30 Mly.)
  weight *= smoothstep(1.0, 1.6, iLum / ((d > 3e7 ? uFaint : ${FAINT.toFixed(3)}) * pow(d / ${D_STAR.toExponential()}, 2.0)));
  // The surveyed sky has the Magellanic Clouds in it already.
  if (iGlow.a == 1.0 || iGlow.a == 2.0) weight *= 1.0 - uHideClouds;
  // (Most of those generated are still faded out: nothing more to work out for them.)
  if (weight <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
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
  vA = iA; vB = iB; vC = iC; vE = iE; vF = iF; vG = iG;
  vD = vec4(iD.xy, iD.z * uBrightness, iD.w);
  float dim = 0.3 * px / sigma;
  vSpot = vec4(iGlow.rgb * (uBrightness * dim * dim), halfPx * halfPx / (2.0 * sigma * sigma));
  // Shrunk to a point, a galaxy is drawn as a star of its magnitude would be: with the starfield's law, light
  // going as flux^0.7, not as flux, from where the two scales meet (STAR_ANCHOR: the light of a star of magnitude
  // 8, where the glow's linear scale is anchored). Faint galaxies then show as far as stars as faint do.
  // (Only once it is small: as it grows, the light goes over smoothly to the march's.)
  float total = dot(vSpot.rgb, vec3(0.3333)) * 6.2832 * sigma * sigma;
  vSpot.rgb *= mix(1.0, pow(max(total / ${STAR_ANCHOR}, 1e-12), -0.3), smoothstep(5.0, 1.5, px));
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
  // With the camera inside the bounding sphere, or close to it, a billboard cannot cover the galaxy: the whole view does.
  if (d < bound * 1.3) {
    clip = vec4(position.xy, 0.0, 1.0);
    vec4 v = inverse(projectionMatrix) * clip;
    world = transpose(mat3(modelViewMatrix)) * (v.xyz / v.w);
  }
  vRay = frame * world;
  // (A small galaxy covers few pixels: it can afford more steps, and needs them, or its march is a speckle.)
  float fullPx = iA.x / d * uFullPpr;
  vMode = vec3(weight, spot, clamp(max(fullPx * 0.1, 2400.0 / max(fullPx, 1.0)), 8.0, 64.0));
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
varying vec4 vE;
varying vec4 vF;
varying vec4 vG;
varying vec4 vSpot;
varying vec3 vMode;
varying vec2 vQuad;
void main() {
  vec4 col = vec4(0.0);
  if (vMode.y < 1.0) {
    col = galaxyMarch(vEye, normalize(vRay), vA, vB, vC, vD, vE, vF, vG, int(vMode.z), marchJitter(gl_FragCoord.xy), 1.0 / uPixelsPerRadian) * (1.0 - vMode.y);
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
// The galaxy around the camera as marched this frame (GalaxyHost): how much of what is behind it its dust and
// light hide, and how far along the ray they are (log ly). A star behind the dust is dimmed and reddened by it,
// one in front is not: the same dust, on the same screen, as the glow.
uniform sampler2D tHost;
uniform sampler2D tDepth;
uniform float uHost;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uPixelsPerRadian / 900.0;
  vColor = aColor * uGain;
  if (uHost > 0.5 && gl_Position.w > 0.0) {
    vec2 uv = gl_Position.xy / gl_Position.w * 0.5 + 0.5;
    if (all(greaterThan(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0)))) {
      float hide = textureLod(tHost, uv, 0.0).a;
      float depth = exp(textureLod(tDepth, uv, 0.0).r);
      float behind = smoothstep(0.6, 1.4, length(mv.xyz) / max(depth, 1.0));
      // (Hidden as much as the march says, in the colours dust takes: more of the blue.)
      float t = 1.0 - clamp(hide, 0.0, 0.999) * behind;
      vColor *= pow(vec3(t), vec3(0.8, 1.0, 1.3));
    }
  }
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

function gamma(rng: Rng, k: number, scale: number): number {
  let s = 0;
  for (let i = 0; i < k; i++) s -= Math.log(Math.max(rng.next(), 1e-9));
  return s * scale;
}

/** Every galaxy of the universe: a marched sky for the ones around the camera, billboards for the rest. */
export class GalaxyCloud {
  readonly group = new THREE.Group();
  /** (Only for the tuning tool, panorama: built when first asked for.) */
  private volume: GalaxyVolume | null = null;
  private readonly host = new GalaxyHost();
  private readonly home = new HomeSky();
  /** The camera the background is drawn with: the black hole lens draws it with others too. */
  private camera: THREE.PerspectiveCamera | null = null;
  /** Billboard weights of the near galaxies, for the main view and for any other (the lens's cube map). */
  private readonly nearWeight = new THREE.Vector2();
  private readonly allWeight = new THREE.Vector2(1, 1);
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
  private readonly eyes = new Map<number, { x: number; y: number; z: number }>();
  state = { mapped: 0, gain: 0, galaxies: 0 };
  /**
   * How far the eye dark-adapts here (pipeline.darkAdapt): in intergalactic space, with no galaxy near, further
   * than in open space anywhere else (INTERGALACTIC_ADAPT); 1 elsewhere.
   */
  adapt = 1;
  /** (Tuning.) */
  intergalactic = INTERGALACTIC_ADAPT;
  private adaptSmooth = 1;
  private lastAdaptT = 0;
  /**
   * The billboards: one instance per galaxy, in slots. The catalogue's are fixed (slot = id); generated ones
   * (cosmos.ts) come and go as the camera moves, into free slots, and only the slots changed are uploaded.
   */
  private readonly geometry = new THREE.InstancedBufferGeometry();
  private readonly attrs: Record<string, THREE.InstancedBufferAttribute> = {};
  private readonly slotOf = new Map<number, number>();
  private readonly free: number[] = [];
  private top = 0;
  private dirty = [Infinity, -Infinity];

  /** Writes a galaxy (or, null, an empty slot) into a slot of the billboards. */
  private write(slot: number, g: GalaxyData | null): void {
    const a = this.attrs;
    if (!g) {
      a.iA.array[slot * 4] = 0;
      a.iGlow.array[slot * 4 + 3] = -10;
    } else {
      a.iPos.array.set([g.x, g.y, g.z], slot * 3);
      a.iX.array.set(g.axes.slice(0, 3), slot * 3);
      a.iY.array.set(g.axes.slice(3, 6), slot * 3);
      a.iZ.array.set(g.axes.slice(6, 9), slot * 3);
      const p = galaxyParams(g, 1);
      ['iA', 'iB', 'iC', 'iD', 'iE', 'iF', 'iG'].forEach((name, k) => a[name].array.set(p[k], slot * 4));
      a.iGlow.array.set([...glowOf(g), slot], slot * 4);
      a.iLum.array[slot] = g.lum ?? 1e9;
    }
    this.dirty[0] = Math.min(this.dirty[0], slot);
    this.dirty[1] = Math.max(this.dirty[1], slot);
  }

  /** Takes in the galaxies generated and dropped since the last frame. */
  /** Generated galaxies waiting for a slot (a few thousand are written per frame at most). */
  private queued: GalaxyData[] = [];

  private stream(): void {
    const drained = COSMOS.drain();
    const removed = drained.removed;
    if (drained.added.length) this.queued.push(...drained.added);
    // (One gone before it was written: never written.)
    if (removed.length && this.queued.length) {
      const gone = new Set(removed.map((g) => g.id));
      this.queued = this.queued.filter((g) => !gone.has(g.id));
    }
    const added = this.queued.splice(0, WRITES_PER_FRAME);
    for (const g of removed) {
      const slot = this.slotOf.get(g.id);
      if (slot === undefined) continue;
      this.slotOf.delete(g.id);
      this.write(slot, null);
      this.free.push(slot);
    }
    // (Lowest slots first, so that what is uploaded stays together.)
    if (removed.length) this.free.sort((x, y) => y - x);
    for (const g of added) {
      if (this.slotOf.has(g.id)) continue;
      const slot = this.free.length ? this.free.pop()! : this.top < CAPACITY ? this.top++ : -1;
      if (slot < 0) break;
      this.slotOf.set(g.id, slot);
      this.write(slot, g);
    }
    if (this.dirty[0] <= this.dirty[1]) {
      for (const attr of Object.values(this.attrs)) {
        attr.clearUpdateRanges();
        attr.addUpdateRange(this.dirty[0] * attr.itemSize, (this.dirty[1] - this.dirty[0] + 1) * attr.itemSize);
        attr.needsUpdate = true;
      }
      this.dirty = [Infinity, -Infinity];
    }
    this.geometry.instanceCount = this.top;
  }

  constructor() {
    const quad = new THREE.PlaneGeometry(2, 2);
    const geometry = this.geometry;
    geometry.setAttribute('position', quad.getAttribute('position'));
    geometry.setIndex(quad.getIndex());
    for (const [name, width] of [['iPos', 3], ['iX', 3], ['iY', 3], ['iZ', 3], ['iA', 4], ['iB', 4], ['iC', 4], ['iD', 4], ['iE', 4], ['iF', 4], ['iG', 4], ['iGlow', 4], ['iLum', 1]] as const) {
      const attr = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * width), width);
      attr.setUsage(THREE.DynamicDrawUsage);
      this.attrs[name] = attr;
      geometry.setAttribute(name, attr);
    }
    for (const g of GALAXIES) {
      this.slotOf.set(g.id, g.id);
      this.write(g.id, g);
    }
    this.top = GALAXIES.length;
    geometry.instanceCount = this.top;

    const make = (uniforms: Record<string, THREE.IUniform>, defines: Record<string, number>): THREE.ShaderMaterial => new THREE.ShaderMaterial({
      vertexShader: FIELD_VERT, fragmentShader: FIELD_FRAG, uniforms, defines,
      transparent: true, premultipliedAlpha: true, depthTest: false, depthWrite: false,
    });
    this.field = make({
      uCam: { value: new THREE.Vector3() }, uPixelsPerRadian: { value: 1000 }, uFullPpr: { value: 1000 }, uBig: { value: new THREE.Vector2(...BIG_PX) },
      uBrightness: { value: 1 }, uNearId: { value: new THREE.Vector2(-1, -1) }, uNearWeight: { value: new THREE.Vector2() },
      uHideClouds: { value: 0 }, uFaint: { value: FAINT }, uNoise: { value: galaxyNoise }, ...galaxyKnotUniforms,
    }, {});
    // The same galaxies on the soft layer; only the resolution differs.
    this.fieldSoft = make({ ...this.field.uniforms, uPixelsPerRadian: { value: 1000 } }, { SOFT_PASS: 1 });
    const billboards = new THREE.Mesh(geometry, this.field);
    billboards.frustumCulled = false;
    billboards.renderOrder = -4;
    // (The galaxies around the camera are GalaxyHost's, on screen: any other view gets them as billboards.)
    billboards.onBeforeRender = (_r, _s, camera) => {
      this.field.uniforms.uNearWeight.value = camera === this.camera ? this.nearWeight : this.allWeight;
      this.field.uniformsNeedUpdate = true;
    };
    const large = new THREE.Mesh(geometry, this.fieldSoft);
    large.frustumCulled = false;
    large.layers.set(SOFT_LAYER);
    large.onBeforeRender = billboards.onBeforeRender;
    this.group.add(large);
    this.host.mesh.renderOrder = -3;
    this.home.mesh.renderOrder = -3;
    this.group.add(billboards, this.host.mesh, this.home.mesh);

    this.sparkle = new THREE.ShaderMaterial({
      vertexShader: SPARKLE_VERT,
      fragmentShader: SPARKLE_FRAG,
      uniforms: { uPixelsPerRadian: { value: 1000 }, uGain: { value: 0 }, tHost: { value: null }, tDepth: { value: null }, uHost: { value: 0 } },
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
      // Few are bright, most barely show. (The dust in front of them dims them as it dims the glow: drawn, they
      // look up the march of this frame, SPARKLE_VERT.)
      const gain = Math.min(0.13 * Math.pow(Math.max(rng.next(), 1e-4), -0.5), 1.8);
      const tint = rng.next() < young ? [0.62, 0.78, 1.0] : rng.next() < 0.5 ? [1.0, 0.92, 0.8] : [1.0, 0.72, 0.45];
      col.set([tint[0] * gain, tint[1] * gain, tint[2] * gain], i * 3);
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
    // (Only the view the march was made for can read it: any other, the lens's cube map, draws them undimmed.)
    points.onBeforeRender = (_r, _s, camera) => {
      const u = this.sparkle.uniforms;
      const host = this.host.output();
      u.uHost.value = camera === this.camera && host ? 1 : 0;
      if (host) { u.tHost.value = host.color; u.tDepth.value = host.depth; }
      this.sparkle.uniformsNeedUpdate = true;
    };
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
    this.volume ??= new GalaxyVolume();
    const out = this.volume.panorama(list, centre, pole, width, passes);
    if (out) for (let i = 0; i < out.length; i++) if (i % 4 !== 3) out[i] *= INSIDE_GAIN;
    return out;
  }

  /** For measuring: the viewpoint the galaxy around the camera is drawn from (its own frame, ly), null if none. */
  shownEye(): number[] | null {
    return this.host.shownEye;
  }

  /**
   * cam: position in the universe (ly); gain: brightness of all galaxy light, 1 = as calibrated; camera: the
   * background camera, already turned and projected for this frame.
   */
  update(cam: { x: number; y: number; z: number }, pixelsPerRadian: number, gain: number, camera?: THREE.PerspectiveCamera): void {
    if (camera) this.camera = camera;
    // The universe beyond the catalogue, generated around the camera within a budget, into the billboards.
    COSMOS.update(cam);
    this.stream();
    this.state.galaxies = this.slotOf.size;
    // The galaxies near enough to be marched on screen, nearest (in their own radii) first.
    const near = this.near;
    near.length = 0;
    const consider = (g: GalaxyData): void => {
      const d = Math.hypot(g.x - cam.x, g.y - cam.y, g.z - cam.z) / g.radius;
      if (d >= NEAR_END) return;
      let eye = this.eyes.get(g.id);
      if (!eye) this.eyes.set(g.id, (eye = { x: 0, y: 0, z: 0 }));
      toGalaxy(g, cam.x, cam.y, cam.z, eye);
      near.push({ galaxy: g, eye, weight: 1 - THREE.MathUtils.smoothstep(d, NEAR_START, NEAR_END) });
    };
    for (const g of GALAXIES) consider(g);
    // (No generated galaxy is larger than 300 kly: within eight of its radii means within 2.4 Mly.)
    COSMOS.near(cam.x, cam.y, cam.z, 2.4e6, consider);
    if (this.eyes.size > 4096) this.eyes.clear();
    const span = (n: NearGalaxy): number => Math.hypot(n.eye.x, n.eye.y, n.eye.z) / n.galaxy.radius;
    near.sort((a, b) => span(a) - span(b));
    near.length = Math.min(near.length, NEAR_GALAXIES);
    // The eye adapts: inside a disc its light is all around and reads dimmer than the same galaxy seen whole from outside.
    const host = near[0];
    // Between the galaxies, far from all of them, the eye adapts further still (over a few seconds, as eyes do).
    const apart = THREE.MathUtils.smoothstep(host ? span(host) : NEAR_END, 4, NEAR_END);
    const tNow = performance.now() / 1000, dtA = Math.min(Math.max(tNow - this.lastAdaptT, 0), 0.25);
    this.lastAdaptT = tNow;
    const goal = THREE.MathUtils.lerp(1, this.intergalactic, apart);
    this.adaptSmooth += (goal - this.adaptSmooth) * (1 - Math.exp(-dtA / 2));
    this.adapt = this.adaptSmooth;
    let out = 1;
    if (host) {
      const g = host.galaxy;
      out = THREE.MathUtils.smoothstep(Math.max(Math.abs(host.eye.y) - g.height, Math.hypot(host.eye.x, host.eye.z) - g.radius), 0, g.radius * 0.35);
    }
    gain *= THREE.MathUtils.lerp(INSIDE_GAIN, OUTSIDE_GAIN, out);
    // (Towards a galaxy's core the sky is many times brighter: the light meter turns the exposure down there.)
    const surveyed = this.home.update(host, pixelsPerRadian, this.survey ? HOME_GAIN : 0);
    // Inside a galaxy, above it, in its outskirts and outside it, it is one march of one model from where the
    // camera is: leaving the disc changes the perspective and nothing else. (What the survey shows, it leaves.)
    const mapped = Math.max(0, 1 - (this.survey ? HomeSky.cover(host) : 0));
    /** (For measuring: how much of the host the march draws, and how bright.) */
    this.state = { ...this.state, mapped, gain };
    if (this.camera && mapped > 0.002) this.host.update(near, cam, this.camera, gain * mapped, pixelsPerRadian, mapped);
    else this.host.update(NO_GALAXIES, cam, this.camera!, 0, pixelsPerRadian, 0);

    const f = this.field.uniforms;
    f.uCam.value.set(cam.x, cam.y, cam.z);
    f.uPixelsPerRadian.value = pixelsPerRadian;
    f.uFullPpr.value = pixelsPerRadian;
    this.fieldSoft.uniforms.uPixelsPerRadian.value = pixelsPerRadian * softLayer.scale;
    f.uBrightness.value = gain;
    f.uFaint.value = FAINT * 4 ** COSMOS.bias;
    for (let i = 0; i < NEAR_GALAXIES; i++) {
      f.uNearId.value.setComponent(i, near[i] ? this.slotOf.get(near[i].galaxy.id) ?? -1 : -1);
      this.nearWeight.setComponent(i, near[i] ? 1 - near[i].weight : 0);
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
