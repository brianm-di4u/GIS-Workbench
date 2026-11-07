// GeoPDF map writer (REQ-GAP-66, SDP-2.3 §2 GR-24; lazy block js-geopdf): one page with several
// map frames, each an ISO 32000-2 geospatial viewport in its own CRS, vector layers with their
// attributes, imagery, and Unicode text.
//
// * Projected CRSs: a frame's /GEO measure names the CRS (/GCS << /Type /PROJCS /EPSG n /WKT (…) >>,
//   or /GEOGCS for longitude/latitude frames); its GPTS are latitude/longitude in that CRS's own
//   datum, as ISO 32000-2 §12.10 requires, at the corners of the frame (LPTS: the BBox's unit
//   square). The page is drawn linearly in the CRS, so readers recover X/Y exactly.
// * Several frames: one viewport each (a main map, an overview, …); each frame's content is clipped
//   to its box and its layers are optional-content groups named "<frame>: <layer>" when there is
//   more than one frame.
// * Attributes as GDAL's PDF driver writes and reads them: /MarkInfo << /UserProperties true >>,
//   a structure tree of layer elements (/S /Feature /T name) whose kids are feature elements
//   (/S /feature, /K MCID, /A << /O /UserProperties /P [<< /N name /V value >> …] >>), each
//   feature's drawing inside `/feature <</MCID n>> BDC … EMC`. Points are circles (GDAL's symbol,
//   read back as points). Values: numbers, 1/0 for booleans (as GDAL), text strings in any script.
// * Text: Helvetica when every string fits WinAnsi; otherwise the fonts-noto pack's subset Type0
//   fonts (formats/pdf-text.js PdfFonts, prepared by the caller), or '?' without the pack.
// * Content streams FlateDecode (the caller's deflate), objects uncompressed (PDF 1.7).
//
// layout(spec) places the frames on the page; compose(spec, layoutResult, data) projects features
// into them; writeGeoPdf(doc) writes the bytes. All coordinates here are PDF points, y up.

import { textStr, winStr, HELVETICA } from './pdf-text.js';

const enc = new TextEncoder();
const MM = 72 / 25.4;
const KAPPA = 0.5522847498;

const f3 = (v) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};

/** '#rrggbb' or '#rrggbbaa' → [r, g, b, a] in 0…1. */
export function rgba(hex, dflt = [0, 0, 0, 1]) {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(hex ?? ''));
  if (!m) return dflt;
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, m[2] ? parseInt(m[2], 16) / 255 : 1];
}
const col = (c) => c.slice(0, 3).map((v) => f3(v)).join(' ');

/** A PDF attribute value (GDAL's types): number, 1/0, text string; null for none. */
export function pdfValue(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : String(+v.toPrecision(15))) : null;
  if (v instanceof Date) return textStr(v.toISOString());
  if (typeof v === 'object') return textStr(JSON.stringify(v));
  return textStr(String(v));
}

/**
 * Page layout: {width, height (pt), frames: [{name, box: [x0, y0, x1, y1], extent: [X0, Y0, X1, Y1]}]}.
 * spec: {widthMm, heightMm, main: {extent}, overview: {extent} | null, title}. The main frame takes
 * the left of the page, the overview and the legend the right column; each extent is widened to
 * its frame's shape so the scale is the same along X and Y.
 */
export function layout(spec) {
  const W = spec.widthMm * MM;
  const H = spec.heightMm * MM;
  const m = 18;
  const top = H - m - 28; // title band
  const bottom = m + 30; // CRS / scale band
  const side = spec.overview ? Math.min(0.3 * (W - 2 * m), 220) : 0;
  const fit = (box, ext) => {
    const [x0, y0, x1, y1] = box;
    let [X0, Y0, X1, Y1] = ext;
    const bw = x1 - x0;
    const bh = y1 - y0;
    const ew = Math.max(X1 - X0, 1e-9);
    const eh = Math.max(Y1 - Y0, 1e-9);
    // Widen the extent to the box's shape.
    if (ew / eh > bw / bh) {
      const need = (ew * bh) / bw;
      Y0 -= (need - eh) / 2;
      Y1 += (need - eh) / 2;
    } else {
      const need = (eh * bw) / bh;
      X0 -= (need - ew) / 2;
      X1 += (need - ew) / 2;
    }
    return [X0, Y0, X1, Y1];
  };
  // The main frame takes the extent's shape inside its area (top left), so the map has no blank bands.
  let mainBox = [m, bottom, W - m - (side ? side + 12 : 0), top];
  const [eX0, eY0, eX1, eY1] = spec.main.extent;
  const ar = (eX1 - eX0) / Math.max(eY1 - eY0, 1e-12);
  if (Number.isFinite(ar) && ar > 0) {
    const [x0, y0, x1, y1] = mainBox;
    if (ar > (x1 - x0) / (y1 - y0)) mainBox = [x0, y1 - (x1 - x0) / ar, x1, y1];
    else mainBox = [x0, y0, x0 + (y1 - y0) * ar, y1];
  }
  const frames = [{ name: spec.main.name, box: mainBox, extent: fit(mainBox, spec.main.extent) }];
  if (spec.overview) {
    const ox0 = W - m - side;
    const obox = [ox0, top - side, W - m, top];
    frames.push({ name: spec.overview.name, box: obox, extent: fit(obox, spec.overview.extent) });
  }
  return { width: W, height: H, frames, legendBox: spec.overview ? [W - m - side, bottom, W - m, top - side - 14] : null };
}

/** A projected point → page point in a frame. */
const toPage = (fr) => {
  const [x0, y0, x1, y1] = fr.box;
  const [X0, Y0, X1, Y1] = fr.extent;
  const sx = (x1 - x0) / (X1 - X0);
  const sy = (y1 - y0) / (Y1 - Y0);
  return (X, Y) => [x0 + (X - X0) * sx, y0 + (Y - Y0) * sy];
};

/** A nice scale-bar length (1, 2 or 5 × 10^n) not over `max` units. */
export function niceLength(max) {
  const p = 10 ** Math.floor(Math.log10(max));
  return [5, 2, 1].map((k) => k * p).find((v) => v <= max) ?? p;
}

/**
 * The document for writeGeoPdf. data: {frames: [{name, gcs: {epsg, wkt, projected}, toLatLon(X, Y) →
 * [lat, lon] in the CRS's datum, fwd(lon, lat) → [X, Y] from WGS 84, image: {jpeg, width, height} |
 * null, layers: [{name, style: {stroke, fill, width}, attributes: bool, features: [{geom (GeoJSON,
 * WGS 84), label, attrs: {k: v}, style}]}], extentOf: [X0, Y0, X1, Y1] | null (a box drawn in this
 * frame: the main map's extent in the overview)}], title, notes: [lines at the foot], units,
 * legend: bool}. Strings for fonts: textsOf(doc).
 */
export function compose(L, data) {
  const doc = { width: L.width, height: L.height, title: data.title, frames: [], layers: [], texts: [] };
  const multi = L.frames.length > 1;
  L.frames.forEach((fr, fi) => {
    const d = data.frames[fi];
    const P = toPage(fr);
    const [X0, Y0, X1, Y1] = fr.extent;
    const corners = [[X0, Y0], [X0, Y1], [X1, Y1], [X1, Y0]].map(([X, Y]) => d.toLatLon(X, Y)); // LL, UL, UR, LR
    doc.frames.push({ name: fr.name, bbox: fr.box, gpts: corners, gcs: d.gcs });
    const lname = (n) => (multi ? `${fr.name}: ${n}` : n);
    if (d.image) doc.layers.push({ name: lname(d.image.name ?? 'Imagery'), frame: fi, image: { ...d.image, rect: fr.box }, features: [] });
    for (const V of d.layers) {
      const feats = [];
      for (const f of V.features) {
        const g = f.geom;
        if (!g) continue;
        const st = { ...V.style, ...(f.style ?? {}) };
        const proj = (c) => P(...d.fwd(c[0], c[1]));
        const base = { stroke: st.stroke ?? '#000000', fill: st.fill ?? null, width: st.width ?? 1, label: f.label ?? null, attrs: V.attributes ? f.attrs ?? {} : null };
        switch (g.type) {
          case 'Point':
            feats.push({ ...base, kind: 'point', parts: [[proj(g.coordinates)]] });
            break;
          case 'MultiPoint':
            feats.push({ ...base, kind: 'point', parts: g.coordinates.map((c) => [proj(c)]) });
            break;
          case 'LineString':
            feats.push({ ...base, kind: 'line', parts: [g.coordinates.map(proj)] });
            break;
          case 'MultiLineString':
            feats.push({ ...base, kind: 'line', parts: g.coordinates.map((r) => r.map(proj)) });
            break;
          case 'Polygon':
            feats.push({ ...base, kind: 'poly', parts: g.coordinates.map((r) => r.map(proj)) });
            break;
          case 'MultiPolygon':
            feats.push({ ...base, kind: 'poly', parts: g.coordinates.flatMap((p) => p.map((r) => r.map(proj))) });
            break;
          default:
            break;
        }
      }
      doc.layers.push({ name: lname(V.name), sname: V.name, frame: fi, features: feats, attributes: !!V.attributes });
    }
    if (d.extentOf) {
      const [a, b, c, e] = d.extentOf;
      doc.layers.push({ name: lname(data.extentName ?? 'Main map extent'), frame: fi, features: [{ kind: 'line', parts: [[[a, b], [c, b], [c, e], [a, e], [a, b]].map(([X, Y]) => P(X, Y))], stroke: '#e00000', width: 1.5 }] });
    }
  });
  // Map elements: neatlines, the frame names, the scale bar of the main frame, the legend, the foot notes.
  const els = [];
  const texts = [];
  L.frames.forEach((fr) => {
    const [x0, y0, x1, y1] = fr.box;
    els.push({ kind: 'line', parts: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]], stroke: '#000000', width: 0.8 });
    if (multi) texts.push({ text: fr.name, at: [x0, y1 + 3], size: 8 });
  });
  const main = L.frames[0];
  const metres = data.frames[0].gcs.projected ? data.units ?? 1 : null;
  if (metres) {
    const [x0, y0, x1] = main.box;
    const [X0, , X1] = main.extent;
    const perPt = (X1 - X0) / (x1 - x0); // CRS units per point
    const len = niceLength((perPt * (x1 - x0)) / 4);
    const w = len / perPt;
    els.push({ kind: 'line', parts: [[[x0, y0 - 14], [x0 + w, y0 - 14]], [[x0, y0 - 11], [x0, y0 - 17]], [[x0 + w, y0 - 11], [x0 + w, y0 - 17]]], stroke: '#000000', width: 1.5 });
    const m = len * metres;
    texts.push({ text: data.scaleText?.(m) ?? (m >= 1000 ? `${+(m / 1000).toPrecision(6)} km` : `${+m.toPrecision(6)} m`), at: [x0 + w + 6, y0 - 17], size: 8 });
  }
  if (L.legendBox && data.legend !== false) {
    const [lx0, , , ly1] = L.legendBox;
    let y = ly1 - 10;
    for (const V of data.frames[0].layers) {
      if (y < L.legendBox[1] + 10) break;
      const st = V.style ?? {};
      els.push({ kind: 'poly', parts: [[[lx0, y], [lx0 + 14, y], [lx0 + 14, y + 8], [lx0, y + 8], [lx0, y]]], stroke: st.stroke ?? '#000000', fill: st.fill ?? null, width: 0.8 });
      texts.push({ text: V.name, at: [lx0 + 20, y + 1], size: 8 });
      y -= 14;
    }
  }
  if (data.title) texts.push({ text: data.title, at: [main.box[0], L.height - 34], size: 14, bold: true });
  (data.notes ?? []).forEach((n, i) => texts.push({ text: n, at: [main.box[0] + (metres ? 150 : 0), main.box[1] - 14 - 10 * i], size: 7 }));
  doc.layers.push({ name: data.elementsName ?? 'Map elements', frame: -1, features: els });
  doc.texts = texts;
  doc.textsLayer = data.textsName ?? 'Map text';
  return doc;
}

/** Every string a document shows (for pdfFontsFor). */
export const textsOf = (doc) => [...doc.texts.filter((x) => !x.bold).map((x) => x.text), ...doc.layers.flatMap((l) => l.features.map((f) => f.label).filter(Boolean))];
export const boldTextsOf = (doc) => doc.texts.filter((x) => x.bold).map((x) => x.text);

/** Path operators of one feature (page points). */
function pathOps(f) {
  const out = [];
  if (f.kind === 'point') {
    const r = 3;
    const k = r * KAPPA;
    for (const [[x, y]] of f.parts) out.push(`${f3(x + r)} ${f3(y)} m ${f3(x + r)} ${f3(y + k)} ${f3(x + k)} ${f3(y + r)} ${f3(x)} ${f3(y + r)} c ${f3(x - k)} ${f3(y + r)} ${f3(x - r)} ${f3(y + k)} ${f3(x - r)} ${f3(y)} c ${f3(x - r)} ${f3(y - k)} ${f3(x - k)} ${f3(y - r)} ${f3(x)} ${f3(y - r)} c ${f3(x + k)} ${f3(y - r)} ${f3(x + r)} ${f3(y - k)} ${f3(x + r)} ${f3(y)} c h`);
    return out.join(' ');
  }
  for (const part of f.parts) {
    if (part.length < 2) continue;
    out.push(part.map(([x, y], i) => `${f3(x)} ${f3(y)} ${i ? 'l' : 'm'}`).join(' ') + (f.kind === 'poly' ? ' h' : ''));
  }
  return out.join(' ');
}

/**
 * The PDF bytes. doc: {width, height, title, info, frames: [{name, bbox, gpts [[lat, lon] LL, UL,
 * UR, LR], gcs: {epsg, wkt, projected}}], layers: [{name, frame (-1: the page), image?: {jpeg,
 * width, height, rect}, features: [{kind, parts, stroke, fill, width, label, attrs}], attributes}],
 * texts: [{text, at, size, bold}], textsLayer}. opts: {fonts: PdfFonts with every string added (or
 * null for Helvetica), deflate(Uint8Array) → zlib bytes (or null: uncompressed)}.
 */
export function writeGeoPdf(doc, { fonts = null, deflate = null } = {}) {
  const objs = [];
  let next = 1;
  const alloc = () => next++;
  const put = (n, body) => (objs[n] = body);
  const CAT = alloc();
  const PAGES = alloc();
  const PAGE = alloc();
  const CONTENT = alloc();
  const INFO = alloc();
  // Viewports, measures and CRS dictionaries as their own objects (GDAL's layout).
  const vps = doc.frames.map((fr) => {
    const [vp, ms, gcs] = [alloc(), alloc(), alloc()];
    const [x0, y0, x1, y1] = fr.bbox;
    const g = fr.gpts.map(([la, lo]) => `${la.toFixed(10)} ${lo.toFixed(10)}`).join(' ');
    put(vp, `<< /Type /Viewport /Name ${textStr(fr.name)} /BBox [${f3(x0)} ${f3(y0)} ${f3(x1)} ${f3(y1)}] /Measure ${ms} 0 R >>`);
    put(ms, `<< /Type /Measure /Subtype /GEO /Bounds [0 0 0 1 1 1 1 0] /GPTS [${g}] /LPTS [0 0 0 1 1 1 1 0] /GCS ${gcs} 0 R /PDU [/M /SQM /DEG] >>`);
    put(gcs, `<< /Type /${fr.gcs.projected ? 'PROJCS' : 'GEOGCS'}${fr.gcs.epsg ? ` /EPSG ${fr.gcs.epsg}` : ''}${fr.gcs.wkt ? ` /WKT ${textStr(fr.gcs.wkt)}` : ''} >>`);
    return vp;
  });
  const layers = doc.layers.filter((l) => l.image || l.features.length);
  const ocgs = layers.map(() => alloc());
  const textOcg = doc.texts.length ? alloc() : null;
  const images = layers.map((l) => (l.image ? alloc() : null));
  const structured = layers.some((l) => l.attributes && l.features.length);
  const ROOT = structured ? alloc() : null;
  const PTREE = structured ? alloc() : null;
  const alphas = new Map();
  const gsName = (a) => {
    const k = f3(a);
    if (!alphas.has(k)) alphas.set(k, `GA${alphas.size}`);
    return alphas.get(k);
  };
  const label = (text, size, [x, y], bold = false) => (fonts ? `BT ${f3(x)} ${f3(y)} Td ${fonts.show(String(text), size, { bold })} ET` : `BT /F0 ${size} Tf ${f3(x)} ${f3(y)} Td ${winStr(text)} Tj ET`);
  const ops = [];
  const layerEls = [];
  const featEls = []; // by MCID
  let mcid = 0;
  layers.forEach((L, li) => {
    ops.push(`/OC /oc${li} BDC`);
    const fr = L.frame >= 0 ? doc.frames[L.frame] : null;
    if (fr) {
      const [x0, y0, x1, y1] = fr.bbox;
      ops.push(`q ${f3(x0)} ${f3(y0)} ${f3(x1 - x0)} ${f3(y1 - y0)} re W n`);
    }
    if (L.image) {
      const [x0, y0, x1, y1] = L.image.rect;
      ops.push(`q ${f3(x1 - x0)} 0 0 ${f3(y1 - y0)} ${f3(x0)} ${f3(y0)} cm /Im${li} Do Q`);
    }
    const kids = [];
    const labels = [];
    for (const f of L.features) {
      const path = pathOps(f);
      if (!path) continue;
      const s = rgba(f.stroke);
      const fl = f.fill ? rgba(f.fill) : null;
      // Polygons are always filled (transparent when unstyled): readers take a stroked-only path for a line.
      const fill = f.kind !== 'line';
      const fc = f.kind === 'point' ? fl ?? s : fl && fl[3] > 0 ? fl : [...s.slice(0, 3), 0];
      let gs = '';
      if (fill && fc[3] < 1) gs = `/${gsName(fc[3])} gs `;
      const paint = f.kind === 'line' ? 'S' : fill ? (f.kind === 'point' ? 'b' : 'b*') : 's';
      const body = `q ${gs}${col(s)} RG ${fill ? `${col(fc)} rg ` : ''}${f3(f.width ?? 1)} w 1 j 1 J ${path} ${paint} Q`;
      if (L.attributes && f.attrs) {
        ops.push(`/feature <</MCID ${mcid}>> BDC ${body} EMC`);
        kids.push({ mcid: mcid++, attrs: f.attrs });
      } else ops.push(body);
      if (f.label) labels.push(f);
    }
    for (const f of labels) {
      const [x, y] = f.parts[0][0];
      ops.push(`q ${col(rgba(f.stroke))} rg ${label(f.label, 8, [x + 4, y + 3])} Q`);
    }
    if (fr) ops.push('Q');
    ops.push('EMC');
    if (kids.length) {
      const el = alloc();
      const kidObjs = kids.map((k) => {
        const n = alloc();
        featEls[k.mcid] = n;
        const props = Object.entries(k.attrs)
          .map(([key, v]) => [key, pdfValue(v)])
          .filter(([, v]) => v !== null)
          .map(([key, v]) => `<< /N ${textStr(key)} /V ${v} >>`)
          .join(' ');
        put(n, `<< /Type /StructElem /S /feature /P ${el} 0 R /Pg ${PAGE} 0 R /K ${k.mcid} /T ${textStr(`feature${k.mcid}`)} /A << /O /UserProperties /P [${props}] >> >>`);
        return n;
      });
      put(el, `<< /Type /StructElem /S /Feature /P ${ROOT} 0 R /T ${textStr(L.sname ?? L.name)} /A << /O /UserProperties >> /K [${kidObjs.map((n) => `${n} 0 R`).join(' ')}] >>`);
      layerEls.push(el);
    }
  });
  if (doc.texts.length) {
    ops.push(`/OC /octx BDC q 0 0 0 rg`);
    for (const x of doc.texts) ops.push(label(x.text, x.size, x.at, !!x.bold));
    ops.push('Q EMC');
  }
  let content = enc.encode(ops.join('\n'));
  const filter = deflate ? ' /Filter /FlateDecode' : '';
  if (deflate) content = deflate(content);
  put(CONTENT, { dict: `<< /Length ${content.length}${filter} >>`, data: content });
  const fontObj = fonts ? null : alloc();
  if (fonts) next = fonts.allocate(next);
  const allOcgs = [...ocgs, ...(textOcg ? [textOcg] : [])];
  const ocgRefs = allOcgs.map((n) => `${n} 0 R`).join(' ');
  layers.forEach((L, i) => put(ocgs[i], `<< /Type /OCG /Name ${textStr(L.name)} >>`));
  if (textOcg) put(textOcg, `<< /Type /OCG /Name ${textStr(doc.textsLayer ?? 'Map text')} >>`);
  layers.forEach((L, i) => {
    if (!L.image) return;
    put(images[i], { dict: `<< /Type /XObject /Subtype /Image /Width ${L.image.width} /Height ${L.image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${L.image.jpeg.length} >>`, data: L.image.jpeg });
  });
  const xo = layers.map((L, i) => (L.image ? `/Im${i} ${images[i]} 0 R` : '')).filter(Boolean).join(' ');
  const props = [...layers.map((_, i) => `/oc${i} ${ocgs[i]} 0 R`), ...(textOcg ? [`/octx ${textOcg} 0 R`] : [])].join(' ');
  const egs = [...alphas].map(([a, n]) => `/${n} << /Type /ExtGState /ca ${a} /CA 1 >>`).join(' ');
  put(PAGE, `<< /Type /Page /Parent ${PAGES} 0 R /MediaBox [0 0 ${f3(doc.width)} ${f3(doc.height)}] /VP [${vps.map((n) => `${n} 0 R`).join(' ')}] /Resources << ${xo ? `/XObject << ${xo} >> ` : ''}/Font << ${fonts ? fonts.resources() : `/F0 ${fontObj} 0 R`} >> /Properties << ${props} >>${egs ? ` /ExtGState << ${egs} >>` : ''} >> /Contents ${CONTENT} 0 R${structured ? ' /StructParents 0' : ''} >>`);
  put(PAGES, `<< /Type /Pages /Kids [${PAGE} 0 R] /Count 1 >>`);
  if (structured) {
    put(ROOT, `<< /Type /StructTreeRoot /K [${layerEls.map((n) => `${n} 0 R`).join(' ')}] /ParentTree ${PTREE} 0 R /ParentTreeNextKey 1 >>`);
    put(PTREE, `<< /Nums [0 [${featEls.map((n) => `${n} 0 R`).join(' ')}]] >>`);
  }
  put(CAT, `<< /Type /Catalog /Pages ${PAGES} 0 R /OCProperties << /OCGs [${ocgRefs}] /D << /Order [${ocgRefs}] /ON [${ocgRefs}] >> >>${structured ? ` /MarkInfo << /Marked true /UserProperties true >> /StructTreeRoot ${ROOT} 0 R` : ''} /ViewerPreferences << /PrintScaling /None >> >>`);
  const info = doc.info ?? {};
  const now = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  put(INFO, `<< /Title ${textStr(doc.title ?? 'GIS Workbench GeoPDF')}${info.subject ? ` /Subject ${textStr(info.subject)}` : ''}${info.author ? ` /Author ${textStr(info.author)}` : ''}${info.keywords ? ` /Keywords ${textStr(info.keywords)}` : ''} /Creator (GIS Workbench) /Producer (GIS Workbench GeoPDF writer) /CreationDate (D:${now}Z) >>`);
  if (fontObj) put(fontObj, HELVETICA);
  // Serialise.
  const chunks = [];
  let size = 0;
  const offsets = [];
  const push = (x) => {
    const b = typeof x === 'string' ? enc.encode(x) : x;
    chunks.push(b);
    size += b.length;
  };
  const write = (n, body) => {
    offsets[n] = size;
    push(`${n} 0 obj\n`);
    if (typeof body === 'string') push(`${body}\nendobj\n`);
    else {
      push(`${body.dict}\nstream\n`);
      push(body.data);
      push('\nendstream\nendobj\n');
    }
  };
  push('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
  for (let n = 1; n < objs.length; n++) if (objs[n] !== undefined) write(n, objs[n]);
  if (fonts) fonts.emit(write);
  const end = Math.max(next, objs.length);
  const xref = size;
  push(`xref\n0 ${end}\n0000000000 65535 f \n`);
  for (let n = 1; n < end; n++) push(offsets[n] === undefined ? '0000000000 65535 f \n' : `${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${end} /Root ${CAT} 0 R /Info ${INFO} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
