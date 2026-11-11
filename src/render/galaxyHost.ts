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

const MARCH_FRAG = /* glsl */ `
#define MARCH_DEPTH
// (Detail finer than a step averages out over the frames, but only as far as there are frames to average.)
#define STEP_LIMIT 8.0
${GALAXY_GLSL}
uniform vec4 uA[${NEAR_GALAXIES}];
uniform vec4 uB[${NEAR_GALAXIES}];
uniform vec4 uC[${NEAR_GALAXIES}];
uniform vec4 uD[${NEAR_GALAXIES}];
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
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oDepth;

void main() {
  vec2 ndc = (gl_FragCoord.xy + uJitter) / uSize * 2.0 - 1.0;
  vec4 v = uInvProj * vec4(ndc, -1.0, 1.0);
  vec3 dir = normalize(uView * (v.xyz / v.w));
  // (White noise, new every frame: a pattern of offsets, however even, shows in each frame as a hatching.)
  float jitter = hash13(vec3(gl_FragCoord.xy, uIndex));
  vec4 sum = vec4(0.0);
  for (int i = 0; i < ${NEAR_GALAXIES}; i++) {
    if (i >= uCount) break;
    vec4 g = galaxyMarch(uEye[i], uFrame[i] * dir, uA[i], uB[i], uC[i], uD[i], uSteps, jitter, uPixel) * uWeight[i];
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
  float near = exp(-dot(d, d) * 8.0);
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
  if (clip.w <= 0.0 || any(lessThan(puv, vec2(0.0))) || any(greaterThan(puv, vec2(1.0)))) { gl_FragColor = soft; return; }
  vec4 h = catmull(tHist, puv);
  h = clamp(h, m1 - 1.5 * sigma, m1 + 1.5 * sigma);
  // At rest many frames are averaged, the march's grain gone; moving, fewer, so nothing trails behind.
  // (Moving, every pixel of the history is read anew anyway: this frame's march is taken in as it falls on the
  // pixel, smoothly, and not only where a sample happens to be near.)
  float moving = smoothstep(0.3, 3.0, length((puv - vUv) * uSize));
  gl_FragColor = mix(h, mix(c, soft, moving), mix(uBlend * near, uBlendMoving, moving));
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
  float grain = 0.84 + 0.65 * s * s * s * s;
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
const HOST = { res: 0.25, steps: 72, minSteps: 32, maxSteps: 96, up: 2, blend: 0.08, rest: 0.008, moving: 0.3 };
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
  private hist = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }));
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
        uA: { value: vec4s() }, uB: { value: vec4s() }, uC: { value: vec4s() }, uD: { value: vec4s() },
        uFrame: { value: Array.from({ length: NEAR_GALAXIES }, () => new THREE.Matrix3()) },
        uEye: { value: Array.from({ length: NEAR_GALAXIES }, () => new THREE.Vector3()) },
        uWeight: { value: new Array(NEAR_GALAXIES).fill(0) },
        uCount: { value: 0 },
        uInvProj: { value: new THREE.Matrix4() }, uView: { value: new THREE.Matrix3() },
        uSize: { value: new THREE.Vector2(1, 1) }, uJitter: { value: new THREE.Vector2() }, uIndex: { value: 0 },
        uSteps: { value: HOST.steps }, uPixel: { value: 0.001 }, uSettle: { value: 1 },
        uNoise: { value: galaxyNoise }, ...galaxyKnotUniforms,
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
        uJitter: { value: new THREE.Vector2() }, uBlend: { value: 1 }, uBlendMoving: { value: 0.25 },
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
        uGain: { value: 1 }, uCover: { value: 1 }, uGrain: { value: 1000 },
      },
      transparent: true, premultipliedAlpha: true, depthTest: false, depthWrite: false,
    });
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.mesh = new THREE.Mesh(tri, this.show);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /**
   * near: the galaxies to march, nearest first; cam: the camera, universe ly; camera: the background camera
   * (orientation and projection of this frame); brightness scales their light, cover their opacity.
   */
  update(near: NearGalaxy[], cam: { x: number; y: number; z: number }, camera: THREE.PerspectiveCamera, brightness: number, pixelsPerRadian: number, cover: number): void {
    const renderer = probeRenderer();
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
      const [a, b, c, d] = galaxyParams(n.galaxy, 1);
      mu.uA.value[i].fromArray(a);
      mu.uB.value[i].fromArray(b);
      mu.uC.value[i].fromArray(c);
      mu.uD.value[i].fromArray(d);
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
    this.mesh.visible = true;
    this.shownEye = [near[0].eye.x, near[0].eye.y, near[0].eye.z];
  }
}
