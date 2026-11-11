import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import type { GalaxyData } from '../universe/universe';
import { GALAXY_GLSL, galaxyNoise } from './galaxyShader';
import { probeRenderer } from './probe';

/** How many galaxies the camera can be inside of (or close to) at once. */
export const NEAR_GALAXIES = 2;

/** The march parameters of a galaxy, as the four vectors the shader expects. */
export function galaxyParams(g: GalaxyData, brightness: number): [number[], number[], number[], number[]] {
  return [
    [g.radius, g.discScale, g.height, g.bulgeScale],
    [g.arms, g.pitchK, g.armContrast, g.dust],
    [g.bulgeLum, g.discLum, g.blue, g.seed],
    [g.bulgeFlat, g.irregular, brightness, g.kind === 'barred spiral' ? 1.8 : 1],
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
  vec2 uv = (gl_FragCoord.xy + sub) / uSize * 2.0 - 1.0;
  vec3 dir = normalize(uFaceF + uv.x * uFaceU + uv.y * uFaceV);
  // Rays sample at nearly the same distances, so each march step is a soft shell of cloud around the
  // camera rather than grain; each pass shifts the shells, and the passes average towards the true light.
  float jitter = fract(0.5 + uPass * 0.6180340 + (uPass > 0.5 ? 0.6 * (marchJitter(gl_FragCoord.xy + uPass * 17.0) - 0.5) : 0.0));
  vec4 sum = vec4(0.0);
  // Nearest galaxy first: each one is seen through the dust of those before it.
  for (int i = 0; i < ${NEAR_GALAXIES}; i++) {
    if (i >= uCount) break;
    vec4 g = galaxyMarch(uEye[i], uFrame[i] * dir, uA[i], uB[i], uC[i], uD[i], uSteps, jitter, 2.0 / uSize) * uWeight[i];
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

const SKY_FRAG = /* glsl */ `
uniform samplerCube uFrom;
uniform samplerCube uTo;
uniform float uMix;
uniform float uGain;
uniform float uGrain;   // pixels per radian, for the grain of unresolved stars
varying vec3 vDir;

float hash3(vec3 p) {
  p = fract(p * vec3(443.897, 441.423, 437.195));
  p += dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec3 d = normalize(vDir);
  vec4 c = mix(textureCube(uFrom, vDir), textureCube(uTo, vDir), uMix);
  // The glow of a galaxy from inside is stars too faint to see one by one, but not so many that
  // they blur into fog: a fine grain of them, a little coarser than the pixels.
  vec3 cell = floor(d * uGrain * 1.4);
  float s = hash3(cell);
  float grain = 0.84 + 0.65 * s * s * s * s;
  gl_FragColor = vec4(c.rgb * uGain * grain, c.a);
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
  strips: number;
  done: number;
  /** 0 writes the map; pass k > 0 is averaged into the k passes already there. */
  pass: number;
}

// (Strips must divide the size: a fractional row would leave a seam unmarched.)
const DRAFT = { size: 512, steps: 40, strips: 2 };
const FINE = { size: 1024, steps: 160, strips: 8, passes: 24, show: 4 };

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
  private readonly drafts = [this.makeTarget(DRAFT.size), this.makeTarget(DRAFT.size)];
  private readonly fine = this.makeTarget(FINE.size);
  private shown: THREE.WebGLCubeRenderTarget | null = null;
  private shownView: View | null = null;
  private job: Job | null = null;
  private fade = 1;
  private finePasses = 0;
  private lastTime = 0;

  constructor() {
    const vec4s = (): THREE.Vector4[] => Array.from({ length: NEAR_GALAXIES }, () => new THREE.Vector4());
    this.march = new THREE.ShaderMaterial({
      vertexShader: MARCH_VERT,
      fragmentShader: MARCH_FRAG,
      uniforms: {
        uA: { value: vec4s() }, uB: { value: vec4s() }, uC: { value: vec4s() }, uD: { value: vec4s() },
        uFrame: { value: Array.from({ length: NEAR_GALAXIES }, () => new THREE.Matrix3()) },
        uEye: { value: Array.from({ length: NEAR_GALAXIES }, () => new THREE.Vector3()) },
        uWeight: { value: new Array(NEAR_GALAXIES).fill(0) },
        uCount: { value: 0 },
        uFaceU: { value: new THREE.Vector3() }, uFaceV: { value: new THREE.Vector3() }, uFaceF: { value: new THREE.Vector3() },
        uSize: { value: 1 }, uSteps: { value: 1 }, uPass: { value: 0 }, uSettle: { value: 0 }, uNoise: { value: galaxyNoise },
      },
      blending: THREE.CustomBlending, blendSrc: THREE.ConstantAlphaFactor, blendDst: THREE.OneMinusConstantAlphaFactor,
      depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.march);
    this.sky = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: { uFrom: { value: null }, uTo: { value: null }, uMix: { value: 1 }, uGain: { value: 1 }, uGrain: { value: 1000 } },
      side: THREE.BackSide, transparent: true, premultipliedAlpha: true, depthTest: false, depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), this.sky);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  private makeTarget(size: number): THREE.WebGLCubeRenderTarget {
    return new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false });
  }

  /** near: the galaxies to draw, nearest first (at most NEAR_GALAXIES); brightness scales their light without a new march. */
  update(near: NearGalaxy[], brightness: number, pixelsPerRadian = 1000): void {
    this.sky.uniforms.uGrain.value = pixelsPerRadian;
    const renderer = probeRenderer();
    if (!renderer || near.length === 0) {
      this.mesh.visible = false;
      this.shown = null;
      this.job = null;
      return;
    }
    const time = performance.now();
    const dt = Math.min((time - this.lastTime) / 1000, 0.1);
    this.lastTime = time;
    const now = capture(near);

    if (!this.shown || !this.shownView) {
      // Nothing to show yet: the first draft takes a few frames.
      if (!this.job) {
        this.job = { target: this.drafts[0], view: now, steps: DRAFT.steps, strips: DRAFT.strips, done: 0, pass: 0 };
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
    this.fade = Math.min(1, this.fade + dt / 0.2);
    // A new march starts only once the last one has faded in: it overwrites the map being faded out.
    if (!this.job && this.fade >= 1) {
      if (stale(this.shownView!, now)) {
        const target = this.shown === this.drafts[0] ? this.drafts[1] : this.drafts[0];
        this.job = { target, view: now, steps: DRAFT.steps, strips: DRAFT.strips, done: 0, pass: 0 };
        this.finePasses = 0;
        this.setGalaxies(near);
      } else if (this.finePasses < FINE.passes) {
        // At rest: a sharper map first, then more passes averaged into it until the grain of the march is gone.
        this.job = { target: this.fine, view: now, steps: FINE.steps, strips: FINE.strips, done: 0, pass: this.finePasses };
        this.setGalaxies(near);
      }
    }
    if (this.job) this.advance(renderer);
    this.sky.uniforms.uMix.value = this.fade;
    this.sky.uniforms.uGain.value = brightness;
    this.mesh.visible = true;
  }

  private setGalaxies(near: NearGalaxy[]): void {
    const u = this.march.uniforms;
    u.uCount.value = near.length;
    near.forEach((n, i) => {
      const [a, b, c, d] = galaxyParams(n.galaxy, 1);
      u.uA.value[i].fromArray(a);
      u.uB.value[i].fromArray(b);
      u.uC.value[i].fromArray(c);
      u.uD.value[i].fromArray(d);
      const ax = n.galaxy.axes;
      u.uFrame.value[i].set(ax[0], ax[1], ax[2], ax[3], ax[4], ax[5], ax[6], ax[7], ax[8]);
      u.uEye.value[i].set(n.eye.x, n.eye.y, n.eye.z);
      u.uWeight.value[i] = n.weight;
    });
  }

  /** Marches the next strip of the current job; shows the map when the last one is in. */
  private advance(renderer: THREE.WebGLRenderer): void {
    const job = this.job!;
    const u = this.march.uniforms;
    const size = job.target.width;
    const face = Math.floor(job.done / job.strips), strip = job.done % job.strips;
    const [fu, fv, ff] = FACES[face];
    u.uFaceU.value.fromArray(fu);
    u.uFaceV.value.fromArray(fv);
    u.uFaceF.value.fromArray(ff);
    u.uSize.value = size;
    u.uSteps.value = job.steps;
    u.uPass.value = job.pass;
    u.uSettle.value = job.target === this.fine ? 1 : 0;
    this.march.blendAlpha = 1 / (job.pass + 1);
    const rows = size / job.strips;
    job.target.scissorTest = true;
    job.target.scissor.set(0, strip * rows, size, rows);
    const previous = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    // Later passes blend with what the earlier ones left in the map.
    renderer.autoClear = false;
    renderer.setRenderTarget(job.target, face);
    this.quad.render(renderer);
    renderer.setRenderTarget(previous);
    renderer.autoClear = autoClear;
    if (++job.done < 6 * job.strips) return;
    this.job = null;
    if (job.target === this.fine) this.finePasses = job.pass + 1;
    // The fine map is noisy until a few passes are in: until then the draft stays up.
    if (job.pass !== (job.target === this.fine ? FINE.show - 1 : 0)) return;
    this.sky.uniforms.uFrom.value = (this.shown ?? job.target).texture;
    this.sky.uniforms.uTo.value = job.target.texture;
    this.fade = this.shown ? 0 : 1;
    this.shown = job.target;
    this.shownView = job.view;
  }
}
