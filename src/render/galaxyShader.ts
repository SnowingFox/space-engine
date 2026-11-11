import * as THREE from 'three';
import { Rng } from '../core/rng';
import { NOISE } from './glsl';

// The march reads its clouds from a tiling volume of random values: one filtered fetch per
// octave instead of eight hashes, which is most of what a galaxy costs to draw.
const NOISE_SIZE = 128;

function makeNoise(): THREE.Data3DTexture {
  const rng = new Rng(977);
  const data = new Uint8Array(NOISE_SIZE ** 3);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(rng.next() * 256);
  const texture = new THREE.Data3DTexture(data, NOISE_SIZE, NOISE_SIZE, NOISE_SIZE);
  texture.format = THREE.RedFormat;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

/** Bind as the uniform uNoise of every material that includes GALAXY_GLSL. */
export const galaxyNoise = makeNoise();

// One model of a galaxy's light, marched along view rays. It is used twice: into a cube
// map for the galaxy the camera is inside or close to, and directly on a billboard for
// every galaxy further away, so a galaxy looks the same before and after the hand-over.
//
// Per galaxy, in its own frame (disc in the XZ plane, units of light years):
//   gA = radius, disc scale length, stellar scale height, bulge scale
//   gB = arm count, 1 / tan(arm pitch), arm contrast, dust amount
//   gC = bulge light per ly, disc light per ly, blueness of the arms, seed
//   gD = bulge flattening, irregularity, brightness, bar length (1: round bulge)
export const GALAXY_GLSL = /* glsl */ `
${NOISE}
uniform highp sampler3D uNoise;

// Value noise, 0..1, smoothly interpolated.
float gnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return textureLod(uNoise, (i + f + 0.5) / ${NOISE_SIZE}.0, 0.0).r;
}

// As fbm: octaves fade in as 'detail' (features of the first octave per sample) allows.
float gfbm(vec3 p, float detail) {
  float sum = 0.0, amp = 0.5, freq = 1.0, norm = 0.0;
  for (int i = 0; i < 8; i++) {
    float fade = clamp(detail / freq - 1.0, 0.0, 1.0);
    if (fade <= 0.0) break;
    sum += amp * mix(0.5, gnoise(p), fade);
    norm += amp;
    p = OCTAVE_ROT * p * 2.03 + 17.1;
    freq *= 2.03;
    amp *= 0.56;
  }
  return norm > 0.0 ? sum / norm : 0.5;
}

// Path length through a layer exp(-|y| / h), exactly, between two heights of a straight ray:
// thin dust lanes and discs cannot slip between the march steps.
float gColumn(float ya, float yb, float h, float ds) {
  float ea = exp(-abs(ya) / h), eb = exp(-abs(yb) / h);
  float dy = abs(yb - ya);
  if (dy < 1e-3 * h) return ds * 0.5 * (ea + eb);
  return ds * h / dy * (ya * yb < 0.0 ? 2.0 - ea - eb : abs(ea - eb));
}

// Density of the bulge at a point, relative to its centre.
float gBulge(vec3 p, vec4 gA, vec4 gD) {
  return exp(-length(vec3(p.x / gD.w, p.y * gD.x, p.z)) / gA.w);
}

// 0..1: how strongly a point of the disc belongs to a spiral arm (matches armStrengthOf on the CPU).
float gArm(float theta, float r, vec4 gA, vec4 gB) {
  float phase = gB.x * (theta - gB.y * log(max(r, 1.0) / (gA.x * 0.077)));
  float major = pow(0.5 + 0.5 * cos(phase), 3.0);
  float minor = pow(0.5 + 0.5 * cos(2.0 * phase + 1.3), 4.0) * 0.35;
  float core = clamp((r - gA.x * 0.048) / (gA.x * 0.096), 0.0, 1.0);
  return mix(1.0, mix(0.45, min(1.0, major + minor), gB.z), core);
}

// As gArm, for the dust: narrower lanes.
float gLane(float theta, float r, vec4 gA, vec4 gB) {
  float phase = gB.x * (theta - gB.y * log(max(r, 1.0) / (gA.x * 0.077)));
  float major = pow(0.5 + 0.5 * cos(phase), 8.0);
  float minor = pow(0.5 + 0.5 * cos(2.0 * phase + 1.3), 10.0) * 0.5;
  float core = clamp((r - gA.x * 0.048) / (gA.x * 0.096), 0.0, 1.0);
  return mix(0.35, mix(0.3, min(1.0, major + minor), gB.z), core);
}

const float LANE_LEAD = 0.16;

// ro, rd: ray in the galaxy's frame; pixel: radians across one pixel, which limits the cloud detail.
// Returns light (premultiplied) and how much of the background is hidden.
vec4 galaxyMarch(vec3 ro, vec3 rd, vec4 gA, vec4 gB, vec4 gC, vec4 gD, int steps, float jitter, float pixel) {
  float R = gA.x * 1.2;
  float b = dot(ro, rd);
  float h2 = b * b - dot(ro, ro) + R * R;
  if (h2 <= 0.0) return vec4(0.0);
  float sq = sqrt(h2);
  float t0 = max(-b - sq, 0.0), t1 = -b + sq;
  // Nearly all of a disc galaxy lies in a slab around its plane.
  float H = gC.y > 0.0 ? max(7.0 * gA.z, 5.5 * gA.w / gD.x) : R;
  if (abs(rd.y) > 1e-5) {
    float sa = (-H - ro.y) / rd.y, sb = (H - ro.y) / rd.y;
    t0 = max(t0, min(sa, sb));
    t1 = min(t1, max(sa, sb));
  } else if (abs(ro.y) > H) {
    return vec4(0.0);
  }
  if (t1 <= t0) return vec4(0.0);
  float span = t1 - t0;
  // From inside, steps start short, where nearby dust clouds need them, and grow with distance.
  float a = mix(3.6, 0.4, clamp(t0 / (0.25 * gA.x), 0.0, 1.0));
  float norm = 1.0 / (exp(a) - 1.0);
  float hd = gA.z * 0.12;       // dust hugs the plane
  float cell = gA.x * 0.022;    // size of the largest star clouds
  float knot = gA.x * 0.008;    // and of the largest dust clouds
  // Young discs outshine old bulges for the same mass of stars.
  float discLum = gC.y * 2.4, bulgeLum = gC.x * 0.6;
  vec3 light = vec3(0.0);
  vec3 trans = vec3(1.0);
  float ta = t0;
  float fa = gBulge(ro + rd * t0, gA, gD);
  float n = float(steps);
  for (int i = 0; i < steps; i++) {
    float tb = t0 + span * (exp(a * float(i + 1) / n) - 1.0) * norm;
    float ds = tb - ta;
    float ya = ro.y + rd.y * ta, yb = ro.y + rd.y * tb;
    // A step through the plane is sampled where it crosses it: that is where its dust and stars are,
    // and the clouds of a disc seen from above stay sharp and free of grain however long the step.
    // (A step that only approaches the plane is sampled at its nearer end, unless it runs along the plane.)
    bool cross = ya * yb < 0.0;
    float along = mix(jitter, abs(ya) < abs(yb) ? 0.0 : 1.0, clamp(abs(yb - ya) / (gA.z * 0.05), 0.0, 1.0));
    vec3 p = ro + rd * (ta + ds * (cross ? ya / (ya - yb) : along));
    // What one sample stands for: the length of the ray inside the layer of stars, and of dust.
    float reach = cross ? min(ds, gA.z * 0.5 / max(abs(rd.y), 1e-3)) : ds;
    float reachD = cross ? min(ds, hd / max(abs(rd.y), 1e-3)) : ds;
    // The bulge is smooth: three samples a step integrate it without grain or bands.
    float fm = gBulge(ro + rd * (ta + 0.5 * ds), gA, gD), fb = gBulge(ro + rd * tb, gA, gD);
    float bulge = ds * (fa + 4.0 * fm + fb) / 6.0;
    fa = fb;
    ta = tb;
    float r = length(p.xz);
    // The stars nearest the camera are drawn one by one: their light is not part of the glow.
    float far = clamp((ta - 0.5 * ds) / (gA.z * 1.5), 0.0, 1.0);
    vec3 e = vec3(0.0), born = vec3(0.0);
    float tau = 0.0;
    if (gC.y > 0.0) {
      float theta = atan(p.z, p.x);
      theta += 0.2 * sin(r / (gA.x * 0.1) + gC.w) + 0.08 * sin(3.0 * theta + r / (gA.x * 0.048));
      float arm = gArm(theta, r, gA, gB);
      // Far from the plane there are neither clouds nor dust to look up.
      float off = cross ? 0.0 : min(abs(ya), abs(yb));
      float clouds = off < 4.0 * gA.z ? gfbm(p / cell + gC.w, min(clamp(2.2 * cell / reach, 1.0, 6.0), cell / (2.0 * pixel * tb))) : 0.5;
      float edge = smoothstep(gA.x * 1.1, gA.x * 0.75, r);
      float radial = exp(-r / gA.y) * edge;
      float young = arm * smoothstep(0.05, 0.3, r / gA.x);
      // Old stars fill a thin disc inside a faint thick one; the young blue ones hug the plane.
      float stars = 0.85 * gColumn(ya, yb, gA.z * 0.7, ds) * 0.66 + 0.15 * gColumn(ya, yb, gA.z * 1.85, ds);
      float newborn = gColumn(ya, yb, gA.z * 0.25, ds) * 1.85;
      float clump = max(1.0 + (0.4 + gD.y) * 4.0 * (0.5 - clouds), 0.2);
      float blue = 0.75 * gC.z * young;
      float lit = discLum * radial * (0.3 + 1.3 * arm) * clump * far;
      e = vec3(1.0, 0.84, 0.66) * (stars * (1.0 - blue) * lit);
      born = vec3(0.52, 0.72, 1.1) * (newborn * blue * lit);
      if (off < 2.5 * gA.z && gB.w > 0.0) {
      // Detail finer than the step, or than a pixel, would only be grain.
      float grain = min(knot / (2.0 * pixel * tb), 2.5 * knot / reachD);
      float murk = gfbm(p / knot + gC.w + 3.1, clamp(grain, 1.0, 24.0));
      // Cloud complexes billow out of the dust layer here and there: the same dust, spread higher.
      // (Samples further apart than the clouds would only turn them into streaks: there the layer is even.)
      float puff = mix(0.45, gnoise(p / (cell * 0.7) + gC.w + 7.0), clamp(1.4 * cell / reachD - 1.0, 0.0, 1.0));
      float thick = 0.4 + 5.0 * puff * puff;
      // The layer itself wanders above and below the plane, and its lanes from side to side.
      float sway = (gnoise(p / (cell * 1.5) + gC.w + 19.0) - 0.5) * clamp(3.0 * cell / reachD - 1.0, 0.0, 1.0);
      float lift = sway * gA.z * 0.3;
      float gas = gColumn(ya - lift, yb - lift, hd * thick, ds) / mix(1.0, thick, 0.45);
      // Star-forming regions glow pink inside the densest clouds of the arms.
      float knots = smoothstep(0.64, 0.78, clouds) * young;
      born += vec3(1.0, 0.25, 0.4) * (discLum * radial * 2.5 * knots * gas);
      // Most of the dust sits in cloud complexes, opaque ones, with clearer space between them.
      // (From too far to tell them apart, they blend into the lanes along the arms.)
      float dense = mix(0.4, smoothstep(0.3, 0.8, murk), clamp(grain * 0.5 - 0.8, 0.0, 1.0));
      // It gathers in narrow lanes along the inner edges of the arms, which the star clouds push about.
      float lane = gLane(theta + LANE_LEAD + 0.5 * (clouds - 0.5) + 0.25 * sway, r, gA, gB);
      float ring = smoothstep(gA.x * 0.03, gA.x * 0.1, r) * edge;
      tau = gB.w * ring * exp(-(r - 0.5 * gA.x) / (1.4 * gA.y)) * (0.1 + 2.6 * lane) * (0.3 + 2.2 * dense) * gas / 2200.0;
      }
    }
    e += vec3(1.0, 0.82, 0.58) * (bulgeLum * bulge);
    // Dust takes more of the blue light, so what shines through it is reddened.
    vec3 att = exp(-tau * vec3(0.8, 1.0, 1.3));
    // The dust lies in the middle of the old stars: where a step crosses it, half of them shine in front of it.
    // The newborn ones are still inside it.
    vec3 veil = sqrt(att);
    light += trans * (e * (cross ? 0.5 + 0.5 * att : veil) + born * veil);
    trans *= att;
    if (trans.b < 0.002) break;
  }
  return vec4(light * gD.z, 1.0 - dot(trans, vec3(0.3333)));
}

// Per-pixel offset along the ray: trades banding between march steps for fine grain.
float marchJitter(vec2 px) {
  return hash13(vec3(px, 1.0));
}
`;
