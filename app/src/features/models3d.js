// 2.5 group models3d (REQ-GAP-35, REQ-GAP-68): I3S scene layers in the 3D view, and SLPK,
// OpenFlight and 3D PDF writing. This module is the lazy js-models3d block's feature code
// (lazy/models3d.lazy.js); features/models3d-lazy.js holds the commands' eager stubs.
//   3d.slpk         Open Scene Layer Package (SLPK): 3DObject, IntegratedMesh, Point layers and
//                   the 3DObject sublayers of a Building scene layer, streamed by LOD;
//   3d.i3s          the same from an I3S scene service (…/SceneServer/layers/<n>, allow-listed);
//   3d.i3sidentify  the attributes of the scene layer feature under a click;
//   3d.pdf          the 3D view's terrain, models and scene layers as a 3D PDF (PRC);
//   app.models3d.saveTerrain / exportBuildings: SLPK and OpenFlight for Hub ▸ 3D Terrain and
//                   Feature ▸ 3D Export.

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { t, gwError, msgOf } from '../i18n/index.js';
import { int } from '../i18n/format.js';
import { SlpkStore, ServiceStore, describeLayer } from '../formats/i3s-scene.js';
import { I3sLayer } from '../render/i3s-layer.js';
import { dracoPool } from '../render/i3s-draco.js';
import { writeSlpk, objectsFromModels } from '../formats/slpk-write.js';
import { writeOpenFlight } from '../formats/openflight-write.js';
import { sceneObjects, write3dPdf } from '../formats/pdf3d-write.js';
import { faceTriangles } from '../vector/mesh.js';
import { sceneLayerUrl } from '../connectors/i3s.js';
import { ktx2Loader } from '../render/gltf-ext.js';

const okCancel = () => [{ label: t('OK'), value: 'ok', primary: true }, { label: t('Cancel'), value: 'cancel' }];
const safe = (s) => String(s ?? 'model').replace(/[^\w.-]+/g, '_') || 'model';

/** deps: {saveBlob, pickFiles} (the app's own, handed over by the eager stub). */
export function install(app, deps) {
  const C = app.commands;
  const pane = () => app.activePane?.();
  let draco = null;
  const decode = {
    plain: (bytes, layout) => {
      const b = bytes.slice();
      return app.pool.run('i3s.geometry', { bytes: b, layout, maxVertices: 8e6 }, { kind: 'analysis', transfer: [b.buffer], label: t('scene layer geometry') });
    },
    draco: (bytes) => {
      if (!app.gw?.manifest?.blocks?.['wasm-draco']) throw gwError('Draco-compressed scene layer geometry needs the Draco decoder, which this file leaves out: open the Standard file', null, 'E_NO_DRACO');
      draco ??= dracoPool(app.gw);
      return draco.decode(bytes);
    },
  };
  const run = (op, data) => app.pool.run(op, data, { kind: 'analysis', label: t('scene layer package') });
  const undulation = (lat, lon) => app.core?.undulation?.(lat, lon) ?? 0;
  const log = (lvl, msg) => app.log?.(lvl, msg);
  const layers = [];
  // KTX2 (Basis) textures of scene layers, through the 3D view's KTX2 loader (render/i3s-layer.js).
  app.models3dKtx2 = (v) => (app.gw?.manifest?.blocks?.['wasm-basis'] ? ktx2Loader(v.T, app.gw, v.renderer) : null);

  /** Add the layers of a store to the 3D view → {layers, info}. */
  async function addStore(store, label, p = pane()) {
    const v = await app.scene3d.ensureView(p);
    const doc = await store.layerDocument();
    const info = describeLayer(doc, label);
    const subs = info.sublayers ? info.sublayers.filter((s) => s.visible && !s.point && store.hasSublayer(s.id)) : null;
    if (subs && !subs.length) throw gwError('{file}: the building scene layer has no 3D object sublayer to show', { file: label }, 'E_I3S_BUILDING_EMPTY');
    const out = [];
    if (subs) {
      for (const s of subs) {
        const st = store.sub(`sublayers/${s.id}/`);
        const si = describeLayer(await st.layerDocument(), `${label} / ${s.name}`);
        out.push(await addLayer(v, st, si, `${info.name} / ${s.group ? `${s.group} / ` : ''}${s.name}`));
      }
    } else out.push(await addLayer(v, store, info, info.name || label));
    // The view goes to what was opened (a layer far from the view's content is otherwise out of sight).
    out[0].lookAt();
    app.emit?.('state');
    return { layers: out, info };
  }

  async function addLayer(v, store, info, name) {
    const l = new I3sLayer(v, store, info, decode, { name, undulation, log });
    await l.load();
    v.tilesets.push(l);
    layers.push(l);
    v.invalidate();
    return l;
  }

  async function openSlpk(file, p = pane()) {
    const store = await SlpkStore.open(file, run);
    return addStore(store, file.name, p);
  }

  async function openService(url, p = pane()) {
    const layerUrl = sceneLayerUrl(url);
    const store = new ServiceStore(layerUrl, app.netlog.fetchFor(`I3S: ${new URL(layerUrl).host}`));
    return addStore(store, layerUrl, p);
  }

  const toast = (r) => {
    const l = r.layers[0];
    const n = r.layers.length;
    app.toast(n > 1 ? t('{name}: {n, plural, one {# sublayer} other {# sublayers}} of a building scene layer, streamed by level of detail', { name: r.info.name, n }) : t('{name}: I3S {type} layer, streamed by level of detail', { name: l.name, type: l.info.layerType }), { kind: 'info' });
  };

  C.implement('3d.slpk', {
    run: async () => {
      try {
        const [f] = await deps.pickFiles(app, { multiple: false, accept: ['.slpk'], description: t('Scene layer packages (I3S)') });
        if (!f) return null;
        const r = await openSlpk(f);
        toast(r);
        return r;
      } catch (e) {
        app.toast(msgOf(e), { kind: e?.code === 'E_URL_MISSING' ? 'warn' : 'error', ms: 9000 });
        return null;
      }
    },
  });
  C.implement('3d.i3s', {
    run: async () => {
      try {
        const url = h('input', { class: 'inp', type: 'url', placeholder: 'https://…/SceneServer/layers/0', 'aria-label': t('Scene layer URL'), style: { width: '100%' } });
        const ans = await modal({ title: t('Add I3S Scene Layer'), body: h('div', {}, field(t('Scene layer URL'), url), h('p', { class: 'hint' }, t('A SceneServer layer (3D objects, integrated mesh or points). The origin must be in this file’s network allow-list. Nodes stream by level of detail as you move.'))), buttons: okCancel(), id: '3d-i3s' });
        if (ans !== 'ok') return null;
        const u = url.value.trim();
        if (!/^https?:\/\/[^\s/]+/i.test(u)) throw gwError('enter the {what} URL (http:// or https://) first', { what: 'SceneServer' }, 'E_URL_MISSING');
        const r = await openService(u);
        toast(r);
        return r;
      } catch (e) {
        app.toast(msgOf(e), { kind: e?.code === 'E_URL_MISSING' ? 'warn' : 'error', ms: 9000 });
        return null;
      }
    },
  });

  /** The scene layer feature at screen point (sx, sy) of view v → featureAt() or null. */
  async function identifyAt(v, sx, sy) {
    const T = v.T;
    const r = v.canvas.getBoundingClientRect();
    const rc = new T.Raycaster();
    rc.params.Points = { threshold: 3 };
    v.world.updateMatrixWorld(true);
    rc.setFromCamera(new T.Vector2((sx / r.width) * 2 - 1, -(sy / r.height) * 2 + 1), v.camera);
    const objs = v.tilesets.filter((l) => l instanceof I3sLayer).flatMap((l) => l.objects());
    const hit = rc.intersectObjects(objs, false)[0];
    if (!hit) return null;
    return hit.object.userData.i3s.featureAt(hit);
  }
  async function showFeature(f) {
    const rows = Object.entries(f.attributes).map(([k, val]) => h('tr', {}, h('th', { scope: 'row' }, k), h('td', {}, val == null || (typeof val === 'number' && Number.isNaN(val)) ? '' : String(val))));
    await modal({ title: t('Scene Layer Feature'), body: h('div', {}, h('p', { class: 'hint' }, t('Node {node}, feature {id}', { node: String(f.node), id: f.featureId == null ? String(f.index) : String(f.featureId) })), h('table', { class: 'tbl' }, h('tbody', {}, ...rows))), buttons: [{ label: t('Close'), value: 'ok', primary: true }], id: '3d-i3sfeature' });
  }
  C.implement('3d.i3sidentify', {
    enabled: () => !!pane()?.view3d?.tilesets?.some((l) => l instanceof I3sLayer),
    run: async () => {
      const v = pane()?.view3d;
      if (!v) return;
      app.toast(t('Click a feature of a scene layer in the 3D view'), { kind: 'info' });
      v.canvas.addEventListener(
        'pointerup',
        async (e) => {
          try {
            const r = v.canvas.getBoundingClientRect();
            const f = await identifyAt(v, e.clientX - r.left, e.clientY - r.top);
            if (!f) app.toast(t('No scene layer feature there'), { kind: 'warn' });
            else await showFeature(f);
          } catch (err) {
            app.toast(msgOf(err), { kind: 'error', ms: 8000 });
          }
        },
        { once: true },
      );
    },
  });

  // ---- writers ----
  /** Terrain grid (hub/terrain3d.js terrainGrid) → objects in local metres with UVs. */
  function terrainObjects(grid) {
    const P = [];
    const UV = [];
    for (const f of grid.faces)
      for (const k of f.idx) {
        const [x, y, z] = grid.vertices[k];
        P.push(x, y, z);
        UV.push(...(grid.uv.get([x, y, z].map((v) => v.toFixed(4)).join(',')) ?? [0, 0]));
      }
    return [{ id: 'terrain', name: 'Terrain', attrs: { KIND: 'terrain' }, positions: Float64Array.from(P), uv: Float32Array.from(UV) }];
  }
  const gridToGeo = (o) => {
    const k = Math.PI / 180;
    const ex = 6378137 * Math.cos(o.lat * k) * k;
    const ny = 6378137 * k;
    return (x, y, z) => [o.lon + x / ex, o.lat + y / ny, o.h + z];
  };

  /** Hub ▸ 3D Terrain (SLPK / OpenFlight): grid from features/hub.js; texture {bytes, format}. */
  async function saveTerrain(kind, grid, { texture = null, stem = 'terrain' } = {}) {
    const objects = terrainObjects(grid);
    const toGeo = gridToGeo(grid.origin);
    if (kind === 'slpk') {
      const r = writeSlpk({ name: `${stem} terrain`, objects, toGeo, texture });
      await deps.saveBlob(app, new Blob([r.bytes], { type: 'application/octet-stream' }), { name: `${safe(stem)}_terrain.slpk`, types: ['.slpk'], description: t('Scene layer package (I3S)') });
      return r;
    }
    const texName = `${safe(stem)}_terrain.${texture?.format === 'png' ? 'png' : 'jpg'}`;
    const r = writeOpenFlight({ objects, origin: grid.origin, toGeo, texture: texture ? texName : null, name: `${stem} terrain`, terrain: true });
    await deps.saveBlob(app, new Blob([r.bytes], { type: 'application/octet-stream' }), { name: `${safe(stem)}_terrain.flt`, types: ['.flt'], description: 'OpenFlight' });
    if (texture) await deps.saveBlob(app, new Blob([texture.bytes], { type: texture.format === 'png' ? 'image/png' : 'image/jpeg' }), { name: texName, types: [`.${texName.split('.').pop()}`], description: t('Terrain texture') });
    return r;
  }

  /** Feature ▸ 3D Export: a building layer as SLPK or OpenFlight → {bytes, name, type, m}. */
  async function exportBuildings(layerId, fmt) {
    const m = app.extractR2.models(layerId);
    const stem = safe(app.store.get(layerId)?.name ?? 'buildings');
    const colour = [0.82, 0.78, 0.72];
    const objects = objectsFromModels(m.models, faceTriangles).map((o) => ({ ...o, colour }));
    const toGeo = (x, y, z) => {
      const [lon, lat] = m.frame.from(x, y);
      return [lon, lat, z + m.origin.h];
    };
    if (fmt === 'slpk') {
      const r = writeSlpk({ name: app.store.get(layerId)?.name ?? 'Buildings', objects, toGeo, colour });
      return { bytes: r.bytes, name: `${stem}.slpk`, type: 'application/octet-stream', m, report: r };
    }
    const r = writeOpenFlight({ objects, origin: m.origin, toGeo, name: app.store.get(layerId)?.name ?? 'Buildings' });
    return { bytes: r.bytes, name: `${stem}.flt`, type: 'application/octet-stream', m, report: r };
  }

  // ---- 3D PDF ----
  async function export3dPdf({ v = pane()?.view3d, save = true, title = null } = {}) {
    if (!v) throw gwError('show the 3D view first', null, 'E_NO_3D_VIEW');
    v.render();
    const poster = await new Promise((res) => v.canvas.toBlob(res, 'image/jpeg', 0.88));
    const scene = await sceneObjects(v);
    if (!scene.meshes.length) throw gwError('the 3D view has nothing to export: open terrain, models or a scene layer first', null, 'E_PDF3D_EMPTY');
    const r = write3dPdf({ ...scene, poster: poster ? { bytes: new Uint8Array(await poster.arrayBuffer()), width: v.canvas.width, height: v.canvas.height } : null, title: title ?? t('GIS Workbench 3D view') });
    if (save) await deps.saveBlob(app, new Blob([r.bytes], { type: 'application/pdf' }), { name: 'scene_3d.pdf', types: ['.pdf'], description: t('3D PDF') });
    return r;
  }
  C.implement('3d.pdf', {
    enabled: () => !!pane()?.view3d,
    run: async () => {
      try {
        const r = await export3dPdf();
        app.toast(t('3D PDF: {tris} triangles in {n, plural, one {# mesh} other {# meshes}}, {tex, plural, =0 {untextured} one {# texture} other {# textures}}', { tris: int(r.triangles), n: r.meshes, tex: r.textures }), { kind: 'info' });
        return r;
      } catch (e) {
        app.toast(msgOf(e), { kind: e?.code === 'E_NO_3D_VIEW' || e?.code === 'E_PDF3D_EMPTY' ? 'warn' : 'error', ms: 9000 });
        return null;
      }
    },
  });

  Object.assign(app.models3d, { openSlpk, openService, identifyAt, saveTerrain, exportBuildings, export3dPdf, layers: () => layers.filter((l) => !l.disposed) });
}
