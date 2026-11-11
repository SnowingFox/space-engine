import { LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, LOGDEPTH_VERT, LOGDEPTH_VERT_PARS } from './glsl';
import { atmoCommon } from './atmosphereScatter';
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
${atmoCommon(16)}
uniform vec3 uCenter;     // planet centre relative to camera, km
uniform float uRadius;    // km
uniform float uTop;       // atmosphere top, planet radii (e.g. 1.022)
uniform vec3 uSunDir;     // world space, towards the star
uniform vec3 uSunColor;
uniform vec3 uColor;
uniform float uDensity;
uniform float uAirglow;   // night glow of the upper air: oxygen, green below and red above
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
  vec3 col = uSunColor * atmoScatter(ro, rd, 1e9, uSunDir, uTop, uColor, uDensity, od);
  if (uAirglow > 0.0) {
    float d = uTop - 1.0;
    float green = shellPath(ro, rd, 1.0 + d * 1.08, 1.0 + d * 1.24);
    float red = shellPath(ro, rd, 1.0 + d * 1.3, 1.0 + d * 1.6);
    col += (vec3(0.3, 1.0, 0.42) * green + vec3(1.0, 0.18, 0.12) * (0.25 * red)) * (uAirglow * 0.6) * exp(-od);
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
  vec3 od = (gas + ozone) * atmoColumn(p, rd, hGas) + haze * 1.1 * atmoColumn(p, rd, hHaze);
  vec3 t = exp(-od);
  gl_FragColor = vec4(any(isnan(t)) ? vec3(1.0) : t, 1.0);
  ${LOGDEPTH_FRAG}
}
`;

export const RING_FRAG = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
${RING_DENSITY}
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
  // The unlit face only shows light that leaks through thin regions.
  bool sameSide = uSunDir.y * uCamObj.y > 0.0;
  float lit = sameSide ? 0.55 + 0.45 * d : 0.5 * (1.0 - d) + 0.06;
  float grain = 0.9 + 0.1 * sin(r * 900.0);
  vec3 col = uColor * uSunColor * 1.5 * lit * shadow * grain + uColor * 0.004;
  gl_FragColor = vec4(col, d * 0.96);
  ${LOGDEPTH_FRAG}
}
`;
