import * as THREE from 'three';
import { NOISE } from './glsl';
import { GALAXIES } from '../universe/universe';
import { NOISE_DATA, NOISE_SIZE } from '../universe/galaxyNoise';

// The march reads its clouds from a tiling volume of random values: one filtered fetch per
// octave instead of eight hashes, which is most of what a galaxy costs to draw.
function makeNoise(): THREE.Data3DTexture {
  const texture = new THREE.Data3DTexture(NOISE_DATA, NOISE_SIZE, NOISE_SIZE, NOISE_SIZE);
  texture.format = THREE.RedFormat;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

/** Bind as the uniform uNoise of every material that includes GALAXY_GLSL. */
export const galaxyNoise = makeNoise();

const KNOTS = 8, SHIFTS = 3;
/**
 * Spread into the uniforms of every material that includes GALAXY_GLSL: the galaxies' giant star-forming
 * regions and off-centre bars, each tagged with the seed of its galaxy.
 */
export const galaxyKnotUniforms: Record<string, THREE.IUniform> = (() => {
  const knots = GALAXIES.flatMap((g) => (g.knots ?? []).map((k) => ({ k, seed: g.seed }))).slice(0, KNOTS);
  const shifts = GALAXIES.filter((g) => g.barShift).slice(0, SHIFTS);
  return {
    uKnot: { value: Array.from({ length: KNOTS }, (_, i) => new THREE.Vector4(...(knots[i]?.k ?? [0, 0, 1, 0]))) },
    uKnotSeed: { value: Array.from({ length: KNOTS }, (_, i) => knots[i]?.seed ?? -1e9) },
    uShift: { value: Array.from({ length: SHIFTS }, (_, i) => new THREE.Vector3(...(shifts[i]?.barShift ?? [0, 0]), shifts[i]?.barAngle ?? 0)) },
    uShiftSeed: { value: Array.from({ length: SHIFTS }, (_, i) => shifts[i]?.seed ?? -1e9) },
    uTint: { value: Array.from({ length: SHIFTS }, (_, i) => new THREE.Vector3(...(shifts[i]?.tint ?? [0, 0, 0]))) },
  };
})();

// One model of a galaxy's light, marched along view rays. It is used twice: into a cube
// map for the galaxy the camera is inside or close to, and directly on a billboard for
// every galaxy further away, so a galaxy looks the same before and after the hand-over.
//
// Per galaxy, in its own frame (disc in the XZ plane, units of light years):
//   gA = radius, disc scale length, stellar scale height, bulge scale
//   gB = arm count, 1 / tan(arm pitch), arm contrast, dust amount
//   gC = bulge light per ly, disc light per ly, blueness of the arms, seed
//   gD = bulge flattening, irregularity, brightness, bar length (1: round bulge)
//   gE = how flocculent the arms are (broken into patches), spurs and feathers off them, how lopsided
//        (one side's arms stronger), elongation of the disc along the bar (1: round)
//   gF = a ring: radius (fraction of the radius), brightness (above 1 the disc inside and beyond is cleared),
//        spokes (negative: a polar ring), dust ring
//   gG = tidal tails, shells, a starburst's outflow, warp of the disc
export const GALAXY_GLSL = /* glsl */ `
${NOISE}
uniform highp sampler3D uNoise;
// Giant star-forming regions (x, z, radius, brightness in the galaxy's frame), each of the galaxy with that seed.
uniform vec4 uKnot[${KNOTS}];
uniform float uKnotSeed[${KNOTS}];
uniform vec3 uShift[${SHIFTS}];   // where a galaxy's bar sits off its centre (x, z) and the angle of its axis
uniform float uShiftSeed[${SHIFTS}];
uniform vec3 uTint[${SHIFTS}];     // colour of the old stars, where not the usual (x = 0)

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

// Density relative to its mean, log-normal: ln(density) an fbm of standard deviation 'spread' once all of
// its octaves (each 'gain' times the last) are resolved; ridged, the noise is folded into filaments and
// sheets. Octaves too fine to resolve are left out and the result keeps its mean: a blur of many clouds is
// their average, never a different look.
float gDust(vec3 p, float detail, float spread, float gain, bool ridged, int octaves) {
  float sum = 0.0, amp = 1.0, freq = 1.0, full = 0.0, part = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    float fade = clamp(detail / freq - 1.0, 0.0, 1.0);
    full += amp * amp;
    if (fade > 0.0) {
      float n = gnoise(p);
      if (ridged) {
        float ridge = 1.0 - abs(2.0 * n - 1.0);
        sum += amp * fade * (ridge * ridge - 0.4) / 0.26;
      } else {
        sum += amp * fade * (n - 0.5) / 0.17;
      }
      part += amp * amp * fade * fade;
    }
    p = OCTAVE_ROT * p * 2.03 + 17.1;
    freq *= 2.03;
    amp *= gain;
  }
  float k = spread / sqrt(full);
  return exp(k * sum - 0.5 * k * k * part);
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
float gBulge(vec3 p, vec4 gA, vec4 gD, vec2 turn) {
  vec2 q = vec2(turn.x * p.x + turn.y * p.z, turn.x * p.z - turn.y * p.x);
  return exp(-length(vec3(q.x / gD.w, p.y * gD.x, q.y)) / gA.w);
}

// 0..1: how strongly a point of the disc belongs to a spiral arm (matches armStrengthOf on the CPU).
// (minorW: how much of the secondary arms between the main ones; a flocculent spiral has fewer, as rings of them read.)
// (An arm contrast above 1 makes the arms narrower: as much contrast, in a crisper arc.)
float gArm(float theta, float r, vec4 gA, vec4 gB, float minorW) {
  float phase = gB.x * (theta - gB.y * log(max(r, 1.0) / (gA.x * 0.077)));
  float major = pow(0.5 + 0.5 * cos(phase), 3.0 * max(gB.z, 1.0));
  float minor = pow(0.5 + 0.5 * cos(2.0 * phase + 1.3), 4.0) * 0.35 * minorW;
  float core = clamp((r - gA.x * 0.048) / (gA.x * 0.096), 0.0, 1.0);
  return mix(1.0, mix(0.45, min(1.0, major + minor), min(gB.z, 1.0)), core);
}

// As gArm, for the dust: narrower lanes.
float gLane(float theta, float r, vec4 gA, vec4 gB, float minorW) {
  float phase = gB.x * (theta - gB.y * log(max(r, 1.0) / (gA.x * 0.077)));
  float major = pow(0.5 + 0.5 * cos(phase), 8.0 * max(gB.z, 1.0));
  float minor = pow(0.5 + 0.5 * cos(2.0 * phase + 1.3), 10.0) * 0.5 * minorW;
  float core = clamp((r - gA.x * 0.048) / (gA.x * 0.096), 0.0, 1.0);
  return mix(0.35, mix(0.3, min(1.0, major + minor), min(gB.z, 1.0)), core);
}

const float LANE_LEAD = 0.16;

// The arms of a real spiral are not a clean pattern: they wander, branch and break into patches, throw off spurs
// and feathers at a steep angle on their outer side, and are stronger on one side of the disc than the other.
// arm: gArm or gLane at the point (theta already warped); returns it so changed. (Matches armStructureOf on the CPU.)
float gArmStructure(float arm, vec3 p, float theta, float r, vec4 gA, vec4 gB, vec4 gC, vec4 gE) {
  float core = clamp((r - gA.x * 0.048) / (gA.x * 0.096), 0.0, 1.0);
  float a = arm;
  if (gE.y > 0.0) {
    // Spurs: many short arcs of a much steeper pitch, just outside each arm.
    float phase = gB.x * (theta - gB.y * log(max(r, 1.0) / (gA.x * 0.077)));
    float side = pow(0.5 + 0.5 * cos(phase - 0.9), 3.0);
    float spur = pow(0.5 + 0.5 * cos(7.0 * (theta - sign(gB.y) * 0.8 * log(max(r, 1.0) / (gA.x * 0.077))) + gC.w), 4.0);
    a = max(a, mix(a, 0.35 + 0.65 * spur, gE.y * side * core));
  }
  if (gE.x > 0.0) {
    // Flocculent: the arms in patches, a few kly long; and the inner disc too, nearly to the bulge.
    float patchy = gnoise(vec3(p.x, 0.0, p.z) / (gA.x * 0.07) + gC.w + 41.0);
    float inner = clamp((r - gA.x * 0.012) / (gA.x * 0.03), 0.0, 1.0);
    a = mix(a, a * smoothstep(0.25, 0.7, patchy) * 1.5, gE.x * max(core, inner));
  }
  if (gE.z > 0.0) a *= 1.0 + gE.z * 0.6 * cos(theta + gC.w) * core;
  return a;
}

// Where a point lies in the disc's own pattern: how far out (in a disc stretched along its bar where it is
// elongated, gE.w) and at what angle, the arms' wobble and wandering included.
vec2 gDiscPolar(vec3 p, vec4 gA, vec4 gC, vec4 gE) {
  // (Narrowed across the bar rather than drawn out along it: the galaxy stays inside its bounds.)
  vec2 q = p.xz;
  if (gE.w > 1.0) q.y *= gE.w;
  float r = length(q);
  float theta = atan(q.y, q.x);
  theta += 0.2 * sin(r / (gA.x * 0.1) + gC.w) + 0.08 * sin(3.0 * theta + r / (gA.x * 0.048));
  // (The noise's scale shrinks inward with the radius: the inner arms wander as much as the outer ones.)
  if (gE.x > 0.0) theta += gE.x * 1.4 * (gnoise(vec3(p.x, 0.0, p.z) / (0.5 * r + gA.x * 0.03) + gC.w + 23.0) - 0.5);
  return vec2(r, theta);
}

// Where along a step from height ya to yb to look up the clouds of a layer exp(-|y| / h): at the fraction u
// of its column. Every pass of the sky map takes another u, so its samples spread over the dust the step
// passes through instead of sitting on shells around the camera (which show as rings and streaks).
float gPick(float ya, float yb, float h, float u) {
  float ea = exp(-abs(ya) / h), eb = exp(-abs(yb) / h);
  float dy = ya - yb;
  if (abs(dy) < 1e-3 * h) return u;
  float y;
  if (ya * yb >= 0.0) {
    if (abs(eb - ea) < 1e-4) return u;
    y = sign(ya + yb) * -h * log(max(mix(ea, eb, u), 1e-30));
  } else {
    float ca = 1.0 - ea, s = u * (ca + 1.0 - eb);
    y = s < ca ? sign(ya) * -h * log(ea + s) : sign(yb) * -h * log(max(1.0 - (s - ca), 1e-30));
  }
  return clamp((ya - y) / dy, 0.0, 1.0);
}

// The shells of an elliptical that swallowed a smaller galaxy: a few thin, sharp-edged concentric shells at radii
// growing by a factor of 1.5 from 2.5 bulge scales out, brighter on alternate sides along its long axis, and
// falling off far slower than the elliptical's own light (they are the other galaxy's stars). Returns the light
// they add, in the bulge's units.
float gShell(vec3 p, vec4 gA, float amount) {
  float r = length(p);
  float lr = log(max(r, 1.0) / (2.5 * gA.w)) / log(1.5);
  if (lr < 0.0 || lr > 5.0) return 0.0;
  float k = floor(lr), f = lr - k;
  float edge = smoothstep(0.55, 0.95, f) * (1.0 - smoothstep(0.95, 1.0, f));
  float side = 0.35 + 0.65 * smoothstep(-0.3, 0.5, (mod(k, 2.0) < 0.5 ? p.x : -p.x) / r);
  return amount * 0.3 * edge * side * exp(-r / (3.0 * gA.w));
}

// ro, rd: ray in the galaxy's frame; pixel: radians across one pixel, which limits the cloud detail.
// Returns light (premultiplied) and how much of the background is hidden.
// uSettle: 0 for a single look; 1 where many jittered passes are averaged, which may then resolve
// detail finer than a step (it averages out instead of showing as grain). Unset, it is 0.
uniform float uSettle;
#ifdef STEP_LIMIT
uniform float uStepLimit;
#endif
#ifdef MARCH_DEPTH
// Where along the ray the light and the dust of a march are (log distance, weighted by each): what moves on
// screen with the camera, for reusing the last frames' marches.
float gDL = 0.0, gWL = 0.0, gDA = 0.0, gWA = 0.0;
#endif
vec4 galaxyMarch(vec3 ro, vec3 rd, vec4 gA, vec4 gB, vec4 gC, vec4 gD, vec4 gE, vec4 gF, vec4 gG, int steps, float jitter, float pixel) {
  float stepLimit = mix(1.0, 30.0, uSettle);
#ifdef STEP_LIMIT
  stepLimit = min(stepLimit, uStepLimit);
#endif
  float inLayer = 1.0 - smoothstep(1.0 * gA.z, 2.5 * gA.z, abs(ro.y));
  float R = gA.x * 1.2;
  float b = dot(ro, rd);
  float h2 = b * b - dot(ro, ro) + R * R;
  if (h2 <= 0.0) return vec4(0.0);
  float sq = sqrt(h2);
  float t0 = max(-b - sq, 0.0), t1 = -b + sq;
  // Nearly all of a disc galaxy lies in a slab around its plane.
  // (Not so for a polar ring, tidal tails or an outflow, which reach far from the plane.)
  bool tall = gF.z < 0.0 || gG.x > 0.0 || gG.z > 0.0;
  float H = gC.y > 0.0 && !tall ? max(7.0 * gA.z, 5.5 * gA.w / gD.x) : R;
  if (abs(rd.y) > 1e-5) {
    float sa = (-H - ro.y) / rd.y, sb = (H - ro.y) / rd.y;
    t0 = max(t0, min(sa, sb));
    t1 = min(t1, max(sa, sb));
  } else if (abs(ro.y) > H) {
    return vec4(0.0);
  }
  if (t1 <= t0) return vec4(0.0);
  float span = t1 - t0;
  // From inside, steps start short, where nearby dust clouds need them, and grow with distance:
  // a few light years at first, a few per cent of the distance further out.
  float a = t0 > 0.0 ? mix(3.6, 0.4, clamp(t0 / (0.25 * gA.x), 0.0, 1.0)) : clamp(log(span / (gA.z * 0.02)), 3.6, 11.0);
  float norm = 1.0 / (exp(a) - 1.0);
  float hd = gA.z * 0.12;       // dust hugs the plane
  float cell = gA.x * 0.022;    // size of the largest star clouds
  float knot = gA.x * 0.008;    // and of the largest dust clouds
  // Young discs outshine old bulges for the same mass of stars.
  float discLum = gC.y * 2.4, bulgeLum = gC.x * 0.6;
  vec3 light = vec3(0.0);
  vec3 trans = vec3(1.0);
  float ta = t0;
  // An off-centre bar (the LMC's): the bulge is looked up from a camera shifted the other way.
  vec3 bro = ro;
  vec2 turn = vec2(1.0, 0.0);
  for (int k = 0; k < ${SHIFTS}; k++) if (abs(gC.w - uShiftSeed[k]) < 1e-3) {
    bro -= vec3(uShift[k].x, 0.0, uShift[k].y);
    turn = vec2(cos(uShift[k].z), sin(uShift[k].z));
  }
  float fa = gBulge(bro + rd * t0, gA, gD, turn);
  if (gG.y > 0.0) fa += gShell(ro + rd * t0, gA, gG.y);
  float n = float(steps);
  for (int i = 0; i < steps; i++) {
    float tb = t0 + span * (exp(a * float(i + 1) / n) - 1.0) * norm;
    float ds = tb - ta;
    float ya = ro.y + rd.y * ta, yb = ro.y + rd.y * tb;
    // A step through the plane is sampled where it crosses it: that is where its dust and stars are,
    // and the clouds of a disc seen from above stay sharp and free of grain however long the step.
    // (A step that only approaches the plane is sampled at its nearer end, unless it runs along the plane.)
    bool cross = ya * yb < 0.0;
    // (Where many passes are averaged, each samples its step somewhere else in the dust it passes through.)
    float along = mix(jitter, abs(ya) < abs(yb) ? 0.0 : 1.0, clamp(abs(yb - ya) / (gA.z * 0.05), 0.0, 1.0));
    vec3 p = ro + rd * (ta + ds * (uSettle > 0.5 ? gPick(ya, yb, hd, jitter) : cross ? ya / (ya - yb) : along));
    // What one sample stands for: the length of the ray inside the layer of stars, and of dust.
    float reach = cross ? min(ds, gA.z * 0.5 / max(abs(rd.y), 1e-3)) : ds;
    float reachD = cross ? min(ds, hd / max(abs(rd.y), 1e-3)) : ds;
    // The bulge is smooth: three samples a step integrate it without grain or bands.
    float fm = gBulge(bro + rd * (ta + 0.5 * ds), gA, gD, turn), fb = gBulge(bro + rd * tb, gA, gD, turn);
    if (gG.y > 0.0) { fm += gShell(ro + rd * (ta + 0.5 * ds), gA, gG.y); fb += gShell(ro + rd * tb, gA, gG.y); }
    float bulge = ds * (fa + 4.0 * fm + fb) / 6.0;
    fa = fb;
    ta = tb;
    vec2 polar = gDiscPolar(p, gA, gC, gE);
    float r = polar.x;
    // The stars nearest the camera are drawn one by one: their light is not part of the glow.
    float far = clamp((ta - 0.5 * ds) / (gA.z * 1.5), 0.0, 1.0);
    vec3 e = vec3(0.0), born = vec3(0.0);
    float tau = 0.0;
    if (gC.y > 0.0) {
      // A warped disc (Centaurus A's): its plane tilts more the further out, up on one side, down on the other.
      float yw = gG.w > 0.0 ? gG.w * gA.x * pow(r / gA.x, 2.0) * sin(atan(p.z, p.x)) : 0.0;
      ya -= yw; yb -= yw;
      float theta = polar.y;
      float minorW = 1.0 - 0.8 * gE.x;
      float arm = gArmStructure(gArm(theta, r, gA, gB, minorW), p, theta, r, gA, gB, gC, gE);
      // Far from the plane there are neither clouds nor dust to look up.
      float off = cross ? 0.0 : min(abs(ya), abs(yb));
      float clouds = off < 4.0 * gA.z ? gfbm(p / cell + gC.w, min(clamp(2.2 * cell / reach * stepLimit, 1.0, 64.0), cell / (2.0 * pixel * tb))) : 0.5;
      float edge = smoothstep(gA.x * 1.1, gA.x * 0.75, r);
      float radial = exp(-r / gA.y) * edge;
      float young = arm * smoothstep(0.05, 0.3, r / gA.x);
      // Old stars fill a thin disc inside a faint thick one; the young blue ones hug the plane.
      float stars = 0.85 * gColumn(ya, yb, gA.z * 0.7, ds) * 0.66 + 0.15 * gColumn(ya, yb, gA.z * 1.85, ds);
      float newborn = gColumn(ya, yb, gA.z * 0.25, ds) * 1.85;
      // (Seen whole from outside, star clouds are soft swellings of the arms, not a speckle all over the disc.)
      // (A flocculent disc is clumpier all over, its inner parts too.)
      float clump = max(1.0 + (0.4 + gD.y + 0.6 * gE.x) * mix(2.2, 4.0, uSettle) * (0.5 - clouds), 0.2);
      float blue = 0.75 * gC.z * young;
      float lit = discLum * radial * (0.3 + 1.3 * arm) * clump * far;
      // (The old stars' colour: warm, but lavender-white in galaxies that are nearly all young, the Magellanic Clouds.)
      vec3 oldTint = vec3(1.0, 0.84, 0.66);
      for (int k = 0; k < ${SHIFTS}; k++) if (abs(gC.w - uShiftSeed[k]) < 1e-3 && uTint[k].x > 0.0) oldTint = uTint[k];
      // A ring of young stars (gF): an inner ring round a bar, or a collisional or Hoag-type ring, which clears
      // the disc inside it (down to a small core) and beyond it.
      float ringLight = 0.0;
      if (gF.x > 0.0 && gF.z >= 0.0) {
        float rr = gF.x * gA.x, w = gA.x * 0.045;
        float shape = exp(-pow((r - rr) / w, 2.0)) * (0.55 + 0.9 * clouds);
        float clear = clamp(gF.y - 1.0, 0.0, 1.0);
        lit *= 1.0 - 0.92 * clear * (smoothstep(0.18 * rr, 0.4 * rr, r) * smoothstep(0.95 * rr, 0.8 * rr, r) + smoothstep(1.1 * rr, 1.35 * rr, r));
        // Spokes from the core to the ring (the Cartwheel's).
        // (Straight and radial: the angle without the arms' wobble.)
        float spokes = gF.z > 0.0 ? pow(max(0.5 + 0.5 * cos(gF.z * atan(p.z, p.x) + gC.w), 0.0), 10.0) * smoothstep(0.15 * rr, 0.35 * rr, r) * smoothstep(rr, 0.8 * rr, r) : 0.0;
        // (As bright against its galaxy however short the disc's scale: at most two scale lengths' fall.)
        ringLight = discLum * exp(-min(rr / gA.y, 2.0)) * gF.y * shape * far;
        e += oldTint * (stars * discLum * exp(-min(r / gA.y, 2.0)) * spokes * 0.6 * clear * far);
      }
      // Tidal tails: two long arcs flung out from the disc, curving away, thinning and fading outward, with clumps of
      // stars along them; tilted out of the plane further out. (The angle without the disc's wobble or flocculence.)
      if (gG.x > 0.0) {
        float th0 = atan(p.z, p.x);
        float tp = 2.0 * (th0 - 0.85 * log(max(r, 1.0) / (gA.x * 0.12)));
        float width = 6.0 + 40.0 * r / gA.x;
        float tail = pow(max(0.5 + 0.5 * cos(tp), 0.0), width) * smoothstep(0.1 * gA.x, 0.25 * gA.x, r) * exp(-r / (0.45 * gA.x)) * smoothstep(gA.x * 1.15, gA.x * 0.85, r);
        float clumps = 0.35 + 1.6 * pow(max(gnoise(p / (gA.x * 0.02) + gC.w + 9.0), 0.0), 2.0);
        float tiltY = 0.25 * r * sin(th0 + gC.w);
        e += oldTint * (gG.x * discLum * 0.9 * tail * clumps * gColumn(ya - tiltY, yb - tiltY, gA.z * 2.0, ds) * far);
        born += vec3(0.55, 0.72, 1.05) * (gG.x * discLum * 0.5 * tail * smoothstep(0.75, 1.0, clumps / 1.95) * gColumn(ya - tiltY, yb - tiltY, gA.z * 1.2, ds) * far);
      }
      e += oldTint * (stars * (1.0 - blue) * lit);
      born += vec3(0.52, 0.72, 1.1) * (newborn * blue * lit + newborn * ringLight);
      if (off < 2.5 * gA.z && gB.w > 0.0) {
      // Detail finer than the step, or than a pixel, would only be grain.
      float grain = min(knot / (2.0 * pixel * tb), 2.5 * knot / reachD * stepLimit);
      // Interstellar clouds are filaments and sheets, not blobs: the noise is pulled along itself.
      float warp = clamp(grain * 0.25 - 0.5, 0.0, 1.0);
      vec3 q = p / knot + gC.w + 3.1;
      q += warp * 1.4 * vec3(gnoise(q * 0.45 + 31.0) - 0.5, 0.0, gnoise(q * 0.45 + 57.0) - 0.5);
      // The dust: cloud complexes with clear gaps between them (through which the far glow shows, as it does
      // through the real ones), their insides and edges torn into wisps and filaments down to a few light
      // years, as far as the pixels and the march resolve them.
      float dense = gDust(q, clamp(grain, 1.0, 5.0), mix(1.8, 1.2, smoothstep(1.5 * gA.z, 4.0 * gA.z, abs(ro.y))), 0.55, false, 3) * gDust(q * 4.1 + 11.0, grain * 0.25, mix(0.5, 1.3, uSettle), 0.8, true, 6);
      // (A single pass on screen, the galaxy seen whole: the finest wisps would only be a speckle of dark dots.)
      // Cloud complexes billow out of the dust layer here and there: the same dust, spread higher.
      // (Samples further apart than the clouds would only turn them into streaks: there the layer is even.)
      float puff = mix(0.45, gnoise(p / (cell * 0.7) + gC.w + 7.0), clamp(1.4 * cell / reachD - 1.0, 0.0, 1.0));
      float thick = 0.5 + 2.5 * puff * puff;
      // The layer itself wanders above and below the plane, and its lanes from side to side.
      float sway = (gnoise(p / (cell * 1.5) + gC.w + 19.0) - 0.5) * clamp(3.0 * cell / reachD - 1.0, 0.0, 1.0);
      float lift = sway * gA.z * 0.3;
      float gas = gColumn(ya - lift, yb - lift, hd * thick, ds) / mix(1.0, thick, 0.45);
      // Star-forming regions glow pink inside the densest clouds of the arms.
      float knots = smoothstep(0.64, 0.78, clouds) * young;
      born += vec3(1.0, 0.25, 0.4) * (discLum * radial * 2.5 * knots * gas);
      for (int k = 0; k < ${KNOTS}; k++) {
        if (abs(gC.w - uKnotSeed[k]) > 1e-3) continue;
        vec2 dq = (p.xz - uKnot[k].xy) / uKnot[k].z;
        float w = exp(-dot(dq, dq) * 2.0) * (0.4 + 1.2 * clouds);
        born += vec3(1.0, 0.32, 0.5) * (discLum * uKnot[k].w * w * gColumn(ya, yb, gA.z * 0.3, ds));
      }
      // It gathers in narrow lanes along the inner edges of the arms, which the star clouds push about.
      // (Broken up and pushed about by the star clouds: real lanes are ragged arcs, not rings.)
      float laneTheta = theta + LANE_LEAD + 1.0 * (clouds - 0.5) + 0.35 * sway;
      // In a flocculent spiral the lanes wander further than the arms' light and break up with them: short
      // ragged stretches of dust, not rings. (The Milky Way's, gE.x = 0, as they were.)
      float tear = 1.0;
      if (gE.x > 0.0) {
        // (By up to about a radian of the pattern's phase, however many arms there are.)
        laneTheta += gE.x * 5.0 / max(gB.x, 1.0) * (gnoise(vec3(p.x, 0.0, p.z) / (0.3 * r + gA.x * 0.02) + gC.w + 61.0) - 0.5);
        tear = mix(1.0, smoothstep(0.3, 0.65, gnoise(vec3(p.x, 0.0, p.z) / (0.12 * r + gA.x * 0.01) + gC.w + 71.0)) * 1.6, gE.x);
      }
      float lane = gArmStructure(gLane(laneTheta, r, gA, gB, minorW), p, laneTheta, r, gA, gB, gC, gE) * tear * (0.45 + 1.1 * clouds);
      // (In a flocculent spiral the dust reaches nearly to the bulge, in patches.)
      float ring = smoothstep(gA.x * mix(0.03, 0.006, gE.x), gA.x * mix(0.1, 0.025, gE.x), r) * edge;
      // No dust right around the camera: up close a single cloud would fill half the sky. (The Sun sits in
      // such a cavity, the Local Bubble, a few hundred light years across; every camera carries one along.)
      // And the nearest thousand or two light years hold fewer clouds than further on: they would span tens
      // of degrees and cover the sky out of the plane. (Seen from far off, nothing changes.)
      float tc = ta - 0.5 * ds;
      ring *= smoothstep(gA.x * 0.0025, gA.x * 0.006, tc) * mix(0.2, 1.0, smoothstep(gA.x * 0.01, gA.x * 0.04, tc));
      // Denser towards the centre, but only down to where the molecular ring is (some 0.35 of the radius): further in
      // the dust thins again, gathered into narrow lanes along the bar instead of a deepening fog of clouds.
      float inner = exp(-(max(r, 0.35 * gA.x) - 0.5 * gA.x) / (1.4 * gA.y)) * mix(1.0, 0.55, smoothstep(0.35 * gA.x, 0.15 * gA.x, r) * (1.0 - gE.x));
      // (Inside the ring the clouds keep to the lanes: where the lane is weak there is hardly any.)
      float inLane = smoothstep(0.42 * gA.x, 0.25 * gA.x, r);
      float laneW = mix(0.1 + 2.6 * lane, 0.03 + 3.2 * lane * lane, inLane * (1.0 - 0.7 * gE.x));
      tau = gB.w * ring * inner * laneW * (0.1 + 1.6 * dense) * gas / 2200.0;
      }
      // A ring of dust (the Sombrero's): crisp and dark, at the ring's radius or, without one, at 0.7 of the radius.
      if (gF.w > 0.0 && gF.z >= 0.0) {
        float rd0 = (gF.x > 0.0 ? gF.x : 0.7) * gA.x;
        float shapeD = exp(-pow((r - rd0) / (gA.x * 0.04), 2.0)) * (0.7 + 0.6 * clouds);
        tau += gF.w * shapeD * gColumn(ya, yb, gA.z * 0.15, ds) * 6.0 / 2200.0;
      }
    }
    // A polar ring: stars and dust in a ring round the disc's axis, in the plane x-y of the galaxy's frame.
    if (gF.z < 0.0) {
      float za = ro.z + rd.z * (ta - ds), zb = ro.z + rd.z * ta;
      vec3 q = abs(za - zb) > 1e-6 && za * zb < 0.0 ? ro + rd * (ta - ds + ds * za / (za - zb)) : p;
      float rp = length(q.xy);
      float shapeP = exp(-pow((rp - gF.x * gA.x) / (gA.x * 0.07), 2.0)) * (0.6 + 0.8 * gnoise(q / (gA.x * 0.04) + gC.w));
      float colP = gColumn(za, zb, gA.x * 0.025, ds);
      born += vec3(0.6, 0.75, 1.0) * (discLum * gF.y * 0.3 * shapeP * colP);
      tau += gF.w * shapeP * gColumn(za, zb, gA.x * 0.01, ds) * 4.0 / 2200.0;
    }
    // A starburst's outflow (M82's): red filaments of hot gas blown out along the axis, both ways.
    if (gG.z > 0.0) {
      float ay = abs(p.y);
      float cone = exp(-length(p.xz) / (gA.x * 0.04 + 0.45 * ay)) * exp(-ay / (gA.x * 0.3)) * smoothstep(gA.x * 0.01, gA.x * 0.05, ay);
      float fil = pow(gnoise(p / (gA.x * 0.025) + gC.w + 5.0), 3.0) * 2.5;
      born += vec3(1.0, 0.16, 0.22) * (gG.z * discLum * 0.15 * cone * fil * ds);
    }
    // The bars of irregular galaxies are no smooth bulge but a chain of star clouds.
    float lumpy = smoothstep(0.45, 0.9, gD.y);
    if (lumpy > 0.0) bulge *= mix(1.0, 0.25 + 1.6 * pow(gnoise(p / (gA.w * 0.45) + gC.w + 13.0), 1.5) * (0.6 + 0.8 * gnoise(p / (gA.w * 0.15) + gC.w + 3.0)), lumpy);
    e += vec3(1.0, 0.82, 0.58) * (bulgeLum * bulge);
    // Dust takes more of the blue light, so what shines through it is reddened.
    vec3 att = exp(-tau * vec3(0.8, 1.0, 1.3));
    // The dust lies in the middle of the old stars: where a step crosses it, half of them shine in front of it.
    // The newborn ones are still inside it.
    vec3 veil = sqrt(att);
    vec3 added = trans * (e * (cross ? 0.5 + 0.5 * att : veil) + born * veil);
    light += added;
#ifdef MARCH_DEPTH
    float lt = log(max(ta - 0.5 * ds, 1.0));
    float dl = dot(added, vec3(0.3333)), da = dot(trans * (1.0 - att), vec3(0.3333));
    gDL += dl * lt; gWL += dl; gDA += da * lt; gWA += da;
#endif
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
