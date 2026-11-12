import type { SystemData } from '../universe/bodies';
import { describe, properties } from './describe';
import { HELP_HTML, ScenicDialog, SearchDialog, SettingsDialog, SystemBrowser, type SearchSource } from './dialogs';
import { formatDate, formatDistance, formatDistanceLong, formatSpeed, formatTimeRate } from './format';
import type { Box, LabelLayout } from './labels';
import { MusicPlayer } from './music';
import { SCENIC_SPOTS } from './scenic';
import { targetName, type Target } from './target';
import { ICON, el, escapeHtml, type IconName } from './ui';

/** The few properties the compact info panel shows, by label, best first; the rest wait for Info (I). */
const KEY_FACTS: Record<string, string[]> = {
  body: ['Diameter', 'Temperature'],
  star: ['Luminosity', 'Temperature'],
  galaxy: ['Diameter', 'Type'],
  nebula: ['Diameter', 'From Sol'],
};
const KEY_FACTS_OTHER = ['Diameter', 'Size', 'Mass', 'Temperature', 'Type'];

/** Up to two short facts for the compact panel, with any "(...)" aside dropped. */
function keyFacts(t: Target): [string, string][] {
  const rows = properties(t);
  const cls = describe(t).toLowerCase();
  const picked = (KEY_FACTS[t.kind] ?? KEY_FACTS_OTHER).map((k) => rows.find(([label]) => label === k))
    .filter((r): r is [string, string] => !!r && !cls.includes(r[1].toLowerCase()));
  const facts = (picked.length > 0 ? picked : rows).slice(0, 2);
  return facts.map(([k, v]) => [k, v.replace(/\s*\([^)]*\)\s*$/, '')]);
}

const canLand = (t: Target) => t.kind === 'body' && t.body.type !== 'gas' && t.body.type !== 'icegiant';

export type TimeCommand = 'reverse' | 'slower' | 'pause' | 'faster' | 'real';
export type PanelName = 'search' | 'browser' | 'help' | 'settings' | 'scenic';

export interface Settings {
  labels: boolean;
  orbits: boolean;
  /** Vertical field of view, degrees. */
  fov: number;
  mouseSensitivity: number;
  /** null when the render pipeline does not expose a bloom switch. */
  bloom: boolean | null;
  /** Inside the Milky Way, show the sky as photographed (NASA survey) instead of the model. */
  milkyWayPhoto: boolean;
}

export interface HudActions {
  select(t: Target | null): void;
  go(t: Target): void;
  land(t: Target): void;
  /** Select and turn to face it (C). */
  center(t: Target): void;
  /** Select and keep it centred (T). */
  track(t: Target): void;
  /** Select and move along with it (Shift+F). */
  follow(t: Target): void;
  home(): void;
  time(cmd: TimeCommand): void;
  /** Called after the HUD changed a value in the shared settings object. */
  settingsChanged(): void;
  /** Jump to a scenic spot by id. */
  scenic(id: string): void;
  /** Objects the search dialog can find. */
  searchSource: SearchSource;
}

export interface HudFrame {
  /** "Free mode", "Go to: Saturn", "Landing: Moon", "Following Earth". */
  mode: string;
  /** True while an autopilot is flying. */
  auto: boolean;
  speed: number;
  speedSetting: number;
  /** The proximity safety limit is holding the speed down. */
  limited: boolean;
  /** The fastest the proximity limit allows here, km/s. */
  cap: number;
  /** Nearest body or region, and where we are relative to it. */
  place: string;
  placeDetail: string;
  timeRate: number;
  paused: boolean;
  /** Simulated date, ms since the Unix epoch. */
  dateMs: number;
  selected: Target | null;
  /** km to the selected object's surface. */
  selectedDist: number;
}

/** SpaceEngine-style HUD: sparse panels docked to the screen edges, nothing in the centre. */
export class Hud {
  private readonly info: HTMLElement;
  private readonly infoDist: HTMLElement;
  private readonly modeEl: HTMLElement;
  private readonly velEl: HTMLElement;
  private readonly setEl: HTMLElement;
  private readonly limitEl: HTMLElement;
  private readonly placeEl: HTMLElement;
  private readonly placeDetailEl: HTMLElement;
  private readonly dateEl: HTMLElement;
  private readonly rateEl: HTMLElement;
  private readonly pauseBtn: HTMLElement;
  private readonly toastEl: HTMLElement;
  private readonly marker: HTMLElement;
  private readonly tools = new Map<string, HTMLElement>();
  private readonly dialogs: Record<Exclude<PanelName, 'browser'>, HTMLElement>;
  private readonly search: SearchDialog;
  private readonly settingsDialog: SettingsDialog;
  private readonly scenicDialog: ScenicDialog;
  private boxes: Box[] = [];
  private boxesAt = -1e9;
  private readonly browser: SystemBrowser;
  private readonly labels = new Map<string, HTMLElement>();
  private selected: Target | null = null;
  private lastText = 0;
  private toastTimer = 0;
  private readonly speedNoteEl: HTMLElement;
  private speedNoteTimer = 0;
  private lastSetting = -1;
  private paused: boolean | null = null;
  /** Full property list (I) instead of the compact summary. */
  private infoFull = false;
  private readonly ctxMenu: HTMLElement;
  private lastPointer = 0;
  private idle = false;
  readonly music: MusicPlayer;

  constructor(
    private readonly root: HTMLElement, private readonly labelRoot: HTMLElement,
    private readonly actions: HudActions, private readonly settings: Settings,
  ) {
    this.music = new MusicPlayer((m) => this.toast(m));

    // Right edge: slim vertical toolbar, faint until hovered.
    const bar = el('div', 'toolbar', root);
    const tool = (id: string, icon: IconName, tip: string, key: string, run: () => void) => {
      const b = el('button', 'tool', bar, `${ICON[icon]}<span class="tip">${tip}<kbd>${key}</kbd></span>`);
      b.setAttribute('aria-label', `${tip} (${key})`);
      b.addEventListener('click', () => { run(); b.blur(); });
      this.tools.set(id, b);
    };
    const gap = () => el('i', 'sep', bar);
    tool('search', 'search', 'Find object', 'F3', () => this.toggle('search'));
    tool('browser', 'system', 'Solar system browser', 'F2', () => this.toggle('browser'));
    tool('scenic', 'scenic', 'Scenic spots', 'F6', () => this.toggle('scenic'));
    tool('home', 'home', 'Go home', 'H', () => actions.home());
    gap();
    tool('info', 'info', 'Object info', 'I', () => this.toggleInfo());
    tool('labels', 'labels', 'Labels', 'Shift+L', () => this.flip('labels'));
    tool('orbits', 'orbits', 'Orbits', 'O', () => this.flip('orbits'));
    tool('music', 'music', 'Music', 'M', () => this.music.toggle());
    gap();
    tool('settings', 'settings', 'Settings', 'F4', () => this.toggle('settings'));
    tool('help', 'help', 'Controls', 'F1', () => this.toggle('help'));
    tool('hide', 'hide', 'Hide interface', '`', () => document.body.classList.add('ui-hidden'));

    // Top-left: the selected object.
    this.info = el('div', 'panel info', root);
    this.infoDist = el('span', '', null);

    // Right-click on an object: its actions at the cursor.
    this.ctxMenu = el('div', 'panel ctx hidden', root);
    window.addEventListener('pointerdown', (e) => {
      if (!this.ctxMenu.classList.contains('hidden') && !(e.target instanceof Node && this.ctxMenu.contains(e.target))) this.closeContext();
    }, true);
    // Secondary panels fade during flight while the mouse is still; any movement brings them back.
    window.addEventListener('pointermove', () => { this.lastPointer = performance.now(); }, { passive: true });

    // Bottom-left: movement readout.
    const move = el('div', 'panel move', root);
    this.modeEl = el('div', 'mode', move);
    const grid = el('div', 'kv', move);
    el('span', 'k', grid, 'Velocity');
    this.velEl = el('span', 'v', grid);
    el('span', 'k', grid, 'Setting');
    const setRow = el('span', 'v', grid);
    this.setEl = el('span', '', setRow);
    this.limitEl = el('span', 'limit', setRow, 'limited');
    this.limitEl.title = 'Speed is limited near bodies';
    this.placeEl = el('span', 'k', grid);
    this.placeDetailEl = el('span', 'v', grid);

    // Bottom-right: simulated clock and time controls.
    const clock = el('div', 'panel clock', root);
    this.dateEl = el('div', 'date', clock);
    this.rateEl = el('div', 'rate', clock);
    const buttons = el('div', 'timebar', clock);
    const timeBtn = (icon: IconName, tip: string, key: string, cmd: TimeCommand) => {
      const b = el('button', 'tbtn', buttons, `<span class="ic">${ICON[icon]}</span><span class="tip">${tip}<kbd>${escapeHtml(key)}</kbd></span>`);
      b.setAttribute('aria-label', `${tip} (${key})`);
      b.addEventListener('click', () => { actions.time(cmd); b.blur(); });
      return b;
    };
    timeBtn('reverse', 'Reverse time', 'J', 'reverse');
    timeBtn('slower', '10x slower', 'K', 'slower');
    this.pauseBtn = timeBtn('pause', 'Pause', 'Space', 'pause');
    timeBtn('faster', '10x faster', 'L', 'faster');
    timeBtn('real', 'Real time', '\\', 'real');

    this.toastEl = el('div', 'toast', root);
    this.speedNoteEl = el('div', 'speed-note', root);
    this.marker = el('div', 'marker', labelRoot, '<i></i><i></i><i></i><i></i>');

    this.browser = new SystemBrowser(el('div', 'panel browser', root), actions);
    const dialog = (name: string) => el('div', `panel dialog ${name}`, root);
    this.dialogs = { search: dialog('search'), help: dialog('help'), settings: dialog('settings'), scenic: dialog('scenic') };
    this.search = new SearchDialog(this.dialogs.search, actions, () => this.close('search'), (p) => this.toggle(p));
    this.settingsDialog = new SettingsDialog(this.dialogs.settings, settings, () => this.syncSettings(true), this.music);
    this.music.onChange = () => {
      this.tools.get('music')?.classList.toggle('on', this.music.on && !!this.music.track);
      this.settingsDialog.syncMusic();
    };
    this.scenicDialog = new ScenicDialog(this.dialogs.scenic, SCENIC_SPOTS, (id) => actions.scenic(id));
    this.dialogs.help.innerHTML = HELP_HTML;
    for (const [name, d] of Object.entries(this.dialogs)) {
      d.querySelector('[data-close]')?.addEventListener('click', () => this.close(name as PanelName));
    }

    this.setSelected(null);
    this.syncSettings(false);
  }

  /** Show a short message, bottom-centre. */
  toast(msg: string): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 2600);
  }

  isOpen(name: PanelName): boolean {
    return this.root.classList.contains(`open-${name}`);
  }

  toggle(name: PanelName): void {
    if (this.isOpen(name)) this.close(name);
    else this.open(name);
  }

  open(name: PanelName): void {
    // Centre dialogs replace one another; the browser strip is independent.
    if (name !== 'browser') for (const other of Object.keys(this.dialogs)) this.close(other as PanelName);
    this.root.classList.add(`open-${name}`);
    this.tools.get(name)?.classList.add('on');
    if (name === 'search') this.search.opened();
    if (name === 'settings') this.settingsDialog.sync();
    if (name === 'scenic') this.scenicDialog.opened();
    this.boxesAt = -1e9;
  }

  close(name: PanelName): void {
    this.root.classList.remove(`open-${name}`);
    this.tools.get(name)?.classList.remove('on');
    if (name === 'search') this.search.closed();
    this.boxesAt = -1e9;
  }

  /** Esc: close the topmost dialog. False when there was nothing to close. */
  closeTop(): boolean {
    if (!this.ctxMenu.classList.contains('hidden')) { this.closeContext(); return true; }
    for (const name of ['search', 'scenic', 'help', 'settings', 'browser'] as PanelName[]) {
      if (this.isOpen(name)) { this.close(name); return true; }
    }
    return false;
  }

  /** Flip a boolean setting from the toolbar or a hotkey. */
  flip(key: 'labels' | 'orbits'): void {
    this.settings[key] = !this.settings[key];
    this.syncSettings(true);
    this.toast(`${key === 'labels' ? 'Labels' : 'Orbits'} ${this.settings[key] ? 'on' : 'off'}`);
  }

  /** Reflect the shared settings object in the toolbar and dialog. */
  syncSettings(notify: boolean): void {
    this.tools.get('labels')!.classList.toggle('on', this.settings.labels);
    this.tools.get('orbits')!.classList.toggle('on', this.settings.orbits);
    this.settingsDialog.sync();
    if (notify) this.actions.settingsChanged();
  }

  setSystem(system: SystemData | null): void {
    this.browser.setSystem(system);
    this.browser.setSelected(this.selected);
  }

  setSelected(t: Target | null): void {
    this.selected = t;
    this.boxesAt = -1e9;
    this.browser.setSelected(t);
    this.infoDist.textContent = '';
    this.renderInfo();
  }

  /** I: switch the object panel between the short summary and the full property list. */
  toggleInfo(): void {
    this.infoFull = !this.infoFull;
    this.tools.get('info')?.classList.toggle('on', this.infoFull);
    this.renderInfo();
    if (!this.selected) this.toast(`Full object info ${this.infoFull ? 'on' : 'off'}`);
  }

  get infoExpanded(): boolean {
    return this.infoFull;
  }

  private renderInfo(): void {
    const t = this.selected;
    this.boxesAt = -1e9;
    this.info.classList.toggle('hidden', !t);
    this.info.classList.toggle('full', this.infoFull);
    if (!t) return;
    const rows = (this.infoFull ? properties(t) : keyFacts(t))
      .map(([k, v]) => `<span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span>`).join('');
    const btn = (attr: string, text: string, key: string) =>
      `<button ${attr} aria-label="${text} (${key})">${text}<kbd>${key}</kbd></button>`;
    this.info.innerHTML = `
      <div class="name">${escapeHtml(targetName(t))}</div>
      <div class="cls">${escapeHtml(describe(t))}</div>
      <div class="kv"><span class="k">Distance</span><span class="v" data-dist></span>${rows}</div>
      <div class="actions">
        ${btn('data-go', 'Go to', 'G')}
        ${canLand(t) ? btn('data-land', 'Land', 'Shift+G') : ''}
        <button data-more class="more${this.infoFull ? ' on' : ''}" aria-label="${this.infoFull ? 'Less' : 'More'} info (I)">${this.infoFull ? 'Less' : 'More'}<kbd>I</kbd></button>
      </div>`;
    this.info.querySelector('[data-dist]')!.appendChild(this.infoDist);
    const click = (sel: string, run: () => void) =>
      this.info.querySelector(sel)?.addEventListener('click', (e) => { run(); (e.currentTarget as HTMLElement).blur(); });
    click('[data-go]', () => this.actions.go(t));
    click('[data-land]', () => this.actions.land(t));
    click('[data-more]', () => this.toggleInfo());
  }

  /** Right-click on an object: a small menu of what can be done with it, at the cursor. */
  contextMenu(t: Target, x: number, y: number): void {
    const items: [string, string, () => void][] = [
      ['Select', 'Click', () => this.actions.select(t)],
      ['Go to', 'G', () => this.actions.go(t)],
    ];
    if (canLand(t)) items.push(['Land', 'Shift+G', () => this.actions.land(t)]);
    items.push(['Centre', 'C', () => this.actions.center(t)]);
    items.push(['Track', 'T', () => this.actions.track(t)]);
    if (t.kind === 'body') items.push(['Follow', 'Shift+F', () => this.actions.follow(t)]);
    items.push(['Info', 'I', () => { this.actions.select(t); if (!this.infoFull) this.toggleInfo(); }]);
    const m = this.ctxMenu;
    m.innerHTML = `<div class="hd">${escapeHtml(targetName(t))}</div>`;
    for (const [text, key, run] of items) {
      const b = el('button', 'item', m, `<span>${text}</span><kbd>${escapeHtml(key)}</kbd>`);
      b.addEventListener('click', () => { this.closeContext(); run(); });
    }
    m.classList.remove('hidden');
    // Keep it on screen: open up or left of the cursor near the edges.
    const w = m.offsetWidth, h = m.offsetHeight;
    const left = x + w + 8 > window.innerWidth ? x - w - 2 : x + 2;
    const top = y + h + 8 > window.innerHeight ? y - h - 2 : y + 2;
    m.style.transform = `translate(${Math.max(left, 4)}px, ${Math.max(top, 4)}px)`;
  }

  closeContext(): void {
    this.ctxMenu.classList.add('hidden');
  }

  get contextOpen(): boolean {
    return !this.ctxMenu.classList.contains('hidden');
  }

  frame(f: HudFrame, now: number): void {
    if (now - this.lastText < 100) return;
    this.lastText = now;

    // In flight with the mouse still, the toolbar and the secondary panels fade out of the way.
    const idle = (f.auto || f.speed > 0) && now - this.lastPointer > 2500 && !this.contextOpen;
    if (idle !== this.idle) {
      this.idle = idle;
      this.root.classList.toggle('idle', idle);
    }
    this.music.duck(f.auto);

    setText(this.modeEl, f.mode);
    this.modeEl.classList.toggle('auto', f.auto);
    setText(this.velEl, formatSpeed(f.speed));
    // The setting is exactly what the player set (only the wheel, +/- and an arrival change it). Near a
    // body the flight is held below it for safety: that shows separately, as the 'limited' tag.
    const capped = f.cap < f.speedSetting;
    setText(this.setEl, formatSpeed(f.speedSetting));
    setText(this.limitEl, capped ? `limited to ${formatSpeed(f.cap)}` : 'limited');
    // A change of the speed setting shows top-centre for a moment, then fades.
    if (f.speedSetting !== this.lastSetting) {
      if (this.lastSetting > 0) {
        this.speedNoteEl.textContent = formatSpeed(f.speedSetting);
        this.speedNoteEl.classList.add('show');
        clearTimeout(this.speedNoteTimer);
        this.speedNoteTimer = window.setTimeout(() => this.speedNoteEl.classList.remove('show'), 1400);
      }
      this.lastSetting = f.speedSetting;
    }
    this.limitEl.classList.toggle('show', f.limited || f.cap < f.speedSetting);
    setText(this.placeEl, f.place);
    setText(this.placeDetailEl, f.placeDetail);

    const { date, time } = formatDate(f.dateMs);
    setText(this.dateEl, time ? `${date}  ${time} UTC` : date);
    setText(this.rateEl, formatTimeRate(f.timeRate, f.paused));
    this.rateEl.classList.toggle('odd', f.paused || f.timeRate !== 1);
    if (this.paused !== f.paused) {
      this.paused = f.paused;
      this.pauseBtn.querySelector('.ic')!.innerHTML = f.paused ? ICON.play : ICON.pause;
      this.pauseBtn.querySelector('.tip')!.firstChild!.textContent = f.paused ? 'Resume' : 'Pause';
      this.pauseBtn.classList.toggle('on', f.paused);
    }

    if (f.selected) setText(this.infoDist, formatDistanceLong(f.selectedDist));
  }

  /** Screen rectangles the panels cover, so scene labels can keep out from under them. */
  occupied(now: number): Box[] {
    if (now - this.boxesAt < 400) return this.boxes;
    this.boxesAt = now;
    this.boxes = [];
    for (const e of Array.from(this.root.children)) {
      if (e === this.toastEl) continue;
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) this.boxes.push({ x0: r.left - 4, y0: r.top - 4, x1: r.right + 4, y1: r.bottom + 4 });
    }
    return this.boxes;
  }

  /** Reconcile the pooled label elements and the selection reticle with this frame's layout. */
  setLabels(layout: LabelLayout): void {
    const m = layout.marker;
    this.marker.style.display = m ? '' : 'none';
    if (m) {
      this.marker.style.width = this.marker.style.height = `${m.size.toFixed(1)}px`;
      this.marker.style.transform = `translate(${(m.x - m.size / 2).toFixed(1)}px, ${(m.y - m.size / 2).toFixed(1)}px)`;
    }

    const seen = new Set<string>();
    for (const it of layout.items) {
      seen.add(it.key);
      let e = this.labels.get(it.key);
      if (!e) {
        e = el('div', 'label', this.labelRoot);
        this.labels.set(it.key, e);
      }
      const cls = `label ${it.cls}${it.selected ? ' sel' : ''}`;
      if (e.className !== cls) e.className = cls;
      const text = it.selected ? `${escapeHtml(it.text)}<span class="d">${formatDistance(it.dist)}</span>` : escapeHtml(it.text);
      if (e.dataset.text !== text) {
        e.dataset.text = text;
        e.innerHTML = text;
      }
      e.style.opacity = it.opacity.toFixed(2);
      e.style.transform = `translate(${it.tx.toFixed(1)}px, ${(it.y - 8).toFixed(1)}px)`;
    }
    for (const [key, e] of this.labels) {
      if (!seen.has(key)) {
        e.remove();
        this.labels.delete(key);
      }
    }
  }

  /** Open the search dialog with a query already typed (tests, deep links). */
  searchFor(query: string): void {
    this.open('search');
    this.search.setQuery(query);
  }
}

function setText(e: HTMLElement, text: string): void {
  if (e.textContent !== text) e.textContent = text;
}
