/**
 * Keyboard input primitive - wraps DOM keyboard events into a polling +
 * subscription API.
 *
 * One instance is meant to be shared across the systems that need to read
 * keys: the built-in controllers, and any code constructing presets directly.
 * Create one and pass it to whichever controller is active, rather than giving
 * each system its own listener.
 *
 * The polling surface (`isKeyDown(code)`) is the canonical "current state."
 * The event hooks (`onKeyDown(code, fn)`, `onKeyUp(code, fn)`) fire once per
 * physical edge - repeats from auto-repeat are filtered (re-pressing a key
 * that's already in the down-set won't fire `onKeyDown` a second time).
 */
/** @group Input */
export type Unsubscribe = () => void;
/** @group Input */
export type KeyEventListener = () => void;

/** @group Input */
export class Keyboard {
  private _keys = new Set<string>();
  private _downListeners = new Map<string, Set<KeyEventListener>>();
  private _upListeners = new Map<string, Set<KeyEventListener>>();
  private _target: Window | HTMLElement | null = null;

  /**
   * Attach to a DOM event target. Default `window`. Idempotent - calling
   * twice without `detach` is a no-op (the second call is ignored).
   */
  attach(target: Window | HTMLElement = window): void {
    if (this._target) return;
    this._target = target;
    target.addEventListener('keydown', this._onKeyDown as EventListener);
    target.addEventListener('keyup', this._onKeyUp as EventListener);
  }

  detach(): void {
    if (!this._target) return;
    this._target.removeEventListener('keydown', this._onKeyDown as EventListener);
    this._target.removeEventListener('keyup', this._onKeyUp as EventListener);
    this._target = null;
    this._keys.clear();
  }

  /** True for every frame `code` is held. Use `KeyboardEvent.code` values ("KeyW", "Space", ...). */
  isKeyDown(code: string): boolean {
    return this._keys.has(code);
  }

  /** Fires once per physical key-down edge (auto-repeat filtered). */
  onKeyDown(code: string, fn: KeyEventListener): Unsubscribe {
    let set = this._downListeners.get(code);
    if (!set) { set = new Set(); this._downListeners.set(code, set); }
    set.add(fn);
    return () => set!.delete(fn);
  }

  /** Fires once per key-up. */
  onKeyUp(code: string, fn: KeyEventListener): Unsubscribe {
    let set = this._upListeners.get(code);
    if (!set) { set = new Set(); this._upListeners.set(code, set); }
    set.add(fn);
    return () => set!.delete(fn);
  }

  private _onKeyDown = (e: KeyboardEvent) => {
    const wasDown = this._keys.has(e.code);
    this._keys.add(e.code);
    if (!wasDown) {
      const fns = this._downListeners.get(e.code);
      if (fns) for (const fn of fns) fn();
    }
  };
  private _onKeyUp = (e: KeyboardEvent) => {
    this._keys.delete(e.code);
    const fns = this._upListeners.get(e.code);
    if (fns) for (const fn of fns) fn();
  };
}
