import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import type { ViggleScene } from '@viggle/scene-sdk';
import type { SceneStudioToolbarContext } from '@viggle/scene-sdk/react';
import { SceneStudio, ViggleSceneProvider, useViggleSceneClient } from '@viggle/scene-sdk/react';
import { isUprightFile } from '@viggle/scene-sdk/walk';

import { EditPage } from './EditPage';
import { addScene, saveFile } from './library';
import { createMockFetch } from './mockApi';
import { ShowcasePage } from './ShowcasePage';

/** Set by vite.config.ts: true when the dev proxy holds an API key. The key itself never reaches the page. */
declare const __VIGGLE_LIVE__: boolean;

const STORE = 'viggle-scene-sdk-example:scene';

function loadScene(): ViggleScene | undefined {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? (JSON.parse(raw) as ViggleScene) : void 0;
  } catch {
    return void 0;
  }
}

function saveScene(scene: ViggleScene) {
  try {
    localStorage.setItem(STORE, JSON.stringify(scene));
  } catch {
    // A private window: the scene just is not remembered.
  }
}

/**
 * `#edit` (or `#edit:<library id>`, to open on one scene) and `#showcase` show
 * those pages; anything else the studio. `#walk` is the showcase's old name.
 */
type Route = { page: 'studio' | 'showcase' } | { page: 'edit'; scene?: string };

function useHashPage(): Route {
  const read = (): Route => {
    const h = location.hash;
    if (h.startsWith('#edit')) return { page: 'edit', scene: h.split(':')[1] || void 0 };
    if (h === '#showcase' || h === '#walk') return { page: 'showcase' };
    return { page: 'studio' };
  };
  const [page, setPage] = useState(read);
  useEffect(() => {
    const update = () => setPage(read());
    addEventListener('hashchange', update);
    return () => removeEventListener('hashchange', update);
  }, []);
  return page;
}

/**
 * The studio, opened on the scene saved last time. Its signed URLs last ~3 h,
 * so the saved scene is re-signed (`refreshScene`) before it is shown.
 */
function Studio() {
  const client = useViggleSceneClient();
  const [initial, setInitial] = useState<ViggleScene | null | undefined>(__VIGGLE_LIVE__ ? void 0 : null);
  useEffect(() => {
    if (!__VIGGLE_LIVE__) return;
    const saved = loadScene();
    if (!saved) return setInitial(null);
    let live = true;
    client.refreshScene(saved)
      .then((fresh) => { saveScene(fresh); return fresh; }, () => saved)
      .then((scene) => live && setInitial(scene));
    return () => { live = false; };
  }, [client]);
  if (initial === void 0) return <div style={{ flex: 1, display: 'grid', placeItems: 'center', font: '13px system-ui', color: '#777' }}>Opening the saved scene…</div>;
  return (
    <SceneStudio
      style={{ flex: 1 }}
      defaultScene={initial ?? void 0}
      generateInput={{ quality: 'low' }}
      toolbar={(ctx) => <StudioToolbar {...ctx} />}
      onSceneChange={(s) => {
        console.info('[scene]', s.sessionId, s.versions.map((v) => `${v.operation}:${v.batchIds.length}`).join(' → '));
        if (__VIGGLE_LIVE__) saveScene(s);
      }}
    />
  );
}

/** Beside Fill view: save the version on screen as a file, or send it to Edit to put a character in it. */
function StudioToolbar({ scene, version, versionIndex, busy }: SceneStudioToolbarContext) {
  const client = useViggleSceneClient();
  const [working, setWorking] = useState<'download' | 'edit' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ext = /\.(ply|sog|splat|spz)(\?|$)/i.exec(version.splatUrl)?.[1]?.toLowerCase() ?? 'spz';
  const name = `scene-${scene.sessionId.slice(-8)}-v${versionIndex}`;
  const run = (kind: 'download' | 'edit') => {
    setWorking(kind);
    setError(null);
    client.fetchSplat(scene, versionIndex)
      .then(async (blob) => {
        if (kind === 'download') return saveFile(blob, `${name}.${ext}`);
        const entry = await addScene({ name: `Studio v${versionIndex}`, source: 'studio', filename: `${name}.${ext}`, upright: isUprightFile(`x.${ext}`), blob });
        location.hash = `#edit:${entry.id}`;
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setWorking(null));
  };
  return (
    <>
      {error && <span style={{ ...glassButton, background: 'rgba(150, 32, 48, 0.88)', cursor: 'default' }}>{error}</span>}
      <button type="button" style={{ ...glassButton, opacity: working ? 0.6 : 1 }} disabled={!!working} onClick={() => run('download')} title="Save this version's splat file">
        {working === 'download' ? 'Downloading…' : '↓ Download'}
      </button>
      <button type="button" style={{ ...glassButton, opacity: working || busy ? 0.6 : 1 }} disabled={!!working || busy} onClick={() => run('edit')} title="Put a character in this version, in Edit">
        {working === 'edit' ? 'Sending…' : 'Use in Edit →'}
      </button>
    </>
  );
}

const glassButton: CSSProperties = {
  padding: '9px 14px', borderRadius: 14, border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(16, 14, 28, 0.66)', color: '#f4f2ff',
  backdropFilter: 'blur(14px)', font: '500 13px system-ui', cursor: 'pointer', whiteSpace: 'nowrap',
};

function App() {
  const route = useHashPage();
  const page = route.page;
  const tab = (to: string, label: string, on: boolean) => (
    <a href={to} style={{ color: on ? '#111' : '#777', fontWeight: on ? 600 : 400, textDecoration: 'none' }}>{label}</a>
  );
  return (
    <ViggleSceneProvider
      // Live: the dev proxy, which adds the key. Mock: an in-page stand-in.
      baseUrl="/viggle-api"
      fetch={__VIGGLE_LIVE__ ? void 0 : createMockFetch('/demo-room.ply')}
    >
      <div style={{ height: '100vh', padding: 16, boxSizing: 'border-box', background: '#e9e9ee', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ font: '13px system-ui', color: '#555', display: 'flex', gap: 16 }}>
          {tab('#', 'Studio', page === 'studio')}
          {tab('#edit', 'Edit', page === 'edit')}
          {tab('#showcase', 'Showcase', page === 'showcase')}
          <span style={{ marginLeft: 'auto' }}>
            {__VIGGLE_LIVE__ ? 'Live: apis.viggle.ai through the dev proxy' : 'Mock API (set VIGGLE_API_KEY in example/.env.local for live)'}
          </span>
        </div>
        {route.page === 'edit' ? <EditPage key={route.scene ?? ''} initialScene={route.scene} />
          : route.page === 'showcase' ? <ShowcasePage />
          : <Studio />}
      </div>
    </ViggleSceneProvider>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
