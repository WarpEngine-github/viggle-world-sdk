import type { ChangeEvent, CSSProperties, ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { AutoPlacement, CollisionView, WalkPlacement } from '@viggle/scene-sdk/explorer';
import type { SunLight } from '@viggle/scene-sdk/lighting';
import type { SceneExplorerHandle } from '@viggle/scene-sdk/react';
import { SceneExplorerView } from '@viggle/scene-sdk/react';
import { isUprightFile } from '@viggle/scene-sdk/walk';

import { CanvasControls } from './CanvasControls';
import { ACTIONS, CHARACTERS, DEFAULT_LIGHT, GALLERY_SCENES, LIGHT_PRESETS } from './catalog';
import type { LibraryScene, SceneRef } from './library';
import { addScene, deleteScene, listScenes, publish } from './library';

/**
 * Edit: put a character in a scene and give it something to do, then publish
 * it to Showcase. The scenes are the gallery's rooms plus your own - sent from
 * Studio or uploaded here - which are placed by measuring their floor.
 */
export function EditPage({ initialScene }: { initialScene?: string }) {
  const view = useRef<SceneExplorerHandle>(null);
  const [library, setLibrary] = useState<LibraryScene[]>([]);
  const [selected, setSelected] = useState<SceneRef>(initialScene ? { kind: 'library', id: initialScene } : { kind: 'gallery', index: 0 });
  const [characterId, setCharacterId] = useState(GALLERY_SCENES[0]!.character);
  const [action, setAction] = useState<{ url: string; name: string } | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [loop, setLoop] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Your own scenes: which way up the file is, the measured placement, and a size on top of it.
  const [upright, setUpright] = useState(false);
  // The stored choice of the scene the page opened on.
  useEffect(() => { if (initialScene) { const s = library.find((x) => x.id === initialScene); if (s) setUpright(s.upright); } }, [library, initialScene]);
  const [measured, setMeasured] = useState<WalkPlacement | null>(null);
  const [found, setFound] = useState(true);
  const [size, setSize] = useState(1);
  // The light: a preset, then the sun moved by hand.
  const [lightId, setLightId] = useState(initialScene ? DEFAULT_LIGHT : 'scene');
  const [tune, setTune] = useState<{ azimuth: number; elevation: number; intensity: number } | null>(null);
  const [shadows, setShadows] = useState(true);
  const [collision, setCollision] = useState<CollisionView>('off');
  const [title, setTitle] = useState('');
  const uploadRef = useRef<HTMLInputElement>(null);

  const refresh = () => listScenes().then(setLibrary).catch((e: unknown) => setError(String(e)));
  useEffect(() => { void refresh(); }, []);

  const own = selected.kind === 'library' ? library.find((s) => s.id === selected.id) : void 0;
  const gallery = selected.kind === 'gallery' ? GALLERY_SCENES[selected.index]! : void 0;
  const character = CHARACTERS.find((c) => c.id === characterId)!;

  // A library scene plays from its stored bytes.
  // Kept with the id it was made for: for one render after a switch, the URL
  // still belongs to the scene before (and is already revoked).
  const [blobUrl, setBlobUrl] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => {
    if (!own) return setBlobUrl(null);
    const url = URL.createObjectURL(own.blob);
    setBlobUrl({ id: own.id, url });
    return () => URL.revokeObjectURL(url);
  }, [own]);
  const ownUrl = own && blobUrl?.id === own.id ? blobUrl.url : null;

  const placement: WalkPlacement | AutoPlacement | null = gallery
    ? gallery.placement
    : !own ? null
    : measured && size !== 1 ? { ...measured, scale: measured.scale * size }
    : { auto: true, upright };
  const scene = useMemo(() => {
    if (gallery) return { url: gallery.url, placement: gallery.placement };
    if (own && ownUrl && placement) return { url: ownUrl, filename: own.filename, placement };
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `placement` is rebuilt from these
  }, [gallery, own, ownUrl, upright, measured, size]);
  const base: SunLight | null = lightId === 'scene' ? gallery?.light ?? null : LIGHT_PRESETS.find((p) => p.id === lightId)?.light ?? null;
  const light: SunLight | null = base && { ...base, ...(tune ?? {}), shadows };
  const pickLight = (id: string) => { setLightId(id); setTune(null); };
  const sunNow = light && { azimuth: light.azimuth, elevation: light.elevation, intensity: light.intensity ?? 1.8 };
  const nudge = (k: 'azimuth' | 'elevation' | 'intensity', v: number) => sunNow && setTune({ ...sunNow, [k]: v });
  const sceneName = gallery?.name ?? own?.name ?? '';

  /** `entry`: the library scene itself, when the list in state may not have it yet (just uploaded). */
  const choose = (ref: SceneRef, entry?: LibraryScene) => {
    setReady(false);
    setError(null);
    setSelected(ref);
    setMeasured(null);
    setSize(1);
    setTitle('');
    // A gallery room opens on its own light; your scene on a plain one.
    pickLight(ref.kind === 'gallery' ? 'scene' : DEFAULT_LIGHT);
    if (ref.kind === 'gallery') setCharacterId(GALLERY_SCENES[ref.index]!.character);
    else setUpright((entry ?? library.find((s) => s.id === ref.id))?.upright ?? false);
  };

  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const entry = await addScene({ name: file.name.replace(/\.[^.]+$/, ''), source: 'upload', filename: file.name, upright: isUprightFile(file.name), blob: file });
    await refresh();
    choose({ kind: 'library', id: entry.id }, entry);
  };

  const remove = async (id: string) => {
    await deleteScene(id);
    if (selected.kind === 'library' && selected.id === id) choose({ kind: 'gallery', index: 0 });
    await refresh();
  };

  const play = (a: { url: string; name: string }) => {
    setAction(a);
    setPending(a.url);
    view.current?.playAction(a.url, { loop })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setPending((p) => (p === a.url ? null : p)));
  };

  const goLive = () => {
    const placed = view.current?.explorer?.getPlacement();
    if (!placed) return;
    publish({
      scene: selected,
      title: title.trim() || sceneName,
      placement: placed,
      character: { url: character.url, name: character.name },
      light,
      action: action && { ...action, loop },
    });
    location.hash = '#showcase';
  };

  return (
    <div style={{ flex: 1, display: 'flex', gap: 8, minHeight: 0 }}>
      {scene ? (
        <SceneExplorerView
          ref={view}
          style={{ flex: 1, borderRadius: 12, background: '#000' }}
          scene={scene}
          character={{ url: character.url }}
          light={light}
          showCollision={collision}
          walkerBehind="occluded"
          onReady={() => {
            setReady(true);
            setError(null);
            // Keep what the floor measured, so a size change starts from it.
            if (own && !measured) {
              setMeasured(view.current?.explorer?.getPlacement() ?? null);
              setFound(view.current?.explorer?.getPlacementSource() !== 'fallback');
            }
          }}
          onActionChange={setPlaying}
          onError={(e) => setError(e.message)}
        >
          <CanvasControls collision={collision} onCollision={setCollision} onRespawn={() => view.current?.respawn()} disabled={!ready} />
          {!ready && !error && <div style={overlay}>{own ? 'Loading · measuring the floor…' : 'Loading…'}</div>}
          {error && <div style={{ ...overlay, color: '#ff8a8a' }}>{error}</div>}
        </SceneExplorerView>
      ) : (
        <div style={{ ...overlay, position: 'relative', flex: 1, borderRadius: 12, background: '#000' }}>Loading…</div>
      )}

      <aside style={panel}>
        <Section title="Scene">
          {GALLERY_SCENES.map((s, i) => (
            <Chip key={s.url} on={selected.kind === 'gallery' && selected.index === i} onClick={() => choose({ kind: 'gallery', index: i })}>{s.name}</Chip>
          ))}
        </Section>

        <Section title="My scenes" aside={<Chip onClick={() => uploadRef.current?.click()}>↑ Upload</Chip>}>
          <input ref={uploadRef} type="file" accept=".spz,.ply,.sog,.splat" hidden onChange={(e) => void upload(e)} />
          {library.length === 0 && <p style={hint}>Send a scene here from Studio, or upload a .spz / .ply / .sog file.</p>}
          {library.map((s) => (
            <span key={s.id} style={{ display: 'inline-flex', alignItems: 'center' }}>
              <Chip on={selected.kind === 'library' && selected.id === s.id} onClick={() => choose({ kind: 'library', id: s.id })}>
                {s.source === 'studio' ? '✦ ' : ''}{s.name}
              </Chip>
              <button type="button" aria-label={`Delete ${s.name}`} onClick={() => void remove(s.id)} style={xButton}>×</button>
            </span>
          ))}
          {own && (
            <div style={{ display: 'grid', gap: 8, width: '100%', marginTop: 4 }}>
              <label style={row}>
                Size <input type="range" min={0.4} max={2.5} step={0.05} value={size} disabled={!measured} onChange={(e) => setSize(Number(e.target.value))} style={{ flex: 1 }} />
                <span style={{ width: 40, textAlign: 'right' }}>{size.toFixed(2)}×</span>
              </label>
              <label style={row}><input type="checkbox" checked={upright} onChange={(e) => { setUpright(e.target.checked); setMeasured(null); setSize(1); setReady(false); }} /> Upright file (+Y up)</label>
              {measured && (
                <p style={hint}>
                  {found
                    ? `Floor measured: ${measured.scale.toFixed(2)} m per unit.`
                    : `No floor found under the start: using a typical ${measured.scale.toFixed(0)} m per unit. Adjust Size, or try the other way up.`}
                </p>
              )}
            </div>
          )}
        </Section>

        <Section title="Light">
          {LIGHT_PRESETS.filter((p) => p.id !== 'scene' || gallery).map((p) => (
            <Chip key={p.id} on={p.id === lightId} onClick={() => pickLight(p.id)}>{p.name}</Chip>
          ))}
          {sunNow && (
            <div style={{ display: 'grid', gap: 6, width: '100%', marginTop: 4 }}>
              <Slider label="Direction" min={0} max={359} step={1} value={((sunNow.azimuth % 360) + 360) % 360} unit="°" onChange={(v) => nudge('azimuth', v)} />
              <Slider label="Height" min={3} max={89} step={1} value={sunNow.elevation} unit="°" onChange={(v) => nudge('elevation', v)} />
              <Slider label="Strength" min={0} max={3} step={0.05} value={sunNow.intensity} onChange={(v) => nudge('intensity', v)} />
              <label style={row}><input type="checkbox" checked={shadows} onChange={(e) => setShadows(e.target.checked)} /> Shadows</label>
            </div>
          )}
        </Section>

        <Section title="Collision">
          {COLLISION_VIEWS.map((v) => (
            <Chip key={v.id} on={collision === v.id} onClick={() => setCollision(v.id)}>{v.name}</Chip>
          ))}
          {collision !== 'off' && <p style={hint}>{COLLISION_VIEWS.find((v) => v.id === collision)?.hint} Not published.</p>}
        </Section>

        <Section title="Character">
          {CHARACTERS.map((c) => <Chip key={c.id} on={c.id === characterId} onClick={() => setCharacterId(c.id)}>{c.name}</Chip>)}
        </Section>

        <Section title="Action">
          {ACTIONS.map((a) => (
            <Chip key={a.url} on={playing === a.url} busy={pending === a.url} disabled={!ready} onClick={() => play(a)}>{a.name}</Chip>
          ))}
          <div style={{ ...row, width: '100%', marginTop: 4 }}>
            <label style={row}><input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> Loop</label>
            <Chip disabled={!playing} onClick={() => { setAction(null); void view.current?.playAction(null); }}>Stop</Chip>
          </div>
        </Section>

        <section style={{ marginTop: 'auto', display: 'grid', gap: 8, paddingTop: 12, borderTop: '1px solid #eee' }}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={sceneName || 'Title'} style={field} aria-label="Title" />
          <p style={hint}>
            {character.name} in {sceneName || '…'}{action ? `, ${action.name.toLowerCase()}${loop ? ' on a loop' : ' once'}` : ''}.
          </p>
          <button type="button" disabled={!ready} onClick={goLive} style={{ ...publishButton, opacity: ready ? 1 : 0.5 }}>Publish to Showcase →</button>
        </section>
      </aside>
    </div>
  );
}

const COLLISION_VIEWS: Array<{ id: CollisionView; name: string; hint: string }> = [
  { id: 'off', name: 'Off', hint: '' },
  { id: 'outline', name: 'Outline', hint: 'The edge of where the walker can go: walls, holes and ledges. The ring at the feet turns red where a wall stops the body.' },
  { id: 'cells', name: 'Voxels', hint: 'Every cell of the collider: the detail behind the outline.' },
  { id: 'floor', name: 'Floor', hint: 'Only the cells the walker can stand on.' },
  { id: 'surface', name: 'Surface', hint: 'The solid surface a game engine would collide with.' },
];

function Slider({ label, min, max, step, value, unit = '', onChange }: { label: string; min: number; max: number; step: number; value: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <label style={row}>
      <span style={{ width: 62 }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ flex: 1 }} />
      <span style={{ width: 36, textAlign: 'right' }}>{step < 1 ? value.toFixed(2) : Math.round(value)}{unit}</span>
    </label>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <h3 style={{ margin: '0 0 6px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, fontWeight: 600, color: '#666', textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {title}{aside}
      </h3>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{children}</div>
    </section>
  );
}

export function Chip({ on, busy, disabled, onClick, children }: { on?: boolean; busy?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={on}
      onClick={onClick}
      style={{
        padding: '6px 10px', borderRadius: 8, border: '1px solid #d4d4dc', font: '13px system-ui', cursor: disabled ? 'default' : 'pointer', textTransform: 'none', letterSpacing: 0,
        background: on ? '#1d1a2e' : '#fff', color: on ? '#fff' : '#222', opacity: disabled ? 0.45 : busy ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}

const overlay: CSSProperties = { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#fff', font: '14px system-ui', pointerEvents: 'none' };
const panel: CSSProperties = { width: 280, flex: '0 0 280px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16, padding: 12, borderRadius: 12, background: '#fff', font: '13px system-ui' };
const hint: CSSProperties = { margin: 0, color: '#888', fontSize: 12, lineHeight: 1.5 };
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 };
const xButton: CSSProperties = { border: 'none', background: 'none', color: '#aaa', cursor: 'pointer', padding: '0 4px', fontSize: 15 };
const field: CSSProperties = { padding: '8px 10px', borderRadius: 8, border: '1px solid #d4d4dc', font: '13px system-ui' };
const publishButton: CSSProperties = { padding: '10px 12px', borderRadius: 10, border: 'none', background: '#7c5cff', color: '#fff', font: '600 13px system-ui', cursor: 'pointer' };
