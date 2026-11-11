import * as THREE from 'three';
import { NEBULAE, type NebulaData } from '../universe/nebulae';
import { temperatureToRgb } from '../universe/stars';
import { BAKE_VERT, MAX_GLOWS, MAX_PRIMS, MAX_STARS, NEBULA_VERT, PARAM_SLOTS, nebulaFragment, nebulaNoise, type Family } from './nebulaShader';

// The nebulae of the catalogue, drawn in the background scene (light years, camera at the origin):
//   tiny on screen       a soft spot carrying the nebula's light (measured from the model itself);
//   up to BIG px across  marched where it is drawn, at full resolution, on a billboard over it;
//   larger, or around    marched into a target of reduced resolution, upscaled (bicubic) over the sky.
// Their brightest stars are drawn as points, as the starfield draws its own.

/**
 * Linear brightness (HDR frame, before exposure) of a surface of 21 mag/arcsec^2: the galaxies' scale
 * (galaxyCloud.ts), from the starfield's magnitude law anchored on stars of magnitude 7, a patch of mu
 * mag/arcsec^2 giving 729 x 10^(-0.4 (mu - 7)) per pixel, raised 2.6 times as the glow is; so a nebula and the
 * Milky Way behind it compare as their published surface brightnesses do.
 */
export const SB21 = 729 * 2.6 * Math.pow(10, -0.4 * (21 - 7));
/** Linear brightness of a surface of mu mag/arcsec^2. */
export function surfaceBrightness(mu: number): number {
  return SB21 * Math.pow(10, -0.4 * (mu - 21));
}
/**
 * Dark adaptation: how far the exposure may open up when a nebula fills the view (the pipeline's meter ignores
 * light this faint), and what its typical light is brought to.
 */
const ADAPT_MAX = 160;
const ADAPT_TARGET = 0.035;
/** Radius on screen (device px) over which a nebula moves from the full-resolution pass to the reduced one. */
const BIG_PX: [number, number] = [140, 240];
/** Radius on screen (device px) over which the spot gives way to the march. */
const SPOT_PX: [number, number] = [2.2, 4.5];
/** Resolution of the reduced pass relative to the main target, and the most pixels it gets. */
const SOFT_SCALE = 0.5;
const SOFT_MAX_PIXELS = 6e5;
// A nebula the camera comes near is baked into a volume (emission and dust on a grid over its bounding cube):
// marching that is a filtered fetch per step instead of the model's dozen, and only finer detail is added live.
/** Grid of a baked volume, per side. */
const BAKE_N = 128;
/** Layers of the grid baked per frame (each one a 128 x 128 draw of the model). */
const BAKE_LAYERS = 4;
/** Volumes kept at once (8 MB each): the nearest nebulae within BAKE_REACH radii. */
const BAKE_SLOTS = 3;
const BAKE_REACH = 9;
// Close up, a second, finer level: a cube round the camera (in the nebula's frame, so it stays put in space),
// baked again when the camera has moved on by a quarter of it, into the other of two volumes, and swapped in
// once complete.
const FINE_N = 96;
/** Half the side of the fine cube, radii (its grid: 4 times finer than the coarse one's). */
const FINE_HALF = 0.19;
const FINE_LAYERS = 12;
/** Models baked: the ones whose march is expensive (the shells of supernova remnants and planetary nebulae are not). */
const BAKED_MODELS = new Set(['hii', 'refl']);

const STAR_VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aLum;
uniform float uPixelRatio;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = max(length(mv.xyz), 1e-4);
  // As the starfield: apparent magnitude from visual luminosity and distance, compressed the same way.
  float mag = -2.5 * log(aLum / (d * d)) / 2.302585 - 2.74;
  float intensity = clamp(pow(2.512, 0.7 * (3.6 - mag)), 0.0, 9.0) * smoothstep(8.8, 6.0, mag);
  float size = clamp(2.7 - mag * 0.32, 1.0, 3.8) * uPixelRatio;
  vColor = aColor * intensity;
  gl_PointSize = size;
  gl_Position = projectionMatrix * mv;
  if (intensity <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;
const STAR_FRAG = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  gl_FragColor = vec4(vColor * (exp(-r2 * 5.0) - 0.0067), 1.0);
}
`;

const SPOT_VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
varying vec3 vColor;
void main() {
  vColor = aColor;
  gl_PointSize = aSize;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  if (aSize <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;
const SPOT_FRAG = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  gl_FragColor = vec4(vColor * exp(-4.0 * r2), 1.0);
}
`;
/** Integral of exp(-4 r^2) over the unit disc, over pi: the spot's light per unit of its peak and area. */
const SPOT_INTEGRAL = (1 - Math.exp(-4)) / 4;

const UP_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
// Catmull-Rom upscaling in nine bilinear taps: sharper than bilinear, without its blur of the filaments.
const UP_FRAG = /* glsl */ `
uniform sampler2D tNeb;
uniform vec2 uSize;
varying vec2 vUv;
void main() {
  vec2 sp = vUv * uSize;
  vec2 t1 = floor(sp - 0.5) + 0.5;
  vec2 f = sp - t1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 p0 = (t1 - 1.0) / uSize, p3 = (t1 + 2.0) / uSize, p12 = (t1 + w2 / w12) / uSize;
  vec4 c = texture2D(tNeb, vec2(p0.x, p0.y)) * w0.x * w0.y + texture2D(tNeb, vec2(p12.x, p0.y)) * w12.x * w0.y
    + texture2D(tNeb, vec2(p3.x, p0.y)) * w3.x * w0.y + texture2D(tNeb, vec2(p0.x, p12.y)) * w0.x * w12.y
    + texture2D(tNeb, vec2(p12.x, p12.y)) * w12.x * w12.y + texture2D(tNeb, vec2(p3.x, p12.y)) * w3.x * w12.y
    + texture2D(tNeb, vec2(p0.x, p3.y)) * w0.x * w3.y + texture2D(tNeb, vec2(p12.x, p3.y)) * w12.x * w3.y
    + texture2D(tNeb, vec2(p3.x, p3.y)) * w3.x * w3.y;
  c = clamp(c, vec4(0.0), vec4(6e4));
  gl_FragColor = vec4(c.rgb, min(c.a, 1.0));
}
`;

/** Visual bolometric correction (Flower 1996 fit, extended as a Rayleigh-Jeans tail beyond 50,000 K). */
function bolometricCorrection(temp: number): number {
  const t = Math.min(temp, 50000);
  const x = Math.log10(t) - 4;
  let bc = -8.499 * x ** 4 + 13.421 * x ** 3 - 8.131 * x * x - 3.901 * x - 0.438;
  if (temp > 50000) bc -= 7.5 * Math.log10(temp / 50000);
  return Math.min(bc, 0);
}

const FAMILY: Record<NebulaData['look']['model'], Family> = { hii: 'hii', pn: 'pn', snr: 'snr', refl: 'refl' };

interface Item {
  n: NebulaData;
  uniforms: Record<string, THREE.IUniform>;
  full: THREE.Mesh;
  soft: THREE.Mesh;
  fullMat: THREE.ShaderMaterial;
  softMat: THREE.ShaderMaterial;
  /** Mean surface brightness of the model as seen from Sol at unit gain (rgb), once measured. */
  mean: [number, number, number] | null;
  /** Its peak (99.5th percentile of the luminance over the disc), at unit gain. */
  peak: number;
  /** Its typical light: the median over the part of the disc brighter than a twentieth of the peak, at unit gain. */
  typical: number;
  gain: number;
  starStart: number;
  bakeable: boolean;
  bakeMat: THREE.ShaderMaterial | null;
  /** The passes marching the baked volume instead of the model. */
  softBaked: THREE.ShaderMaterial | null;
  fullBaked: THREE.ShaderMaterial | null;
  /** The volume it is baked into, and how many layers of it are done. */
  vol: Vol | null;
  layer: number;
}

interface Fine {
  rt: THREE.WebGL3DRenderTarget;
  /** Centre (shape frame, radii) and owner of what it holds; layers done. */
  centre: THREE.Vector3;
  owner: Item | null;
  layer: number;
}

interface Vol {
  rt: THREE.WebGL3DRenderTarget;
  owner: Item | null;
}

const v = new THREE.Vector3();
const fwd = new THREE.Vector3();

export class Nebulae {
  readonly group = new THREE.Group();
  private readonly softScene = new THREE.Scene();
  private readonly target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  private readonly items: Item[] = [];
  private readonly composite: THREE.Mesh;
  private readonly spots: THREE.Points;
  private readonly stars: THREE.Points;
  private readonly starMat: THREE.ShaderMaterial;
  private readonly starWorld: number[] = [];
  private readonly bakeScene = new THREE.Scene();
  private readonly bakeQuad: THREE.Mesh;
  private readonly bakeCam = new THREE.OrthographicCamera();
  private readonly vols: Vol[] = [];
  private readonly fine: Fine[] = [];
  /** Which of the two fine volumes is shown (the other is the one being baked). */
  private fineShown = -1;
  /** A placeholder volume, so the baked programs can be compiled before anything is baked. */
  private readonly noVol = new THREE.Data3DTexture(new Uint16Array(4), 1, 1, 1);
  private ready = false;
  /** GPU time of the reduced pass, ms (smoothed), where the driver can measure it. */
  gpuMs = 0;
  private timer: { ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }; query: WebGLQuery | null } | null | undefined;
  private warming = false;
  private softScale = SOFT_SCALE;
  /** How far the exposure should open up for the nebulae in view (1: not at all); for Pipeline.darkAdapt. */
  adapt = 1;
  /** Overall brightness, for tuning. */
  gain = 1;
  /** Debug: scale of the step counts, and a switch for the whole layer. */
  stepScale = 1;
  enabled = true;
  /** Debug: march the models themselves even where a baked volume is ready; no finer level round the camera. */
  noBake = false;
  noFine = false;

  constructor() {
    const quad = new THREE.PlaneGeometry(2, 2);
    const starPos: number[] = [], starCol: number[] = [], starLum: number[] = [];
    for (const n of NEBULAE) {
      const family = FAMILY[n.look.model];
      const R = n.radius;
      // Sight frame offsets to the shape frame, in radii.
      const toShape = (x: number, y: number, z: number): [number, number, number] => {
        const s = n.sight, a = n.axes;
        const wx = s[0] * x + s[3] * y + s[6] * z, wy = s[1] * x + s[4] * y + s[7] * z, wz = s[2] * x + s[5] * y + s[8] * z;
        return [(a[0] * wx + a[1] * wy + a[2] * wz) / R, (a[3] * wx + a[4] * wy + a[5] * wz) / R, (a[6] * wx + a[7] * wy + a[8] * wz) / R];
      };
      const maxLum = Math.max(1e-9, ...n.stars.map((s) => s.lum));
      const star = Array.from({ length: MAX_STARS }, (_, i) => {
        const s = n.stars[i];
        return s ? new THREE.Vector4(...toShape(s.x, s.y, s.z), s.lum / maxLum) : new THREE.Vector4();
      });
      const starTint = Array.from({ length: MAX_STARS }, (_, i) => new THREE.Vector3(...(n.stars[i] ? temperatureToRgb(n.stars[i].temp) : [0, 0, 0])));
      const p = Array.from({ length: PARAM_SLOTS }, (_, i) => new THREE.Vector4(...(n.look.p[i] ?? [0, 0, 0, 0])));
      // Structures, the solids first (the shader draws the first uLiveN of them live).
      const KIND = { cloud: 0, solid: 1, reflect: 2, bright: 3, cavity: 4 };
      const prims = [...(n.look.prims ?? [])].sort((x, y) => Number(y.kind === 'solid') - Number(x.kind === 'solid')).slice(0, MAX_PRIMS);
      const pr = Array.from({ length: MAX_PRIMS * 3 }, () => new THREE.Vector4());
      prims.forEach((q, j) => {
        pr[j * 3].set(...q.a, q.ra);
        pr[j * 3 + 1].set(...(q.b ?? q.a), q.rb ?? q.ra);
        pr[j * 3 + 2].set(q.density ?? 1, q.rough ?? 0.3, KIND[q.kind], q.glow ?? 1);
      });
      const live = Math.min(prims.filter((q) => q.kind === 'solid').length, 6);
      const gl = Array.from({ length: MAX_GLOWS * 2 }, () => new THREE.Vector4());
      (n.look.glows ?? []).slice(0, MAX_GLOWS).forEach((g, i) => {
        gl[i * 2].set(...g.at, g.sigma);
        gl[i * 2 + 1].set(...g.color, g.amount);
      });
      const focus = family === 'hii' && n.stars.length ? new THREE.Vector4(star[0].x, star[0].y, star[0].z, 0.12)
        : family === 'pn' ? new THREE.Vector4(0, 0, 0, 0.35) : new THREE.Vector4(0, 0, 0, 50);
      const uniforms: Record<string, THREE.IUniform> = {
        uNoise: { value: nebulaNoise }, uRel: { value: new THREE.Vector3() }, uRadius: { value: R },
        uToLocal: { value: new THREE.Matrix3().set(...(n.axes as [number, number, number, number, number, number, number, number, number])) },
        uEye: { value: new THREE.Vector3() }, uGain: { value: new THREE.Vector3(1, 1, 1) },
        uScale: { value: new THREE.Vector3(...n.look.scale) }, uSeed: { value: n.look.seed }, uVariant: { value: n.look.variant },
        uP: { value: p }, uStar: { value: star }, uStarCol: { value: starTint }, uStarN: { value: Math.min(n.stars.length, MAX_STARS) },
        uFocus: { value: focus }, uDust: { value: 1 },
        uPr: { value: pr }, uPrN: { value: prims.length }, uLiveN: { value: live },
        uGlow: { value: gl }, uGlowN: { value: Math.min(n.look.glows?.length ?? 0, MAX_GLOWS) },
        uFine: { value: this.noVol }, uFineBox: { value: new THREE.Vector4(0, 0, 0, 0) }, uFineVoxel: { value: (2 * FINE_HALF) / FINE_N },
      };
      const make = (): THREE.ShaderMaterial => new THREE.ShaderMaterial({
        vertexShader: NEBULA_VERT, fragmentShader: nebulaFragment(family),
        uniforms: { ...uniforms, uSteps: { value: 32 }, uPixel: { value: 0.001 }, uWeight: { value: 1 } },
        transparent: true, premultipliedAlpha: true, depthTest: false, depthWrite: false, toneMapped: false,
      });
      const fullMat = make(), softMat = make();
      const bakeable = BAKED_MODELS.has(n.look.model) || (n.look.model === 'snr' && n.look.variant === 0);
      const bakeMat = bakeable ? new THREE.ShaderMaterial({
        vertexShader: BAKE_VERT, fragmentShader: nebulaFragment(family, 'bake'),
        uniforms: { ...uniforms, uLayer: { value: 0 }, uN: { value: BAKE_N }, uBox: { value: new THREE.Vector4(0, 0, 0, 1) } },
        blending: THREE.NoBlending, depthTest: false, depthWrite: false, toneMapped: false,
      }) : null;
      const bakedOf = (m: THREE.ShaderMaterial): THREE.ShaderMaterial | null => bakeable ? new THREE.ShaderMaterial({
        vertexShader: NEBULA_VERT, fragmentShader: nebulaFragment(family, 'baked'),
        uniforms: { ...uniforms, uSteps: m.uniforms.uSteps, uPixel: m.uniforms.uPixel, uWeight: m.uniforms.uWeight,
          uVol: { value: this.noVol }, uVoxel: { value: 2 / BAKE_N } },
        transparent: true, premultipliedAlpha: true, depthTest: false, depthWrite: false, toneMapped: false,
      }) : null;
      const softBaked = bakedOf(softMat), fullBaked = bakedOf(fullMat);
      const full = new THREE.Mesh(quad, fullMat);
      const soft = new THREE.Mesh(quad, softMat);
      for (const m of [full, soft]) {
        m.frustumCulled = false;
        m.visible = false;
        m.matrixAutoUpdate = false;
      }
      // Over the Milky Way's glow (which its dust hides), under the stars.
      full.renderOrder = -2.5;
      this.group.add(full);
      this.softScene.add(soft);
      this.items.push({ n, uniforms, full, soft, fullMat, softMat, mean: null, peak: 0, typical: 0, gain: 0, starStart: starLum.length, bakeable, bakeMat, softBaked, fullBaked, vol: null, layer: 0 });
      for (const s of n.stars) {
        // The light the eye sees: luminosity less the bolometric correction.
        starLum.push(s.lum * Math.pow(10, 0.4 * bolometricCorrection(s.temp)));
        starCol.push(...temperatureToRgb(s.temp));
        starPos.push(0, 0, 0);
        const w = { x: 0, y: 0, z: 0 };
        const a = n.sight;
        w.x = n.x + a[0] * s.x + a[3] * s.y + a[6] * s.z;
        w.y = n.y + a[1] * s.x + a[4] * s.y + a[7] * s.z;
        w.z = n.z + a[2] * s.x + a[5] * s.y + a[8] * s.z;
        this.starWorld.push(w.x, w.y, w.z);
      }
    }

    this.noVol.format = THREE.RGBAFormat;
    this.noVol.type = THREE.HalfFloatType;
    this.noVol.needsUpdate = true;
    this.bakeQuad = new THREE.Mesh(quad);
    this.bakeQuad.frustumCulled = false;
    this.bakeScene.add(this.bakeQuad);

    this.composite = new THREE.Mesh(quad, new THREE.ShaderMaterial({
      vertexShader: UP_VERT, fragmentShader: UP_FRAG,
      uniforms: { tNeb: { value: this.target.texture }, uSize: { value: new THREE.Vector2(1, 1) } },
      transparent: true, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      depthTest: false, depthWrite: false, toneMapped: false,
    }));
    this.composite.frustumCulled = false;
    this.composite.renderOrder = -2.45;
    this.composite.visible = false;
    this.group.add(this.composite);

    const n = NEBULAE.length;
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    sg.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    sg.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(n), 1));
    this.spots = new THREE.Points(sg, new THREE.ShaderMaterial({
      vertexShader: SPOT_VERT, fragmentShader: SPOT_FRAG,
      blending: THREE.AdditiveBlending, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    }));
    this.spots.frustumCulled = false;
    this.spots.renderOrder = -2.4;
    this.group.add(this.spots);

    const stg = new THREE.BufferGeometry();
    stg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(starPos), 3));
    stg.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(starCol), 3));
    stg.setAttribute('aLum', new THREE.BufferAttribute(new Float32Array(starLum), 1));
    this.starMat = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT, fragmentShader: STAR_FRAG, uniforms: { uPixelRatio: { value: 1 } },
      blending: THREE.AdditiveBlending, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.stars = new THREE.Points(stg, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = 0.5;
    this.group.add(this.stars);
  }

  /**
   * Compile every program in the background, then measure how bright each model is from Sol (so the spot
   * that stands in for it when tiny carries the same light). Nothing is marched until both are done.
   */
  warm(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    if (this.warming) return;
    this.warming = true;
    const all = [...this.items.flatMap((it) => [it.full, it.soft]), this.composite, this.spots, this.stars];
    const was = all.map((o) => o.visible);
    all.forEach((o) => { o.visible = true; });
    // The programs are compiled for the kind of target they draw into (linear, no tone mapping).
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    const a = renderer.compileAsync(this.group, camera);
    const b = renderer.compileAsync(this.softScene, camera);
    // And the baking and baked programs, one stand-in each.
    const extra = new THREE.Scene();
    for (const it of this.items) {
      for (const m of [it.bakeMat, it.softBaked, it.fullBaked]) {
        if (!m) continue;
        const mesh = new THREE.Mesh(this.bakeQuad.geometry, m);
        mesh.frustumCulled = false;
        extra.add(mesh);
      }
    }
    const c = renderer.compileAsync(extra, camera);
    renderer.setRenderTarget(prev);
    all.forEach((o, i) => { o.visible = was[i]; });
    void Promise.all([a, b, c]).then(() => this.measure(renderer));
  }

  private async measure(renderer: THREE.WebGLRenderer): Promise<void> {
    const size = 96;
    const rt = new THREE.WebGLRenderTarget(size, size, { type: THREE.FloatType, depthBuffer: false });
    const scene = new THREE.Scene();
    const half = Math.asin(1 / 4);
    const fov = 2 * half * 1.08;
    const cam = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(fov), 1, 0.001, 1e9);
    const pix = new Float32Array(size * size * 4);
    const prev = renderer.getRenderTarget();
    const clear = renderer.getClearAlpha();
    for (const it of this.items) {
      const n = it.n;
      // From the side of Sol, four radii out.
      const s = n.sight;
      const D = 4 * n.radius;
      const camPos = { x: n.x + s[6] * D, y: n.y + s[7] * D, z: n.z + s[8] * D };
      // (On a copy of the material: frames are drawn between the reads, with the shared uniforms as they need them.)
      const mat = it.fullMat.clone();
      const u = mat.uniforms;
      // (Not a copy of the noise: the one already on the GPU.)
      u.uNoise.value = nebulaNoise;
      this.setFrame(it, camPos, u);
      u.uSteps.value = 64;
      u.uPixel.value = fov / size;
      u.uWeight.value = 1;
      (u.uGain.value as THREE.Vector3).set(1, 1, 1);
      cam.position.set(0, 0, 0);
      cam.lookAt(v.set(-s[6], -s[7], -s[8]));
      cam.updateMatrixWorld();
      const mesh = new THREE.Mesh(it.full.geometry, mat);
      mesh.frustumCulled = false;
      scene.add(mesh);
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(scene, cam);
      scene.remove(mesh);
      mat.dispose();
      await renderer.readRenderTargetPixelsAsync(rt, 0, 0, size, size, pix);
      const sum = [0, 0, 0];
      const pixel = (fov / size) ** 2;
      const lum: number[] = [];
      for (let i = 0; i < size * size; i++) {
        for (let c = 0; c < 3; c++) sum[c] += pix[i * 4 + c];
        lum.push(0.2126 * pix[i * 4] + 0.7152 * pix[i * 4 + 1] + 0.0722 * pix[i * 4 + 2]);
      }
      lum.sort((x, y) => x - y);
      it.peak = lum[Math.floor(lum.length * 0.995)];
      const lit = lum.filter((v) => v > it.peak * 0.05);
      it.typical = lit.length ? lit[Math.floor(lit.length * 0.5)] : it.peak;
      const disc = 2 * Math.PI * (1 - Math.cos(half));
      it.mean = [sum[0] * pixel / disc, sum[1] * pixel / disc, sum[2] * pixel / disc];
    }
    renderer.setRenderTarget(prev);
    renderer.setClearColor(0x000000, clear);
    rt.dispose();
    // Calibrated on the peak, to the published surface brightness as seen from Sol, through the dust in front
    // (the published extinction); nearer, there is less of it.
    for (const it of this.items) it.gain = it.peak > 0 ? surfaceBrightness(it.n.sb) / (it.peak * Math.pow(10, -0.4 * it.n.av)) : 0;
    this.ready = true;
  }

  /** Shape-frame uniforms for a camera at `cam` (universe, ly). */
  private setFrame(it: Item, cam: { x: number; y: number; z: number }, u: Record<string, THREE.IUniform> = it.uniforms): void {
    const n = it.n, a = n.axes;
    const rx = n.x - cam.x, ry = n.y - cam.y, rz = n.z - cam.z;
    (u.uRel.value as THREE.Vector3).set(rx, ry, rz);
    (u.uEye.value as THREE.Vector3).set(
      -(a[0] * rx + a[1] * ry + a[2] * rz) / n.radius,
      -(a[3] * rx + a[4] * ry + a[5] * rz) / n.radius,
      -(a[6] * rx + a[7] * ry + a[8] * rz) / n.radius,
    );
  }

  /** Measured mean surface brightness from Sol (linear, rgb, before extinction), or null before measuring. */
  meanBrightness(id: number): [number, number, number] | null {
    const it = this.items[id];
    return it.mean ? [it.mean[0] * it.gain, it.mean[1] * it.gain, it.mean[2] * it.gain] : null;
  }

  /**
   * cam: universe position (ly); camera: the background camera, already turned for this frame;
   * pixelsPerRadian / pixelRatio: of the main target.
   */
  update(cam: { x: number; y: number; z: number }, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer, pixelsPerRadian: number, pixelRatio: number): void {
    if (!this.warming) this.warm(renderer, camera);
    fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const edge = Math.atan(tanY * Math.hypot(1, camera.aspect));
    const sp = this.spots.geometry.getAttribute('position') as THREE.BufferAttribute;
    const sc = this.spots.geometry.getAttribute('aColor') as THREE.BufferAttribute;
    const ss = this.spots.geometry.getAttribute('aSize') as THREE.BufferAttribute;
    let anySoft = false;
    let adapt = 1;
    let bigOnScreen = 0;
    for (const it of this.items) {
      const n = it.n;
      const rx = n.x - cam.x, ry = n.y - cam.y, rz = n.z - cam.z;
      const d = Math.hypot(rx, ry, rz);
      const inside = d < n.radius * 1.3;
      const ang = d > n.radius ? Math.asin(n.radius / d) : Math.PI / 2;
      const px = inside ? 1e5 : ang * pixelsPerRadian;
      const off = Math.acos(THREE.MathUtils.clamp((rx * fwd.x + ry * fwd.y + rz * fwd.z) / d, -1, 1));
      const inView = inside || off - ang < edge + 0.01;
      // Interstellar dust between the camera and the nebula: all of it from Sol, less from nearer.
      const av = n.av * Math.min(d / n.dist, 1);
      // (Its colour as in a photograph balanced for the dust: only part of the reddening is kept.)
      const ext = [0.97, 1.0, 1.04].map((c) => Math.pow(10, -0.4 * av * c));
      const g = it.gain * this.gain;
      // The eye opens up to a nebula as it comes to fill the view, until its typical light reads as a night scene.
      if (inView && it.typical > 0) {
        const cover = inside ? 1 : Math.min(1, (ang / edge) ** 2);
        const light = it.typical * g * (0.2126 * ext[0] + 0.7152 * ext[1] + 0.0722 * ext[2]);
        const want = THREE.MathUtils.clamp(ADAPT_TARGET / Math.max(light, 1e-9), 1, ADAPT_MAX);
        adapt = Math.max(adapt, 1 + (want - 1) * THREE.MathUtils.smoothstep(cover, 0.1, 0.6));
      }
      const spotW = 1 - THREE.MathUtils.smoothstep(px, SPOT_PX[0], SPOT_PX[1]);
      const marchW = this.ready && inView && this.enabled ? 1 - spotW : 0;
      const big = inside ? 1 : THREE.MathUtils.smoothstep(px, BIG_PX[0], BIG_PX[1]);
      const wFull = marchW * (1 - big), wSoft = marchW * big;
      it.full.visible = wFull > 0.002;
      it.soft.visible = wSoft > 0.002;
      if (it.full.visible || it.soft.visible) {
        this.setFrame(it, cam);
        (it.uniforms.uGain.value as THREE.Vector3).set(g * ext[0], g * ext[1], g * ext[2]);
        // From afar the galaxy's own dust model already darkens the band there: a nebula's dust shows only as it grows.
        it.uniforms.uDust.value = inside ? 1 : 0.3 + 0.7 * THREE.MathUtils.smoothstep(px, 40, 400);
      }
      if (it.full.visible) {
        const u = it.fullMat.uniforms;
        u.uWeight.value = wFull;
        u.uPixel.value = 1 / pixelsPerRadian;
        u.uSteps.value = Math.round(THREE.MathUtils.clamp(20 + px * 0.1, 24, 48) * (it.full.material === it.fullBaked ? 1.5 : 1) * this.stepScale);
      }
      if (it.soft.visible) {
        anySoft = true;
        const u = it.softMat.uniforms;
        u.uWeight.value = wSoft;
        u.uPixel.value = 1 / (pixelsPerRadian * this.softScale);
        // Marching the baked volume is cheap: more steps, less grain.
        // Marching the baked volume is cheap; the model itself (until its volume is baked) is not: fewer steps.
        const baked = it.soft.material === it.softBaked;
        u.uSteps.value = Math.round((baked ? (inside ? 72 : 64) : it.softBaked ? 28 : 56) * this.stepScale);
        bigOnScreen = Math.max(bigOnScreen, inside ? 1 : Math.min(1, (ang / edge) ** 2));
      }
      // The spot: the same light, gathered.
      const i = n.id;
      if (spotW > 0.002 && it.mean && inView) {
        const sizePx = Math.max(2.6 * pixelRatio, 2.4 * px);
        const flux = Math.PI * ang * ang * pixelsPerRadian * pixelsPerRadian;
        const peak = (flux * spotW) / (SPOT_INTEGRAL * Math.PI * (sizePx / 2) ** 2);
        sp.setXYZ(i, rx, ry, rz);
        sc.setXYZ(i, it.mean[0] * g * ext[0] * peak, it.mean[1] * g * ext[1] * peak, it.mean[2] * g * ext[2] * peak);
        ss.setX(i, sizePx);
      } else {
        ss.setX(i, 0);
      }
    }
    sp.needsUpdate = sc.needsUpdate = ss.needsUpdate = true;
    this.spots.visible = true;

    // (Faster when a nebula fills the view and its model is being marched meanwhile.)
    if (this.ready) this.bake(cam, renderer, bigOnScreen > 0.3 ? BAKE_LAYERS * 4 : BAKE_LAYERS);
    for (const it of this.items) {
      if (!it.softBaked || !it.fullBaked) continue;
      const done = !this.noBake && !!it.vol && it.layer >= BAKE_N;
      it.soft.material = done ? it.softBaked : it.softMat;
      it.full.material = done ? it.fullBaked : it.fullMat;
    }
    this.adapt = adapt;

    // Stars, camera-relative in doubles.
    const pos = this.stars.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setXYZ(i, this.starWorld[i * 3] - cam.x, this.starWorld[i * 3 + 1] - cam.y, this.starWorld[i * 3 + 2] - cam.z);
    pos.needsUpdate = true;
    this.starMat.uniforms.uPixelRatio.value = pixelRatio;

    // The reduced pass, drawn now into its own target; the composite lays it over the sky.
    this.composite.visible = anySoft;
    if (anySoft) {
      const scale = Math.min(SOFT_SCALE, Math.sqrt(SOFT_MAX_PIXELS / (window.innerWidth * window.innerHeight)) / pixelRatio);
      const w = Math.max(1, Math.round(window.innerWidth * pixelRatio * scale));
      const h = Math.max(1, Math.round(window.innerHeight * pixelRatio * scale));
      this.softScale = scale;
      if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
      (this.composite.material as THREE.ShaderMaterial).uniforms.uSize.value.set(w, h);
      const prev = renderer.getRenderTarget();
      const clear = renderer.getClearAlpha();
      renderer.setRenderTarget(this.target);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      const gl = renderer.getContext() as WebGL2RenderingContext;
      if (this.timer === undefined) {
        const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
        this.timer = ext ? { ext, query: null } : null;
      }
      const timer = this.timer;
      let started = false;
      if (timer) {
        if (timer.query && gl.getQueryParameter(timer.query, gl.QUERY_RESULT_AVAILABLE)) {
          if (!gl.getParameter(timer.ext.GPU_DISJOINT_EXT)) this.gpuMs += (gl.getQueryParameter(timer.query, gl.QUERY_RESULT) / 1e6 - this.gpuMs) * 0.2;
          gl.deleteQuery(timer.query);
          timer.query = null;
        }
        if (!timer.query) {
          timer.query = gl.createQuery();
          gl.beginQuery(timer.ext.TIME_ELAPSED_EXT, timer.query!);
          started = true;
        }
      }
      renderer.render(this.softScene, camera);
      if (started) gl.endQuery(timer!.ext.TIME_ELAPSED_EXT);
      renderer.setClearColor(0x000000, clear);
      renderer.setRenderTarget(prev);
    }
  }

  /** Bake the nearest nebulae into volumes, a few layers per frame; their reduced pass marches the volume once done. */
  private bake(cam: { x: number; y: number; z: number }, renderer: THREE.WebGLRenderer, layers: number): void {
    const span = (it: Item): number => Math.hypot(it.n.x - cam.x, it.n.y - cam.y, it.n.z - cam.z) / it.n.radius;
    const want = this.items.filter((it) => it.bakeable && span(it) < BAKE_REACH).sort((a, b) => span(a) - span(b)).slice(0, BAKE_SLOTS);
    for (const it of want) {
      if (it.vol) continue;
      let vol = this.vols.find((v) => !v.owner || !want.includes(v.owner));
      if (!vol && this.vols.length < BAKE_SLOTS) {
        const rt = new THREE.WebGL3DRenderTarget(BAKE_N, BAKE_N, BAKE_N, { type: THREE.HalfFloatType, depthBuffer: false });
        rt.texture.minFilter = rt.texture.magFilter = THREE.LinearFilter;
        rt.texture.wrapS = rt.texture.wrapT = rt.texture.wrapR = THREE.ClampToEdgeWrapping;
        vol = { rt, owner: null };
        this.vols.push(vol);
      }
      if (!vol) break;
      if (vol.owner) {
        // Taken from a nebula now further away: it goes back to marching the model.
        vol.owner.vol = null;
      }
      vol.owner = it;
      it.vol = vol;
      it.layer = 0;
    }
    const job = want.find((it) => it.vol && it.layer < BAKE_N);
    if (job) {
      const prev = renderer.getRenderTarget();
      this.bakeQuad.material = job.bakeMat!;
      const u = job.bakeMat!.uniforms;
      u.uN.value = BAKE_N;
      (u.uBox.value as THREE.Vector4).set(0, 0, 0, 1);
      for (let i = 0; i < layers && job.layer < BAKE_N; i++, job.layer++) {
        u.uLayer.value = job.layer;
        renderer.setRenderTarget(job.vol!.rt, job.layer);
        renderer.render(this.bakeScene, this.bakeCam);
      }
      renderer.setRenderTarget(prev);
      if (job.layer >= BAKE_N) {
        job.softBaked!.uniforms.uVol.value = job.vol!.rt.texture;
        job.fullBaked!.uniforms.uVol.value = job.vol!.rt.texture;
      }
      return;
    }
    this.bakeFine(renderer, !this.noFine && want[0] && span(want[0]) < 1.15 && want[0].layer >= BAKE_N ? want[0] : null);
  }

  /** The finer level round the camera, for the nebula it is in (null: none). */
  private bakeFine(renderer: THREE.WebGLRenderer, it: Item | null): void {
    const shown = this.fineShown >= 0 ? this.fine[this.fineShown] : null;
    if (!it) {
      if (shown?.owner) (shown.owner.uniforms.uFineBox.value as THREE.Vector4).w = 0;
      this.fineShown = -1;
      return;
    }
    if (this.fine.length === 0) {
      for (let i = 0; i < 2; i++) {
        const rt = new THREE.WebGL3DRenderTarget(FINE_N, FINE_N, FINE_N, { type: THREE.HalfFloatType, depthBuffer: false });
        rt.texture.minFilter = rt.texture.magFilter = THREE.LinearFilter;
        rt.texture.wrapS = rt.texture.wrapT = rt.texture.wrapR = THREE.ClampToEdgeWrapping;
        this.fine.push({ rt, centre: new THREE.Vector3(1e9, 0, 0), owner: null, layer: 0 });
      }
    }
    // Where the camera is, in the nebula's frame, snapped to a quarter of the cube.
    const eye = it.uniforms.uEye.value as THREE.Vector3;
    const cell = FINE_HALF / 2;
    const want = v.set(Math.round(eye.x / cell) * cell, Math.round(eye.y / cell) * cell, Math.round(eye.z / cell) * cell);
    if (shown && shown.owner === it && shown.layer >= FINE_N && shown.centre.distanceTo(want) < 1e-6) return;
    const back = this.fine[this.fineShown === 0 ? 1 : 0];
    if (back.owner !== it || back.centre.distanceTo(want) > 1e-6) {
      back.owner = it;
      back.centre.copy(want);
      back.layer = 0;
    }
    const prev = renderer.getRenderTarget();
    this.bakeQuad.material = it.bakeMat!;
    const u = it.bakeMat!.uniforms;
    u.uN.value = FINE_N;
    (u.uBox.value as THREE.Vector4).set(back.centre.x, back.centre.y, back.centre.z, FINE_HALF);
    for (let i = 0; i < FINE_LAYERS && back.layer < FINE_N; i++, back.layer++) {
      u.uLayer.value = back.layer;
      renderer.setRenderTarget(back.rt, back.layer);
      renderer.render(this.bakeScene, this.bakeCam);
    }
    renderer.setRenderTarget(prev);
    u.uN.value = BAKE_N;
    (u.uBox.value as THREE.Vector4).set(0, 0, 0, 1);
    if (back.layer >= FINE_N) {
      if (shown?.owner && shown.owner !== it) (shown.owner.uniforms.uFineBox.value as THREE.Vector4).w = 0;
      this.fineShown = this.fine.indexOf(back);
      it.uniforms.uFine.value = back.rt.texture;
      (it.uniforms.uFineBox.value as THREE.Vector4).set(back.centre.x, back.centre.y, back.centre.z, FINE_HALF);
    }
  }

  /** Where a nebula's centre is relative to a point, and whether a view direction falls on it. */
  static hit(n: NebulaData, cam: { x: number; y: number; z: number }, dir: THREE.Vector3): number {
    v.set(n.x - cam.x, n.y - cam.y, n.z - cam.z);
    const d = v.length();
    if (d < n.radius) return Infinity;
    const apparent = Math.asin(Math.min(n.radius / d, 1));
    const ang = v.angleTo(dir);
    const reach = Math.max(apparent * 0.8, 0.01);
    return ang < reach ? ang / reach : Infinity;
  }
}
