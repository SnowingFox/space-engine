// Kerr black holes, the parts the renderer approximates (units: M = GM/c^2 = r_s / 2, spin a in [0, 1)).
//   ISCO and photon-orbit radii of equatorial circular orbits: Bardeen, Press & Teukolsky (1972).
//   The shadow's edge seen from far away at inclination i: the celestial coordinates of the spherical photon
//   orbits, alpha = -xi / sin i, beta = +-sqrt(eta + a^2 cos^2 i - xi^2 cot^2 i) (Bardeen 1973; Chandrasekhar 1983).

/** Prograde innermost stable circular orbit, M. */
export function iscoRadius(a: number): number {
  const z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
  const z2 = Math.sqrt(3 * a * a + z1 * z1);
  return 3 + z2 - Math.sqrt((3 - z1) * (3 + z1 + 2 * z2));
}

/** Radiative efficiency of a thin disc ending at the ISCO, 1 - E_isco. */
export function discEfficiency(a: number): number {
  return 1 - Math.sqrt(1 - 2 / (3 * iscoRadius(a)));
}

/** Equatorial photon orbits, prograde and retrograde, M. */
export function photonOrbits(a: number): [number, number] {
  const r = (s: number): number => 2 * (1 + Math.cos((2 / 3) * Math.acos(s)));
  return [r(-a), r(a)];
}

/** Bins of the shadow table over cos(chi), chi the position angle on the sky from the prograde side's axis. */
export const SHADOW_BINS = 33;

/**
 * The shadow's edge for spin a seen at inclination i (radians, from the spin axis), as a table over
 * cos(chi) = alpha / |(alpha, beta)| from -1 (prograde side) to 1: x the edge's distance from the hole's
 * centre on the sky (impact parameter, r_s), y the radius of the photon orbit behind that part of the edge (M).
 * At a = 0 it is the circle 3 sqrt(3) M with orbits at 3 M everywhere.
 */
export function shadowTable(a: number, incl: number, out: Float32Array): void {
  const sinI = Math.max(Math.abs(Math.sin(incl)), 1e-3), cosI = Math.cos(incl);
  const [rPro, rRetro] = photonOrbits(a);
  if (a < 1e-3) {
    for (let k = 0; k < SHADOW_BINS; k++) { out[k * 2] = 1.5 * Math.sqrt(3); out[k * 2 + 1] = 3; }
    return;
  }
  const pts: { c: number; R: number; r: number }[] = [];
  const N = 600;
  for (let i = 0; i <= N; i++) {
    const r = rPro + ((rRetro - rPro) * i) / N;
    const xi = (r * r * (3 - r) - a * a * (r + 1)) / (a * (r - 1));
    const eta = (r ** 3 * (4 * a * a - r * (r - 3) ** 2)) / (a * a * (r - 1) ** 2);
    const b2 = eta + a * a * cosI * cosI - (xi * xi * cosI * cosI) / (sinI * sinI);
    if (b2 < 0) continue;
    const alpha = -xi / sinI, beta = Math.sqrt(b2);
    const R = Math.hypot(alpha, beta);
    pts.push({ c: alpha / R, R, r });
  }
  if (pts.length < 2) {
    // Seen nearly pole-on the edge is a circle (of radius sqrt(eta + a^2) for the orbit with xi = 0).
    for (let k = 0; k < SHADOW_BINS; k++) { out[k * 2] = 1.5 * Math.sqrt(3); out[k * 2 + 1] = 3; }
    return;
  }
  pts.sort((p, q) => p.c - q.c);
  for (let k = 0; k < SHADOW_BINS; k++) {
    const c = -1 + (2 * k) / (SHADOW_BINS - 1);
    let j = 0;
    while (j < pts.length - 2 && pts[j + 1].c < c) j++;
    const p = pts[j], q = pts[j + 1];
    const t = Math.min(Math.max((c - p.c) / (q.c - p.c || 1), 0), 1);
    out[k * 2] = (p.R + (q.R - p.R) * t) / 2;
    out[k * 2 + 1] = p.r + (q.r - p.r) * t;
  }
}
