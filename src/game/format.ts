import { C_KM_S, KM_PER_AU, KM_PER_LY, SECONDS_PER_DAY, SECONDS_PER_YEAR } from '../core/units';

const LY_PER_PC = 3.26156;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** About three significant digits, with thousands separators for big values. */
export function num(v: number): string {
  const a = Math.abs(v);
  if (a < 1e-9) return '0';
  if (a >= 1000) return Math.round(v).toLocaleString('en-US');
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 0.1 || a === 0) return v.toFixed(2);
  if (a >= 0.001) return v.toFixed(4);
  return v.toExponential(1);
}

export function formatSpeed(kmPerSec: number): string {
  const a = Math.abs(kmPerSec);
  if (a < 0.9995) return `${num(kmPerSec * 1000)} m/s`;
  if (a < 0.1 * C_KM_S) return `${num(kmPerSec)} km/s`;
  if (a < KM_PER_AU) return `${num(kmPerSec / C_KM_S)} c`;
  if (a < 0.1 * KM_PER_LY) return `${num(kmPerSec / KM_PER_AU)} AU/s`;
  const ly = kmPerSec / KM_PER_LY;
  if (a < 1e3 * KM_PER_LY) return `${num(ly)} ly/s`;
  if (a < 1e6 * KM_PER_LY) return `${num(ly / 1e3)} kly/s`;
  return `${num(ly / 1e6)} Mly/s`;
}

export function formatDistance(km: number): string {
  const a = Math.abs(km);
  if (a < 1) return `${num(km * 1000)} m`;
  if (a < 0.01 * KM_PER_AU) return `${num(km)} km`;
  if (a < 0.1 * KM_PER_LY) return `${num(km / KM_PER_AU)} AU`;
  const ly = km / KM_PER_LY;
  if (a < 1e3 * KM_PER_LY) return `${num(ly)} ly`;
  if (a < 1e6 * KM_PER_LY) return `${num(ly / 1e3)} kly`;
  return `${num(ly / 1e6)} Mly`;
}

/** Interstellar distances also in parsecs, as astronomers quote them. */
export function formatDistanceLong(km: number): string {
  const ly = Math.abs(km) / KM_PER_LY;
  if (ly < 0.1) return formatDistance(km);
  const pc = ly / LY_PER_PC;
  return `${formatDistance(km)} (${pc < 1000 ? `${num(pc)} pc` : `${num(pc / 1000)} kpc`})`;
}

export function formatDuration(seconds: number): string {
  const a = Math.abs(seconds);
  if (a < 120) return `${num(seconds)} s`;
  if (a < 7200) return `${num(seconds / 60)} min`;
  if (a < 2 * SECONDS_PER_DAY) return `${num(seconds / 3600)} hours`;
  if (a < 2 * SECONDS_PER_YEAR) return `${num(seconds / SECONDS_PER_DAY)} days`;
  return `${num(seconds / SECONDS_PER_YEAR)} years`;
}

/** Simulated UTC date and time; far beyond the calendar it degrades to a year count. */
export function formatDate(ms: number): { date: string; time: string } {
  const d = new Date(ms);
  if (isNaN(d.getTime()) || Math.abs(d.getUTCFullYear()) > 99999) {
    const year = 1970 + ms / (SECONDS_PER_YEAR * 1000);
    return { date: `Year ${Math.round(year).toLocaleString('en-US')}`, time: '' };
  }
  const p = (v: number) => String(v).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()} ${MONTHS[d.getUTCMonth()]} ${p(d.getUTCDate())}`,
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`,
  };
}

export function formatTimeRate(rate: number, paused: boolean): string {
  if (paused) return 'Paused';
  if (rate === 1) return '1x real time';
  const a = Math.abs(rate);
  const mag = a >= 1 ? Math.round(a).toLocaleString('en-US') : String(a);
  return `${rate < 0 ? '-' : ''}${mag}x`;
}
