// A local HLS server for the REQ-GAP-49 tests (2.5 streams): on-demand playlists of segments made
// by ffmpeg, and its own segmenter, which cuts a transport stream at video key frames without
// touching a single packet (ffmpeg's HLS muxer rewrites synchronous KLV, stream type 0x15, as
// asynchronous 0x06), so synchronous KLV reaches the player as the encoder wrote it. A live
// stream slides a window over the segments in real time, loops with EXT-X-DISCONTINUITY, and can
// encrypt every segment with AES-128 (key and IV per RFC 8216 §5.2). Every request is recorded,
// and so is the wall-clock time each live segment was published.
//
//   const srv = await startHls();  srv.vod('name', dir) / srv.live('name', segments, opts) …

import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createCipheriv, randomBytes } from 'node:crypto';

const PACKET = 188;
const pts33 = (b, i) => (b[i] & 0x0e) * 2 ** 29 + b[i + 1] * 2 ** 22 + (b[i + 2] & 0xfe) * 2 ** 14 + b[i + 3] * 2 ** 7 + (b[i + 4] >> 1);

/** The PAT, the PMT and the video PID of a transport stream, and its packets' offsets. */
function scanTs(b) {
  let pmtPid = -1;
  let vpid = -1;
  let vtype = 0;
  let pat = null;
  let pmt = null;
  for (let o = 0; o + PACKET <= b.length; o += PACKET) {
    if (b[o] !== 0x47) throw new Error(`not 188-byte MPEG-TS at ${o}`);
    const pid = ((b[o + 1] & 0x1f) << 8) | b[o + 2];
    const pusi = b[o + 1] & 0x40;
    const afc = (b[o + 3] >> 4) & 3;
    let p = o + 4;
    if (afc & 2) p += 1 + b[p];
    if (!(afc & 1) || !pusi) continue;
    if (pid === 0 && !pat) {
      pat = b.subarray(o, o + PACKET);
      const s = p + 1 + b[p];
      pmtPid = ((b[s + 10] & 0x1f) << 8) | b[s + 11];
    } else if (pid === pmtPid && !pmt) {
      pmt = b.subarray(o, o + PACKET);
      const s = p + 1 + b[p];
      const len = ((b[s + 1] & 15) << 8) | b[s + 2];
      const pil = ((b[s + 10] & 15) << 8) | b[s + 11];
      for (let q = s + 12 + pil; q < s + 3 + len - 4; ) {
        const type = b[q];
        const epid = ((b[q + 1] & 0x1f) << 8) | b[q + 2];
        if (vpid < 0 && [0x01, 0x02, 0x1b, 0x24].includes(type)) {
          vpid = epid;
          vtype = type;
        }
        q += 5 + (((b[q + 3] & 15) << 8) | b[q + 4]);
      }
    }
    if (pat && pmt && vpid >= 0) break;
  }
  if (!pat || !pmt || vpid < 0) throw new Error('no PAT, PMT or video stream');
  return { pat, pmt, vpid, vtype };
}

/** Whether a video PES that starts in this packet starts a key frame (an SPS or IDR for H.264, a sequence header for MPEG-1/2). */
function keyStart(b, o, vtype) {
  const afc = (b[o + 3] >> 4) & 3;
  let p = o + 4;
  if (afc & 2) p += 1 + b[p];
  const end = o + PACKET;
  if (b[p] !== 0 || b[p + 1] !== 0 || b[p + 2] !== 1) return { key: false, pts: null };
  const flags = b[p + 7] >> 6;
  const pts = flags & 2 ? pts33(b, p + 9) : null;
  const dts = flags === 3 ? pts33(b, p + 14) : pts;
  const q0 = p + 9 + b[p + 8];
  for (let q = q0; q + 4 < end; q++) {
    if (b[q] !== 0 || b[q + 1] !== 0 || b[q + 2] !== 1) continue;
    if (vtype === 0x1b && ((b[q + 3] & 0x1f) === 7 || (b[q + 3] & 0x1f) === 5)) return { key: true, pts, dts };
    if ((vtype === 0x01 || vtype === 0x02) && b[q + 3] === 0xb3) return { key: true, pts, dts };
  }
  return { key: false, pts, dts };
}

/**
 * Cut a transport stream into segments of at least `seconds` at key frames. Each segment starts
 * with the stream's PAT and PMT; every other packet is copied unchanged. → [{bytes, duration}]
 */
export function segmentTs(buf, seconds = 2) {
  const b = new Uint8Array(buf);
  const { pat, pmt, vpid, vtype } = scanTs(b);
  const cuts = [];
  for (let o = 0; o + PACKET <= b.length; o += PACKET) {
    const pid = ((b[o + 1] & 0x1f) << 8) | b[o + 2];
    if (pid !== vpid || !(b[o + 1] & 0x40)) continue;
    const k = keyStart(b, o, vtype);
    if (k.key && k.dts !== null) cuts.push({ o, dts: k.dts });
  }
  if (!cuts.length) throw new Error('no key frames');
  const chosen = [cuts[0]];
  for (const c of cuts) if ((c.dts - chosen.at(-1).dts) / 90000 >= seconds - 1e-6) chosen.push(c);
  const segs = [];
  for (let i = 0; i < chosen.length; i++) {
    const a = i === 0 ? 0 : chosen[i].o;
    const e = i + 1 < chosen.length ? chosen[i + 1].o : b.length;
    const body = b.subarray(a, e);
    const head = i === 0 ? [] : [pat, pmt];
    const out = new Uint8Array(head.length * PACKET + body.length);
    head.forEach((h, k) => out.set(h, k * PACKET));
    out.set(body, head.length * PACKET);
    const next = i + 1 < chosen.length ? chosen[i + 1].dts : null;
    segs.push({ bytes: out, dts: chosen[i].dts, duration: next !== null ? (next - chosen[i].dts) / 90000 : null });
  }
  // The last segment's length: the mean of the others (its end is not cut).
  const known = segs.filter((s) => s.duration !== null);
  const mean = known.length ? known.reduce((a, s) => a + s.duration, 0) / known.length : seconds;
  for (const s of segs) if (s.duration === null) s.duration = mean;
  return segs;
}

/** AES-128-CBC with PKCS#7 padding (RFC 8216 §4.3.2.4). */
export function encrypt(bytes, key, iv) {
  const c = createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([c.update(bytes), c.final()]);
}

/** The IV of media sequence number `seq` (§5.2): its big-endian 128-bit value. */
export function seqIv(seq) {
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(seq >>> 0, 12);
  iv.writeUInt32BE(Math.floor(seq / 2 ** 32) >>> 0, 8);
  return iv;
}

export async function startHls({ host = '127.0.0.1' } = {}) {
  const routes = new Map(); // path → handler(req, res)
  const seen = [];
  const live = new Map();
  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push({ at: Date.now(), method: req.method, path: u.pathname, origin: req.headers.origin ?? null, range: req.headers.range ?? null });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    const h = routes.get(u.pathname);
    if (!h) {
      res.writeHead(404);
      return res.end();
    }
    try {
      h(req, res, u);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e.message));
    }
  });
  await new Promise((r) => srv.listen(0, host, r));
  const origin = `http://${host}:${srv.address().port}`;

  const send = (res, req, type, body) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    if (m) {
      const a = Number(m[1]);
      const e = m[2] ? Number(m[2]) : buf.length - 1;
      res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${a}-${e}/${buf.length}`, 'content-length': e - a + 1 });
      return res.end(buf.subarray(a, e + 1));
    }
    res.writeHead(200, { 'content-type': type, 'content-length': buf.length });
    res.end(buf);
  };
  const TYPE = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.key': 'application/octet-stream', '.bin': 'application/octet-stream' };

  /** Serve the files of a directory under /<name>/ (an ffmpeg-made on-demand stream). */
  function vod(name, dir) {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      routes.set(`/${name}/${f}`, (req, res) => send(res, req, TYPE[extname(f)] ?? 'application/octet-stream', readFileSync(p)));
    }
    return `${origin}/${name}/${readdirSync(dir).find((f) => f.endsWith('.m3u8'))}`;
  }

  /** Serve text or bytes at a path (hand-made playlists for the refusal tests). */
  function file(path, body, type = 'application/vnd.apple.mpegurl') {
    routes.set(path, (req, res) => send(res, req, type, body));
    return `${origin}${path}`;
  }

  /** An on-demand playlist of segments from the own segmenter (synchronous KLV kept). */
  function vodSegments(name, segs, { aes = null } = {}) {
    const key = aes ? (aes === true ? randomBytes(16) : aes) : null;
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...segs.map((s) => s.duration)))}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
    if (key) {
      routes.set(`/${name}/key.bin`, (req, res) => send(res, req, TYPE['.bin'], key));
      lines.push(`#EXT-X-KEY:METHOD=AES-128,URI="key.bin"`);
    }
    segs.forEach((s, i) => {
      const body = key ? encrypt(s.bytes, key, seqIv(i)) : Buffer.from(s.bytes);
      routes.set(`/${name}/s${i}.ts`, (req, res) => send(res, req, TYPE['.ts'], body));
      lines.push(`#EXTINF:${s.duration.toFixed(6)},`, `s${i}.ts`);
    });
    lines.push('#EXT-X-ENDLIST', '');
    routes.set(`/${name}/index.m3u8`, (req, res) => send(res, req, TYPE['.m3u8'], lines.join('\n')));
    return { url: `${origin}/${name}/index.m3u8`, key };
  }

  /**
   * A live stream: segment k (looping over `segs`, a discontinuity at each loop) is published when
   * its predecessors' durations have passed in real time; the playlist lists the last `window`.
   * `speed` > 1 publishes faster than real time. aes: true (a random key) or a 16-byte key.
   */
  function liveStream(name, segs, { window = 5, aes = null, loops = Infinity, startAhead = 3, targetDuration = null } = {}) {
    const key = aes ? (aes === true ? randomBytes(16) : aes) : null;
    const t0 = Date.now();
    const state = { t0, published: new Map(), requests: 0, key, segs };
    // Publication times: the first `startAhead` segments exist at once (a stream already running).
    const plan = [];
    let at = t0;
    const maxN = Number.isFinite(loops) ? loops * segs.length : 1e6;
    const pubAt = (k) => {
      while (plan.length <= k && plan.length < maxN) {
        const i = plan.length;
        plan.push({ k: i, src: i % segs.length, loop: Math.floor(i / segs.length), at: i < startAhead ? t0 : at });
        if (i >= startAhead - 1) at += segs[i % segs.length].duration * 1000;
      }
      return plan[k];
    };
    const td = targetDuration ?? Math.ceil(Math.max(...segs.map((s) => s.duration)));
    const cache = new Map();
    const bodyOf = (k) => {
      if (!cache.has(k)) {
        const s = segs[k % segs.length];
        cache.set(k, key ? encrypt(s.bytes, key, seqIv(k)) : Buffer.from(s.bytes));
        if (cache.size > 64) cache.delete(cache.keys().next().value);
      }
      return cache.get(k);
    };
    routes.set(`/${name}/live.m3u8`, (req, res) => {
      state.requests++;
      const now = Date.now();
      let n = 0;
      while (n < maxN && pubAt(n) && pubAt(n).at <= now) {
        if (!state.published.has(n)) state.published.set(n, pubAt(n).at);
        n++;
      }
      const first = Math.max(0, n - window);
      const ended = n >= maxN;
      // Discontinuities before the window (one at each loop) count in EXT-X-DISCONTINUITY-SEQUENCE.
      const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${td}`, `#EXT-X-MEDIA-SEQUENCE:${first}`, `#EXT-X-DISCONTINUITY-SEQUENCE:${Math.floor(first / segs.length)}`];
      if (key) {
        if (!routes.has(`/${name}/key.bin`)) routes.set(`/${name}/key.bin`, (rq, rs) => send(rs, rq, TYPE['.bin'], key));
        lines.push(`#EXT-X-KEY:METHOD=AES-128,URI="key.bin"`);
      }
      for (let k = first; k < n; k++) {
        const p = pubAt(k);
        if (k > first && p.src === 0) lines.push('#EXT-X-DISCONTINUITY');
        lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(p.at).toISOString()}`, `#EXTINF:${segs[p.src].duration.toFixed(6)},`, `seg${k}.ts`);
      }
      if (ended) lines.push('#EXT-X-ENDLIST');
      lines.push('');
      send(res, req, TYPE['.m3u8'], lines.join('\n'));
    });
    // Segments are served by number on request (only once published).
    const prefix = `/${name}/seg`;
    const handler = (req, res, u) => {
      const k = Number(u.pathname.slice(prefix.length).replace(/\.ts$/, ''));
      const p = Number.isInteger(k) ? pubAt(k) : null;
      if (!p || p.at > Date.now()) {
        res.writeHead(404);
        return res.end();
      }
      send(res, req, TYPE['.ts'], bodyOf(k));
    };
    live.set(name, { state, prefix, handler });
    return { url: `${origin}/${name}/live.m3u8`, state, key };
  }

  // Live segment paths are numbered: one dispatcher per stream prefix.
  const routeGet = routes.get.bind(routes);
  routes.get = (path) => {
    const h = routeGet(path);
    if (h) return h;
    for (const l of live.values()) if (path.startsWith(l.prefix) && path.endsWith('.ts')) return l.handler;
    return undefined;
  };

  return { origin, seen, vod, vodSegments, live: liveStream, file, close: () => new Promise((r) => srv.close(r)) };
}

export function readIfExists(p) {
  return existsSync(p) ? readFileSync(p) : null;
}
