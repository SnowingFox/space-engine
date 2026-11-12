import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { B_CRIT, TABLE_COLS, TABLE_ROWS, W_IN, W_OUT, rowImpact, tableTextures } from './geodesics';
import { X_V } from '../universe/blackHoles';
import { SHADOW_BINS } from '../universe/kerr';

// Gravitational lensing by a black hole as a screen-space pass, plus its accretion disc, corona and jet, traced
// along the same light paths. Per pixel: the view ray's impact parameter b and the swept azimuth from the tables
// in geodesics.ts give where the ray ends up at infinity (sampled from the frame, or from a cube map of the
// background when that direction is off screen) or that it falls in; the disc plane's crossings along the path
// (the direct image, the lensed far side above and below the hole, the photon ring) come from the same tables.
//
// Spin (an approximation, see kerr.ts): the light paths are Schwarzschild's, with the impact parameter rescaled
// per direction on the sky so that the critical curve (the shadow's edge) is the Kerr one, flattened and shifted
// towards the side where the disc comes at us; far from the edge the rescaling fades out. Radii near the hole
// are remapped the same way (3 M, the Schwarzschild photon orbit, to the Kerr photon orbit behind that part of
// the edge), so the disc can reach in to the Kerr ISCO on the prograde side. Disc gas: Kerr circular orbits,
// Omega = 1 / (r^1.5 + a), redshift g = 1 / (u^t (1 - Omega lambda)) for a camera at rest (Bardeen, Press &
// Teukolsky 1972; Cunningham 1975; Luminet 1979). Light: Shakura & Sunyaev (1973) temperature profile from the
// ISCO, colour of a blackbody at g T, visible intensity g^3 B_550nm(T) (no compression), scaled so the disc's
// light as a whole matches the point of light it is from afar (blackHole.ts).
//
// Compiled twice: as the lens (before bloom) and, with MASK defined, as the shadow mask drawn after bloom, which
// darkens the pixels where rays fall in so the bloom of the disc around it does not fill the shadow with grey.

export interface LensParams {
  /** Camera relative to the hole, in Schwarzschild radii (universe axes). */
  cam: THREE.Vector3;
  axis: THREE.Vector3;
  /** Cosine of the angle from the hole beyond which the frame passes through untouched. */
  reachCos: number;
  /** Cosine of the shadow's angular radius (with a margin): the mask pass works inside it. */
  shadowCos: number;
  /** rIn (M: the ISCO, or where a faint disc is truncated), rOut (r_s), peak temperature (K), peak brightness (0: no disc). */
  disc: THREE.Vector4;
  opacity: number;
  /** Spin a, prograde ISCO (M), sin of the inclination of the camera to the spin axis. */
  spin: THREE.Vector3;
  /** The shadow's edge and the photon orbit behind it over cos(chi), see kerr.ts shadowTable. */
  shadow: Float32Array;
  /** Rotation of the gas at the inner edge since t = 0 (radians, wrapped) and in one frame (for the blur). */
  phase: number;
  step: number;
  /** Corona: brightness, scale radius (r_s), colour temperature (K). */
  corona: THREE.Vector3;
  /** length (r_s), Lorentz factor, brightness (0: no jet). */
  jet: THREE.Vector4;
  knots: THREE.Vector2[];
  /** The hole's own light as a point while too small to trace: colour times intensity, and size in device pixels. */
  point: THREE.Vector4;
  /** A body in front that hides it, unlensed (the companion star): centre relative to the camera (r_s), radius (0: none). */
  occluder: THREE.Vector4;
  /** Screen rectangle of the shadow for the mask pass, device pixels: x, y, width, height (width 0: none). */
  shadowRect: THREE.Vector4;
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
uniform float uShadowCos;
uniform vec4 uDisc;
uniform float uOpacity;
uniform vec3 uSpin;
uniform vec2 uShadow[${SHADOW_BINS}];
uniform float uPhase;
uniform float uStep;
uniform vec3 uCorona;
uniform vec4 uJet;
uniform vec2 uKnots[8];
uniform vec4 uPoint;
uniform vec4 uOcc;
varying vec2 vUv;

const float PI = 3.14159265358979;
const float BC = ${B_CRIT.toFixed(9)};
const float BMAX = ${rowImpact(false, TABLE_ROWS - 1).toFixed(3)};
const vec2 WOUT = vec2(${W_OUT[0].toFixed(1)}, ${W_OUT[1].toFixed(1)});
const vec2 WIN = vec2(${W_IN[0].toFixed(1)}, ${W_IN[1].toFixed(1)});
const float COLS = ${TABLE_COLS.toFixed(1)};
const float ROWS = ${TABLE_ROWS.toFixed(1)};
const int BINS = ${SHADOW_BINS};

float rowOut(float b) { return (clamp((log(b / BC - 1.0) - WOUT.x) / (WOUT.y - WOUT.x), 0.0, 1.0) * (ROWS - 1.0) + 0.5) / ROWS; }
float rowIn(float b) { return (clamp((log(max(1.0 - b / BC, 1e-30)) - WIN.x) / (WIN.y - WIN.x), 0.0, 1.0) * (ROWS - 1.0) + 0.5) / ROWS; }
vec4 tab(sampler2D t, float col, float row) { return texture(t, vec2((clamp(col, 0.0, 1.0) * (COLS - 1.0) + 0.5) / COLS, row)); }

// The Kerr shadow's edge (r_s) and photon orbit (M) in a direction on the sky, cos(chi) from -1 (prograde) to 1.
vec2 kerrEdge(float c) {
  float x = (clamp(c, -1.0, 1.0) * 0.5 + 0.5) * float(BINS - 1);
  int i = int(min(floor(x), float(BINS - 2)));
  return mix(uShadow[i], uShadow[i + 1], x - float(i));
}

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

// e^y - 1 without losing it for small y (a disc of ten million kelvin, seen at 550 nm).
float em1(float y) { return y < 1e-3 ? y * (1.0 + 0.5 * y) : exp(min(y, 80.0)) - 1.0; }

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

// Turbulent clumps carried round with the gas at radius r (M) and azimuth az. The gas turns differentially, so a
// pattern that only rotated would wind up into rings within a few orbits; instead two generations of clumps,
// each sheared by the orbits for half a turn, take over from one another (and are reseeded each time).
float clumps(float az, float rK, float lr) {
  float a = uSpin.x;
  float turns = uPhase * (pow(uDisc.x, 1.5) + a) / (pow(rK, 1.5) + a) / 6.2831853;
  float sum = 0.0;
  for (int j = 0; j < 2; j++) {
    float cyc = turns * 2.0 + 0.5 * float(j);
    float c = floor(cyc), f = fract(cyc);
    float am = az - 6.2831853 * 0.5 * f;
    // (Longer along the orbit than across it: clumps drawn out by the shear.)
    vec3 q = vec3(cos(am) * 4.0, sin(am) * 4.0, lr * 11.0) + c * vec3(3.7, 1.9, 5.3) + float(j) * 11.0;
    float n = 0.55 * noise(q) + 0.3 * noise(q * vec3(2.3, 2.3, 2.9) + 4.2) + 0.15 * noise(q * vec3(5.1, 5.1, 6.3) + 9.1);
    sum += (1.0 - abs(2.0 * f - 1.0)) * n;
  }
  return sum;
}

#ifndef MASK
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
  return mix(textureLod(tCube, dir, lod).rgb, frame, w);
}
#endif

// One view ray: whether it falls in, where it ends up at infinity, and the light of the disc and corona along it.
bool traceRay(vec3 d, float ro, vec3 er, out vec3 outDir, out vec3 col, out float trans, out float bOut) {
  float cosA0 = -dot(d, er);
  col = vec3(0.0);
  trans = 1.0;
  outDir = d;
  bool captured = false;
  float uo = 1.0 / ro;
  vec3 et = d + cosA0 * er;
  float sinA0 = length(et);
  et = sinA0 > 1e-12 ? et / sinA0 : normalize(cross(er, abs(er.y) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0)));
  float alpha0 = atan(sinA0, cosA0);
  float bTrue = ro * sinA0 / sqrt(1.0 - uo);
  // The ray's angular momentum about the spin axis decides which part of the Kerr shadow's edge it is near.
  vec3 L = cross(er, et);
  float ln = dot(L, uAxis);
  vec2 edge = kerrEdge(ln / max(uSpin.z, 1e-3));
  float b = bTrue * mix(BC / edge.x, 1.0, smoothstep(edge.x, 3.0 * edge.x, bTrue));
  bOut = b;
  // The Schwarzschild ray with that impact parameter, leaving the camera at its own angle to the hole.
  float sinA = min(b * sqrt(1.0 - uo) / ro, 1.0);
  float cosA = sign(cosA0) * sqrt(max(1.0 - sinA * sinA, 0.0));
  float alpha = atan(sinA, cosA);
  float psi = PI - alpha;
  bool inward = cosA0 > 0.0;
  float delta = 0.0;
  float phiObs = 0.0, phiEnd = 0.0, phiP = 1.0, up = 1.0, row = 0.0, rMin = ro;
  int mode;
  if (b >= BMAX) {
    // Weak field: 2 r_s / b in all, of which (1 + cos(alpha)) r_s / b on the way from here to infinity.
    mode = 0;
    delta = (1.0 + cosA) / b;
    phiEnd = alpha;
    rMin = inward ? b : ro;
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
      rMin = 1.0 / up;
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
      rMin = 1.0;
    } else {
      mode = 3;
      delta = phiO - psi;
      phiEnd = phiO;
    }
  }

  // The photon's angular momentum about the spin axis (it travels opposite to the traced ray), in M: from its
  // true impact parameter, the Kerr one (the warped one only stands in for it in the Schwarzschild tables).
  float lamM = -2.0 * bTrue * ln;
  if (uDisc.w > 0.0) {
    float A = dot(er, uAxis), B = dot(et, uAxis);
    float phi0 = atan(-A, B);
    if (phi0 < 1e-5) phi0 += PI;
    if (phi0 < 1e-5) phi0 += PI;
    float a = uSpin.x;
    float rIn = uDisc.x;
    float rPeak = rIn * 49.0 / 36.0;
    float fMax = pow(rPeak, -0.75) * pow(1.0 - sqrt(rIn / rPeak), 0.25);
    float rOutM = 2.0 * uDisc.y;
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
      // Schwarzschild radius (r_s) to the Kerr one (M): the photon orbit at 3 M moves to the Kerr orbit behind this part of the edge.
      float rS = 2.0 * r;
      float rK = rS - (3.0 - edge.y) * 9.0 / (rS * rS);
      if (rK <= rIn * 0.995 || rK >= rOutM) continue;
      float x = sqrt(rK);
      float om = 1.0 / (rK * x + a);
      float ut = (rK * x + a) / (pow(rK, 0.75) * sqrt(max(rK * x - 3.0 * x + 2.0 * a, 1e-6)));
      // (The rescaled paths only approximate Kerr's: a ray can come out with more angular momentum than one from
      // there could carry, which would blueshift it without bound. Held to what orbital speeds near the ISCO give.)
      float g = 1.0 / (ut * max(1.0 - om * lamM, 0.4) * sqrt(1.0 - uo));
      float f = pow(rK, -0.75) * pow(max(1.0 - sqrt(rIn / rK), 0.0), 0.25) / fMax;
      vec3 pos = cos(phi) * er + sin(phi) * et;
      float az = atan(dot(pos, uE2), dot(pos, uE1));
      float lr = log(rK);
      // Clumps carried with the gas; smeared out only when the clock runs so fast they would flicker.
      float blur = smoothstep(0.3, 2.0, uStep * (pow(rIn, 1.5) + a) / (rK * x + a));
      float cl = mix(clumps(az, rK, lr), 0.5, blur);
      float tex = 0.35 + 1.3 * smoothstep(0.2, 0.85, cl);
      // Two-armed trailing spiral density waves, turning at a fifth of the inner edge's rate.
      float wave = 0.5 + 0.5 * cos(2.0 * (az - 0.2 * uPhase) + 4.5 * lr);
      tex *= 0.78 + 0.5 * wave * wave;
      // Thin near the hole, flaring and thinning out towards the edge: seen at a grazing angle the outer disc
      // stops more light (and shows more of its own) than seen face-on.
      float cosInc = abs(-sin(phi) * A + cos(phi) * B) * min(b * sqrt(max(1.0 - 1.0 / r, 0.0)) / r, 1.0);
      float tau = 3.0 * (1.0 - smoothstep(0.1 * rOutM, rOutM, rK)) * smoothstep(rIn * 0.995, rIn * 1.04, rK);
      float aOp = uOpacity * (1.0 - exp(-tau / max(cosInc, 0.03)));
      // Visible light: Planck at 550 nm for the gas's temperature, shifted by g (I_nu / nu^3 is invariant),
      // relative to the disc's peak: g^3 (e^(X / Tpeak) - 1) / (e^(X / (g T)) - 1).
      float tObs = uDisc.z * g * f;
      vec3 light = blackbody(tObs) * uDisc.w * g * g * g * em1(${X_V.toFixed(1)} / uDisc.z) / em1(${X_V.toFixed(1)} / max(tObs, 1.0)) * tex;
      // (Its own light follows how much of it there is along the ray, not the flow's overall transparency.)
      col += trans * (aOp / max(uOpacity, 1e-3)) * light;
      trans *= 1.0 - aOp;
    }
  }

  // The corona: hot, thin gas around the inner disc. Its light along a path is the emissivity (~ r^-2 e^(-r/rc))
  // integrated over the azimuth swept, so rays that wind round the photon sphere gather the most: a glow that
  // peaks at the shadow's edge. (None from rays that fall in: the shadow stays black.)
  if (uCorona.x > 0.0 && !captured) {
    float sweep = max(phiEnd, 0.0);
    float glow = uCorona.x * (sweep / PI) * (BC / max(b, BC)) * exp(-max(rMin - 1.5, 0.0) / uCorona.y);
    col += blackbody(uCorona.z) * glow * (0.4 + 0.6 * trans);
  }

  if (!captured) outDir = cos(delta + alpha0 - alpha) * d + sin(delta + alpha0 - alpha) * (-sinA0 * er - cosA0 * et);
  return captured;
}

// A body between the camera and the hole (the companion star): it is in front of the lens, not seen through it.
bool occluded(vec3 d, float ro) {
  if (uOcc.w <= 0.0) return false;
  float t = dot(d, uOcc.xyz);
  if (t <= 0.0) return false;
  float h2 = dot(uOcc.xyz, uOcc.xyz) - t * t;
  float r2 = uOcc.w * uOcc.w;
  return h2 < r2 && t - sqrt(r2 - h2) < ro;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 d = normalize(uViewToWorld * vec3(ndc * uTan, -1.0));
  float ro = length(uCam);
  vec3 er = uCam / ro;
  float cosA = -dot(d, er);
#ifdef MASK
  // How much of this pixel is shadow (rays falling in with nothing in front): the frame there is darkened.
  float m = 0.0;
  if (cosA >= uShadowCos && !occluded(d, ro)) {
    vec3 o, c;
    float t, b;
    bool in0 = traceRay(d, ro, er, o, c, t, b);
    if (b < 0.9 * BC || b > 1.1 * BC) {
      // Well inside or outside the edge: one ray says it all.
      m = in0 ? t : 0.0;
    } else {
      for (int i = 0; i < 4; i++) {
        vec2 off = (vec2(float(i & 1), float(i >> 1)) - 0.5) * 0.5 * (2.0 / uRes);
        vec3 d2 = normalize(uViewToWorld * vec3((ndc + off) * uTan, -1.0));
        if (traceRay(d2, ro, er, o, c, t, b)) m += 0.25 * t;
      }
    }
  }
  gl_FragColor = vec4(vec3(1.0 - m), 1.0);
#else
  vec3 col = vec3(0.0);
  float trans = 1.0;
  bool captured = false;
  bool lensed = cosA >= uReachCos && !occluded(d, ro);
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
#endif
}
`;

const CUBE_SIZE = 512;
/** Cube texels per radian at the centre of a face. */
const CUBE_PPR = CUBE_SIZE / 2;
/** Frames between refreshes of one cube face. */
const CUBE_FACE_EVERY = 5;

function uniforms(cube: THREE.Texture): Record<string, THREE.IUniform> {
  return {
    tFrame: { value: null }, tCube: { value: cube }, uCubeOn: { value: 0 },
    tOut: { value: null }, tIn: { value: null },
    uViewToWorld: { value: new THREE.Matrix3() }, uWorldToView: { value: new THREE.Matrix3() }, uTan: { value: new THREE.Vector2() },
    uPix: { value: 1e-3 }, uRes: { value: new THREE.Vector2(1, 1) }, uCam: { value: new THREE.Vector3(0, 0, 100) }, uAxis: { value: new THREE.Vector3(0, 1, 0) },
    uE1: { value: new THREE.Vector3(1, 0, 0) }, uE2: { value: new THREE.Vector3(0, 0, 1) }, uReachCos: { value: 0.9 }, uShadowCos: { value: 1 },
    uDisc: { value: new THREE.Vector4() }, uOpacity: { value: 1 }, uSpin: { value: new THREE.Vector3(0, 6, 1) },
    uShadow: { value: Array.from({ length: SHADOW_BINS }, () => new THREE.Vector2(B_CRIT, 3)) },
    uPhase: { value: 0 }, uStep: { value: 0 }, uCorona: { value: new THREE.Vector3() }, uJet: { value: new THREE.Vector4() },
    uKnots: { value: Array.from({ length: 8 }, () => new THREE.Vector2()) }, uPoint: { value: new THREE.Vector4() },
    uOcc: { value: new THREE.Vector4() },
  };
}

/** After bloom: darkens the shadows again (the lens pass leaves its parameters for it). */
export class ShadowMaskPass extends Pass {
  constructor(private readonly lens: LensPass) {
    super();
    this.needsSwap = false;
    this.enabled = false;
  }

  render(renderer: THREE.WebGLRenderer, _writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    this.lens.renderMasks(renderer, readBuffer);
  }

  setSize(): void { /* full-screen quad */ }
}

export class LensPass extends Pass {
  private readonly quad: FullScreenQuad;
  private readonly maskQuad: FullScreenQuad;
  private readonly material: THREE.ShaderMaterial;
  private readonly maskMaterial: THREE.ShaderMaterial;
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
  /** The pass after bloom that keeps the shadows black (added to the composer by the pipeline). */
  readonly mask = new ShadowMaskPass(this);

  constructor(private readonly bgScene: THREE.Scene) {
    super();
    const u = uniforms(this.cube.texture);
    this.material = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: u, depthTest: false, depthWrite: false });
    // The mask multiplies the frame (dst * src): one minus the shadow's share of each pixel.
    this.maskMaterial = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: u, defines: { MASK: 1 }, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor, transparent: true,
    });
    this.quad = new FullScreenQuad(this.material);
    this.maskQuad = new FullScreenQuad(this.maskMaterial);
    // The soft layer too: its glows are drawn straight into the faces.
    for (const c of this.cubeCamera.children) c.layers.enableAll();
    this.enabled = false;
  }

  /** Builds the tables and compiles both shaders now, so the first black hole in view costs no stall. */
  warm(renderer: THREE.WebGLRenderer): void {
    this.ensureTables(renderer);
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
    const u = this.material.uniforms;
    u.uDisc.value.set(3, 100, 6000, 1);
    u.uJet.value.set(1e5, 3, 1, 1);
    u.uCorona.value.set(1, 5, 1e5);
    renderer.setRenderTarget(rt);
    this.quad.render(renderer);
    this.maskQuad.render(renderer);
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

  private setView(width: number, height: number): void {
    const u = this.material.uniforms;
    const m = new THREE.Matrix4().makeRotationFromQuaternion(this.view);
    u.uViewToWorld.value.setFromMatrix4(m);
    u.uWorldToView.value.copy(u.uViewToWorld.value).transpose();
    u.uTan.value.copy(this.tan);
    u.uPix.value = this.pixelAngle;
    u.uRes.value.set(width, height);
  }

  private setHole(h: LensParams): void {
    const u = this.material.uniforms;
    u.uCam.value.copy(h.cam);
    u.uAxis.value.copy(h.axis);
    const e1 = u.uE1.value as THREE.Vector3;
    e1.set(0, 1, 0).cross(h.axis);
    if (e1.lengthSq() < 1e-6) e1.set(1, 0, 0).cross(h.axis);
    e1.normalize();
    u.uE2.value.crossVectors(h.axis, e1);
    u.uReachCos.value = h.reachCos;
    u.uShadowCos.value = h.shadowCos;
    u.uDisc.value.copy(h.disc);
    u.uOpacity.value = h.opacity;
    u.uSpin.value.copy(h.spin);
    for (let k = 0; k < SHADOW_BINS; k++) u.uShadow.value[k].set(h.shadow[k * 2], h.shadow[k * 2 + 1]);
    u.uPhase.value = h.phase;
    u.uStep.value = h.step;
    u.uCorona.value.copy(h.corona);
    u.uJet.value.copy(h.jet);
    u.uPoint.value.copy(h.point);
    u.uOcc.value.copy(h.occluder);
    for (let k = 0; k < 8; k++) u.uKnots.value[k].copy(h.knots[k] ?? ZERO2);
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    this.ensureTables(renderer);
    const u = this.material.uniforms;
    if (this.useCube) this.updateCube(renderer);
    else this.cubeValid = false;
    u.uCubeOn.value = this.useCube ? 1 : 0;
    this.setView(readBuffer.width, readBuffer.height);
    let src = readBuffer, dst = writeBuffer;
    this.holes.forEach((h, i) => {
      u.tFrame.value = src.texture;
      this.setHole(h);
      const last = i === this.holes.length - 1;
      renderer.setRenderTarget(this.renderToScreen && last ? null : dst);
      this.quad.render(renderer);
      [src, dst] = [dst, src];
    });
    // With an even number of draws the result is back in the read buffer.
    this.needsSwap = this.holes.length % 2 === 1;
    this.mask.enabled = this.holes.some((h) => h.shadowRect.z > 0);
  }

  /** The shadow masks, multiplied into the frame after bloom, each only over its shadow's rectangle. */
  renderMasks(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget): void {
    this.setView(target.width, target.height);
    // (Drawn over the frame: no clearing first.)
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(target);
    for (const h of this.holes) {
      const r = h.shadowRect;
      if (r.z <= 0) continue;
      this.setHole(h);
      // (A render target's scissor is in its own pixels.)
      target.scissor.set(r.x, r.y, r.z, r.w);
      target.scissorTest = true;
      renderer.setRenderTarget(target);
      this.maskQuad.render(renderer);
      target.scissorTest = false;
    }
    renderer.setRenderTarget(target);
    renderer.autoClear = autoClear;
  }

  setSize(): void { /* full-screen quad: nothing to resize */ }

  dispose(): void {
    this.material.dispose();
    this.maskMaterial.dispose();
    this.quad.dispose();
    this.maskQuad.dispose();
    this.cube.dispose();
  }
}

const ZERO2 = new THREE.Vector2();
