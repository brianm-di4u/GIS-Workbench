// Hub bridges (2.0 plan P7; REQ-HUB-01..03, REQ-HUB-06): one-click hand-offs from the view to the tools
// around GIS Workbench, all written on this computer.
//   Photoshop  layered PSD: raw base + live Levels / Curves rebuilding the stretch (hub/psd.js);
//              16-bit GeoTIFF of the data with a Curves preset (.acv) for the same look
//   Illustrator layered PDF (optional-content groups) and layered SVG (hub/layers.js)
//   Blender, Unreal, iOS  textured terrain as GLB or USDZ (hub/terrain3d.js); COLLADA, KMZ (Google
//              Earth), STL and PLY (REQ-GAP-34, vector/mesh-formats.js)
//   Drives  rows go to a Google Sheet through the user's own Apps Script relay (text/plain POST,
//           HMAC-signed; experimental until spike S-41). Reading works through synced Drive /
//           OneDrive folders (Catalog ▸ Add Folder) or a downloaded CSV: Google's CSV export
//           redirects without CORS headers, so a page cannot read it directly (DN-58).

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { saveBlob } from '../storage/files.js';
import { makeChip } from '../products/chip.js';
import { ChipView } from '../render/offscreen.js';
import { toGeoJSON } from '../vector/geom.js';
import { writeGltf } from '../vector/mesh.js';
import { writeCollada, writeKmz, writeStl, writePly } from '../vector/mesh-formats.js';
import { viewPsd, levelsFor, acvPreset } from '../hub/psd.js';
import { writeGeoTiff } from '../formats/geotiff-writer.js';
import { stretchRange, histPercentile } from '../render/chain.js';
import { layeredPdf, layeredSvg, layerLabels } from '../hub/layers.js';
import { pdfFontsFor } from '../formats/font-pack.js';
import { terrainGrid, uvLookup } from '../hub/terrain3d.js';
import { t, tr, N_, msgOf } from '../i18n/index.js';
import { length } from '../i18n/format.js';

export const name = 'hub';

/** The Apps Script relay the analyst deploys in their own Google account (REQ-HUB-06). */
export const RELAY_SCRIPT = `// GIS Workbench → Google Sheets relay. Deploy: Extensions ▸ Apps Script in your Sheet, paste,
// set SECRET (Project Settings ▸ Script properties: SECRET), Deploy ▸ Web app (execute as you,
// access: anyone). Paste the web app URL and the same secret into GIS Workbench.
function doPost(e) {
  var body = e.postData.contents;
  var msg = JSON.parse(body);
  var secret = PropertiesService.getScriptProperties().getProperty('SECRET');
  var sig = Utilities.computeHmacSha256Signature(JSON.stringify(msg.rows), secret)
    .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
  if (sig !== msg.sig) return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'bad signature' }));
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(msg.sheet || 'GIS Workbench') || SpreadsheetApp.getActiveSpreadsheet().insertSheet(msg.sheet || 'GIS Workbench');
  if (sheet.getLastRow() === 0) sheet.appendRow(msg.columns);
  msg.rows.forEach(function (r) { sheet.appendRow(r); });
  return ContentService.createTextOutput(JSON.stringify({ ok: true, rows: msg.rows.length }));
}`;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
}

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const pane = () => app.activePane();
  const geoLayer = () => {
    const l = pane()?.geoLayer?.() ?? pane()?.activeLayer?.();
    if (!l) throw new Error('open an image first');
    return l;
  };
  const stem = () => (geoLayer().rec?.name ?? 'view').replace(/\.\w+$/, '').replace(/[^\w.-]+/g, '_');
  const toJpeg = (canvas, q = 0.92) => new Promise((res) => canvas.toBlob((b) => b.arrayBuffer().then((a) => res(new Uint8Array(a))), 'image/jpeg', q));
  const imgCanvas = (img, W, H) => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    c.getContext('2d').putImageData(new ImageData(img.data, W, H), 0, 0);
    return c;
  };
  // label: a name marked with N_ (Photoshop, Layered PDF…); the result is a translated message.
  const run = (label, fn) => async () => {
    try {
      const r = await fn();
      if (r) app.toast(t('{label}: {msg}', { label: tr(label), msg: r }), { kind: 'info' });
    } catch (e) {
      app.toast(t('{label}: {msg}', { label: tr(label), msg: msgOf(e) }), { kind: 'warn', ms: 9000 });
    }
  };

  /** Vector layers of a view in output pixels (for PDF and SVG). */
  function vectorLayers(cv, l) {
    const px = (lon, lat, hh) => {
      const q = l.imageAt?.(lat, lon, hh ?? l.defaultHeight?.() ?? 0);
      if (!q) return null;
      const s = cv.screenPoint(q.x, q.y);
      return [s.x, s.y];
    };
    const layers = [];
    const gItems = [];
    for (const g of S.all('graphic')) {
      if (g.pane && g.pane !== pane()?.id) continue;
      const pts = (g.coords ?? []).map((c) => (g.anchor === 'ground' ? px(c[0], c[1], c[2]) : (({ x, y }) => [x, y])(cv.screenPoint(c[0], c[1]))));
      if (!pts.length || pts.some((p) => !p)) continue;
      const kind = g.shape === 'polygon' || g.shape === 'rect' ? 'poly' : g.shape === 'polyline' ? 'line' : g.shape === 'text' ? 'text' : 'point';
      gItems.push({ kind, pts, stroke: g.style?.stroke ?? '#00e5ff', fill: kind === 'poly' ? g.style?.fill ?? null : null, width: g.style?.width ?? 2, label: g.text ?? '' });
    }
    if (gItems.length) layers.push({ name: 'Graphics', items: gItems });
    for (const v of S.all('vlayer')) {
      if (v.visible === false) continue;
      const items = [];
      for (const f of S.all('feature')) {
        if (f.vlayer !== v.id || !f.geom) continue;
        const gj = toGeoJSON(f.geom, 9);
        const rings = gj.type === 'Polygon' ? gj.coordinates : gj.type === 'MultiPolygon' ? gj.coordinates.flat() : gj.type === 'LineString' ? [gj.coordinates] : gj.type === 'MultiLineString' ? gj.coordinates : gj.type === 'Point' ? [[gj.coordinates]] : [];
        const kind = /Polygon/.test(gj.type) ? 'poly' : /Line/.test(gj.type) ? 'line' : 'point';
        for (const r of rings) {
          const pts = r.map((c) => px(c[0], c[1], c[2]));
          if (pts.length && pts.every(Boolean)) items.push({ kind, pts, stroke: v.style?.stroke ?? '#ffcc00', fill: kind === 'poly' ? v.style?.fill ?? null : null, width: v.style?.width ?? 2, label: kind === 'point' ? f.name ?? '' : '' });
        }
      }
      if (items.length) layers.push({ name: v.name ?? 'Vector layer', items });
    }
    return layers;
  }

  /** Neatline and scale bar layers for a W × H chip view. */
  function furniture(cv, l, W, H) {
    const out = [{ name: 'Neatline', items: [{ kind: 'poly', pts: [[1, 1], [W - 1, 1], [W - 1, H - 1], [1, H - 1]], stroke: '#000000', width: 2 }] }];
    const mpp = cv.groundScale?.(l);
    if (Number.isFinite(mpp) && mpp > 0) {
      const target = (W * mpp) / 5;
      const pow = 10 ** Math.floor(Math.log10(target));
      const len = [1, 2, 5].map((k) => k * pow).filter((v) => v <= target).at(-1) ?? pow;
      const px = len / mpp;
      out.push({ name: 'Scale bar', items: [{ kind: 'line', pts: [[20, H - 20], [20 + px, H - 20]], stroke: '#ffffff', width: 4 }, { kind: 'text', pts: [[20, H - 28]], stroke: '#ffffff', label: len >= 1000 ? `${len / 1000} km` : `${len} m` }] });
    }
    return out;
  }

  // ---- Photoshop (REQ-HUB-01) ----
  async function psd({ maxSide = 4096 } = {}) {
    const p = pane();
    const l = geoLayer();
    const R = app.aiLocal?.viewRegion?.(p, l) ?? { x0: 0, y0: 0, w: l.width, h: l.height };
    const step = Math.max(1, Math.floor(1 / p.view.zoom), Math.ceil(Math.max(R.w, R.h) / maxSide));
    const lib = await app.gw.runScript('js-psd');
    const read = (layer, reg, st, bands) => app.pool.run('window', { handle: layer.handle, x0: Math.round(reg.x0), y0: Math.round(reg.y0), w: Math.ceil(reg.w / st), h: Math.ceil(reg.h / st), step: st, bands }, { affinity: layer.affinity, label: t('PSD: read view') });
    // Graphics as a pixel layer, drawn on the same grid (image-aligned, 1 px = step image px).
    const W = Math.ceil(R.w / step);
    const H = Math.ceil(R.h / step);
    const gfx = document.createElement('canvas');
    gfx.width = W;
    gfx.height = H;
    const cv = new ChipView(p, { ...p.view, cx: R.x0 + R.w / 2, cy: R.y0 + R.h / 2, zoom: 1 / step, rot: 0, lin: null }, W, H);
    app.graphics?.drawPane(cv, gfx.getContext('2d'));
    const out = await viewPsd({ l, region: R, step, read, writePsd: lib.writePsd, graphics: gfx, groundAt: (x, y) => l.groundAt?.(x, y) });
    await saveBlob(app, new Blob([out.bytes], { type: 'image/vnd.adobe.photoshop' }), { name: `${stem()}.psd`, types: ['.psd'], description: t('Photoshop document') });
    if (out.world) {
      await saveBlob(app, new Blob([out.world], { type: 'text/plain' }), { name: `${stem()}.psw`, types: ['.psw'], description: t('World file') });
    }
    return t('{w} × {h} px, {n, plural, one {# layer} other {# layers}} ({names})', { w: String(out.size[0]), h: String(out.size[1]), n: out.layers.length, names: out.layers.slice(1).join(', ') });
  }

  /** 16-bit TIFF of the view (the data rescaled linearly from its full range) plus a Curves preset (.acv) that rebuilds the look. */
  async function tiff16({ maxSide = 8192 } = {}) {
    const p = pane();
    const l = geoLayer();
    const R = app.aiLocal?.viewRegion?.(p, l) ?? { x0: 0, y0: 0, w: l.width, h: l.height };
    const step = Math.max(1, Math.floor(1 / p.view.zoom), Math.ceil(Math.max(R.w, R.h) / maxSide));
    const bands = (l.chain?.bands ?? [0]).slice(0, 3);
    const r = await app.pool.run('window', { handle: l.handle, x0: Math.round(R.x0), y0: Math.round(R.y0), w: Math.ceil(R.w / step), h: Math.ceil(R.h / step), step, bands }, { affinity: l.affinity, label: t('16-bit TIFF: read view') });
    const n = r.planes.length;
    const data = new Uint16Array(r.w * r.h * n);
    const levels = [];
    for (let b = 0; b < n; b++) {
      const hst = l.stats?.[bands[b]];
      const f = hst ? { lo: histPercentile(hst, 0), hi: histPercentile(hst, 1) } : { lo: 0, hi: 65535 };
      if (!(f.hi > f.lo)) f.hi = f.lo + 1;
      levels.push(levelsFor(f, hst ? stretchRange(hst, l.chain, bands[b]) : f, l.chain?.tone?.gamma ?? 0));
      const pl = r.planes[b];
      for (let i = 0; i < r.w * r.h; i++) data[i * n + b] = Math.max(0, Math.min(65535, Math.round(((pl[i] - f.lo) / (f.hi - f.lo)) * 65535)));
    }
    const opts = { tile: 256, compress: 'deflate', overviews: false, photometric: n >= 3 ? 'rgb' : 'minisblack', description: `${l.rec?.name ?? 'view'}: 16-bit, linear over the full data range; apply the .acv Curves preset for the GIS Workbench look` };
    const gt = l.info?.meta?.geotransform;
    const epsg = l.info?.meta?.epsg;
    if (gt && epsg && !gt[2] && !gt[4]) {
      opts.epsg = epsg;
      opts.geotransform = [gt[0] + R.x0 * gt[1], gt[1] * step, 0, gt[3] + R.y0 * gt[5], 0, gt[5] * step];
    } else if (l.modelId) {
      opts.epsg = 4326;
      opts.gcps = [];
      for (let j = 0; j <= 4; j++)
        for (let i = 0; i <= 4; i++) {
          const g = l.groundAt(R.x0 + (i / 4) * R.w, R.y0 + (j / 4) * R.h);
          if (g) opts.gcps.push({ x: (i / 4) * r.w, y: (j / 4) * r.h, lon: g.lon, lat: g.lat, h: g.h ?? 0 });
        }
    }
    const bytes = await writeGeoTiff({ width: r.w, height: r.h, bands: n, type: 'u16', data }, opts);
    await saveBlob(app, new Blob([bytes], { type: 'image/tiff' }), { name: `${stem()}_16bit.tif`, types: ['.tif'], description: t('16-bit GeoTIFF') });
    const acv = acvPreset(n >= 3 ? levels : [levels[0], levels[0], levels[0]], l.chain?.tone?.curve ?? null);
    await saveBlob(app, new Blob([acv], { type: 'application/octet-stream' }), { name: `${stem()}_look.acv`, types: ['.acv'], description: t('Photoshop Curves preset') });
    return t('{w} × {h} px, {n, plural, one {# band} other {# bands}}, 16-bit, with a Curves preset', { w: String(r.w), h: String(r.h), n }); // pixel sizes ungrouped
  }

  // ---- Illustrator (REQ-HUB-02) ----
  async function layered(kind) {
    const p = pane();
    const l = geoLayer();
    const chip = await makeChip(app, p, { graphics: false });
    const cv = chip.view;
    const W = cv.width;
    const H = cv.height;
    const layers = [...vectorLayers(cv, l), ...furniture(cv, l, W, H)];
    const canvas = imgCanvas(chip.image, W, H);
    const geo = chip.record.cornersGround ? chip.record.cornersGround.map((c) => [c[1], c[0]]) : null;
    if (kind === 'pdf') {
      const jpeg = await toJpeg(canvas);
      // Labels outside WinAnsi (Cyrillic, CJK…) use the fonts-noto pack; without it they show '?' (REQ-L10N-11).
      const fonts = await pdfFontsFor(app, layerLabels(layers));
      const bytes = layeredPdf({ width: W, height: H, jpeg, imgW: W, imgH: H, layers, title: l.rec?.name ?? 'GIS Workbench', geo, fonts });
      await saveBlob(app, new Blob([bytes], { type: 'application/pdf' }), { name: `${stem()}_layers.pdf`, types: ['.pdf'], description: t('Layered PDF') });
    } else {
      const svg = layeredSvg({ width: W, height: H, imageHref: canvas.toDataURL('image/jpeg', 0.9), layers, title: l.rec?.name ?? 'GIS Workbench' });
      await saveBlob(app, new Blob([svg], { type: 'image/svg+xml' }), { name: `${stem()}_layers.svg`, types: ['.svg'], description: t('Layered SVG') });
    }
    return t('{n, plural, one {# layer} other {# layers}} ({names})', { n: layers.length + 1, names: ['Imagery', ...layers.map((x) => x.name)].join(', ') });
  }

  // ---- Blender / Unreal / iOS (REQ-HUB-03) ----
  async function terrain(kind, { n = 96, texture = 2048 } = {}) {
    const p = pane();
    const l = geoLayer();
    if (!l.modelId) throw new Error('the image has no sensor model or georeference');
    const { w: pw, h: ph } = p.size();
    const s = Math.min(texture, kind === 'usdz' ? 4096 : 8192) / Math.max(pw, ph);
    const chip = await makeChip(app, p, { graphics: true, width: Math.round(pw * s), height: Math.round(ph * s) });
    const cv = chip.view;
    const W = Math.round(pw * s);
    const H = Math.round(ph * s);
    const hasDem = !!app.terrain?.demFor?.(l);
    const grid = terrainGrid(n, (i, j) => {
      const q = cv.imagePoint((i / (n - 1)) * W, (j / (n - 1)) * H);
      const g = l.groundWithTerrain?.(q.x, q.y) ?? l.groundAt(q.x, q.y);
      return g && { lat: g.lat, lon: g.lon, h: g.h ?? 0, u: i / (n - 1), v: j / (n - 1) };
    });
    const canvas = imgCanvas(chip.image, W, H);
    const pngOf = async () => new Uint8Array(await (await new Promise((r) => canvas.toBlob(r, 'image/png'))).arrayBuffer());
    if (kind === 'dae' || kind === 'kmz' || kind === 'stl' || kind === 'ply') {
      // REQ-GAP-34: COLLADA (+ its texture), KMZ (a KML Model at the grid origin), STL, PLY (+ texture).
      const models = [{ id: 'terrain', name: 'Terrain', model: grid, attrs: {} }];
      const texName = `${stem()}_terrain.png`;
      const tex = kind === 'stl' ? null : { png: await pngOf(), uv: uvLookup(grid), name: texName };
      if (kind === 'dae') {
        await saveBlob(app, new Blob([writeCollada(models, grid.origin, { texture: tex, title: stem() })], { type: 'model/vnd.collada+xml' }), { name: `${stem()}_terrain.dae`, types: ['.dae'], description: 'COLLADA' });
        await saveBlob(app, new Blob([tex.png], { type: 'image/png' }), { name: texName, types: ['.png'], description: t('Terrain texture') });
      } else if (kind === 'kmz') {
        // KML altitudes are above mean sea level: the origin's ellipsoid height less the EGM96 undulation.
        const N = app.core.undulation?.(grid.origin.lat, grid.origin.lon) ?? 0;
        const bytes = writeKmz(models, grid.origin, { altitude: grid.origin.h - N, texture: tex, name: t('{name} terrain', { name: stem() }) });
        await saveBlob(app, new Blob([bytes], { type: 'application/vnd.google-earth.kmz' }), { name: `${stem()}_terrain.kmz`, types: ['.kmz'], description: 'KMZ' });
      } else if (kind === 'stl') {
        await saveBlob(app, new Blob([writeStl(models, grid.origin, { name: `${stem()} terrain` })], { type: 'model/stl' }), { name: `${stem()}_terrain.stl`, types: ['.stl'], description: 'STL' });
      } else {
        await saveBlob(app, new Blob([writePly(models, grid.origin, { texture: tex })], { type: 'application/x-ply' }), { name: `${stem()}_terrain.ply`, types: ['.ply'], description: 'PLY' });
        await saveBlob(app, new Blob([tex.png], { type: 'image/png' }), { name: texName, types: ['.png'], description: t('Terrain texture') });
      }
    } else if (kind === 'slpk' || kind === 'flt') {
      // REQ-GAP-35: I3S scene layer package and OpenFlight (lazy js-models3d block), a JPEG texture.
      const jpeg = new Uint8Array(await (await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9))).arrayBuffer());
      await app.models3d.saveTerrain(kind, grid, { texture: { bytes: jpeg, format: 'jpg' }, stem: stem() });
    } else if (kind === 'glb') {
      const png = new Uint8Array(await (await new Promise((r) => canvas.toBlob(r, 'image/png'))).arrayBuffer());
      const bytes = writeGltf([{ id: 'terrain', name: 'Terrain', model: grid, attrs: {} }], grid.origin, { glb: true, texture: { png, uv: uvLookup(grid) } });
      await saveBlob(app, new Blob([bytes], { type: 'model/gltf-binary' }), { name: `${stem()}_terrain.glb`, types: ['.glb'], description: t('glTF binary') });
    } else {
      const T = await app.gw.runScript('js-three');
      const geom = new T.BufferGeometry();
      const pos = new Float32Array(grid.vertices.length * 3);
      const uvs = new Float32Array(grid.vertices.length * 2);
      grid.vertices.forEach(([x, y, z], k) => {
        pos.set([x, z, -y], 3 * k);
        const [u, v] = grid.uv.get([x, y, z].map((t) => t.toFixed(4)).join(','));
        uvs.set([u, 1 - v], 2 * k);
      });
      geom.setAttribute('position', new T.BufferAttribute(pos, 3));
      geom.setAttribute('uv', new T.BufferAttribute(uvs, 2));
      geom.setIndex(grid.faces.flatMap((f) => f.idx));
      geom.computeVertexNormals();
      const tex = new T.CanvasTexture(canvas);
      tex.colorSpace = T.SRGBColorSpace;
      const mesh = new T.Mesh(geom, new T.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0 }));
      mesh.name = 'Terrain';
      const scene = new T.Scene();
      scene.add(mesh);
      const bytes = await new T.USDZExporter().parseAsync(scene);
      await saveBlob(app, new Blob([bytes], { type: 'model/vnd.usdz+zip' }), { name: `${stem()}_terrain.usdz`, types: ['.usdz'], description: 'USDZ' });
    }
    const size = { n, w: length(grid.metres[0], 2), h: length(grid.metres[1], 2), tw: String(W), th: String(H) };
    return hasDem ? t('{n} × {n} grid over {w} × {h}, {tw} × {th} texture', size) : t('{n} × {n} grid over {w} × {h} (flat: no DEM under the image), {tw} × {th} texture', size);
  }

  // ---- Drives (REQ-HUB-06) ----
  async function relay() {
    const url = h('input', { class: 'inp', value: app.prefs.get('relayUrl') ?? '', placeholder: 'https://script.google.com/macros/s/…/exec', 'aria-label': t('Relay URL'), style: { width: '100%' } });
    const secret = h('input', { class: 'inp', type: 'password', 'aria-label': t('Shared secret'), autocomplete: 'off' });
    const sheet = h('input', { class: 'inp', value: app.prefs.get('relaySheet') ?? 'GIS Workbench', 'aria-label': t('Sheet name') });
    const script = h('textarea', { class: 'inp mono', rows: '6', readOnly: true, 'aria-label': t('Relay script to copy') }, RELAY_SCRIPT);
    if ((await modal({ title: t('Send to a Google Sheet'), body: h('div', {}, h('p', { class: 'hint' }, t('Appends the markers, observations and accepted detections as rows, through an Apps Script web app you deploy in your own account (script below). The secret signs each request and is not stored. Experimental: Google may refuse requests from a file opened from disk; host GIS Workbench on https if it does.')), field(t('Relay URL'), url), field(t('Secret'), secret), field(t('Sheet'), sheet), h('details', {}, h('summary', {}, t('Apps Script relay')), script)), buttons: [{ label: t('Send'), value: 'send', primary: true }, { label: t('Cancel'), value: 'cancel' }], width: 640, id: 'hub-relay' })) !== 'send') return null;
    const u = url.value.trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(u)) throw new Error('the relay URL must be a script.google.com/macros/s/…/exec web app');
    if (!secret.value) throw new Error('enter the shared secret first');
    app.prefs.set('relayUrl', u);
    app.prefs.set('relaySheet', sheet.value.trim() || 'GIS Workbench');
    const columns = ['time', 'kind', 'name', 'lat', 'lon', 'mgrs', 'text', 'source'];
    const rows = [];
    const now = new Date().toISOString();
    for (const g of S.all('graphic')) if ((g.shape === 'marker' || g.shape === 'point') && g.anchor === 'ground' && g.coords?.[0]) rows.push([now, 'marker', g.text ?? '', g.coords[0][1], g.coords[0][0], app.core.mgrs(g.coords[0][1], g.coords[0][0], 5), g.text ?? '', 'GIS Workbench']);
    for (const o of S.all('observation')) if (Number.isFinite(o.lat)) rows.push([now, 'observation', '', o.lat, o.lon, app.core.mgrs(o.lat, o.lon, 5), o.text ?? '', 'GIS Workbench']);
    for (const d of S.all('detection').filter((x) => x.status === 'accepted')) {
      const f = d.feature && S.get(d.feature);
      const gj = f?.geom && toGeoJSON(f.geom, 9);
      const ring = gj?.type === 'Polygon' ? gj.coordinates[0] : null;
      const pt = gj?.type === 'Point' ? gj.coordinates : ring ? [ring.reduce((s, q) => s + q[0], 0) / ring.length, ring.reduce((s, q) => s + q[1], 0) / ring.length] : null;
      if (pt) rows.push([now, 'detection', d.cls ?? '', pt[1], pt[0], app.core.mgrs(pt[1], pt[0], 5), d.note ?? '', d.source ?? '']);
    }
    if (!rows.length) throw new Error('nothing to send');
    const sig = await hmacHex(secret.value, JSON.stringify(rows));
    // text/plain keeps the POST "simple" (no CORS preflight, which Apps Script does not answer).
    const r = await app.netlog.fetchFor('Drives: Sheets relay')(u, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ sheet: sheet.value.trim() || 'GIS Workbench', columns, rows, sig }) });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
    return t('{n, plural, one {# row appended} other {# rows appended}}', { n: j.rows });
  }

  const has = () => !!(pane()?.geoLayer?.() ?? pane()?.activeLayer?.())?.handle;
  C.implement('hub.psd', { enabled: has, run: run('Photoshop', () => psd()) });
  C.implement('hub.tiff16', { enabled: has, run: run(N_('16-bit TIFF'), () => tiff16()) });
  C.implement('hub.pdf', { enabled: has, run: run(N_('Layered PDF'), () => layered('pdf')) });
  C.implement('hub.svg', { enabled: has, run: run(N_('Layered SVG'), () => layered('svg')) });
  C.implement('hub.glb', { enabled: has, run: run(N_('3D terrain'), () => terrain('glb')) });
  C.implement('hub.usdz', { enabled: has, run: run(N_('3D terrain'), () => terrain('usdz')) });
  for (const k of ['dae', 'kmz', 'stl', 'ply', 'slpk', 'flt']) C.implement(`hub.${k === 'kmz' ? 'kmz3d' : k}`, { enabled: has, run: run(N_('3D terrain'), () => terrain(k)) });
  C.implement('hub.relay', { run: run(N_('Google Sheet'), relay) });
  app.hub = { psd, tiff16, layered, terrain, vectorLayers, relay };
}
