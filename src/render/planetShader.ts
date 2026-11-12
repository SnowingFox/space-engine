import { atmoCommon } from './atmosphereScatter';
import { LOGDEPTH_FRAG_PARS, LOGDEPTH_VERT, LOGDEPTH_VERT_PARS, NOISE } from './glsl';
import { ECLIPSE } from './lighting';
import { SHADOW_LOOKUP, SHADOW_PROJECT } from './terrainShadow';

export const RING_DENSITY = /* glsl */ `
float ringNoise(float x) {
  float i = floor(x);
  float f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(fract(sin(i * 127.1) * 43758.5453), fract(sin((i + 1.0) * 127.1) * 43758.5453), f);
}

// Radial ring structure; t is 0 at the inner edge and 1 at the outer edge.
float ringDensity(float t, float seed) {
  if (t < 0.0 || t > 1.0) return 0.0;
  float x = t + seed;
  float d = 0.5 * ringNoise(x * 9.0) + 0.3 * ringNoise(x * 37.0) + 0.2 * ringNoise(x * 151.0);
  d = smoothstep(0.2, 0.7, d);
  float fine = 0.85 + 0.15 * ringNoise(x * 900.0);
  float gap = smoothstep(0.0, 0.018, abs(t - 0.62 - 0.1 * sin(seed)));  // one wide division
  float edges = smoothstep(0.0, 0.03, t) * smoothstep(1.0, 0.96, t);
  float profile = mix(0.3, 1.0, smoothstep(0.05, 0.35, t));              // faint inner ring
  return clamp((0.3 + 0.7 * d) * fine * gap * edges * profile, 0.0, 1.0);
}
`;

export const PLANET_VERT = /* glsl */ `
${LOGDEPTH_VERT_PARS}
uniform vec3 uCamObj;
varying vec3 vObj;
varying vec3 vView;
varying vec3 vFine;
varying float vSkirt;
varying float vMapKm;
varying vec4 vGrad;
void main() {
  vObj = position;
  vView = position - uCamObj;
  vFine = vec3(0.0);
  vSkirt = 0.0;
  vMapKm = 0.0;
  vGrad = vec4(0.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  ${LOGDEPTH_VERT}
}
`;

// Uniforms and height functions shared by the terrain vertex shader, the surface
// fragment shader, the cloud shell and the ground probe, so they all agree.
// Planet types: 0 terran/ocean, 1 desert, 2 barren, 3 ice, 4 lava, 5 gas, 6 ice giant.
export const PLANET_COMMON = /* glsl */ `
${NOISE}
uniform int uType;
uniform vec3 uPal[4];
uniform float uSeed;
uniform float uSea;
uniform float uClouds;
uniform float uTime;
uniform float uPolar;       // 0..1 polar cap extent
uniform vec3 uSunDir;       // object space, towards the star
uniform vec3 uSunColor;
uniform vec3 uCamObj;       // camera position in object space (planet radii)
uniform vec3 uAtmoColor;
uniform float uAtmoDensity;
uniform vec4 uRing;         // inner, outer (planet radii), seed, enabled
uniform vec3 uRingNormal;   // object space
uniform float uHeightScale; // planet radii per unit of terrain height
uniform sampler2D uHeightMap; // real relief, km (Solar System bodies)
uniform vec4 uHeightInfo;   // terrain units per km, km at the datum, texels around the equator, 1 once loaded

// Finer than this and float32 can no longer tell neighbouring noise cells apart.
const float MAX_DETAIL = 1.5e5;
// Cells per planet radius of the first fine-relief octave, which takes over from there.
const float FINE_FREQ = 131072.0;

// minFreq: only craters too small for a real map to hold (0: all of them).
float craters(vec3 p, float detail, float minFreq) {
  float h = 0.0;
  float freq = 2.2;
  float amp = 1.0;
  for (int i = 0; i < 11; i++) {
    float fade = clamp(detail / (freq * 2.0) - 1.0, 0.0, 1.0);
    if (fade <= 0.0) break;
    if (freq < minFreq * 0.5) {
      freq *= 2.3;
      amp *= 0.7;
      continue;
    }
    fade *= smoothstep(minFreq * 0.5, minFreq, freq);
    vec3 at;
    vec3 q = p * freq + uSeed;
    vec3 w = worleyAt(q, at);
    // A crater that reaches the border of its cell fades out there rather than being cut off.
    fade *= smoothstep(0.0, 0.1, w.z - w.x);
    // Not every cell holds one (impacts are random, and the smaller ones are many more), and they come
    // in all sizes, most of them small for their cell.
    // Most are old: worn down by later impacts to shallow dimples; a few are fresh.
    float id = w.y, id2 = fract(id * 7.31), age = 1.0 - pow(fract(id * 13.7), 3.0);
    fade *= step(id2, 0.22 + 0.025 * float(i));
    float r = 0.07 + 0.26 * id * id;
    // Not quite round: a little elongated, a little lobed.
    vec3 rel = q - at;
    float len = length(rel);
    vec3 dir = rel / max(len, 1e-6);
    float d = len / r;
    // (Lobes by direction from the centre only: a few around the rim, never finer than the crater.)
    d *= 1.0 + 0.06 * sin(3.0 * dot(dir, vec3(0.8, 0.5, 0.33)) + id * 40.0) + 0.04 * sin(5.0 * dot(dir, vec3(-0.3, 0.9, 0.3)) + id * 17.0);
    // Age softens them: old craters are shallow, their rims low and worn wide; fresh ones are deep bowls with
    // sharp raised rims and their ejecta spread around.
    float worn = mix(0.14, 0.4, age);
    float bowl = (d * d - 1.0) * 0.55 * mix(1.0, 0.3, age);
    float rim = 0.4 * mix(1.0, 0.45, age) * exp(-pow((d - 1.0) / worn, 2.0));
    float ejecta = 0.06 * (1.0 - age) * exp(-(d - 1.0) * 2.2) * smoothstep(1.0, 1.25, d);
    // Basins are shallow for their width; small craters are bowls of constant proportions.
    float depth = min(amp, 0.6 / (freq * uHeightScale));
    h += depth * fade * (d < 1.0 ? bowl + rim : rim + ejecta);
    freq *= 2.3;
    amp *= 0.7;
  }
  return h;
}

// Direction to equirectangular texture coordinates: longitude 0 at +x, east towards -z, north up.
vec2 equirect(vec3 n) {
  return vec2(atan(-n.z, n.x) * 0.15915494 + 0.5, asin(clamp(n.y, -1.0, 1.0)) * 0.31830989 + 0.5);
}

float seaLevelH() {
  return 0.5 + (uSea - 0.5) * 0.45;
}

// Noise-space position of a direction, bent so continents do not look like plain noise.
vec3 warped(vec3 p) {
  vec3 q = p * 1.7 + uSeed;
  return q + 0.45 * (vec3(vnoise(q * 1.3 + 1.1), vnoise(q * 1.3 + 4.7), vnoise(q * 1.3 + 8.3)) - 0.5);
}

// Set by terrain(): 1 where the ground is the level surface of a flooded (or silted-up) basin.
float gBasin;

const float BASIN_FREQ = 14.0;

// Ancient impact basins: a level floor inside a ring wall, which the mountain noise then
// carves into a crown of ridges. Returns the level liquid stands at, or -1 outside.
float basin(vec3 p, inout float h, inout float mount) {
  vec3 at;
  vec3 shift = vec3(uSeed * 1.3 + 11.0);
  vec3 w = worleyAt(p * BASIN_FREQ + shift, at);
  float share = uType == 0 ? 0.06 : 0.07;
  if (w.y > share) return -1.0;
  float pick = w.y / share;
  float r = 0.07 + 0.2 * pick * pick;
  // The centre is the cell's point brought down (or up) onto the surface.
  vec3 centre = normalize(at - shift);
  float d = length(p - centre) * BASIN_FREQ / r;
  // Nothing of the basin is left by the border of its cell, nor far outside the rim.
  float k = smoothstep(0.0, 0.1, w.z - w.x) * (1.0 - smoothstep(1.3, 1.7, d));
  if (k <= 0.0) return -1.0;
  // Everything about the basin hangs off the ground height at its centre, so it is one level all round.
  float hc = fbm(warped(centre), 24.0);
  float deep = 0.025 + 0.05 * fract(pick * 7.0);
  if (uType == 0) {
    // The same lowering of the continents as in terrain(); a basin by the sea would just be a bay.
    hc = min(hc, seaLevelH() + (hc - seaLevelH()) * 0.4);
    deep *= 0.2;
    if (hc - deep < seaLevelH() + 0.003) return -1.0;
  }
  float bed = hc - deep;
  float wall = smoothstep(0.4, 1.0, d);
  float crest = exp(-pow((d - 1.0) * 3.0, 2.0));
  h = mix(h, mix(bed, max(h, bed), wall) + crest * (uType == 0 ? 0.6 : 1.0) * (0.025 + 0.03 * fract(pick * 13.0)), k);
  mount = mix(mount, max(mount, 0.85 * crest) * smoothstep(0.3, 0.6, d), k);
  // The level falls away towards the rim, so a breach cannot leave a wall of water standing.
  return bed + 0.006 - 0.3 * smoothstep(0.7, 0.95, d);
}

// The real map's height in km under p. The fragment shader may hand in the height interpolated
// between the vertices instead (weight gMapGiven): float32 directions are too coarse near the
// ground for the map's slopes, which then show steps a few decimetres apart.
float gMapKm = 0.0;
float gMapGiven = 0.0;
float gMapGivenKm = 0.0;
// Also set by mapTerrain(): the height before the procedural relief, and that relief's amplitude.
float gMapH0 = 0.0;
float gMapAmp = 0.0;

// Cubic B-spline filtering from four bilinear taps, so slopes stay smooth where the map is magnified.
float heightTap(vec2 uv, float lod) {
  if (lod >= 1.0) return textureLod(uHeightMap, uv, lod).r;
  vec2 size = vec2(uHeightInfo.z, uHeightInfo.z * 0.5);
  vec2 st = uv * size - 0.5;
  vec2 i = floor(st), f = st - i;
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 t0 = (i - 0.5 + w1 / g0) / size;
  vec2 t1 = (i + 1.5 + w3 / g1) / size;
  float v = g0.y * (g0.x * textureLod(uHeightMap, t0, 0.0).r + g1.x * textureLod(uHeightMap, vec2(t1.x, t0.y), 0.0).r)
          + g1.y * (g0.x * textureLod(uHeightMap, vec2(t0.x, t1.y), 0.0).r + g1.x * textureLod(uHeightMap, t1, 0.0).r);
  return lod > 0.0 ? mix(v, textureLod(uHeightMap, uv, 1.0).r, lod) : v;
}

// terrain() for a body with a real height map: the map, plus the procedural relief it is too
// coarse to hold, sized and placed by how rugged the map is there.
float mapTerrain(vec3 p, float detail, out float rough) {
  detail = min(detail, MAX_DETAIL);
  vec2 uv = equirect(p);
  float texels = uHeightInfo.z * 0.15915494;   // map texels per planet radius
  float km = gMapGiven >= 1.0 ? gMapGivenKm : heightTap(uv, max(log2(texels / max(detail, 1.0)), 0.0));
  km = mix(km, gMapGivenKm, gMapGiven);
  gMapKm = km;
  gBasin = 0.0;
  float base = uType == 0 ? seaLevelH() : 0.15;
  float h = base + (km - uHeightInfo.y) * uHeightInfo.x;
  // Ruggedness: the map against a blurred copy of itself (a fixed level, so every caller agrees).
  float relief = abs(km - textureLod(uHeightMap, uv, 4.0).r) * uHeightInfo.x;
  vec3 q = p * 1.7 + uSeed;
  float zone = smoothstep(0.35, 0.65, vnoise(q * 5.0 + 2.1));
  float mount = mix(0.12, 1.0, max(smoothstep(0.002, 0.03, relief), 0.5 * zone * zone));
  float amp = 0.2, erosion = 0.55, sharp = 0.8;
  if (uType == 2) {
    h += 0.1 * craters(p, detail, texels * 0.1);
    mount = max(mount, 0.5); amp = 0.06; erosion = 0.2; sharp = 0.15;
  } else if (uType == 1) {
    h += 0.05 * craters(p, detail, texels * 0.1);
    mount = max(mount, 0.3);
  } else if (uType == 0) {
    mount *= smoothstep(-0.015, 0.1, h - base);
  }
  rough = mount;
  // Same physical sizes as the procedural relief, starting where the map's resolution runs out.
  float f0 = clamp(0.63 / uHeightScale, 40.0, 150.0) * 1.7;
  // The map's cubic filter smooths away what is near its texel size, so this starts at a wavelength of one texel.
  float fd = max(f0, texels);
  gMapH0 = h;
  gMapAmp = mount * 2.2 * amp * sqrt(f0 / fd);
  if (detail > fd && mount > 0.0) {
    float finest = (uType == 2 ? 24.0 : mix(24.0, 200.0, smoothstep(0.12, 0.45, mount))) * f0 / fd;
    float e = eroded(p * fd + uSeed + 3.0, p, min(detail / fd, finest), erosion, sharp * smoothstep(0.3, 0.75, mount));
    h += mount * e * 2.2 * amp * sqrt(f0 / fd);
  }
  return h;
}

// Returns height (roughly 0..1). Drives colouring, shading and the real geometry.
// 'rough' reports how rugged the place is, for the fine relief layered on top
// (negative: none at all, the surface is liquid).
float terrain(vec3 p, float detail, out float rough) {
  if (uHeightInfo.w > 0.5) return mapTerrain(p, detail, rough);
  detail = min(detail, MAX_DETAIL);
  vec3 q = warped(p);
  float base = fbm(q, min(detail / 1.7, 250.0));
  float h;
  // How mountainous it is here, the relief that buys, and how hard water has worked on it.
  float mount, amp = 0.2, erosion = 0.55, sharp = 0.8;
  float level = -1.0;
  gBasin = 0.0;
  if (uType == 2) {
    h = base * 0.6 + 0.2 + 0.16 * craters(p, detail, 0.0);
    mount = 0.5; amp = 0.06; erosion = 0.2; sharp = 0.15;
  } else if (uType == 3) {
    h = base * 0.7 + 0.15 - 0.25 * pow(ridged(q * 3.1, detail / 5.3), 3.0);
    mount = 0.4; amp = 0.07; erosion = 0.5; sharp = 0.5;
  } else if (uType == 4) {
    h = base * 0.6 + 0.2 + 0.35 * ridged(q * 2.2, detail / 3.7);
    mount = 0.75 * smoothstep(0.42, 0.55, h); amp = 0.12; erosion = 0.6;
  } else {
    float chain = ridged(q * 2.6 + 5.0, min(detail / 4.4, 40.0));
    h = base;
    // Continents are mostly lowland: a kilometre or so of plains, with the relief left to the mountain belts.
    if (uType == 0) h = min(h, seaLevelH() + (h - seaLevelH()) * 0.4);
    h += (chain - 0.25) * (uType == 0 ? 0.14 : 0.3) * smoothstep(0.42, 0.7, base);
    // Mountain belts along the big chains, with hill country scattered between them.
    float belt = smoothstep(0.12, 0.5, chain);
    float zone = smoothstep(0.35, 0.65, vnoise(q * 5.0 + 2.1));
    mount = mix(0.12, 1.0, max(belt, 0.7 * zone * zone));
    if (uType == 1) {
      h += 0.05 * craters(p, detail, 0.0);
      mount = max(mount, 0.3);
    } else {
      mount *= smoothstep(-0.015, 0.1, h - seaLevelH());
    }
    level = basin(p, h, mount);
  }
  rough = mount;
  // Mountains: ridges tens of kilometres across down to gullies, the same physical size on
  // any world (small worlds have taller relief per radius, so fewer cells per radius).
  float f0 = clamp(0.63 / uHeightScale, 40.0, 150.0) * 1.7;
  if (detail > f0 && mount > 0.0) {
    // Gullies are cut into the mountains; the plains between them roll more gently.
    float finest = uType == 2 ? 24.0 : mix(24.0, 200.0, smoothstep(0.12, 0.45, mount));
    float e = eroded(p * f0 + uSeed + 3.0, p, min(detail / f0, finest), erosion, sharp * smoothstep(0.3, 0.75, mount)) * 2.2 * amp;
    if (uType == 1) {
      // Mesa country: here and there the slopes break into steps.
      float steps = 0.8 * smoothstep(0.55, 0.7, vnoise(q * 9.0 + 4.0));
      float t = e / 0.045;
      e = mix(e, (floor(t) + smoothstep(0.38, 0.62, fract(t))) * 0.045, steps * clamp(detail / (f0 * 4.0) - 1.0, 0.0, 1.0));
    }
    h += mount * e;
  }
  if (h < level) {
    h = level;
    gBasin = 1.0;
    rough = -0.3;
  }
  return h;
}

// Metre-scale relief, continuing the terrain below what float32 can address globally.
// fp: fine coordinates (see FINE_FREQ), wrapped to the noise period on the CPU.
// Fades a feature of 'f' cycles per fine cell in as the pixels can show it (d: cells per pixel footprint).
float bandFade(float d, float f) {
  return clamp(d / f - 1.0, 0.0, 1.0);
}

float fineRelief(vec3 fp, float detail, float rough) {
  float d = detail / FINE_FREQ;
  if (d <= 1.0) return 0.0;
  float unit = 3.0e-6 / uHeightScale;   // ~20 m on an Earth-sized world (a fine cell is ~50 m)
  float h = (0.3 + rough) * (pfbm(fp, d) - 0.5);
  // What the ground is made of, at the scale of a person: every coordinate scale below is a whole number,
  // so the patterns repeat with the fine coordinates' period and never show a seam.
  float plain = 1.0 - smoothstep(0.15, 0.55, max(rough, 0.0));
  if (uType == 1) {
    // Sand seas: dunes a few hundred metres apart on the level ground, wind ripples on their flanks.
    float dune = 1.0 - abs(pnoise(fp * 3.0 + 7.0) * 2.0 - 1.0);
    h += plain * 0.55 * (dune * dune - 0.4) * bandFade(d, 3.0);
    float warp = pnoise(fp * 8.0 + 3.0) * 3.0;
    float ripple = sin(6.2831853 * (dot(fp, vec3(60.0, 0.0, 80.0)) * 1.0 + warp));
    h += plain * 0.0035 * ripple * bandFade(d, 100.0);
  }
  if (uType == 1 || uType == 2 || (uType == 0 && rough > 0.25)) {
    // Stones and boulders, scattered more thickly where the ground is rugged: rounded, half-buried lumps
    // of a few metres and a few decimetres, one in some of the cells of a cellular pattern.
    float many = mix(0.25, 0.6, clamp(rough, 0.0, 1.0)) * (uType == 1 ? 0.5 + 0.5 * (1.0 - plain) : 1.0);
    float stones = 0.0;
    if (bandFade(d, 9.0) > 0.0) {
      vec2 w = worley(fp * 9.0 + 11.0);
      float r = 0.15 + 0.2 * fract(w.y * 7.7);
      float x = clamp(1.0 - w.x / r, 0.0, 1.0);
      stones += 0.05 * step(w.y, many) * x * sqrt(x) * bandFade(d, 9.0);
    }
    if (bandFade(d, 47.0) > 0.0) {
      vec2 w = worley(fp * 47.0 + 5.0);
      float r = 0.12 + 0.2 * fract(w.y * 5.3);
      float x = clamp(1.0 - w.x / r, 0.0, 1.0);
      stones += 0.012 * step(w.y, many * 1.3) * x * sqrt(x) * bandFade(d, 47.0);
    }
    h += stones;
  }
  if (uType == 3) {
    // Sastrugi: ridges carved into the snow by the wind, long and narrow.
    float s = 1.0 - abs(pnoise(vec3(fp.x * 6.0, fp.y * 40.0, fp.z * 6.0) + 13.0) * 2.0 - 1.0);
    h += 0.008 * s * s * bandFade(d, 40.0);
  }
  return unit * h;
}

// Height above the datum (sea level on wet worlds) in planet radii.
float displacement(float h) {
  return max(h - (uType == 0 ? seaLevelH() : 0.15), 0.0) * uHeightScale;
}
`;

// One quadtree patch of a cube-sphere. The patch mesh sits at its own centre, so
// everything here is a small offset from that point and survives float32.
export const TERRAIN_VERT = /* glsl */ `
${LOGDEPTH_VERT_PARS}
${PLANET_COMMON}
uniform vec3 uCubeCenter;   // patch centre on the cube face
uniform vec3 uCubeU;        // half-extent axes on the cube face
uniform vec3 uCubeV;
uniform float uRadius;      // km
uniform float uPatchDetail;
uniform float uSkirt;       // planet radii
uniform vec3 uView;         // patch centre relative to the camera, planet radii
uniform vec3 uFineOrigin;   // fine coordinates of the patch centre
uniform float logDepthBufFC;
#ifdef SHADOW
${SHADOW_PROJECT}
#endif
varying vec3 vObj;
varying vec3 vView;
varying vec3 vFine;
varying float vSkirt;
varying float vMapKm;
varying vec4 vGrad;
// Patches this fine (vertices per planet radius) also carry the terrain's slope per vertex, for the
// pixels too close for the per-pixel slope (see the fragment shader).
const float GRAD_DETAIL = 2e4;
void main() {
  vec3 d = position.x * uCubeU + position.y * uCubeV;
  float l0 = length(uCubeCenter);
  vec3 c1 = uCubeCenter + d;
  float l1 = length(c1);
  vec3 n = c1 / l1;
  // n - normalize(centre), written so the two near-equal unit vectors never get subtracted.
  vec3 off = d / l1 - uCubeCenter * ((2.0 * dot(uCubeCenter, d) + dot(d, d)) / ((l1 + l0) * l0 * l1));
  vec3 fp = uFineOrigin + off * FINE_FREQ;
  float rough;
  float height = terrain(n, uPatchDetail, rough);
  vGrad = vec4(0.0);
#ifndef SHADOW
  if (uPatchDetail > GRAD_DETAIL) {
    // Two vertex spacings apart, and at least 2e-6 radii: far enough that float32 rounding of the
    // direction (6e-8) does not matter.
    float e = max(2.0 / uPatchDetail, 2e-6);
    vec3 tu = normalize(uCubeU - n * dot(uCubeU, n)), tv = normalize(uCubeV - n * dot(uCubeV, n));
    float r2;
    float hu = terrain(normalize(n + tu * e), uPatchDetail, r2);
    float hv = terrain(normalize(n + tv * e), uPatchDetail, r2);
    vGrad = vec4(((hu - height) * tu + (hv - height) * tv) / e, 1.0);
  }
#endif
  float h = displacement(height + fineRelief(fp, uPatchDetail, rough)) - position.z * uSkirt;
  vObj = n;
  vMapKm = gMapKm;
  vFine = fp;
  vSkirt = position.z;
  vView = uView + off + n * h;
#ifdef SHADOW
  gl_Position = shadowProject(vView);
#else
  gl_Position = projectionMatrix * modelViewMatrix * vec4(uRadius * (off + n * h), 1.0);
  ${LOGDEPTH_VERT}
  // Logarithmic depth per vertex rather than per fragment: patches are finely tessellated, and
  // leaving gl_FragDepth alone lets the GPU reject hidden terrain before shading it.
  gl_Position.z = (log2(max(1e-6, 1.0 + gl_Position.w)) * logDepthBufFC - 1.0) * gl_Position.w;
#endif
}
`;

// Procedural weather, evaluated once per planet into an equirectangular cloud map.
export const CLOUD_COVER = /* glsl */ `
float cloudCover(vec3 p, float detail) {
  if (uClouds <= 0.0) return 0.0;
  vec3 q = p * 1.5 + uSeed * 1.7;
  // Weather systems: a slow field decides where it is overcast and where it is clear.
  float systems = fbm(q, min(detail, 12.0) / 1.5);
  // Two rounds of domain warping curl the field into fronts and cyclones.
  vec3 w = vec3(fbm(q * 1.9 + 3.1, detail / 2.9), fbm(q * 1.9 + 5.3, detail / 2.9), fbm(q * 1.9 + 7.9, detail / 2.9)) - 0.5;
  vec3 r = q * 2.4 + 2.6 * w;
  r += 0.5 * (vec3(vnoise(r * 2.6 + 1.3), vnoise(r * 2.6 + 4.1), vnoise(r * 2.6 + 6.7)) - 0.5);
  float c = fbm(r, detail / 3.6);
  float fine = fbm(r * 7.0 + 2.0 * w, detail / 25.0);
  // Storm tracks at the equator and mid latitudes, clearer skies over the subtropics.
  float belt = uClouds < 0.99 ? 0.045 * cos(abs(p.y) * 9.5) : 0.0;
  c = c * 0.55 + fine * 0.25 + systems * 0.38 - 0.09 + belt;
  float center = 0.78 - 0.52 * uClouds;
  return smoothstep(center - 0.02, center + 0.16, c) * smoothstep(-0.25, 0.35, fine - 0.5 + c - center + 0.2);
}
`;

// Fragment-only helpers for equirectangular maps (they need screen-space derivatives).
export const SURFACE_MAPS = /* glsl */ `
uniform sampler2D uCloudMap;
uniform vec2 uCloudRot;     // cos, sin of how far the cloud deck has drifted
uniform sampler2D uColorMap;  // real surface colour (sRGB, read as linear)
uniform sampler2D uNightMap;  // city lights (Earth)
uniform sampler2D uCloudTint; // colour of an opaque cloud deck (Venus)
uniform vec4 uMapInfo;        // colour map on, night map on, colour texels around the equator, cloud tint on
uniform vec3 uMapTint;        // gain (and hue, for greyscale mosaics) applied to the colour map

// 'sharp' < 1 picks a finer mip than the footprint asks for (a cloud map's soft edges stay crisp at grazing angles).
vec4 sampleEquirectBias(sampler2D map, vec3 n, float sharp) {
  vec2 uv = equirect(n);
  vec2 alt = vec2(fract(uv.x + 0.5) - 0.5, uv.y);
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  vec2 dxa = dFdx(alt), dya = dFdy(alt);
  if (abs(dxa.x) + abs(dya.x) < abs(dx.x) + abs(dy.x)) { dx = dxa; dy = dya; }
  return textureGrad(map, uv, dx * sharp, dy * sharp);
}

vec4 sampleEquirect(sampler2D map, vec3 n) {
  vec2 uv = equirect(n);
  // Take derivatives from whichever parameterisation is continuous here, so the seam does not shimmer.
  vec2 alt = vec2(fract(uv.x + 0.5) - 0.5, uv.y);
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  vec2 dxa = dFdx(alt), dya = dFdy(alt);
  if (abs(dxa.x) + abs(dya.x) < abs(dx.x) + abs(dy.x)) { dx = dxa; dy = dya; }
  return textureGrad(map, uv, dx, dy);
}

// Cloud cover 0..1 above direction n. The map carries the weather; noise adds the wisps a map cannot hold.
vec3 cloudFrame(vec3 n) {
  return vec3(uCloudRot.x * n.x - uCloudRot.y * n.z, n.y, uCloudRot.y * n.x + uCloudRot.x * n.z);
}

float cloudAt(vec3 n, float detail) {
  if (uClouds <= 0.0) return 0.0;
  vec3 q = cloudFrame(n);
  float c = sampleEquirectBias(uCloudMap, q, 0.6).r;
  float edge = 4.0 * c * (1.0 - c);
  if (detail > 700.0 && edge > 0.01) {
    c = clamp(c + edge * 0.9 * (fbm(q * 600.0 + 3.0, min(detail / 600.0, 40.0)) - 0.5), 0.0, 1.0);
    // Up close a map's soft edges would be a blur kilometres wide: real cloud edges are crisp.
    c = mix(c, smoothstep(0.12, 0.8, c), smoothstep(1500.0, 6000.0, detail));
  }
  return c;
}
`;

export const PLANET_FRAG = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
${PLANET_COMMON}
${RING_DENSITY}
${SURFACE_MAPS}
${atmoCommon(12)}
${ECLIPSE}
uniform float uAtmoTop;     // planet radii
uniform vec3 uShineDir;     // towards the neighbour that lights the night side (object space)
uniform vec3 uShine;        // the light it throws here
uniform vec3 uRingShine;    // light off the sunlit face of the rings, with the star overhead them
varying vec3 vObj;
varying vec3 vView;         // camera to surface, planet radii
varying vec3 vFine;
varying float vSkirt;       // above zero on the curtain that hangs under a patch's edge
varying float vMapKm;       // the real map's height, interpolated between the vertices
varying vec4 vGrad;         // the terrain's slope from the vertices (w = 1 where there is one)
uniform sampler2D uRingMap; // real ring colour and opacity, inner edge to outer
uniform float uRingMapOn;
${SHADOW_LOOKUP}

float ringOpacity(float t) {
  if (uRingMapOn > 0.5) return t < 0.0 || t > 1.0 ? 0.0 : textureLod(uRingMap, vec2(t, 0.5), 2.0).a;
  return ringDensity(t, uRing.z);
}

// Height of a sea surface in fine cells: wind waves crossing each other, every octave drifting
// at the pace water waves of that length travel. 'lost' receives the slope variance of the
// octaves too fine for the pixels to show, which spreads the sun's reflection out instead.
float waves(vec3 fp, float d, out float lost) {
  float sum = 0.0;
  lost = 0.0;
  float freq = 1.0, amp = 0.17, speed = 0.18;
  for (int i = 0; i < 5; i++) {
    float fade = clamp(d / freq - 1.0, 0.0, 1.0);
    if (fade > 0.0) {
      // Whole multiples of the noise period, so the wrap of the clock never shows.
      vec3 drift = mod(uTime * speed, 1024.0) * ((i & 1) == 0 ? vec3(0.75, 0.25, 0.5) : vec3(-0.5, 0.75, -0.25));
      sum += amp / freq * fade * (pnoise(fp * freq + drift + float(i) * 19.0) - 0.5);
    }
    lost += (1.0 - fade * fade) * amp * amp * 0.4;
    freq *= 2.0;
    speed *= 1.41;
    amp *= 0.9;
  }
  return sum;
}

vec3 gasColor(vec3 p, float detail, float contrast) {
  vec3 q = p + uSeed;
  float turb = fbm(q * vec3(3.0, 9.0, 3.0) + vec3(uTime * 0.002, 0.0, 0.0), detail / 9.0) - 0.5;
  float lat = p.y + 0.07 * turb;
  // Storm ovals: warp latitude bands around a few cells.
  vec2 cell = worley(vec3(p.x * 2.5, p.y * 6.0, p.z * 2.5) + uSeed);
  lat += 0.03 * smoothstep(0.45, 0.0, cell.x) * sin(cell.x * 30.0);
  float bands = fbm(vec3(lat * 9.0, uSeed, 0.5), 64.0);
  float fine = fbm(vec3(lat * 34.0 + turb * 2.0, q.x * 1.5, q.z * 1.5), detail / 34.0);
  float v = clamp(0.5 + (bands - 0.5) * 2.4 * contrast + (fine - 0.5) * 0.6 * contrast, 0.0, 1.0);
  vec3 c = mix(uPal[3], uPal[1], smoothstep(0.0, 0.35, v));
  c = mix(c, uPal[0], smoothstep(0.3, 0.6, v));
  c = mix(c, uPal[2], smoothstep(0.6, 0.95, v));
  float pole = smoothstep(0.75, 0.98, abs(p.y));
  return mix(c, uPal[1] * 0.7, pole * 0.6);
}
`;
