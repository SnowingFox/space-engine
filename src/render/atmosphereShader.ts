import { LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, LOGDEPTH_VERT, LOGDEPTH_VERT_PARS } from './glsl';
import { atmoCommon } from './atmosphereScatter';
import { ECLIPSE, RING_SCATTER } from './lighting';
import { RING_DENSITY } from './planetShader';

export const WORLD_VERT = /* glsl */ `
${LOGDEPTH_VERT_PARS}
varying vec3 vWorld;
varying vec3 vObj;
void main() {
  vObj = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  ${LOGDEPTH_VERT}
}
`;

// The sky: drawn on the far side of the shell, so anything solid hides it and
// only rays that leave the planet (or graze its limb) get this far.
export const ATMO_FRAG = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
${atmoCommon(12)}
${ECLIPSE}
uniform vec3 uCenter;     // planet centre relative to camera, km
uniform float uRadius;    // km
uniform float uTop;       // atmosphere top, planet radii (e.g. 1.022)
uniform vec3 uSunDir;     // world space, towards the star
uniform vec3 uSunColor;
uniform vec3 uColor;
uniform float uDensity;
uniform float uAirglow;   // night glow of the upper air: oxygen, green below and red above
uniform float uGiant;     // 1 on gas giants: a thin layer of haze over the cloud tops
varying vec3 vWorld;

// Length of the ray's way through the shell between radii a and b.
float shellPath(vec3 ro, vec3 rd, float a, float b) {
  vec2 o = raySphere(ro, rd, b);
  if (o.x > o.y || o.y < 0.0) return 0.0;
  float len = o.y - max(o.x, 0.0);
  vec2 i = raySphere(ro, rd, a);
  if (i.x < i.y && i.y > 0.0) len -= i.y - max(i.x, 0.0);
  return max(len, 0.0);
}

void main() {
  vec3 rd = normalize(vWorld);
  vec3 ro = -uCenter / uRadius;
  // Looking at the ground: the surface in front has already added its own haze.
  vec2 tp = raySphere(ro, rd, 0.9995);
  if (tp.x < tp.y && tp.x > 0.0) discard;
  vec3 od;
  // A moon's shadow darkens the sky it falls on, taken halfway along the ray's way through the air: in the
  // umbra the sky overhead goes dark while low down, beyond the shadow, the horizon glows like a dusk all round.
  vec2 ts = raySphere(ro, rd, uTop);
  vec3 ecl = eclipseLight(ro + rd * max(0.5 * (max(ts.x, 0.0) + ts.y), 0.0), uSunDir);
  vec3 col = uSunColor * ecl * atmoScatter(ro, rd, 1e9, uSunDir, uTop, uColor, uDensity, od);
  if (uAirglow > 0.0) {
    // Oxygen's green line from a layer near 95 km, and fainter red higher up. Each layer is three nested
    // shells, so its edges are soft: from the ground it is only a faint brightening low over the horizon
    // (the long way through the layer there), from orbit a thin line above the night limb.
    float d = uTop - 1.0;
    float green = 0.5 * shellPath(ro, rd, 1.0 + d * 1.12, 1.0 + d * 1.2)
      + 0.3 * shellPath(ro, rd, 1.0 + d * 1.06, 1.0 + d * 1.26) + 0.2 * shellPath(ro, rd, 1.0 + d * 1.0, 1.0 + d * 1.34);
    float red = 0.6 * shellPath(ro, rd, 1.0 + d * 1.35, 1.0 + d * 1.55) + 0.4 * shellPath(ro, rd, 1.0 + d * 1.25, 1.0 + d * 1.7);
    col += (vec3(0.35, 1.0, 0.45) * green + vec3(1.0, 0.25, 0.15) * (0.15 * red)) * (uAirglow * 0.22) * exp(-od);
  }
  if (uGiant > 0.0) {
    // Backlit, the haze over a giant's cloud tops scatters sunlight forward into a thin bright rim
    // just off the limb (Cassini's view of Saturn eclipsing the Sun); from the day side it is faint.
    float path = shellPath(ro, rd, 1.0, 1.006);
    vec3 pc = ro + rd * max(-dot(ro, rd), 0.0);
    float bs = dot(pc, uSunDir);
    float perp = sqrt(max(dot(pc, pc) - bs * bs, 0.0));
    float lit = bs > 0.0 ? 1.0 : smoothstep(0.995, 1.003, perp);
    float g = 0.8, mu = dot(rd, uSunDir);
    float hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5);
    col += uSunColor * ecl * uColor * min(path * hg * lit * 0.35, 2.0);
  }
  // (One bad pixel would be spread over the whole frame by the bloom.)
  if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
  // What lies behind is dimmed in the pass before this one; here a bright daytime sky drowns the stars out.
  gl_FragColor = vec4(col, clamp(1.0 - exp(-dot(col, vec3(4.0))), 0.0, 1.0));
  ${LOGDEPTH_FRAG}
}
`;

// Extinction: whatever lies behind the air (stars, the Milky Way, other worlds) loses light
// to it, blue first, so stars dim and redden towards the horizon. Drawn as a multiply.
export const ATMO_EXTINCT_FRAG = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
${atmoCommon(1)}
uniform vec3 uCenter;
uniform float uRadius;
uniform float uTop;
uniform vec3 uColor;
uniform float uDensity;
varying vec3 vWorld;

void main() {
  vec3 rd = normalize(vWorld);
  vec3 ro = -uCenter / uRadius;
  vec2 tp = raySphere(ro, rd, 0.9995);
  if (tp.x < tp.y && tp.x > 0.0) discard;
  vec2 ta = raySphere(ro, rd, uTop);
  if (ta.x > ta.y || ta.y < 0.0) discard;
  vec3 p = ro + rd * max(ta.x, 0.0);
  float hGas, hHaze, haze;
  vec3 gas, ozone;
  atmoMedium(uTop, uColor, uDensity, hGas, hHaze, gas, ozone, haze);
  // (Aerosols dim what lies behind more than the haze that colours the sky lets on: with them a star
  // loses about a sixth of its light at the zenith and is gone a degree or two above the horizon.)
  vec3 od = (gas + ozone) * atmoColumn(p, rd, hGas) + haze * 4.0 * atmoColumn(p, rd, hHaze);
  vec3 t = exp(-od);
  gl_FragColor = vec4(any(isnan(t)) ? vec3(1.0) : t, 1.0);
  ${LOGDEPTH_FRAG}
}
`;

export const RING_FRAG = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
${RING_DENSITY}
${ECLIPSE}
${RING_SCATTER}
uniform vec4 uRing;       // inner, outer, seed, -
uniform vec3 uColor;
uniform vec3 uSunDir;     // ring object space (planet radii), towards the star
uniform vec3 uSunColor;
uniform vec3 uCamObj;
varying vec3 vObj;

void main() {
  float r = length(vObj.xz);
  float d = ringDensity((r - uRing.x) / (uRing.y - uRing.x), uRing.z);
  if (d < 0.004) discard;
  // Shadow of the planet (unit sphere at the origin) falling across the ring.
  float b = dot(vObj, uSunDir);
  float perp = sqrt(max(dot(vObj, vObj) - b * b, 0.0));
  float shadow = b > 0.0 ? 1.0 : smoothstep(0.97, 1.03, perp);
  vec3 L = normalize(uSunDir);
  float lit = ringScatter(vObj, d, L, uCamObj, 0.55 + 0.45 * d);
  float grain = 0.9 + 0.1 * sin(r * 900.0);
  vec3 col = uColor * uSunColor * eclipseLight(vObj, L) * 1.5 * lit * shadow * grain;
  gl_FragColor = vec4(col, d * 0.96);
  ${LOGDEPTH_FRAG}
}
`;
