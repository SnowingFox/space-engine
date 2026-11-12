import * as THREE from 'three';
import { Rng } from '../core/rng';

// Nebulae are marched through a procedural model of their gas and dust, in the nebula's own frame,
// with lengths in units of its radius. One program per family (H II region, planetary nebula,
// supernova remnant, reflection nebula); the variant of a family is a uniform.
//
// What is modelled:
//  - Emission: recombination light goes as density squared where the gas is ionised. Whether it is
//    ionised follows from the light of the hot stars against the density (flux / n^2, a local
//    Stromgren criterion): thin gas near the stars glows, dense clumps, pillars and the molecular cloud
//    behind a blister stay neutral and dark, and their faces towards the stars light up as bright rims.
//    Pillars cast shadows away from the stars.
//  - Colour: H-alpha with H-beta (pink-red) everywhere, [O III] (teal) where the ionisation is highest,
//    near the hottest stars or inside a planetary nebula's shell; [N II] (deep red) outermost.
//  - Dust: extinction that reddens what is behind it (dust lanes, the neutral cloud), and scattered
//    starlight (blue) where dust is lit.
//  - Shells: shocked sheets of gas are bright where they are seen edge on (limb brightening), which is
//    what draws the filaments of the Veil.
// Density: turbulent gas has a log-normal density distribution, so the noise is exponentiated.

const NOISE_SIZE = 64;

function makeNoise(): THREE.Data3DTexture {
  const rng = new Rng(4242);
  const data = new Uint8Array(NOISE_SIZE ** 3 * 4);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(rng.next() * 256);
  const t = new THREE.Data3DTexture(data, NOISE_SIZE, NOISE_SIZE, NOISE_SIZE);
  t.format = THREE.RGBAFormat;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

export const nebulaNoise = makeNoise();

export const MAX_STARS = 9;
export const PARAM_SLOTS = 6;
/** Structures of an H II region (clouds, pillars, cavities...), and analytic glows. */
export const MAX_PRIMS = 16;
export const MAX_GLOWS = 4;

export const NEBULA_VERT = /* glsl */ `
uniform vec3 uRel;      // centre relative to the camera, ly
uniform float uRadius;  // ly
varying vec3 vRay;
void main() {
  float d = length(uRel);
  float bound = uRadius * 1.02;
  vec3 world;
  vec4 clip;
  if (d < bound * 1.3) {
    // Close to or inside the nebula: a billboard cannot cover it; the whole view does.
    clip = vec4(position.xy, 0.0, 1.0);
    vec4 v = inverse(projectionMatrix) * clip;
    world = transpose(mat3(modelViewMatrix)) * (v.xyz / v.w);
  } else {
    vec3 f = uRel / d;
    vec3 right = normalize(cross(f, abs(f.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 up = cross(right, f);
    float size = bound * d / sqrt(d * d - bound * bound);
    world = uRel + (right * position.x + up * position.y) * size;
    clip = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
  }
  vRay = world;
  gl_Position = clip;
}
`;

const COMMON = /* glsl */ `
precision highp sampler3D;
uniform sampler3D uNoise;
uniform mat3 uToLocal;
uniform vec3 uEye;
uniform float uSteps;
uniform float uPixel;
uniform float uWeight;
uniform vec3 uGain;
uniform vec3 uScale;
uniform float uSeed;
uniform int uVariant;
uniform vec4 uP[${PARAM_SLOTS}];
uniform vec4 uStar[${MAX_STARS}];
uniform vec3 uStarCol[${MAX_STARS}];
uniform int uStarN;
uniform float uDust;    // opacity of the dust, 0..1
uniform vec4 uFocus;   // xyz: point the steps crowd around (the main star); w > 0: closest the crowding gets
varying vec3 vRay;

vec3 gRd;   // the ray, in the nebula's frame
vec3 gL;    // light gathered along it
vec3 gT;    // and how much of what is behind still comes through

const vec3 C_HA = vec3(1.0, 0.13, 0.30);      // H-alpha with H-beta (about 1 / 2.9 of it): the pink of ionised hydrogen
const vec3 C_RED = vec3(1.0, 0.05, 0.06);     // H-alpha and [N II], where the ionisation is low
const vec3 C_BROWN = vec3(0.55, 0.30, 0.16);  // dust lit by the nebula's own red light
const vec3 C_RIM = vec3(1.0, 0.24, 0.36);     // ionisation fronts on dense gas: H-alpha, with [O III] and scattered starlight
const vec3 C_OIII = vec3(0.06, 1.0, 0.74);    // [O III] 496/501 nm
const vec3 C_HEII = vec3(0.32, 0.5, 1.0);
const vec3 C_SYNC = vec3(0.52, 0.7, 1.0);
const vec3 C_SCAT = vec3(0.42, 0.62, 1.0);    // starlight scattered by dust (bluer than the star)
const vec3 C_DUST = vec3(0.78, 1.0, 1.28);    // extinction per channel (reddens)

const mat3 ROT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);

vec4 n4(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return textureLod(uNoise, (i + f + 0.5) / ${NOISE_SIZE}.0, 0.0);
}

// Four independent fields, each 0..1 around a mean of 0.5 (standard deviation about 0.1); octaves beyond
// 'oct' fade to their mean, so detail comes in smoothly as the camera nears.
vec4 fbm4(vec3 p, float oct) {
  vec4 s = vec4(0.0);
  float a = 0.5, w = 0.0;
  for (int i = 0; i < 9; i++) {
    float o = clamp(oct - float(i), 0.0, 1.0);
    if (o <= 0.0) break;
    s += a * mix(vec4(0.5), n4(p), o);
    w += a;
    p = ROT * p * 2.03;
    a *= 0.56;
  }
  return s / max(w, 1e-4);
}

float fbm(vec3 p, float oct) {
  return fbm4(p, oct).x;
}

float ridge(float v) {
  return 1.0 - abs(2.0 * v - 1.0);
}

// Per-pixel offset of the steps (white noise: a pattern would show once upscaled).
float ign(vec2 px) {
  uvec2 u = uvec2(px);
  uint h = u.x * 1664525u + u.y * 22695477u + 1013904223u;
  h ^= h >> 16; h *= 2246822519u; h ^= h >> 13; h *= 3266489917u; h ^= h >> 16;
  return float(h) / 4294967296.0;
}

float octaves(float fp, float freq, float most) {
  return clamp(log2(1.0 / max(2.0 * fp * freq, 1e-6)) + 1.0, 1.0, most);
}

float gauss(float x, float w) {
  return exp(-(x * x) / (w * w));
}
`;

const HII = /* glsl */ `
// Per region (shape frame, lengths in radii):
//   uP[0] = cavity radius, cavity softness, outer radius, concentration towards the main star
//   uP[1] = dust, [O III], scattered starlight (blue), ionising power
//   uP[2] = warp, noise frequency, density contrast (log-normal sigma), stretch along the stars' rays
//   uP[3] = molecular cloud behind the region: normal xyz (out of the cloud), offset
//   uP[4] = its curvature (positive: a bowl around the stars), density, softness, glow of its lit face
//   uP[5] = filaments, opening towards the poles (Z), 1: a sheet seen face on (IC 434), dust lit by the nebula
// Structures, three vec4 each: (a.xyz, ra), (b.xyz, rb), (density, roughness, kind, glow): a round cone from a to b.
//   kind 0: dark cloud (neutral, dusty, its face lit by the stars, as brightly as 'glow'); 1: solid (a pillar or
//   globule, sharp, drawn live, see solids()); 2: reflection cloud (dust scattering the stars' blue light);
//   3: a brighter part of the ionised gas; 4: a cavity cleared of gas.
uniform vec4 uPr[${MAX_PRIMS * 3}];
uniform int uPrN;
uniform int uLiveN;   // the first uLiveN structures are the solids

// Distance to a round cone (a sphere of radius ra at a, rb at b, and the cone tangent to both).
float roundCone(vec3 p, vec3 a, vec3 b, float ra, float rb) {
  vec3 ba = b - a;
  float l2 = dot(ba, ba);
  if (l2 < 1e-8) return length(p - a) - ra;
  float rr = ra - rb, a2 = l2 - rr * rr, il2 = 1.0 / l2;
  vec3 pa = p - a;
  float y = dot(pa, ba), z = y - l2;
  vec3 xv = pa * l2 - ba * y;
  float x2 = dot(xv, xv), y2 = y * y * l2, z2 = z * z * l2;
  float k = sign(rr) * rr * rr * x2;
  if (sign(z) * a2 * z2 > k) return sqrt(x2 + z2) * il2 - rb;
  if (sign(y) * a2 * y2 < k) return sqrt(x2 + y2) * il2 - ra;
  return (sqrt(x2 * a2 * il2) + y * rr) * il2 - ra;
}

// Fill of structure j at p: 0 outside, 1 well inside, its edge roughened by noise.
float primFill(int j, vec3 p, float rough) {
  vec4 A = uPr[j * 3], B = uPr[j * 3 + 1], C = uPr[j * 3 + 2];
  float d = roundCone(p, A.xyz, B.xyz, A.w, B.w);
  float size = max(A.w, B.w);
  if (d > size * (0.8 + 1.2 * C.y)) return 0.0;
  if (rough > 0.0) d += rough * size * 1.6 * ((n4(p / (size * 0.6) + float(j) * 7.3 + uSeed).x - 0.5) + 0.5 * (n4(p / (size * 0.22) + float(j) * 3.1).y - 0.5));
  // (A dark cloud thins out gradually; the others have firmer edges.)
  float soft = int(C.z + 0.5) == 0 ? size * 0.7 : size * 0.2;
  return smoothstep(soft, -soft, d);
}

float gCloud;   // the molecular cloud's share of the last neutralGas()
float gGlow;    // how brightly the dark clouds there glow where lit
// Neutral (dusty) gas at p: the molecular cloud and the dark clouds; for shadows (shadow = true), the solids too.
float neutralGas(vec3 p, bool shadow) {
  vec3 q = p / uScale;
  vec3 cn = uP[3].xyz;
  float along = dot(q, cn);
  vec3 across = q - cn * along;
  float h = along - uP[3].w - uP[4].x * dot(across, across);
  // (Faded out well inside the bounding sphere, raggedly: its edge must never show as a circle.)
  float edgeN = n4(q * 2.3 + uSeed * 0.7).w - 0.5;
  float cloud = uP[4].y * smoothstep(uP[4].z, -uP[4].z, h) * (1.0 - smoothstep(0.3, 0.9, length(q) + 0.35 * edgeN));
  gCloud = cloud;
  gGlow = 1.0;
  // (Dark clouds belong to the region: they thin out towards its edge rather than run on across the sky.)
  float inside = 1.0 - smoothstep(0.35, 0.92, length(q) + 0.35 * edgeN);
  for (int j = 0; j < ${MAX_PRIMS}; j++) {
    if (j >= uPrN) break;
    vec4 C = uPr[j * 3 + 2];
    int kind = int(C.z + 0.5);
    if (kind == 0 || (shadow && kind == 1)) {
      float f = primFill(j, p, shadow ? 0.0 : C.y);
      cloud += C.x * f * (kind == 0 ? inside : 1.0);
      if (f > 0.05 && kind == 0) gGlow = min(gGlow, C.w);
    }
  }
  return cloud;
}

void medium(vec3 p, float fp, float dt, out vec3 e, out vec3 k) {
  vec3 q = p / uScale;
  float freq = uP[2].y;
  // Two levels of domain warping: the gas flows in swirls and long streamers.
  vec4 w = n4(q * freq * 0.4 + uSeed) - 0.5;
  vec4 w2 = n4(q * freq * 1.1 + w.xyz * 1.5 + uSeed * 2.3) - 0.5;
  vec3 qw = q + (w.xyz + 0.45 * w2.xyz) * uP[2].x;
  // A ragged outline: the edge of the nebula wanders in and out by a large-scale field.
  // (By as much as the gas is warped: a calm region has a calm outline.)
  float r = length(qw) / (0.95 + 1.5 * uP[2].x * w.w);
  e = vec3(0.0);
  k = vec3(0.0);

  // Starlight: inverse square from every star.
  float flux = 0.0;
  for (int i = 0; i < ${MAX_STARS}; i++) {
    if (i >= uStarN) break;
    vec3 d = uStar[i].xyz - p;
    flux += uStar[i].w / (dot(d, d) + 0.0006);
  }
  vec3 d0 = uStar[0].xyz - p;
  float r0 = length(d0);
  vec3 radial = d0 / max(r0, 1e-4);
  float env;
  if (uP[5].z > 0.5) {
    // A sheet of gas seen nearly face on (IC 434 behind the Horsehead), densest at the edge of the cloud,
    // where the gas boils off it into the starlight.
    float side = dot(qw, uP[3].xyz) - uP[3].w;
    env = 2.5 * gauss(q.z + 0.22 + 0.2 * w.w, 0.2) * (1.0 - smoothstep(0.3, 0.95, r)) * (0.6 + 1.2 * exp(-max(side, 0.0) * 4.0)) * smoothstep(-0.12, 0.04, side);
  } else {
    // (The cavity is measured without the ragged outline's stretch, so it stays round and clear.)
    float rc = length(qw);
    env = smoothstep(uP[0].x - uP[0].y, uP[0].x + uP[0].y, rc) * (1.0 - smoothstep(uP[0].z * 0.35, uP[0].z, r));
    // A bubble blown by the cluster's winds: the swept-up gas is densest at its inner wall.
    if (uP[0].x > 0.05) env *= 0.45 + 2.6 * exp(-max(rc - uP[0].x, 0.0) * 6.0);
    // Some are rings rather than bubbles, open towards the poles.
    env *= 1.0 - uP[5].y * smoothstep(0.45, 0.85, abs(qw.z) / max(rc, 1e-3));
  }
  // Denser towards the stars that formed in it, and densest around the main star.
  // (On the emission measure, n^2, so a square root on the density.)
  env *= sqrt((1.0 + uP[0].w * exp(-r0 * 6.0)) / (1.0 + 1.2 * r0 * r0));
  // Brighter parts, and cavities.
  for (int j = 0; j < ${MAX_PRIMS}; j++) {
    if (j >= uPrN) break;
    vec4 C = uPr[j * 3 + 2];
    int kind = int(C.z + 0.5);
    if (kind == 3) env *= 1.0 + C.x * primFill(j, qw * uScale, C.y);
    else if (kind == 4) env *= 1.0 - C.x * primFill(j, p, C.y);
  }
  float neuHere = neutralGas(p, false);
  float refl = 0.0;
  for (int j = 0; j < ${MAX_PRIMS}; j++) {
    if (j >= uPrN) break;
    vec4 C = uPr[j * 3 + 2];
    if (int(C.z + 0.5) == 2) refl += C.x * primFill(j, p, C.y);
  }
  // Nothing here (a cavity, beyond the outline): the rest is skipped.
  if (env < 0.002 && neuHere < 0.005 && refl < 0.005) return;
  // Gas is pushed and shadowed along the rays from the stars: structure stretched along them.
  vec3 qs = qw + radial * dot(qw, radial) * uP[2].w * 1.5;
  vec4 G = fbm4(qs * freq + uSeed * 1.7, octaves(fp, freq, 8.5));
  // About unit variance; the log-normal's tail is cut at 3 sigma (beyond, one pixel can overflow a half float).
  vec4 Z = clamp((G - 0.5) * 10.0, -3.0, 3.0);
  refl *= exp(0.9 * Z.x);
  // Turbulent ionised gas: log-normal clouds, and thin sheets swept up by shocks (filaments, seen edge on).
  float sigma = uP[2].z;
  float gas = env * exp(sigma * Z.x - 0.5 * sigma * sigma);
  float wisp = env * gauss(Z.y, 0.28) * exp(0.7 * Z.x);
  float n = 0.6 * gas + uP[5].x * wisp;
  // Neutral gas, which carries the dust: the molecular cloud and dark clouds, and globules where the third field peaks.
  float clump = 0.5 + 0.5 * exp(0.7 * Z.x);
  float faceGlow = mix(1.0, uP[4].w, clamp(gCloud / max(neuHere, 1e-4), 0.0, 1.0)) * gGlow;
  float neu = neuHere * clump + env * smoothstep(1.2, 1.45, Z.z + 0.25 * Z.y) * 3.0;

  // Shadows of the neutral gas and the solids, towards the main star. Ionising light dies within a thin skin
  // of neutral gas, so the samples crowd near the point.
  float sh = 0.0;
  for (int j = 0; j < 3; j++) {
    float at = min(0.015 * float((j + 1) * (j + 1) * (j + 1)), r0 * 0.9);
    sh += neutralGas(p + radial * at, true) * (j == 0 ? 2.0 : 1.0);
  }
  // (The main star's light, whose shadows these are; the others light the gas on their own.)
  vec3 dm = uStar[0].xyz - p;
  float main = uStar[0].w / (dot(dm, dm) + 0.0006);
  flux -= main * (1.0 - exp(-3.0 * sh));

  // The gas is ionised where the starlight outweighs recombinations (flux against n^2); the neutral gas only
  // on its skin, where the starlight reaches it: the bright rims of clouds.
  float lit = uP[1].w * flux;
  float x = lit / (1.0 + 3.0 * n * n);
  float ion = smoothstep(0.03, 0.4, x);
  float front = neu * exp(-1.2 * neu) * smoothstep(0.2, 2.0, lit) * 2.2 * faceGlow;
  // Doubly ionised oxygen where the ionisation parameter is high: the hot cores glow teal-green.
  float oiii = uP[1].y * x / (x + 4.0);
  // H-alpha and [N II] (deep red) where the ionisation is low, with H-beta (pink) where it is higher.
  vec3 ha = mix(C_RED, C_HA, smoothstep(0.1, 1.5, x) * (0.5 + 0.5 * G.w));
  e = (n * n * ion) * (ha * (1.0 - 0.8 * oiii) + C_OIII * oiii * 1.4) + front * mix(C_RIM, C_OIII, 0.4 * oiii);

  // Dust: in the neutral gas, a little in the ionised.
  float dust = (neu + 0.05 * n) * uP[1].x;
  // Lit dust: blue starlight near the stars, the nebula's own red light further out (brown).
  float starShare = flux / (flux + 4.0);
  e += dust * (uP[1].z * min(flux, 60.0) * 0.03 * starShare * C_SCAT + uP[5].w * 0.025 * env * C_BROWN);
  // Deep in a cloud, the nebula's light scattered over and over by the dust: a dim brown glow (what is left
  // to see inside the molecular cloud behind the Trapezium, besides its stars).
  e += dust * 0.012 * C_BROWN;
  e += refl * min(flux, 80.0) * 0.25 * C_SCAT;
  k = (dust + refl * 0.3) * 6.0 * C_DUST * (1.0 - smoothstep(0.5, 1.0, r));
}

// Solids: pillars, trunks and globules, too sharp for the baked volume (and for the steps through it), drawn live.
// Each is integrated on its own along the part of the ray near it, in fine steps, and composited into the march
// where the ray passes it. They are opaque dust lit on the side that faces the main star, with a thin layer of
// gas evaporating off that side, glowing: the bright rims and tips of the Pillars of Creation.
vec3 gSolidL[6];
vec3 gSolidT[6];
float gSolidAt[6];
int gSolidN;

void solids(vec3 ro, vec3 rd, float pixel) {
  gSolidN = 0;
  for (int j = 0; j < 6; j++) {
    if (j >= uLiveN) break;
    vec4 A = uPr[j * 3], B = uPr[j * 3 + 1], C = uPr[j * 3 + 2];
    float size = max(A.w, B.w);
    float R = size * (1.5 + 1.5 * C.y);
    // The part of the ray within R of the axis segment: a sphere around it, then a cylinder around its line.
    vec3 ax = B.xyz - A.xyz;
    float al = length(ax);
    vec3 u = al > 1e-6 ? ax / al : vec3(0.0, 0.0, 1.0);
    vec3 oc = ro - (A.xyz + B.xyz) * 0.5;
    float bs = al * 0.5 + R;
    float bb = dot(oc, rd), hh = bb * bb - dot(oc, oc) + bs * bs;
    if (hh <= 0.0) continue;
    hh = sqrt(hh);
    float ta = max(-bb - hh, 0.0), tb = -bb + hh;
    if (tb <= ta) continue;
    vec3 w0 = ro - A.xyz;
    vec3 rp = rd - u * dot(rd, u), wp = w0 - u * dot(w0, u);
    float aa = dot(rp, rp), b2 = dot(wp, rp), h2 = b2 * b2 - aa * (dot(wp, wp) - R * R);
    if (aa > 1e-8) {
      if (h2 <= 0.0) continue;
      h2 = sqrt(h2);
      ta = max(ta, (-b2 - h2) / aa);
      tb = min(tb, (-b2 + h2) / aa);
      if (tb <= ta) continue;
    }
    vec3 L = vec3(0.0), T = vec3(1.0);
    const int N = 16;
    float dt = (tb - ta) / float(N);
    float jit = fract(ign(gl_FragCoord.xy) + float(j) * 0.37);
    vec3 toStar = normalize(uStar[0].xyz - (A.xyz + B.xyz) * 0.5);
    for (int i = 0; i < N; i++) {
      float t = ta + (float(i) + jit) * dt;
      vec3 p = ro + rd * t;
      float d = roundCone(p, A.xyz, B.xyz, A.w, B.w);
      // Its surface, roughened at two scales.
      d += C.y * size * 1.4 * ((n4(p / (size * 0.6) + float(j) * 7.3 + uSeed).x - 0.5) + 0.5 * (n4(p / (size * 0.2) + float(j) * 3.1).y - 0.5));
      // (And finer still, as far as a pixel there resolves it.)
      float fine = clamp(size * 0.07 / max(pixel * t, 1e-9) - 1.0, 0.0, 1.0);
      if (fine > 0.0) d += fine * C.y * size * 0.35 * (n4(p / (size * 0.06) + float(j) * 1.7).z - 0.5);
      vec3 ap = p - A.xyz;
      vec3 nrm = normalize(ap - u * clamp(dot(ap, u), 0.0, al));
      float facing = smoothstep(-0.2, 0.8, dot(nrm, toStar));
      float soft = max(size * 0.1, pixel * t * 1.5);
      float dens = C.x * smoothstep(soft, -soft, d);
      // The evaporating skin, just outside the surface on the lit side.
      // (Brightest at the tip that faces the stars, where the light falls on it squarely.)
      float skin = gauss(d - size * 0.12, size * 0.12 + soft * 0.5) * facing;
      float tip = 1.0 + 1.5 * smoothstep(0.6, 1.0, clamp(dot(ap, u) / max(al, 1e-6), 0.0, 1.0)) * step(0.0, dot(u, toStar));
      vec3 e = C.w * skin * tip * C_RIM * 7.0 + dens * 0.004 * C_BROWN;
      vec3 kk = max(vec3(dens * 6.0 * uP[1].x) * C_DUST, vec3(1e-4));
      vec3 tr = exp(-kk * dt);
      L += T * e * (1.0 - tr) / kk;
      T *= tr;
    }
    gSolidAt[gSolidN] = (ta + tb) * 0.5;
    gSolidL[gSolidN] = L;
    gSolidT[gSolidN] = T;
    gSolidN++;
  }
}
`;

const PN = /* glsl */ `
mat3 turn(float ax, float az) {
  float cx = cos(ax), sx = sin(ax), cz = cos(az), sz = sin(az);
  return mat3(cz, sz, 0.0, -sz, cz, 0.0, 0.0, 0.0, 1.0) * mat3(1.0, 0.0, 0.0, 0.0, cx, sx, 0.0, -sx, cx);
}

// A shell of ionised gas from radius a to b (in whatever radial measure r is). The ionisation falls outwards
// through it: [O III] on the inside, H-alpha throughout, [N II] at the outer edge.
vec3 gO3, gHa, gN2;
void shellLayer(float r, float a, float b, float W, float n0, float knots) {
  float n = n0 * smoothstep(a - W, a + W, r) * (1.0 - smoothstep(b - W, b + W, r));
  float f = clamp((r - a) / max(b - a, 1e-3), 0.0, 1.0);
  float em = n * n;
  gO3 += vec3(em * (1.0 - f) * (1.0 - f));
  gHa += vec3(em * (0.35 + 0.65 * f));
  gN2 += vec3(em * f * f * f * knots);
}

void medium(vec3 p, float fp, float dt, out vec3 e, out vec3 k) {
  vec3 q = p / uScale;
  float r = length(q);
  vec3 dir = q / max(r, 1e-5);
  float W = max(uP[0].w, 0.45 * dt);
  vec4 c1 = n4(q * 6.0 + uSeed);
  vec4 c2 = n4(q * 17.0 + uSeed * 1.3);
  vec4 c3 = n4(q * 41.0 + uSeed * 0.7);
  // Clumpy gas (log-normal), and knots that the fast wind has not yet swept up.
  float clump = exp(uP[1].y * (2.2 * (c1.x - 0.5) + 1.6 * (c2.y - 0.5) + 1.0 * (c3.x - 0.5)));
  float knots = 0.3 + 4.0 * pow(c2.x * c3.y, 2.0) * 4.0;
  float rO = uP[0].x, rH = uP[0].y, rN = uP[0].z;
  gO3 = vec3(0.0); gHa = vec3(0.0); gN2 = vec3(0.0);
  float fill = 0.0, heii = 0.0, halo = 0.0;
  k = vec3(0.0);
  // The edge of a shell wobbles a little, so it is never a perfect ellipse.
  float rw = r * (1.0 + 0.06 * (c1.y - 0.5) + 0.03 * (c2.z - 0.5));
  if (uVariant == 0) {
    // Ring: a barrel along the axis (Z), its walls thickest at the waist; a hot thin bubble inside.
    float eq = 1.0 + uP[1].x * pow(1.0 - dir.z * dir.z, 2.0);
    shellLayer(rw, rO, rN, W, eq * clump, knots);
    fill = 0.42 * (1.0 - smoothstep(rO - 3.0 * W, rO + W, rw)) * (0.7 + 0.6 * c1.w);
    heii = 0.35 * gauss(r, rO * 0.55);
    halo = smoothstep(rN, rN + 0.05, r) * (1.0 - smoothstep(0.7, 1.0, r)) * (0.4 + c1.z) * gauss(fract(r * 7.0 + c1.w * 0.4) - 0.5, 0.25);
  } else if (uVariant == 1) {
    // Dumbbell: a prolate bubble whose caps (along the axis) are bright: the "apple core".
    float lobe = 1.0 + uP[1].w * dir.z * dir.z;
    float rr = rw / lobe;
    float caps = 0.12 + 0.88 * pow(abs(dir.z), 1.4);
    shellLayer(rr, rO * 0.7, rO, W * 2.5, 0.6 * caps * clump, knots);
    fill = 0.75 * caps * (1.0 - smoothstep(rO * 0.8, rO + W, rr)) * (0.6 + 0.8 * c1.w);
    // The faint "football" around it.
    float ball = length(q * vec3(1.0, 1.0, 0.82));
    shellLayer(ball, rH * 0.8, rN, W * 3.0, 0.42 * clump, knots);
    heii = 0.15 * gauss(r, 0.18);
  } else if (uVariant == 2) {
    // Cat's Eye: an elongated bubble crossed by a second, tilted one, inside a halo of concentric shells.
    float A = length(q * vec3(1.0, 1.0, 0.6)) * (1.0 + 0.05 * (c1.y - 0.5));
    vec3 q2 = turn(radians(uP[2].x), radians(uP[2].y)) * q;
    float B = length(q2 * vec3(1.0, 1.9, 0.5)) * (1.0 + 0.05 * (c2.y - 0.5));
    shellLayer(A, rO * 0.75, rO, W, clump, knots);
    shellLayer(B, rH * 0.8, rH, W, uP[2].z * clump, knots * 1.5);
    fill = 0.25 * (1.0 - smoothstep(rO * 0.75 - W, rO * 0.75 + W, A));
    heii = 0.4 * gauss(r, rO * 0.35);
    float rings = pow(0.5 + 0.5 * cos(r * 6.2831853 * uP[2].w + 2.0 * c1.w), 8.0);
    halo = rings * smoothstep(rN, rN + 0.15, r) * (1.0 - smoothstep(0.75, 1.0, r)) * smoothstep(0.3, 0.7, c1.z);
  } else {
    // Helix: an inner disc and an outer ring at another tilt; the inner edge combed into cometary knots.
    float rho = length(q.xy) * (1.0 + 0.05 * (c1.y - 0.5));
    float disc = gauss(q.z, 0.12 + 0.35 * rho);
    shellLayer(rho, rO, rH, W * 2.0, disc * clump, knots);
    vec3 q2 = turn(radians(uP[2].x), radians(uP[2].y)) * q;
    float rho2 = length(q2.xy) * (1.0 + 0.05 * (c2.y - 0.5));
    shellLayer(rho2, rN, rN + 0.17, W * 2.0, uP[2].z * gauss(q2.z, 0.18) * clump, knots);
    fill = 0.3 * (1.0 - smoothstep(rO - W, rO + W, rho)) * gauss(q.z, 0.35);
    // Knots: dense heads lit on the side of the star, tails streaming outwards (stretched radially).
    vec4 kn = n4(vec3(dir.xy * 46.0, rho * 4.0) + uSeed);
    float head = smoothstep(0.78, 0.9, kn.x) * gauss(rho - rO - 0.06, 0.07) * disc;
    gHa += vec3(head * head * 6.0 * uP[1].y);
    k += vec3(head * 30.0 * uP[1].y);
    heii = 0.25 * gauss(r, 0.12);
  }
  gHa += vec3(uP[1].z * 0.05 * halo * (0.5 + c1.w));
  e = C_OIII * (gO3.x * 1.2 + fill * fill * 1.5) + C_RED * (gHa.x * 0.8 + gN2.x * 1.4) + C_HEII * heii * heii * 3.0;
}
`;

const SNR = /* glsl */ `
void medium(vec3 p, float fp, float dt, out vec3 e, out vec3 k) {
  vec3 q = p / uScale;
  float r = length(q);
  vec3 dir = q / max(r, 1e-5);
  k = vec3(0.0);
  if (uVariant == 0) {
    // Crab: synchrotron light of the pulsar wind filling the remnant (blue-white), inside a cage of
    // filaments (H-alpha, [N II], [S II], [O III]): Rayleigh-Taylor fingers where the wind pushes on the ejecta.
    float oct = octaves(fp, 3.0, 6.0);
    vec4 w = n4(q * 1.4 + uSeed) - 0.5;
    vec3 qw = q + w.xyz * 0.3;
    float rr = length(qw);
    vec4 G = fbm4(qw * 2.6 + uSeed, oct);
    vec4 Z = (G - 0.5) * 10.0;
    float shell = smoothstep(0.3, 0.65, rr) * (1.0 - smoothstep(0.82, 1.0, rr));
    // A filament is where two sheets cross: lines in space, a net on the sky.
    float fil = gauss(Z.x, 0.2) * gauss(Z.y, 0.8) * shell;
    float sync = (1.0 - smoothstep(0.15, 0.92, rr)) * (0.7 + 0.4 * G.z) + 0.5 * gauss(Z.w, 0.4) * (1.0 - smoothstep(0.1, 0.7, rr));
    vec3 fc = mix(vec3(1.0, 0.32, 0.1), vec3(0.95, 0.85, 0.35), smoothstep(0.35, 0.65, G.z));
    float torus = gauss(length(q.xz) - 0.09, 0.025) * gauss(q.y, 0.02);
    e = C_SYNC * (sync * sync * uP[1].y * 1.6 + torus * uP[1].w) + fc * fil * uP[1].z * 9.0;
    k = vec3(fil * 4.0);
    return;
  }
  e = vec3(0.0);
}

// A shocked shell (Cygnus Loop, Vela): thin sheets of gas behind the blast wave, folded by the clouds it ran
// into. A sheet is bright where it is seen edge on (its column goes as 1 / |cos| of the angle to the line of
// sight), which draws the filaments. The march finds where the ray crosses each sheet and adds that column,
// so the filaments stay sharp at any step size.
vec3 sheetField(vec3 p) {
  vec3 q = p / uScale;
  float r = length(q);
  vec3 dir = q / max(r, 1e-5);
  float big = fbm(dir * 2.3 + uSeed, 4.0) - 0.5;
  vec4 f1 = n4(q * 7.0 + uSeed);
  vec4 f2 = n4(q * 19.0 + uSeed * 2.0);
  vec4 f3 = n4(q * 47.0 + uSeed * 3.0);
  float s = r - uP[0].x - uP[0].y * (big + 0.5 * (f1.x - 0.5) + 0.32 * (f2.y - 0.5) + 0.12 * (f3.x - 0.5));
  // More sheets behind the first, where the shock wrapped around a cloud.
  return vec3(s, s + 0.03 + 0.06 * (f1.w - 0.5), s - 0.05 + 0.07 * (f2.z - 0.5));
}

void shellMarch(vec3 ro, float ta, float tb, int steps, float jit) {
  if (tb <= ta) return;
  float w = uP[0].z;
  float dt = (tb - ta) / float(steps);
  // The longest path through a sheet, seen exactly edge on.
  float cap = w * 1.772 / (2.0 * sqrt(2.0 * uP[0].x * w));
  float tp = ta + jit * dt;
  vec3 a = sheetField(ro + gRd * tp);
  for (int i = 1; i < 128; i++) {
    if (i > steps) break;
    float t = ta + (float(i) + jit) * dt;
    vec3 b = sheetField(ro + gRd * t);
    // Levels: H-alpha at the first sheet, [O III] just ahead of it (hotter gas right behind the shock), two more sheets.
    vec4 la = vec4(a.x, a.x - 2.0 * w, a.y, a.z), lb = vec4(b.x, b.x - 2.0 * w, b.y, b.z);
    bvec4 hit = lessThan(la * lb, vec4(0.0));
    if (any(hit)) {
      vec3 c = vec3(0.0);
      for (int j = 0; j < 4; j++) {
        if (!hit[j]) continue;
        float f = la[j] / (la[j] - lb[j]);
        vec3 pc = ro + gRd * (tp + f * dt);
        vec3 q = pc / uScale;
        vec3 dir = normalize(q);
        float col = w * 1.772 / max(abs(lb[j] - la[j]) / dt, cap);
        // Where the blast meets denser clouds the sheets are bright: the arcs of the Veil.
        // (uP[1].w favours two opposite limbs, as the Veil's eastern and western arcs.)
        float arcs = smoothstep(uP[0].w - 0.03, uP[0].w + 0.07, fbm(dir * 1.7 + uSeed + 3.1, 3.0) + uP[1].w * 0.12 * (abs(dir.x) - 0.6));
        vec4 m = n4(q * 5.0 + 1.7);
        float along = 0.08 + 2.4 * m.x * m.x * m.x;
        vec3 tint = j == 0 ? C_RED * (1.0 - 0.3 * uP[1].x) : j == 1 ? C_OIII * uP[1].x
          : j == 2 ? C_RED * 0.7 * m.y : C_OIII * uP[1].x * 0.6 * m.z;
        c += tint * col * arcs * along;
      }
      gL += c;
    }
    a = b;
    tp = t;
  }
}
`;

const REFL = /* glsl */ `
void medium(vec3 p, float fp, float dt, out vec3 e, out vec3 k) {
  vec3 q = p / uScale;
  float r = length(q);
  float freq = uP[0].z;
  // Dust streaked in one direction (the cloud is sheared as the cluster ploughs through it).
  vec3 qs = q * vec3(1.0 / uP[0].y, 1.0, 1.0);
  vec4 w = n4(q * 1.3 + uSeed) - 0.5;
  float g = fbm((qs + w.xyz * 0.25) * freq + uSeed, octaves(fp, freq * 2.0, 6.0));
  float d = uP[0].x * (1.0 - smoothstep(0.45, 1.0, r)) * exp(3.2 * (g - 0.5)) * smoothstep(0.3, 0.6, g);
  vec3 light = vec3(0.0);
  float gg = uP[0].w;
  for (int i = 0; i < ${MAX_STARS}; i++) {
    if (i >= uStarN) break;
    vec3 ds = p - uStar[i].xyz;
    float d2 = dot(ds, ds) + 0.0004;
    float mu = dot(ds * inversesqrt(d2), -gRd);
    float hg = (1.0 - gg * gg) / pow(1.0 + gg * gg - 2.0 * gg * mu, 1.5);
    light += uStarCol[i] * (uStar[i].w * hg / d2);
  }
  e = d * light * C_SCAT;
  k = d * 0.8 * C_DUST;
}
`;

const MAIN = /* glsl */ `
// Small bright knots integrated exactly along the ray (an isotropic Gaussian has a closed form): the
// Homunculus around Eta Carinae, the Hourglass, the brightest cores. (xyz, sigma), (rgb, amount).
uniform vec4 uGlow[${MAX_GLOWS * 2}];
uniform int uGlowN;
float gGlowT[${MAX_GLOWS}];
vec3 gGlowL[${MAX_GLOWS}];
bool gGlowDone[${MAX_GLOWS}];

void glows(vec3 ro, float t0, float t1) {
  for (int i = 0; i < ${MAX_GLOWS}; i++) {
    gGlowDone[i] = true;
    if (i >= uGlowN) continue;
    vec4 c = uGlow[i * 2];
    float tc = dot(c.xyz - ro, gRd);
    gGlowT[i] = tc;
    vec3 off = ro + gRd * tc - c.xyz;
    float d2 = dot(off, off) / (c.w * c.w);
    if (d2 > 25.0 || tc < t0 - 3.0 * c.w || tc > t1 + 3.0 * c.w) continue;
    gGlowDone[i] = false;
    gGlowL[i] = uGlow[i * 2 + 1].rgb * uGlow[i * 2 + 1].a * c.w * 1.7725 * exp(-d2);
  }
}

// Lay what lies before distance t along the ray (glows, solids) over what has been gathered so far.
void passTo(float t) {
  for (int i = 0; i < ${MAX_GLOWS}; i++) {
    if (gGlowDone[i] || gGlowT[i] > t) continue;
    gL += gT * gGlowL[i];
    gGlowDone[i] = true;
  }
#ifdef SOLIDS
  for (int j = 0; j < 6; j++) {
    if (j >= gSolidN) break;
    if (gSolidAt[j] > t) continue;
    gL += gT * gSolidL[j];
    gT *= gSolidT[j];
    gSolidAt[j] = 1e30;
    gSolidL[j] = vec3(0.0);
    gSolidT[j] = vec3(1.0);
  }
#endif
}

void marchSpan(vec3 ro, float ta, float tb, int steps, float jit) {
  if (tb <= ta) return;
  // Steps crowd around the closest approach to the main star (equiangular sampling: it matches the
  // inverse-square fall of its light), and spread out evenly when the ray passes far from it.
  float tc = dot(uFocus.xyz - ro, gRd);
  float D = max(length(ro + gRd * tc - uFocus.xyz), uFocus.w);
#ifdef BAKED_VOLUME
  // (A baked volume has the same detail everywhere: even steps.)
  D = 1e3;
#endif
  float aa = atan((ta - tc) / D), ab = atan((tb - tc) / D);
  float da = (ab - aa) / float(steps);
  for (int i = 0; i < 128; i++) {
    if (i >= steps) break;
    float th = aa + (float(i) + jit) * da;
    float c = cos(th);
    float t = tc + D * tan(th);
    float dt = D * da / (c * c);
    vec3 e, k;
    passTo(t);
    SAMPLE(ro + gRd * t, t * uPixel, dt, e, k);
    // Light emitted along the step, dimmed by the dust of the step itself.
    vec3 kk = max(k, vec3(1e-4));
    vec3 tr = exp(-kk * dt);
    gL += gT * e * (1.0 - tr) / kk;
    gT *= tr;
    if (max(gT.r, max(gT.g, gT.b)) < 0.01) break;
  }
}

void main() {
  gRd = normalize(uToLocal * vRay);
  vec3 ro = uEye;
  float b = dot(ro, gRd);
  float h = b * b - dot(ro, ro) + 1.0;
  if (h <= 0.0) discard;
  h = sqrt(h);
  float t0 = max(-b - h, 0.0), t1 = -b + h;
  if (t1 <= 0.0) discard;
  gL = vec3(0.0);
  gT = vec3(1.0);
  glows(ro, t0, t1);
#ifdef SOLIDS
  solids(ro, gRd, uPixel);
#endif
  float jit = ign(gl_FragCoord.xy);
  int steps = int(uSteps);
#ifdef SHELL
  // Only the band the shell's sheets can be in is worth stepping through.
  if (uVariant != 0) {
    vec3 sro = ro / uScale, srd = gRd / uScale;
    float A = dot(srd, srd), B = dot(sro, srd), C0 = dot(sro, sro);
    float rin = uP[0].x - 1.2 * uP[0].y - 0.08;
    float hin = B * B - A * (C0 - rin * rin);
    if (hin > 0.0) {
      hin = sqrt(hin);
      float ia = (-B - hin) / A, ib = (-B + hin) / A;
      shellMarch(ro, t0, min(ia, t1), steps / 2, jit);
      shellMarch(ro, max(ib, t0), t1, steps / 2, jit);
    } else {
      shellMarch(ro, t0, t1, steps, jit);
    }
  } else {
    marchSpan(ro, t0, t1, steps, jit);
  }
#else
  marchSpan(ro, t0, t1, steps, jit);
#endif
  passTo(1e29);
  float a = (1.0 - (gT.r + gT.g + gT.b) / 3.0) * uDust;
  // (Into half floats: a single overflowing pixel would be spread over the whole frame by the bloom.)
  gl_FragColor = vec4(min(gL * uGain, vec3(6e4)), a) * uWeight;
}
`;

// The baked volume: emission (rgb, at unit gain) and dust (a, extinction per radius) of the model on a grid
// over its bounding cube, marched instead of the model, with finer detail laid over it near the camera.
const BAKED = /* glsl */ `
uniform highp sampler3D uVol;
uniform float uVoxel;   // grid spacing, radii
// A finer level around the camera: centre and half-size (radii; 0: none), its own grid spacing.
uniform highp sampler3D uFine;
uniform vec4 uFineBox;
uniform float uFineVoxel;
void baked(vec3 p, float fp, float dt, out vec3 e, out vec3 k) {
  vec4 v = textureLod(uVol, p * 0.5 + 0.5, 0.0);
  float voxel = uVoxel;
  if (uFineBox.w > 0.0) {
    vec3 f = (p - uFineBox.xyz) / uFineBox.w;
    float edge = max(abs(f.x), max(abs(f.y), abs(f.z)));
    if (edge < 1.0) {
      float w = 1.0 - smoothstep(0.7, 0.95, edge);
      v = mix(v, textureLod(uFine, f * 0.5 + 0.5, 0.0), w);
      voxel = mix(uVoxel, uFineVoxel, w);
    }
  }
  // Below the grid's resolution, more of the same turbulence: a log-normal factor on the density
  // (squared for the emission), fading in as the footprint of a pixel gets finer than the grid.
  // (Never finer than the steps either: detail between two samples only shows up as speckle.)
  float more = clamp(log2(voxel / max(max(fp, dt * 0.7), 1e-6)), 0.0, 2.0);
  float m = 1.0;
  if (more > 0.0 && v.a + v.r > 1e-5) {
    // Filaments (thin sheets, where a field crosses its middle) more than blobs: what turbulent gas shows close up.
    vec3 dq = p * (1.2 / voxel) + uSeed;
    vec4 a = n4(dq), b = n4(ROT * dq * 2.1);
    float sheet = exp(-pow((a.x - 0.5) * 7.0, 2.0)) * 0.8 + 0.5 * clamp(more - 1.0, 0.0, 1.0) * exp(-pow((b.y - 0.5) * 7.0, 2.0));
    float z = 1.4 * (sheet - 0.35) + 0.6 * (a.z - 0.5);
    m = exp(z * min(more, 1.0));
  }
  e = v.rgb * m * m;
  k = v.a * m * C_DUST;
}
`;

const BAKE_MAIN = /* glsl */ `
uniform float uLayer;
uniform float uN;
uniform vec4 uBox;   // the cube baked: centre, half-size (radii)
void main() {
  vec3 p = uBox.xyz + (vec3(gl_FragCoord.xy, uLayer + 0.5) / uN * 2.0 - 1.0) * uBox.w;
  gRd = vec3(0.0, 0.0, -1.0);
  vec3 e, k;
  float voxel = 2.0 * uBox.w / uN;
  medium(p, voxel * 0.5, voxel, e, k);
  // (Half floats: keep it finite.)
  gl_FragColor = vec4(min(e, vec3(3e3)), min(k.g, 3e3));
}
`;

export const BAKE_VERT = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export type Family = 'hii' | 'pn' | 'snr' | 'refl';
/** march: the model itself; baked: its baked volume; bake: one layer of that volume. */
export type Mode = 'march' | 'baked' | 'bake';

export function nebulaFragment(family: Family, mode: Mode = 'march'): string {
  const body = family === 'hii' ? HII : family === 'pn' ? PN : family === 'snr' ? SNR : REFL;
  const shell = (family === 'snr' ? '#define SHELL\n' : '') + (family === 'hii' ? '#define SOLIDS\n' : '');
  if (mode === 'bake') return `${COMMON}${body}${BAKE_MAIN}`;
  if (mode === 'baked') return `${shell}#define SAMPLE baked\n#define BAKED_VOLUME\n${COMMON}${body}${BAKED}${MAIN}`;
  return `${shell}#define SAMPLE medium\n${COMMON}${body}${MAIN}`;
}
