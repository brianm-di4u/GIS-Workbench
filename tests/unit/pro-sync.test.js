// ArcGIS Pro sync, the page's end (REQ-GAP-65): the echo rule the add-in shares, and the host's
// behaviour against a fake sidecar. The real sidecar is in tests/e2e/sidecar/26-native.spec.js.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ProSyncHost, isEcho, sameView, CURSOR_PER_SECOND } from '../../app/src/sidecar/pro-sync.js';
import { viewerAffine, STEREO_MODES } from '../../app/src/sidecar/native-ui.js';

const CONTRACT = JSON.parse(readFileSync(new URL('../../sidecar/pro-addin/contract/sync-contract.json', import.meta.url), 'utf8'));
const V = { lon: -105, lat: 39.7, mpp: 2.5, rotation: 0 };

/** A sidecar that answers `next` from a list, then waits to be aborted. */
function fakeClient(script = []) {
  const calls = [];
  const client = {
    calls,
    next: [...script],
    async request(method, path, { json, signal } = {}) {
      calls.push({ method, path, json });
      if (path === '/v1/sync/attach') return { session: 'a'.repeat(48), hold_s: 25 };
      if (path.endsWith('/state')) {
        if (client.refuse) throw client.refuse;
        return { seq: calls.length };
      }
      if (method === 'DELETE') return null;
      if (client.next.length) {
        const n = client.next.shift();
        if (n instanceof Error) throw n;
        return n;
      }
      return new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
    },
  };
  return client;
}

function host(client, over = {}) {
  const applied = [];
  const cursors = [];
  let t = 1000;
  const h = new ProSyncHost({ client, name: 'page', applyView: (v) => applied.push(v), showCursor: (c) => cursors.push(c), wait: async () => {}, now: () => t, ...over });
  return { h, applied, cursors, tick: (ms) => (t += ms) };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the echo rule', () => {
  for (const c of CONTRACT.echo) it(c.name, () => expect(isEcho(c.applied, c.seen, c.after_ms)).toBe(c.echo));

  it('needs something applied', () => {
    expect(isEcho(null, V, 0)).toBe(false);
    expect(sameView(V, V)).toBe(true);
  });
});

describe('ProSyncHost', () => {
  it('asks for nothing until it is turned on', async () => {
    const c = fakeClient();
    const { h } = host(c);
    await h.localView(V);
    h.localCursor({ lon: 1, lat: 2, visible: true });
    expect(c.calls).toEqual([]);
  });

  it('follows the add-in and tells the page who is there', async () => {
    const c = fakeClient([{ seq: 4, peer: true, view: V, cursor: { lon: 1, lat: 2, visible: true } }]);
    const { h, applied, cursors } = host(c);
    await h.start('both');
    await settle();
    expect(c.calls[0].json).toEqual({ client: 'page', direction: 'both' });
    expect(applied).toEqual([V]);
    expect(cursors).toEqual([{ lon: 1, lat: 2, visible: true }]);
    expect(h.peer).toBe(true);
    expect(h.received).toBe(2);
    expect(c.calls.at(-1).path).toContain('next?after=4');
    await h.stop();
  });

  it('does not send back a view it was told to make', async () => {
    const c = fakeClient([{ seq: 1, peer: true, view: V }]);
    const { h, tick } = host(c);
    await h.start('both');
    await settle();
    expect(await h.localView({ ...V })).toBe(false);
    expect(c.calls.some((x) => x.path.endsWith('/state'))).toBe(false);
    tick(3000);
    expect(await h.localView({ ...V })).toBe(true); // the analyst came back to the same place
    await h.stop();
  });

  it('a follower publishes nothing', async () => {
    const c = fakeClient();
    const { h } = host(c);
    await h.start('app_follows');
    expect(await h.localView(V)).toBe(false);
    h.localCursor({ lon: 1, lat: 2, visible: true });
    expect(c.calls.filter((x) => x.path.endsWith('/state'))).toEqual([]);
    await h.stop();
  });

  it('limits the cursor and always sends the last move', async () => {
    const c = fakeClient();
    const { h, tick } = host(c);
    await h.start('both');
    for (let i = 0; i < 10; i++) h.localCursor({ lon: i, lat: 0, visible: true });
    const sent = () => c.calls.filter((x) => x.path.endsWith('/state')).map((x) => x.json.cursor.lon);
    expect(sent()).toEqual([0]);
    tick(1000 / CURSOR_PER_SECOND);
    await new Promise((r) => setTimeout(r, 1000 / CURSOR_PER_SECOND + 30));
    expect(sent()).toEqual([0, 9]);
    h.localCursor({ lon: 0, lat: 0, visible: false }); // leaving the map is never held back
    expect(c.calls.at(-1).json.cursor.visible).toBe(false);
    await h.stop();
  });

  it('goes off for good when the sidecar says so', async () => {
    const e = Object.assign(new Error('gone'), { status: 401 });
    const c = fakeClient([e]);
    const { h } = host(c);
    await h.start('both');
    await settle();
    expect(h.on).toBe(false);
    expect(h.error).toBe(e);
    expect(await h.localView(V)).toBe(false);
  });

  it('gives a connection error a few tries', async () => {
    const e = new Error('no answer');
    const c = fakeClient([e, e, e]);
    const { h } = host(c);
    await h.start('both');
    await new Promise((r) => setTimeout(r, 5));
    expect(h.on).toBe(false);
    expect(c.calls.filter((x) => x.path.includes('/next')).length).toBe(3);
  });

  it('a refused publish does not stop sync, and a lost pairing does', async () => {
    const c = fakeClient();
    const { h } = host(c);
    await h.start('both');
    c.refuse = Object.assign(new Error('busy'), { status: 429 });
    expect(await h.localView(V)).toBe(false);
    expect(h.on).toBe(true);
    c.refuse = Object.assign(new Error('off'), { status: 404 });
    await h.localView({ ...V, lon: 3 });
    expect(h.on).toBe(false);
  });

  it('sends one at a time, and only the newest of what waited', async () => {
    const c = fakeClient();
    const { h } = host(c);
    await h.start('both');
    const open = [];
    const plain = c.request;
    c.request = (m, p, o) => (p.endsWith('/state') ? new Promise((res) => open.push(() => plain(m, p, o).then(res))) : plain(m, p, o));
    const first = h.localView({ ...V, lon: 1 });
    await h.localView({ ...V, lon: 2 });
    await h.localView({ ...V, lon: 3 });
    h.localCursor({ lon: 4, lat: 5, visible: true });
    expect(open.length).toBe(1); // the first is still out, and nothing overtakes it
    open.shift()();
    await settle();
    expect(open.length).toBe(1);
    open.shift()();
    await first;
    const sent = c.calls.filter((x) => x.path.endsWith('/state')).map((x) => x.json);
    expect(sent).toEqual([{ view: { ...V, lon: 1 } }, { view: { ...V, lon: 3 }, cursor: { lon: 4, lat: 5, visible: true } }]);
    await h.stop();
  });

  it('stopping tells the sidecar and forgets the session', async () => {
    const c = fakeClient();
    const { h } = host(c);
    await h.start('both');
    await h.stop();
    expect(c.calls.at(-1).method).toBe('DELETE');
    expect(h.session).toBe(null);
    await h.stop();
    expect(c.calls.filter((x) => x.method === 'DELETE').length).toBe(1);
  });
});

describe('the stereo dialog', () => {
  it('turns the panel affine round for the viewer', () => {
    // Panel: x = c0 + cu·u + cv·v. Viewer: x = a·u + b·v + c.
    const [c0, cu, cv, d0, du, dv] = [10, 0.9, 0.1, 20, -0.1, 0.8];
    const [a, b, c, d, e, f] = viewerAffine([c0, cu, cv, d0, du, dv]);
    const [u, v] = [33, 44];
    expect(a * u + b * v + c).toBeCloseTo(c0 + cu * u + cv * v);
    expect(d * u + e * v + f).toBeCloseTo(d0 + du * u + dv * v);
  });

  it('offers the modes the API has', () => {
    const schema = JSON.parse(readFileSync(new URL('../../sidecar/schema/api.schema.json', import.meta.url), 'utf8'));
    const text = JSON.stringify(schema.types.StereoRequest);
    for (const [m] of STEREO_MODES) expect(text).toContain(`"${m}"`);
  });
});
