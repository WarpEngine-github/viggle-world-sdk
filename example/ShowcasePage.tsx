import { useEffect, useRef, useState } from 'react';

import type { CollisionView, ExplorerProgress } from '@viggle/scene-sdk/explorer';
import type { SceneExplorerHandle } from '@viggle/scene-sdk/react';
import { SceneExplorerView } from '@viggle/scene-sdk/react';

import { CanvasControls } from './CanvasControls';
import { CHARACTERS, GALLERY_SCENES } from './catalog';
import type { Published } from './library';
import { getScene, readPublished } from './library';

/** What shows before anything is published: the gallery's attic. */
const DEFAULT: Published = {
  scene: { kind: 'gallery', index: 0 },
  title: 'The attic',
  placement: GALLERY_SCENES[0]!.placement,
  character: { url: CHARACTERS[0]!.url, name: CHARACTERS[0]!.name },
  light: GALLERY_SCENES[0]!.light,
  action: null,
  publishedAt: 0,
};

/** Showcase: what Edit published, to walk round. */
export function ShowcasePage() {
  const view = useRef<SceneExplorerHandle>(null);
  const [live] = useState(() => readPublished() ?? DEFAULT);
  const [scene, setScene] = useState<{ url: string; filename?: string } | null>(null);
  const [progress, setProgress] = useState<ExplorerProgress | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collision, setCollision] = useState<CollisionView>('off');

  // A gallery room by URL; your own from its stored bytes.
  useEffect(() => {
    const ref = live.scene;
    if (ref.kind === 'gallery') return setScene({ url: GALLERY_SCENES[ref.index]!.url });
    let url: string | null = null;
    let alive = true;
    getScene(ref.id).then((s) => {
      if (!alive) return;
      if (!s) return setError('The published scene is no longer in this browser. Publish again from Edit.');
      url = URL.createObjectURL(s.blob);
      setScene({ url, filename: s.filename });
    }, (e: unknown) => setError(String(e)));
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [live]);

  const date = live.publishedAt ? new Date(live.publishedAt).toLocaleString() : null;
  return (
    <div style={{ flex: 1, position: 'relative', borderRadius: 12, overflow: 'hidden', background: '#000' }}>
      {scene && (
        <SceneExplorerView
          ref={view}
          style={{ position: 'absolute', inset: 0 }}
          scene={{ ...scene, placement: live.placement }}
          character={{ url: live.character.url }}
          light={live.light}
          showCollision={collision}
          walkerBehind="occluded"
          onProgress={setProgress}
          onReady={() => {
            setReady(true);
            if (live.action) void view.current?.playAction(live.action.url, { loop: live.action.loop });
          }}
          onError={(e) => setError(e.message)}
        />
      )}

      {/* A title card bottom-left, the keys bottom-centre. */}
      <div style={{ position: 'absolute', left: 24, bottom: 72, maxWidth: 380, color: '#fff', textShadow: '0 2px 12px rgba(0,0,0,0.6)', pointerEvents: 'none' }}>
        <div style={{ font: '600 11px/1 system-ui', letterSpacing: 2, textTransform: 'uppercase', opacity: 0.75, marginBottom: 8 }}>
          {live.publishedAt ? 'Now showing' : 'Showcase · nothing published yet'}
        </div>
        <div style={{ font: '700 30px/1.1 Georgia, serif' }}>{live.title}</div>
        <div style={{ font: '14px/1.5 system-ui', opacity: 0.85, marginTop: 6 }}>
          {live.character.name}{live.action ? ` · ${live.action.name}` : ''}{date ? ` · published ${date}` : ''}
        </div>
      </div>
      <div style={{ position: 'absolute', left: '50%', bottom: 18, transform: 'translateX(-50%)', display: 'flex', gap: 14, alignItems: 'center', color: '#fff', font: '12px system-ui', pointerEvents: 'none', whiteSpace: 'nowrap' }}>
        <Keys keys={['W', 'A', 'S', 'D']} label="walk" />
        <Keys keys={['Shift']} label="run" />
        <Keys keys={['Space']} label="jump" />
        <Keys keys={['Drag']} label="look" />
      </div>
      <CanvasControls collision={collision} onCollision={setCollision} onRespawn={() => view.current?.respawn()} disabled={!ready} />
      <a href="#edit" style={{ position: 'absolute', top: 14, right: 14, padding: '7px 12px', borderRadius: 999, background: 'rgba(16,14,28,0.6)', color: '#fff', font: '500 12px system-ui', textDecoration: 'none', backdropFilter: 'blur(10px)' }}>
        ✎ Edit
      </a>

      {!ready && !error && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#fff', font: '14px system-ui', pointerEvents: 'none' }}>
          Loading{progress ? ` ${progress.loaded}/${progress.total}` : '…'}
        </div>
      )}
      {error && <div style={{ position: 'absolute', top: 16, left: 16, color: '#ff8a8a', font: '13px system-ui' }}>{error}</div>}
    </div>
  );
}

function Keys({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      {keys.map((k) => (
        <kbd key={k} style={{ minWidth: 22, padding: '3px 6px', borderRadius: 6, background: 'rgba(255,255,255,0.14)', border: '1px solid rgba(255,255,255,0.28)', borderBottomWidth: 2, font: '600 11px system-ui', textAlign: 'center' }}>{k}</kbd>
      ))}
      <span style={{ opacity: 0.8, marginLeft: 2 }}>{label}</span>
    </span>
  );
}
