// Shared GLSL snippets. All custom materials render into a logarithmic depth
// buffer, so they pull in three's logdepth chunks through these helpers.

export const LOGDEPTH_VERT_PARS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
`;
export const LOGDEPTH_VERT = /* glsl */ `
#include <logdepthbuf_vertex>
`;
export const LOGDEPTH_FRAG_PARS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
`;
export const LOGDEPTH_FRAG = /* glsl */ `
#include <logdepthbuf_fragment>
`;

export const NOISE = /* glsl */ `
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

// Value noise with quintic interpolation, range 0..1.
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash13(i);
  float b = hash13(i + vec3(1, 0, 0));
  float c = hash13(i + vec3(0, 1, 0));
  float d = hash13(i + vec3(1, 1, 0));
  float e = hash13(i + vec3(0, 0, 1));
  float g = hash13(i + vec3(1, 0, 1));
  float h = hash13(i + vec3(0, 1, 1));
  float k = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}

const mat3 OCTAVE_ROT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);

// fBm that stops adding octaves once they fall below the pixel footprint,
// which keeps distant planets alias-free and near ones detailed.
// 'detail' is the highest useful frequency (features per unit).
float fbm(vec3 p, float detail) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  float norm = 0.0;
  for (int i = 0; i < 18; i++) {
    float fade = clamp(detail / freq - 1.0, 0.0, 1.0);
    if (fade <= 0.0) break;
    sum += amp * mix(0.5, vnoise(p), fade);
    norm += amp;
    p = OCTAVE_ROT * p * 2.03 + 17.1;
    freq *= 2.03;
    amp *= 0.56;
  }
  return norm > 0.0 ? sum / norm : 0.5;
}

// Ridged variant for mountain chains, range 0..1.
float ridged(vec3 p, float detail) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  float norm = 0.0;
  float prev = 1.0;
  for (int i = 0; i < 12; i++) {
    float fade = clamp(detail / freq - 1.0, 0.0, 1.0);
    if (fade <= 0.0) break;
    float n = 1.0 - abs(vnoise(p) * 2.0 - 1.0);
    n *= n;
    sum += amp * fade * n * prev;
    norm += amp;
    prev = n;
    p = OCTAVE_ROT * p * 2.07 + 9.7;
    freq *= 2.07;
    amp *= 0.5;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}

// Value noise with its gradient: x is the value (0..1), yzw the derivative.
vec4 vnoised(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec3 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float a = hash13(i);
  float b = hash13(i + vec3(1, 0, 0));
  float c = hash13(i + vec3(0, 1, 0));
  float d = hash13(i + vec3(1, 1, 0));
  float e = hash13(i + vec3(0, 0, 1));
  float g = hash13(i + vec3(1, 0, 1));
  float h = hash13(i + vec3(0, 1, 1));
  float k = hash13(i + vec3(1, 1, 1));
  float k1 = b - a, k2 = c - a, k3 = e - a;
  float k4 = a - b - c + d, k5 = a - c - e + h, k6 = a - b - e + g;
  float k7 = -a + b + c - d + e - g - h + k;
  return vec4(
    a + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z,
    du * vec3(k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z, k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x, k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y));
}

// Mountains that look carved by water (after Quilez): every octave is damped where the
// octaves below it are already steep, so crests stay sharp while gullies branch down
// the flanks. 'up' is the local vertical: only the slope along the ground counts.
// 'sharp' folds the octaves into ridges (1) or leaves them as rolling hills (0); the fold
// is rounded a little so the slope, and with it the damping, stays continuous across a crest.
// The broadest octaves are folded less: massifs first, then the ridges that run down them.
// Every octave is centred on zero, so the mean height does not drift as detail fades in.
float eroded(vec3 p, vec3 up, float detail, float erosion, float sharp) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  vec3 run = vec3(0.0);
  for (int i = 0; i < 12; i++) {
    float fade = clamp(detail / freq - 1.0, 0.0, 1.0);
    if (fade <= 0.0) break;
    vec4 n = vnoised(p);
    float t = n.x * 2.0 - 1.0;
    float a = sqrt(t * t + 0.03);
    float s = sharp * min(0.45 + 0.3 * float(i), 1.0);
    float v = mix(n.x, 1.0 - a, s) - 0.5;
    vec3 g = n.yzw * mix(1.0, -2.0 * t / a, s);
    run += (g - up * dot(g, up)) * fade;
    sum += amp * fade * v / (1.0 + erosion * dot(run, run));
    p = OCTAVE_ROT * p * 2.0 + 13.7;
    up = OCTAVE_ROT * up;
    run = OCTAVE_ROT * run;
    freq *= 2.0;
    amp *= 0.5;
  }
  return sum;
}

// Value noise that repeats every 256 cells. Terrain finer than float32 can address
// on a whole planet is built from this, fed with coordinates wrapped on the CPU.
float pnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec3 j = mod(i + 1.0, 256.0);
  i = mod(i, 256.0);
  float a = hash13(i);
  float b = hash13(vec3(j.x, i.y, i.z));
  float c = hash13(vec3(i.x, j.y, i.z));
  float d = hash13(vec3(j.x, j.y, i.z));
  float e = hash13(vec3(i.x, i.y, j.z));
  float g = hash13(vec3(j.x, i.y, j.z));
  float h = hash13(vec3(i.x, j.y, j.z));
  float k = hash13(j);
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}

float pfbm(vec3 p, float detail) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  float norm = 0.0;
  for (int i = 0; i < 8; i++) {
    float fade = clamp(detail / freq - 1.0, 0.0, 1.0);
    if (fade <= 0.0) break;
    sum += amp * mix(0.5, pnoise(p), fade);
    norm += amp;
    p = p * 2.0 + 37.0;
    freq *= 2.0;
    amp *= 0.5;
  }
  return norm > 0.0 ? sum / norm : 0.5;
}

// Cellular noise: distance to the nearest feature point (exact within half a cell), used for craters.
vec2 worley(vec3 p) {
  vec3 i = floor(p - 0.5);
  vec3 f = p - i;
  float d1 = 9.0;
  float id = 0.0;
  for (int x = 0; x <= 1; x++)
  for (int y = 0; y <= 1; y++)
  for (int z = 0; z <= 1; z++) {
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 o = hash33(i + g);
    float d = length(g + o - f);
    if (d < d1) { d1 = d; id = o.x; }
  }
  return vec2(d1, id);
}

// The same, also reporting where the nearest feature point is, and in z the distance to the
// runner-up: z - x falls to zero on the border of the cell, where the identity changes hands.
vec3 worleyAt(vec3 p, out vec3 at) {
  vec3 i = floor(p - 0.5);
  vec3 f = p - i;
  float d1 = 9.0;
  float d2 = 9.0;
  float id = 0.0;
  at = p;
  for (int x = 0; x <= 1; x++)
  for (int y = 0; y <= 1; y++)
  for (int z = 0; z <= 1; z++) {
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 o = hash33(i + g);
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; id = o.y; at = i + g + o; }
    else if (d < d2) d2 = d;
  }
  return vec3(d1, id, d2);
}
`;
