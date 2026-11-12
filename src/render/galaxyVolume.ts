import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { armStructureOf, type GalaxyData } from '../universe/universe';
import { GALAXY_GLSL, galaxyKnotUniforms, galaxyNoise } from './galaxyShader';
import { probeRenderer } from './probe';

/** How many galaxies the camera can be inside of (or close to) at once. */
export const NEAR_GALAXIES = 2;

/** The march parameters of a galaxy, as the five vectors the shader expects. */
export function galaxyParams(g: GalaxyData, brightness: number): [number[], number[], number[], number[], number[], number[], number[]] {
  const st = armStructureOf(g);
  return [
    [g.radius, g.discScale, g.height, g.bulgeScale],
    [g.arms, g.pitchK, g.armContrast, g.dust],
    [g.bulgeLum, g.discLum, g.blue, g.seed],
    [g.bulgeFlat, g.irregular, brightness, g.bar ?? (g.kind === 'barred spiral' ? 1.8 : 1)],
    [st.flocculent, st.spurs, st.lopsided, st.elongation],
    g.ring ?? [0, 0, 0, 0],
    [g.tails ?? 0, g.shells ?? 0, g.outflow ?? 0, g.warp ?? 0],
  ];
}

const MARCH_VERT = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const MARCH_FRAG = /* glsl */ `
${GALAXY_GLSL}
uniform vec4 uA[${NEAR_GALAXIES}];
uniform vec4 uB[${NEAR_GALAXIES}];
uniform vec4 uC[${NEAR_GALAXIES}];
uniform vec4 uD[${NEAR_GALAXIES}];
uniform vec4 uE[${NEAR_GALAXIES}];
uniform vec4 uF[${NEAR_GALAXIES}];
uniform vec4 uG[${NEAR_GALAXIES}];
uniform mat3 uFrame[${NEAR_GALAXIES}];   // universe axes to the galaxy's own
uniform vec3 uEye[${NEAR_GALAXIES}];     // the camera in the galaxy's frame
uniform float uWeight[${NEAR_GALAXIES}];
uniform int uCount;
uniform vec3 uFaceU;
uniform vec3 uFaceV;
uniform vec3 uFaceF;
uniform float uSize;
uniform int uSteps;
uniform float uPass;
void main() {
  // Later passes also land anywhere inside their texel, so what is finer than a texel averages out smoothly.
  vec2 sub = uSettle > 0.5 && uPass > 0.5 ? vec2(marchJitter(gl_FragCoord.xy + uPass * 5.0), marchJitter(gl_FragCoord.yx + uPass * 11.0)) - 0.5 : vec2(0.0);
#ifdef PANORAMA
  // The whole sky in galactic longitude and latitude, as the survey maps are: centre in the middle, longitude to the left.
  // (uFaceU: universe direction of l = 0; uFaceV: of l = 90 deg; uFaceF: north galactic pole.)
  vec2 lb = vec2(0.5 - (gl_FragCoord.x + sub.x) / uSize, (gl_FragCoord.y + sub.y) / (0.5 * uSize) - 0.5) * vec2(6.2831853, 3.14159265);
  vec3 dir = cos(lb.y) * (cos(lb.x) * uFaceU + sin(lb.x) * uFaceV) + sin(lb.y) * uFaceF;
#else
  vec2 uv = (gl_FragCoord.xy + sub) / uSize * 2.0 - 1.0;
  vec3 dir = normalize(uFaceF + uv.x * uFaceU + uv.y * uFaceV);
#endif
  // Rays sample at nearly the same distances, so each march step is a soft shell of cloud around the
  // camera rather than grain; each pass shifts the shells, and the passes average towards the true light.
  // (Every pass, the first too, spreads its rays a little: a map of one pass is fine grain, never shells.)
  float jitter = fract(0.5 + uPass * 0.6180340 + 0.6 * (marchJitter(gl_FragCoord.xy + uPass * 17.0) - 0.5));
  vec4 sum = vec4(0.0);
  // Nearest galaxy first: each one is seen through the dust of those before it.
  for (int i = 0; i < ${NEAR_GALAXIES}; i++) {
    if (i >= uCount) break;
    vec4 g = galaxyMarch(uEye[i], uFrame[i] * dir, uA[i], uB[i], uC[i], uD[i], uE[i], uF[i], uG[i], uSteps, jitter, 2.0 / uSize) * uWeight[i];
    sum += (1.0 - sum.a) * g;
  }
  gl_FragColor = sum;
}
`;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FINE_SIZE = 1024;
const SKY_FRAG = /* glsl */ `
uniform samplerCube uFrom;
uniform samplerCube uTo;
uniform vec2 uSizes;    // texels across a face of each map; a draft (coarser than the fine map) is drawn smooth
uniform float uMix;
uniform float uGain;
uniform float uCover;   // how much of the galaxy the map carries: what it hides behind it goes with it
uniform float uGrain;   // pixels per radian, for the grain of unresolved stars
varying vec3 vDir;

float hash3(vec3 p) {
  p = fract(p * vec3(443.897, 441.423, 437.195));
  p += dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}

// A cube map read with a cubic B-spline instead of linearly (four linear reads): no texel blocks where a
// coarse map is magnified. (Offsets are taken on the face the direction falls on; a read past its edge is
// simply a direction on the next face.)
vec4 smoothCube(samplerCube map, vec3 d, float size) {
  vec3 a = abs(d);
  vec3 f, e1, e2;
  if (a.x >= a.y && a.x >= a.z) { f = vec3(sign(d.x), 0.0, 0.0); e1 = vec3(0.0, 0.0, 1.0); e2 = vec3(0.0, 1.0, 0.0); }
  else if (a.y >= a.z) { f = vec3(0.0, sign(d.y), 0.0); e1 = vec3(1.0, 0.0, 0.0); e2 = vec3(0.0, 0.0, 1.0); }
  else { f = vec3(0.0, 0.0, sign(d.z)); e1 = vec3(1.0, 0.0, 0.0); e2 = vec3(0.0, 1.0, 0.0); }
  float m = dot(d, f);
  vec2 x = (vec2(dot(d, e1), dot(d, e2)) / m * 0.5 + 0.5) * size - 0.5;
  vec2 i = floor(x), t = x - i;
  vec2 t2 = t * t, t3 = t2 * t;
  vec2 w0 = (1.0 - 3.0 * t + 3.0 * t2 - t3) / 6.0, w1 = (4.0 - 6.0 * t2 + 3.0 * t3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * t + 3.0 * t2 - 3.0 * t3) / 6.0, w3 = t3 / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 c0 = ((i - 1.0 + w1 / g0) + 0.5) / size * 2.0 - 1.0, c1 = ((i + 1.0 + w3 / g1) + 0.5) / size * 2.0 - 1.0;
  return g0.y * (g0.x * textureCube(map, f + c0.x * e1 + c0.y * e2) + g1.x * textureCube(map, f + c1.x * e1 + c0.y * e2))
       + g1.y * (g0.x * textureCube(map, f + c0.x * e1 + c1.y * e2) + g1.x * textureCube(map, f + c1.x * e1 + c1.y * e2));
}

vec4 readMap(samplerCube map, vec3 d, float size) {
  return size < ${FINE_SIZE}.0 ? smoothCube(map, d, size) : textureCube(map, d);
}

void main() {
  vec3 d = normalize(vDir);
  // (Once the new map has faded in, the old one is not read at all.)
  vec4 c = readMap(uTo, d, uSizes.y);
  if (uMix < 0.999) c = mix(readMap(uFrom, d, uSizes.x), c, uMix);
  // The glow of a galaxy from inside is stars too faint to see one by one, but not so many that
  // they blur into fog: a fine grain of them, a little coarser than the pixels.
  vec3 cell = floor(d * uGrain * 1.4);
  float s = hash3(cell);
  float grain = 0.84 + 0.65 * s * s * s * s;
  gl_FragColor = vec4(c.rgb * uGain * grain, c.a * uCover);
}
`;

// Cube faces in WebGL's order (+X -X +Y -Y +Z -Z): direction = F + u U + v V for u, v in -1..1.
const FACES = [
  [[0, 0, -1], [0, -1, 0], [1, 0, 0]],
  [[0, 0, 1], [0, -1, 0], [-1, 0, 0]],
  [[1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[1, 0, 0], [0, 0, -1], [0, -1, 0]],
  [[1, 0, 0], [0, -1, 0], [0, 0, 1]],
  [[-1, 0, 0], [0, -1, 0], [0, 0, -1]],
];

/** One galaxy as seen by the march: which one, from where, how strongly it shows. */
export interface NearGalaxy {
  galaxy: GalaxyData;
  /** The camera in the galaxy's frame, light years. */
  eye: { x: number; y: number; z: number };
  weight: number;
}

interface View {
  ids: number[];
  eyes: number[];
  weights: number[];
  /** How far the camera may drift from this view before it is stale, light years. */
  tolerance: number;
}

interface Job {
  target: THREE.WebGLCubeRenderTarget;
  view: View;
  steps: number;
  /** Progress: the face being marched, and the first of its rows not yet marched. */
  face: number;
  row: number;
  /** 0 writes the map; pass k > 0 is averaged into the k passes already there. */
  pass: number;
}

// The draft is the same march as the fine map, only coarser and a single pass: the same galaxy while the
// camera moves as when it rests, never a different look to hand over from.
const DRAFT = { size: 256, steps: 160 };
const FINE = { size: FINE_SIZE, steps: 160, passes: 12, show: 3 };
/**
 * Texels marched per frame: as many as the frame rate allows. The budget grows while frames keep to 60 Hz
 * and is cut back as soon as one runs late, before the pipeline would lower the resolution.
 * (GPU timer queries were tried: on ANGLE / Metal they time far more than the march.)
 */
const TEXELS = { start: 24000, min: 12000, max: 300000, grow: 1.015, cut: 0.6, lateMs: 18.3, holdMs: 3000 };

function capture(near: NearGalaxy[]): View {
  const p = near[0];
  const g = p.galaxy;
  const outside = Math.max(0, Math.abs(p.eye.y) - 2 * g.height, Math.hypot(p.eye.x, p.eye.z) - g.radius);
  return {
    ids: near.map((n) => n.galaxy.id),
    eyes: near.flatMap((n) => [n.eye.x, n.eye.y, n.eye.z]),
    weights: near.map((n) => n.weight),
    tolerance: g.radius * 6e-5 + outside * 1e-3,
  };
}

function stale(view: View, now: View): boolean {
  if (view.ids.length !== now.ids.length) return true;
  for (let i = 0; i < view.ids.length; i++) {
    if (view.ids[i] !== now.ids[i] || Math.abs(view.weights[i] - now.weights[i]) > 0.02) return true;
  }
  return Math.hypot(view.eyes[0] - now.eyes[0], view.eyes[1] - now.eyes[1], view.eyes[2] - now.eyes[2]) > view.tolerance;
}

/**
 * (No longer drawn: the galaxies around the camera are marched on screen every frame, GalaxyHost. What is
 * left is the panorama, the tuning tool scripts/gpano.mjs uses.)
 *
 * The galaxies around the camera, drawn as a sky. Marching them costs far more than a
 * frame can afford at full resolution, but their light barely changes from frame to
 * frame: it is marched into a cube map, a face at a time, only after the camera has
 * moved, and sharpened once the camera rests.
 */
export class GalaxyVolume {
  readonly mesh: THREE.Mesh;
  private readonly sky: THREE.ShaderMaterial;
  private readonly march: THREE.ShaderMaterial;
  private readonly quad: FullScreenQuad;
  // Four drafts: the one fading out, the one fading in, a finished one waiting, and the next being marched.
  private readonly drafts = Array.from({ length: 4 }, () => this.makeTarget(DRAFT.size));
  private from: THREE.WebGLCubeRenderTarget | null = null;
  private fromView: View | null = null;
  /** A finished draft waiting for the one before it to have faded in fully (a swap before then would jump). */
  private pending: { target: THREE.WebGLCubeRenderTarget; view: View } | null = null;
  /** How fast each galaxy's eye moves (ly/s, its own frame), smoothed: drafts are marched for where the camera will be. */
  private readonly velocity = new Map<number, number[]>();
  private readonly lastEye = new Map<number, number[]>();
  /** Seconds a new map takes to fade in: as long as the next draft takes to march, so the sky never stands still between them. */
  private fadeTime = 0.2;
  private jobStart = 0;
  private readonly fine = this.makeTarget(FINE.size);
  private shown: THREE.WebGLCubeRenderTarget | null = null;
  private shownView: View | null = null;
  private job: Job | null = null;
  private fade = 1;
  private finePasses = 0;
  private lastTime = 0;
  /** Texels to march this frame, and when the last march was. */
  texels = TEXELS.start;
  private lastMarch = 0;
  private frameMs = 16.7;
  /** After a late frame: no growth until then, and never again to the level that was late, for a while. */
  private holdUntil = 0;
  private ceiling = TEXELS.max;

  constructor() {
    const vec4s = (): THREE.Vector4[] => Array.from({ length: NEAR_GALAXIES }, () => new THREE.Vector4());
    this.march = new THREE.ShaderMaterial({
      vertexShader: MARCH_VERT,
      fragmentShader: MARCH_FRAG,
      uniforms: {
        uA: { value: vec4s() }, uB: { value: vec4s() }, uC: { value: vec4s() }, uD: { value: vec4s() }, uE: { value: vec4s() }, uF: { value: vec4s() }, uG: { value: vec4s() },
        uFrame: { value: Array.from({ length: NEAR_GALAXIES }, () => new THREE.Matrix3()) },
        uEye: { value: Array.from({ length: NEAR_GALAXIES }, () => new THREE.Vector3()) },
        uWeight: { value: new Array(NEAR_GALAXIES).fill(0) },
        uCount: { value: 0 },
        uFaceU: { value: new THREE.Vector3() }, uFaceV: { value: new THREE.Vector3() }, uFaceF: { value: new THREE.Vector3() },
        uSize: { value: 1 }, uSteps: { value: 1 }, uPass: { value: 0 }, uSettle: { value: 0 }, uNoise: { value: galaxyNoise }, ...galaxyKnotUniforms,
      },
      blending: THREE.CustomBlending, blendSrc: THREE.ConstantAlphaFactor, blendDst: THREE.OneMinusConstantAlphaFactor,
      depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.march);
    this.sky = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: { uFrom: { value: null }, uTo: { value: null }, uSizes: { value: new THREE.Vector2(FINE_SIZE, FINE_SIZE) }, uMix: { value: 1 }, uGain: { value: 1 }, uCover: { value: 1 }, uGrain: { value: 1000 } },
      side: THREE.BackSide, transparent: true, premultipliedAlpha: true, depthTest: false, depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), this.sky);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /**
   * For measuring how smoothly the sky follows the camera: the viewpoint (first galaxy's frame, ly) the sky on
   * screen shows, as the blend of the two maps it fades between; null when none is shown.
   */
  shownEye(): number[] | null {
    const to = this.shownView, from = this.fromView ?? to;
    if (!to || !from || !this.mesh.visible) return null;
    const f = this.sky.uniforms.uMix.value as number;
    return [0, 1, 2].map((i) => from.eyes[i] + (to.eyes[i] - from.eyes[i]) * f);
  }

  private makeTarget(size: number): THREE.WebGLCubeRenderTarget {
    return new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false });
  }

  /** near: the galaxies to draw, nearest first (at most NEAR_GALAXIES); brightness scales their light without a new march. */
  update(near: NearGalaxy[], brightness: number, pixelsPerRadian = 1000, cover = 1): void {
    this.sky.uniforms.uGrain.value = pixelsPerRadian;
    this.sky.uniforms.uCover.value = cover;
    const renderer = probeRenderer();
    if (!renderer || near.length === 0) {
      this.mesh.visible = false;
      this.shown = null;
      this.pending = null;
      this.job = null;
      return;
    }
    const time = performance.now();
    const dt = Math.min((time - this.lastTime) / 1000, 0.1);
    this.lastTime = time;
    const now = capture(near);
    for (const n of near) {
      const e = [n.eye.x, n.eye.y, n.eye.z], last = this.lastEye.get(n.galaxy.id), v = this.velocity.get(n.galaxy.id) ?? [0, 0, 0];
      // (A jump, a go-to or a teleport, is not a speed: then the camera starts from rest again.)
      const jump = last ? Math.hypot(e[0] - last[0], e[1] - last[1], e[2] - last[2]) : Infinity;
      if (!last || jump > n.galaxy.radius * 0.02) v.fill(0);
      else if (dt > 0) for (let i = 0; i < 3; i++) v[i] += ((e[i] - last[i]) / dt - v[i]) * Math.min(1, dt * 8);
      this.velocity.set(n.galaxy.id, v);
      this.lastEye.set(n.galaxy.id, e);
    }

    if (!this.shown || !this.shownView) {
      // Nothing to show yet: the first draft takes a few frames.
      if (!this.job) {
        this.job = { target: this.drafts[0], view: now, steps: DRAFT.steps, face: 0, row: 0, pass: 0 };
        this.setGalaxies(near);
      }
      this.advance(renderer);
      this.mesh.visible = this.shown !== null;
      this.sky.uniforms.uMix.value = this.fade;
      this.sky.uniforms.uGain.value = brightness;
      return;
    }
    if (this.job && this.job.target === this.fine && stale(this.job.view, now)) {
      this.job = null;
      if (this.shown !== this.fine) this.finePasses = 0;
    }
    this.fade = Math.min(1, this.fade + dt / this.fadeTime);
    if (this.pending && this.fade >= 1) {
      this.show(this.pending.target, this.pending.view);
      this.pending = null;
    }
    // While the camera moves, drafts follow one another without a pause: each fades in over the time the
    // next one takes, so the sky glides from one viewpoint to the next instead of jumping. And each is
    // marched for where the camera will be when it is half faded in, so the sky keeps pace with the camera
    // instead of trailing it.
    // (Moving at all, it drafts on and on: waiting until the camera is a tolerance away would step the sky.)
    const v0 = this.velocity.get(near[0].galaxy.id) ?? [0, 0, 0];
    const moving = Math.hypot(v0[0], v0[1], v0[2]) > now.tolerance * 0.5;
    const newest = this.pending?.view ?? this.shownView!;
    const free = this.drafts.find((d) => d !== this.shown && d !== this.from && d !== this.pending?.target);
    if (!this.job && free && (!this.pending || moving)) {
      if (moving || stale(newest, now)) {
        const target = free;
        const ahead = near.map((n) => {
          const v = this.velocity.get(n.galaxy.id) ?? [0, 0, 0];
          // (Never further ahead than a little of the galaxy: a guess, not a jump.)
          const lead = Math.min(1.8 * this.fadeTime, (n.galaxy.radius * 0.05) / Math.max(Math.hypot(v[0], v[1], v[2]), 1e-9));
          return { ...n, eye: { x: n.eye.x + v[0] * lead, y: n.eye.y + v[1] * lead, z: n.eye.z + v[2] * lead } };
        });
        this.job = { target, view: capture(ahead), steps: DRAFT.steps, face: 0, row: 0, pass: 0 };
        this.jobStart = time;
        this.finePasses = 0;
        this.setGalaxies(ahead);
      } else if (this.fade >= 1 && !this.pending && this.finePasses < FINE.passes) {
        // At rest: a sharper map first, then more passes averaged into it until the grain of the march is gone.
        this.job = { target: this.fine, view: now, steps: FINE.steps, face: 0, row: 0, pass: this.finePasses };
        this.setGalaxies(near);
      }
    }
    if (this.job) this.advance(renderer);
    this.sky.uniforms.uMix.value = this.fade;
    this.sky.uniforms.uGain.value = brightness;
    this.mesh.visible = true;
  }

  /**
   * For tuning against the survey: the whole sky from the camera in galactic longitude and latitude
   * (l = 0 towards `centre`, the plate carree of the NASA maps), linear light, `width` x `width / 2`, RGBA rows bottom-up.
   * Each galaxy is marched on its own and their light added. Slow (seconds): a tool, not for frames.
   */
  panorama(near: NearGalaxy[], centre: THREE.Vector3, north: THREE.Vector3, width = 1024, passes = 12, steps = FINE.steps): Float32Array | null {
    const renderer = probeRenderer();
    if (!renderer) return null;
    const height = width / 2;
    const material = new THREE.ShaderMaterial({
      vertexShader: MARCH_VERT, fragmentShader: MARCH_FRAG, uniforms: this.march.uniforms, defines: { PANORAMA: 1 },
      blending: THREE.CustomBlending, blendSrc: THREE.ConstantAlphaFactor, blendDst: THREE.OneMinusConstantAlphaFactor,
      depthTest: false, depthWrite: false,
    });
    const quad = new FullScreenQuad(material);
    const target = new THREE.WebGLRenderTarget(width, height, { type: THREE.FloatType, depthBuffer: false });
    const u = this.march.uniforms;
    const f = new THREE.Vector3().copy(centre).normalize();
    const n = new THREE.Vector3().copy(north).normalize();
    // (l = 90 deg is the pole crossed with the centre: the real sky, longitude rising to the left.)
    const side = new THREE.Vector3().crossVectors(n, f);
    const sum = new Float32Array(width * height * 4);
    const pixels = new Float32Array(width * height * 4);
    const previous = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    for (const g of near) {
      this.setGalaxies([{ ...g, weight: 1 }]);
      u.uFaceU.value.copy(f);
      u.uFaceV.value.copy(side);
      u.uFaceF.value.copy(n);
      u.uSize.value = width;
      u.uSteps.value = steps;
      u.uSettle.value = 1;
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.autoClear = false;
      const strips = 8;
      for (let pass = 0; pass < passes; pass++) {
        u.uPass.value = pass;
        material.blendAlpha = 1 / (pass + 1);
        for (let s = 0; s < strips; s++) {
          target.scissorTest = true;
          target.scissor.set(0, (s * height) / strips, width, height / strips);
          renderer.setRenderTarget(target);
          quad.render(renderer);
        }
      }
      target.scissorTest = false;
      renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
      for (let i = 0; i < sum.length; i++) sum[i] += pixels[i];
    }
    renderer.setRenderTarget(previous);
    renderer.autoClear = autoClear;
    target.dispose();
    material.dispose();
    quad.dispose();
    // The sky map's own job must start again: its uniforms were used.
    this.job = null;
    this.shown = null;
    this.pending = null;
    this.shownView = null;
    return sum;
  }

  private setGalaxies(near: NearGalaxy[]): void {
    const u = this.march.uniforms;
    u.uCount.value = near.length;
    near.forEach((n, i) => {
      const [a, b, c, d, e, f, h] = galaxyParams(n.galaxy, 1);
      u.uA.value[i].fromArray(a);
      u.uB.value[i].fromArray(b);
      u.uC.value[i].fromArray(c);
      u.uD.value[i].fromArray(d);
      u.uE.value[i].fromArray(e);
      u.uF.value[i].fromArray(f);
      u.uG.value[i].fromArray(h);
      const ax = n.galaxy.axes;
      u.uFrame.value[i].set(ax[0], ax[1], ax[2], ax[3], ax[4], ax[5], ax[6], ax[7], ax[8]);
      u.uEye.value[i].set(n.eye.x, n.eye.y, n.eye.z);
      u.uWeight.value[i] = n.weight;
    });
  }

  /** Marches the next rows of the current job, as many as fit in the frame's budget; shows the map when the last are in. */
  private advance(renderer: THREE.WebGLRenderer): void {
    const job = this.job!;
    const u = this.march.uniforms;
    const size = job.target.width;
    const face = job.face;
    // As many rows as the budget allows; the budget follows the frame time.
    const t = performance.now(), dt = t - this.lastMarch;
    this.lastMarch = t;
    if (dt < 100) {
      // (Smoothed: a lone slow frame, a page or a texture loading, says nothing about the march.)
      this.frameMs += (dt - this.frameMs) * 0.15;
      if (this.frameMs > TEXELS.lateMs && t > this.holdUntil - TEXELS.holdMs + 500) {
        this.ceiling = Math.max(this.texels * 0.8, TEXELS.min);
        this.texels *= TEXELS.cut;
        this.holdUntil = t + TEXELS.holdMs;
      } else if (this.frameMs < 17.3 && t > this.holdUntil) {
        this.texels *= TEXELS.grow;
      }
      // The ceiling creeps back up slowly: the load of the rest of the frame changes.
      this.ceiling = Math.min(this.ceiling * 1.003, TEXELS.max);
      this.texels = THREE.MathUtils.clamp(this.texels, TEXELS.min, this.ceiling);
    }
    const rows = Math.min(size - job.row, Math.max(2, Math.floor(this.texels / size)));
    const [fu, fv, ff] = FACES[face];
    u.uFaceU.value.fromArray(fu);
    u.uFaceV.value.fromArray(fv);
    u.uFaceF.value.fromArray(ff);
    u.uSize.value = size;
    u.uSteps.value = job.steps;
    u.uPass.value = job.pass;
    u.uSettle.value = 1;
    this.march.blendAlpha = 1 / (job.pass + 1);
    job.target.scissorTest = true;
    job.target.scissor.set(0, job.row, size, rows);
    const previous = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    // Later passes blend with what the earlier ones left in the map.
    renderer.autoClear = false;
    renderer.setRenderTarget(job.target, face);
    this.quad.render(renderer);
    renderer.setRenderTarget(previous);
    renderer.autoClear = autoClear;
    job.row += rows;
    if (job.row >= size) {
      job.row = 0;
      job.face++;
    }
    if (job.face < 6) return;
    this.job = null;
    if (job.target === this.fine) this.finePasses = job.pass + 1;
    // The fine map is noisy until a few passes are in: until then the draft stays up.
    if (job.pass !== (job.target === this.fine ? FINE.show - 1 : 0)) return;
    const took = THREE.MathUtils.clamp((performance.now() - this.jobStart) / 1000, 0.08, 0.6);
    // (A newer draft replaces one still waiting: the waiting one is out of date.)
    if (this.shown && this.fade < 1) this.pending = { target: job.target, view: job.view };
    else this.show(job.target, job.view);
    // The next map fades in over as long as this one took to march.
    this.fadeTime = job.target === this.fine ? 0.3 : took * 1.1;
  }

  /** Starts fading from what is on screen to a finished map. */
  private show(target: THREE.WebGLCubeRenderTarget, view: View): void {
    const from = (this.from = this.shown ?? target);
    this.fromView = this.shownView ?? view;
    this.sky.uniforms.uFrom.value = from.texture;
    this.sky.uniforms.uTo.value = target.texture;
    this.sky.uniforms.uSizes.value.set(from.width, target.width);
    this.fade = this.shown ? 0 : 1;
    this.shown = target;
    this.shownView = view;
  }
}
