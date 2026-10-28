// The engine's collider worker, spawned from here because a bundler only emits
// a worker from a relative `new URL`. Importing it installs its onmessage.
import '@viggle/splat-engine/collider/collider-worker.ts';
