import * as THREE from 'three';

// Light paths around a Schwarzschild black hole, tabulated once at start so the lens shader never integrates.
// Units: the Schwarzschild radius r_s = 1, u = r_s / r. A photon with impact parameter b moves in a plane with
//   (du/dphi)^2 = 1/b^2 - u^2 + u^3                                            (e.g. Chandrasekhar 1983, §20;
// Misner, Thorne & Wheeler §25.6). Rays with b < b_c = 3 sqrt(3) / 2 that head inwards are captured (the shadow);
// the rest reach a periapsis u_p and leave again. Phi(u) is the azimuth swept from infinity to u.
//
// tOut, one row per b > b_c (w = ln(b / b_c - 1) from W_OUT[0] to W_OUT[1]):
//   R: Phi(s) - asin(s), s = u / u_p = 1 - sigma^2, sampled uniformly in sigma (smooth through the periapsis);
//      asin(s) is the flat-space value, so for far observers what is stored is the small correction only.
//   G: s(t), t = Phi / Phi_p, sampled uniformly in sqrt(t) (where along the path a ray is: for disc crossings;
//      dense at the start, where a ray that will wind round the photon sphere first falls towards it).
//   B: Phi_p - pi/2 (half the total deflection).  A: u_p.
// tIn, one row per b < b_c (w = ln(1 - b / b_c) from W_IN[0] to 0):
//   R: Phi(u), u in [0, 1/3] (where an observer can be).  G: u(t), t = Phi / Phi_h, uniform in sqrt(t).
//   B: Phi_h, swept down to the horizon.

export const B_CRIT = 1.5 * Math.sqrt(3);
export const W_OUT: [number, number] = [-16, 7];
export const W_IN: [number, number] = [-16, 0];
export const TABLE_COLS = 128;
export const TABLE_ROWS = 512;
const STEPS = 3000;

/** The three roots of u^3 - u^2 + 1/b^2 (b > b_c): periapsis u_p, the next u_2, and the negative u_3. */
function roots(b: number): [number, number, number] {
  const th = Math.acos(-B_CRIT / b);
  const r0 = (2 * b / Math.sqrt(3)) * Math.cos(th / 3);
  const r1 = (2 * b / Math.sqrt(3)) * Math.cos(th / 3 - (2 * Math.PI) / 3);
  const up = 1 / r0, u2 = 1 / r1;
  return [up, u2, 1 - up - u2];
}

/** Cumulative integral of f over a monotone grid x (trapezoid). */
function cumulative(x: Float64Array, f: Float64Array): Float64Array {
  const out = new Float64Array(x.length);
  for (let i = 1; i < x.length; i++) out[i] = out[i - 1] + 0.5 * (f[i] + f[i - 1]) * (x[i] - x[i - 1]);
  return out;
}

/** y at x by linear interpolation over a monotone increasing xs. */
function interp(xs: Float64Array, ys: Float64Array, x: number): number {
  let lo = 0, hi = xs.length - 1;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[hi]) return ys[hi];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid; else hi = mid;
  }
  const t = (x - xs[lo]) / (xs[hi] - xs[lo] || 1);
  return ys[lo] + (ys[hi] - ys[lo]) * t;
}

function outRow(b: number, row: Float32Array): void {
  const [up, u2, u3] = roots(b);
  // u = u_p (1 - sigma^2); near the critical b the integrand has a near-double root, smoothed by sigma = s0 sinh(tau).
  const s0 = Math.max(Math.sqrt(Math.max(u2 - up, 0) / up), 1e-7);
  const tauMax = Math.asinh(1 / s0);
  const sig = new Float64Array(STEPS + 1), f = new Float64Array(STEPS + 1);
  for (let i = 0; i <= STEPS; i++) {
    const tau = (tauMax * i) / STEPS;
    const s = Math.min(s0 * Math.sinh(tau), 1);
    sig[i] = s;
    const u = up * (1 - s * s);
    // f(u) = (u_p - u)(u_2 - u)(u - u_3) with u_p - u = u_p sigma^2 exactly, so dPhi/dsigma = 2 u_p sigma / sqrt(f) = 2 sqrt(u_p) / sqrt((u_2 - u)(u - u_3)).
    f[i] = (2 * Math.sqrt(up)) / Math.sqrt(Math.max((u2 - u) * (u - u3), 1e-300));
  }
  // Phi measured from the periapsis outwards in sigma; the swept azimuth from infinity is Phi_p minus that.
  const fromPeri = cumulative(sig, f);
  const phiP = fromPeri[STEPS];
  for (let j = 0; j < TABLE_COLS; j++) {
    const sigma = j / (TABLE_COLS - 1);
    const s = 1 - sigma * sigma;
    row[j * 4] = phiP - interp(sig, fromPeri, sigma) - Math.asin(s);
  }
  // s(t): Phi from infinity is increasing as sigma decreases.
  const n = STEPS + 1;
  const phi = new Float64Array(n), sv = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    phi[i] = phiP - fromPeri[n - 1 - i];
    const sg = sig[n - 1 - i];
    sv[i] = 1 - sg * sg;
  }
  for (let j = 0; j < TABLE_COLS; j++) row[j * 4 + 1] = interp(phi, sv, (j / (TABLE_COLS - 1)) ** 2 * phiP);
  for (let j = 0; j < TABLE_COLS; j++) {
    row[j * 4 + 2] = phiP - Math.PI / 2;
    row[j * 4 + 3] = up;
  }
}

function inRow(b: number, row: Float32Array): void {
  // f(u) = 1/b^2 - u^2 + u^3 > 0 on [0, 1], smallest at u = 2/3: there the grid is refined, u = 2/3 + sqrt(fmin) sinh(tau).
  const fmin = Math.max(1 / (b * b) - 4 / 27, 1e-14);
  const q = Math.sqrt(fmin);
  const t0 = Math.asinh(-(2 / 3) / q), t1 = Math.asinh((1 / 3) / q);
  const uu = new Float64Array(STEPS + 1), f = new Float64Array(STEPS + 1);
  for (let i = 0; i <= STEPS; i++) {
    const tau = t0 + ((t1 - t0) * i) / STEPS;
    const u = Math.min(Math.max(2 / 3 + q * Math.sinh(tau), 0), 1);
    uu[i] = u;
    f[i] = 1 / Math.sqrt(Math.max(1 / (b * b) - u * u + u * u * u, 1e-300));
  }
  uu[0] = 0;
  uu[STEPS] = 1;
  const phi = cumulative(uu, f);
  const phiH = phi[STEPS];
  for (let j = 0; j < TABLE_COLS; j++) {
    row[j * 4] = interp(uu, phi, (j / (TABLE_COLS - 1)) / 3);
    row[j * 4 + 1] = interp(phi, uu, (j / (TABLE_COLS - 1)) ** 2 * phiH);
    row[j * 4 + 2] = phiH;
    row[j * 4 + 3] = 0;
  }
}

/** b for a row of either table. */
export function rowImpact(inside: boolean, i: number): number {
  const w = inside ? W_IN[0] + ((W_IN[1] - W_IN[0]) * i) / (TABLE_ROWS - 1) : W_OUT[0] + ((W_OUT[1] - W_OUT[0]) * i) / (TABLE_ROWS - 1);
  return inside ? B_CRIT * (1 - Math.exp(w)) : B_CRIT * (1 + Math.exp(w));
}

export interface GeodesicTables {
  out: Float32Array;
  in: Float32Array;
}

export function buildTables(): GeodesicTables {
  const out = new Float32Array(TABLE_COLS * TABLE_ROWS * 4);
  const inn = new Float32Array(TABLE_COLS * TABLE_ROWS * 4);
  for (let i = 0; i < TABLE_ROWS; i++) {
    outRow(rowImpact(false, i), out.subarray(i * TABLE_COLS * 4, (i + 1) * TABLE_COLS * 4));
    // (The last inside row is b = 0, a radial ray: Phi = 0 everywhere.)
    const b = Math.max(rowImpact(true, i), 1e-6);
    inRow(b, inn.subarray(i * TABLE_COLS * 4, (i + 1) * TABLE_COLS * 4));
  }
  return { out, in: inn };
}

/** The tables as float textures, linearly filtered (half floats where float filtering is unsupported). */
export function tableTextures(renderer: THREE.WebGLRenderer): { out: THREE.DataTexture; in: THREE.DataTexture } {
  const t = buildTables();
  const floatLinear = renderer.extensions.has('OES_texture_float_linear');
  const make = (data: Float32Array): THREE.DataTexture => {
    const tex = floatLinear
      ? new THREE.DataTexture(data, TABLE_COLS, TABLE_ROWS, THREE.RGBAFormat, THREE.FloatType)
      : new THREE.DataTexture(Uint16Array.from(data, (v) => THREE.DataUtils.toHalfFloat(v)), TABLE_COLS, TABLE_ROWS, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  };
  return { out: make(t.out), in: make(t.in) };
}
