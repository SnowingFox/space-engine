// Single-scattering atmosphere, ray-marched through a shell around the planet.
// All lengths are in planet radii. Shared by the sky shell and by every surface
// under it, so haze over terrain and the sky behind it come from the same integral.
//
// Two layers, as on Earth: gas (Rayleigh), whose density halves every few kilometres, and
// haze (Mie), which hugs the ground. Ozone rides with the gas and only absorbs: it is what
// keeps the sky blue at dusk, when sunlight crosses the air at a grazing angle.
// Light scattered twice is estimated, not traced: the air around each point glows with the
// sunlight that reaches the air above it. That is what fills in a twilight sky.

/** Scale height of the gas as a fraction of the shell's depth: the shell ends six scale heights up. */
export const ATMO_SCALE = 1 / 6;
/** Scale height of the haze relative to that of the gas. */
export const ATMO_HAZE = 0.3;
/** Optical depth at the zenith for a density of 1: gas (times the atmosphere's colour) and haze. */
export const ATMO_GAS_DEPTH = 0.2;
export const ATMO_HAZE_DEPTH = 0.02;
/** What ozone absorbs, relative to the blue the gas scatters. */
export const ATMO_OZONE: readonly [number, number, number] = [0.09, 0.22, 0.006];

export function atmoCommon(viewSteps: number): string {
  return /* glsl */ `
const int ATMO_VIEW_STEPS = ${viewSteps};
const float ATMO_SCALE = ${ATMO_SCALE.toFixed(5)};
const float ATMO_HAZE = ${ATMO_HAZE.toFixed(3)};
const vec3 ATMO_OZONE = vec3(${ATMO_OZONE.join(', ')});

vec2 raySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float d = b * b - c;
  if (d < 0.0) return vec2(1.0, -1.0);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}

// Optical depth from p out to space along dir, in units of density * length: the
// Chapman function in Schüler's closed-form approximation, so no inner ray march.
float atmoColumn(vec3 p, vec3 dir, float scaleH) {
  float r = length(p);
  float mu = dot(p, dir) / r;
  float X = 1.0 / scaleH;
  float h = max(r - 1.0, 0.0) * X;
  float c = sqrt(1.5708 * (X + h));
  if (mu >= 0.0) return scaleH * c / (c * mu + 1.0) * exp(-h);
  float x0 = sqrt(max(1.0 - mu * mu, 0.0)) * (X + h);
  return scaleH * (2.0 * sqrt(1.5708 * x0) * exp(min(X - x0, 20.0)) - c / (1.0 - c * mu) * exp(-h));
}

// Extinction per unit of gas and of haze.
void atmoMedium(float top, vec3 color, float density, out float hGas, out float hHaze, out vec3 gas, out vec3 ozone, out float haze) {
  hGas = (top - 1.0) * ATMO_SCALE;
  hHaze = hGas * ATMO_HAZE;
  gas = color * (${ATMO_GAS_DEPTH.toFixed(3)} * density / hGas);
  ozone = ATMO_OZONE * (max(color.b - color.r, 0.0) * ${ATMO_GAS_DEPTH.toFixed(3)} * density / hGas);
  haze = ${ATMO_HAZE_DEPTH.toFixed(3)} * density / hHaze;
}

// Light scattered towards the camera along ro + rd * [0, tEnd], for a unit-colour sun.
// 'od' receives the optical depth of that stretch (extinction of what lies behind it).
// 'most': steps at most (up to ATMO_VIEW_STEPS). 'adapt': fewer on a short stretch that stays at about
// one height (the air in front of nearby ground), where the integrand barely changes.
vec3 atmoScatterSteps(vec3 ro, vec3 rd, float tEnd, vec3 sunDir, float top, vec3 color, float density, int most, bool adapt, out vec3 od) {
  od = vec3(0.0);
  vec2 ta = raySphere(ro, rd, top);
  if (ta.x > ta.y || ta.y < 0.0) return vec3(0.0);
  float t0 = max(ta.x, 0.0);
  float t1 = min(ta.y, tEnd);
  if (t1 <= t0) return vec3(0.0);

  float hGas, hHaze, haze;
  vec3 gas, ozone;
  atmoMedium(top, color, density, hGas, hHaze, gas, ozone, haze);
  // Haze takes a little more light than it scatters on.
  float hazeOut = haze * 1.1;

  int steps = min(most, ATMO_VIEW_STEPS);
  if (adapt) {
    // A step at most 0.4 gas scale heights long and half a haze scale height deep.
    float rise = abs(length(ro + rd * t1) - length(ro + rd * t0));
    float need = max((t1 - t0) / (0.4 * hGas), rise / (0.5 * hHaze));
    steps = int(clamp(ceil(need), 2.0, float(steps)));
  }
  float dt = (t1 - t0) / float(steps);
  float lift = 2.5 * hGas;
  vec3 sumGas = vec3(0.0), sumHaze = vec3(0.0), sumSky = vec3(0.0);
  for (int i = 0; i < ATMO_VIEW_STEPS; i++) {
    if (i >= steps) break;
    vec3 p = ro + rd * (t0 + (float(i) + 0.5) * dt);
    float r = length(p);
    float h = max(r - 1.0, 0.0);
    float thin = exp(-h / hGas);
    float dGas = thin * dt, dHaze = exp(-h / hHaze) * dt;
    vec3 step = (gas + ozone) * dGas + hazeOut * dHaze;
    vec3 here = exp(-(od + 0.5 * step));
    // Is this sample lit? The planet's shadow, then the air the sunlight crossed on its way here.
    float bs = dot(p, sunDir);
    float perp = sqrt(max(dot(p, p) - bs * bs, 0.0));
    float lit = bs > 0.0 ? 1.0 : smoothstep(0.996, 1.001, perp);
    if (lit > 0.0) {
      vec3 sunOd = (gas + ozone) * atmoColumn(p, sunDir, hGas) + hazeOut * atmoColumn(p, sunDir, hHaze);
      vec3 through = here * exp(-sunOd) * lit;
      sumGas += through * dGas;
      sumHaze += through * dHaze;
    }
    // The sky overhead still sees the sun a while after this point has lost it.
    float litSky = bs > 0.0 ? 1.0 : smoothstep(0.996, 1.001, perp + lift);
    if (litSky > 0.0) {
      vec3 skyOd = (gas + ozone) * atmoColumn(p * (1.0 + lift / r), sunDir, hGas);
      vec3 around = 1.0 - exp(-gas * (4.0 * hGas * thin));
      sumSky += here * exp(-skyOd) * around * (litSky * dGas);
    }
    od += step;
  }

  float mu = dot(rd, sunDir);
  float phaseR = 0.0597 * (1.0 + mu * mu);
  float g = 0.76;
  float phaseM = 0.0796 * (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5);
  return 7.0 * ((sumGas * phaseR + sumSky * 0.12) * gas + sumHaze * (haze * phaseM));
}

vec3 atmoScatter(vec3 ro, vec3 rd, float tEnd, vec3 sunDir, float top, vec3 color, float density, out vec3 od) {
  return atmoScatterSteps(ro, rd, tEnd, sunDir, top, color, density, ATMO_VIEW_STEPS, false, od);
}

// Colour of direct sunlight after crossing the atmosphere down to p: white at noon, red at dusk.
vec3 atmoSunlight(vec3 p, vec3 sunDir, float top, vec3 color, float density) {
  float hGas, hHaze, haze;
  vec3 gas, ozone;
  atmoMedium(top, color, density, hGas, hHaze, gas, ozone, haze);
  return exp(-(gas + ozone) * atmoColumn(p, sunDir, hGas) - haze * 1.1 * atmoColumn(p, sunDir, hHaze));
}
`;
}

function column(r: number, mu: number, scaleH: number): number {
  const X = 1 / scaleH;
  const h = Math.max(r - 1, 0) * X;
  const c = Math.sqrt(1.5708 * (X + h));
  if (mu >= 0) return scaleH * c / (c * mu + 1) * Math.exp(-h);
  const x0 = Math.sqrt(Math.max(1 - mu * mu, 0)) * (X + h);
  return scaleH * (2 * Math.sqrt(1.5708 * x0) * Math.exp(Math.min(X - x0, 20)) - c / (1 - c * mu) * Math.exp(-h));
}

/**
 * What is left of each colour of a star's light on reaching a point at r planet radii from the
 * centre, where the star stands at the angle acos(mu) from the zenith: atmoSunlight, on the CPU.
 */
export function atmoTransmittance(r: number, mu: number, top: number, color: readonly number[], density: number, out: number[]): number[] {
  const hGas = (top - 1) * ATMO_SCALE, hHaze = hGas * ATMO_HAZE;
  const gas = column(r, mu, hGas) * ATMO_GAS_DEPTH * density / hGas;
  const haze = column(r, mu, hHaze) * ATMO_HAZE_DEPTH * 1.1 * density / hHaze;
  const blue = Math.max(color[2] - color[0], 0);
  for (let i = 0; i < 3; i++) out[i] = Math.exp(-(color[i] + ATMO_OZONE[i] * blue) * gas - haze);
  return out;
}
