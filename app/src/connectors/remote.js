// Remote files (REQ-CON-01, REQ-CON-03): a File-like object over HTTP Range requests that every
// reader (geotiff.js, the NITF parser, the fingerprint) can use as if it were a local File. All
// requests run on the main thread through the logged, Online-gated fetch (REQ-NET-02,
// REQ-SEC-12), signed when a connection needs it (SigV4, SAS); workers read their byte ranges
// through the pool (workers/pool.js 'range' messages), so they never fetch on their own.
// Requests ask for credentials:'omit'; the logged fetch turns that into 'include' only for an
// origin the user marked "use my sign-in", and adds the bearer token of an OIDC sign-in to its
// own origin (connectors/auth.js, REQ-GAP-09/10).

import { gwError } from '../i18n/index.js';

let nextId = 1;

/** https URL for s3:// and gs:// paths (path-style, so no wildcard origins are needed). */
export function httpsUrl(u, { region = null } = {}) {
  const t = String(u).trim();
  let m = /^s3:\/\/([^/]+)\/?(.*)$/i.exec(t);
  if (m) {
    const [, bucket, key] = m;
    const r = region ?? KNOWN_REGIONS[bucket] ?? 'us-east-1';
    return r === 'us-east-1' ? `https://s3.amazonaws.com/${bucket}/${key}` : `https://s3.${r}.amazonaws.com/${bucket}/${key}`;
  }
  m = /^gs:\/\/([^/]+)\/?(.*)$/i.exec(t);
  if (m) return `https://storage.googleapis.com/${m[1]}/${m[2]}`;
  return t;
}

/** Regions of the open-data buckets the app knows (path-style endpoints are per region). */
export const KNOWN_REGIONS = {
  'maxar-opendata': 'us-west-2',
  'umbra-open-data-catalog': 'us-west-2',
  'sentinel-cogs': 'us-west-2',
  'sentinel-s2-l2a-cogs': 'us-west-2',
  'naip-analytic': 'us-west-2',
  'usgs-landsat': 'us-west-2',
  'copernicus-dem-30m': 'eu-central-1',
  'elevation-tiles-prod': 'us-east-1',
};

/**
 * Open a URL as a File-like object. `sign(url, init)` (optional) returns a signed
 * {url, init} for each request; `purpose` names the requests in the Network Log.
 */
export async function remoteFile(app, url, { name = null, purpose = null, sign = null, size = null } = {}) {
  const href = httpsUrl(url);
  let host;
  try {
    host = new URL(href).host;
  } catch {
    throw gwError('"{text}" is not a URL', { text: String(url) }, 'E_NOT_A_URL');
  }
  const fetch = app.netlog.fetchFor(purpose ?? `Open: ${host}`);
  const go = async (u, init) => {
    const s = sign ? await sign(u, init) : { url: u, init };
    return fetch(s.url, s.init);
  };
  let total = size;
  if (!Number.isFinite(total)) {
    const r = await go(href, { credentials: 'omit', headers: { Range: 'bytes=0-0' } });
    // A server that asks for a sign-in the user has not set up for it (REQ-GAP-09/10): say where to set it up.
    if (r.status === 401 && !sign && !app.auth?.policy?.get(new URL(href).origin)) throw gwError('{host} asks you to sign in (HTTP 401). Set up its origin in Online ▸ Sign-In for Data Origins.', { host }, 'E_REMOTE_SIGNIN');
    if (r.status === 403 || r.status === 401) throw gwError('{host} refused access (HTTP {status}): the object is private, or the bucket is requester-pays', { host, status: String(r.status) }, 'E_REMOTE_DENIED');
    if (r.status !== 206 && r.status !== 200) throw new Error(`${host}: HTTP ${r.status}`);
    total = Number(/\/(\d+)$/.exec(r.headers.get('content-range') ?? '')?.[1]);
    await r.arrayBuffer().catch(() => null);
    if (r.status === 200 && !Number.isFinite(total)) throw gwError('{host} does not answer byte-range requests; the file would have to be downloaded whole', { host }, 'E_REMOTE_NO_RANGES');
    // S3 and others hide Content-Range from CORS (TE-045); Content-Length of a HEAD is safelisted.
    if (!Number.isFinite(total)) {
      const h = await go(href, { method: 'HEAD', credentials: 'omit' }).catch(() => null);
      const n = Number(h?.headers.get('content-length'));
      if (h?.ok && n > 0) total = n;
    }
    if (!Number.isFinite(total)) throw gwError('{host} did not say how large the file is (no Content-Range or Content-Length visible to the browser)', { host }, 'E_REMOTE_NO_SIZE');
  }
  const fname = name ?? decodeURIComponent(new URL(href).pathname.split('/').pop() || 'remote.tif');
  const remoteId = `r${nextId++}`;
  const stats = { ranges: 0, bytes: 0 };
  const read = async (a, b) => {
    const end = Math.min(total, b);
    if (end <= a) return new ArrayBuffer(0);
    const q = await go(href, { credentials: 'omit', headers: { Range: `bytes=${a}-${end - 1}` } });
    if (q.status !== 206 && !(q.status === 200 && a === 0 && end >= total)) throw gwError('{file}: bytes {from}–{to} failed (HTTP {status})', { file: fname, from: String(a), to: String(end), status: String(q.status) }, 'E_REMOTE_RANGE');
    const buf = await q.arrayBuffer();
    stats.ranges++;
    stats.bytes += buf.byteLength;
    return buf;
  };
  const f = {
    name: fname,
    size: total,
    type: '',
    lastModified: 0,
    url: href,
    remote: true,
    remoteId,
    stats,
    slice: (a = 0, b = total) => ({ size: Math.max(0, Math.min(total, b) - a), arrayBuffer: () => read(a, b), text: async () => new TextDecoder().decode(await read(a, b)) }),
    arrayBuffer: () => read(0, total),
  };
  app.pool.remote ??= new Map();
  app.pool.remote.set(remoteId, { read, name: fname });
  return f;
}

/** What a worker receives for a file: a remote file goes by id (workers/worker-core.js). */
export function forWorker(file) {
  return file?.remote ? { remoteId: file.remoteId, name: file.name, size: file.size } : file;
}
