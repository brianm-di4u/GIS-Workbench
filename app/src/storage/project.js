// The .gwb project file (D1, D28, REQ-ARC-08/09): a ZIP with manifest.json, records.json,
// views.json and the journal tail. Imagery is never copied in; it is referenced by name,
// size, time and fingerprint, and relinked on open by fingerprint or by the user's pick.

import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { fingerprint } from '../formats/open.js';
import { clone } from '../core/util.js';

export const FORMAT = 'gis-workbench-project';
export const VERSION = 1;
const LIMITS = { entries: 2000, total: 512 << 20, ratio: 200 };

export function serialiseProject(app) {
  const records = app.store.snapshot();
  const views = {};
  for (const mp of app.desktop.multiports) for (const p of mp.panes) views[p.id] = clone(p.view);
  const docks = Object.fromEntries(app.desktop.multiports.map((mp) => [mp.id, mp.docks.layout()]));
  const manifest = {
    format: FORMAT,
    version: VERSION,
    build: app.build,
    saved: new Date().toISOString(),
    project: app.project()?.name ?? 'Untitled',
    origins: app.project()?.origins ?? [],
    marking: app.screenMarking(),
    imagery: app.store.all('fileref').map((f) => ({ id: f.id, name: f.name, size: f.size, fingerprint: f.fingerprint })),
    note: 'Imagery is referenced, not embedded. Open the project and relink files by fingerprint.',
  };
  const journal = app.undo.history().slice(0, 50);
  const files = {
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'records.json': strToU8(JSON.stringify(records)),
    'views.json': strToU8(JSON.stringify({ views, docks, arrange: app.desktop.arrange })),
    'journal.json': strToU8(JSON.stringify(journal)),
  };
  return zipSync(files, { level: 6 });
}

/** Bounded unzip of a project (zip bombs, path tricks). */
export function readProject(bytes) {
  let total = 0;
  let count = 0;
  const files = unzipSync(bytes, {
    filter(f) {
      count++;
      if (count > LIMITS.entries) throw new Error('project has too many entries');
      if (/^\/|\.\.(\/|\\)/.test(f.name)) throw new Error(`refusing entry name ${f.name}`);
      total += f.originalSize;
      if (total > LIMITS.total) throw new Error('project expands beyond 512 MB');
      if (f.size && f.originalSize / f.size > LIMITS.ratio) throw new Error(`entry ${f.name} has a suspicious compression ratio`);
      return true;
    },
  });
  const text = (n) => (files[n] ? strFromU8(files[n]) : null);
  const manifest = JSON.parse(text('manifest.json') ?? 'null');
  if (!manifest || manifest.format !== FORMAT) throw new Error('not a GIS Workbench project (.gwb)');
  if (manifest.version > VERSION) throw new Error(`this project was saved by a newer GIS Workbench (format ${manifest.version}); this build reads up to ${VERSION}`);
  const records = JSON.parse(text('records.json') ?? '[]', (k, v) => (k === '__proto__' ? undefined : v));
  const views = JSON.parse(text('views.json') ?? '{}');
  return { manifest, records: migrate(records, manifest.version), views };
}

function migrate(records) {
  // Format 1 is the first version; future versions add steps here.
  return records.filter((r) => r && typeof r.id === 'string' && typeof r.type === 'string');
}

/**
 * Relink: match each fileref to a File by fingerprint (size first, then the hash).
 * `candidates` are Files the user picked (or a folder's files). Returns {linked, missing, mismatched}.
 */
export async function relink(frefs, candidates) {
  const linked = new Map();
  const mismatched = [];
  const bySize = new Map();
  for (const f of candidates) {
    if (!bySize.has(f.size)) bySize.set(f.size, []);
    bySize.get(f.size).push(f);
  }
  for (const r of frefs) {
    const same = bySize.get(r.size) ?? [];
    let hit = null;
    for (const f of same) {
      if ((await fingerprint(f)) === r.fingerprint) {
        hit = f;
        break;
      }
    }
    if (hit) linked.set(r.id, hit);
    else {
      const byName = candidates.find((f) => f.name === r.name);
      if (byName) mismatched.push({ ref: r, file: byName });
    }
  }
  const missing = frefs.filter((r) => !linked.has(r.id));
  return { linked, missing, mismatched };
}
