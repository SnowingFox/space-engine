export interface KeyPress {
  code: string;
  shift: boolean;
  ctrl: boolean;
}

/** Keys the page must keep away from the browser (find bar, help, scrolling, quick find). */
const CAPTURED = new Set([
  'Space', 'Tab', 'F1', 'F2', 'F3', 'F4', 'F6', 'F10', 'Backquote', 'Slash', 'Backslash', 'Quote',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End',
]);

const isTextField = (t: EventTarget | null) =>
  t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;

/** Keyboard + pointer state, sampled once per frame by the flight model. */
export class Input {
  private readonly keys = new Set<string>();
  private readonly pressed: KeyPress[] = [];
  private lookX = 0;
  private lookY = 0;
  private orbitX = 0;
  private orbitY = 0;
  private wheel = 0;
  /** Which mouse button is dragging the scene: 0 = look, 2 = orbit, -1 = none. */
  dragButton = -1;
  /** Fired for a left press-and-release without movement. */
  onClick: (x: number, y: number, double: boolean) => void = () => {};
  /** Fired for a right press-and-release without movement. */
  onContext: (x: number, y: number) => void = () => {};
  private downX = 0;
  private downY = 0;
  private moved = 0;
  private lastClick = 0;

  constructor(el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.altKey) return;
      if (isTextField(e.target)) return;
      // Ctrl is only meaningful for Ctrl+G; leave every other browser shortcut alone.
      if (e.ctrlKey && e.code !== 'KeyG') return;
      if (!e.repeat) this.pressed.push({ code: e.code, shift: e.shiftKey, ctrl: e.ctrlKey });
      this.keys.add(e.code);
      if (CAPTURED.has(e.code) || e.ctrlKey) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.dragButton = -1;
    });

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 2) return;
      if (this.dragButton !== -1) return;
      (document.activeElement as HTMLElement | null)?.blur?.();
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic events have no live pointer */ }
      this.dragButton = e.button;
      this.downX = e.clientX;
      this.downY = e.clientY;
      this.moved = 0;
    });
    el.addEventListener('pointermove', (e) => {
      if (this.dragButton === -1) return;
      if (this.dragButton === 0) {
        this.lookX += e.movementX;
        this.lookY += e.movementY;
      } else {
        this.orbitX += e.movementX;
        this.orbitY += e.movementY;
      }
      this.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
    });
    el.addEventListener('pointerup', (e) => {
      if (e.button !== this.dragButton) return;
      this.dragButton = -1;
      // A right press-and-release without movement is a context click; with movement it orbited.
      if (e.button === 2 && this.moved < 5) this.onContext(this.downX, this.downY);
      if (e.button === 0 && this.moved < 5) {
        const now = performance.now();
        const double = now - this.lastClick < 350;
        this.lastClick = double ? 0 : now;
        this.onClick(this.downX, this.downY, double);
      }
    });
    el.addEventListener('pointercancel', () => (this.dragButton = -1));
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    // On the window, so the wheel also works with the cursor over a label; panels keep their own scrolling.
    window.addEventListener('wheel', (e) => {
      if (e.target instanceof Element && e.target.closest('.panel')) return;
      e.preventDefault();
      // Shift turns a vertical wheel into a horizontal one in most browsers.
      const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      if (delta === 0) return;
      const px = e.deltaMode === 1 ? delta * 33 : e.deltaMode === 2 ? delta * 300 : delta;
      // A mouse wheel sends whole notches (wheelDelta in multiples of 120) and each is one
      // step. Trackpads and smooth-scrolling mice send streams of arbitrary deltas plus
      // inertia; those are scaled down and capped so a hard flick is a few steps, not dozens.
      const legacy = (e as WheelEvent & { wheelDeltaY?: number; wheelDeltaX?: number });
      const raw = legacy.wheelDeltaY || legacy.wheelDeltaX || 0;
      const isNotch = e.deltaMode !== 0 || (Math.abs(px) >= 50 && raw !== 0 && raw % 120 === 0) || (raw === 0 && Math.abs(px) >= 100);
      const notches = isNotch
        ? Math.sign(px) * Math.max(1, Math.min(Math.round(Math.abs(px) / 100), 3))
        : Math.sign(px) * Math.min(Math.abs(px) / 300, 0.35);
      this.wheel -= notches * (e.shiftKey ? WHEEL_SHIFT_STEPS : 1);
    }, { passive: false });
  }

  get dragging(): boolean {
    return this.dragButton !== -1;
  }

  down(code: string): boolean {
    return this.keys.has(code);
  }

  get shift(): boolean {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  /** +1 if any of pos is held, -1 if any of neg is held. */
  axis(pos: string | string[], neg: string | string[]): number {
    const held = (c: string | string[]) => (typeof c === 'string' ? this.keys.has(c) : c.some((k) => this.keys.has(k)));
    return (held(pos) ? 1 : 0) - (held(neg) ? 1 : 0);
  }

  /** Key presses since the last call (no auto-repeat). */
  takePressed(): KeyPress[] {
    return this.pressed.splice(0);
  }

  /** Left-drag mouse motion since the last call, px. */
  takeLook(): [number, number] {
    const v: [number, number] = [this.lookX, this.lookY];
    this.lookX = this.lookY = 0;
    return v;
  }

  /** Right-drag mouse motion since the last call, px. */
  takeOrbit(): [number, number] {
    const v: [number, number] = [this.orbitX, this.orbitY];
    this.orbitX = this.orbitY = 0;
    return v;
  }

  /** Velocity steps since the last call: positive = faster (wheel up). */
  takeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  /** For tests and UI buttons: hold or release a key without a real keyboard event. */
  setKey(code: string, down: boolean): void {
    if (down) this.keys.add(code);
    else this.keys.delete(code);
  }

  /** For tests: add velocity steps as if the wheel had turned. */
  addWheel(steps: number): void {
    this.wheel += steps;
  }
}

/** One Shift+wheel notch equals this many plain notches (1.3^9 ≈ 10x). */
const WHEEL_SHIFT_STEPS = 8.776;
