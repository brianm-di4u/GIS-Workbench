// Shared corpus helpers for the T&E campaign (build/campaign/*, tests/campaign/*).
// The corpus is untrusted public data kept outside the repo; nothing here executes it.

import { readFileSync, existsSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '..', '..');
export const MANIFEST = join(HERE, 'corpus.json');
export const CORPUS = resolve(process.env.TE_CORPUS ?? join(REPO, '..', 'TE-corpus'));
export const SAMPLES = resolve(REPO, '..', 'Research', 'samples');
/** Field data supplied by a user (tier U): referenced in place, never copied or bundled. */
export const FIELD = resolve(process.env.TE_FIELD ?? join(REPO, '..', 'Research', 'Additional Data Samples'));

export const loadManifest = () => JSON.parse(readFileSync(MANIFEST, 'utf8'));

/** Directory holding an item's files: Research/samples/<dir> for registered samples, the field-data folder for tier U, else TE-corpus/<id>. */
export const itemDir = (item) => (item.origin === 'research-samples' ? join(SAMPLES, item.dir) : item.origin === 'field-data' ? join(FIELD, item.dir) : join(CORPUS, item.id));
export const filePath = (item, f) => join(itemDir(item), ...f.name.split('/'));

export function sha256File(p) {
  return new Promise((ok, fail) => {
    const h = createHash('sha256');
    createReadStream(p)
      .on('data', (d) => h.update(d))
      .on('end', () => ok(h.digest('hex')))
      .on('error', fail);
  });
}

/** True when every file of the item is on disk (truth/metadata files optional). */
export const present = (item) => item.files.length > 0 && item.files.every((f) => existsSync(filePath(item, f)));

export const ext = (p) => extname(p.replace(/\.(gz|zip)$/i, '')).toLowerCase();

export const fmtBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e3).toFixed(0)} kB`);
