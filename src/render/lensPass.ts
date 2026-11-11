import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { B_CRIT, TABLE_COLS, TABLE_ROWS, W_IN, W_OUT, rowImpact, tableTextures } from './geodesics';

// Gravitational lensing by a Schwarzschild black hole as a screen-space pass, plus its thin accretion disc and
// jet, traced along the same light paths. Per pixel: the view ray's impact parameter b and the swept azimuth
// from the tables in geodesics.ts give where the ray ends up at infinity (sampled from the frame, or from a cube
// map of the background when that direction is off screen) or that it falls in; the disc plane's crossings
// along the path (the direct image, the lensed far side above and below the hole, the photon ring) are found
// from the same tables. Disc light: Shakura & Sunyaev (1973) temperature profile with the zero-torque inner
// edge, Keplerian emitters, redshift g = sqrt(1 - 3M/r) / (1 - Omega lambda) for an observer at rest
// (e.g. Luminet 1979; Cunningham 1975), colour of a blackbody at g T, bolometric intensity ~ g^4 T^4, drawn
// compressed to its 3/4 power ((g T)^3) so the frame holds a disc hotter than any star without losing its shape.

export interface LensParams {
  /** Camera relative to the hole, in Schwarzschild radii (universe axes). */
  cam: THREE.Vector3;
  axis: THREE.Vector3;
  /** Cosine of the angle from the hole beyond which the frame passes through untouched. */
  reachCos: number;
  /** rIn, rOut (r_s), peak temperature (K), peak brightness (0: no disc). */
  disc: THREE.Vector4;
  opacity: number;
  /** Simulated time in r_s / c (for the pattern), and the time step of a frame in the same unit (for its blur). */
  time: number;
  step: number;
  /** length (r_s), Lorentz factor, brightness (0: no jet). */
  jet: THREE.Vector4;
  knots: THREE.Vector2[];
  /** The hole's own light as a point while too small to trace: colour times intensity, and size in device pixels. */
  point: THREE.Vector4;
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tFrame;
uniform samplerCube tCube;
uniform float uCubeOn;
uniform float uCubeGain;
uniform sampler2D tOut;
uniform sampler2D tIn;
uniform mat3 uViewToWorld;
uniform mat3 uWorldToView;
uniform vec2 uTan;
uniform float uPix;
uniform vec2 uRes;
uniform vec3 uCam;
uniform vec3 uAxis;
uniform vec3 uE1;
uniform vec3 uE2;
uniform float uReachCos;
uniform vec4 uDisc;
uniform float uOpacity;
uniform float uTime;
uniform float uStep;
uniform vec4 uJet;
uniform vec2 uKnots[8];
uniform vec4 uPoint;
varying vec2 vUv;

const float PI = 3.14159265358979;
const float BC = ${B_CRIT.toFixed(9)};
const float BMAX = ${rowImpact(false, TABLE_ROWS - 1).toFixed(3)};
const vec2 WOUT = vec2(${W_OUT[0].toFixed(1)}, ${W_OUT[1].toFixed(1)});
const vec2 WIN = vec2(${W_IN[0].toFixed(1)}, ${W_IN[1].toFixed(1)});
const float COLS = ${TABLE_COLS.toFixed(1)};
const float ROWS = ${TABLE_ROWS.toFixed(1)};

float rowOut(float b) { return (clamp((log(b / BC - 1.0) - WOUT.x) / (WOUT.y - WOUT.x), 0.0, 1.0) * (ROWS - 1.0) + 0.5) / ROWS; }
float rowIn(float b) { return (clamp((log(max(1.0 - b / BC, 1e-30)) - WIN.x) / (WIN.y - WIN.x), 0.0, 1.0) * (ROWS - 1.0) + 0.5) / ROWS; }
vec4 tab(sampler2D t, float col, float row) { return texture(t, vec2((clamp(col, 0.0, 1.0) * (COLS - 1.0) + 0.5) / COLS, row)); }

// The same blackbody colours as the stars (temperatureToRgb in stars.ts), brightest channel 1.
vec3 blackbody(float k) {
  float t = clamp(k, 1000.0, 40000.0) / 100.0;
  vec3 c;
  if (t <= 66.0) {
    c = vec3(255.0, 99.47 * log(t) - 161.12, t <= 19.0 ? 0.0 : 138.52 * log(t - 10.0) - 305.04);
  } else {
    c = vec3(329.7 * pow(t - 60.0, -0.1332), 288.12 * pow(t - 60.0, -0.0755), 255.0);
  }
  c = pow(clamp(c / 255.0, 0.0, 1.0), vec3(2.2));
  return c / max(max(c.r, c.g), c.b);
}

float hash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}
float noise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}

float noise1(float x) {
  float i = floor(x), f = fract(x);
  return mix(fract(sin(i * 12.9898) * 43758.5453), fract(sin((i + 1.0) * 12.9898) * 43758.5453), f * f * (3.0 - 2.0 * f));
}

// What the camera sees in a direction at infinity: the frame where it is on screen, else the cube map.
// 'spread' is the angle between neighbouring pixels' rays out there: where the lens squeezes much sky into
// a pixel (towards the photon ring) the cube's mipmaps average it, where the frame would sparkle.
vec3 sky(vec3 dir, float spread) {
  vec3 v = uWorldToView * dir;
  float w = 0.0;
  vec2 uv = vec2(0.5);
  if (v.z < -1e-6) {
    uv = (v.xy / -v.z) / uTan * 0.5 + 0.5;
    vec2 e = min(uv, 1.0 - uv);
    w = smoothstep(0.0, 0.04, min(e.x, e.y));
  }
  vec3 frame = w > 0.0 ? texture(tFrame, clamp(uv, 0.0, 1.0)).rgb : vec3(0.0);
  if (uCubeOn < 0.5) return frame;
  w *= 1.0 - smoothstep(2.0, 4.0, spread / uPix);
  if (w >= 1.0) return frame;
  float lod = log2(max(spread / ${(Math.PI / 2 / 512).toFixed(6)}, 1.0));
  return mix(textureLod(tCube, dir, lod).rgb * uCubeGain, frame, w);
}

// One view ray: whether it falls in, where it ends up at infinity, and the disc's light along it.
bool traceRay(vec3 d, float ro, vec3 er, out vec3 outDir, out vec3 col, out float trans, out float b) {
  float cosA = -dot(d, er);
  col = vec3(0.0);
  trans = 1.0;
  outDir = d;
  bool captured = false;
  float uo = 1.0 / ro;
  vec3 et = d + cosA * er;
  float sinA = length(et);
  et = sinA > 1e-12 ? et / sinA : normalize(cross(er, abs(er.y) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0)));
  float alpha = atan(sinA, cosA);
  float psi = PI - alpha;
  b = ro * sinA / sqrt(1.0 - uo);
  bool inward = cosA > 0.0;
  // How far the ray turns towards the hole on its way out, and what the disc crossings need.
  float delta = 0.0;
  float phiObs = 0.0, phiEnd = 0.0, phiP = 1.0, up = 1.0, row = 0.0;
  int mode;
  if (b >= BMAX) {
    // Weak field: 2 r_s / b in all, of which (1 + cos(alpha)) r_s / b on the way from here to infinity.
    mode = 0;
    delta = (1.0 + cosA) / b;
    phiEnd = alpha;
  } else if (b > BC) {
    mode = 1;
    row = rowOut(b);
    vec4 p = tab(tOut, 0.0, row);
    up = p.a;
    phiP = p.b + 0.5 * PI;
    float so = min(uo / up, 1.0);
    float e = tab(tOut, sqrt(1.0 - so), row).r;
    float phiO = asin(so) + e;
    if (inward) {
      // (Written so that nothing large cancels for a distant camera.)
      delta = 2.0 * p.b - ((asin(so) - alpha) + e);
      phiObs = phiO;
      phiEnd = 2.0 * phiP - phiO;
    } else {
      delta = phiO - psi;
      phiObs = 2.0 * phiP - phiO;
      phiEnd = phiO;
    }
  } else {
    row = rowIn(b);
    vec4 p = tab(tIn, 0.0, row);
    phiP = p.b;
    float phiO = tab(tIn, 3.0 * uo, row).r;
    phiObs = phiO;
    if (inward) {
      mode = 2;
      captured = true;
      phiEnd = phiP - phiO;
    } else {
      mode = 3;
      delta = phiO - psi;
      phiEnd = phiO;
    }
  }

  if (uDisc.w > 0.0) {
    float A = dot(er, uAxis), B = dot(et, uAxis);
    float phi0 = atan(-A, B);
    if (phi0 < 1e-5) phi0 += PI;
    if (phi0 < 1e-5) phi0 += PI;
    // The photon's angular momentum about the spin axis (it travels opposite to the traced ray).
    float lam = -b * dot(cross(er, et), uAxis);
    float rIn = uDisc.x, rOut = uDisc.y;
    float rPeak = rIn * 49.0 / 36.0;
    float fMax = pow(rPeak, -0.75) * pow(1.0 - sqrt(rIn / rPeak), 0.25);
    for (int k = 0; k < 3; k++) {
      float phi = phi0 + float(k) * PI;
      if (phi >= phiEnd || trans < 0.01) break;
      float r;
      if (mode == 0) {
        r = b / sin(psi + phi);
      } else if (mode == 1) {
        float ph = phiObs + phi;
        float tt = ph < phiP ? ph / phiP : (2.0 * phiP - ph) / phiP;
        r = 1.0 / (max(tab(tOut, sqrt(max(tt, 0.0)), row).g, 1e-9) * up);
      } else {
        float tt = mode == 2 ? (phiObs + phi) / phiP : (phiObs - phi) / phiP;
        r = 1.0 / max(tab(tIn, sqrt(clamp(tt, 0.0, 1.0)), row).g, 1e-9);
      }
      if (r <= rIn * 0.98 || r >= rOut) continue;
      float om = sqrt(0.5 / (r * r * r));
      float g = sqrt(1.0 - 1.5 / r) / ((1.0 - om * lam) * sqrt(1.0 - uo));
      float f = pow(r, -0.75) * pow(max(1.0 - sqrt(rIn / r), 0.0), 0.25) / fMax;
      // Streaks of hotter and cooler gas, sheared by the differential rotation; smeared out where they turn too fast to follow.
      vec3 pos = cos(phi) * er + sin(phi) * et;
      float azs = atan(dot(pos, uE2), dot(pos, uE1));
      float blur = smoothstep(0.15, 1.5, om * uStep);
      float lr = log(r);
      float n = 0.5;
      if (blur < 0.99) {
        // (Sheared into trailing spirals: the angle lags with radius as the orbits do.)
        float sh = azs - om * uTime + 1.6 * lr;
        vec3 q = vec3(cos(sh) * 2.2, sin(sh) * 2.2, lr * 5.0);
        n = 0.65 * noise(q) + 0.35 * noise(q * 2.7 + 3.1);
      }
      // Radial structure survives the blur: rings of denser and thinner gas, irregular in width.
      float band = 0.6 * noise1(lr * 5.0) + 0.4 * noise1(lr * 17.0 + 3.7);
      // And a two-armed spiral density wave, which turns at its own slow pattern speed, not with the gas.
      float wave = 1.0 + 0.14 * sin(2.0 * azs + 5.0 * lr + 1.3);
      float tex = mix(0.45 + 1.1 * n, 1.0, blur) * (0.84 + 0.32 * band) * wave;
      float gf = g * f;
      vec3 light = blackbody(uDisc.z * gf) * uDisc.w * gf * gf * gf * tex;
      float a = uOpacity * smoothstep(rIn * 0.98, rIn * 1.04, r) * (1.0 - smoothstep(0.3 * rOut, rOut, r));
      col += trans * a * light;
      trans *= 1.0 - a;
    }
  }

  if (!captured) outDir = cos(delta) * d + sin(delta) * (-sinA * er - cosA * et);
  return captured;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 d = normalize(uViewToWorld * vec3(ndc * uTan, -1.0));
  float ro = length(uCam);
  vec3 er = uCam / ro;
  float cosA = -dot(d, er);
  vec3 col = vec3(0.0);
  float trans = 1.0;
  bool captured = false;
  bool lensed = cosA >= uReachCos;
  vec3 outDir = d;
  float shadow = 0.0;
  if (lensed) {
    float b;
    captured = traceRay(d, ro, er, outDir, col, trans, b);
    shadow = captured ? 1.0 : 0.0;
    // Around the photon ring the disc's images and the shadow's edge are thinner than a pixel: four more rays.
    if (b > 0.93 * BC && b < 1.15 * BC) {
      vec3 o2, c2;
      float t2, b2;
      for (int i = 0; i < 4; i++) {
        vec2 off = (vec2(float(i & 1), float(i >> 1)) - 0.5) * 0.5 * (2.0 / uRes);
        vec3 d2 = normalize(uViewToWorld * vec3((ndc + off) * uTan, -1.0));
        shadow += traceRay(d2, ro, er, o2, c2, t2, b2) ? 1.0 : 0.0;
        col += c2;
        trans += t2;
      }
      col /= 5.0;
      trans /= 5.0;
      shadow /= 5.0;
    }
  }
  // (Derivatives outside the branches, where every pixel of a quad has its value.)
  float spread = max(length(dFdx(outDir)), length(dFdy(outDir)));
  vec3 bg = !lensed ? texture(tFrame, vUv).rgb : captured ? vec3(0.0) : sky(outDir, spread) * (1.0 - shadow);

  if (uJet.w > 0.0) {
    // Closest approach of the (straight) view ray to the jet axis; the jet's light across it, integrated
    // through a Gaussian tube as wide as the jet there (or the pixel), Doppler boosted along the flow.
    float bb = dot(d, uAxis), dd = dot(d, uCam), ee = dot(uAxis, uCam);
    float den = max(1.0 - bb * bb, 1e-6);
    float sc = max((bb * ee - dd) / den, 0.0);
    float tc = ee + bb * sc;
    float z = abs(tc);
    float dist = length(uCam + sc * d - tc * uAxis);
    float wj = 0.8 * pow(max(z, 1.0), 0.6) + 0.012 * z;
    float wp = max(sc, 1.0) * uPix * 0.7;
    float we = sqrt(wj * wj + wp * wp);
    float side = sign(tc);
    float cth = dot(side * uAxis, -d);
    float beta = sqrt(1.0 - 1.0 / (uJet.y * uJet.y));
    float dop = 1.0 / (uJet.y * (1.0 - beta * cth));
    float sinth = max(sqrt(den), 0.08);
    float along = z / uJet.x;
    float knots = 0.35;
    for (int i = 0; i < 8; i++) knots += uKnots[i].y * exp(-pow((along - uKnots[i].x) / 0.018, 2.0));
    // (The jet slows on kiloparsec scales: the boosting of the inner jet fades with distance.)
    float dopz = pow(dop, 2.6 / (1.0 + z / (0.05 * uJet.x)));
    float sb = uJet.z * (pow(max(z, 3.0) / 30.0, -0.6) + 0.03) * knots * dopz * (wj / we) * exp(-dist * dist / (we * we)) / sinth;
    sb *= smoothstep(2.0, 12.0, z) * (1.0 - smoothstep(0.85, 1.0, along));
    // Behind the shadow or the disc, it is hidden.
    float hidden = (captured && sc > ro * 0.9) ? 0.0 : mix(1.0, trans, step(ro, sc));
    col += vec3(0.62, 0.74, 1.0) * sb * hidden;
  }

  // Too small to trace, the disc is a point of light (the starfield's profile), unbent: it is the lens itself.
  if (uPoint.a > 0.0) {
    float px = acos(clamp(cosA, -1.0, 1.0)) / uPix;
    col += uPoint.rgb * max(exp(-20.0 * px * px / (uPoint.a * uPoint.a)) - 0.0067, 0.0);
  }
  gl_FragColor = vec4(bg * trans + col, 1.0);
}
`;

const CUBE_SIZE = 512;
/** Cube texels per radian at the centre of a face. */
const CUBE_PPR = CUBE_SIZE / 2;
/** Frames between refreshes of one cube face. */
const CUBE_FACE_EVERY = 5;

export class LensPass extends Pass {
  private readonly quad: FullScreenQuad;
  private readonly material: THREE.ShaderMaterial;
  private readonly cube = new THREE.WebGLCubeRenderTarget(CUBE_SIZE, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  private readonly cubeCamera = new THREE.CubeCamera(0.01, 1e9, this.cube);
  private cubeValid = false;
  private cubeFace = 0;
  private cubeTick = 0;
  private readonly cubeEye = new THREE.Vector3();
  /** The camera's position in the universe, ly (for when the cube needs redrawing). */
  readonly eye = new THREE.Vector3();
  private tablesReady = false;
  /** The black holes to draw this frame, farthest first. */
  readonly holes: LensParams[] = [];
  /** Off-screen directions come from a cube map of the background (needed close to a hole). */
  useCube = false;
  /** Camera orientation and field of view. */
  readonly view = new THREE.Quaternion();
  tan = new THREE.Vector2(1, 1);
  /** Radians per device pixel, and device pixels per CSS pixel. */
  pixelAngle = 1e-3;
  pixelRatio = 1;

  constructor(private readonly bgScene: THREE.Scene) {
    super();
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: {
        tFrame: { value: null }, tCube: { value: this.cube.texture }, uCubeOn: { value: 0 }, uCubeGain: { value: 1 },
        tOut: { value: null }, tIn: { value: null },
        uViewToWorld: { value: new THREE.Matrix3() }, uWorldToView: { value: new THREE.Matrix3() }, uTan: { value: new THREE.Vector2() },
        uPix: { value: 1e-3 }, uRes: { value: new THREE.Vector2(1, 1) }, uCam: { value: new THREE.Vector3(0, 0, 100) }, uAxis: { value: new THREE.Vector3(0, 1, 0) },
        uE1: { value: new THREE.Vector3(1, 0, 0) }, uE2: { value: new THREE.Vector3(0, 0, 1) }, uReachCos: { value: 0.9 },
        uDisc: { value: new THREE.Vector4() }, uOpacity: { value: 1 }, uTime: { value: 0 }, uStep: { value: 0 }, uJet: { value: new THREE.Vector4() },
        uKnots: { value: Array.from({ length: 8 }, () => new THREE.Vector2()) }, uPoint: { value: new THREE.Vector4() },
      },
      depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
    // The soft layer too: its glows are drawn straight into the faces.
    for (const c of this.cubeCamera.children) c.layers.enableAll();
    this.enabled = false;
  }

  /** Builds the tables and compiles the shader now, so the first black hole in view costs no stall. */
  warm(renderer: THREE.WebGLRenderer): void {
    this.ensureTables(renderer);
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
    this.material.uniforms.uDisc.value.set(3, 100, 6000, 1);
    this.material.uniforms.uJet.value.set(1e5, 3, 1, 1);
    renderer.setRenderTarget(rt);
    this.quad.render(renderer);
    renderer.setRenderTarget(null);
    rt.dispose();
  }

  private ensureTables(renderer: THREE.WebGLRenderer): void {
    if (this.tablesReady) return;
    const t = tableTextures(renderer);
    this.material.uniforms.tOut.value = t.out;
    this.material.uniforms.tIn.value = t.in;
    this.tablesReady = true;
  }

  /** Forget the cube map (the background changed a lot): it is redrawn whole when next needed. */
  invalidateCube(): void {
    this.cubeValid = false;
  }

  private updateCube(renderer: THREE.WebGLRenderer): void {
    // The background hardly changes while the camera stays near a hole: one face every few frames keeps it
    // current, and a jump (light years: nearby stars move) redraws the whole cube.
    if (this.cubeValid && this.eye.distanceTo(this.cubeEye) > 0.05) this.cubeValid = false;
    if (this.cubeValid && ++this.cubeTick % CUBE_FACE_EVERY !== 0) return;
    if (!this.cubeValid) this.cubeEye.copy(this.eye);
    // The soft layer's full-screen composite has no place in a cube face: hide it while drawing them.
    const hidden: THREE.Object3D[] = [];
    // Point sprites (stars) are sized in pixels: a cube texel spans many screen pixels, so drawn as they are they
    // would carry that many times their light. Drawn a texel wide instead, with their light scaled to match.
    const points: { m: THREE.ShaderMaterial; ratio: number }[] = [];
    const k = 0.3 * (2.7 * this.pixelRatio * (CUBE_PPR * this.pixelAngle)) ** 2;
    this.bgScene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
      if (!o.visible || !m || !m.uniforms) return;
      if ('tSoft' in m.uniforms) { o.visible = false; hidden.push(o); }
      if ((o as THREE.Points).isPoints && 'uPixelRatio' in m.uniforms && m.blending === THREE.AdditiveBlending && !points.some((p) => p.m === m)) {
        points.push({ m, ratio: m.uniforms.uPixelRatio.value });
        m.uniforms.uPixelRatio.value = 0.3;
        m.blending = THREE.CustomBlending;
        m.blendSrc = THREE.ConstantColorFactor;
        m.blendDst = THREE.OneFactor;
        m.blendColor.setScalar(Math.min(k, 1));
      }
    });
    const cams = this.cubeCamera.children as THREE.PerspectiveCamera[];
    if (this.cubeCamera.coordinateSystem !== renderer.coordinateSystem) {
      this.cubeCamera.coordinateSystem = renderer.coordinateSystem;
      this.cubeCamera.updateCoordinateSystem();
    }
    const faces = this.cubeValid ? [this.cubeFace] : [0, 1, 2, 3, 4, 5];
    this.cubeFace = (this.cubeFace + 1) % 6;
    const mips = this.cube.texture.generateMipmaps;
    this.cube.texture.generateMipmaps = false;
    for (let i = 0; i < faces.length; i++) {
      // Mipmaps once, after the last face.
      if (i === faces.length - 1) this.cube.texture.generateMipmaps = mips;
      renderer.setRenderTarget(this.cube, faces[i]);
      renderer.render(this.bgScene, cams[faces[i]]);
    }
    this.cube.texture.generateMipmaps = mips;
    for (const o of hidden) o.visible = true;
    for (const p of points) {
      p.m.uniforms.uPixelRatio.value = p.ratio;
      p.m.blending = THREE.AdditiveBlending;
    }
    this.cubeValid = true;
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    this.ensureTables(renderer);
    const u = this.material.uniforms;
    if (this.useCube) this.updateCube(renderer);
    else this.cubeValid = false;
    u.uCubeOn.value = this.useCube ? 1 : 0;
    const m = new THREE.Matrix4().makeRotationFromQuaternion(this.view);
    u.uViewToWorld.value.setFromMatrix4(m);
    u.uWorldToView.value.copy(u.uViewToWorld.value).transpose();
    u.uTan.value.copy(this.tan);
    u.uPix.value = this.pixelAngle;
    u.uRes.value.set(readBuffer.width, readBuffer.height);
    let src = readBuffer, dst = writeBuffer;
    this.holes.forEach((h, i) => {
      u.tFrame.value = src.texture;
      u.uCam.value.copy(h.cam);
      u.uAxis.value.copy(h.axis);
      const e1 = u.uE1.value as THREE.Vector3;
      e1.set(0, 1, 0).cross(h.axis);
      if (e1.lengthSq() < 1e-6) e1.set(1, 0, 0).cross(h.axis);
      e1.normalize();
      u.uE2.value.crossVectors(h.axis, e1);
      u.uReachCos.value = h.reachCos;
      u.uDisc.value.copy(h.disc);
      u.uOpacity.value = h.opacity;
      u.uTime.value = h.time;
      u.uStep.value = h.step;
      u.uJet.value.copy(h.jet);
      u.uPoint.value.copy(h.point);
      for (let k = 0; k < 8; k++) u.uKnots.value[k].copy(h.knots[k] ?? ZERO2);
      const last = i === this.holes.length - 1;
      renderer.setRenderTarget(this.renderToScreen && last ? null : dst);
      this.quad.render(renderer);
      [src, dst] = [dst, src];
    });
    // With an even number of draws the result is back in the read buffer.
    this.needsSwap = this.holes.length % 2 === 1;
  }

  setSize(): void { /* full-screen quad: nothing to resize */ }

  dispose(): void {
    this.material.dispose();
    this.quad.dispose();
    this.cube.dispose();
  }
}

const ZERO2 = new THREE.Vector2();
