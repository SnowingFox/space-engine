import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { GALAXY_GLSL, galaxyKnotUniforms, galaxyNoise } from './galaxyShader';
import { galaxyParams, NEAR_GALAXIES, type NearGalaxy } from './galaxyVolume';
import { probeRenderer } from './probe';

// The galaxies around the camera, marched on screen every frame from where the camera is: their stars and
// dust are fixed in the galaxy's own frame like the stars of the starfield, and only the perspective changes.
// A march fine enough to show the dust would cost several frames, so each frame marches a fraction of it, at
// a reduced resolution, with its samples placed elsewhere along each ray and within each pixel; the frames are
// averaged where the same piece of sky was in the last ones (found from where along the ray its light and
// dust are, so near clouds are followed as they sweep past and far ones as they creep).

const MARCH_VERT = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const BLUE = 64;

/**
 * A tile of blue noise (void and cluster, Ulichney 1993): values 0..1 whose neighbours are as different as can be.
 * Built once at start, a few milliseconds.
 */
function blueNoise(n: number): THREE.DataTexture {
  const N = n * n, R = 4, sigma = 1.6;
  const kernel: number[] = [];
  for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) kernel.push(Math.exp(-(x * x + y * y) / (2 * sigma * sigma)));
  const on = new Uint8Array(N), energy = new Float32Array(N), rank = new Float32Array(N);
  const splat = (i: number, sign: number): void => {
    const px = i % n, py = (i / n) | 0;
    let k = 0;
    for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++, k++) energy[((py + y + n) % n) * n + ((px + x + n) % n)] += sign * kernel[k];
  };
  const extreme = (want: number, max: boolean): number => {
    let best = -1, be = max ? -Infinity : Infinity;
    for (let i = 0; i < N; i++) if (on[i] === want && (max ? energy[i] > be : energy[i] < be)) { be = energy[i]; best = i; }
    return best;
  };
  // (Deterministic: the same tile every run.)
  let seed = 12345;
  const rand = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const ones = Math.floor(N * 0.1);
  for (let k = 0; k < ones; ) { const i = Math.floor(rand() * N); if (!on[i]) { on[i] = 1; splat(i, 1); k++; } }
  // Even out the initial pattern: the tightest cluster moves to the largest void until it is already there.
  for (let it = 0; it < N; it++) {
    const c = extreme(1, true);
    on[c] = 0; splat(c, -1);
    const v = extreme(0, false);
    on[v] = 1; splat(v, 1);
    if (v === c) break;
  }
  const initial = on.slice(), start = energy.slice();
  // Ranks below the initial count: remove tightest clusters.
  for (let r = ones - 1; r >= 0; r--) { const c = extreme(1, true); on[c] = 0; splat(c, -1); rank[c] = r; }
  on.set(initial); energy.set(start);
  // And above it: fill the largest voids.
  for (let r = ones; r < N; r++) { const v = extreme(0, false); on[v] = 1; splat(v, 1); rank[v] = r; }
  const data = new Float32Array(N);
  for (let i = 0; i < N; i++) data[i] = (rank[i] + 0.5) / N;
  const t = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

const MARCH_FRAG = /* glsl */ `
#define MARCH_DEPTH
// (Detail finer than a step averages out over the frames, but only as far as there are frames to average.)
#define STEP_LIMIT
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
uniform mat4 uInvProj;
uniform mat3 uView;      // camera axes to the universe's
uniform vec2 uSize;
uniform vec2 uJitter;    // where in its pixel this frame's ray goes, pixels
uniform float uIndex;    // frame number
uniform int uSteps;
uniform float uPixel;    // radians per pixel of the detail resolved
uniform sampler2D uBlue; // blue noise, ${BLUE} x ${BLUE}
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oDepth;

void main() {
  vec2 ndc = (gl_FragCoord.xy + uJitter) / uSize * 2.0 - 1.0;
  vec4 v = uInvProj * vec4(ndc, -1.0, 1.0);
  vec3 dir = normalize(uView * (v.xyz / v.w));
  // Where along its steps each ray samples: blue noise, so that neighbouring pixels sample far apart (what is
  // left of the march's grain is fine, and the filters reading it average it out), moved on every frame by the
  // golden ratio, so that each pixel goes through all of them in turn. (A regular pattern of offsets shows as a
  // hatching; the tile is shifted every frame so that it does not show either.)
  vec2 tile = mod(gl_FragCoord.xy + floor(vec2(uIndex * 37.0, uIndex * 61.0)), ${BLUE}.0);
  float jitter = fract(texelFetch(uBlue, ivec2(tile), 0).r + uIndex * 0.6180340);
  vec4 sum = vec4(0.0);
  for (int i = 0; i < ${NEAR_GALAXIES}; i++) {
    if (i >= uCount) break;
    vec4 g = galaxyMarch(uEye[i], uFrame[i] * dir, uA[i], uB[i], uC[i], uD[i], uE[i], uF[i], uG[i], uSteps, jitter, uPixel) * uWeight[i];
    sum += (1.0 - sum.a) * g;
  }
  oColor = sum;
  float dl = gWL > 0.0 ? gDL / gWL : 16.0;
  float da = gWA > 0.0 ? gDA / gWA : dl;
  oDepth = vec4(mix(dl, da, smoothstep(0.02, 0.25, sum.a)), 0.0, 0.0, 1.0);
}
`;

const RESOLVE_FRAG = /* glsl */ `
uniform sampler2D tCur;
uniform sampler2D tDepth;
uniform sampler2D tHist;
uniform mat4 uInvProj;
uniform mat3 uView;
uniform mat4 uPrev;      // the last frame's projection and view (camera at the origin)
uniform vec3 uDelta;     // the camera's move since then, universe axes, ly
uniform vec2 uSize;      // pixels of the history
uniform vec2 uCurSize;   // and of the march
uniform vec2 uJitter;    // where in their pixels this frame's march samples are, march pixels
uniform float uBlend;    // weight of this frame's march at rest: 1 starts again
uniform float uBlendMoving;
uniform float uBlendFast;
uniform float uClamp;
uniform float uSharp;    // how far (standard deviations of this frame's neighbourhood) the history may stray from it
varying vec2 vUv;

// History read with a Catmull-Rom filter: bilinear reads would blur it a little more every frame it moves.
vec4 catmull(sampler2D t, vec2 uv) {
  vec2 pos = uv * uSize, c = floor(pos - 0.5) + 0.5, f = pos - c;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f)), w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f)), w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2, o12 = w2 / w12;
  vec2 p0 = (c - 1.0) / uSize, p3 = (c + 2.0) / uSize, p12 = (c + o12) / uSize;
  vec4 r = texture2D(t, vec2(p12.x, p0.y)) * w12.x * w0.y
    + texture2D(t, vec2(p0.x, p12.y)) * w0.x * w12.y + texture2D(t, p12) * w12.x * w12.y + texture2D(t, vec2(p3.x, p12.y)) * w3.x * w12.y
    + texture2D(t, vec2(p12.x, p3.y)) * w12.x * w3.y;
  float n = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(r / n, vec4(0.0));
}

void main() {
  // This frame's march sample nearest to the pixel, and how near it is (the samples move about within
  // their pixels from frame to frame, and the history has more pixels than the march: each of its pixels
  // takes in a frame's march where a sample came close).
  vec2 m = vUv * uCurSize;
  vec2 i = floor(m - uJitter);
  vec2 d = m - (i + 0.5 + uJitter);
  vec2 cuv = (i + 0.5) / uCurSize;
  vec4 c = texture2D(tCur, cuv);
  // (In pixels of the history: a sample counts for the history pixel it falls in, little for its neighbours,
  // so that what is averaged over the frames is as sharp as the history.)
  vec2 dh = d * uSize / uCurSize;
  float near = exp(-dot(dh, dh) * uSharp);
  vec4 soft = texture2D(tCur, vUv - uJitter / uCurSize);
  if (uBlend >= 1.0) { gl_FragColor = soft; return; }
  // The spread of this frame's march around the pixel: history outside it belongs to something else.
  vec4 m1 = vec4(0.0), m2 = vec4(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec4 s = texture2D(tCur, cuv + vec2(float(x), float(y)) / uCurSize);
    m1 += s; m2 += s * s;
  }
  m1 /= 9.0;
  vec4 sigma = sqrt(max(m2 / 9.0 - m1 * m1, 0.0));
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 v = uInvProj * vec4(ndc, -1.0, 1.0);
  vec3 dir = normalize(uView * (v.xyz / v.w));
  float depth = exp(texture2D(tDepth, vUv - uJitter / uCurSize).r);
  vec4 clip = uPrev * vec4(dir * depth + uDelta, 1.0);
  vec2 puv = clip.xy / clip.w * 0.5 + 0.5;
  // (Where there is no history, newly in view or uncovered, this frame's march alone would show its grain:
  // there it is smoothed over its neighbours instead, as the frames would have.)
  vec4 calm = mix(soft, m1, 0.6);
  if (clip.w <= 0.0 || any(lessThan(puv, vec2(0.0))) || any(greaterThan(puv, vec2(1.0)))) { gl_FragColor = calm; return; }
  // (Where the sky has not moved, the history is read as it is: a read even a hair off the pixel centre would
  // blur it a little every frame, and over the hundreds of frames averaged at rest that adds up.)
  vec2 shiftPx = (puv - vUv) * uSize;
  vec4 h0 = dot(shiftPx, shiftPx) < 0.03 * 0.03 ? texelFetch(tHist, ivec2(gl_FragCoord.xy), 0) : catmull(tHist, puv);
  vec4 h = clamp(h0, m1 - uClamp * sigma, m1 + uClamp * sigma);
  float lost = smoothstep(0.5, 2.0, length(h0 - h) / max(length(sigma) * 3.0, 1e-6));
  // At rest many frames are averaged, the march's grain gone; moving, fewer, so nothing trails behind.
  // (Moving, every pixel of the history is read anew anyway: this frame's march is taken in as it falls on the
  // pixel, smoothly, and not only where a sample happens to be near.)
  float shift = length(shiftPx);
  float moving = smoothstep(0.3, 3.0, shift);
  // (The further the history is carried, the more each read of it blurs: a fast move takes in more of the frame.)
  float w = mix(uBlend * near, mix(uBlendMoving, uBlendFast, smoothstep(3.0, 20.0, shift)), moving);
  vec4 cur = mix(c, soft, moving);
  gl_FragColor = mix(mix(h, calm, lost), cur, w);
}
`;

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const SHOW_FRAG = /* glsl */ `
uniform sampler2D tHost;
uniform sampler2D tSoft;   // (unused: marks this as a screen-space layer, which the lens's cube map leaves out)
uniform vec2 uSize;
uniform mat4 uInvProj;
uniform mat3 uView;
uniform float uGain;
uniform float uCover;
uniform float uGrain;
uniform float uGrainAmp;
varying vec2 vUv;

float hash3(vec3 p) {
  p = fract(p * vec3(443.897, 441.423, 437.195));
  p += dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}

// Read with a Catmull-Rom filter: sharper than bilinear, without its blocks.
vec4 catmull(sampler2D t, vec2 uv) {
  vec2 pos = uv * uSize, c = floor(pos - 0.5) + 0.5, f = pos - c;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f)), w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f)), w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2, o12 = w2 / w12;
  vec2 p0 = (c - 1.0) / uSize, p3 = (c + 2.0) / uSize, p12 = (c + o12) / uSize;
  vec4 r = texture2D(t, vec2(p12.x, p0.y)) * w12.x * w0.y
    + texture2D(t, vec2(p0.x, p12.y)) * w0.x * w12.y + texture2D(t, p12) * w12.x * w12.y + texture2D(t, vec2(p3.x, p12.y)) * w3.x * w12.y
    + texture2D(t, vec2(p12.x, p3.y)) * w12.x * w3.y;
  float n = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(r / n, vec4(0.0));
}

void main() {
  vec4 c = catmull(tHost, vUv);
  vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, -1.0, 1.0);
  vec3 d = normalize(uView * (v.xyz / v.w));
  // The glow of a galaxy from inside is stars too faint to see one by one, but not so many that
  // they blur into fog: a fine grain of them, a little coarser than the pixels.
  float s = hash3(floor(d * uGrain * 1.4));
  float grain = mix(1.0, 0.84 + 0.65 * s * s * s * s, uGrainAmp);
  gl_FragColor = vec4(c.rgb * uGain * grain, c.a * uCover);
}
`;

// Halton (2, 3): where in its pixel each frame's ray goes.
const JITTER = Array.from({ length: 16 }, (_, i) => {
  const h = (b: number): number => { let f = 1, r = 0, n = i + 1; while (n > 0) { f /= b; r += f * (n % b); n = Math.floor(n / b); } return r; };
  return [h(2) - 0.5, h(3) - 0.5];
});

/**
 * March resolution relative to the screen's (CSS pixels), steps per ray (within min..max), how much finer the
 * history is, and the weight of a frame in it, at rest and moving.
 */
const HOST = { res: 0.25, steps: 72, minSteps: 32, maxSteps: 96, up: 2, blend: 0.08, rest: 0.002, moving: 0.3, fast: 0.3, clamp: 1.5, sharp: 2, limit: 8, limitFast: 2, grain: 1 };
/**
 * The steps follow the frame time: fewer as soon as frames run late, more again slowly while they keep to
 * 60 Hz. (Fewer steps leave more grain in each frame's march, not a different picture: what the frames average
 * to is the same.) They give way before the pipeline would lower the resolution of everything.
 */
const BUDGET = { lateMs: 17.9, cut: 0.85, grow: 1.004, holdMs: 1500 };

export class GalaxyHost {
  readonly mesh: THREE.Mesh;
  private readonly march: THREE.ShaderMaterial;
  private readonly marchQuad: FullScreenQuad;
  private readonly resolve: THREE.ShaderMaterial;
  private readonly resolveQuad: FullScreenQuad;
  private readonly show: THREE.ShaderMaterial;
  private cur = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, count: 2, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  /**
   * The history, in full floats where they can be filtered: at rest each frame adds under 1 % of itself, which
   * half floats round away unevenly (the average then settles a few per cent off what it converges to).
   */
  private hist: THREE.WebGLRenderTarget[] = [];
  private index = 0;
  private fresh = true;
  private readonly prevProj = new THREE.Matrix4();
  private readonly prevCam = new THREE.Vector3();
  private prevId = -1;
  private readonly view = new THREE.Matrix4();
  private lastTime = 0;
  private frameMs = 16.7;
  private holdUntil = 0;
  /** Frames the view has held still: the average then takes in ever more of them, until the grain is gone. */
  private still = 0;
  /** How fast near clouds sweep across the screen, history pixels per frame, smoothed. */
  private sweep = 0;
  private readonly prevQuat = new THREE.Quaternion();
  /** (Tuning: march resolution, steps and averaging.) */
  readonly cfg = HOST;
  /** (For measuring: where the galaxy on screen was marched from, the first galaxy's frame.) */
  shownEye: number[] | null = null;

  constructor() {
    const vec4s = (): THREE.Vector4[] => Array.from({ length: NEAR_GALAXIES }, () => new THREE.Vector4());
    this.march = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: MARCH_VERT,
      fragmentShader: MARCH_FRAG,
      uniforms: {
        uA: { value: vec4s() }, uB: { value: vec4s() }, uC: { value: vec4s() }, uD: { value: vec4s() }, uE: { value: vec4s() }, uF: { value: vec4s() }, uG: { value: vec4s() },
        uFrame: { value: Array.from({ length: NEAR_GALAXIES }, () => new THREE.Matrix3()) },
        uEye: { value: Array.from({ length: NEAR_GALAXIES }, () => new THREE.Vector3()) },
        uWeight: { value: new Array(NEAR_GALAXIES).fill(0) },
        uCount: { value: 0 },
        uInvProj: { value: new THREE.Matrix4() }, uView: { value: new THREE.Matrix3() },
        uSize: { value: new THREE.Vector2(1, 1) }, uJitter: { value: new THREE.Vector2() }, uIndex: { value: 0 },
        uSteps: { value: HOST.steps }, uPixel: { value: 0.001 }, uSettle: { value: 1 }, uStepLimit: { value: 8 },
        uNoise: { value: galaxyNoise }, uBlue: { value: blueNoise(BLUE) }, ...galaxyKnotUniforms,
      },
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    this.marchQuad = new FullScreenQuad(this.march);
    this.resolve = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: RESOLVE_FRAG,
      uniforms: {
        tCur: { value: null }, tDepth: { value: null }, tHist: { value: null },
        uInvProj: { value: new THREE.Matrix4() }, uView: { value: new THREE.Matrix3() }, uPrev: { value: new THREE.Matrix4() },
        uDelta: { value: new THREE.Vector3() }, uSize: { value: new THREE.Vector2(1, 1) }, uCurSize: { value: new THREE.Vector2(1, 1) },
        uJitter: { value: new THREE.Vector2() }, uBlend: { value: 1 }, uBlendMoving: { value: 0.25 }, uBlendFast: { value: 0.3 }, uClamp: { value: 1.5 }, uSharp: { value: 2 },
      },
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    this.resolveQuad = new FullScreenQuad(this.resolve);
    this.show = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: SHOW_FRAG,
      uniforms: {
        tHost: { value: null }, tSoft: { value: null }, uSize: { value: new THREE.Vector2(1, 1) },
        uInvProj: { value: new THREE.Matrix4() }, uView: { value: new THREE.Matrix3() },
        uGain: { value: 1 }, uCover: { value: 1 }, uGrain: { value: 1000 }, uGrainAmp: { value: 1 },
      },
      transparent: true, premultipliedAlpha: true, depthTest: false, depthWrite: false,
    });
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.mesh = new THREE.Mesh(tri, this.show);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** This frame's march as shown (premultiplied light, opacity) and where along the rays it is (log ly); null when not drawn. */
  output(): { color: THREE.Texture; depth: THREE.Texture } | null {
    if (!this.mesh.visible) return null;
    return { color: this.show.uniforms.tHost.value as THREE.Texture, depth: this.cur.textures[1] };
  }

  /**
   * Tuning aid (scripts/gerror.mjs): how far the galaxy on screen is from what it converges to for this very
   * view: the history against `passes` marches averaged at its resolution, each with other offsets. Returns the
   * RMS difference of their brightness relative to its mean, where the galaxy shows, per pixel and on 4 x 4 blocks,
   * and the ratio of their mean brightness; or null. Slow: a tool, not for frames.
   */
  measureError(passes = 256, base = 7000): { error: number; low: number; ratio: number } | null {
    const renderer = probeRenderer();
    if (!renderer || !this.mesh.visible) return null;
    const out = this.show.uniforms.tHost.value as THREE.Texture;
    const target = this.hist.find((t) => t.texture === out)!;
    const W = target.width, H = target.height;
    // (Each pass read back and summed here, in doubles: a running mean blended into a texture loses the last
    // passes' light to rounding.)
    const ref = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, depthBuffer: false, count: 2 });
    const mu = this.march.uniforms;
    const saved = { size: mu.uSize.value.clone(), jitter: mu.uJitter.value.clone(), index: mu.uIndex.value, steps: mu.uSteps.value };
    const previous = renderer.getRenderTarget();
    mu.uSize.value.set(W, H);
    mu.uSteps.value = HOST.maxSteps;
    const pass = new Float32Array(W * H * 4);
    const acc = new Float64Array(W * H * 4);
    for (let k = 0; k < passes; k++) {
      mu.uJitter.value.set(JITTER[k % 16][0], JITTER[(k + 5) % 16][1]);
      mu.uIndex.value = base + k;
      renderer.setRenderTarget(ref);
      this.marchQuad.render(renderer);
      renderer.readRenderTargetPixels(ref, 0, 0, W, H, pass);
      for (let i = 0; i < acc.length; i++) acc[i] += pass[i];
    }
    renderer.setRenderTarget(previous);
    mu.uSize.value.copy(saved.size);
    mu.uJitter.value.copy(saved.jitter);
    mu.uIndex.value = saved.index;
    mu.uSteps.value = saved.steps;
    ref.dispose();
    const a = new Float32Array(W * H * 4), b = new Float32Array(W * H * 4);
    for (let i = 0; i < a.length; i++) a[i] = acc[i] / passes;
    if (target.texture.type === THREE.FloatType) renderer.readRenderTargetPixels(target, 0, 0, W, H, b);
    else {
      const half = new Uint16Array(W * H * 4);
      renderer.readRenderTargetPixels(target, 0, 0, W, H, half);
      for (let i = 0; i < half.length; i++) b[i] = THREE.DataUtils.fromHalfFloat(half[i]);
    }
    let sum = 0, n = 0, err = 0, hs = 0, lowErr = 0;
    const lum = (v: Float32Array, i: number): number => 0.2126 * v[i] + 0.7152 * v[i + 1] + 0.0722 * v[i + 2];
    let mean = 0;
    for (let i = 0; i < a.length; i += 4) mean += lum(a, i);
    mean /= W * H;
    // (Also on 4 x 4 blocks: what is left there is not grain but a different picture.)
    for (let y = 0; y + 4 <= H; y += 4) for (let x = 0; x + 4 <= W; x += 4) {
      let ra = 0, rb = 0;
      for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) { const i = ((y + j) * W + x + k) * 4; ra += lum(a, i); rb += lum(b, i); }
      if (ra / 16 < 0.3 * mean) continue;
      lowErr += ((rb - ra) / 16) ** 2;
    }
    let blocks = 0;
    for (let y = 0; y + 4 <= H; y += 4) for (let x = 0; x + 4 <= W; x += 4) {
      let ra = 0;
      for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) ra += lum(a, ((y + j) * W + x + k) * 4);
      if (ra / 16 >= 0.3 * mean) blocks++;
    }
    for (let i = 0; i < a.length; i += 4) {
      const r = lum(a, i);
      if (r < 0.3 * mean) continue;
      const d = lum(b, i) - r;
      err += d * d; sum += r; hs += lum(b, i); n++;
    }
    return n ? { error: Math.sqrt(err / n) / (sum / n), low: Math.sqrt(lowErr / Math.max(blocks, 1)) / (sum / n), ratio: hs / sum } : null;
  }

  /**
   * near: the galaxies to march, nearest first; cam: the camera, universe ly; camera: the background camera
   * (orientation and projection of this frame); brightness scales their light, cover their opacity.
   */
  update(near: NearGalaxy[], cam: { x: number; y: number; z: number }, camera: THREE.PerspectiveCamera, brightness: number, pixelsPerRadian: number, cover: number): void {
    const renderer = probeRenderer();
    if (renderer && this.hist.length === 0) {
      const gl = renderer.getContext();
      const full = !!gl.getExtension('OES_texture_float_linear') && !!gl.getExtension('EXT_color_buffer_float');
      this.hist = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, { type: full ? THREE.FloatType : THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }));
    }
    if (!renderer || near.length === 0) {
      this.mesh.visible = false;
      this.fresh = true;
      this.shownEye = null;
      return;
    }
    // Sizes follow the window.
    const w = Math.max(16, Math.round(window.innerWidth * HOST.res)), h = Math.max(16, Math.round(window.innerHeight * HOST.res));
    if (this.cur.width !== w || this.cur.height !== h) {
      this.cur.setSize(w, h);
      for (const t of this.hist) t.setSize(w * HOST.up, h * HOST.up);
      this.fresh = true;
    }
    const mu = this.march.uniforms;
    mu.uCount.value = near.length;
    near.forEach((n, i) => {
      const [a, b, c, d, e, f, h] = galaxyParams(n.galaxy, 1);
      mu.uA.value[i].fromArray(a);
      mu.uB.value[i].fromArray(b);
      mu.uC.value[i].fromArray(c);
      mu.uD.value[i].fromArray(d);
      mu.uE.value[i].fromArray(e);
      mu.uF.value[i].fromArray(f);
      mu.uG.value[i].fromArray(h);
      const ax = n.galaxy.axes;
      mu.uFrame.value[i].set(ax[0], ax[1], ax[2], ax[3], ax[4], ax[5], ax[6], ax[7], ax[8]);
      mu.uEye.value[i].set(n.eye.x, n.eye.y, n.eye.z);
      mu.uWeight.value[i] = n.weight;
    });
    const id = near[0].galaxy.id;
    camera.updateMatrixWorld();
    this.view.makeRotationFromQuaternion(camera.quaternion);
    const invProj = camera.projectionMatrixInverse;
    mu.uInvProj.value.copy(invProj);
    mu.uView.value.setFromMatrix4(this.view);
    mu.uSize.value.set(w, h);
    const j = JITTER[this.index % JITTER.length];
    mu.uJitter.value.set(j[0], j[1]);
    mu.uIndex.value = this.index % 4096;
    const now = performance.now(), dt = now - this.lastTime;
    this.lastTime = now;
    if (dt > 0 && dt < 100) {
      this.frameMs += (dt - this.frameMs) * 0.2;
      if (this.frameMs > BUDGET.lateMs && now > this.holdUntil) {
        HOST.steps *= BUDGET.cut;
        // (Give the cut time to show in the frame times before cutting again.)
        this.holdUntil = now + 300;
        this.frameMs = 16.7;
      } else if (this.frameMs < 17.2 && now > this.holdUntil) {
        HOST.steps *= BUDGET.grow;
      }
      HOST.steps = THREE.MathUtils.clamp(HOST.steps, HOST.minSteps, HOST.maxSteps);
    }
    mu.uSteps.value = Math.round(HOST.steps);
    // Detail finer than a step is resolved only by averaging many frames: moving fast, with few frames to average,
    // it would be grain. So it gives way as the near clouds sweep faster across the screen (in pixels of the
    // history per frame, for clouds a thousandth of the galaxy's radius off, about the nearest there are).
    const move = Math.hypot(cam.x - this.prevCam.x, cam.y - this.prevCam.y, cam.z - this.prevCam.z);
    const sweep = this.fresh ? 0 : move / (near[0].galaxy.radius * 0.01) * (h * HOST.up) / (Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * 2);
    this.sweep += (sweep - this.sweep) * 0.2;
    mu.uStepLimit.value = THREE.MathUtils.lerp(HOST.limit, HOST.limitFast, THREE.MathUtils.smoothstep(this.sweep, 1, 12));
    // (Detail down to a pixel of the history, which the frames averaged resolve.)
    mu.uPixel.value = (Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * 2) / (h * HOST.up);
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.cur);
    this.marchQuad.render(renderer);

    // The camera's move since the last frame; a jump starts again.
    // (A second galaxy coming into the march is no jump: what it changes, the history clamps away.)
    const jump = Math.hypot(cam.x - this.prevCam.x, cam.y - this.prevCam.y, cam.z - this.prevCam.z) > near[0].galaxy.radius * 0.05 || id !== this.prevId;
    const ru = this.resolve.uniforms;
    const [read, write] = this.index % 2 === 0 ? this.hist : [this.hist[1], this.hist[0]];
    ru.tCur.value = this.cur.textures[0];
    ru.tDepth.value = this.cur.textures[1];
    ru.tHist.value = read.texture;
    ru.uInvProj.value.copy(invProj);
    ru.uView.value.setFromMatrix4(this.view);
    ru.uPrev.value.copy(this.prevProj);
    // The point at the current camera + dir * depth, from the last camera: + (now - before).
    ru.uDelta.value.set(cam.x - this.prevCam.x, cam.y - this.prevCam.y, cam.z - this.prevCam.z);
    ru.uSize.value.set(w * HOST.up, h * HOST.up);
    ru.uCurSize.value.set(w, h);
    ru.uJitter.value.set(j[0], j[1]);
    // (Still: no part of the sky moves by a tenth of a march pixel; the nearest light and dust are some tens of light years off.)
    const pixel = (Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * 2) / h;
    const moved = Math.hypot(cam.x - this.prevCam.x, cam.y - this.prevCam.y, cam.z - this.prevCam.z) > 30 * 0.1 * pixel || camera.quaternion.angleTo(this.prevQuat) > 0.1 * pixel;
    this.still = moved ? 0 : this.still + 1;
    ru.uBlend.value = this.fresh || jump ? 1 : Math.max(HOST.rest, HOST.blend / (1 + this.still * HOST.blend));
    ru.uBlendMoving.value = HOST.moving;
    ru.uBlendFast.value = HOST.fast;
    ru.uClamp.value = HOST.clamp;
    ru.uSharp.value = HOST.sharp;
    renderer.setRenderTarget(write);
    this.resolveQuad.render(renderer);
    renderer.setRenderTarget(previous);

    this.prevProj.copy(camera.projectionMatrix).multiply(new THREE.Matrix4().copy(this.view).transpose());
    this.prevCam.set(cam.x, cam.y, cam.z);
    this.prevQuat.copy(camera.quaternion);
    this.prevId = id;
    this.fresh = false;
    this.index++;

    const su = this.show.uniforms;
    su.tHost.value = write.texture;
    su.uSize.value.set(w * HOST.up, h * HOST.up);
    su.uInvProj.value.copy(invProj);
    su.uView.value.setFromMatrix4(this.view);
    su.uGain.value = brightness;
    su.uCover.value = cover;
    su.uGrain.value = pixelsPerRadian;
    su.uGrainAmp.value = HOST.grain;
    this.mesh.visible = true;
    this.shownEye = [near[0].eye.x, near[0].eye.y, near[0].eye.z];
  }
}
