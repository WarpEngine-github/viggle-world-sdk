// No playcanvas import here: the app imports this file on its own, so a
// keyboard check doesn't pull the whole engine into a page's first load.

/**
 * Default {@link FlyControlsOptions.shouldIgnoreKeystroke} implementation.
 * Returns `true` when the event's composed path contains an element that
 * is plausibly accepting text input, so the fly cam doesn't steal
 * keystrokes from the user typing in a form.
 *
 * Two design choices keep this robust as the platform evolves:
 *
 *  1. **`composedPath()`** is walked so the check pierces Shadow DOM -
 *     a `<my-text-field>` web component with an `<input>` inside its
 *     shadow root is still recognised even though `e.target` is the
 *     shadow host. Plain DOM is the trivial case of `composedPath()`.
 *  2. **Inverted allowlist for `<input>` types** - we recognise the
 *     small, stable set of NON-typing types (button, checkbox, range,
 *     etc.) and treat everything else as text-y. Future HTML input
 *     types (`datetime-local`, `month`, …) are handled correctly
 *     without a future update here.
 *
 * Exported so callers can compose it with extra checks of their own
 * (e.g. wrap it to also ignore keystrokes while a modal is open) by
 * passing a custom `shouldIgnoreKeystroke` that defers to this fn.
 *
 * @group Presets
 * @category Camera
 */
export function defaultShouldIgnoreKeystroke(e: KeyboardEvent): boolean {
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
  for (const node of path) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.isContentEditable) return true;
    const tag = node.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
      const type = ((node as HTMLInputElement).type || '').toLowerCase();
      return !_NON_TYPING_INPUT_TYPES.has(type);
    }
  }
  return false;
}

const _NON_TYPING_INPUT_TYPES = new Set([
  'button', 'submit', 'reset', 'image', 'file',
  'checkbox', 'radio', 'range', 'color', 'hidden',
]);
