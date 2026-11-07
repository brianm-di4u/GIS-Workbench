// Load the WASM bundles exactly as shipped: from the built file's blocks (hash-checked).
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Core } from '../../app/src/wasm/core.js';
import { Bundle } from '../../app/src/wasm/abi.js';

export const DIST = process.env.TE_DIST ?? 'dist/gis-workbench.html';
export const built = existsSync(DIST);

let cache;
function blocks() {
  if (cache) return cache;
  const html = readFileSync(DIST, 'utf8');
  const manifest = JSON.parse(/<script type="application\/json" id="build-manifest">([\s\S]*?)<\/script>/.exec(html)[1]);
  cache = { html, manifest };
  return cache;
}

export function blockBytes(name) {
  const { html, manifest } = blocks();
  const b64 = new RegExp(`<script type="application/octet-stream" id="blk-${name}"[^>]*>([\\s\\S]*?)</script>`).exec(html)[1];
  let u8 = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
  if (manifest.blocks[name].gz) u8 = gunzipSync(u8);
  if (createHash('sha256').update(u8).digest('hex') !== manifest.blocks[name].sha256) throw new Error(`block ${name} hash mismatch`);
  return u8;
}

export const loadCore = () => new Core(new WebAssembly.Module(blockBytes('wasm-core')));
export const loadBundle = (name) => new Bundle(new WebAssembly.Module(blockBytes(`wasm-${name}`)), name);
