// OGC 3D Tiles in the 3D pane (REQ-STR-15): a tileset.json from an online source (its origin in
// this file's network allow-list; every request through the network log) is traversed each frame
// by screen-space error: a tile whose geometric error spans more than `maxSse` pixels refines to
// its children (REPLACE hides the parent once they are ready; ADD keeps it). Content is b3dm
// (glTF inside, RTC_CENTER honoured) or glb/gltf (3D Tiles 1.1). glTF is Y-up; the tile frame is
// Z-up; tile transforms chain to ECEF; every vertex is then converted to the view's local frame
// (east, north metres from the view origin; up = HAE), so tiles line up with terrain and clouds.

import { gltfExtensions, gltfLoader, refuseUndecodable } from './gltf-ext.js';

const A = 6378137;
const E2 = 0.0066943799901413165;

export function ecefToGeo(x, y, z) {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2));
  let h = 0;
  for (let i = 0; i < 6; i++) {
    const s = Math.sin(lat);
    const n = A / Math.sqrt(1 - E2 * s * s);
    h = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - (E2 * n) / (n + h)));
  }
  return { lat: (lat * 180) / Math.PI, lon: (lon * 180) / Math.PI, h };
}

export function geoToEcef(lat, lon, h) {
  const [la, lo] = [(lat * Math.PI) / 180, (lon * Math.PI) / 180];
  const s = Math.sin(la);
  const n = A / Math.sqrt(1 - E2 * s * s);
  return [(n + h) * Math.cos(la) * Math.cos(lo), (n + h) * Math.cos(la) * Math.sin(lo), (n * (1 - E2) + h) * s];
}

const mul4 = (a, b) => {
  // Column-major 4 × 4.
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const apply4 = (m, x, y, z) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// glTF (Y-up) → 3D Tiles (Z-up): +90° about X.
const Y_UP_TO_Z_UP = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];

/** Bounding sphere (ECEF centre, radius) of a bounding volume under `m`. */
function sphereOf(bv, m) {
  if (bv.region) {
    const [w, s, e, n, h0, h1] = bv.region;
    const lat = ((s + n) / 2) * (180 / Math.PI);
    const lon = ((w + e) / 2) * (180 / Math.PI);
    const c = geoToEcef(lat, lon, (h0 + h1) / 2);
    const corner = geoToEcef(s * (180 / Math.PI), w * (180 / Math.PI), h0);
    return { c, r: Math.hypot(c[0] - corner[0], c[1] - corner[1], c[2] - corner[2]) };
  }
  if (bv.box) {
    const b = bv.box;
    const c = apply4(m, b[0], b[1], b[2]);
    const r = Math.hypot(b[3], b[4], b[5]) + Math.hypot(b[6], b[7], b[8]) + Math.hypot(b[9], b[10], b[11]);
    return { c, r };
  }
  const s = bv.sphere ?? [0, 0, 0, 1];
  return { c: apply4(m, s[0], s[1], s[2]), r: s[3] };
}

export class Tileset {
  /** view: View3D; url: tileset.json URL; fetch: the logged fetch. */
  constructor(view, url, fetch, { maxSse = 16, name = '3D Tiles' } = {}) {
    this.view = view;
    this.url = url;
    this.fetch = fetch;
    this.maxSse = maxSse;
    this.name = name;
    this.group = new view.T.Group();
    view.world.add(this.group);
    this.root = null;
    this.stats = { requested: 0, loaded: 0, failed: 0, visible: 0, triangles: 0 };
    this.loading = 0;
  }

  async load() {
    const r = await this.fetch(this.url, { credentials: 'omit' });
    if (!r.ok) throw new Error(`${this.url}: HTTP ${r.status}`);
    const ts = await r.json();
    if (!ts.root) throw new Error('not a 3D Tiles tileset (no root)');
    this.asset = ts.asset ?? {};
    this.root = this._node(ts.root, IDENT, this.url, null);
    // A tileset with no transform to ECEF (test packages in a unit box) sits at the Earth's centre:
    // nothing places it, and every vertex would convert to NaN.
    if (Math.hypot(...this.root.sphere.c) < 6.0e6) throw new Error('the tileset is not georeferenced: its root sits near the Earth\'s centre (no transform to ECEF), so it cannot be placed');
    // The view's frame: the root's centre when nothing else fixed it.
    if (!this.view.origin) {
      const g = ecefToGeo(...this.root.sphere.c);
      const s = Math.sin((g.lat * Math.PI) / 180);
      const w = 1 - E2 * s * s;
      this.view.setOrigin({ lat0: g.lat, lon0: g.lon, kx: ((A / Math.sqrt(w)) * Math.cos((g.lat * Math.PI) / 180) * Math.PI) / 180, ky: (((A * (1 - E2)) / (w * Math.sqrt(w))) * Math.PI) / 180 });
      this.view.lookAtLocal?.(0, 0, g.h, this.root.sphere.r);
    }
    this.view.invalidate();
    return this;
  }

  _node(j, parentM, base, parent) {
    const m = j.transform ? mul4(parentM, j.transform) : parentM;
    const n = { j, m, base, parent, children: [], state: 'none', object: null, sphere: sphereOf(j.boundingVolume, m), refine: (j.refine ?? parent?.refine ?? 'REPLACE').toUpperCase() };
    // 3D Tiles 1.1 tiles may carry several contents (`contents`); 1.0 has one (`content`).
    n.uris = (j.contents ?? (j.content ? [j.content] : [])).map((c) => c.uri ?? c.url).filter(Boolean);
    n.children = (j.children ?? []).map((c) => this._node(c, m, base, n));
    return n;
  }

  /** Called before each render: traverse, request, show/hide. */
  update() {
    if (!this.root) return;
    const v = this.view;
    const cam = v.camera;
    const hpx = v.canvas.height || 1;
    const k = hpx / (2 * Math.tan((cam.fov * Math.PI) / 360));
    const camLocal = cam.position;
    const want = new Set();
    let visible = 0;
    const visit = (n) => {
      const g = ecefToGeo(...n.sphere.c);
      const [e, nn] = v.toLocal(g.lat, g.lon);
      const d = Math.max(1e-3, Math.hypot(camLocal.x - e, camLocal.y - nn, camLocal.z - g.h) - n.sphere.r);
      const sse = (n.j.geometricError * k) / d;
      const refine = sse > this.maxSse && n.children.length;
      if (refine) {
        const ready = n.children.every((c) => !c.uris.length || c.state === 'ready');
        if (n.refine === 'ADD' || !ready) want.add(n);
        n.children.forEach(visit);
      } else want.add(n);
    };
    visit(this.root);
    // Hide everything, then show the wanted nodes that are ready; request the rest.
    const all = [];
    const walk = (n) => (all.push(n), n.children.forEach(walk));
    walk(this.root);
    for (const n of all) {
      const on = want.has(n);
      if (n.object) n.object.visible = on && n.state === 'ready';
      if (on && n.uris.length && n.state === 'none') this._request(n);
      if (on && n.state === 'ready') visible++;
    }
    this.stats.visible = visible;
  }

  async _request(n) {
    n.state = 'loading';
    this.stats.requested++;
    this.loading++;
    try {
      const objs = [];
      for (const uri of n.uris) {
        const url = new URL(uri, n.base).href;
        const r = await this.fetch(url, { credentials: 'omit' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const b = new Uint8Array(await r.arrayBuffer());
        const magic = String.fromCharCode(...b.subarray(0, 4));
        let glb = b;
        let rtc = null;
        if (magic === 'b3dm') {
          const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
          const ftJ = dv.getUint32(12, true);
          const ftB = dv.getUint32(16, true);
          const btJ = dv.getUint32(20, true);
          const btB = dv.getUint32(24, true);
          if (ftJ) {
            const ft = JSON.parse(new TextDecoder().decode(b.subarray(28, 28 + ftJ)));
            if (ft.RTC_CENTER) rtc = ft.RTC_CENTER;
          }
          glb = b.subarray(28 + ftJ + ftB + btJ + btB);
        } else if (/\.json$/i.test(url) && b[0] === 0x7b) {
          // An external tileset: graft its root under this node.
          const ts = JSON.parse(new TextDecoder().decode(b));
          n.children.push(this._node(ts.root, n.m, url, n));
          continue;
        } else if (magic !== 'glTF' && b[0] !== 0x7b) throw new Error(`unsupported tile content "${magic}"`);
        objs.push(await this._gltf(glb, n.m, rtc, url));
      }
      if (objs.length) {
        const obj = objs.length === 1 ? objs[0] : objs.reduce((g, o) => (g.add(o), g), new this.view.T.Group());
        n.object = obj;
        obj.visible = false;
        this.group.add(obj);
      }
      n.state = 'ready';
      this.stats.loaded++;
    } catch (e) {
      n.state = 'failed';
      this.stats.failed++;
      this.view.app.log('warn', `3D Tiles ${this.name}: ${e.message}`);
    } finally {
      this.loading--;
      this.view.invalidate();
    }
  }

  /** glTF → a group whose vertices are in the view's local frame. */
  async _gltf(bytes, m, rtc, url) {
    const T = this.view.T;
    refuseUndecodable(bytes, '3D Tiles content');
    // External buffers and images (a .gltf beside its .bin in a tileset or a .3tz) come through the
    // tileset's own fetch — the archive, or the network log for an online source — as blob: URLs;
    // embedded data: URIs become blobs too. Left to the loader they resolved against the page and
    // broke the CSP (TE archive: 3d-tiles-3tz-cesium-test-packages).
    const blobs = new Map();
    const { json } = gltfExtensions(bytes);
    for (const r of [...(json?.buffers ?? []), ...(json?.images ?? [])]) {
      if (!r.uri || /^blob:/i.test(r.uri) || blobs.has(r.uri)) continue;
      let data;
      if (/^data:/i.test(r.uri)) {
        const mm = /^data:([^;,]*)(;base64)?,(.*)$/is.exec(r.uri);
        if (!mm) continue;
        data = new Blob([mm[2] ? Uint8Array.from(atob(mm[3]), (ch) => ch.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(mm[3]))], { type: mm[1] || 'application/octet-stream' });
      } else {
        const res = await this.fetch(new URL(r.uri, url).href, { credentials: 'omit' });
        if (!res.ok) throw new Error(`${r.uri}: HTTP ${res.status}`);
        data = await res.blob();
      }
      blobs.set(r.uri, URL.createObjectURL(data));
    }
    const manager = new T.LoadingManager();
    manager.setURLModifier((u) => blobs.get(u) ?? u);
    const loader = gltfLoader(T, manager);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    let gltf;
    try {
      gltf = await new Promise((res, rej) => loader.parse(buf, '', res, rej));
    } finally {
      for (const b of blobs.values()) URL.revokeObjectURL(b);
    }
    const scene = gltf.scene;
    scene.updateMatrixWorld(true);
    const M = mul4(m, rtc ? mul4([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, rtc[0], rtc[1], rtc[2], 1], Y_UP_TO_Z_UP) : Y_UP_TO_Z_UP);
    const out = new T.Group();
    const v = this.view;
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const [x, y, z] = apply4(M, p.getX(i), p.getY(i), p.getZ(i));
        const geo = ecefToGeo(x, y, z);
        const [e, nn] = v.toLocal(geo.lat, geo.lon);
        p.setXYZ(i, e, nn, geo.h);
      }
      p.needsUpdate = true;
      g.computeVertexNormals();
      g.computeBoundingSphere();
      this.stats.triangles += (g.index ? g.index.count : p.count) / 3;
      const mat = o.material?.clone?.() ?? new T.MeshLambertMaterial({ color: 0xcccccc });
      mat.side = T.DoubleSide;
      out.add(new T.Mesh(g, mat));
    });
    return out;
  }

  dispose() {
    this.view.world.remove(this.group);
    this.group.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose?.();
    });
  }
}
