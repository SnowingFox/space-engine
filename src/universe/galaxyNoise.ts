import { Rng } from '../core/rng';

// The random values the galaxy march reads its clouds and arm structure from (galaxyShader.ts uploads them as a
// tiling 3D texture), and the same noise read on the CPU, so that what is placed from the model there (bright
// stars, the stars of a galaxy one flies into) follows the arms the march draws.

export const NOISE_SIZE = 128;

export const NOISE_DATA: Uint8Array = (() => {
  const rng = new Rng(977);
  const data = new Uint8Array(NOISE_SIZE ** 3);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(rng.next() * 256);
  return data;
})();

const N = NOISE_SIZE, M = N - 1;
const at = (x: number, y: number, z: number): number => NOISE_DATA[((z & M) * N + (y & M)) * N + (x & M)] / 255;

/** gnoise of the march: value noise 0..1, smoothly interpolated (the texture read linearly at smoothstepped offsets). */
export function gnoise(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  fz = fz * fz * (3 - 2 * fz);
  const l = (a: number, b: number, t: number): number => a + (b - a) * t;
  return l(
    l(l(at(ix, iy, iz), at(ix + 1, iy, iz), fx), l(at(ix, iy + 1, iz), at(ix + 1, iy + 1, iz), fx), fy),
    l(l(at(ix, iy, iz + 1), at(ix + 1, iy, iz + 1), fx), l(at(ix, iy + 1, iz + 1), at(ix + 1, iy + 1, iz + 1), fx), fy),
    fz,
  );
}
