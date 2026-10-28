import type { ChangeEvent, CSSProperties, FormEvent, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

import { withoutBatch } from '../core/client.js';
import { SceneApiError } from '../core/errors.js';
import type { CreateSceneInput, SceneVersion, ViggleScene } from '../core/types.js';
import { useSceneExpand, useSceneGeneration, useSceneRebuild } from './hooks.js';
import type { SceneViewerHandle } from './SceneViewer.js';
import { SceneViewer } from './SceneViewer.js';

export interface SceneStudioLabels {
  placeholder: string;
  generate: string;
  panorama: string;
  generating: string;
  expand: string;
  expanding: string;
  expandHint: string;
  rebuilding: string;
  remove: string;
  removeHint: string;
  loadingScene: string;
  latest: string;
  base: string;
  /** @deprecated Unused since the versions became a list. */
  previous: string;
  /** @deprecated Unused since the versions became a list. */
  next: string;
  busySession: string;
  references: string;
  referencesHint: string;
  removeReference: string;
}

const DEFAULT_LABELS: SceneStudioLabels = {
  placeholder: 'Describe a place - "a sunlit open-plan office"',
  generate: 'Generate',
  panorama: 'Panorama',
  generating: 'Generating scene',
  expand: 'Fill view',
  expanding: 'Filling',
  expandHint: 'Fill in the scene where you are standing and looking',
  rebuilding: 'Rebuilding',
  remove: 'Remove',
  removeHint: 'Rebuild the scene without the view this step added',
  loadingScene: 'Loading scene',
  latest: 'now',
  base: 'Base',
  previous: 'Previous version',
  next: 'Next version',
  busySession: 'This scene is still working on another task.',
  references: 'Images',
  referencesHint: 'Reference images sent with the prompt (up to 8)',
  removeReference: 'Remove image',
};

/** The API takes at most this many reference images with a prompt. */
const MAX_REFERENCES = 8;

/** The parts of `<SceneStudio>`. Each carries `data-viggle-part="<name>"` too, for plain CSS. */
export type SceneStudioPart =
  | 'root' | 'versions' | 'versionButton' | 'versionLabel' | 'expand' | 'cost'
  | 'status' | 'error' | 'promptBar' | 'input' | 'panoramaButton' | 'generateButton'
  | 'referencesButton' | 'references' | 'referenceThumb' | 'referenceRemove';

export type SceneStudioClassNames = Partial<Record<SceneStudioPart, string>>;

export interface SceneStudioToolbarContext {
  scene: ViggleScene;
  /** The version on screen (the timeline's selection). */
  version: SceneVersion;
  versionIndex: number;
  /** A generate, fill or rebuild is running. */
  busy: boolean;
}

export interface SceneStudioProps {
  /** Controlled: the scene to show. Pair with `onSceneChange`. */
  scene?: ViggleScene | null;
  /** Uncontrolled: the scene to start with (one you stored from `onSceneChange`). */
  defaultScene?: ViggleScene | null;
  /** Called when a generate, expand or rebuild produces a new scene state. Store it to reopen later. */
  onSceneChange?: (scene: ViggleScene) => void;
  /** Called when a task fails. */
  onError?: (error: Error) => void;
  /** Extra fields sent with every prompt generation (quality, reference images). */
  generateInput?: Omit<CreateSceneInput, 'prompt' | 'panorama'>;
  /** Hide the prompt bar (a host that generates through the hooks itself). */
  hidePrompt?: boolean;
  /** Hide the Panorama button. */
  hidePanorama?: boolean;
  /** Hide the Images button (reference images picked by the user). */
  hideReferences?: boolean;
  /**
   * Your own controls top-right, beside Fill view - export, "use this
   * scene", share. Called with the scene and the version on screen.
   */
  toolbar?: (ctx: SceneStudioToolbarContext) => ReactNode;
  /** Prices shown on the buttons, if any. The API decides the real charge. */
  expandCredits?: number;
  generateCredits?: number;
  labels?: Partial<SceneStudioLabels>;
  /** A class per part, for Tailwind / CSS modules. */
  classNames?: SceneStudioClassNames;
  /** Drop the built-in look (keeps only what positions the overlays). Style it through `classNames` or `[data-viggle-part]`. */
  unstyled?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * The whole flow in one box: a floating composer bottom-centre (a prompt,
 * reference images, or a panorama file) to generate a scene; the scene in a
 * free-fly view; Fill view top-right to fill in where the camera stands; and
 * the scene's steps as a timeline down the left - with Remove on a fill step
 * to rebuild the scene without it.
 *
 * THEMING, from least to most work: the CSS variables below on any ancestor;
 * `classNames` per part; `unstyled` and your own CSS. Or skip this component -
 * it is built only from the public pieces (`useSceneGeneration`,
 * `useSceneExpand`, `useSceneRebuild`, `<SceneViewer>`).
 *
 *   --viggle-scene-bg       canvas background      #0c0b14
 *   --viggle-scene-surface  overlay background     rgba(16, 14, 28, 0.66)
 *   --viggle-scene-text     overlay text           #f4f2ff
 *   --viggle-scene-border   overlay border         rgba(255, 255, 255, 0.10)
 *   --viggle-scene-accent   Fill view, Generate    #7c5cff
 *   --viggle-scene-danger   error, Remove          rgba(150, 32, 48, 0.88)
 *   --viggle-scene-radius   corner radius          14px
 *   --viggle-scene-font     overlay font           500 13px/1.25 system-ui, sans-serif
 */
export function SceneStudio({
  scene: controlled, defaultScene, onSceneChange, onError, generateInput, hidePrompt, hidePanorama, hideReferences, toolbar,
  expandCredits, generateCredits, labels: labelOverrides, classNames, unstyled, className, style,
}: SceneStudioProps) {
  const labels = { ...DEFAULT_LABELS, ...labelOverrides };
  const viewerRef = useRef<SceneViewerHandle>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const refsInputRef = useRef<HTMLInputElement>(null);
  const [prompt, setPrompt] = useState('');
  const references = useReferenceImages();
  const [sceneLoading, setSceneLoading] = useState(false);
  const [inner, setInner] = useState<ViggleScene | null>(defaultScene ?? null);
  const [shownIndex, setShownIndex] = useState<number | null>(null);
  const scene = controlled !== undefined ? controlled : inner;

  const commit = (next: ViggleScene) => {
    setInner(next);
    onSceneChange?.(next);
  };
  const gen = useSceneGeneration({
    onGenerated: (next) => {
      // The images belonged to that prompt: the next one starts clean.
      references.clear();
      commit(next);
    },
  });
  const expand = useSceneExpand(scene, { onExpanded: commit });
  const rebuild = useSceneRebuild(scene, { onRebuilt: commit });

  const error = gen.error ?? expand.error ?? rebuild.error;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  useEffect(() => { if (error) onErrorRef.current?.(error); }, [error]);

  // A new version (or a new scene) puts the view back on the newest.
  const count = scene?.versions.length ?? 0;
  useEffect(() => { setShownIndex(null); }, [scene?.sessionId, count]);

  const busy = gen.busy || expand.busy || rebuild.busy;
  const running = gen.busy ? gen : expand.busy ? expand : rebuild.busy ? rebuild : null;
  const elapsed = useElapsed(running?.startedAt ?? null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = prompt.trim();
    if (!text || busy) return;
    const picked = references.items.map((r) => r.file);
    const referenceImages = [...(generateInput?.referenceImages ?? []), ...picked];
    void gen.generate({ ...generateInput, prompt: text, ...(referenceImages.length && { referenceImages }) });
  };
  const pickReferences = (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    references.add(files, MAX_REFERENCES - (generateInput?.referenceImages?.length ?? 0));
  };
  const roomForReferences = references.items.length + (generateInput?.referenceImages?.length ?? 0) < MAX_REFERENCES;
  const pickPanorama = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file && !busy) void gen.generateFromPanorama({ panorama: file });
  };
  const doExpand = () => {
    const v = viewerRef.current;
    const pose = v?.getPose();
    if (v && pose) void expand.expand(pose, { fov: v.fov });
  };

  const head = count - 1;
  const showing = shownIndex ?? head;
  const current = scene?.versions[head];

  /** Show version `i`; an expand step from where it was aimed. */
  const show = (i: number) => {
    if (!scene) return;
    setShownIndex(i === head ? null : i);
    const pose = scene.versions[i]!.pose;
    if (pose) viewerRef.current?.setPose(pose);
  };
  /** The batch an expand step added, while the current version still has it: the step can be removed. */
  const removableBatch = (i: number): string | undefined => {
    const v = scene?.versions[i];
    if (!v || i === 0 || v.operation !== 'generate') return void 0;
    const added = v.batchIds[v.batchIds.length - 1];
    return added && current?.batchIds.includes(added) ? added : void 0;
  };

  const errorText = error instanceof SceneApiError && error.status === 409 ? labels.busySession : error?.message;
  const statusText = gen.busy ? labels.generating : expand.busy ? labels.expanding : rebuild.busy ? labels.rebuilding : null;
  const expandDisabled = busy || sceneLoading || showing !== head;

  /** Props for one part: its class, its data attribute, and the built-in style unless `unstyled`. */
  const part = (name: SceneStudioPart, look: CSSProperties, layout: CSSProperties = {}, extra?: CSSProperties | null) => ({
    className: classNames?.[name],
    'data-viggle-part': name,
    style: unstyled ? layout : { ...look, ...layout, ...extra },
  });

  const root = part('root', css.root, css.rootLayout);
  return (
    <div {...root} className={join(root.className, className)} style={{ ...root.style, ...style }}>
      {!unstyled && <style>{SPIN_KEYFRAMES}</style>}
      <SceneViewer
        ref={viewerRef}
        scene={scene}
        versionIndex={showing === head ? null : showing}
        onLoadingChange={setSceneLoading}
        style={layout.viewer}
      >
        {/* The scene's history, a timeline down the left edge: one row per step, newest at the bottom. */}
        {count > 1 && (
          <ol {...part('versions', css.versions, layout.versions)} aria-label="Versions">
            {scene!.versions.map((v, i) => {
              const on = i === showing;
              const batch = removableBatch(i);
              return (
                <li key={v.taskId} style={layout.versionRow}>
                  <button
                    type="button"
                    {...part('versionButton', css.step, layout.step, on ? css.stepOn : null)}
                    data-active={on || void 0}
                    aria-current={on || void 0}
                    title={v.operation}
                    onClick={() => show(i)}
                  >
                    <span style={{ ...css.dot, ...(on ? css.dotOn : null) }} aria-hidden />
                    <span {...part('versionLabel', {})}>
                      {i === 0 ? labels.base : `${opLabel(v.operation)} ${i}`}
                      {i === head && <span style={css.now}> · {labels.latest}</span>}
                    </span>
                  </button>
                  {batch && on && (
                    <button
                      type="button"
                      {...part('versionButton', css.remove, {}, busy ? css.disabled : null)}
                      data-action="remove"
                      disabled={busy}
                      title={labels.removeHint}
                      onClick={() => void rebuild.rebuild(withoutBatch(scene!, batch))}
                    >
                      {labels.remove}
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        {scene && (
          <div style={layout.actions}>
          {toolbar && scene.versions[showing] && toolbar({ scene, version: scene.versions[showing]!, versionIndex: showing, busy })}
          <button
            type="button"
            {...part('expand', css.expand, layout.expand, expandDisabled ? css.disabled : null)}
            data-busy={expand.busy || void 0}
            disabled={expandDisabled}
            title={labels.expandHint}
            onClick={doExpand}
          >
            <span aria-hidden>⤢</span>
            <span>{expand.busy ? labels.expanding : labels.expand}</span>
            {!expand.busy && expandCredits != null && <span {...part('cost', css.cost)}>{expandCredits} cr</span>}
          </button>
          </div>
        )}

        {(statusText || sceneLoading) && (
          <div {...part('status', css.pill, layout.status)} role="status">
            <span style={css.spinner} aria-hidden />
            {statusText ? `${statusText} · ${elapsed}` : labels.loadingScene}
          </div>
        )}

        {errorText && !busy && <div {...part('error', css.error, layout.error(!hidePrompt))} role="alert">{errorText}</div>}

        {/* A floating composer, bottom centre: picked images over it, the tools inside it. */}
        {!hidePrompt && (
          <div style={layout.dock}>
            {references.items.length > 0 && (
              <div {...part('references', {}, layout.references)}>
                {references.items.map((r) => (
                  <div key={r.url} {...part('referenceThumb', css.thumb, layout.thumb)} title={r.file.name}>
                    <img src={r.url} alt={r.file.name} style={layout.thumbImage} />
                    {!busy && (
                      <button
                        type="button"
                        {...part('referenceRemove', css.thumbRemove, layout.thumbRemove)}
                        aria-label={`${labels.removeReference}: ${r.file.name}`}
                        onClick={() => references.remove(r.url)}
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            <form onSubmit={submit} {...part('promptBar', css.composer, layout.promptBar)}>
              {!hideReferences && (
                <>
                  <input ref={refsInputRef} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={pickReferences} />
                  <button
                    type="button"
                    {...part('referencesButton', css.tool, {}, busy || !roomForReferences ? css.disabled : null)}
                    disabled={busy || !roomForReferences}
                    title={labels.referencesHint}
                    onClick={() => refsInputRef.current?.click()}
                  >
                    ＋ {labels.references}
                    {references.items.length > 0 && <span style={css.badge}>{references.items.length}</span>}
                  </button>
                </>
              )}
              {!hidePanorama && (
                <>
                  <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={pickPanorama} />
                  <button type="button" {...part('panoramaButton', css.tool, {}, busy ? css.disabled : null)} disabled={busy} onClick={() => fileRef.current?.click()}>
                    ◎ {labels.panorama}
                  </button>
                </>
              )}
              <input
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={labels.placeholder}
                aria-label={labels.placeholder}
                {...part('input', css.input, layout.input)}
                disabled={busy}
              />
              <button
                type="submit"
                {...part('generateButton', css.generate, {}, busy || !prompt.trim() ? css.disabled : null)}
                disabled={busy || !prompt.trim()}
              >
                {gen.busy ? labels.generating : labels.generate}
                {generateCredits != null && !gen.busy && <span {...part('cost', css.cost)}>{generateCredits} cr</span>}
              </button>
            </form>
          </div>
        )}
      </SceneViewer>
    </div>
  );
}

function opLabel(op: string | undefined): string {
  return op === 'generate' ? 'Fill' : op === 'reconstruct' ? 'Rebuild' : 'Version';
}

function join(...names: Array<string | undefined>): string | undefined {
  const s = names.filter(Boolean).join(' ');
  return s || void 0;
}

/** Picked reference images, each with a preview URL that is let go when it is removed or the studio unmounts. */
function useReferenceImages() {
  const [items, setItems] = useState<Array<{ file: File; url: string }>>([]);
  const live = useRef(items);
  live.current = items;
  useEffect(() => () => live.current.forEach((r) => URL.revokeObjectURL(r.url)), []);
  return {
    items,
    /** Adds what fits under `max`; the rest is dropped. */
    add(files: File[], max: number) {
      setItems((cur) => {
        const room = Math.max(0, max - cur.length);
        return [...cur, ...files.slice(0, room).map((file) => ({ file, url: URL.createObjectURL(file) }))];
      });
    },
    remove(url: string) {
      URL.revokeObjectURL(url);
      setItems((cur) => cur.filter((r) => r.url !== url));
    },
    clear() {
      setItems((cur) => {
        cur.forEach((r) => URL.revokeObjectURL(r.url));
        return [];
      });
    },
  };
}

/** `m:ss` since `since`, ticking once a second while set. */
function useElapsed(since: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since == null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);
  const s = since == null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Where things sit. Kept under `unstyled`: without it the overlays would stack in the flow over the canvas. */
const layout = {
  viewer: { position: 'absolute', inset: 0 },
  versions: {
    position: 'absolute', top: 12, left: 12, margin: 0, padding: 6, listStyle: 'none',
    display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 'calc(100% - 120px)', overflowY: 'auto', minWidth: 132,
  },
  versionRow: { display: 'flex', alignItems: 'center', gap: 4 },
  step: { display: 'flex', alignItems: 'center', gap: 8, flex: 1, textAlign: 'left' },
  actions: { position: 'absolute', top: 12, right: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: 'calc(100% - 180px)' },
  expand: { display: 'flex', alignItems: 'center', gap: 8 },
  status: { position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 8 },
  error: (prompt: boolean): CSSProperties => ({ position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: prompt ? 132 : 16, maxWidth: 'calc(100% - 32px)' }),
  dock: {
    position: 'absolute', left: '50%', bottom: 16, transform: 'translateX(-50%)', width: 'min(760px, calc(100% - 24px))',
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  // Wraps on a narrow screen: the prompt keeps a row of its own, the tools go under it.
  promptBar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  input: { flex: '1 1 220px', minWidth: 0, order: -1 },
  references: { display: 'flex', gap: 6, overflowX: 'auto' },
  thumb: { position: 'relative', flex: '0 0 auto', width: 52, height: 52, overflow: 'hidden' },
  thumbImage: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  thumbRemove: { position: 'absolute', top: 3, right: 3, width: 18, height: 18, padding: 0, lineHeight: '16px' },
} satisfies Record<string, CSSProperties | ((p: boolean) => CSSProperties)>;

const v = (name: string, fallback: string) => `var(--viggle-scene-${name}, ${fallback})`;

const accent = v('accent', '#7c5cff');
const SPIN_KEYFRAMES = '@keyframes viggle-scene-spin { to { transform: rotate(360deg) } }';

const glass: CSSProperties = {
  background: v('surface', 'rgba(16, 14, 28, 0.66)'),
  color: v('text', '#f4f2ff'),
  border: `1px solid ${v('border', 'rgba(255, 255, 255, 0.10)')}`,
  borderRadius: v('radius', '14px'),
  backdropFilter: 'blur(14px) saturate(140%)',
  font: v('font', '500 13px/1.25 system-ui, sans-serif'),
  boxShadow: '0 6px 24px rgba(0, 0, 0, 0.28)',
};

const bare: CSSProperties = { border: 'none', background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' };

/** The built-in look. Dropped under `unstyled`. */
const css = {
  root: { minHeight: 320, background: v('bg', '#0c0b14'), borderRadius: v('radius', '14px') },
  rootLayout: { position: 'relative', width: '100%', height: '100%', overflow: 'hidden' },
  versions: { ...glass },
  step: { ...bare, padding: '6px 8px', borderRadius: 8, opacity: 0.72 },
  stepOn: { opacity: 1, background: 'rgba(124, 92, 255, 0.22)' },
  dot: { width: 8, height: 8, borderRadius: '50%', border: '1.5px solid currentColor', flex: '0 0 auto', boxSizing: 'border-box' },
  dotOn: { background: accent, border: `1.5px solid ${accent}` },
  now: { opacity: 0.6, fontWeight: 400 },
  remove: { ...bare, padding: '4px 8px', borderRadius: 6, fontSize: 12, color: v('danger', '#ff8f8f') },
  expand: { ...glass, padding: '9px 14px', cursor: 'pointer', background: accent, border: '1px solid transparent', color: '#fff', fontWeight: 600 },
  cost: { opacity: 0.8, fontSize: 11, fontWeight: 500, padding: '1px 6px', borderRadius: 999, background: 'rgba(255, 255, 255, 0.16)' },
  pill: { ...glass, padding: '7px 14px', borderRadius: 999 },
  spinner: { width: 10, height: 10, borderRadius: '50%', border: `2px solid ${accent}`, borderRightColor: 'transparent', animation: 'viggle-scene-spin 0.8s linear infinite' },
  error: { ...glass, padding: '7px 14px', background: v('danger', 'rgba(150, 32, 48, 0.88)'), color: '#fff' },
  composer: { ...glass, padding: 6, borderRadius: 18 },
  tool: { ...bare, padding: '8px 10px', borderRadius: 12, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(255, 255, 255, 0.06)' },
  badge: { minWidth: 16, padding: '0 5px', borderRadius: 999, background: accent, color: '#fff', fontSize: 11, lineHeight: '16px', textAlign: 'center' },
  input: { ...bare, cursor: 'text', padding: '8px 6px', outline: 'none' },
  generate: { ...bare, marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, padding: '9px 16px', borderRadius: 12, background: accent, color: '#fff', fontWeight: 600 },
  disabled: { opacity: 0.45, cursor: 'default' },
  thumb: { ...glass, padding: 0, borderRadius: 10 },
  thumbRemove: { border: 'none', borderRadius: '50%', background: 'rgba(0, 0, 0, 0.65)', color: '#fff', fontSize: 13, cursor: 'pointer' },
} satisfies Record<string, CSSProperties>;
