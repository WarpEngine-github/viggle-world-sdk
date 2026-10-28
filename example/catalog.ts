import type { WalkPlacement } from '@viggle/scene-sdk/explorer';
import type { SunLight } from '@viggle/scene-sdk/lighting';

/** What the example offers out of the box: Viggle's public gallery assets. */
const CDN = 'https://assets.viggle.ai/pub/www/jst2-gallery/';

/** The PINOC gallery's walkable rooms (jst2Gallery.data.ts), each with the character it was made with. */
export const GALLERY_SCENES: Array<{ name: string; url: string; placement: WalkPlacement; light: SunLight; character: string }> = [
  {
    name: 'Attic hideaway',
    url: `${CDN}attic-cabin-8873bda3.sog`,
    placement: { scale: 3.8, floor: 0.402, start: [0, 0.2] },
    light: { azimuth: 216, elevation: 45, color: '#fff0d8', sceneStrength: 0.05, region: [[-1, -0.8], [1, -0.8], [1, 1.4], [-1, 1.4]] },
    character: 'attic',
  },
  {
    name: 'Hobbit hole',
    url: `${CDN}hobbit-faea6bf0.sog`,
    placement: { scale: 2.3, floor: 1.575, start: [0, -0.3] },
    light: { azimuth: 340, elevation: 35, intensity: 1.6, color: '#ffe6c2', lamps: [{ at: [-0.95, 0.8, -3], color: '#ffd2a0', intensity: 1.2, range: 5 }] },
    character: 'hobbit',
  },
  {
    name: 'Arena',
    url: `${CDN}arena-4ac5da9b.sog`,
    placement: { scale: 8, floor: 0.152, start: [0, 0.2] },
    light: { azimuth: 20, elevation: 70, intensity: 1.7, color: '#f2f6ff', lamps: [{ at: [0, -0.1, -0.9], color: '#eef4ff', intensity: 1.2, range: 6 }] },
    character: 'arena',
  },
  {
    name: 'Blue room',
    url: `${CDN}blue-room-e859178c.sog`,
    placement: { scale: 2.8, floor: 0.421, start: [0, 0] },
    light: { azimuth: 0, elevation: 25, intensity: 1.4, color: '#ff7b55', lamps: [{ at: [0, 0.2, 0.85], color: '#ff5a3c', intensity: 1.3, range: 4 }] },
    character: 'blue',
  },
];

/** Viggle splat characters on the public CDN. Any of them walks in any scene. */
export const CHARACTERS: Array<{ id: string; name: string; url: string }> = [
  { id: 'attic', name: 'Attic', url: `${CDN}attic-cabin-character-40d389ae.vsplat` },
  { id: 'hobbit', name: 'Hobbit', url: `${CDN}hobbit-character-bf3d9c31.vsplat` },
  { id: 'arena', name: 'Arena', url: `${CDN}arena-character-0c9edb65.vsplat` },
  { id: 'blue', name: 'Blue room', url: `${CDN}blue-room-character-2d102bb6.vsplat` },
  { id: 'frodo', name: 'Frodo', url: `${CDN}rivendell-frodo-17a70101.vsplat` },
  { id: 'viking', name: 'Viking', url: `${CDN}viking-woman-p01-f09477b2.vsplat` },
  { id: 'windmill', name: 'Traveller', url: `${CDN}windmill-player-3b5fc511.vsplat` },
  { id: 'villager1', name: 'Villager A', url: `${CDN}windmill-npc-r02-new1011-04-p04-vsplat-0dd47fa9.vsplat` },
  { id: 'villager2', name: 'Villager B', url: `${CDN}windmill-npc-r14-new1011-12-p04-vsplat-d8701b3c.vsplat` },
];

/** Clips retargeted to the Viggle splat rig, from the gallery's scenes. */
export const ACTIONS: Array<{ name: string; url: string }> = [
  { name: 'Wave', url: `${CDN}windmill-npc-react-wavehello-glb-640ca1ec.glb` },
  { name: 'Greet', url: `${CDN}windmill-npc-react-friendlygreeting-glb-1de231ee.glb` },
  { name: 'Bow (m)', url: `${CDN}windmill-greet-male-1c84ec5c.glb` },
  { name: 'Curtsy (f)', url: `${CDN}windmill-greet-female-a053d7fb.glb` },
  { name: 'Nod', url: `${CDN}windmill-npc-react-nodyes-glb-456f8c82.glb` },
  { name: 'Point', url: `${CDN}windmill-npc-react-pointforward-glb-8a1e9d33.glb` },
  { name: 'Beckon', url: `${CDN}windmill-npc-react-beckon-glb-4622ae67.glb` },
  { name: 'Surprise', url: `${CDN}windmill-npc-react-pleasantsurprise-glb-b9a039e6.glb` },
  { name: 'Glance', url: `${CDN}windmill-npc-react-curiousglance-glb-93e2ba19.glb` },
  { name: 'Acknowledge', url: `${CDN}windmill-interaction-acknowledge-c2032a29.glb` },
  { name: 'Cheer', url: `${CDN}cheer-5e381c61.glb` },
  { name: 'Clap', url: `${CDN}su-clapping-cafee4b2.glb` },
  { name: 'Talk', url: `${CDN}windmill-interaction-conversation-speak-c4d5660f.glb` },
  { name: 'Listen', url: `${CDN}windmill-interaction-conversation-listen-9332af0f.glb` },
  { name: 'Turn around', url: `${CDN}windmill-interaction-turn-180-9bb354a5.glb` },
];


/**
 * Lights to choose from in Edit. `scene` is the gallery room's own (it knows
 * where that room's windows and lamps are); the rest suit any scene.
 */
export const LIGHT_PRESETS: Array<{ id: string; name: string; light: SunLight | null }> = [
  { id: 'off', name: 'Off', light: null },
  { id: 'scene', name: 'Scene', light: null },
  { id: 'day', name: 'Daylight', light: { azimuth: 35, elevation: 55, intensity: 1.8, color: '#fff4e0', sceneStrength: 0.06 } },
  { id: 'golden', name: 'Golden hour', light: { azimuth: 250, elevation: 14, intensity: 2.1, color: '#ffb46b', sky: { color: '#f0b8a0', intensity: 0.3 }, sceneStrength: 0.12 } },
  { id: 'overcast', name: 'Overcast', light: { azimuth: 0, elevation: 75, intensity: 1.1, color: '#e8eef5', sky: { color: '#c7d2de', intensity: 0.5 }, sceneStrength: 0.04, shadowStrength: 0.25 } },
  { id: 'blue', name: 'Blue hour', light: { azimuth: 300, elevation: 8, intensity: 0.9, color: '#9fb4ff', sky: { color: '#4a5f9e', intensity: 0.45 }, sceneStrength: 0.15 } },
];

/** What a scene with no light of its own starts on. */
export const DEFAULT_LIGHT = 'day';
