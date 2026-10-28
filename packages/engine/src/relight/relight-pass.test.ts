import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Layer, StandardMaterial } from 'playcanvas';
import type { MeshInstance } from 'playcanvas';

import { RelightPass } from './relight-pass';

/** Exercise registration with real layer lists; no graphics device is needed. */
function fixture(castShadow = true) {
  const layer = new Layer();
  const visibility = new Layer();
  const shadow = new Layer();
  const material = new StandardMaterial();
  const caster = { castShadow, material } as unknown as MeshInstance;
  layer.addMeshInstances([caster]);
  const proxies = new Map<MeshInstance, MeshInstance | null>();
  const pass = Object.assign(Object.create(RelightPass.prototype), {
    _destroyed: false, _proxyLayer: layer, _shadowCasterLayer: shadow, _visibilityLayer: visibility, _proxies: proxies,
  }) as RelightPass;
  return { layer, visibility, shadow, material, caster, proxies, pass };
}

describe('shadow-only relight proxies', () => {
  it('keeps shadow casting while removing the body silhouette from receiver maps', () => {
    const f = fixture();
    f.pass.addProxy(f.caster, false);
    assert.equal(f.layer.meshInstances.includes(f.caster), false);
    assert.equal(f.shadow.shadowCasters.includes(f.caster), true);
    assert.equal(f.shadow.meshInstances.includes(f.caster), true, 'retain CPU skin-matrix updates');
    assert.equal(f.visibility.meshInstances.length, 0);
    assert.equal(f.proxies.get(f.caster), null);
    // Registration is idempotent, including the caster list.
    f.pass.addProxy(f.caster, false);
    assert.equal(f.shadow.shadowCasters.length, 1);
    f.material.destroy();
  });

  it('removes retained shadow casters before their mesh and skin are freed', () => {
    const f = fixture();
    f.pass.addProxy(f.caster, false);
    f.pass.removeProxy(f.caster);
    assert.equal(f.layer.shadowCasters.length, 0);
    assert.equal(f.shadow.shadowCasters.length, 0);
    assert.equal(f.shadow.meshInstances.length, 0);
    assert.equal(f.proxies.has(f.caster), false);
    assert.doesNotThrow(() => f.pass.removeProxy(f.caster));
    f.material.destroy();
  });

  it('respects disabled shadow casting on a caster-only target', () => {
    const f = fixture(false);
    f.pass.addProxy(f.caster, false);
    assert.equal(f.layer.meshInstances.length, 0);
    assert.equal(f.layer.shadowCasters.length, 0);
    assert.equal(f.shadow.shadowCasters.length, 0);
    f.material.destroy();
  });
});
