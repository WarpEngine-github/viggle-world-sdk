import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SPZ_READ_GLSL, SPZ_READ_WGSL } from './spz-quantized-shader.ts';

it('matches the installed PlayCanvas SPZ parser\'s shader reads', () => {
  // Fails after a PlayCanvas upgrade that changes them: re-copy from this file.
  const parser = readFileSync(fileURLToPath(import.meta.resolve('playcanvas/scripts/esm/parsers/spz-parser.mjs')), 'utf8');
  const read = (lang: string) => new RegExp(`const read${lang} = /\\* ${lang.toLowerCase()} \\*/\`([\\s\\S]*?)\`;`).exec(parser)?.[1];
  assert.equal(SPZ_READ_GLSL, read('GLSL'));
  assert.equal(SPZ_READ_WGSL, read('WGSL'));
});
