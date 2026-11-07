// I3S scene layers in the 3D pane (REQ-GAP-35): the node tree is traversed each frame with the
// layer's own LOD metric (maxScreenThresholdSQ: a node is drawn while the screen area of its
// bounding sphere stays under its lodThreshold, else its children replace it once they are all
// ready; node-switching, never parent and children together). Nodes outside the view frustum are
// skipped. Node pages, geometry, textures load on demand, at most `concurrency` at a time,
// biggest on screen first; nodes not wanted are dropped when the loaded vertices pass `budget`.
// Vertices are placed in the view's local frame (east, north metres from the view origin; up =
// height above the ellipsoid), so scene layers line up with terrain, clouds and 3D Tiles.

import { NodeTree, nodeGeometry, nodeSphere, nodeTexture, nodeAttributes } from '../formats/i3s-scene.js';
import { gwError } from '../i18n/index.js';

const E2 = 0.0066943799901413165;
const A = 6378137;
/** Metres per degree of longitude and latitude on WGS 84 at `lat`. */
function frame(lat) {
  const s = Math.sin((lat * Math.PI) / 180);
  const w = 1 - E2 * s * s;
  return { kx: ((A / Math.sqrt(w)) * Math.cos((lat * Math.PI) / 180) * Math.PI) / 180, ky: (((A * (1 - E2)) / (w * Math.sqrt(w))) * Math.PI) / 180 };
}

export class I3sLayer {
  /**
   * view: View3D; store: SlpkStore / ServiceStore; info: describeLayer(); decode: {plain, draco};
   * opts: {name, undulation(lat, lon), budget (vertices), concurrency, terrainHeight, log}.
   */
  constructor(view, store, info, decode, { name = info.name, undulation = () => 0, budget = 6e6, concurrency = 6, lodScale = 1, log = () => {} } = {}) {
    this.view = view;
    this.store = store;
    this.info = info;
    this.decode = decode;
    this.name = name;
    this.undulation = undulation;
    this.budget = budget;
    this.concurrency = concurrency;
    this.lodScale = lodScale;
    this.log = log;
    this.tree = new NodeTree(store, info);
    this.group = new view.T.Group();
    this.group.name = name;
    view.world.add(this.group);
    this.recs = new Map(); // node index → {node, sphere, viewC, state, object, vertices, used}
    this.pendingNodes = new Set();
    this.loading = 0;
    this.queue = [];
    this.frame = 0;
    this.stats = { nodes: 0, requested: 0, loaded: 0, failed: 0, visible: 0, vertices: 0, triangles: 0, points: 0, textured: 0, untextured: 0, dropped: 0, maxDepth: 0, pages: 0 };
    this.warnings = new Set();
    this.errors = [];
    this.disposed = false;
  }

  async load() {
    const root = await this.tree.node(this.info.nodePages.rootIndex);
    if (!root) throw gwError('{file}: the root node is missing', { file: this.store.name }, 'E_I3S_NO_ROOT');
    const rec = this._rec(root, 0);
    const v = this.view;
    if (!v.origin) {
      v.setOrigin({ lat0: rec.sphere.lat, lon0: rec.sphere.lon, ...frame(rec.sphere.lat) });
      rec.viewC = null;
      const [e, n, z] = this._viewC(rec);
      v.lookAtLocal?.(e, n, z, Math.max(50, rec.sphere.r));
    }
    v.invalidate();
    return this;
  }

  /** Aim the view at the layer's root bounding sphere. */
  lookAt() {
    const r = this.recs.get(this.info.nodePages.rootIndex);
    if (!r) return;
    const [e, n, z] = this._viewC(r);
    this.view.lookAtLocal?.(e, n, z, Math.max(50, r.sphere.r));
  }

  _rec(node, depth) {
    let r = this.recs.get(node.index);
    if (r) return r;
    const s = nodeSphere(this.info, node);
    if (s && this.info.gravity) s.h += this.undulation(s.lat, s.lon);
    r = { node, depth, sphere: s ?? { lon: 0, lat: 0, h: 0, r: 0 }, viewC: null, state: 'none', object: null, vertices: 0, used: 0 };
    this.recs.set(node.index, r);
    this.stats.nodes = this.recs.size;
    this.stats.maxDepth = Math.max(this.stats.maxDepth, depth);
    return r;
  }

  _viewC(r) {
    if (!r.viewC) {
      const [e, n] = this.view.toLocal(r.sphere.lat, r.sphere.lon);
      r.viewC = [e, n, r.sphere.h];
    }
    return r.viewC;
  }

  /** The child records of `r`, asking for the node pages not read yet. */
  _children(r) {
    const ids = r.node.children ?? [];
    const out = [];
    let missing = false;
    for (const i of ids) {
      const c = this.recs.get(i);
      if (c) out.push(c);
      else {
        missing = true;
        if (!this.pendingNodes.has(i)) {
          this.pendingNodes.add(i);
          this.tree
            .node(i)
            .then((n) => n && this._rec(n, r.depth + 1))
            .catch((e) => this._fail(null, e))
            .finally(() => {
              this.pendingNodes.delete(i);
              this.stats.pages = this.tree.pages.size;
              this.view.invalidate();
            });
        }
      }
    }
    return { out, missing };
  }

  update() {
    if (this.disposed) return;
    const v = this.view;
    const T = v.T;
    const cam = v.camera;
    cam.updateMatrixWorld();
    v.world.updateMatrixWorld();
    const fr = new T.Frustum().setFromProjectionMatrix(new T.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const hpx = v.canvas.height || 1;
    const k = hpx / (2 * Math.tan((cam.fov * Math.PI) / 360));
    const m = v.world.matrixWorld;
    const camP = cam.position;
    const tmp = new T.Vector3();
    const sph = new T.Sphere();
    const want = [];
    this.frame++;
    const visible = (r) => {
      const [e, n, z] = this._viewC(r);
      tmp.set(e, n, z).applyMatrix4(m);
      sph.set(tmp, Math.max(r.sphere.r, 0.01) * Math.max(1, v.exaggeration ?? 1));
      return { inside: fr.intersectsSphere(sph), d: Math.max(1e-3, camP.distanceTo(tmp) - r.sphere.r) };
    };
    const visit = (r) => {
      const { inside, d } = visible(r);
      if (!inside) return true; // culled: counts as ready for its parent's replacement
      const rp = (r.sphere.r * k) / Math.max(d, r.sphere.r * 0.05, 1e-3);
      r.area = Math.PI * rp * rp;
      const hasMesh = !!r.node.mesh?.geometry;
      const thr = (r.node.lodThreshold ?? 0) * this.lodScale;
      const canRefine = (r.node.children?.length ?? 0) > 0;
      if (canRefine && (!hasMesh || r.area > thr)) {
        const { out, missing } = this._children(r);
        let ready = !missing;
        for (const c of out) if (!visit(c)) ready = false;
        if (!ready && hasMesh) want.push(r);
        return ready || (hasMesh && r.state === 'ready');
      }
      if (hasMesh) {
        want.push(r);
        return r.state === 'ready' || r.state === 'failed';
      }
      return true;
    };
    const root = this.recs.get(this.info.nodePages.rootIndex);
    if (root) visit(root);
    const on = new Set(want);
    let vis = 0;
    for (const r of this.recs.values()) {
      const show = on.has(r) && r.state === 'ready';
      if (r.object) r.object.visible = show;
      if (show) vis++;
      if (on.has(r)) r.used = this.frame;
    }
    this.stats.visible = vis;
    // Requests: biggest on screen first.
    const todo = want.filter((r) => r.state === 'none').sort((a, b) => (b.area ?? 0) - (a.area ?? 0));
    for (const r of todo) {
      if (this.loading >= this.concurrency) break;
      this._request(r);
    }
    this._trim(on);
  }

  _trim(on) {
    if (this.stats.vertices <= this.budget) return;
    const old = [...this.recs.values()].filter((r) => r.state === 'ready' && !on.has(r)).sort((a, b) => a.used - b.used);
    for (const r of old) {
      if (this.stats.vertices <= this.budget * 0.8) break;
      this._drop(r);
    }
  }

  _drop(r) {
    if (r.object) {
      this.group.remove(r.object);
      r.object.traverse((o) => {
        o.geometry?.dispose();
        o.material?.map?.dispose();
        o.material?.dispose?.();
      });
    }
    this.stats.vertices -= r.vertices;
    r.object = null;
    r.vertices = 0;
    r.state = 'none';
    this.stats.dropped++;
  }

  _fail(r, e) {
    if (r) r.state = 'failed';
    this.stats.failed++;
    const msg = e?.message ?? String(e);
    if (this.errors.length < 50) this.errors.push(msg);
    this.log('warn', `I3S ${this.name}: ${msg}`);
  }

  async _request(r) {
    r.state = 'loading';
    this.loading++;
    this.stats.requested++;
    try {
      const g = await nodeGeometry(this.store, this.info, r.node, this.decode, this.undulation);
      let tex = null;
      if (g && g.kind === 'mesh' && g.uv0) {
        try {
          tex = await nodeTexture(this.store, this.info, r.node);
          if (tex && !tex.bytes) this.warnings.add(`textures only as ${tex.why}: shown untextured`);
        } catch (e) {
          this.warnings.add(`texture: ${e.message}`);
          tex = null;
        }
      }
      if (this.disposed) return;
      r.object = g ? await this._object(r, g, tex) : null;
      if (r.object) {
        r.object.visible = false;
        this.group.add(r.object);
      }
      r.vertices = g?.vertexCount ?? 0;
      this.stats.vertices += r.vertices;
      r.state = 'ready';
      this.stats.loaded++;
    } catch (e) {
      this._fail(r, e);
    } finally {
      this.loading--;
      this.view.invalidate();
    }
  }

  /** The three.js object of a decoded node. */
  async _object(r, g, tex) {
    const T = this.view.T;
    const n = g.vertexCount;
    const pos = new Float32Array(3 * n);
    const v = this.view;
    for (let i = 0; i < n; i++) {
      const [e, nn] = v.toLocal(g.geo[3 * i + 1], g.geo[3 * i]);
      pos[3 * i] = e;
      pos[3 * i + 1] = nn;
      pos[3 * i + 2] = g.geo[3 * i + 2];
    }
    if (g.kind === 'points' && this.info.elevationMode === 'onTheGround')
      for (let i = 0; i < n; i++) {
        const zt = v.terrainHeight?.(pos[3 * i], pos[3 * i + 1]);
        if (Number.isFinite(zt)) pos[3 * i + 2] = zt;
      }
    const geom = new T.BufferGeometry();
    geom.setAttribute('position', new T.BufferAttribute(pos, 3));
    if (g.indices) geom.setIndex(new T.BufferAttribute(g.indices, 1));
    const ud = { i3s: this, node: r.node.index, featureOf: g.featureOf, featureIds: g.featureIds, resource: g.resource };
    if (g.kind === 'points') {
      this.stats.points += n;
      const c = this.info.pointColour;
      const mat = new T.PointsMaterial({ size: 5, sizeAttenuation: false, color: c ? new T.Color(c[0] / 255, c[1] / 255, c[2] / 255) : new T.Color(0.3, 0.55, 0.8) });
      const p = new T.Points(geom, mat);
      p.userData = ud;
      p.name = `node ${r.node.index}`;
      return p;
    }
    this.stats.triangles += g.indices ? g.indices.length / 3 : n / 3;
    let uv = g.uv0;
    if (uv && g.uvRegion) {
      // Atlas regions (u0, v0, u1, v1 as 16-bit fractions): repeat within the region, per vertex.
      uv = uv.slice();
      for (let i = 0; i < n; i++) {
        const [u0, v0, u1, v1] = [g.uvRegion[4 * i] / 65535, g.uvRegion[4 * i + 1] / 65535, g.uvRegion[4 * i + 2] / 65535, g.uvRegion[4 * i + 3] / 65535];
        const u = uv[2 * i];
        const w = uv[2 * i + 1];
        uv[2 * i] = u0 + (u >= 0 && u <= 1 ? u : u - Math.floor(u)) * (u1 - u0);
        uv[2 * i + 1] = v0 + (w >= 0 && w <= 1 ? w : w - Math.floor(w)) * (v1 - v0);
      }
      this.warnings.add('texture atlas regions are applied per vertex');
    }
    let map = null;
    if (tex?.bytes) {
      map = await this._texture(tex);
      if (map) {
        geom.setAttribute('uv', new T.BufferAttribute(uv, 2));
        this.stats.textured++;
      }
    } else if (g.uv0) this.stats.untextured++;
    const white = !g.color || g.color.every((x) => x === 255);
    if (!white) geom.setAttribute('color', new T.BufferAttribute(g.color, 4, true));
    geom.computeVertexNormals();
    geom.computeBoundingSphere();
    const md = this.info.materials[r.node.mesh?.material?.definition ?? 0] ?? {};
    const bc = md.pbrMetallicRoughness?.baseColorFactor;
    const side = md.doubleSided || this.info.layerType === 'IntegratedMesh' ? T.DoubleSide : undefined;
    const opts = { side, vertexColors: !white, transparent: md.alphaMode === 'blend' };
    if (map) opts.map = map;
    if (bc) opts.color = new T.Color(bc[0], bc[1], bc[2]);
    else if (!map && white) opts.color = new T.Color(0.86, 0.84, 0.8);
    // Integrated meshes carry their lighting in the texture: drawn unlit.
    const mat = this.info.layerType === 'IntegratedMesh' && map ? new T.MeshBasicMaterial(opts) : new T.MeshLambertMaterial(opts);
    const mesh = new T.Mesh(geom, mat);
    mesh.userData = ud;
    mesh.name = `node ${r.node.index}`;
    return mesh;
  }

  async _texture(tex) {
    const T = this.view.T;
    if (tex.format === 'ktx2') {
      const k = await this.view.app?.models3dKtx2?.(this.view);
      if (!k) {
        this.warnings.add('KTX2 textures need the Basis transcoder: shown untextured');
        return null;
      }
      const t = await new Promise((res, rej) => k.parse(tex.bytes.buffer.slice(tex.bytes.byteOffset, tex.bytes.byteOffset + tex.bytes.byteLength), res, rej));
      t.flipY = false;
      return t;
    }
    const type = tex.format === 'png' ? 'image/png' : 'image/jpeg';
    const bmp = await createImageBitmap(new Blob([tex.bytes], { type }));
    const t = new T.Texture(bmp);
    t.flipY = false;
    t.colorSpace = T.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  }

  /** Traverse and wait until the nodes the current view wants have loaded (or failed), up to `ms`. */
  async settle(ms = 60000) {
    const t0 = performance.now();
    this.update();
    while ((this.loading > 0 || this.pendingNodes.size > 0 || [...this.recs.values()].some((r) => r.state === 'none' && r.used === this.frame)) && performance.now() - t0 < ms) {
      await new Promise((r) => setTimeout(r, 40));
      this.update();
    }
    return this.stats;
  }

  /** The feature under a raycast hit on this layer: {node, index, featureId, attributes}. */
  async featureAt(hit) {
    const ud = hit?.object?.userData;
    if (ud?.i3s !== this) return null;
    const vi = hit.face ? hit.face.a : hit.index;
    const idx = ud.featureOf ? ud.featureOf[vi] : 0;
    const rec = this.recs.get(ud.node);
    const attrs = await nodeAttributes(this.store, this.info, rec.node);
    const one = {};
    for (const [k, vals] of Object.entries(attrs)) one[k] = vals[idx];
    return { node: ud.node, index: idx, featureId: ud.featureIds?.[idx] ?? null, attributes: one };
  }

  /** Objects for raycasting and exports. */
  objects() {
    return [...this.recs.values()].filter((r) => r.object?.visible).map((r) => r.object);
  }

  bounds() {
    const r = this.recs.get(this.info.nodePages.rootIndex);
    if (!r) return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    const s = r.sphere;
    const dLat = s.r / 111320;
    const dLon = s.r / (111320 * Math.max(0.05, Math.cos((s.lat * Math.PI) / 180)));
    return { min: [s.lat - dLat, s.lon - dLon, s.h - s.r], max: [s.lat + dLat, s.lon + dLon, s.h + s.r] };
  }

  dispose() {
    this.disposed = true;
    for (const r of this.recs.values()) if (r.object) this._drop(r);
    this.view.world.remove(this.group);
    const i = this.view.tilesets.indexOf(this);
    if (i >= 0) this.view.tilesets.splice(i, 1);
  }
}
