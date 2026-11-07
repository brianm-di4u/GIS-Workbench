// Lazy app blocks (2.4: js-services, js-ai24, js-apiv2 …): app code in a lazy main-thread block must use the running
// app's own copy of its stateful modules (the i18n locale and catalogue, the dialog stack, the
// image opener, the CRS table with its PROJ pack definitions). This esbuild plugin turns an
// import of one of them, from app code inside a lazy block, into a module that re-exports what the
// app handed over in globalThis.__gwHost (features/lazy-host.js HOST), so the block carries no
// second copy. Imports from packages and of other app modules bundle as usual.

import { readFileSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

export const HOST_MODULES = ['i18n/index.js', 'i18n/format.js', 'shell/dialogs.js', 'shell/dom.js', 'formats/open.js', 'geo/crs.js', 'vector/geom.js', 'formats/nitf-writer.js', 'vector/io.js', 'formats/geotiff-writer.js'];

/** The names a module exports (export function/const/let/class NAME, export { a, b as c }). */
export function exportNames(src) {
  const out = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) for (const part of m[1].split(',')) {
    const n = part.trim().split(/\s+as\s+/).pop();
    if (n) out.add(n);
  }
  return [...out];
}

export function hostModules(root) {
  const srcDir = join(root, 'app', 'src');
  return {
    name: 'gw-host-modules',
    setup(b) {
      b.onResolve({ filter: /^\.\.?\/.*\.js$/ }, (args) => {
        if (!args.importer || /node_modules/.test(args.importer) || args.namespace !== 'file') return undefined;
        const rel = relative(srcDir, resolve(dirname(args.importer), args.path)).replace(/\\/g, '/');
        return HOST_MODULES.includes(rel) ? { path: rel, namespace: 'gw-host' } : undefined;
      });
      b.onLoad({ filter: /.*/, namespace: 'gw-host' }, (args) => {
        const names = exportNames(readFileSync(join(srcDir, args.path), 'utf8'));
        const key = JSON.stringify(args.path);
        const body = [`const m = globalThis.__gwHost && globalThis.__gwHost[${key}];`, `if (!m) throw new Error('the app did not hand over ' + ${key});`, ...names.map((n) => `export const ${n} = m.${n};`)];
        return { contents: body.join('\n'), loader: 'js' };
      });
    },
  };
}
