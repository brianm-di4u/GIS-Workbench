// The folders under app/src are layers, and until now only habit kept them apart. This holds two
// things that were already true, so that a later change can't undo them unnoticed.
//
// 1. A worker never loads UI code. Each file in workers/kinds is bundled on its own
//    (build/build.mjs), so one import of a UI module from anything a worker reaches puts the shell
//    in every worker and breaks where it touches `document`.
// 2. The UI layers sit on top. features/, lazy/, mobile/, shell/ and shell2/ are imported only by
//    each other and by the two entry files. The files in FROM_BEFORE imported one from below
//    before this check existed. Untangling one means taking it off the list, and the list may
//    only shrink.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';

const SRC = 'app/src';
const UI = new Set(['features', 'lazy', 'mobile', 'shell', 'shell2']);
const ENTRIES = new Set(['main.js', 'app.js']);
const FROM_BEFORE = new Set([
  'ai/tools-gis.js -> features/panels.js',
  'feedback/review.js -> shell/dialogs.js',
  'feedback/review.js -> shell/dom.js',
  'feedback/whiteboard.js -> shell/dom.js',
  'feedback/whiteboard.js -> shell/icons.js',
  'render/view3d.js -> shell/dom.js',
  'sensor/vendor.js -> shell/dom.js',
  'sidecar/cors-relay.js -> shell/dialogs.js',
  'sidecar/cors-relay.js -> shell/dom.js',
  'sidecar/feature.js -> features/lazy-host.js',
  'sidecar/feature.js -> shell/dialogs.js',
  'sidecar/feature.js -> shell/dom.js',
  'sidecar/native-ui.js -> shell/dialogs.js',
  'sidecar/native-ui.js -> shell/dom.js',
  'sidecar/relay-ui.js -> shell/dialogs.js',
  'sidecar/relay-ui.js -> shell/dom.js',
  'storage/files.js -> shell/dialogs.js',
  'storage/files.js -> shell/dom.js',
  'svc/publish.js -> shell/dialogs.js',
  'svc/publish.js -> shell/dom.js',
  'svc/services.js -> shell/dialogs.js',
  'svc/services.js -> shell/dom.js',
  'tools/tools.js -> shell/dialogs.js',
  'tools/tools.js -> shell/dom.js',
]);

/** Every relative import in a module: `import … from`, a bare `import '…'`, `export … from` and `import('…')`, on one line or several. */
const IMPORT = /(?:\bimport\s*(?:[^"';]*?\bfrom\s*)?|\bexport\s[^"';]*?\bfrom\s*|\bimport\s*\(\s*)["'](\.\.?\/[^"']+)["']/g;

/** The imports of each module under `dir`, as paths from app/src. `read` is injected so the scan can be tested on made-up files. */
export function importGraph(paths, read) {
  const graph = new Map();
  for (const p of paths) {
    const found = [...read(p).matchAll(IMPORT)].map((m) => posix.normalize(posix.join(posix.dirname(p), m[1]))).filter((r) => !r.startsWith('..'));
    graph.set(p, [...new Set(found)]);
  }
  return graph;
}

const layer = (p) => p.split('/')[0];

/** Imports of a UI layer from a module that is neither a UI layer nor an entry file, as "from -> to". */
export function upward(graph) {
  const out = [];
  for (const [from, tos] of graph) {
    if (UI.has(layer(from)) || ENTRIES.has(from)) continue;
    for (const to of tos) if (UI.has(layer(to))) out.push(`${from} -> ${to}`);
  }
  return out.sort();
}

/** Every module `entry` reaches, with the chain of imports that reaches it. */
export function reach(graph, entry) {
  const chain = new Map([[entry, [entry]]]);
  const queue = [entry];
  while (queue.length) {
    const p = queue.shift();
    for (const to of graph.get(p) ?? []) {
      if (chain.has(to)) continue;
      chain.set(to, [...chain.get(p), to]);
      queue.push(to);
    }
  }
  return chain;
}

const walk = (dir) => readdirSync(`${SRC}/${dir}`, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.m?js$/.test(e.name) ? [`${dir}/${e.name}`] : []));
const modules = readdirSync(SRC, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(e.name) : /\.m?js$/.test(e.name) ? [e.name] : []));
const text = (p) => readFileSync(`${SRC}/${p}`, 'utf8');
const graph = importGraph(modules, text);
const workers = modules.filter((p) => /^workers\/kinds\/[^/]+\.worker\.js$/.test(p));

describe('the import scan', () => {
  const files = {
    'core/a.js': "import { b } from './b.js';\nimport {\n  c,\n  d,\n} from '../shell/dom.js';\nexport * from '../geo/g.js';\nimport '../styles/x.js';",
    'core/b.js': "const m = await import('../features/f.js');\nimport fs from 'node:fs';",
    'features/f.js': "import { a } from '../core/a.js';",
    'main.js': "import './features/f.js';",
  };
  const g = importGraph(Object.keys(files), (p) => files[p]);

  it('reads one-line, many-line, bare, re-exporting and dynamic imports, and skips packages', () => {
    expect(g.get('core/a.js')).toEqual(['core/b.js', 'shell/dom.js', 'geo/g.js', 'styles/x.js']);
    expect(g.get('core/b.js')).toEqual(['features/f.js']);
    expect(g.get('main.js')).toEqual(['features/f.js']);
  });

  it('reports a UI import from below, and not one from a UI layer or an entry file', () => {
    expect(upward(g)).toEqual(['core/a.js -> shell/dom.js', 'core/b.js -> features/f.js']);
  });

  it('follows imports to everything a module reaches, with the chain', () => {
    expect(reach(g, 'core/a.js').get('features/f.js')).toEqual(['core/a.js', 'core/b.js', 'features/f.js']);
  });
});

describe('the layers of app/src', () => {
  it('finds the modules and the worker entries the build bundles', () => {
    expect(modules.length).toBeGreaterThan(300);
    expect(workers.length).toBeGreaterThanOrEqual(4);
    expect([...graph.values()].flat().filter((p) => /\.m?js$/.test(p) && !graph.has(p)), 'an import the scan resolved to a file that is not there').toEqual([]);
  });

  it('a worker reaches no UI layer', () => {
    const chains = workers.flatMap((w) => [...reach(graph, w)].filter(([p]) => UI.has(layer(p))).map(([, chain]) => chain.join(' > ')));
    expect(chains, 'a worker bundle must not contain UI code: move what the worker needs into a module below the UI layers, and import that from both sides').toEqual([]);
  });

  it('nothing a worker reaches uses document or window', () => {
    const code = (p) => text(p).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    const using = [...new Set(workers.flatMap((w) => [...reach(graph, w).keys()]))].filter((p) => graph.has(p) && /\b(document|window)\./.test(code(p)));
    expect(using.sort(), 'a worker has no document or window: use self or globalThis, or keep the DOM part in a module the worker does not import').toEqual([]);
  });

  it('nothing below the UI layers imports one, unless it did before this check', () => {
    const found = upward(graph);
    const added = found.filter((e) => !FROM_BEFORE.has(e));
    expect(added, 'a module below the UI imports it: pass in what it needs from the caller, or move the UI part into features/').toEqual([]);
    const gone = [...FROM_BEFORE].filter((e) => !found.includes(e));
    expect(gone, 'these imports are gone: take them off FROM_BEFORE').toEqual([]);
  });
});
