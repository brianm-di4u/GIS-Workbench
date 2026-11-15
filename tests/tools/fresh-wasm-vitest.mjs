// Vitest global setup: the unit tests load the WASM bundles from cargo's target, so build them first,
// or a change to crates/ would be tested against the last build's WASM. Cargo rebuilds only what
// changed (about 4 s when current). With no cargo, the tests that need the WASM skip as before.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cargoBundles } from '../../build/rust.mjs';

export default function setup() {
  if (spawnSync('cargo', ['--version']).status !== 0) {
    console.warn('fresh-wasm: no cargo, so the tests that load the WASM bundles will skip');
    return;
  }
  cargoBundles(fileURLToPath(new URL('../..', import.meta.url)));
}
