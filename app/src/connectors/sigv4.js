// AWS Signature Version 4 for S3-compatible storage (REQ-CON-04, REQ-CON-05: AWS S3, MinIO, GCS
// interoperability with HMAC keys). SubtleCrypto HMAC-SHA256; keys live only in memory (the
// REQ-AI-03 rule). Only GET and HEAD of objects and bucket listings are signed; the payload is
// always empty, so x-amz-content-sha256 is the hash of the empty string.

const enc = new TextEncoder();
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}

async function sha256Hex(s) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

/** RFC 3986 encoding as SigV4 wants it (keep unreserved characters; '/' kept in paths). */
const uriEncode = (s, keepSlash = false) => {
  const e = encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? e.replace(/%2F/g, '/') : e;
};

/**
 * Sign a request. creds = {accessKeyId, secretAccessKey, sessionToken?, region, service = 's3'}.
 * Returns {url, init} with the Authorization, x-amz-date and x-amz-content-sha256 headers.
 */
export async function signV4(url, init = {}, creds, now = new Date()) {
  const u = new URL(url);
  const method = (init.method ?? 'GET').toUpperCase();
  const service = creds.service ?? 's3';
  const region = creds.region ?? 'us-east-1';
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers = { ...(init.headers ?? {}) };
  const signed = { host: u.host, 'x-amz-content-sha256': EMPTY_SHA256, 'x-amz-date': amzDate };
  if (creds.sessionToken) signed['x-amz-security-token'] = creds.sessionToken;
  for (const [k, v] of Object.entries(headers)) if (/^range$/i.test(k)) signed.range = v;
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(signed[n]).trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const path = u.pathname.split('/').map((p) => uriEncode(decodeURIComponent(p), false)).join('/');
  const canonical = [method, path || '/', query, canonicalHeaders, signedHeaders, EMPTY_SHA256].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonical)].join('\n');
  let key = await hmac(`AWS4${creds.secretAccessKey}`, day);
  key = await hmac(key, region);
  key = await hmac(key, service);
  key = await hmac(key, 'aws4_request');
  const signature = hex(await hmac(key, toSign));
  const out = { ...headers, 'x-amz-date': amzDate, 'x-amz-content-sha256': EMPTY_SHA256, Authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
  if (creds.sessionToken) out['x-amz-security-token'] = creds.sessionToken;
  return { url, init: { ...init, headers: out } };
}
