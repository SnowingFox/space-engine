import { Rng, hash32 } from '../core/rng';
import {
  GALAXIES, MILKY_WAY, NAMED_GALAXIES, catalogueAround, lightOf, randomAxes, setCosmos, shape,
  type GalaxyData, type GalaxyKind,
} from './universe';

// The universe beyond the catalogue, generated where the camera goes, the same on every visit.
//
// Space is cut into cells of CELL light years. Each cell's content follows from the universe's seed and the
// cell's coordinates alone: a few nodes of the cosmic web (groups, and now and then a rich cluster), filaments
// joining each node to its nearest neighbours (cut into pieces, each in the cell of its middle), and the
// galaxies of every node and piece. Voids are what is left: no structure, no galaxies.
//
// The galaxies of a structure are drawn brightest first from a Schechter luminosity function, each from a seed
// of its own: drawing down to a fainter limit adds galaxies and never changes those already drawn. So a cell far
// from the camera holds only its few brightest, too faint to see otherwise, and as the camera comes near it is
// drawn deeper, down to the dwarfs (the levels of detail: four times fainter each).

export const CELL = 40e6;
/** Cells from the centre to the edge of the generated universe, in each direction (the universe is 5 Gly across). */
const SPAN = 63;
const SEED = 20260411;

/** Schechter function: faint-end slope; galaxies are counted by their light in units of L*, the Milky Way's. */
const ALPHA = -1.25;
/** The faintest galaxies drawn (dwarfs, a few times fainter than the SMC). */
const X_FLOOR = 0.002;
/** A galaxy as bright as the Milky Way stays in view out to this far (its glow then fades below a pixel's grey level). */
export const D_STAR = 150e6;
/** Cells drawn around the camera, in each direction: out to where only the brightest galaxies would still show. */
const REACH = 10;

// Q(x) = integral from x to infinity of t^alpha e^-t dt, tabulated on a log grid; galaxies are counted relative to
// those brighter than 0.1 L* ("bright" below).
const QX: number[] = [], QV: number[] = [];
(() => {
  const n = 600, lo = Math.log(1e-4), hi = Math.log(40);
  let acc = 0;
  const f = (lt: number): number => Math.exp((ALPHA + 1) * lt - Math.exp(lt));
  for (let i = n; i >= 0; i--) {
    const lt = lo + ((hi - lo) * i) / n;
    if (i < n) acc += 0.5 * (f(lt) + f(lt + (hi - lo) / n)) * ((hi - lo) / n);
    QX.unshift(Math.exp(lt));
    QV.unshift(acc);
  }
})();
const qAt = (x: number): number => {
  if (x <= QX[0]) return QV[0];
  if (x >= QX[QX.length - 1]) return 0;
  let a = 0, b = QX.length - 1;
  while (b - a > 1) { const m = (a + b) >> 1; if (QX[m] > x) b = m; else a = m; }
  const t = (x - QX[a]) / (QX[b] - QX[a]);
  return QV[a] + (QV[b] - QV[a]) * t;
};
const Q_BRIGHT = qAt(0.1);
/** Luminosity (L*) above which, on average, `count` of a structure's galaxies lie, for `bright` of them above 0.1 L*. */
function luminosityAt(count: number, bright: number): number {
  const q = (count / bright) * Q_BRIGHT;
  if (q >= QV[0]) return 0;
  let a = 0, b = QV.length - 1;
  while (b - a > 1) { const m = (a + b) >> 1; if (QV[m] < q) b = m; else a = m; }
  const t = (q - QV[a]) / (QV[b] - QV[a]);
  return QX[a] + (QX[b] - QX[a]) * t;
}

/**
 * How faint (L*) the galaxies generated at a distance d go, as FAINT * (d / D_STAR)^2: deep enough that, with
 * the intergalactic dark adaptation (galaxyCloud.ts), each comes into being fainter than shows and fades in
 * (galaxyCloud's billboards fade them in over a factor of 1.6 above it).
 */
// (0.2: some 57,000 galaxies loaded around a typical camera, ~750 in view from 30 Mly out. 0.12 loads 85,000 and
// makes frames late while flying between them, scripts/gspikes.mjs; the fade-in over a factor 1.6 instead
// shows as many.)
export const FAINT = 0.2;
/** The most galaxies generated at once: past it the far cells are drawn shallower (Cosmos.bias). */
const MAX_LOADED = 140000;

/** The faintest galaxy (L*) worth drawing at a distance, with `bias` levels of four shallower: fainter ones would not show. */
export function faintestAt(d: number, bias = 0): number {
  return Math.max(X_FLOOR, FAINT * 4 ** bias * (d / D_STAR) ** 2);
}
// (Rounded down: a level draws at least every galaxy that would show.)
const levelOf = (x: number): number => Math.max(0, Math.floor(Math.log(x / X_FLOOR) / Math.log(4) + 1e-9));
const levelLimit = (level: number): number => X_FLOOR * 4 ** level;

interface Node { x: number; y: number; z: number; rich: number; key: number }
type Environment = 'cluster' | 'group' | 'filament';
interface Structure {
  sid: number;
  env: Environment;
  /** Galaxies above 0.1 L*, on average. */
  bright: number;
  /** A position for a galaxy of this structure (rank: 0 brightest). */
  place: (rng: Rng, rank: number, out: number[]) => void;
  /** For a node: its centre and size, for how central a galaxy is. */
  core?: [number, number, number, number];
}

const cellCode = (i: number, j: number, k: number): number => ((i + SPAN + 1) * 128 + (j + SPAN + 1)) * 128 + (k + SPAN + 1);
const inUniverse = (i: number, j: number, k: number): boolean => Math.abs(i) <= SPAN && Math.abs(j) <= SPAN && Math.abs(k) <= SPAN;
/** Galaxy ids: cell, structure and rank, above the catalogue's. */
const MAX_STRUCT = 32, MAX_RANK = 1024;
const ID_BASE = 1000;
const idOf = (code: number, sid: number, rank: number): number => ID_BASE + (code * MAX_STRUCT + sid) * MAX_RANK + rank;

const nodeCache = new Map<number, Node[]>();
/** The nodes of the web in a cell: groups mostly, a rich cluster now and then (richness: galaxies above 0.1 L*). */
function nodesOf(i: number, j: number, k: number): Node[] {
  const code = cellCode(i, j, k);
  let nodes = nodeCache.get(code);
  if (nodes) return nodes;
  nodes = [];
  if (inUniverse(i, j, k)) {
    const rng = new Rng(hash32(SEED, i, j, k));
    // Poisson, mean 2.5.
    let n = 0;
    for (let p = Math.exp(-2.5), u = rng.next(), c = p; u > c && n < 8; ) { n++; p *= 2.5 / n; c += p; }
    for (let m = 0; m < n; m++) {
      const rich = Math.min(1 / Math.max(rng.next(), 1e-6), 400);
      nodes.push({ x: (i + rng.next()) * CELL, y: (j + rng.next()) * CELL, z: (k + rng.next()) * CELL, rich, key: code * 16 + m });
    }
  }
  if (nodeCache.size > 60000) nodeCache.clear();
  nodeCache.set(code, nodes);
  return nodes;
}

const LINK = 40e6;
/** The two nodes nearest to a node within LINK (its neighbours on the web). */
function linksOf(a: Node, i: number, j: number, k: number): Node[] {
  const near: { n: Node; d: number }[] = [];
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) {
    for (const b of nodesOf(i + di, j + dj, k + dk)) {
      if (b === a) continue;
      const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      if (d < LINK) near.push({ n: b, d });
    }
  }
  near.sort((p, q) => p.d - q.d);
  return near.slice(0, 2).map((p) => p.n);
}
const cellOf = (v: number): number => Math.floor(v / CELL);

interface Filament { a: Node; b: Node }
const filamentCache = new Map<number, Filament[]>();
/** The filaments a cell's nodes own: each to its nearest neighbours, and those whose nearest it is, owned by the node with the smaller key. */
function filamentsOf(i: number, j: number, k: number): Filament[] {
  const code = cellCode(i, j, k);
  let list = filamentCache.get(code);
  if (list) return list;
  list = [];
  for (const a of nodesOf(i, j, k)) {
    const mine = linksOf(a, i, j, k);
    const cand = new Set<Node>(mine);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) {
      for (const b of nodesOf(i + di, j + dj, k + dk)) {
        if (b === a || cand.has(b) || Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) >= LINK) continue;
        if (linksOf(b, cellOf(b.x), cellOf(b.y), cellOf(b.z)).includes(a)) cand.add(b);
      }
    }
    for (const b of cand) if (a.key < b.key) list.push({ a, b });
  }
  if (filamentCache.size > 20000) filamentCache.clear();
  filamentCache.set(code, list);
  return list;
}

const PIECE = 10e6;
const structCache = new Map<number, Structure[]>();
/** The structures of a cell: its nodes, and the pieces of filaments whose middle lies in it. */
function structuresOf(i: number, j: number, k: number): Structure[] {
  const code = cellCode(i, j, k);
  let list = structCache.get(code);
  if (list) return list;
  list = [];
  for (const n of nodesOf(i, j, k)) {
    // Plummer spheres: a group some 0.2 Mly across, a rich cluster a few Mly.
    const a = 0.15e6 * Math.cbrt(n.rich);
    const env: Environment = n.rich >= 20 ? 'cluster' : 'group';
    list.push({
      sid: list.length, env, bright: n.rich, core: [n.x, n.y, n.z, a],
      place: (rng, rank, out) => {
        // (The brightest of a rich cluster sits at its centre.)
        let r = rank === 0 && n.rich >= 20 ? 0 : a / Math.sqrt(Math.max(rng.next(), 1e-6) ** (-2 / 3) - 1);
        r = Math.min(r, 6 * a);
        const u = rng.range(-1, 1), ph = rng.range(0, Math.PI * 2), s = Math.sqrt(1 - u * u);
        out[0] = n.x + r * s * Math.cos(ph); out[1] = n.y + r * u; out[2] = n.z + r * s * Math.sin(ph);
      },
    });
  }
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) {
    for (const f of filamentsOf(i + di, j + dj, k + dk)) {
      const dx = f.b.x - f.a.x, dy = f.b.y - f.a.y, dz = f.b.z - f.a.z;
      const len = Math.hypot(dx, dy, dz);
      const pieces = Math.max(1, Math.ceil(len / PIECE));
      // Galaxies per light year along it: more between rich nodes.
      const lambda = 0.02e-6 * Math.sqrt(f.a.rich * f.b.rich);
      for (let p = 0; p < pieces; p++) {
        const t0 = p / pieces, t1 = (p + 1) / pieces, tm = (t0 + t1) / 2;
        const mx = f.a.x + dx * tm, my = f.a.y + dy * tm, mz = f.a.z + dz * tm;
        if (cellOf(mx) !== i || cellOf(my) !== j || cellOf(mz) !== k) continue;
        if (list.length >= MAX_STRUCT) continue;
        const seed = hash32(f.a.key, f.b.key, p, SEED);
        // A few knots along each piece where its galaxies gather in small groups.
        const kr = new Rng(seed);
        const knots = Array.from({ length: 3 }, () => kr.range(t0, t1));
        list.push({
          sid: list.length, env: 'filament', bright: lambda * (len / pieces) * 1.3,
          place: (rng, _rank, out) => {
            const wide = rng.next() < 0.25;
            const t = rng.next() < 0.4 ? knots[Math.floor(rng.next() * 3)] + rng.gauss() * 0.01 : rng.range(t0, t1);
            const sig = wide ? 3e6 : rng.next() < 0.4 ? 0.25e6 : 0.9e6;
            out[0] = f.a.x + dx * t + rng.gauss() * sig; out[1] = f.a.y + dy * t + rng.gauss() * sig; out[2] = f.a.z + dz * t + rng.gauss() * sig;
          },
        });
      }
    }
  }
  // Around the Local Group (the catalogue's), the Local Sheet: a flattened spread of mostly small galaxies some
  // 50 Mly across, where the Milky Way sits. (Owned by the cell at the origin; the last of its structures, so that
  // those generated before it keep their numbers.)
  if (i === 0 && j === 0 && k === 0 && list.length < MAX_STRUCT) {
    const tilt = 0.3;
    list.push({
      sid: list.length, env: 'group', bright: 60,
      place: (rng, _rank, out) => {
        const r = 25e6 * Math.sqrt(rng.next()), ph = rng.range(0, Math.PI * 2), h = rng.gauss() * 2.5e6;
        const x = r * Math.cos(ph), z = r * Math.sin(ph);
        out[0] = x; out[1] = h * Math.cos(tilt) + z * Math.sin(tilt); out[2] = z * Math.cos(tilt) - h * Math.sin(tilt);
      },
    });
  }
  if (structCache.size > 20000) structCache.clear();
  structCache.set(code, list);
  return list;
}

const KIND_MIX: Record<string, [number, number, number, number]> = {
  // elliptical, lenticular, spiral, irregular
  core: [0.4, 0.3, 0.25, 0.05],
  cluster: [0.2, 0.25, 0.45, 0.1],
  group: [0.12, 0.18, 0.55, 0.15],
  filament: [0.06, 0.1, 0.62, 0.22],
};
const MW_LIGHT = lightOf(MILKY_WAY);

/** One galaxy of a structure, from its own seed. */
function makeGalaxy(code: number, st: Structure, rank: number, x: number): GalaxyData | null {
  const rng = new Rng(hash32(code, st.sid, rank, SEED + 7));
  const pos = [0, 0, 0];
  st.place(rng, rank, pos);
  // (Where the catalogue has galaxies, it is the catalogue's: the Local Group and the famous neighbours.)
  if (Math.hypot(pos[0], pos[1], pos[2]) < 3.5e6) return null;
  for (const c of catalogueAround(pos[0], pos[1], pos[2])) {
    if (Math.hypot(c.x - pos[0], c.y - pos[1], c.z - pos[2]) < c.radius * 6 + 3e5) return null;
  }
  let mix = KIND_MIX[st.env];
  if (st.core && st.env === 'cluster' && Math.hypot(pos[0] - st.core[0], pos[1] - st.core[1], pos[2] - st.core[2]) < 2 * st.core[3]) mix = KIND_MIX.core;
  const u = rng.next();
  let kind: GalaxyKind = u < mix[0] ? 'elliptical' : u < mix[0] + mix[1] ? 'lenticular' : u < mix[0] + mix[1] + mix[2] ? 'spiral' : 'irregular';
  // Dwarfs are irregulars or dwarf ellipticals; the brightest of a rich cluster a giant elliptical.
  if (x < 0.01) kind = rng.next() < 0.7 ? 'irregular' : 'elliptical';
  if (rank === 0 && st.env === 'cluster' && st.bright >= 20) kind = 'elliptical';
  if (kind === 'spiral' && rng.next() < 0.35) kind = 'barred spiral';
  const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
  const radius = kind === 'elliptical' ? clamp(60000 * x ** 0.55, 2500, 300000)
    : kind === 'lenticular' ? clamp(45000 * x ** 0.45, 6000, 150000)
      : kind === 'irregular' ? clamp(15000 * x ** 0.35, 1500, 30000)
        : clamp(50000 * x ** 0.4, 8000, 150000);
  const axes = randomAxes(rng);
  const g: GalaxyData = {
    id: idOf(code, st.sid, rank), name: '', kind, x: pos[0], y: pos[1], z: pos[2], axes, radius, ...shape(kind, radius, rng),
  };
  // As bright as its luminosity says, the share of disc and bulge as its kind has them.
  const scale = (x * MW_LIGHT) / Math.max(lightOf(g), 1e-30);
  g.discLum *= scale;
  g.bulgeLum *= scale;
  g.name = `PGC ${g.id}`;
  g.lum = x;
  // (Seeds above the catalogue's: the giant star-forming regions and off-centre bars the march gives a seed are its alone.)
  g.seed += 100;
  morphology(g, st, rng, x);
  return g;
}

/**
 * The finer kind of a generated galaxy, by its environment and its own seed (each draw after all the others, so
 * nothing else about it changes): ellipticals from round (E0) to flat (E7), some with shells; dwarf spheroidals;
 * grand-design and flocculent spirals, barred ones with inner rings; lenticulars, some with dust lanes; and now
 * and then a ring galaxy, a polar ring or a pair in collision (makeCompanion).
 */
function morphology(g: GalaxyData, st: Structure, rng: Rng, x: number): void {
  const u = rng.next(), v = rng.next();
  if (g.kind === 'elliptical') {
    if (x < 0.01) {
      // A dwarf spheroidal: faint and spread out, its light the same.
      g.radius *= 2.2;
      g.bulgeScale *= 2.2;
      g.bulgeLum /= 2.2 ** 3;
      g.type = 'Dwarf spheroidal galaxy';
      return;
    }
    g.bulgeFlat = 1 + 2.3 * u ** 1.6;
    const n = Math.min(7, Math.round(10 * (1 - 1 / g.bulgeFlat)));
    g.type = `E${n} elliptical galaxy`;
    if (st.env !== 'cluster' && v < 0.15) { g.shells = 0.5 + 0.5 * rng.next(); g.type = `E${n} shell galaxy`; }
  } else if (g.kind === 'spiral') {
    if (u < 0.25) { g.armContrast = 1; g.flocculent = 0.08; g.spurs = 0.7; g.type = 'Grand-design spiral galaxy'; }
    else if (u < 0.55) { g.armContrast = 0.45; g.flocculent = 0.9; g.type = 'Flocculent spiral galaxy'; }
    if (st.env !== 'filament' && v < 0.02) {
      // Collisional ring: a smaller galaxy fell through it.
      g.armContrast = 0; g.flocculent = 0; g.ring = [0.7 + 0.15 * rng.next(), 3, 6 + Math.floor(rng.next() * 8), 0.3];
      // (The ring's light spread out with the wave: a longer disc scale, its light kept.)
      const k = lightOf(g);
      g.discScale = 0.35 * g.radius;
      g.discLum *= k / lightOf(g);
      g.type = 'Ring galaxy (collisional)';
    }
  } else if (g.kind === 'barred spiral') {
    if (u < 0.4) { g.ring = [0.28 + 0.1 * v, 0.7, 0, 0.3]; g.type = 'Barred spiral galaxy with an inner ring'; }
  } else if (g.kind === 'lenticular') {
    if (u < 0.3) { g.dust = 0.8 + 0.8 * v; g.type = 'Lenticular galaxy with a dust lane'; }
    else if (u < 0.33) { g.ring = [0.55 + 0.2 * v, 1.4, -1, 0.8]; g.type = 'Polar-ring galaxy'; }
    else if (u < 0.34) {
      g.ring = [0.72, 2.4, 0, 0]; g.bulgeFlat = 1.05; g.blue = 1; g.type = 'Ring galaxy (Hoag-type)';
      const k = lightOf(g);
      g.discScale = 0.45 * g.radius;
      g.discLum *= k / lightOf(g);
    }
  }
}

/** In groups and clusters, a few spirals have a partner in collision: both throw out tidal tails. */
function makeCompanion(code: number, st: Structure, rank: number, g: GalaxyData): GalaxyData | null {
  if ((g.kind !== 'spiral' && g.kind !== 'barred spiral') || st.env === 'filament' || g.ring || rank >= MAX_RANK / 2) return null;
  const rng = new Rng(hash32(code, st.sid, rank, SEED + 11));
  if (rng.next() > 0.04) return null;
  const x = (g.lum ?? 0.1) * rng.range(0.3, 1);
  const dir = randomAxes(rng).slice(0, 3);
  const sep = g.radius * rng.range(0.9, 1.6);
  const cr = g.radius * Math.sqrt(x / Math.max(g.lum ?? 0.1, 1e-6));
  const c: GalaxyData = {
    id: idOf(code, st.sid, rank + MAX_RANK / 2), name: '', kind: 'spiral', x: g.x + dir[0] * sep, y: g.y + dir[1] * sep, z: g.z + dir[2] * sep,
    axes: randomAxes(rng), radius: cr, ...shape('spiral', cr, rng),
  };
  const k = (x * MW_LIGHT) / Math.max(lightOf(c), 1e-30);
  c.discLum *= k;
  c.bulgeLum *= k;
  c.name = `PGC ${c.id}`;
  c.lum = x;
  c.seed += 100;
  // (Their tails reach out to twice their discs: the radius the march gives them is doubled, the discs kept.)
  for (const h of [g, c]) { h.tails = 1 + rng.next(); h.radius *= 2; h.flocculent = 0.7; h.type = 'Interacting galaxy'; }
  return c;
}

/** A cell's galaxies down to `limit` (L*), brightest of each structure first. */
function galaxiesOf(i: number, j: number, k: number, limit: number): GalaxyData[] {
  const code = cellCode(i, j, k);
  const out: GalaxyData[] = [];
  for (const st of structuresOf(i, j, k)) {
    // Ranks: a Poisson process in the expected count above a luminosity, from its own seed.
    const rng = new Rng(hash32(code, st.sid, SEED + 3));
    let n = 0;
    // (Ranks up to half of MAX_RANK: the upper half numbers the companions, makeCompanion.)
    for (let rank = 0; rank < MAX_RANK / 2; rank++) {
      n -= Math.log(Math.max(rng.next(), 1e-12));
      const x = luminosityAt(n, st.bright);
      if (x < limit) break;
      const g = makeGalaxy(code, st, rank, x);
      if (g) {
        out.push(g);
        const c = makeCompanion(code, st, rank, g);
        if (c) out.push(c);
      }
    }
  }
  return out;
}

interface Loaded { level: number; galaxies: GalaxyData[] }

/** Generated galaxies near a point, by a grid of GRID ly: what is loaded, for picking, the HUD and the march. */
const GRID = 2e6;
const gkey = (x: number, y: number, z: number): string => `${Math.floor(x / GRID)},${Math.floor(y / GRID)},${Math.floor(z / GRID)}`;

export class Cosmos {
  private readonly loaded = new Map<number, Loaded>();
  private readonly byPos = new Map<string, GalaxyData[]>();
  private readonly byId = new Map<number, GalaxyData>();
  /** Galaxies come and go for the renderer: added and removed since it last asked. */
  private added: GalaxyData[] = [];
  private removed: GalaxyData[] = [];
  /** Cells around the camera, nearest first, and where the sweep through them is. */
  private readonly offsets: number[][] = [];
  private sweep = 0;
  private centre = [NaN, NaN, NaN];

  constructor() {
    for (let i = -REACH; i <= REACH; i++) for (let j = -REACH; j <= REACH; j++) for (let k = -REACH; k <= REACH; k++) {
      if (i * i + j * j + k * k <= (REACH + 0.5) ** 2) this.offsets.push([i, j, k]);
    }
    this.offsets.sort((a, b) => a[0] ** 2 + a[1] ** 2 + a[2] ** 2 - (b[0] ** 2 + b[1] ** 2 + b[2] ** 2));
  }

  /** Changes whenever galaxies come or go. */
  version = 0;

  /** Galaxies generated so far. */
  get count(): number {
    return this.byId.size;
  }

  private set(i: number, j: number, k: number, level: number): void {
    const code = cellCode(i, j, k);
    const old = this.loaded.get(code);
    if (old && old.level === level) return;
    const fresh = level < 0 ? [] : galaxiesOf(i, j, k, levelLimit(level));
    const keep = new Map((old?.galaxies ?? []).map((g) => [g.id, g]));
    const next: GalaxyData[] = [];
    for (const g of fresh) {
      const was = keep.get(g.id);
      if (was) { next.push(was); keep.delete(g.id); continue; }
      next.push(g);
      this.byId.set(g.id, g);
      const key = gkey(g.x, g.y, g.z);
      const cell = this.byPos.get(key);
      if (cell) cell.push(g); else this.byPos.set(key, [g]);
      this.added.push(g);
    }
    for (const g of keep.values()) {
      this.byId.delete(g.id);
      const key = gkey(g.x, g.y, g.z);
      const cell = this.byPos.get(key);
      if (cell) {
        const at = cell.indexOf(g);
        if (at >= 0) cell.splice(at, 1);
        if (cell.length === 0) this.byPos.delete(key);
      }
      this.removed.push(g);
    }
    if (level < 0) this.loaded.delete(code);
    else this.loaded.set(code, { level, galaxies: next });
    this.version++;
  }

  /**
   * Levels shallower than their distance calls for, beyond 30 Mly: raised while more than MAX_LOADED galaxies
   * are generated, lowered again once well under it. (Memory stays bounded however crowded the view.)
   */
  bias = 0;

  /** Brings the cells around the camera to the detail their distance calls for, within a time budget (ms). */
  update(cam: { x: number; y: number; z: number }, budgetMs = 1.0): void {
    const t0 = performance.now();
    if (this.byId.size > MAX_LOADED && this.bias < 3) { this.bias++; this.sweep = 0; }
    else if (this.byId.size < MAX_LOADED * 0.4 && this.bias > 0) { this.bias--; this.sweep = 0; }
    const ci = cellOf(cam.x), cj = cellOf(cam.y), ck = cellOf(cam.z);
    if (ci !== this.centre[0] || cj !== this.centre[1] || ck !== this.centre[2]) {
      this.centre = [ci, cj, ck];
      this.sweep = 0;
      // Cells left behind go.
      for (const [code, l] of this.loaded) {
        const k = (code % 128) - SPAN - 1, j = (Math.floor(code / 128) % 128) - SPAN - 1, i = Math.floor(code / 16384) - SPAN - 1;
        if (l && (i - ci) ** 2 + (j - cj) ** 2 + (k - ck) ** 2 > (REACH + 1.5) ** 2) this.set(i, j, k, -1);
      }
    }
    // A sweep through the cells, nearest first: each brought to its level (the near ones are swept every frame).
    let checked = 0;
    while (performance.now() - t0 < budgetMs && checked < this.offsets.length) {
      const [oi, oj, ok] = this.offsets[this.sweep];
      this.sweep = (this.sweep + 1) % this.offsets.length;
      checked++;
      const i = ci + oi, j = cj + oj, k = ck + ok;
      if (!inUniverse(i, j, k)) continue;
      // Nearest point of the cell (a margin for galaxies spilling out of it).
      const near = (c: number, v: number): number => Math.max(c * CELL - v, 0, v - (c + 1) * CELL);
      const d = Math.max(Math.hypot(near(i, cam.x), near(j, cam.y), near(k, cam.z)) - 6e6, 0);
      const want = levelOf(faintestAt(d, d > 30e6 ? this.bias : 0));
      const have = this.loaded.get(cellCode(i, j, k))?.level;
      // (Deeper at once; shallower only once well past it, so a camera on the boundary does not flicker.)
      if (have === undefined || want < have || want > have + 1) this.set(i, j, k, want);
    }
  }

  /** Makes sure every galaxy that can reach a point is generated, to the full depth; returns those near it. */
  around(x: number, y: number, z: number): GalaxyData[] {
    const ci = cellOf(x), cj = cellOf(y), ck = cellOf(z);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) {
      const i = ci + di, j = cj + dj, k = ck + dk;
      // (Only cells whose galaxies can lie within a few Mly of the point.)
      const near = (c: number, v: number): number => Math.max(c * CELL - v, 0, v - (c + 1) * CELL);
      if (!inUniverse(i, j, k) || Math.hypot(near(i, x), near(j, y), near(k, z)) > 12e6) continue;
      const l = this.loaded.get(cellCode(i, j, k));
      if (!l || l.level > 0) this.set(i, j, k, 0);
    }
    const out: GalaxyData[] = [];
    this.near(x, y, z, 0.6e6, (g) => {
      if (Math.hypot(g.x - x, g.y - y, g.z - z) < g.radius * 1.3 + 0.3e6) out.push(g);
    });
    return out;
  }

  /** Every generated galaxy within r of a point. */
  near(x: number, y: number, z: number, r: number, each: (g: GalaxyData) => void): void {
    const n = Math.ceil(r / GRID);
    const gi = Math.floor(x / GRID), gj = Math.floor(y / GRID), gk = Math.floor(z / GRID);
    for (let i = gi - n; i <= gi + n; i++) for (let j = gj - n; j <= gj + n; j++) for (let k = gk - n; k <= gk + n; k++) {
      const cell = this.byPos.get(`${i},${j},${k}`);
      if (!cell) continue;
      for (const g of cell) if (Math.hypot(g.x - x, g.y - y, g.z - z) <= r) each(g);
    }
  }

  /** Every generated galaxy. */
  forEach(each: (g: GalaxyData) => void): void {
    for (const g of this.byId.values()) each(g);
  }

  /** Galaxies added and removed since the last call (for the renderer). */
  drain(): { added: GalaxyData[]; removed: GalaxyData[] } {
    const out = { added: this.added, removed: this.removed };
    this.added = [];
    this.removed = [];
    return out;
  }

  /** A generated galaxy by its id (generated now if need be), or null. */
  byIdent(id: number): GalaxyData | null {
    const have = this.byId.get(id);
    if (have) return have;
    const v = id - ID_BASE;
    if (v < 0 || !Number.isInteger(v)) return null;
    const code = Math.floor(v / (MAX_STRUCT * MAX_RANK));
    const k = (code % 128) - SPAN - 1, j = (Math.floor(code / 128) % 128) - SPAN - 1, i = Math.floor(code / 16384) - SPAN - 1;
    if (!inUniverse(i, j, k) || cellCode(i, j, k) !== code) return null;
    this.set(i, j, k, 0);
    return this.byId.get(id) ?? null;
  }
}

export const COSMOS = new Cosmos();
setCosmos((x, y, z) => COSMOS.around(x, y, z), (x, y, z, r, each) => COSMOS.near(x, y, z, r, each));

/** A galaxy by name, catalogued or generated (a generated one by its PGC number even if not yet generated). */
export function findGalaxy(name: string): GalaxyData | null {
  const q = name.toLowerCase();
  const m = /^pgc\s*(\d+)$/.exec(q.trim());
  if (m) return COSMOS.byIdent(Number(m[1]));
  const cat = GALAXIES.find((g) => g.name.toLowerCase() === q) ?? GALAXIES.find((g) => g.name.toLowerCase().includes(q));
  if (cat) return cat;
  let hit: GalaxyData | null = null;
  COSMOS.forEach((g) => { if (!hit && g.name.toLowerCase().includes(q)) hit = g; });
  return hit;
}

/** Every galaxy known now: the catalogue and those generated so far. */
export function forEachGalaxy(each: (g: GalaxyData) => void): void {
  for (const g of GALAXIES) each(g);
  COSMOS.forEach(each);
}

/** Is a galaxy one of the generated ones? */
export const isGenerated = (g: GalaxyData): boolean => g.id >= NAMED_GALAXIES;

/** Whether a galaxy is bright enough to show from a distance (ly): the faint ones drawn near the limit are not picked. */
export function visibleAt(g: GalaxyData, d: number): boolean {
  return g.id < NAMED_GALAXIES || lightOf(g) / MW_LIGHT >= 1.6 * faintestAt(d);
}
