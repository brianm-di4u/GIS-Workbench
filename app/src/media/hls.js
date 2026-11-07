// HLS playlists (RFC 8216, REQ-GAP-49): master and media playlists, live and VOD, sliding
// windows (EXT-X-MEDIA-SEQUENCE), discontinuities (EXT-X-DISCONTINUITY and
// EXT-X-DISCONTINUITY-SEQUENCE), byte ranges, program date-time and AES-128 keys. What the player
// cannot play is refused by name: fMP4/CMAF segments (EXT-X-MAP), SAMPLE-AES and key systems
// other than "identity" (DRM). DOM-free, so it tests in Node; the player is lazy/streams.lazy.js.

import { gwError } from '../i18n/index.js';

const MAX_TEXT = 4 << 20; // a playlist larger than 4 MB is not a playlist
const MAX_SEGMENTS = 100000;

/** The attribute list of a tag (RFC 8216 §4.2): KEY=VALUE, KEY="quoted, with commas", KEY=0x… */
export function attrList(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)(?:,|$)/g;
  let m;
  while ((m = re.exec(String(s))) && m[0] !== '') {
    const v = m[2];
    out[m[1]] = v.startsWith('"') ? v.slice(1, -1) : v.trim();
    if (re.lastIndex >= s.length) break;
  }
  return out;
}

function resolve(uri, base) {
  try {
    return new URL(uri, base).href;
  } catch {
    throw gwError('the playlist names a segment address that is not valid: {uri}', { uri: String(uri).slice(0, 200) }, 'E_HLS_URI');
  }
}

/** A 128-bit IV: "0x…" hex, or the media sequence number as a big-endian 16-byte integer (§5.2). */
export function ivOf(hex, seq) {
  const iv = new Uint8Array(16);
  if (hex) {
    const h = String(hex).replace(/^0x/i, '').padStart(32, '0');
    if (!/^[0-9a-f]{32}$/i.test(h)) throw gwError('the playlist gives an AES-128 IV that is not 128 bits: {iv}', { iv: String(hex).slice(0, 40) }, 'E_HLS_IV');
    for (let i = 0; i < 16; i++) iv[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
    return iv;
  }
  let n = BigInt(seq);
  for (let i = 15; i >= 0 && n > 0n; i--) {
    iv[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return iv;
}

/**
 * Parse a playlist. → {kind: 'master', variants, renditions} or {kind: 'media', targetDuration,
 * mediaSequence, discontinuitySequence, endList, playlistType, segments, duration}. Segment
 * `seq` is its media sequence number, `disc` its discontinuity sequence number.
 */
export function parsePlaylist(text, baseUrl) {
  const src = String(text ?? '');
  if (src.length > MAX_TEXT) throw gwError('the playlist is larger than 4 MB', null, 'E_HLS_TOO_LARGE');
  const lines = src.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim());
  if (lines[0] !== '#EXTM3U') throw gwError('this is not an HLS playlist (no #EXTM3U on the first line)', null, 'E_HLS_NOT_PLAYLIST');
  const master = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
  if (master) return parseMaster(lines, baseUrl);
  return parseMedia(lines, baseUrl);
}

function parseMaster(lines, baseUrl) {
  const variants = [];
  const renditions = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('#EXT-X-STREAM-INF:')) {
      const a = attrList(l.slice(18));
      let j = i + 1;
      while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
      if (j >= lines.length) break;
      const res = /^(\d+)x(\d+)$/.exec(a.RESOLUTION ?? '');
      variants.push({ uri: resolve(lines[j], baseUrl), bandwidth: Number(a.BANDWIDTH) || 0, averageBandwidth: Number(a['AVERAGE-BANDWIDTH']) || null, codecs: a.CODECS ?? null, resolution: res ? [Number(res[1]), Number(res[2])] : null, frameRate: Number(a['FRAME-RATE']) || null, name: a.NAME ?? null });
      i = j;
    } else if (l.startsWith('#EXT-X-MEDIA:')) {
      const a = attrList(l.slice(13));
      renditions.push({ type: a.TYPE ?? null, name: a.NAME ?? null, groupId: a['GROUP-ID'] ?? null, uri: a.URI ? resolve(a.URI, baseUrl) : null });
    } else if (l.startsWith('#EXT-X-I-FRAME-STREAM-INF')) continue;
  }
  if (!variants.length) throw gwError('the master playlist lists no variant streams', null, 'E_HLS_NO_VARIANTS');
  return { kind: 'master', variants, renditions };
}

function parseMedia(lines, baseUrl) {
  const out = { kind: 'media', version: 1, targetDuration: null, mediaSequence: 0, discontinuitySequence: 0, endList: false, playlistType: null, segments: [], duration: 0, partial: false };
  let seq = null;
  let disc = null;
  let key = null; // the EXT-X-KEY in force
  let dur = null;
  let title = '';
  let pendingDisc = false;
  let pdt = null;
  let range = null;
  let lastRangeEnd = null;
  let lastUri = null;
  let gap = false;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    if (l.startsWith('#')) {
      const c = l.indexOf(':');
      const tag = c < 0 ? l : l.slice(0, c);
      const v = c < 0 ? '' : l.slice(c + 1);
      switch (tag) {
        case '#EXT-X-VERSION':
          out.version = Number(v) || 1;
          break;
        case '#EXT-X-TARGETDURATION':
          out.targetDuration = Number(v);
          break;
        case '#EXT-X-MEDIA-SEQUENCE':
          out.mediaSequence = Number(v) || 0;
          break;
        case '#EXT-X-DISCONTINUITY-SEQUENCE':
          out.discontinuitySequence = Number(v) || 0;
          break;
        case '#EXT-X-ENDLIST':
          out.endList = true;
          break;
        case '#EXT-X-PLAYLIST-TYPE':
          out.playlistType = v;
          break;
        case '#EXTINF': {
          const [d, ...rest] = v.split(',');
          dur = Number(d);
          title = rest.join(',');
          if (!Number.isFinite(dur) || dur < 0) throw gwError('a segment duration in the playlist is not a number: {value}', { value: d.slice(0, 40) }, 'E_HLS_EXTINF');
          break;
        }
        case '#EXT-X-DISCONTINUITY':
          pendingDisc = true;
          break;
        case '#EXT-X-PROGRAM-DATE-TIME': {
          const ms = Date.parse(v);
          pdt = Number.isFinite(ms) ? ms : null;
          break;
        }
        case '#EXT-X-BYTERANGE': {
          const m = /^(\d+)(?:@(\d+))?$/.exec(v);
          if (!m) throw gwError('a byte range in the playlist is not valid: {value}', { value: v.slice(0, 40) }, 'E_HLS_BYTERANGE');
          range = { length: Number(m[1]), offset: m[2] !== undefined ? Number(m[2]) : null };
          break;
        }
        case '#EXT-X-KEY': {
          const a = attrList(v);
          const method = a.METHOD ?? 'NONE';
          if (method === 'NONE') key = null;
          else if (method === 'AES-128') {
            if (a.KEYFORMAT && a.KEYFORMAT !== 'identity') throw gwError('the stream is encrypted with the key system {format}, which is not supported (only AES-128 with an identity key)', { format: a.KEYFORMAT.slice(0, 80) }, 'E_HLS_KEYFORMAT');
            if (!a.URI) throw gwError('the playlist gives an AES-128 key without an address', null, 'E_HLS_KEY_URI');
            key = { method, uri: resolve(a.URI, baseUrl), iv: a.IV ?? null };
          } else if (method === 'SAMPLE-AES' || method === 'SAMPLE-AES-CTR') throw gwError('the stream uses {method} encryption, which is not supported (only whole-segment AES-128)', { method }, 'E_HLS_SAMPLE_AES');
          else throw gwError('the stream uses the encryption method {method}, which is not supported', { method: method.slice(0, 40) }, 'E_HLS_KEY_METHOD');
          break;
        }
        case '#EXT-X-MAP':
          throw gwError('the stream has fMP4 (CMAF) segments; only MPEG-TS segments are played, because MISB KLV is carried in MPEG-TS', null, 'E_HLS_FMP4');
        case '#EXT-X-GAP':
          gap = true;
          break;
        case '#EXT-X-PART':
        case '#EXT-X-PRELOAD-HINT':
          out.partial = true; // low-latency parts: the whole segments are played
          break;
        default:
          break;
      }
      continue;
    }
    // A URI line: one segment.
    if (dur === null) throw gwError('a segment in the playlist has no #EXTINF duration', null, 'E_HLS_EXTINF');
    if (seq === null) {
      seq = out.mediaSequence;
      disc = out.discontinuitySequence;
    }
    if (pendingDisc && out.segments.length) disc++;
    const uri = resolve(l, baseUrl);
    let byteRange = null;
    if (range) {
      const offset = range.offset ?? (lastUri === uri ? lastRangeEnd : null);
      if (offset === null) throw gwError('a byte range in the playlist has no offset and follows no range of the same file', null, 'E_HLS_BYTERANGE');
      byteRange = { offset, length: range.length };
      lastRangeEnd = offset + range.length;
    }
    if (out.segments.length >= MAX_SEGMENTS) throw gwError('the playlist lists more than {n} segments', { n: MAX_SEGMENTS }, 'E_HLS_TOO_LARGE');
    out.segments.push({ uri, seq, disc, discontinuity: pendingDisc, duration: dur, title, key: key ? { ...key, ivBytes: ivOf(key.iv, seq) } : null, byteRange, pdt, gap, start: out.duration });
    out.duration += dur;
    lastUri = uri;
    if (pdt !== null) pdt += dur * 1000;
    seq++;
    dur = null;
    title = '';
    pendingDisc = false;
    range = null;
    gap = false;
  }
  if (!out.segments.length && out.endList) throw gwError('the playlist lists no segments', null, 'E_HLS_EMPTY');
  if (!(out.targetDuration > 0)) {
    if (out.segments.length) out.targetDuration = Math.ceil(Math.max(...out.segments.map((s) => s.duration)));
    else throw gwError('the playlist has no #EXT-X-TARGETDURATION', null, 'E_HLS_TARGET');
  }
  out.live = !out.endList && out.playlistType !== 'VOD';
  return out;
}

/**
 * The variant to play: the best one whose codecs are H.264 or MPEG-2 video (or unknown), under a
 * bandwidth cap when one is given; the first otherwise.
 */
export function pickVariant(variants, { maxBandwidth = Infinity } = {}) {
  const ok = (v) => !v.codecs || /\b(avc1|avc3|mp4v\.6[01]|mp4v\.61)/i.test(v.codecs);
  const pool = variants.filter(ok);
  const list = (pool.length ? pool : variants).slice().sort((a, b) => b.bandwidth - a.bandwidth);
  return list.find((v) => v.bandwidth <= maxBandwidth) ?? list.at(-1);
}

/**
 * Where to start a live playlist (RFC 8216 §6.3.3): not closer to the end than three target
 * durations. → the index into `segments`.
 */
export function liveStartIndex(pl, holdBack = 3 * pl.targetDuration) {
  let acc = 0;
  for (let i = pl.segments.length - 1; i >= 0; i--) {
    acc += pl.segments[i].duration;
    if (acc >= holdBack) return i;
  }
  return 0;
}

/** How long to wait before reloading a media playlist (§6.3.4): the target duration, half of it when nothing changed. */
export function reloadDelay(pl, changed) {
  const t = Math.max(0.5, pl.targetDuration || 2);
  return (changed ? t : t / 2) * 1000;
}

/** AES-128-CBC with PKCS#7 padding (§4.3.2.4), through WebCrypto. */
export async function decryptSegment(bytes, keyBytes, iv, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw gwError('this browser has no WebCrypto, so AES-128 segments cannot be decrypted', null, 'E_HLS_NO_CRYPTO');
  if (keyBytes?.byteLength !== 16) throw gwError('the AES-128 key is {n} bytes, not 16', { n: keyBytes?.byteLength ?? 0 }, 'E_HLS_KEY_SIZE');
  if (bytes.byteLength % 16) throw gwError('an encrypted segment is not a whole number of AES blocks ({n} bytes)', { n: bytes.byteLength }, 'E_HLS_DECRYPT');
  const k = await subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv }, k, bytes));
  } catch {
    throw gwError('an AES-128 segment did not decrypt with its key (wrong key or IV, or a damaged segment)', null, 'E_HLS_DECRYPT');
  }
}
