// OPFS tile store for long MIE4NITF sequences on the hosted copy (REQ-GAP-47, SDP-2.3 tier T1).
// Display tiles of a sequence are written to the origin-private file system as they are made, so
// a sequence played again (a loop, a second pass, a reload of the page) reads them back instead of
// decoding its frames again. One directory per sequence under `gw-mie-tiles/`; the whole store is
// capped (CAP bytes): when it grows past the cap the least recently used sequences are removed, and
// a sequence that alone fills the cap stops adding tiles. A file:// page has no OPFS (opaque origin):
// open() then returns null and the sequence decodes as before.

const ROOT = 'gw-mie-tiles';
export const CAP = 1 << 30;
const TYPES = { Uint8Array, Uint16Array, Int16Array, Float32Array };

let rootP = null;
let why = null;

async function root() {
  if (!rootP) {
    rootP = (async () => {
      try {
        if (!navigator.storage?.getDirectory) throw new Error('no navigator.storage.getDirectory');
        const top = await navigator.storage.getDirectory();
        return await top.getDirectoryHandle(ROOT, { create: true });
      } catch (e) {
        why = String(e?.message ?? e);
        return null;
      }
    })();
  }
  return rootP;
}

/** A short stable name for a key (FNV-1a, 64-bit, hex). */
function hashName(s) {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) h = BigInt.asUintN(64, (h ^ BigInt(s.charCodeAt(i))) * 0x100000001b3n);
  return h.toString(16).padStart(16, '0');
}

/** Bytes of every sequence directory: [{name, bytes, used}] (used: the newest file time). */
async function inventory(dir) {
  const out = [];
  for await (const [name, h] of dir.entries()) {
    if (h.kind !== 'directory') continue;
    let bytes = 0;
    let used = 0;
    for await (const [, f] of h.entries()) {
      if (f.kind !== 'file') continue;
      const file = await f.getFile();
      bytes += file.size;
      used = Math.max(used, file.lastModified);
    }
    out.push({ name, bytes, used });
  }
  return out;
}

export class TileStore {
  static unavailable() {
    return { enabled: false, reason: why ?? 'OPFS is not available here' };
  }

  /** The store of one sequence, or null without OPFS. Trims the store to the cap first. */
  static async open(key, { cap = CAP } = {}) {
    const dir = await root();
    if (!dir) return null;
    const name = hashName(key);
    try {
      const inv = await inventory(dir);
      let total = inv.reduce((a, x) => a + x.bytes, 0);
      for (const x of inv.filter((d) => d.name !== name).sort((a, b) => a.used - b.used)) {
        if (total <= cap * 0.8) break;
        await dir.removeEntry(x.name, { recursive: true });
        total -= x.bytes;
      }
      const mine = inv.find((d) => d.name === name);
      const sub = await dir.getDirectoryHandle(name, { create: true });
      return new TileStore(sub, { cap, total, bytes: mine?.bytes ?? 0, name });
    } catch (e) {
      why = String(e?.message ?? e);
      return null;
    }
  }

  constructor(dir, { cap, total, bytes, name }) {
    this.dir = dir;
    this.cap = cap;
    this.total = total;
    this.bytes = bytes;
    this.name = name;
    this.hits = 0;
    this.misses = 0;
    this.writes = 0;
    this.full = false;
    this.pending = new Set();
  }

  info() {
    return { enabled: true, dir: `${ROOT}/${this.name}`, hits: this.hits, misses: this.misses, writes: this.writes, bytes: this.bytes, full: this.full, cap: this.cap };
  }

  /** A tile written by put(), or null. */
  async get(key) {
    try {
      const fh = await this.dir.getFileHandle(hashName(key));
      const buf = await (await fh.getFile()).arrayBuffer();
      const dv = new DataView(buf);
      const jl = dv.getUint32(0, true);
      const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, jl)));
      if (meta.key !== key) throw new Error('hash collision');
      let at = 4 + jl;
      const bands = meta.bands.map(([type, n]) => {
        const C = TYPES[type];
        const pad = at % C.BYTES_PER_ELEMENT ? C.BYTES_PER_ELEMENT - (at % C.BYTES_PER_ELEMENT) : 0;
        at += pad;
        const a = new C(buf.slice(at, at + n * C.BYTES_PER_ELEMENT));
        at += n * C.BYTES_PER_ELEMENT;
        return a;
      });
      this.hits++;
      return { ...meta.tile, bands };
    } catch {
      this.misses++;
      return null;
    }
  }

  /** Write a tile (fire and forget; at most one write per key at a time). */
  put(key, tile) {
    if (this.full || this.pending.has(key)) return;
    const meta = { key, tile: { w: tile.w, h: tile.h, x0: tile.x0, y0: tile.y0 }, bands: tile.bands.map((b) => [b.constructor.name, b.length]) };
    const head = new TextEncoder().encode(JSON.stringify(meta));
    const parts = [new Uint32Array([head.length]), head];
    let at = 4 + head.length;
    for (const b of tile.bands) {
      const pad = at % b.BYTES_PER_ELEMENT ? b.BYTES_PER_ELEMENT - (at % b.BYTES_PER_ELEMENT) : 0;
      if (pad) parts.push(new Uint8Array(pad));
      parts.push(b);
      at += pad + b.byteLength;
    }
    if (this.total + at > this.cap) {
      this.full = true;
      return;
    }
    // The Blob copies the bands now: the tile's buffers are transferred to the page right after.
    const blob = new Blob(parts);
    this.pending.add(key);
    (async () => {
      try {
        const fh = await this.dir.getFileHandle(hashName(key), { create: true });
        const w = await fh.createWritable();
        await w.write(blob);
        await w.close();
        this.writes++;
        this.bytes += at;
        this.total += at;
      } catch {
        /* a full disk or a revoked origin: the tile is decoded again next time */
      } finally {
        this.pending.delete(key);
      }
    })();
  }

  /** Wait for pending writes (tests, chips). */
  async flush() {
    while (this.pending.size) await new Promise((r) => setTimeout(r, 5));
  }
}

/** Remove the whole store (the command that clears cached motion imagery). */
export async function clearStore() {
  const dir = await root();
  if (!dir) return { removed: 0, bytes: 0 };
  const inv = await inventory(dir);
  for (const x of inv) await dir.removeEntry(x.name, { recursive: true });
  return { removed: inv.length, bytes: inv.reduce((a, x) => a + x.bytes, 0) };
}
