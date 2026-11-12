/**
 * Background music from a file the player supplies: picked in Settings or dropped on the
 * window, kept in IndexedDB across reloads. Without one, the soundtrack the project ships at
 * public/music/soundtrack.mp3 is used. Nothing plays until the first click or key press, as
 * browsers require; playback loops and fades in and out.
 */

const DEFAULT_URL = `${import.meta.env.BASE_URL}music/soundtrack.mp3`;
const PREFS_KEY = 'se.music';
const DB_NAME = 'space-engine';
const STORE = 'music';
/** Session storage key: playback position across reloads. */
const POS_KEY = 'se.music.pos';
const TRACK_KEY = 'track';
const FADE_S = 1.2;
/** Gain while the autopilot jumps, relative to the volume setting. */
const DUCK = 0.55;

interface StoredTrack { name: string; blob: Blob }

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbRequest<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export class MusicPlayer {
  /** User preference: play when a track is available. */
  on = true;
  /** 0..1 */
  volume = 0.5;
  /** Name of the current track, or null when there is none. */
  track: string | null = null;
  /** 'file' for a picked or dropped file, 'default' for public/music/soundtrack.mp3. */
  source: 'file' | 'default' | null = null;
  /** Called whenever the state above changes (Settings re-renders from it). */
  onChange: () => void = () => {};

  private readonly audio = new Audio();
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private url: string | null = null;
  private unlocked = false;
  private autoplayRefused = false;
  /** Where the track was when the page was last left (s). */
  private resumeAt = 0;
  private ducked = false;
  private pauseTimer = 0;

  constructor(private readonly notify: (msg: string) => void) {
    this.audio.loop = true;
    this.audio.preload = 'auto';
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as { on?: boolean; volume?: number };
      if (typeof p.on === 'boolean') this.on = p.on;
      if (typeof p.volume === 'number') this.volume = Math.min(Math.max(p.volume, 0), 1);
    } catch { /* no saved preferences */ }

    const unlock = () => {
      this.unlocked = true;
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
      this.update();
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    // A reload (a code change during development, or F5) starts again where the track was.
    try { this.resumeAt = Number(sessionStorage.getItem(POS_KEY) ?? 0) || 0; } catch { /* no session storage */ }
    window.addEventListener('pagehide', () => {
      try { sessionStorage.setItem(POS_KEY, String(this.audio.currentTime || 0)); } catch { /* not remembered */ }
    });

    // Drop an audio file anywhere on the window to use it as the soundtrack.
    window.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
      const f = e.dataTransfer?.files[0];
      if (!f) return;
      e.preventDefault();
      if (!f.type.startsWith('audio/')) { this.notify('Drop an audio file to use it as music'); return; }
      void this.setFile(f);
    });

    void this.load();
  }

  get playing(): boolean {
    return !this.audio.paused;
  }

  /** M: music on or off. */
  toggle(): void {
    this.on = !this.on;
    this.save();
    if (!this.track) this.notify(this.on ? 'Music on (no track: choose one in Settings, F4)' : 'Music off');
    else this.notify(`Music ${this.on ? 'on' : 'off'}`);
    this.update();
  }

  setVolume(v: number): void {
    this.volume = Math.min(Math.max(v, 0), 1);
    this.save();
    this.ramp(0.15);
  }

  /** Lower the music a little while the autopilot jumps. */
  duck(on: boolean): void {
    if (on === this.ducked) return;
    this.ducked = on;
    this.ramp(0.8);
  }

  async setFile(file: File): Promise<void> {
    try {
      await dbRequest('readwrite', (s) => s.put({ name: file.name, blob: file } satisfies StoredTrack, TRACK_KEY));
    } catch { /* storage blocked: plays this session only */ }
    this.use(file, file.name, 'file');
    this.on = true;
    this.save();
    this.notify(`Music: ${file.name}`);
    this.update();
  }

  /** Forget the picked file; falls back to the project soundtrack if there is one. */
  async clearFile(): Promise<void> {
    try { await dbRequest('readwrite', (s) => s.delete(TRACK_KEY)); } catch { /* nothing stored */ }
    this.stopNow();
    this.use(null, null, null);
    await this.loadDefault();
    this.update();
  }

  private async load(): Promise<void> {
    try {
      const t = await dbRequest<StoredTrack | undefined>('readonly', (s) => s.get(TRACK_KEY));
      if (t?.blob) { this.use(t.blob, t.name, 'file'); this.update(); return; }
    } catch { /* no IndexedDB */ }
    await this.loadDefault();
    this.update();
  }

  private async loadDefault(): Promise<void> {
    try {
      // The dev server answers a missing file with index.html, so check what came back.
      const r = await fetch(DEFAULT_URL, { method: 'HEAD' });
      if (r.ok && (r.headers.get('content-type') ?? '').startsWith('audio/')) {
        this.use(DEFAULT_URL, 'soundtrack.mp3', 'default');
      }
    } catch { /* offline or absent */ }
  }

  private use(src: Blob | string | null, name: string | null, source: MusicPlayer['source']): void {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = src instanceof Blob ? URL.createObjectURL(src) : null;
    const wasPlaying = this.playing;
    if (wasPlaying) this.audio.pause();
    this.audio.src = src instanceof Blob ? this.url! : src ?? '';
    if (!src) this.audio.removeAttribute('src');
    this.track = name;
    this.source = source;
    this.onChange();
  }

  /** Start or stop to match the preference, the track and the autoplay unlock. */
  private update(): void {
    this.onChange();
    // Before any click or key, try anyway: browsers allow it on a page the player has used before. If
    // that's refused, say how to start it and wait for the first click or key.
    const want = this.on && !!this.track && (this.unlocked || !this.autoplayRefused);
    if (want) this.start();
    else this.fadeOut();
  }

  private start(): void {
    clearTimeout(this.pauseTimer);
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
        this.gain = this.ctx.createGain();
        this.gain.gain.value = 0;
        this.ctx.createMediaElementSource(this.audio).connect(this.gain).connect(this.ctx.destination);
      } catch {
        this.ctx = null;
        this.gain = null;
      }
    }
    void this.ctx?.resume();
    if (this.audio.paused) {
      if (this.resumeAt > 0 && this.audio.currentTime === 0) {
        try { this.audio.currentTime = this.resumeAt; } catch { /* not seekable yet */ }
        this.resumeAt = 0;
      }
      this.audio.play().then(() => {
        // (Playing into an audio context the browser keeps suspended is still silence.)
        if (!this.ctx || this.ctx.state === 'running') this.unlocked = true;
        else if (!this.unlocked && !this.autoplayRefused) {
          this.autoplayRefused = true;
          this.notify('Click or press any key to start the music (M turns it off)');
        }
        this.onChange();
      }, (e: unknown) => {
        if (!this.unlocked && e instanceof DOMException && e.name === 'NotAllowedError') {
          this.autoplayRefused = true;
          this.notify('Click or press any key to start the music (M turns it off)');
        } else {
          this.notify('Could not play the music file');
        }
      });
    }
    this.ramp(FADE_S);
  }

  private fadeOut(): void {
    if (this.audio.paused) return;
    this.ramp(FADE_S, 0);
    clearTimeout(this.pauseTimer);
    this.pauseTimer = window.setTimeout(() => { this.audio.pause(); this.onChange(); }, FADE_S * 1000 + 50);
  }

  private stopNow(): void {
    clearTimeout(this.pauseTimer);
    this.audio.pause();
  }

  private ramp(seconds: number, to = this.volume * (this.ducked ? DUCK : 1)): void {
    if (this.gain && this.ctx) {
      const g = this.gain.gain;
      const now = this.ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(to, now + seconds);
    } else {
      // No Web Audio: jump straight to the level.
      this.audio.volume = to;
    }
  }

  private save(): void {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ on: this.on, volume: this.volume })); } catch { /* not remembered */ }
  }
}
