import type { Rng } from '../core/rng';
import type { PlanetType, Rgb } from './bodies';

/** HSL (h in turns) to linear RGB. */
export function hsl(h: number, s: number, l: number): Rgb {
  h = ((h % 1) + 1) % 1;
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.pow(Math.max(v, 0), 2.2);
  };
  return [f(0), f(8), f(4)];
}

type Palette = [Rgb, Rgb, Rgb, Rgb];

/** Surface colours; the meaning of each slot is defined by the planet shader. */
export function makePalette(type: PlanetType, rng: Rng): Palette {
  const j = (v: number, amt: number) => v + rng.range(-amt, amt);
  switch (type) {
    case 'terran':
    case 'ocean': {
      const alien = rng.chance(0.25);
      const veg = alien ? rng.pick([0.02, 0.78, 0.9, 0.52]) : j(0.3, 0.06);
      return [
        hsl(j(0.6, 0.05), 0.75, 0.16),
        hsl(veg, j(0.5, 0.1), j(0.24, 0.05)),
        hsl(j(0.1, 0.03), 0.4, j(0.45, 0.08)),
        hsl(j(0.07, 0.03), 0.15, j(0.36, 0.06)),
      ];
    }
    case 'desert': {
      const h = rng.pick([0.04, 0.07, 0.1, 0.02]);
      return [
        hsl(j(h, 0.02), 0.45, 0.2),
        hsl(j(h, 0.02), 0.6, 0.42),
        hsl(j(h + 0.03, 0.02), 0.55, 0.6),
        hsl(j(h - 0.02, 0.02), 0.3, 0.26),
      ];
    }
    case 'barren': {
      const h = rng.range(0.04, 0.12);
      const s = rng.range(0.02, 0.14);
      return [hsl(h, s, 0.16), hsl(h, s, 0.36), hsl(h, s * 0.7, 0.56), hsl(h, s * 0.4, 0.74)];
    }
    case 'ice': {
      const h = j(0.56, 0.05);
      return [hsl(h, 0.55, 0.32), hsl(h, 0.28, 0.68), hsl(h, 0.1, 0.9), hsl(j(0.08, 0.03), 0.3, 0.42)];
    }
    case 'lava':
      return [hsl(j(0.05, 0.02), 1, 0.52), hsl(0.03, 0.2, 0.07), hsl(0.05, 0.15, 0.17), hsl(j(0.11, 0.02), 1, 0.6)];
    case 'gas': {
      const h = rng.pick([0.07, 0.09, 0.11, 0.04, 0.58, 0.95, 0.14]);
      return [
        hsl(j(h, 0.02), j(0.45, 0.1), 0.72),
        hsl(j(h - 0.02, 0.02), j(0.55, 0.1), 0.48),
        hsl(j(h + 0.03, 0.03), j(0.3, 0.1), 0.84),
        hsl(j(h - 0.04, 0.03), j(0.6, 0.1), 0.3),
      ];
    }
    case 'icegiant': {
      const h = rng.range(0.48, 0.64);
      return [hsl(h, 0.5, 0.62), hsl(h + 0.02, 0.6, 0.5), hsl(h - 0.02, 0.35, 0.76), hsl(h + 0.04, 0.65, 0.38)];
    }
  }
}
