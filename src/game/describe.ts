import { EARTH_RADIUS_KM, KM_PER_AU, SUN_RADIUS_KM } from '../core/units';
import { ECL_TO_APP } from '../universe/ephemeris';
import { GM_EARTH, GM_SUN, orbitPosition, phaseName, simClock, type BodyData, type PlanetType, type Rgb } from '../universe/bodies';
import { temperatureToRgb, type StarData } from '../universe/stars';
import { generateSystem } from '../universe/system';
import type { BlackHoleData } from '../universe/blackHoles';
import { iscoRadius } from '../universe/kerr';
import type { NebulaData } from '../universe/nebulae';
import { MILKY_WAY, SOL, type GalaxyKind } from '../universe/universe';
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
  if (t.kind === 'galaxy') return t.galaxy.type ?? GALAXY_KIND[t.galaxy.kind];
  if (t.kind === 'blackhole') return blackHoleKind(t.bh);
  if (t.kind === 'nebula') return t.nebula.type;
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
  if (t.kind === 'galaxy') return t.galaxy.type ?? GALAXY_KIND[t.galaxy.kind];
  if (t.kind === 'blackhole') return blackHoleKind(t.bh);
  if (t.kind === 'nebula') return NEBULA_KIND[t.nebula.kind];
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

function blackHoleKind(bh: BlackHoleData): string {
  if (bh.kind === 'stellar') return bh.companion ? 'Stellar-mass black hole in a binary' : 'Stellar-mass black hole';
  return bh.disc && bh.disc.mdot > 0.01 ? 'Supermassive black hole (quasar)' : 'Supermassive black hole';
}

function blackHoleProperties(bh: BlackHoleData): [string, string][] {
  const mass = bh.mass >= 1e6 ? `${num(bh.mass / 1e6)} million M☉` : `${num(bh.mass)} M☉`;
  const rows: [string, string][] = [
    ['Mass', bh.mass >= 1e9 ? `${num(bh.mass / 1e9)} billion M☉` : mass],
    ['Schwarzschild radius', formatDistance(bh.rs)],
    ['Photon sphere', formatDistance(bh.rs * 1.5)],
    ['Spin (a*)', bh.spin === null ? 'Unmeasured' : num(bh.spin)],
    ['Innermost stable orbit', `${formatDistance((iscoRadius(bh.spin ?? 0) / 2) * bh.rs)} (${num(iscoRadius(bh.spin ?? 0) / 2)} r_s)`],
    ['Accretion', bh.state],
  ];
  if (bh.disc) {
    rows.push(['Disc', `${num(bh.disc.rIn)}–${num(bh.disc.rOut)} r_s, peak ${Math.round(bh.disc.tMax).toLocaleString('en-US')} K`]);
    rows.push(['Accretion rate', `${num(bh.disc.mdot)} × Eddington`]);
  }
  if (bh.jet) rows.push(['Jet', `${formatDistance(bh.jet.length * bh.rs)}, Lorentz factor ${num(bh.jet.gamma)}`]);
  if (bh.companion) rows.push(['Companion', `${bh.companion.name} (${bh.companion.cls}, ${num(bh.companion.mass)} M☉)`]);
  if (bh.orbit) rows.push(['Orbital period', formatDuration(bh.orbit.period)], ['Separation', formatDistance(bh.orbit.a)]);
  if (bh.galaxy && bh.kind === 'supermassive') rows.push(['Host galaxy', bh.galaxy.name]);
  rows.push(['From Sol', formatDistance(Math.hypot(bh.x - SOL.x, bh.y - SOL.y, bh.z - SOL.z) * KM_PER_LY)]);
  return rows;
}

const NEBULA_KIND: Record<NebulaData['kind'], string> = {
  emission: 'Emission nebula', planetary: 'Planetary nebula', remnant: 'Supernova remnant', reflection: 'Reflection nebula', dark: 'Dark nebula',
};

function nebulaProperties(n: NebulaData): [string, string][] {
  const rows: [string, string][] = [
    ['Type', n.type],
    ['Diameter', formatDistance(2 * n.radius * KM_PER_LY)],
    ['From Sol', formatDistance(n.dist * KM_PER_LY)],
    ['Galactic l, b', `${num(n.l)}°, ${num(n.b)}°`],
  ];
  // The star whose light it shines by (the first listed is the main one).
  const main = n.stars[0];
  if (main) rows.push([n.kind === 'planetary' || n.kind === 'remnant' ? 'Central star' : 'Lit by', `${main.name} (${main.cls})`]);
  if (n.aliases.length) rows.push(['Also', n.aliases.slice(0, 3).join(', ')]);
  rows.push(['About', n.note]);
  return rows;
}

/** Label / value pairs for the info panel. Distance is live and added by the HUD. */
export function properties(t: Target): [string, string][] {
  if (t.kind === 'blackhole') return blackHoleProperties(t.bh);
  if (t.kind === 'nebula') return nebulaProperties(t.nebula);
  if (t.kind === 'galaxy') {
    const g = t.galaxy;
    const fromHome = Math.hypot(g.x - MILKY_WAY.x, g.y - MILKY_WAY.y, g.z - MILKY_WAY.z) * KM_PER_LY;
    const rows: [string, string][] = [
      ['Diameter', formatDistance(2 * g.radius * KM_PER_LY)],
      ['Type', g.type ?? GALAXY_KIND[g.kind]],
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
    ...orbitRows(b, t.star.name),
    ['Rotation period', Math.abs(Math.abs(b.rotationPeriod) - b.orbitPeriod) < 0.01 * b.orbitPeriod ? 'Synchronous'
      : `${formatDuration(Math.abs(b.rotationPeriod))}${b.rotationPeriod < 0 ? ' (retrograde)' : ''}`],
    ['Axial tilt', `${num((b.axialTilt * 180) / Math.PI)}°`],
    ['Parent body', b.parent ? b.parent.name : t.star.name],
  ];
  if (!b.parent) rows.push(['Moons', `${b.moons.length}`]);
  return rows;
}

const here = { x: 0, y: 0, z: 0 };

/** The orbit's shape and plane, and where the body is on it now. */
function orbitRows(b: BodyData, starName: string): [string, string][] {
  const rows: [string, string][] = [];
  const o = b.orbit;
  if (o) {
    rows.push(['Eccentricity', o.e.toFixed(4)]);
    const plane = o.frame === ECL_TO_APP ? 'the ecliptic' : b.parent ? `${b.parent.name}'s equator` : 'the system plane';
    rows.push(['Inclination', `${((Math.abs(o.i) * 180) / Math.PI).toFixed(2)}° to ${plane}`]);
  }
  orbitPosition(b, simClock.t, here);
  const d = Math.hypot(here.x, here.y, here.z);
  rows.push([`Distance from ${b.parent ? b.parent.name : starName === 'Sol' ? 'the Sun' : starName}`,
    b.parent ? formatDistance(d) : `${num(d / KM_PER_AU)} AU`]);
  if (b.parent) rows.push([`Phase from ${b.parent.name}`, phaseName(b, simClock.t)]);
  return rows;
}

const srgb = (c: Rgb, gain = 1) =>
  `rgb(${c.map((v) => Math.round(255 * Math.pow(Math.min(Math.max(v * gain, 0), 1), 1 / 2.2))).join(',')})`;

/** A small shaded-sphere swatch for lists and the system browser. */
export function swatch(t: Target): string {
  if (t.kind === 'blackhole') {
    return t.bh.disc
      ? 'radial-gradient(circle at 50% 50%, #000 0%, #000 30%, #ffd9a0 38%, #e07a30 50%, rgba(120,40,10,0.5) 64%, rgba(0,0,0,0) 74%)'
      : 'radial-gradient(circle at 50% 50%, #000 0%, #000 34%, rgba(200,210,255,0.55) 40%, rgba(0,0,0,0) 58%)';
  }
  if (t.kind === 'nebula') {
    const c = t.nebula.kind === 'planetary' ? '#4fd8c0' : t.nebula.kind === 'reflection' ? '#7ea6ff' : t.nebula.kind === 'remnant' ? '#e8a080' : '#e0507a';
    return `radial-gradient(circle at 46% 52%, #ffe8f0 0%, ${c} 22%, rgba(120,30,60,0.45) 52%, rgba(40,10,30,0) 74%)`;
  }
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
