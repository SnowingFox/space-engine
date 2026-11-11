/** Small DOM helpers and the inline icon set shared by the HUD panels. */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls: string, parent: HTMLElement | null, html = '',
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  parent?.appendChild(e);
  return e;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

const svg = (body: string) =>
  `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICON = {
  search: svg('<circle cx="8.5" cy="8.5" r="5"/><path d="M12.3 12.3 17 17"/>'),
  system: svg('<circle cx="4" cy="10" r="2.6"/><circle cx="11" cy="10" r="1.4"/><circle cx="16.5" cy="10" r="1"/>'),
  home: svg('<path d="M3 9.5 10 3.5l7 6"/><path d="M5 8.5V16h10V8.5"/>'),
  labels: svg('<path d="M3 4.5h7.5L17 10l-6.5 5.5H3z"/><circle cx="6.5" cy="10" r="1"/>'),
  orbits: svg('<ellipse cx="10" cy="10" rx="8" ry="4.2" transform="rotate(-20 10 10)"/><circle cx="10" cy="10" r="1.6"/>'),
  scenic: svg('<rect x="2.5" y="4" width="15" height="12" rx="1"/><path d="M3 13.500 7.500 9l3.500 3.500 2-2 4 4"/><circle cx="13.200" cy="7.600" r="1.100"/>'),
  settings: svg('<path d="M3 6h9M15.5 6H17M3 14h1.5M8 14h9"/><circle cx="13.7" cy="6" r="1.8"/><circle cx="6.2" cy="14" r="1.8"/>'),
  help: svg('<circle cx="10" cy="10" r="7"/><path d="M7.8 8.1a2.3 2.3 0 1 1 3.3 2.1c-.7.4-1.1.8-1.1 1.6"/><path d="M10 14.2v.1"/>'),
  reverse: svg('<path d="M12.5 5.5 6.5 10l6 4.5z" fill="currentColor"/>'),
  slower: svg('<path d="M10 5.5 4.5 10l5.500 4.500zM16 5.500 10.500 10l5.500 4.500z" fill="currentColor" stroke-width="1"/>'),
  faster: svg('<path d="M10 5.500 15.500 10 10 14.500zM4 5.500 9.500 10 4 14.500z" fill="currentColor" stroke-width="1"/>'),
  pause: svg('<path d="M7.5 5.500v9M12.500 5.500v9" stroke-width="2"/>'),
  play: svg('<path d="M7.500 5.500 13.500 10l-6 4.500z" fill="currentColor"/>'),
  real: svg('<circle cx="10" cy="10" r="6.5"/><path d="M10 6.300V10l2.500 1.700"/>'),
  close: svg('<path d="M5.500 5.500l9 9M14.500 5.500l-9 9"/>'),
  info: svg('<circle cx="10" cy="10" r="7"/><path d="M10 9v4.800"/><path d="M10 6.300v.1"/>'),
  music: svg('<path d="M8 14.500V4.500l8-1.500v10"/><circle cx="6" cy="14.500" r="2"/><circle cx="14" cy="13" r="2"/>'),
  hide: svg('<path d="M2.500 10s2.800-5 7.500-5 7.500 5 7.500 5-2.800 5-7.500 5-7.500-5-7.500-5z"/><circle cx="10" cy="10" r="2.200"/><path d="M3.500 16.500 16.500 3.500"/>'),
};

export type IconName = keyof typeof ICON;
