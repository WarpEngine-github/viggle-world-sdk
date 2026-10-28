import type { CSSProperties } from 'react';

import type { CollisionView } from '@viggle/scene-sdk/explorer';

/**
 * Two buttons over the walk, top-left: show what the walker collides with,
 * and go back to the spawn point. Shared by Edit and Showcase.
 */
export function CanvasControls({ collision, onCollision, onRespawn, disabled }: {
  collision: CollisionView;
  onCollision: (view: CollisionView) => void;
  onRespawn: () => void;
  disabled?: boolean;
}) {
  const on = collision !== 'off';
  return (
    <div style={{ position: 'absolute', top: 14, left: 14, display: 'flex', gap: 8 }}>
      <button
        type="button"
        aria-pressed={on}
        disabled={disabled}
        title="Show where the walker can go"
        onClick={() => onCollision(on ? 'off' : 'outline')}
        style={{ ...button, ...(on ? active : null) }}
      >
        ▦ Collision {on ? 'on' : 'off'}
      </button>
      <button type="button" disabled={disabled} title="Back to the spawn point" onClick={onRespawn} style={button}>
        ⟲ Back to start
      </button>
    </div>
  );
}

const button: CSSProperties = {
  padding: '7px 12px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(16,14,28,0.6)', color: '#fff',
  font: '500 12px system-ui', cursor: 'pointer', backdropFilter: 'blur(10px)', whiteSpace: 'nowrap',
};
const active: CSSProperties = { background: '#f59e0b', border: '1px solid #f59e0b', color: '#1a1205' };
