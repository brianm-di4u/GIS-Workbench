// GeoPDF Map export (REQ-GAP-66, SDP-2.3 §2 GR-24; part of the lazy js-geopdf block): the view as
// a GeoPDF that GIS tools open with its layers, attributes and coordinates. The page is drawn in a
// projected CRS (the UTM zone of the view, the image's own CRS, Web Mercator, any EPSG code this
// build knows) or in longitude/latitude; a main map frame and an optional overview frame, each its
// own ISO 32000-2 viewport; every visible vector layer an optional-content layer with its
// features' attributes (GDAL's structure-tree layout); the imagery resampled into the main frame's
// grid (a 32 x 32 piecewise-affine warp through the sensor model); text in any script through the
// fonts pack. The app's modules come in through init() (features/geopdf.js), so the block has no
// second copy of them.

import { N_ } from '../i18n/index.js'; // only the marker: t() and the rest come from init()
import { layout, compose, writeGeoPdf, textsOf, boldTextsOf } from './geopdf-writer.js';
import { frameCrs, utmEpsg } from './geopdf-vectors.js';

let h, modal, field, section, saveBlob, makeChip, toGeoJSON, layerCrs, pdfFontsFor, zlibSync, t, tr, msgOf, gwError;

/** Hand in the app's modules (features/geopdf.js). */
export function init(d) {
  ({ h, modal, field, section, saveBlob, makeChip, toGeoJSON, layerCrs, pdfFontsFor, zlibSync, t, tr, msgOf, gwError } = d);
}

const PAGES = { A4: [210, 297], A3: [297, 420], Letter: [215.9, 279.4], Tabloid: [279.4, 431.8] };

/** Projected bounding box of lon/lat points (edges densified by the caller). */
function bboxOf(pts, fwd) {
  let [X0, Y0, X1, Y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lon, lat] of pts) {
    const [X, Y] = fwd(lon, lat);
    if (!Number.isFinite(X) || !Number.isFinite(Y)) continue;
    X0 = Math.min(X0, X);
    Y0 = Math.min(Y0, Y);
    X1 = Math.max(X1, X);
    Y1 = Math.max(Y1, Y);
  }
  return Number.isFinite(X0) ? [X0, Y0, X1, Y1] : null;
}

const allCoords = (c) => (typeof c[0] === 'number' ? [c] : c.flatMap(allCoords));

/** The export of one app: {exportMap(opts), run()} (the command). */
export function geoPdfMap(app) {
  const S = app.store;
  const pane = () => app.activePane?.();
  const visibleLayers = () => S.all('vlayer').filter((v) => v.visible !== false);

  /** Visible vector layers as {name, style, attributes, features: [{geom, label, attrs, style}]} (WGS 84). */
  function vectorData(attributes, labels) {
    const out = [];
    for (const v of visibleLayers()) {
      const feats = [];
      for (const f of S.all('feature')) {
        if (f.vlayer !== v.id || !f.geom) continue;
        const attrs = {};
        if (f.name !== null && f.name !== undefined && f.name !== '') attrs.name = f.name;
        Object.assign(attrs, f.attrs ?? {});
        if (f.description) attrs.description = f.description;
        feats.push({ geom: toGeoJSON(f.geom, 9), label: labels && f.name ? String(f.name) : null, attrs, style: f.style ?? null });
      }
      if (feats.length) out.push({ name: v.name ?? t('Vector layer'), style: { stroke: v.style?.stroke ?? '#ff2020', fill: v.style?.fill ?? null, width: v.style?.width ?? 1.5 }, attributes, features: feats });
    }
    // Ground graphics (markers, outlines, text) as one layer without attributes.
    const g = [];
    for (const x of S.all('graphic')) {
      if (x.anchor !== 'ground' || !x.coords?.length) continue;
      const cs = x.coords.map((c) => [c[0], c[1]]);
      const type = x.shape === 'polygon' || x.shape === 'rect' ? 'Polygon' : x.shape === 'polyline' ? 'LineString' : 'Point';
      const geom = type === 'Polygon' ? { type, coordinates: [[...cs, cs[0]]] } : type === 'LineString' ? { type, coordinates: cs } : { type, coordinates: cs[0] };
      g.push({ geom, label: labels && x.text ? String(x.text) : null, attrs: null, style: { stroke: x.style?.stroke ?? '#00e5ff', fill: type === 'Polygon' ? x.style?.fill ?? null : null, width: x.style?.width ?? 1.5 } });
    }
    if (g.length) out.push({ name: t('Graphics'), style: { stroke: '#00e5ff', fill: null, width: 1.5 }, attributes: false, features: g });
    return out;
  }

  /** The imagery of the view resampled into a frame's projected grid (piecewise affine, 32 × 32 cells). */
  async function frameImage(p, l, fr, F, pxPerPt) {
    const [x0, y0, x1, y1] = fr.box;
    const W = Math.max(16, Math.min(4096, Math.round((x1 - x0) * pxPerPt)));
    const H = Math.max(16, Math.min(4096, Math.round((y1 - y0) * pxPerPt)));
    const { w: pw, h: ph } = p.size();
    const cw = Math.min(4096, Math.max(pw, Math.round(Math.max(W, H) * 1.25)));
    const chip = await makeChip(app, p, { graphics: false, width: cw, height: Math.round((cw * ph) / pw) });
    const cv = chip.view;
    const src = document.createElement('canvas');
    src.width = cv.width;
    src.height = cv.height;
    src.getContext('2d').putImageData(new ImageData(chip.image.data, cv.width, cv.height), 0, 0);
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const g = out.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, W, H);
    const N = 32;
    const [X0, Y0, X1, Y1] = fr.extent;
    const node = [];
    for (let j = 0; j <= N; j++)
      for (let i = 0; i <= N; i++) {
        const [lon, lat] = F.inv(X0 + ((X1 - X0) * i) / N, Y1 - ((Y1 - Y0) * j) / N);
        const q0 = Number.isFinite(lon) && Number.isFinite(lat) ? l.imageAt(lat, lon) : null;
        // Off the image (beyond half a cell): left white rather than drawn from the view's margin.
        const tol = Math.max(l.width, l.height) / N / 2;
        const q = q0 && q0.x >= -tol && q0.y >= -tol && q0.x <= l.width + tol && q0.y <= l.height + tol ? q0 : null;
        const s = q ? cv.screenPoint(q.x, q.y) : null;
        node.push(s && Number.isFinite(s.x) && Number.isFinite(s.y) ? [s.x, s.y] : null);
      }
    const tri = (a, b, c, A, B, Cc) => {
      // Affine chip → output for the triangle (a, b, c) → (A, B, C), clipped to it (slightly grown against seams).
      const den = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
      if (Math.abs(den) < 1e-9) return;
      const m11 = ((B[0] - A[0]) * (c[1] - a[1]) - (Cc[0] - A[0]) * (b[1] - a[1])) / den;
      const m12 = ((Cc[0] - A[0]) * (b[0] - a[0]) - (B[0] - A[0]) * (c[0] - a[0])) / den;
      const m21 = ((B[1] - A[1]) * (c[1] - a[1]) - (Cc[1] - A[1]) * (b[1] - a[1])) / den;
      const m22 = ((Cc[1] - A[1]) * (b[0] - a[0]) - (B[1] - A[1]) * (c[0] - a[0])) / den;
      const dx = A[0] - m11 * a[0] - m12 * a[1];
      const dy = A[1] - m21 * a[0] - m22 * a[1];
      const cx = (A[0] + B[0] + Cc[0]) / 3;
      const cy = (A[1] + B[1] + Cc[1]) / 3;
      const grow = (P) => [P[0] + Math.sign(P[0] - cx) * 0.6, P[1] + Math.sign(P[1] - cy) * 0.6];
      g.save();
      g.beginPath();
      for (const [k, P] of [A, B, Cc].map(grow).entries()) g[k ? 'lineTo' : 'moveTo'](P[0], P[1]);
      g.closePath();
      g.clip();
      g.setTransform(m11, m21, m12, m22, dx, dy);
      g.drawImage(src, 0, 0);
      g.restore();
    };
    const at = (i, j) => [(W * i) / N, (H * j) / N];
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const [n00, n10, n01, n11] = [node[j * (N + 1) + i], node[j * (N + 1) + i + 1], node[(j + 1) * (N + 1) + i], node[(j + 1) * (N + 1) + i + 1]];
        if (n00 && n10 && n11) tri(n00, n10, n11, at(i, j), at(i + 1, j), at(i + 1, j + 1));
        if (n00 && n11 && n01) tri(n00, n11, n01, at(i, j), at(i + 1, j + 1), at(i, j + 1));
      }
    const jpeg = await new Promise((res, rej) => out.toBlob((b) => (b ? b.arrayBuffer().then((a) => res(new Uint8Array(a))) : rej(new Error('JPEG encoding failed'))), 'image/jpeg', 0.9));
    return { jpeg, width: W, height: H, name: t('Imagery') };
  }

  /**
   * The GeoPDF bytes of the view. opts: {epsg ('auto' | 'image' | code), page ('A4'…), landscape,
   * overview, attributes, imagery, labels, title, dpi}. Returns {bytes, epsg, frames, layers, features}.
   */
  async function exportMap(opts = {}) {
    const o = { epsg: 'auto', page: 'A4', landscape: true, overview: true, attributes: true, imagery: true, labels: true, dpi: 150, ...opts };
    const p = pane();
    const l = p?.geoLayer?.() ?? null;
    const layers = vectorData(o.attributes, o.labels);
    // The main extent in WGS 84: the view's ground (edges densified), else all the features.
    // The view's ground and the image's footprint (edges densified): the map is where both are.
    let ll = [];
    let foot = [];
    if (l?.modelId) {
      const { w, h: hh } = p.size();
      const edge = (W, H, pt) => {
        const out = [];
        for (let k = 0; k <= 8; k++)
          for (const [x, y] of [[(W * k) / 8, 0], [(W * k) / 8, H], [0, (H * k) / 8], [W, (H * k) / 8]]) {
            const q = pt(x, y);
            const gpt = l.groundAt(q.x, q.y);
            if (gpt) out.push([gpt.lon, gpt.lat]);
          }
        return out;
      };
      ll = edge(w, hh, (x, y) => p.imagePoint(x, y));
      foot = edge(l.width, l.height, (x, y) => ({ x, y }));
    }
    const featLL = layers.flatMap((L) => L.features.flatMap((f) => allCoords(f.geom.coordinates).map((c) => [c[0], c[1]])));
    if (ll.length < 4) ll = featLL;
    if (!ll.length) throw gwError('nothing to map: open a georeferenced image or a vector layer first', null, 'E_STEP_FIRST');
    const cLon = ll.reduce((s, c) => s + c[0], 0) / ll.length;
    const cLat = ll.reduce((s, c) => s + c[1], 0) / ll.length;
    const imageEpsg = l ? layerCrs(l) : null;
    const epsg = o.epsg === 'auto' ? utmEpsg(cLon, cLat) : o.epsg === 'image' ? (imageEpsg?.epsg && imageEpsg.kind !== 'longlat' ? imageEpsg.epsg : utmEpsg(cLon, cLat)) : Number(o.epsg);
    const F = frameCrs(epsg);
    let main = bboxOf(ll, F.fwd);
    const fb = foot.length >= 4 ? bboxOf(foot, F.fwd) : null;
    if (main && fb && fb[0] < main[2] && fb[2] > main[0] && fb[1] < main[3] && fb[3] > main[1]) main = [Math.max(main[0], fb[0]), Math.max(main[1], fb[1]), Math.min(main[2], fb[2]), Math.min(main[3], fb[3])];
    if (!main) throw gwError('the view cannot be drawn in EPSG:{code}', { code: String(epsg) }, 'E_CRS_UNDEFINED');
    if (!(main[2] > main[0]) || !(main[3] > main[1])) {
      const d = F.projected ? 50 : 5e-4; // a single point: 100 m (or 0.001°) around it
      main = [main[0] - d, main[1] - d, main[2] + d, main[3] + d];
    }
    let ov = null;
    if (o.overview) {
      const [X0, Y0, X1, Y1] = main;
      const cx = (X0 + X1) / 2;
      const cy = (Y0 + Y1) / 2;
      const s = 3 * Math.max(X1 - X0, Y1 - Y0);
      ov = [cx - s, cy - s, cx + s, cy + s];
      const all = bboxOf(featLL, F.fwd);
      if (all) ov = [Math.min(ov[0], all[0]), Math.min(ov[1], all[1]), Math.max(ov[2], all[2]), Math.max(ov[3], all[3])];
    }
    const [pw, ph] = PAGES[o.page] ?? PAGES.A4;
    const [wMm, hMm] = o.landscape ? [Math.max(pw, ph), Math.min(pw, ph)] : [Math.min(pw, ph), Math.max(pw, ph)];
    const L = layout({ widthMm: wMm, heightMm: hMm, main: { name: t('Main map'), extent: main }, overview: ov ? { name: t('Overview map'), extent: ov } : null });
    const image = o.imagery && l?.modelId ? await frameImage(p, l, L.frames[0], F, o.dpi / 72) : null;
    const gcs = { epsg, wkt: F.wkt, projected: F.projected };
    const frames = [{ name: L.frames[0].name, gcs, toLatLon: F.toLatLon, fwd: F.fwd, image, layers }];
    if (ov) frames.push({ name: L.frames[1].name, gcs, toLatLon: F.toLatLon, fwd: F.fwd, image: null, layers: layers.map((V) => ({ ...V, attributes: false, features: V.features.map((f) => ({ ...f, label: null })), style: { ...V.style, width: 0.6 } })), extentOf: L.frames[0].extent });
    const title = o.title ?? l?.rec?.name ?? t('GIS Workbench map');
    const doc = compose(L, {
      title,
      frames,
      units: F.units,
      extentName: t('Main map extent'),
      elementsName: t('Map elements'),
      textsName: t('Map text'),
      notes: [t('{crs} · EPSG:{code}', { crs: /^(?:PROJCS|GEOGCS)\["([^"]+)"/.exec(F.wkt ?? '')?.[1] ?? F.label, code: String(epsg) }), t('Made with GIS Workbench on {date}', { date: new Date().toISOString().slice(0, 10) })],
    });
    doc.info = { subject: t('GeoPDF map'), author: app.prefs?.get?.('analyst') ?? '', keywords: 'GIS Workbench GeoPDF' };
    // Unicode text through the fonts pack (Helvetica, or '?' without the pack: pdfFontsFor says so once).
    const fonts = await pdfFontsFor(app, textsOf(doc), { bold: boldTextsOf(doc) });
    const bytes = writeGeoPdf(doc, { fonts, deflate: (u8) => zlibSync(u8, { level: 6 }) });
    return { bytes, epsg, frames: L.frames.length, layers: layers.length, features: layers.reduce((n, V) => n + V.features.length, 0), image: !!image };
  }

  async function dialog() {
    const p = pane();
    const l = p?.geoLayer?.() ?? null;
    const ic = l ? layerCrs(l) : null;
    const opt = (value, label) => h('option', { value }, label);
    const crsSel = h('select', { class: 'inp', 'aria-label': t('Coordinate system') }, opt('auto', t('UTM zone of the view (WGS 84)')), ic?.epsg && ic.kind !== 'longlat' ? opt('image', t('The image’s CRS ({crs})', { crs: `EPSG:${ic.epsg}` })) : null, opt('3857', t('Web Mercator (EPSG:3857)')), opt('4326', t('Longitude and latitude (EPSG:4326)')), opt('custom', t('Other EPSG code…')));
    const code = h('input', { class: 'inp', type: 'number', min: 1024, max: 999999, placeholder: '32633', 'aria-label': t('EPSG code') });
    const page = h('select', { class: 'inp', 'aria-label': t('Page size') }, ...Object.keys(PAGES).map((k) => opt(k, k)));
    const orient = h('select', { class: 'inp', 'aria-label': t('Orientation') }, opt('landscape', t('Landscape')), opt('portrait', t('Portrait')));
    const chk = (label, on = true) => {
      const c = h('input', { type: 'checkbox', style: { width: '18px', height: '18px', margin: '3px' } }); // 24 px target (WCAG 2.2, 2.5.8)
      c.checked = on;
      return [c, h('label', { class: 'fld fld-check' }, c, h('span', {}, label))];
    };
    const [ovC, ovL] = chk(t('Overview frame (a second georeferenced map)'));
    const [atC, atL] = chk(t('Feature attributes (read by GDAL, QGIS and ArcGIS)'));
    const [imC, imL] = chk(t('Imagery'), !!l?.modelId);
    const [lbC, lbL] = chk(t('Labels from feature names'));
    const title = h('input', { class: 'inp', type: 'text', value: l?.rec?.name ?? '', 'aria-label': t('Title') });
    const res = await modal({
      title: t('GeoPDF Map'),
      body: h('div', {}, section(t('Map'), field(t('Coordinate system'), crsSel), field(t('EPSG code'), code, t('Used with “Other EPSG code”. Codes outside the built-in set need the PROJ pack.')), field(t('Page size'), page), field(t('Orientation'), orient), field(t('Title'), title)), section(t('Content'), ovL, atL, imL, lbL)),
      buttons: [
        { label: t('Save GeoPDF…'), value: 'ok', primary: true },
        { label: t('Cancel'), value: 'cancel' },
      ],
      width: 520,
      id: 'geopdf',
    });
    if (res !== 'ok') return null;
    const epsg = crsSel.value === 'custom' ? Number(code.value) : crsSel.value === 'auto' || crsSel.value === 'image' ? crsSel.value : Number(crsSel.value);
    if (crsSel.value === 'custom' && !(epsg > 0)) throw gwError('enter an EPSG code', null, 'E_STEP_FIRST');
    return { epsg, page: page.value, landscape: orient.value === 'landscape', overview: ovC.checked, attributes: atC.checked, imagery: imC.checked, labels: lbC.checked, title: title.value.trim() || null };
  }

  async function run() {
    try {
      const o = await dialog();
      if (!o) return;
      const r = await exportMap(o);
      const stem = (o.title ?? pane()?.geoLayer?.()?.rec?.name ?? 'map').replace(/\.\w+$/, '').replace(/[^\w.-]+/g, '_') || 'map';
      await saveBlob(app, new Blob([r.bytes], { type: 'application/pdf' }), { name: `${stem}_geo.pdf`, types: ['.pdf'], description: 'GeoPDF' });
      app.toast(t('GeoPDF: EPSG:{code}, {frames, plural, one {# map frame} other {# map frames}}, {n, plural, one {# vector layer} other {# vector layers}} ({count, plural, one {# feature} other {# features}})', { code: String(r.epsg), frames: r.frames, n: r.layers, count: r.features }), { kind: 'info' });
    } catch (e) {
      app.toast(t('{label}: {msg}', { label: tr(N_('GeoPDF Map')), msg: msgOf(e) }), { kind: 'warn', ms: 9000 });
    }
  }
  return { exportMap, run };
}
