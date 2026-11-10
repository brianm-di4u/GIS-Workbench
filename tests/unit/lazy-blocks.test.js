// Lazy app blocks (2.4): the modules handed over to the blocks (features/lazy-host.js HOST) are
// exactly the ones the build binds (build/host-modules.mjs HOST_MODULES), each one's exports can be
// read by the build, every block entry registers under its own block name, and no block entry
// pulls a second copy of a handed-over module or of the feature stubs that load it.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as esbuild from 'esbuild';
import { HOST_MODULES, exportNames, hostModules } from '../../build/host-modules.mjs';
import { vendorFixes } from '../../build/vendor-fixes.mjs';

const root = resolve('.');
const src = join(root, 'app', 'src');
const lazyDir = join(src, 'lazy');
const APP_BLOCKS = ['ai24', 'apiv2', 'field', 'geod', 'geoproc', 'imaging', 'services', 'signin', 'sarstereo', 'sargeo', 'streams', 'portal', 'relay'];

describe('lazy app blocks', () => {
  it('hands over exactly the modules the build binds', () => {
    const text = readFileSync(join(src, 'features', 'lazy-host.js'), 'utf8');
    const body = /export const HOST = \{([\s\S]*?)\};/.exec(text)[1];
    const keys = [...body.matchAll(/'([^']+\.js)'\s*:/g)].map((m) => m[1]);
    expect(keys.sort()).toEqual([...HOST_MODULES].sort());
  });

  it('can read the exports of every handed-over module', () => {
    for (const m of HOST_MODULES) {
      const code = readFileSync(join(src, m), 'utf8');
      expect(exportNames(code).length, m).toBeGreaterThan(0);
      expect(/^export\s+(default|\*)/m.test(code), `${m}: export default / export * cannot be handed over`).toBe(false);
    }
  });

  it('every block entry registers its own name', () => {
    for (const f of readdirSync(lazyDir).filter((x) => x.endsWith('.lazy.js'))) {
      const name = `js-${f.replace('.lazy.js', '')}`;
      expect(readFileSync(join(lazyDir, f), 'utf8'), f).toContain(`['${name}']`);
    }
  });

  it('app blocks bind the handed-over modules and carry no feature stub', async () => {
    for (const b of APP_BLOCKS) {
      const r = await esbuild.build({
        entryPoints: [join(lazyDir, `${b}.lazy.js`)],
        bundle: true,
        write: false,
        metafile: true,
        format: 'iife',
        platform: 'browser',
        logLevel: 'silent',
        define: { __DEV__: 'false', __APP_VERSION__: '"t"', __BUILD_DATE__: '"t"', __DEFAULT_MODEL__: '"t"', 'import.meta.url': '"about:blank"', 'process.env.NODE_ENV': '"production"' },
        loader: { '.css': 'text', '.svg': 'text', '.txt': 'text', '.wgsl': 'text', '.glsl': 'text' },
        plugins: [vendorFixes, hostModules(root)],
      });
      const inputs = Object.keys(r.metafile.inputs).map((k) => k.replace(/\\/g, '/'));
      for (const m of HOST_MODULES) expect(inputs.filter((k) => k.endsWith(`app/src/${m}`)), `${b}: ${m} bundled`).toEqual([]);
      expect(inputs.filter((k) => /features\/(lazy-host|imaging-lazy|field-lazy|index)\.js$|features\/(automation|ai-local|signin|datum-grids)\.js$/.test(k)), `${b}: eager stub bundled`).toEqual([]);
      expect(inputs.filter((k) => /features\/(lazy-host|imaging-lazy|sarstereo-lazy|index)\.js$|features\/(automation|ai-local|signin|datum-grids)\.js$/.test(k)), `${b}: eager stub bundled`).toEqual([]);
      expect(inputs.filter((k) => /features\/(lazy-host|imaging-lazy|index)\.js$|features\/(automation|ai-local|signin|datum-grids|streams)\.js$/.test(k)), `${b}: eager stub bundled`).toEqual([]);
    }
  }, 60000);
});
