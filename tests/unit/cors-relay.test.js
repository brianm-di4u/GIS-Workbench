// The CORS relay, the page's end and its gates (REQ-GAP-08, OD-2.17): it stays off in every shipped
// build, and each of the app's locks is tested here. The sidecar's are in
// sidecar/gwb-sidecar/tests/{shipped,corsrelay}.rs.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CorsRelayHost } from '../../app/src/sidecar/cors-relay.js';
import { NetLog } from '../../app/src/ai/netlog.js';
import { airgapStrip, AIRGAP_OMIT } from '../../build/airgap.mjs';
import { relayGate, RELAY_MARKERS } from '../../sidecar/installer/shipped-gate.mjs';

const ORIGIN = 'https://data.example.org';

function relayClient(respond) {
  const calls = [];
  return {
    calls,
    async request(method, path, o) {
      calls.push({ method, path, json: o.json });
      return respond();
    },
  };
}

const ok = () => new Response('hello', { status: 200, headers: { 'x-gwb-relay-status': '206', 'x-gwb-relay-content-type': 'text/plain', 'x-gwb-relay-content-range': 'bytes 0-4/9', 'set-cookie': 'a=b' } });

describe('CorsRelayHost', () => {
  it('covers only what the gate, the analyst and the method allow', () => {
    let gate = false;
    const h = new CorsRelayHost({ client: relayClient(ok), allowed: () => gate });
    h.origins.add(ORIGIN);
    expect(h.covers(ORIGIN)).toBe(false); // what every shipped sidecar reports
    gate = true;
    expect(h.covers(ORIGIN)).toBe(true);
    expect(h.covers(ORIGIN, 'HEAD')).toBe(true);
    for (const m of ['POST', 'PUT', 'DELETE']) expect(h.covers(ORIGIN, m)).toBe(false);
    expect(h.covers('https://other.example.org')).toBe(false);
  });

  it('sends the narrow request and rebuilds the response', async () => {
    const c = relayClient(ok);
    const h = new CorsRelayHost({ client: c, allowed: () => true });
    const r = await h.fetch(`${ORIGIN}/a?b=1`, { headers: { Range: 'bytes=0-4', Accept: 'text/plain', Cookie: 'x=y', Authorization: 'Bearer z' } });
    expect(c.calls[0].path).toBe('/v1/cors-relay/fetch');
    expect(c.calls[0].json).toEqual({ url: `${ORIGIN}/a?b=1`, method: 'GET', accept: 'text/plain', range: 'bytes=0-4' });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe('bytes 0-4/9');
    expect(r.headers.get('set-cookie')).toBe(null);
    expect(await r.text()).toBe('hello');
  });

  it('passes a refusal on by its code', async () => {
    const h = new CorsRelayHost({ client: relayClient(() => new Response(JSON.stringify({ code: 'not_listed', error: 'no' }), { status: 403 })), allowed: () => true });
    await expect(h.fetch(ORIGIN)).rejects.toMatchObject({ code: 'not_listed', status: 403 });
  });
});

describe('the request log', () => {
  const app = (over) => ({ emit() {}, network: { isOnline: () => true }, sidecar: {}, ...over });

  it('a relayed call is logged, and needs no CSP entry', async () => {
    const a = app();
    const h = new CorsRelayHost({ client: relayClient(ok), allowed: () => true });
    h.origins.add(ORIGIN);
    a.sidecar.corsRelay = h;
    const log = new NetLog(a);
    const r = await log.fetchFor('test')(`${ORIGIN}/x`);
    expect(r.status).toBe(206);
    expect(log.entries[0]).toMatchObject({ origin: ORIGIN, relay: true, status: 206, purpose: 'test' });
  });

  it('never runs while Offline', async () => {
    const c = relayClient(ok);
    const a = app({ network: { isOnline: () => false } });
    const h = new CorsRelayHost({ client: c, allowed: () => true });
    h.origins.add(ORIGIN);
    a.sidecar.corsRelay = h;
    const log = new NetLog(a);
    await expect(log.fetchFor('test')(`${ORIGIN}/x`)).rejects.toMatchObject({ code: 'E_OFFLINE' });
    expect(c.calls).toEqual([]);
    expect(log.entries[0].status).toBe('offline');
  });

  it('a refusal is logged by its code', async () => {
    const a = app();
    const h = new CorsRelayHost({ client: relayClient(() => new Response(JSON.stringify({ code: 'private_target', error: 'no' }), { status: 403 })), allowed: () => true });
    h.origins.add(ORIGIN);
    a.sidecar.corsRelay = h;
    const log = new NetLog(a);
    await expect(log.fetchFor('test')(`${ORIGIN}/x`)).rejects.toThrow();
    expect(log.entries[0]).toMatchObject({ relay: true, status: 'private_target' });
  });

  it('with no relay nothing changes', async () => {
    const log = new NetLog(app());
    await expect(log.fetchFor('test')(`${ORIGIN}/x`)).rejects.toThrow(); // the CSP check, which needs a page
    expect(log.entries.some((e) => e.relay)).toBe(false);
  });
});

describe('the air-gapped file', () => {
  const man = { build: { profile: 'standard' }, curated: [], blocks: { 'js-corsrelay': { sha256: 'a' }, 'js-relay': { sha256: 'b' } } };
  const html = `<meta http-equiv="Content-Security-Policy" id="csp" content="connect-src blob: https://x.example; object-src 'none'"><script type="application/json" id="build-manifest">${JSON.stringify(man)}</script>
<script type="application/octet-stream" id="blk-js-relay" data-kind="js" data-sha256="b">QUJD</script>
<script type="application/octet-stream" id="blk-js-corsrelay" data-kind="js" data-sha256="a">REVG</script>
<p>after</p>`;

  it('has no relay block, and names it as left out', () => {
    expect(AIRGAP_OMIT).toContain('js-corsrelay');
    const out = airgapStrip(html);
    expect(out).not.toContain('blk-js-corsrelay');
    expect(out).not.toContain('REVG');
    expect(out).toContain('blk-js-relay');
    expect(out).toContain('<p>after</p>');
    const m = JSON.parse(/id="build-manifest">([^<]*)</.exec(out)[1]);
    expect(m.blocks['js-corsrelay']).toBeUndefined();
    expect(m.omitted).toContain('js-corsrelay');
  });
});

describe('the package gate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gwb-gate-'));
  it('passes a clean binary', () => {
    const f = join(dir, 'clean.exe');
    writeFileSync(f, Buffer.from('MZ just a service'));
    expect(relayGate([f])).toEqual([]);
  });
  for (const m of RELAY_MARKERS)
    it(`refuses a binary holding ${m}`, () => {
      const f = join(dir, `x${RELAY_MARKERS.indexOf(m)}.exe`);
      writeFileSync(f, Buffer.concat([Buffer.alloc(1000, 1), Buffer.from(m), Buffer.alloc(1000, 2)]));
      const p = relayGate([f]);
      expect(p.length).toBe(1);
      expect(p[0]).toContain('OD-2.17');
    });
});
