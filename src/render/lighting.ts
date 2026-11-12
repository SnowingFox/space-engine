import * as THREE from 'three';
import type { BodyData, PlanetType } from '../universe/bodies';
import { atmoTransmittance } from './atmosphereScatter';

// Light between the bodies of a system: eclipses (one body's shadow on another, from the star's real
// angular size), the light a body throws onto its neighbours' night sides, and how bright the star
// is where each body is.

/** For comparisons and tuning: each part of the system lighting can be switched off. */
export const lightSwitches = { eclipses: true, shine: true, starGain: true, flare: true };

/** Bodies whose shadow a surface shader checks: enough for a moon over its planet and a planet behind a moon. */
export const OCCLUDERS = 2;

/**
 * Night sides are lit only by what really shines on them, but that light is far fainter than the
 * star's: Earthshine on the Moon is about 1/10 000 of sunlight, and would vanish at the exposure a
 * sunlit crescent beside it sets. Eyes adapt locally to the dark (and SpaceEngine shows it so);
 * this stands in for that, compressing faint light the way perceived brightness does (as its
 * square root). Physical share of full starlight in, share to render out.
 */
function perceived(share: number): number {
  // Calibrated so Earthshine (8e-5 of sunlight) shows at about 8% of the sunlit Moon, as eyes (and SpaceEngine) see it.
  return Math.min(13 * Math.sqrt(Math.max(share, 0)), 0.3);
}

/** Fraction of the star's light reflected, by kind of surface (Bond albedos of the like in the Solar System). */
const ALBEDO: Record<PlanetType, number> = {
  terran: 0.3, ocean: 0.29, desert: 0.25, barren: 0.12, ice: 0.6, lava: 0.1, gas: 0.34, icegiant: 0.3,
};

/** Fragment-side: what is left of the starlight at p, given the occluders (any frame, in units of this body's radius). */
export const ECLIPSE = /* glsl */ `
uniform vec4 uOcc[${OCCLUDERS}];     // a body that may stand in front of the star: centre, radius (w = 0: none)
uniform vec3 uOccAir[${OCCLUDERS}];  // light its atmosphere bends into its umbra, as a share of full sunlight
uniform float uSunRadius;            // angular radius of the star from here, radians

// Share of a disc of angular radius rs hidden by one of radius ro whose centre is d away.
float discCover(float rs, float ro, float d) {
  if (d >= rs + ro) return 0.0;
  if (d <= abs(rs - ro)) return ro >= rs ? 1.0 : (ro * ro) / (rs * rs);
  float a = rs * rs * acos(clamp((d * d + rs * rs - ro * ro) / (2.0 * d * rs), -1.0, 1.0));
  float b = ro * ro * acos(clamp((d * d + ro * ro - rs * rs) / (2.0 * d * ro), -1.0, 1.0));
  float k = 0.5 * sqrt(max((-d + rs + ro) * (d + rs - ro) * (d - rs + ro) * (d + rs + ro), 0.0));
  return clamp((a + b - k) / (3.14159265 * rs * rs), 0.0, 1.0);
}

vec3 eclipseLight(vec3 p, vec3 L) {
  vec3 light = vec3(1.0);
  for (int i = 0; i < ${OCCLUDERS}; i++) {
    if (uOcc[i].w <= 0.0) continue;
    vec3 to = uOcc[i].xyz - p;
    float dist = length(to);
    if (dot(to, L) <= 0.0) continue;
    vec3 dir = to / dist;
    float ro = asin(min(uOcc[i].w / dist, 1.0));
    // (atan of sine and cosine: acos would lose these small angles to rounding.)
    float d = atan(length(cross(dir, L)), dot(dir, L));
    float cover = discCover(max(uSunRadius, 1e-6), ro, d);
    light *= 1.0 - cover + cover * uOccAir[i];
  }
  return light;
}
`;

/** Per-body lighting, recomputed every frame by the system view (world space, km, relative to the camera). */
export interface BodyLight {
  /** Colour and strength of the starlight here (the star's colour, scaled for distance). */
  readonly sun: THREE.Color;
  /** Angular radius of the star seen from the body, radians. */
  sunRadius: number;
  /** Occluders: centre relative to the camera, radius (km), and the light their air lets into the umbra. */
  readonly occ: { pos: THREE.Vector3; radius: number; air: THREE.Vector3 }[];
  occCount: number;
  /** Towards the body that lights the night side most, and what it adds (relative to full starlight). */
  readonly shineDir: THREE.Vector3;
  readonly shine: THREE.Color;
  /** Light from the sunlit face of the body's own rings. */
  readonly ringShine: THREE.Color;
  /** Normal of the plane the body (or its planet) orbits the star in. */
  readonly orbitNormal: THREE.Vector3;
}

export function makeBodyLight(): BodyLight {
  return {
    sun: new THREE.Color(1, 1, 1), sunRadius: 0.0046,
    occ: Array.from({ length: OCCLUDERS }, () => ({ pos: new THREE.Vector3(), radius: 0, air: new THREE.Vector3(1, 1, 1) })),
    occCount: 0, shineDir: new THREE.Vector3(0, 1, 0), shine: new THREE.Color(0, 0, 0), ringShine: new THREE.Color(0, 0, 0),
    orbitNormal: new THREE.Vector3(0, 1, 0),
  };
}

/** Uniforms for ECLIPSE (one set per frame of reference). */
export function eclipseUniforms(): Record<string, THREE.IUniform> {
  return {
    uOcc: { value: Array.from({ length: OCCLUDERS }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uOccAir: { value: Array.from({ length: OCCLUDERS }, () => new THREE.Vector3(0, 0, 0)) },
    uSunRadius: { value: 0.0046 },
  };
}

/**
 * Fills a set of ECLIPSE uniforms from the light, in a frame given by `toFrame` (world-space vector
 * relative to the body's centre in, frame vector out), in units of the body's radius.
 */
export function setEclipse(u: Record<string, THREE.IUniform>, light: BodyLight, centre: THREE.Vector3, radius: number, toFrame: (v: THREE.Vector3) => THREE.Vector3): void {
  const occ = u.uOcc.value as THREE.Vector4[];
  const air = u.uOccAir.value as THREE.Vector3[];
  u.uSunRadius.value = light.sunRadius;
  for (let i = 0; i < OCCLUDERS; i++) {
    if (i >= light.occCount) {
      occ[i].w = 0;
      continue;
    }
    const o = light.occ[i];
    const v = toFrame(tmp.copy(o.pos).sub(centre)).multiplyScalar(1 / radius);
    occ[i].set(v.x, v.y, v.z, o.radius / radius);
    air[i].copy(o.air);
  }
}

const tmp = new THREE.Vector3();
const toSun = new THREE.Vector3();
const toOther = new THREE.Vector3();
const toBody = new THREE.Vector3();
const through = [1, 1, 1];

export function albedoOf(b: BodyData): number {
  return THREE.MathUtils.lerp(ALBEDO[b.type], 0.7, Math.min(b.clouds, 1) * 0.5);
}

/**
 * How bright the star looks from a distance: its flux (inverse square), softened the way adapting
 * eyes soften it. Closer in than Earth the glare of the ground grows quickly (Mercury's 6.6 times
 * Earth's sunlight reads as harsh, brilliant light); further out eyes open up, so Saturn's 1/90 still
 * looks clearly sunlit, only dimmer.
 */
export function starGain(lum: number, distKm: number): number {
  const au = distKm / 1.495978707e8;
  const flux = lum / Math.max(au * au, 1e-6);
  return THREE.MathUtils.clamp(Math.pow(flux, flux > 1 ? 0.3 : 0.15), 0.25, 3);
}

interface Placed { body: BodyData; pos: THREE.Vector3; atmoTop: number }

/**
 * Light for one body of the system. pos: every body's position relative to the star (km);
 * camRel: the camera relative to the star; starColor / starLum / starRadius: the star.
 */
export function computeLight(out: BodyLight, me: Placed, all: readonly Placed[], cam: THREE.Vector3, starColor: THREE.Color, starLum: number, starRadiusKm: number): void {
  const b = me.body;
  const dist = me.pos.length();
  out.sun.copy(starColor).multiplyScalar(lightSwitches.starGain ? starGain(starLum, dist) : 1);
  out.sunRadius = Math.asin(Math.min(starRadiusKm / Math.max(dist, starRadiusKm), 1));
  toSun.copy(me.pos).multiplyScalar(-1 / Math.max(dist, 1e-9));

  // Occluders: bodies between this one and the star, near enough to the star's direction for their shadow to reach it.
  out.occCount = 0;
  let worst0 = Infinity, worst1 = Infinity;
  let pick0: Placed | null = null, pick1: Placed | null = null;
  // Shine: the neighbour that lights the night side most.
  let bestShine = 0;
  out.shine.setRGB(0, 0, 0);
  for (const o of all) {
    if (o === me) continue;
    toOther.subVectors(o.pos, me.pos);
    const d = toOther.length();
    if (d <= 1e-6) continue;
    const along = toOther.dot(toSun) / d;
    if (along > 0) {
      const sep = Math.acos(THREE.MathUtils.clamp(along, -1, 1));
      const reach = out.sunRadius + Math.asin(Math.min(o.body.radius / d, 1)) + Math.asin(Math.min(b.radius / d, 1));
      const score = sep - reach;
      if (score < 0 && d < dist) {
        if (score < worst0) { pick1 = pick0; worst1 = worst0; pick0 = o; worst0 = score; }
        else if (score < worst1) { pick1 = o; worst1 = score; }
      }
    }
    // Planetshine: albedo x lit share of the disc seen from here (Lambert sphere phase) x solid angle.
    const od = o.pos.length();
    toBody.copy(toOther).multiplyScalar(-1 / d);
    const phase = Math.acos(THREE.MathUtils.clamp(-o.pos.dot(toBody) / Math.max(od, 1e-9), -1, 1));
    const lambert = (Math.sin(phase) + (Math.PI - phase) * Math.cos(phase)) / Math.PI;
    const size = o.body.radius / d;
    const shine = albedoOf(o.body) * lambert * size * size * starGain(starLum, od);
    if (shine > bestShine) {
      bestShine = shine;
      out.shineDir.copy(toOther).multiplyScalar(1 / d);
      // Its light takes the colour it shows from afar: its air and clouds where it has them (Earth is
      // blue-white), its ground otherwise.
      const a = o.body.atmosphere;
      const c = a ? a.color : o.body.palette[1];
      const m = Math.max(c[0], c[1], c[2], 1e-3);
      const pale = a ? 0.75 : 0.5;
      out.shine.setRGB(pale + (1 - pale) * c[0] / m, pale + (1 - pale) * c[1] / m, pale + (1 - pale) * c[2] / m).multiply(starColor).multiplyScalar(perceived(shine));
    }
  }
  if (!lightSwitches.shine) out.shine.setRGB(0, 0, 0);
  for (const pick of lightSwitches.eclipses ? [pick0, pick1] : []) {
    if (!pick) continue;
    const slot = out.occ[out.occCount++];
    slot.pos.subVectors(pick.pos, cam);
    slot.radius = pick.body.radius;
    const a = pick.body.atmosphere;
    if (a) {
      // Sunlight that grazes the limb some way up (the lowest air lets nothing through) is bent into the
      // umbra, having lost its blue on the way in and out: the copper Moon of a lunar eclipse, about
      // 1/10 000 of full sunlight (Danjon 2-3), shown through the same adaptation as planetshine.
      atmoTransmittance(1 + 0.22 * (pick.atmoTop - 1), 0, pick.atmoTop, a.color, a.density, through);
      const c = through.map((x) => x * x);
      const m = Math.max(c[0], c[1], c[2], 1e-12);
      const k = perceived(1e-4 * Math.min(a.density, 1.5));
      slot.air.set((c[0] / m) * k, (c[1] / m) * k, (c[2] / m) * k);
    } else {
      slot.air.set(0, 0, 0);
    }
  }

  // Ringshine: the sunlit face of the rings, brighter the higher the star stands over them.
  if (b.rings && lightSwitches.shine) out.ringShine.copy(out.sun).multiplyScalar(0.04);
  else out.ringShine.setRGB(0, 0, 0);
}

/**
 * Rings are clouds of icy particles and dust. Seen from the lit face they reflect, a little more
 * towards the star (particles backscatter). Seen from the dark face, light comes through where the
 * ring is thin, and the dust in it scatters strongly forwards: backlit, a ring glows, its sparse
 * parts most, while the dense parts stay dark. p: ring frame, planet radii; d: opacity 0..1.
 */
export const RING_SCATTER = /* glsl */ `
float ringScatter(vec3 p, float d, vec3 L, vec3 camObj, float litGain) {
  vec3 V = normalize(camObj - p);
  float cosV = dot(V, L);
  if (L.y * camObj.y > 0.0) return litGain * (0.85 + 0.15 * cosV);
  // Henyey-Greenstein, g = 0.7, times 4 pi: 1 for isotropic scattering, about 19 straight ahead.
  float g = 0.7;
  float hg = (1.0 - g * g) / pow(1.0 + g * g + 2.0 * g * cosV, 1.5);
  float through = 0.7 * (1.0 - d) + 0.04;
  return through + hg * 0.18 * (4.0 * d * (1.0 - d) + 0.35 * (1.0 - d));
}
`;

/** discCover on the CPU: share of a disc of angular radius rs hidden by one of radius ro, d apart (radians). */
export function discCover(rs: number, ro: number, d: number): number {
  if (d >= rs + ro) return 0;
  if (d <= Math.abs(rs - ro)) return ro >= rs ? 1 : (ro * ro) / (rs * rs);
  const c = (x: number) => Math.acos(THREE.MathUtils.clamp(x, -1, 1));
  const a = rs * rs * c((d * d + rs * rs - ro * ro) / (2 * d * rs));
  const b = ro * ro * c((d * d + ro * ro - rs * rs) / (2 * d * ro));
  const k = 0.5 * Math.sqrt(Math.max((-d + rs + ro) * (d + rs - ro) * (d - rs + ro) * (d + rs + ro), 0));
  return THREE.MathUtils.clamp((a + b - k) / (Math.PI * rs * rs), 0, 1);
}
