// Hub bridges (2.0 plan P7; REQ-HUB-01..04, REQ-HUB-06): one-click hand-offs from the view to the tools
// around GIS Workbench, all written on this computer.
//   Photoshop  layered PSD: raw base + live Levels / Curves rebuilding the stretch (hub/psd.js);
//              16-bit GeoTIFF of the data with a Curves preset (.acv) for the same look
//   Illustrator layered PDF (optional-content groups) and layered SVG (hub/layers.js)
//   Blender, Unreal, iOS  textured terrain as GLB or USDZ (hub/terrain3d.js)
//   ATAK / TAK  CoT events and ATAK data packages (hub/tak.js)
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
import { viewPsd, levelsFor, acvPreset } from '../hub/psd.js';
import { writeGeoTiff } from '../formats/geotiff-writer.js';
import { stretchRange, histPercentile } from '../render/chain.js';
import { layeredPdf, layeredSvg } from '../hub/layers.js';
import { terrainGrid, uvLookup } from '../hub/terrain3d.js';
import { cotEvent, cotType, dataPackage } from '../hub/tak.js';

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
  const run = (label, fn) => async () => {
    try {
      const r = await fn();
      if (r) app.toast(`${label}: ${r}`);
    } catch (e) {
      app.toast(`${label}: ${e.message}`, { kind: 'warn', ms: 9000 });
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
    const read = (layer, reg, st, bands) => app.pool.run('window', { handle: layer.handle, x0: Math.round(reg.x0), y0: Math.round(reg.y0), w: Math.ceil(reg.w / st), h: Math.ceil(reg.h / st), step: st, bands }, { affinity: layer.affinity, label: 'PSD: read view' });
    // Graphics as a pixel layer, drawn on the same grid (image-aligned, 1 px = step image px).
    const W = Math.ceil(R.w / step);
    const H = Math.ceil(R.h / step);
    const gfx = document.createElement('canvas');
    gfx.width = W;
    gfx.height = H;
    const cv = new ChipView(p, { ...p.view, cx: R.x0 + R.w / 2, cy: R.y0 + R.h / 2, zoom: 1 / step, rot: 0, lin: null }, W, H);
    app.graphics?.drawPane(cv, gfx.getContext('2d'));
    const out = await viewPsd({ l, region: R, step, read, writePsd: lib.writePsd, graphics: gfx, groundAt: (x, y) => l.groundAt?.(x, y) });
    await saveBlob(app, new Blob([out.bytes], { type: 'image/vnd.adobe.photoshop' }), { name: `${stem()}.psd`, types: ['.psd'], description: 'Photoshop document' });
    if (out.world) {
      await saveBlob(app, new Blob([out.world], { type: 'text/plain' }), { name: `${stem()}.psw`, types: ['.psw'], description: 'World file' });
    }
    return `${out.size.join(' × ')} px, ${out.layers.length} layers (${out.layers.slice(1).join(', ')})`;
  }

  /** 16-bit TIFF of the view (the data rescaled linearly from its full range) plus a Curves preset (.acv) that rebuilds the look. */
  async function tiff16({ maxSide = 8192 } = {}) {
    const p = pane();
    const l = geoLayer();
    const R = app.aiLocal?.viewRegion?.(p, l) ?? { x0: 0, y0: 0, w: l.width, h: l.height };
    const step = Math.max(1, Math.floor(1 / p.view.zoom), Math.ceil(Math.max(R.w, R.h) / maxSide));
    const bands = (l.chain?.bands ?? [0]).slice(0, 3);
    const r = await app.pool.run('window', { handle: l.handle, x0: Math.round(R.x0), y0: Math.round(R.y0), w: Math.ceil(R.w / step), h: Math.ceil(R.h / step), step, bands }, { affinity: l.affinity, label: '16-bit TIFF: read view' });
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
    await saveBlob(app, new Blob([bytes], { type: 'image/tiff' }), { name: `${stem()}_16bit.tif`, types: ['.tif'], description: '16-bit GeoTIFF' });
    const acv = acvPreset(n >= 3 ? levels : [levels[0], levels[0], levels[0]], l.chain?.tone?.curve ?? null);
    await saveBlob(app, new Blob([acv], { type: 'application/octet-stream' }), { name: `${stem()}_look.acv`, types: ['.acv'], description: 'Photoshop Curves preset' });
    return `${r.w} × ${r.h} px, ${n} band${n > 1 ? 's' : ''}, 16-bit, with a Curves preset`;
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
      const bytes = layeredPdf({ width: W, height: H, jpeg, imgW: W, imgH: H, layers, title: l.rec?.name ?? 'GIS Workbench', geo });
      await saveBlob(app, new Blob([bytes], { type: 'application/pdf' }), { name: `${stem()}_layers.pdf`, types: ['.pdf'], description: 'Layered PDF' });
    } else {
      const svg = layeredSvg({ width: W, height: H, imageHref: canvas.toDataURL('image/jpeg', 0.9), layers, title: l.rec?.name ?? 'GIS Workbench' });
      await saveBlob(app, new Blob([svg], { type: 'image/svg+xml' }), { name: `${stem()}_layers.svg`, types: ['.svg'], description: 'Layered SVG' });
    }
    return `${layers.length + 1} layers (Imagery, ${layers.map((x) => x.name).join(', ')})`;
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
    if (kind === 'glb') {
      const png = new Uint8Array(await (await new Promise((r) => canvas.toBlob(r, 'image/png'))).arrayBuffer());
      const bytes = writeGltf([{ id: 'terrain', name: 'Terrain', model: grid, attrs: {} }], grid.origin, { glb: true, texture: { png, uv: uvLookup(grid) } });
      await saveBlob(app, new Blob([bytes], { type: 'model/gltf-binary' }), { name: `${stem()}_terrain.glb`, types: ['.glb'], description: 'glTF binary' });
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
    return `${n} × ${n} grid over ${(grid.metres[0] / 1000).toFixed(2)} × ${(grid.metres[1] / 1000).toFixed(2)} km${hasDem ? '' : ' (flat: no DEM under the image)'}, ${W} × ${H} texture`;
  }

  // ---- TAK (REQ-HUB-04) ----
  /** Everything worth sending: markers, observations, accepted detections, outlines. → [{uid, xml, title}] */
  function cotItems() {
    const out = [];
    const now = Date.now();
    for (const g of S.all('graphic')) {
      if (g.anchor !== 'ground' || !g.coords?.length) continue;
      const c = g.coords;
      if (g.shape === 'marker' || g.shape === 'point') out.push({ uid: `GW-${g.id}`, xml: cotEvent({ uid: `GW-${g.id}`, type: 'a-u-G', lat: c[0][1], lon: c[0][0], hae: c[0][2], callsign: g.text || `Marker ${g.id.slice(-4)}`, remarks: g.text, time: now }) });
      else if (g.shape === 'polygon' || g.shape === 'rect' || g.shape === 'polyline') {
        const cx = c.reduce((s, q) => s + q[0], 0) / c.length;
        const cy = c.reduce((s, q) => s + q[1], 0) / c.length;
        out.push({ uid: `GW-${g.id}`, xml: cotEvent({ uid: `GW-${g.id}`, lat: cy, lon: cx, callsign: g.text || `Shape ${g.id.slice(-4)}`, ring: c, time: now, remarks: g.provenance?.model ? `${g.text ?? ''} (${g.provenance.model})` : g.text }) });
      }
    }
    for (const o of S.all('observation')) if (Number.isFinite(o.lat) && Number.isFinite(o.lon)) out.push({ uid: `GW-${o.id}`, xml: cotEvent({ uid: `GW-${o.id}`, type: 'a-u-G', lat: o.lat, lon: o.lon, hae: o.hae, callsign: (o.text ?? 'Observation').slice(0, 30), remarks: o.text, time: now }) });
    const v = S.all('vlayer').find((x) => x.role === 'accepted-detections');
    if (v)
      for (const f of S.all('feature').filter((x) => x.vlayer === v.id && x.geom)) {
        const gj = toGeoJSON(f.geom, 9);
        const ring = gj.type === 'Polygon' ? gj.coordinates[0] : null;
        const pt = gj.type === 'Point' ? gj.coordinates : ring ? [ring.reduce((s, q) => s + q[0], 0) / ring.length, ring.reduce((s, q) => s + q[1], 0) / ring.length] : null;
        if (!pt) continue;
        out.push({ uid: `GW-${f.id}`, xml: cotEvent({ uid: `GW-${f.id}`, type: cotType(f.attrs?.CLASS), lat: pt[1], lon: pt[0], callsign: f.name ?? f.attrs?.CLASS ?? 'Detection', remarks: `${f.attrs?.CLASS ?? ''} ${Number.isFinite(f.attrs?.CONF) ? `(${f.attrs.CONF})` : ''} ${f.attrs?.SOURCE ?? ''}`.trim(), how: 'm-g', time: now }) });
      }
    return out;
  }

  async function atak(kind) {
    const items = cotItems();
    if (!items.length) throw new Error('nothing to send: place markers, record observations, accept detections or draw outlines first');
    if (kind === 'cot') {
      const xml = items.map((i) => i.xml.replace(/^<\?xml[^>]*>\n/, '')).join('\n');
      await saveBlob(app, new Blob([`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<events>\n${xml}\n</events>\n`], { type: 'application/xml' }), { name: `${stem()}_cot.xml`, types: ['.xml'], description: 'Cursor on Target' });
      return `${items.length} CoT events`;
    }
    const files = [];
    for (const [k, d] of (app.sessionDeck ?? []).entries()) {
      const jpeg = await toJpeg(d.canvas, 0.85);
      files.push({ path: `images/chip_${k + 1}.jpg`, bytes: jpeg });
    }
    const zip = dataPackage({ name: `GIS Workbench ${stem()}`, uid: crypto.randomUUID(), events: items, files });
    await saveBlob(app, new Blob([zip], { type: 'application/zip' }), { name: `${stem()}_datapackage.zip`, types: ['.zip'], description: 'ATAK data package' });
    return `${items.length} items${files.length ? ` and ${files.length} chips` : ''}`;
  }

  // ---- Drives (REQ-HUB-06) ----
  async function relay() {
    const url = h('input', { class: 'inp', value: app.prefs.get('relayUrl') ?? '', placeholder: 'https://script.google.com/macros/s/…/exec', 'aria-label': 'Relay URL', style: { width: '100%' } });
    const secret = h('input', { class: 'inp', type: 'password', 'aria-label': 'Shared secret', autocomplete: 'off' });
    const sheet = h('input', { class: 'inp', value: app.prefs.get('relaySheet') ?? 'GIS Workbench', 'aria-label': 'Sheet name' });
    const script = h('textarea', { class: 'inp mono', rows: '6', readOnly: true, 'aria-label': 'Relay script to copy' }, RELAY_SCRIPT);
    if ((await modal({ title: 'Send to a Google Sheet', body: h('div', {}, h('p', { class: 'hint' }, 'Appends the markers, observations and accepted detections as rows, through an Apps Script web app you deploy in your own account (script below). The secret signs each request and is not stored. Experimental: Google may refuse requests from a file opened from disk; host GIS Workbench on https if it does.'), field('Relay URL', url), field('Secret', secret), field('Sheet', sheet), h('details', {}, h('summary', {}, 'Apps Script relay'), script)), buttons: ['Send', 'Cancel'], width: 640, id: 'hub-relay' })) !== 'Send') return null;
    const u = url.value.trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(u)) throw new Error('the relay URL must be a script.google.com/macros/s/…/exec web app');
    if (!secret.value) throw new Error('enter the shared secret first');
    app.prefs.set('relayUrl', u);
    app.prefs.set('relaySheet', sheet.value.trim() || 'GIS Workbench');
    const columns = ['time', 'kind', 'name', 'lat', 'lon', 'mgrs', 'text', 'source'];
    const rows = [];
    const t = new Date().toISOString();
    for (const g of S.all('graphic')) if ((g.shape === 'marker' || g.shape === 'point') && g.anchor === 'ground' && g.coords?.[0]) rows.push([t, 'marker', g.text ?? '', g.coords[0][1], g.coords[0][0], app.core.mgrs(g.coords[0][1], g.coords[0][0], 5), g.text ?? '', 'GIS Workbench']);
    for (const o of S.all('observation')) if (Number.isFinite(o.lat)) rows.push([t, 'observation', '', o.lat, o.lon, app.core.mgrs(o.lat, o.lon, 5), o.text ?? '', 'GIS Workbench']);
    for (const d of S.all('detection').filter((x) => x.status === 'accepted')) {
      const f = d.feature && S.get(d.feature);
      const gj = f?.geom && toGeoJSON(f.geom, 9);
      const ring = gj?.type === 'Polygon' ? gj.coordinates[0] : null;
      const pt = gj?.type === 'Point' ? gj.coordinates : ring ? [ring.reduce((s, q) => s + q[0], 0) / ring.length, ring.reduce((s, q) => s + q[1], 0) / ring.length] : null;
      if (pt) rows.push([t, 'detection', d.cls ?? '', pt[1], pt[0], app.core.mgrs(pt[1], pt[0], 5), d.note ?? '', d.source ?? '']);
    }
    if (!rows.length) throw new Error('nothing to send');
    const sig = await hmacHex(secret.value, JSON.stringify(rows));
    // text/plain keeps the POST "simple" (no CORS preflight, which Apps Script does not answer).
    const r = await app.netlog.fetchFor('Drives: Sheets relay')(u, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ sheet: sheet.value.trim() || 'GIS Workbench', columns, rows, sig }) });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
    return `${j.rows} rows appended`;
  }

  const has = () => !!(pane()?.geoLayer?.() ?? pane()?.activeLayer?.())?.handle;
  C.implement('hub.psd', { enabled: has, run: run('Photoshop', () => psd()) });
  C.implement('hub.tiff16', { enabled: has, run: run('16-bit TIFF', () => tiff16()) });
  C.implement('hub.pdf', { enabled: has, run: run('Layered PDF', () => layered('pdf')) });
  C.implement('hub.svg', { enabled: has, run: run('Layered SVG', () => layered('svg')) });
  C.implement('hub.glb', { enabled: has, run: run('3D terrain', () => terrain('glb')) });
  C.implement('hub.usdz', { enabled: has, run: run('3D terrain', () => terrain('usdz')) });
  C.implement('hub.cot', { run: run('CoT', () => atak('cot')) });
  C.implement('hub.atak', { run: run('ATAK data package', () => atak('package')) });
  C.implement('hub.relay', { run: run('Google Sheet', relay) });
  app.hub = { psd, tiff16, layered, terrain, atak, cotItems, vectorLayers, relay };
}
