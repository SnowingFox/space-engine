// Two coordinate scales are used everywhere:
//   galactic positions in light years (double precision),
//   system-local positions in kilometres relative to the anchor star.

export const KM_PER_LY = 9.4607e12;
export const KM_PER_AU = 1.495978707e8;
export const C_KM_S = 299792.458;
export const SUN_RADIUS_KM = 695700;
export const EARTH_RADIUS_KM = 6371;
export const SECONDS_PER_DAY = 86400;
export const SECONDS_PER_YEAR = 365.25 * SECONDS_PER_DAY;

export function formatDistance(km: number): string {
  const a = Math.abs(km);
  if (a < 1) return `${(km * 1000).toFixed(0)} m`;
  if (a < 1e4) return `${km.toFixed(1)} km`;
  if (a < 1e6) return `${Math.round(km).toLocaleString('en-US')} km`;
  if (a < 0.01 * KM_PER_AU) return `${(km / 1e6).toFixed(2)} million km`;
  if (a < 0.05 * KM_PER_LY) return `${(km / KM_PER_AU).toFixed(a < 10 * KM_PER_AU ? 3 : 1)} AU`;
  const ly = km / KM_PER_LY;
  if (Math.abs(ly) < 1000) return `${ly.toFixed(2)} ly`;
  return `${(ly / 1000).toFixed(2)} kly`;
}

export function formatSpeed(kmPerSec: number): string {
  const a = Math.abs(kmPerSec);
  if (a < 1) return `${(kmPerSec * 1000).toFixed(0)} m/s`;
  if (a < 0.01 * C_KM_S) return `${kmPerSec.toFixed(a < 100 ? 1 : 0)} km/s`;
  if (a < 1000 * C_KM_S) return `${(kmPerSec / C_KM_S).toFixed(2)} c`;
  if (a < 0.01 * KM_PER_LY) return `${(kmPerSec / KM_PER_AU).toFixed(1)} AU/s`;
  return `${(kmPerSec / KM_PER_LY).toFixed(2)} ly/s`;
}

export function formatDuration(seconds: number): string {
  const a = Math.abs(seconds);
  if (a < 120) return `${seconds.toFixed(0)} s`;
  if (a < 7200) return `${(seconds / 60).toFixed(1)} min`;
  if (a < 2 * SECONDS_PER_DAY) return `${(seconds / 3600).toFixed(1)} h`;
  if (a < 2 * SECONDS_PER_YEAR) return `${(seconds / SECONDS_PER_DAY).toFixed(1)} d`;
  return `${(seconds / SECONDS_PER_YEAR).toFixed(2)} yr`;
}
