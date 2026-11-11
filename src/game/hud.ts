import type { SystemData } from '../universe/bodies';
import { describe, properties } from './describe';
import { HELP_HTML, ScenicDialog, SearchDialog, SettingsDialog, SystemBrowser, type SearchSource } from './dialogs';
import { formatDate, formatDistance, formatDistanceLong, formatSpeed, formatTimeRate } from './format';
import type { Box, LabelLayout } from './labels';
import { SCENIC_SPOTS } from './scenic';
import { targetName, type Target } from './target';
import { ICON, el, escapeHtml, type IconName } from './ui';

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

  constructor(
    private readonly root: HTMLElement, private readonly labelRoot: HTMLElement,
    private readonly actions: HudActions, private readonly settings: Settings,
  ) {
    // Left edge: slim toolbar that stays out of the way until hovered.
    const bar = el('div', 'toolbar', root);
    const tool = (id: string, icon: IconName, tip: string, key: string, run: () => void) => {
      const b = el('button', 'tool', bar, `${ICON[icon]}<span class="tip">${tip}<kbd>${key}</kbd></span>`);
      b.setAttribute('aria-label', tip);
      b.addEventListener('click', () => { run(); b.blur(); });
      this.tools.set(id, b);
    };
    tool('search', 'search', 'Find object', 'F3', () => this.toggle('search'));
    tool('browser', 'system', 'Solar system browser', 'F2', () => this.toggle('browser'));
    tool('scenic', 'scenic', 'Scenic spots', 'F6', () => this.toggle('scenic'));
    tool('home', 'home', 'Go home', 'H', () => actions.home());
    tool('labels', 'labels', 'Labels', 'Shift+L', () => this.flip('labels'));
    tool('orbits', 'orbits', 'Orbits', 'O', () => this.flip('orbits'));
    tool('settings', 'settings', 'Settings', 'F4', () => this.toggle('settings'));
    tool('help', 'help', 'Controls', 'F1', () => this.toggle('help'));

    // Top-left: the selected object.
    this.info = el('div', 'panel info', root);
    this.infoDist = el('span', '', null);

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
    const timeBtn = (icon: IconName, tip: string, cmd: TimeCommand) => {
      const b = el('button', 'tbtn', buttons, ICON[icon]);
      b.title = tip;
      b.addEventListener('click', () => { actions.time(cmd); b.blur(); });
      return b;
    };
    timeBtn('reverse', 'Reverse time (J)', 'reverse');
    timeBtn('slower', '10x slower (K)', 'slower');
    this.pauseBtn = timeBtn('pause', 'Pause (Space)', 'pause');
    timeBtn('faster', '10x faster (L)', 'faster');
    timeBtn('real', 'Real time (\\)', 'real');

    this.toastEl = el('div', 'toast', root);
    this.speedNoteEl = el('div', 'speed-note', root);
    this.marker = el('div', 'marker', labelRoot, '<i></i><i></i><i></i><i></i>');

    this.browser = new SystemBrowser(el('div', 'panel browser', root), actions);
    const dialog = (name: string) => el('div', `panel dialog ${name}`, root);
    this.dialogs = { search: dialog('search'), help: dialog('help'), settings: dialog('settings'), scenic: dialog('scenic') };
    this.search = new SearchDialog(this.dialogs.search, actions, () => this.close('search'), (p) => this.toggle(p));
    this.settingsDialog = new SettingsDialog(this.dialogs.settings, settings, () => this.syncSettings(true));
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
    this.info.classList.toggle('hidden', !t);
    if (!t) return;
    const rows = properties(t).map(([k, v]) => `<span class="k">${k}</span><span class="v">${escapeHtml(v)}</span>`).join('');
    const landable = t.kind === 'body' && t.body.type !== 'gas' && t.body.type !== 'icegiant';
    this.info.innerHTML = `
      <div class="name">${escapeHtml(targetName(t))}</div>
      <div class="cls">${escapeHtml(describe(t))}</div>
      <div class="kv"><span class="k">Distance</span><span class="v" data-dist></span>${rows}</div>
      <div class="actions">
        <button data-go>Go to<kbd>G</kbd></button>
        ${landable ? '<button data-land>Land<kbd>Shift+G</kbd></button>' : ''}
      </div>`;
    this.info.querySelector('[data-dist]')!.appendChild(this.infoDist);
    this.infoDist.textContent = '';
    this.info.querySelector('[data-go]')!.addEventListener('click', (e) => { this.actions.go(t); (e.currentTarget as HTMLElement).blur(); });
    this.info.querySelector('[data-land]')?.addEventListener('click', (e) => { this.actions.land(t); (e.currentTarget as HTMLElement).blur(); });
  }

  frame(f: HudFrame, now: number): void {
    if (now - this.lastText < 100) return;
    this.lastText = now;

    setText(this.modeEl, f.mode);
    this.modeEl.classList.toggle('auto', f.auto);
    setText(this.velEl, formatSpeed(f.speed));
    // Near a body the setting is capped: show what thrust will actually do here, and the setting on hover.
    const capped = f.cap < f.speedSetting;
    const effective = formatSpeed(capped ? f.cap : f.speedSetting);
    setText(this.setEl, effective);
    this.setEl.title = capped ? `Setting ${formatSpeed(f.speedSetting)}, limited near bodies` : '';
    // A change of the speed setting shows top-centre for a moment, then fades.
    if (f.speedSetting !== this.lastSetting) {
      if (this.lastSetting > 0) {
        this.speedNoteEl.textContent = capped ? `${effective}  (setting ${formatSpeed(f.speedSetting)}, limited here)` : effective;
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
      this.pauseBtn.innerHTML = f.paused ? ICON.play : ICON.pause;
      this.pauseBtn.title = f.paused ? 'Resume (Space)' : 'Pause (Space)';
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
