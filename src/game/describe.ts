import { EARTH_RADIUS_KM, KM_PER_AU, SUN_RADIUS_KM } from '../core/units';
import { GM_EARTH, GM_SUN, type BodyData, type PlanetType, type Rgb } from '../universe/bodies';
import { temperatureToRgb, type StarData } from '../universe/stars';
import { generateSystem } from '../universe/system';
import { MILKY_WAY, type GalaxyKind } from '../universe/universe';
import { KM_PER_LY } from '../core/units';
import { formatDistance, formatDuration, num } from './format';
import type { Target } from './target';

const G0 = 9.80665e-3; // km/s^2

const STAR_KIND: Record<StarData['kind'], string> = {
  main: 'main-sequence star', giant: 'giant', supergiant: 'supergiant', dwarf: 'white dwarf',
};

const BODY_CLASS: Record<PlanetType, string> = {
  terran: 'terra', ocean: 'aquaria', desert: 'desert', barren: 'selena',
  ice: 'ice world', lava: 'lava world', gas: 'gas giant', icegiant: 'ice giant',
};

function temperatureClass(k: number): string {
  if (k < 90) return 'Frigid';
  if (k < 170) return 'Cold';
  if (k < 250) return 'Cool';
  if (k < 330) return 'Temperate';
  if (k < 500) return 'Warm';
  if (k < 1000) return 'Hot';
  return 'Torrid';
}

/** One line in SpaceEngine's style: "Temperate terra with life", "G2 V main-sequence star". */
const GALAXY_KIND: Record<GalaxyKind, string> = {
  spiral: 'Spiral galaxy', 'barred spiral': 'Barred spiral galaxy', elliptical: 'Elliptical galaxy',
  lenticular: 'Lenticular galaxy', irregular: 'Irregular galaxy',
};

export function describe(t: Target): string {
  if (t.kind === 'galaxy') return GALAXY_KIND[t.galaxy.kind];
  if (t.kind === 'star') {
    const s = t.star;
    const m = /^([A-Z]+\d*)(.*)$/.exec(s.cls);
    const cls = m && m[2] ? `${m[1]} ${m[2]}` : s.cls;
    return `${cls} ${STAR_KIND[s.kind]}`;
  }
  const b = t.body;
  let text = `${temperatureClass(b.temp)} ${BODY_CLASS[b.type]}`;
  if (b.type === 'terran' && b.temp > 240 && b.temp < 340) text += ' with life';
  if (b.rings) text += ' with rings';
  return text;
}

/** Shorter label for lists: "Planet", "Moon", "Star". */
export function kindLabel(t: Target): string {
  if (t.kind === 'galaxy') return GALAXY_KIND[t.galaxy.kind];
  if (t.kind === 'star') return `${t.star.cls} star`;
  return t.body.parent ? `Moon of ${t.body.parent.name}` : `Planet of ${t.star.name}`;
}

function atmosphere(b: BodyData): string {
  if (!b.atmosphere) return 'None';
  const d = b.atmosphere.density;
  if (b.type === 'gas' || b.type === 'icegiant') return 'Hydrogen, helium';
  const word = d > 1.5 ? 'Dense' : d > 0.6 ? 'Moderate' : d > 0.25 ? 'Thin' : 'Tenuous';
  return `${word} (${num(d)} x Earth)`;
}

/** Label / value pairs for the info panel. Distance is live and added by the HUD. */
export function properties(t: Target): [string, string][] {
  if (t.kind === 'galaxy') {
    const g = t.galaxy;
    const fromHome = Math.hypot(g.x - MILKY_WAY.x, g.y - MILKY_WAY.y, g.z - MILKY_WAY.z) * KM_PER_LY;
    const rows: [string, string][] = [
      ['Diameter', formatDistance(2 * g.radius * KM_PER_LY)],
      ['Type', GALAXY_KIND[g.kind]],
    ];
    if (g.kind === 'spiral' || g.kind === 'barred spiral') rows.push(['Spiral arms', `${g.arms}`]);
    if (g.id !== MILKY_WAY.id) rows.push(['From the Milky Way', formatDistance(fromHome)]);
    return rows;
  }
  if (t.kind === 'star') {
    const s = t.star;
    const r = s.radius * SUN_RADIUS_KM;
    const g = (GM_SUN * s.mass) / (r * r);
    return [
      ['Diameter', `${formatDistance(2 * r)} (${num(s.radius)} D☉)`],
      ['Mass', `${num(s.mass)} M☉`],
      ['Luminosity', `${num(s.lum)} L☉`],
      ['Temperature', `${Math.round(s.temp).toLocaleString('en-US')} K`],
      ['Surface gravity', `${num(g / G0)} g`],
      ['Spectral class', s.cls],
      ['Planets', `${generateSystem(s).planets.length}`],
    ];
  }
  const b = t.body;
  const gm = GM_EARTH * b.mass;
  const g = gm / (b.radius * b.radius);
  const rows: [string, string][] = [
    ['Diameter', `${formatDistance(2 * b.radius)} (${num(b.radius / EARTH_RADIUS_KM)} D⊕)`],
    ['Mass', `${num(b.mass)} M⊕`],
    ['Surface gravity', `${num(g * 1000)} m/s² (${num(g / G0)} g)`],
    ['Escape velocity', `${num(Math.sqrt((2 * gm) / b.radius))} km/s`],
    ['Temperature', `${Math.round(b.temp)} K (${Math.round(b.temp - 273.15)} °C)`],
    ['Atmosphere', atmosphere(b)],
    ['Semi-major axis', b.parent ? formatDistance(b.orbitRadius) : `${num(b.orbitRadius / KM_PER_AU)} AU`],
    ['Orbital period', formatDuration(b.orbitPeriod)],
    ['Rotation period', Math.abs(b.rotationPeriod - b.orbitPeriod) < 1 ? 'Synchronous' : formatDuration(b.rotationPeriod)],
    ['Axial tilt', `${num((b.axialTilt * 180) / Math.PI)}°`],
    ['Parent body', b.parent ? b.parent.name : t.star.name],
  ];
  if (!b.parent) rows.push(['Moons', `${b.moons.length}`]);
  return rows;
}

const srgb = (c: Rgb, gain = 1) =>
  `rgb(${c.map((v) => Math.round(255 * Math.pow(Math.min(Math.max(v * gain, 0), 1), 1 / 2.2))).join(',')})`;

/** A small shaded-sphere swatch for lists and the system browser. */
export function swatch(t: Target): string {
  if (t.kind === 'galaxy') {
    return 'radial-gradient(circle at 50% 50%, #fff6e0 0%, #d8b98a 18%, rgba(140,150,190,0.55) 50%, rgba(40,50,80,0) 72%)';
  }
  if (t.kind === 'star') {
    const c = temperatureToRgb(t.star.temp);
    return `radial-gradient(circle at 50% 50%, #fff 0%, ${srgb(c)} 55%, ${srgb(c, 0.55)} 100%)`;
  }
  const b = t.body;
  // Palette slots differ per type; pick the two that dominate the look from orbit.
  const [lit, mid] = b.type === 'terran' || b.type === 'ocean' ? [b.palette[0], b.palette[1]]
    : b.type === 'lava' ? [b.palette[0], b.palette[2]]
    : b.type === 'ice' ? [b.palette[2], b.palette[1]]
    : [b.palette[2], b.palette[1]];
  const boost = b.type === 'terran' || b.type === 'ocean' ? 3 : 1.25;
  return `radial-gradient(circle at 34% 30%, ${srgb(lit, boost * 1.25)} 0%, ${srgb(mid, boost)} 48%, ${srgb(mid, boost * 0.12)} 100%)`;
}
