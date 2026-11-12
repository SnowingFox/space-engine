import type { SystemData } from '../universe/bodies';
import { describe, kindLabel, swatch } from './describe';
import type { HudActions, PanelName, Settings } from './hud';
import type { MusicPlayer } from './music';
import type { ScenicSpot } from './scenic';
import { sameTarget, targetName, type Target } from './target';
import { ICON, el, escapeHtml } from './ui';

/** Objects matching a query, best first. Supplied by the game, which knows what is loaded. */
export type SearchSource = (query: string) => Target[];

const titleBar = (title: string) =>
  `<div class="title"><span>${title}</span><button class="x" data-close aria-label="Close">${ICON.close}</button></div>`;

const FKEYS: Record<string, PanelName> = { F1: 'help', F2: 'browser', F3: 'search', F4: 'settings', F6: 'scenic' };

/** F3: type a name, pick from the live-filtered list. */
export class SearchDialog {
  private readonly input: HTMLInputElement;
  private readonly list: HTMLElement;
  private results: Target[] = [];
  private cursor = 0;

  constructor(
    root: HTMLElement, private readonly actions: HudActions,
    private readonly close: () => void, toggle: (p: PanelName) => void,
  ) {
    root.innerHTML = titleBar('Find object');
    this.input = el('input', 'field', root);
    this.input.type = 'text';
    this.input.placeholder = 'Name of a star, planet or moon';
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.list = el('div', 'results', root);
    const foot = el('div', 'foot', root, '<span><kbd>Enter</kbd> select<kbd>Shift+Enter</kbd> go to</span>');
    const goBtn = el('button', '', foot, 'Go to');
    goBtn.addEventListener('click', () => this.commit(true));

    this.input.addEventListener('input', () => this.refresh());
    this.input.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') this.close();
      else if (e.code === 'Enter' || e.code === 'NumpadEnter') this.commit(e.shiftKey);
      else if (e.code === 'ArrowDown') this.move(1);
      else if (e.code === 'ArrowUp') this.move(-1);
      else if (FKEYS[e.code]) toggle(FKEYS[e.code]);
      else return;
      e.preventDefault();
    });
  }

  opened(): void {
    this.input.value = '';
    this.refresh();
    this.input.focus();
  }

  closed(): void {
    this.input.blur();
  }

  /** For tests and deep links: fill in a query as if typed. */
  setQuery(q: string): void {
    this.input.value = q;
    this.refresh();
  }

  private refresh(): void {
    this.results = this.actions.searchSource(this.input.value.trim());
    this.cursor = 0;
    this.list.innerHTML = '';
    if (this.results.length === 0) {
      el('div', 'empty', this.list, 'No matching objects');
      return;
    }
    this.results.forEach((t, i) => {
      const row = el('div', 'row', this.list,
        `<i class="orb" style="background:${swatch(t)}"></i><span class="n">${escapeHtml(targetName(t))}</span><span class="d">${escapeHtml(kindLabel(t))}</span>`);
      row.addEventListener('click', () => { this.cursor = i; this.mark(); this.actions.select(t); });
      row.addEventListener('dblclick', () => { this.cursor = i; this.commit(true); });
    });
    this.mark();
  }

  private move(d: number): void {
    if (this.results.length === 0) return;
    this.cursor = (this.cursor + d + this.results.length) % this.results.length;
    this.mark();
    this.list.children[this.cursor]?.scrollIntoView({ block: 'nearest' });
  }

  private mark(): void {
    Array.from(this.list.children).forEach((row, i) => row.classList.toggle('cur', i === this.cursor));
  }

  private commit(go: boolean): void {
    const t = this.results[this.cursor];
    if (!t) return;
    this.close();
    if (go) this.actions.go(t);
    else this.actions.select(t);
  }
}

/** F2: the current system laid out in a row — star, planets in order, moons beneath. */
export class SystemBrowser {
  private readonly strip: HTMLElement;
  private readonly title: HTMLElement;
  private items: { e: HTMLElement; t: Target }[] = [];

  constructor(root: HTMLElement, private readonly actions: HudActions) {
    root.innerHTML = titleBar('Solar system browser');
    this.title = root.querySelector('.title span') as HTMLElement;
    this.strip = el('div', 'strip', root);
    this.setSystem(null);
  }

  setSystem(system: SystemData | null): void {
    this.strip.innerHTML = '';
    this.items = [];
    this.title.textContent = system ? `Solar system browser — ${system.star.name}` : 'Solar system browser';
    if (!system) {
      el('div', 'empty', this.strip, 'Not inside a star system. Select a star and press G to go there.');
      return;
    }
    const star = system.star;
    const starSize = Math.min(Math.max(34 + 9 * Math.log10(star.radius), 16), 54);
    this.orb(el('div', 'col star', this.strip), { kind: 'star', star }, starSize, star.name);
    if (system.planets.length === 0) el('div', 'empty', this.strip, 'No planets');
    for (const p of system.planets) {
      const col = el('div', 'col', this.strip);
      const size = Math.min(Math.max(8 + 14 * Math.log10(p.radius / 1000), 9), 36);
      this.orb(col, { kind: 'body', star, body: p }, size, p.name);
      if (p.moons.length === 0) continue;
      const moons = el('div', 'moons', col);
      for (const m of p.moons) {
        const mt: Target = { kind: 'body', star, body: m };
        const d = Math.min(Math.max(4 + 5 * Math.log10(m.radius / 100), 5), 12);
        const row = el('div', 'moon', moons,
          `<i class="orb" style="width:${d.toFixed(0)}px;height:${d.toFixed(0)}px;background:${swatch(mt)}"></i><span>${escapeHtml(m.name)}</span>`);
        this.bind(row, mt);
      }
    }
  }

  private orb(col: HTMLElement, t: Target, size: number, name: string): void {
    const item = el('div', 'item', col);
    const stage = el('div', 'stage', item);
    const px = `${size.toFixed(0)}px`;
    const orb = el('i', 'orb', stage);
    orb.style.cssText = `width:${px};height:${px};background:${swatch(t)}`;
    if (t.kind === 'star') orb.style.boxShadow = '0 0 14px 2px rgba(255, 236, 200, 0.35)';
    if (t.kind === 'body' && t.body.rings) {
      const ring = el('i', 'ring', stage);
      ring.style.cssText = `width:${(size * 2.1).toFixed(0)}px;height:${(size * 0.62).toFixed(0)}px`;
    }
    el('span', 'nm', item, escapeHtml(name));
    this.bind(item, t);
  }

  private bind(e: HTMLElement, t: Target): void {
    e.title = `${targetName(t)} — ${describe(t)}`;
    e.addEventListener('click', () => this.actions.select(t));
    e.addEventListener('dblclick', () => this.actions.go(t));
    this.items.push({ e, t });
  }

  setSelected(sel: Target | null): void {
    for (const it of this.items) it.e.classList.toggle('sel', sameTarget(it.t, sel));
  }
}

/** F6: curated places as a grid of picture cards; a click jumps there. */
export class ScenicDialog {
  private readonly thumbs: { img: HTMLImageElement; src: string }[] = [];
  private loaded = false;

  constructor(root: HTMLElement, spots: ScenicSpot[], go: (id: string) => void) {
    root.innerHTML = titleBar('Scenic spots · 风景点');
    const grid = el('div', 'cards', root);
    for (const s of spots) {
      const card = el('button', 'card', grid,
        `<span class="thumb">${ICON.scenic}</span>
         <span class="t"><b>${escapeHtml(s.title)}</b><i>${escapeHtml(s.titleZh)}</i></span>
         <span class="s">${escapeHtml(s.subtitle)}</span>
         <span class="d">${escapeHtml(s.description)}</span>`);
      card.title = `${s.title} — ${s.description}`;
      card.addEventListener('click', () => { card.blur(); go(s.id); });
      const thumb = card.querySelector('.thumb') as HTMLElement;
      const img = el('img', '', thumb);
      img.alt = '';
      img.draggable = false;
      // Until a thumbnail has been rendered the card keeps its neutral placeholder.
      img.addEventListener('load', () => thumb.classList.add('ok'));
      img.addEventListener('error', () => img.remove());
      this.thumbs.push({ img, src: s.image });
    }
  }

  /** Thumbnails are only fetched the first time the panel is shown. */
  opened(): void {
    if (this.loaded) return;
    this.loaded = true;
    for (const t of this.thumbs) t.img.src = t.src;
  }
}

/** F4: a handful of view settings, bound to the shared settings object. */
export class SettingsDialog {
  private readonly sync_: (() => void)[] = [];

  constructor(root: HTMLElement, private readonly settings: Settings, changed: () => void, private readonly music: MusicPlayer) {
    root.innerHTML = titleBar('Settings');
    const body = el('div', 'form', root);

    const slider = (label: string, key: 'fov' | 'mouseSensitivity', min: number, max: number, step: number, fmt: (v: number) => string) => {
      el('label', 'k', body, label);
      const wrap = el('div', 'v', body);
      const input = el('input', '', wrap);
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      const out = el('span', 'out', wrap);
      const show = () => { input.value = String(settings[key]); out.textContent = fmt(settings[key]); };
      input.addEventListener('input', () => { settings[key] = Number(input.value); out.textContent = fmt(settings[key]); changed(); });
      // Give the keyboard back to the flight controls once the drag ends.
      input.addEventListener('change', () => input.blur());
      this.sync_.push(show);
    };
    const check = (label: string, key: 'labels' | 'orbits' | 'bloom' | 'milkyWayPhoto', hint: string) => {
      if (settings[key] === null) return;
      el('label', 'k', body, label);
      const wrap = el('div', 'v', body);
      const input = el('input', '', wrap);
      input.type = 'checkbox';
      el('span', 'hint', wrap, hint);
      input.addEventListener('change', () => { settings[key] = input.checked; input.blur(); changed(); });
      this.sync_.push(() => { input.checked = !!settings[key]; });
    };

    slider('Field of view', 'fov', 20, 120, 1, (v) => `${v.toFixed(0)}°`);
    slider('Mouse sensitivity', 'mouseSensitivity', 0.3, 2.5, 0.1, (v) => `${v.toFixed(1)}x`);
    check('Labels', 'labels', 'Shift+L');
    check('Orbits', 'orbits', 'O');
    check('Bloom', 'bloom', 'Glow around bright objects');
    check('Milky Way photo', 'milkyWayPhoto', 'NASA sky survey instead of the model, inside the Milky Way');

    // Music: a soundtrack the player brings, from a file on their disk.
    el('div', 'sect', body, 'Music');
    el('label', 'k', body, 'Track');
    const trackRow = el('div', 'v track', body);
    this.trackName = el('span', 'tn', trackRow);
    const file = el('input', '', trackRow);
    file.type = 'file';
    file.accept = 'audio/*';
    file.hidden = true;
    const pick = el('button', '', trackRow, 'Choose…');
    pick.title = 'Pick an audio file from your disk (or drop one on the window)';
    pick.addEventListener('click', () => { file.click(); pick.blur(); });
    file.addEventListener('change', () => {
      const f = file.files?.[0];
      if (f) void music.setFile(f);
      file.value = '';
    });
    this.removeBtn = el('button', '', trackRow, 'Remove');
    this.removeBtn.addEventListener('click', () => { void music.clearFile(); this.removeBtn.blur(); });

    el('label', 'k', body, 'Play');
    const playRow = el('div', 'v', body);
    this.musicOn = el('input', '', playRow);
    this.musicOn.type = 'checkbox';
    el('span', 'hint', playRow, 'M · loops, quieter during jumps');
    this.musicOn.addEventListener('change', () => { if (this.musicOn.checked !== music.on) music.toggle(); this.musicOn.blur(); });

    el('label', 'k', body, 'Volume');
    const volRow = el('div', 'v', body);
    this.vol = el('input', '', volRow);
    this.vol.type = 'range';
    this.vol.min = '0';
    this.vol.max = '1';
    this.vol.step = '0.01';
    this.volOut = el('span', 'out', volRow);
    this.vol.addEventListener('input', () => { music.setVolume(Number(this.vol.value)); this.volOut.textContent = `${Math.round(music.volume * 100)}%`; });
    this.vol.addEventListener('change', () => this.vol.blur());
    el('div', 'note', body, 'Choose an audio file or drop one on the window; it is kept in this browser. '
      + 'Leave it empty to use the built-in soundtrack (<code>public/music/soundtrack.mp3</code>).');
    this.sync();
  }

  private readonly trackName: HTMLElement;
  private readonly removeBtn: HTMLButtonElement;
  private readonly musicOn: HTMLInputElement;
  private readonly vol: HTMLInputElement;
  private readonly volOut: HTMLElement;

  sync(): void {
    for (const f of this.sync_) f();
    this.syncMusic();
  }

  syncMusic(): void {
    const m = this.music;
    if (!this.trackName) return;
    this.trackName.textContent = m.track ?? 'None';
    this.trackName.title = m.track ? (m.source === 'default' ? 'public/music/soundtrack.mp3' : m.track) : '';
    this.trackName.classList.toggle('none', !m.track);
    this.removeBtn.hidden = m.source !== 'file';
    this.musicOn.checked = m.on;
    this.vol.value = String(m.volume);
    this.volOut.textContent = `${Math.round(m.volume * 100)}%`;
  }
}

const keys = (rows: [string, string][]) =>
  rows.map(([k, d]) => `<span class="keycap">${k.split(' ').map((p) => (p === '/' ? `<em>${p}</em>` : `<kbd>${escapeHtml(p)}</kbd>`)).join('')}</span><span>${d}</span>`).join('');

const section = (name: string, rows: [string, string][]) =>
  `<section><h3>${name}</h3><div class="keys">${keys(rows)}</div></section>`;

const link = (url: string, text: string) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
const CC_BY = link('https://creativecommons.org/licenses/by/4.0/', 'CC BY 4.0');

// Credit lines required by the CC BY 4.0 maps (and requested by NASA for the public-domain
// ones); the full table, with the changes made to each file, is public/textures/CREDITS.md.
const CREDITS_HTML = `<section class="credits"><h3>Credits</h3><ul>
  <li>Earth (day, clouds), Mars, Mercury, Venus, Jupiter, Saturn and its rings, Uranus, Neptune:
    ${link('https://www.solarsystemscope.com/textures/', 'Solar System Scope')}, ${CC_BY}
    (Earth clouds converted to greyscale; Mercury, Venus and rings downsized).</li>
  <li>Earth at night: NASA Earth Observatory / NASA GSFC (Suomi NPP VIIRS Black Marble).
    Earth elevation: NOAA NCEI ETOPO 2022.</li>
  <li>Moon colour and elevation: NASA's Scientific Visualization Studio, LRO LROC and LOLA teams.
    Mars elevation: NASA MGS MOLA Science Team, PDS Geosciences Node.</li>
  <li>Io, Europa, Ganymede, Callisto, Titan, Enceladus, Triton: NASA / JPL / Space Science Institute / USGS Astrogeology.
    Pluto: NASA / JHUAPL / SwRI.</li>
  <li>Star map: NASA/Goddard Space Flight Center Scientific Visualization Studio; Gaia DR2: ESA/Gaia/DPAC.</li>
  <li>Galaxy images: NASA, ESA and The Hubble Heritage Team (STScI/AURA), S. Beckwith (STScI),
    A. Aloisi (STScI/ESA), A. Zezas and J. Huchra (CfA); ESO; ESO/VMC Survey; ${CC_BY},
    cropped, resized and background-subtracted.</li>
</ul></section>`;

export const HELP_HTML = `${titleBar('Controls')}
<div class="cols">
  <div>
    ${section('Movement', [
      ['W / S', 'Forward / back'],
      ['A / D', 'Strafe left / right'],
      ['R / F', 'Up / down'],
      ['Q / E', 'Roll'],
      ['Wheel / + / -', 'Velocity setting (Shift: x10)'],
      ['Z / X', 'Full stop'],
      ['Left-drag', 'Look around'],
      ['Right-drag', 'Orbit the selected object'],
      ['Arrows', 'Turn'],
      ['PgUp / PgDn', 'Zoom (field of view)'],
    ])}
    ${section('Time', [
      ['Space', 'Pause'],
      ['L / K', '10x faster / slower'],
      ['J', 'Reverse time'],
      ['\\', 'Real time (1x)'],
    ])}
  </div>
  <div>
    ${section('Navigation', [
      ['Click', 'Select object'],
      ['Double-click', 'Select and go to'],
      ['Right-click', 'Object menu'],
      ['G', 'Go to selected object'],
      ['G G', 'Go to, then land'],
      ['Shift+G', 'Land on selected object'],
      ['C', 'Centre selected object'],
      ['T / Shift+C', 'Track (keep centred)'],
      ['Shift+F', 'Follow (move along with it)'],
      ['H', 'Go home (Earth)'],
      ['Esc', 'Cancel / deselect'],
    ])}
    ${section('Interface', [
      ['F1', 'Controls'],
      ['F2', 'Solar system browser'],
      ['F3', 'Find object'],
      ['F4', 'Settings'],
      ['F6', 'Scenic spots'],
      ['I', 'Full object info'],
      ['Shift+L', 'Labels'],
      ['O', 'Orbits'],
      ['M', 'Music on / off'],
      ['\` / F10', 'Hide / show interface'],
      ['Home', 'Reset field of view'],
    ])}
  </div>
</div>
<p class="note">Music: the built-in soundtrack plays in a loop; choose another audio file in Settings (F4) or drop
  one on the window.</p>
${CREDITS_HTML}`;
