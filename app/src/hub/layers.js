// Illustrator bridge (2.0 plan P7; REQ-HUB-02): the view as a layered vector document.
//   PDF: each layer is an optional-content group (Illustrator, Acrobat and QGIS show them as
//        layers): Imagery (a JPEG), then one group per vector layer, the graphics, the neatline
//        and the scale bar, as real paths at the view's scale, with a GeoPDF viewport.
//   SVG: the same layers as Inkscape/Illustrator layer groups, the imagery embedded.
// Layers are [{name, items: [{kind: 'poly'|'line'|'point'|'text', pts: [[x, y]], stroke, fill,
// width, label}]}] in output pixels (y down); 1 px = 0.75 pt (96 dpi).

const enc = new TextEncoder();
const pdfStr = (s) => `(${String(s ?? '').replace(/[^\x20-\xff]/g, '?').replace(/[\\()]/g, (c) => `\\${c}`)})`;
const xmlEsc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** '#rrggbb' or '#rrggbbaa' → [r, g, b, a] in 0…1. */
export function rgba(hex, dflt = [0, 0.9, 1, 1]) {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(hex ?? ''));
  if (!m) return dflt;
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, m[2] ? parseInt(m[2], 16) / 255 : 1];
}

const PT = 0.75;

/** Layered PDF: {width, height (px), jpeg (bytes of the imagery), layers, title, geo: corners [[lat, lon] UL, UR, LR, LL]}. */
export function layeredPdf({ width, height, jpeg, imgW, imgH, layers, title = 'GIS Workbench', geo = null }) {
  const W = width * PT;
  const H = height * PT;
  const chunks = [];
  let size = 0;
  const offsets = [];
  const push = (x) => {
    const b = typeof x === 'string' ? enc.encode(x) : x;
    chunks.push(b);
    size += b.length;
  };
  const obj = (n, body) => {
    offsets[n] = size;
    push(`${n} 0 obj\n`);
    if (typeof body === 'string') push(`${body}\nendobj\n`);
    else {
      push(body.dict);
      push('\nstream\n');
      push(body.data);
      push('\nendstream\nendobj\n');
    }
  };
  const groups = ['Imagery', ...layers.map((l) => l.name)];
  // 1 catalog, 2 pages, 3 page, 4 contents, 5 image, 6 info, 7.. OCGs, then the font
  const ocg = groups.map((_, i) => 7 + i);
  const next = 7 + groups.length;
  push('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n');
  obj(1, `<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [${ocg.map((n) => `${n} 0 R`).join(' ')}] /D << /Order [${ocg.map((n) => `${n} 0 R`).join(' ')}] /ON [${ocg.map((n) => `${n} 0 R`).join(' ')}] >> >> >>`);
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  let vp = '';
  if (geo?.length === 4) {
    const [ul, ur, lr, ll] = geo;
    const g = [ll, ul, ur, lr].map(([la, lo]) => `${la.toFixed(9)} ${lo.toFixed(9)}`).join(' ');
    vp = ` /VP [<< /Type /Viewport /Name (Map frame) /BBox [0 0 ${W.toFixed(4)} ${H.toFixed(4)}] /Measure << /Type /Measure /Subtype /GEO /Bounds [0 0 0 1 1 1 1 0] /GPTS [${g}] /LPTS [0 0 0 1 1 1 1 0] /GCS << /Type /GEOGCS /EPSG 4326 >> >> >>]`;
  }
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W.toFixed(3)} ${H.toFixed(3)}]${vp} /Resources << /XObject << /Im0 5 0 R >> /Font << /F0 ${next} 0 R >> /Properties << ${ocg.map((n, i) => `/oc${i} ${n} 0 R`).join(' ')} >> >> /Contents 4 0 R >>`);
  const f = (v) => (+v).toFixed(2);
  const P = ([x, y]) => `${f(x * PT)} ${f(H - y * PT)}`;
  const ops = [`/OC /oc0 BDC q ${f(W)} 0 0 ${f(H)} 0 0 cm /Im0 Do Q EMC`];
  layers.forEach((L, li) => {
    ops.push(`/OC /oc${li + 1} BDC`);
    for (const it of L.items) {
      const [r, g, b] = rgba(it.stroke);
      const fl = it.fill ? rgba(it.fill) : null;
      const w = (it.width ?? 2) * PT;
      if (it.kind === 'point') {
        const [x, y] = it.pts[0];
        const k = 4;
        ops.push(`q ${r} ${g} ${b} RG ${w} w ${f((x - k) * PT)} ${f(H - (y - k) * PT)} m ${f((x + k) * PT)} ${f(H - (y + k) * PT)} l ${f((x + k) * PT)} ${f(H - (y - k) * PT)} m ${f((x - k) * PT)} ${f(H - (y + k) * PT)} l S Q`);
      } else if (it.kind === 'text') {
        ops.push(`q ${r} ${g} ${b} rg BT /F0 10 Tf ${P(it.pts[0])} Td ${pdfStr(it.label)} Tj ET Q`);
        continue;
      } else if (it.pts.length >= 2) {
        const path = it.pts.map((p, i) => `${P(p)} ${i ? 'l' : 'm'}`).join(' ');
        const close = it.kind === 'poly' ? ' h' : '';
        const paint = it.kind === 'poly' && fl && fl[3] > 0 ? 'B' : 'S';
        ops.push(`q ${r} ${g} ${b} RG ${fl ? `${fl[0]} ${fl[1]} ${fl[2]} rg` : ''} ${w} w ${path}${close} ${paint} Q`);
      }
      if (it.label && it.pts.length) ops.push(`q ${r} ${g} ${b} rg BT /F0 9 Tf ${P([it.pts[0][0] + 4, it.pts[0][1] - 4])} Td ${pdfStr(it.label)} Tj ET Q`);
    }
    ops.push('EMC');
  });
  const text = ops.join('\n');
  const content = enc.encode(text);
  obj(4, { dict: `<< /Length ${content.length} >>`, data: content });
  obj(5, { dict: `<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, data: jpeg });
  obj(6, `<< /Title ${pdfStr(title)} /Creator (GIS Workbench) /Producer (GIS Workbench PDF writer) >>`);
  groups.forEach((g, i) => obj(ocg[i], `<< /Type /OCG /Name ${pdfStr(g)} >>`));
  const fontObj = next;
  obj(fontObj, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const xref = size;
  push(`xref\n0 ${fontObj + 1}\n0000000000 65535 f \n`);
  for (let n = 1; n <= fontObj; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${fontObj + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Layered SVG: the imagery as an embedded image, each layer a group Illustrator and Inkscape treat as a layer. */
export function layeredSvg({ width, height, imageHref, layers, title = 'GIS Workbench' }) {
  const n = (v) => (+v).toFixed(2);
  const g = layers.map((L) => {
    const items = L.items.map((it) => {
      const [r, gg, b, a] = rgba(it.stroke);
      const stroke = `rgb(${Math.round(r * 255)},${Math.round(gg * 255)},${Math.round(b * 255)})`;
      const fl = it.fill ? rgba(it.fill) : null;
      const fill = fl ? `rgb(${Math.round(fl[0] * 255)},${Math.round(fl[1] * 255)},${Math.round(fl[2] * 255)})" fill-opacity="${n(fl[3])}` : 'none';
      const lab = it.label ? `<text x="${n(it.pts[0][0] + 4)}" y="${n(it.pts[0][1] - 4)}" fill="${stroke}" font-family="Arial" font-size="12">${xmlEsc(it.label)}</text>` : '';
      if (it.kind === 'point') return `<circle cx="${n(it.pts[0][0])}" cy="${n(it.pts[0][1])}" r="4" fill="none" stroke="${stroke}" stroke-width="${n(it.width ?? 2)}"/>${lab}`;
      if (it.kind === 'text') return lab || `<text x="${n(it.pts[0][0])}" y="${n(it.pts[0][1])}" fill="${stroke}" font-family="Arial" font-size="12">${xmlEsc(it.label)}</text>`;
      const pts = it.pts.map(([x, y]) => `${n(x)},${n(y)}`).join(' ');
      return `<${it.kind === 'poly' ? 'polygon' : 'polyline'} points="${pts}" fill="${it.kind === 'poly' ? fill : 'none'}" stroke="${stroke}" stroke-opacity="${n(a)}" stroke-width="${n(it.width ?? 2)}"/>${lab}`;
    });
    return `<g id="${xmlEsc(L.name.replace(/\s+/g, '_'))}" inkscape:label="${xmlEsc(L.name)}" inkscape:groupmode="layer">${items.join('')}</g>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>${xmlEsc(title)}</title><g id="Imagery" inkscape:label="Imagery" inkscape:groupmode="layer"><image x="0" y="0" width="${width}" height="${height}" xlink:href="${imageHref}"/></g>${g.join('')}</svg>`;
}
