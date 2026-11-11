// Scenic spots: a hand-curated list of camera poses worth visiting (F6 in the app).
//
// To add one: find a view in /bench.html, copy its URL numbers into a 'body' pose below
// (body → planet, moon, alt, sun, az, turn, pitch, fov, t, seed → star), then run
//   node scripts/scenic-shots.mjs <id>
// to write its thumbnail to public/scenic/<id>.jpg. `se.scenic(id)` jumps to a spot from
// the console, and `se.scenic({ kind: 'body', ... })` tries a pose before it is listed here.

/**
 * A pose over one body, with the same parametrisation as src/bench.ts. It is relative to
 * the body and the sun direction at sim time `t`, so it reproduces exactly on every visit.
 */
export interface BodyPose {
  kind: 'body';
  /** 'sol', or the id of a generated star (bench.html?seed=<id>). */
  star: 'sol' | number;
  /**
   * Galactic position (light years) of that generated star, so the spot sits at the real
   * star in the galaxy. Without it a stand-in system is placed a few light years from Sol.
   */
  starAt?: [number, number, number];
  /** Index into the system's planets (bench 'body'). */
  planet: number;
  /** Index into that planet's moons, to stand over a moon instead. */
  moon?: number;
  /** km above the ground; beyond 5% of the body's radius, km above the datum sphere. */
  alt: number;
  /** Angle between the zenith and the sun, radians: 0 = noon, ~1.5 = sun on the horizon. */
  sun: number;
  /** Swings the spot around the sun axis, radians. */
  az: number;
  /** Heading, radians, turning about the zenith. 0 looks away from the sun, pi towards it. */
  turn: number;
  /** Radians above (+) or below (-) the horizon. */
  pitch: number;
  /** Vertical field of view, degrees. Default 60. */
  fov?: number;
  /**
   * Seconds after SCENIC_EPOCH (bench 't'). Default 0. Sol's bodies move as they really do, so
   * this picks the date: the season, the time of day under the spot, where the moons stand.
   */
  t?: number;
}

/** A pose in open space, for views of the galaxy as a whole. */
export interface SpacePose {
  kind: 'space';
  /** Galactic position, light years. The disc lies in the XZ plane around the origin. */
  pos: [number, number, number];
  /** Direction to look in (need not be normalised). */
  look: [number, number, number];
  /** Which way is up on screen. Default: galactic north (+Y). */
  up?: [number, number, number];
  /** Vertical field of view, degrees. Default 60. */
  fov?: number;
}

export type ScenicPose = BodyPose | SpacePose;

export interface ScenicSpot {
  /** Also the thumbnail file name. */
  id: string;
  title: string;
  /** Chinese title, shown next to the English one. */
  titleZh: string;
  /** Where it is: body and system. */
  subtitle: string;
  /** One line. */
  description: string;
  /** Thumbnail, served from public/. */
  image: string;
  pose: ScenicPose;
}

const img = (id: string) => `/scenic/${id}.jpg`;

/** The moment a pose's t counts from (and bench.html's): 2026-11-11 00:00 UTC. */
export const SCENIC_EPOCH_MS = Date.UTC(2026, 10, 11);

/** Two generated systems in Sol's neighbourhood that the seeds below visit (star id and where it lives). */
const KOI_531579 = { star: 2472731579, starAt: [25989.217245323583, 0.7354063019156456, 861.1170824579895] as [number, number, number] };
const HD_482855 = { star: 2028082855, starAt: [26017.812783379108, 27.24189686961472, 895.938798529096] as [number, number, number] };

export const SCENIC_SPOTS: ScenicSpot[] = [
  {
    id: 'earth-orbit',
    title: 'Low Earth orbit',
    titleZh: '近地轨道',
    subtitle: 'Earth · Sol',
    description: 'The blue limb of home from 420 km up, where the space station flies.',
    image: img('earth-orbit'),
    pose: { kind: 'body', star: 'sol', planet: 2, alt: 420, sun: 0.95, az: 0.4, turn: 0.6, pitch: -0.28, fov: 60 },
  },
  {
    id: 'moon-earthrise',
    title: 'Earthrise',
    titleZh: '月面地出',
    subtitle: 'Moon · Earth',
    description: 'Earth hanging over the grey lunar horizon.',
    image: img('moon-earthrise'),
    // 2026-06-13 10:55 UTC, 40 h before new moon: a nearly full Earth 9 degrees up, opposite the low sun.
    pose: { kind: 'body', star: 'sol', planet: 2, moon: 0, alt: 1.5, sun: 1.3, az: 3.434, turn: 0.0075, pitch: 0.07, fov: 20, t: -13007100 },
  },
  {
    id: 'saturn-rings',
    title: 'Above the rings',
    titleZh: '土星环上',
    subtitle: 'Saturn · Sol',
    description: 'Three degrees over the ring plane, the rings sweeping across the sky.',
    image: img('saturn-rings'),
    // 3 degrees south of the ring plane, on the face the Sun lights in late 2026 (8 degrees south), rings level.
    pose: { kind: 'body', star: 'sol', planet: 5, alt: 110000, sun: 0.9, az: 5.545, turn: 1.42, pitch: -1.45, fov: 70 },
  },
  {
    id: 'mars-sunset',
    title: 'Martian sunset',
    titleZh: '火星日落',
    subtitle: 'Mars · Sol',
    description: 'A small sun sinking into the dust over the red plains.',
    image: img('mars-sunset'),
    pose: { kind: 'body', star: 'sol', planet: 3, alt: 0.6, sun: 1.46, az: 0.4, turn: 3.14, pitch: 0.02, fov: 60 },
  },
  {
    id: 'jupiter-io',
    title: 'Jupiter over Io',
    titleZh: '木卫一与木星',
    subtitle: 'Io · Jupiter',
    description: 'The banded giant looming behind its volcanic moon.',
    image: img('jupiter-io'),
    // 15 h after the epoch, Io stands where Jupiter shows ~90% lit; the spot puts it 23 degrees up.
    pose: { kind: 'body', star: 'sol', planet: 4, moon: 0, alt: 800, sun: 0.7, az: 4.566, turn: 0.663, pitch: -0.56, fov: 50, t: 54000 },
  },
  {
    id: 'titan-haze',
    title: 'Titan\'s haze',
    titleZh: '土卫六',
    subtitle: 'Titan · Saturn',
    description: 'Dunes under a thick orange sky, the only moon with real weather.',
    image: img('titan-haze'),
    pose: { kind: 'body', star: 'sol', planet: 5, moon: 1, alt: 1.2, sun: 1.1, az: 0.4, turn: 2.6, pitch: 0.0, fov: 60 },
  },
  {
    id: 'ringed-moonrise',
    title: 'Ringed giant',
    titleZh: '卫星上看环行星',
    subtitle: 'KOI 531579 Ia · 44 ly from Sol',
    description: 'Standing on a cratered moon while a ringed gas giant fills the sky.',
    image: img('ringed-moonrise'),
    // The moon orbits in the giant's equator, so its rings stand nearly edge-on in this sky.
    pose: { kind: 'body', ...KOI_531579, planet: 0, moon: 0, alt: 1, sun: 1.2, az: 4.45, turn: 0.766, pitch: 0.3, fov: 70 },
  },
  {
    id: 'terra-dusk',
    title: 'Alien dusk',
    titleZh: '异星黄昏',
    subtitle: 'HD 482855 III · 21 ly from Sol',
    description: 'Sunset over the ocean of a living world nobody has named.',
    image: img('terra-dusk'),
    pose: { kind: 'body', ...HD_482855, planet: 2, alt: 3, sun: 1.5, az: 0.4, turn: 3.14, pitch: 0.03, fov: 60 },
  },
  {
    id: 'milky-way-above',
    title: 'Milky Way from above',
    titleZh: '俯瞰银河',
    subtitle: 'Intergalactic space',
    description: 'The whole spiral at once, from 60,000 light years over the disc.',
    image: img('milky-way-above'),
    pose: { kind: 'space', pos: [26000, 60000, 34000], look: [-26000, -60000, -34000], fov: 60 },
  },
  {
    id: 'galactic-centre',
    title: 'The galactic centre',
    titleZh: '望向银心',
    subtitle: 'Milky Way · Orion Arm',
    description: 'The bright bulge and the band of the disc, seen from near home.',
    image: img('galactic-centre'),
    pose: { kind: 'space', pos: [25990, 60, 905], look: [-1, -0.02, -0.03], fov: 70 },
  },
];
