// Minimal PDF 1.4 writer for products (REQ-PRD-03): each page is a stack of JPEG strips
// (DCTDecode image XObjects, each strip under 16 MP), placed edge to edge at the page's exact
// size in points, with the document information (title, marking as subject) and
// /PrintScaling /None so a 1:n page prints at its scale (AT-16.1).

const enc = new TextEncoder();
const MM = 72 / 25.4;

/** PDF text string with escapes (Latin-1 range; anything else becomes '?'). */
const pdfStr = (s) => `(${String(s ?? '').replace(/[^\x20-\xff]/g, '?').replace(/[\\()]/g, (c) => `\\${c}`)})`;

const pdfDate = (d) => `D:${d.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;

/**
 * pages: [{widthMm, heightMm, strips: [{jpeg: Uint8Array, width, height (px), yMm, hMm}], geo?}]
 * (yMm from the top of the page). geo = {frameMm: {x, y, w, h} (from the top left), corners:
 * [[lat, lon] UL, UR, LR, LL]} writes an ISO 32000-2 geospatial viewport (/VP with a /GEO
 * measure in EPSG:4326): a GeoPDF. info: {title, subject, author, keywords}.
 */
export function writePdf(pages, info = {}) {
  const chunks = [];
  let size = 0;
  const offsets = [];
  const push = (x) => {
    const b = typeof x === 'string' ? enc.encode(x) : x;
    chunks.push(b);
    size += b.length;
  };
  // Object numbers: 1 catalog, 2 pages, 3 info, then per page: page, contents, images.
  let next = 4;
  const plan = pages.map((p) => {
    const page = next++;
    const contents = next++;
    const images = p.strips.map(() => next++);
    return { ...p, page, contents, images };
  });
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
  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R /ViewerPreferences << /PrintScaling /None >> >>');
  obj(2, `<< /Type /Pages /Kids [${plan.map((p) => `${p.page} 0 R`).join(' ')}] /Count ${plan.length} >>`);
  const now = pdfDate(new Date());
  obj(3, `<< /Title ${pdfStr(info.title ?? 'GIS Workbench product')} /Subject ${pdfStr(info.subject ?? '')} /Author ${pdfStr(info.author ?? '')} /Keywords ${pdfStr(info.keywords ?? '')} /Creator (GIS Workbench) /Producer (GIS Workbench PDF writer) /CreationDate (${now}) >>`);
  for (const p of plan) {
    const W = p.widthMm * MM;
    const H = p.heightMm * MM;
    const xo = p.images.map((n, i) => `/Im${i} ${n} 0 R`).join(' ');
    let vp = '';
    if (p.geo?.corners?.length === 4) {
      const f = p.geo.frameMm;
      const [x0, y0, x1, y1] = [f.x * MM, H - (f.y + f.h) * MM, (f.x + f.w) * MM, H - f.y * MM];
      const [ul, ur, lr, ll] = p.geo.corners;
      // LPTS: the unit square of the viewport (x right, y up) — LL, UL, UR, LR; GPTS: lat lon pairs.
      const g = [ll, ul, ur, lr].map(([la, lo]) => `${la.toFixed(9)} ${lo.toFixed(9)}`).join(' ');
      vp = ` /VP [<< /Type /Viewport /Name (Map frame) /BBox [${x0.toFixed(4)} ${y0.toFixed(4)} ${x1.toFixed(4)} ${y1.toFixed(4)}] /Measure << /Type /Measure /Subtype /GEO /Bounds [0 0 0 1 1 1 1 0] /GPTS [${g}] /LPTS [0 0 0 1 1 1 1 0] /GCS << /Type /GEOGCS /EPSG 4326 /WKT (GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]) >> >> >>]`;
    }
    obj(p.page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W.toFixed(3)} ${H.toFixed(3)}]${vp} /Resources << /XObject << ${xo} >> >> /Contents ${p.contents} 0 R >>`);
    const ops = p.strips.map((s, i) => `q ${W.toFixed(4)} 0 0 ${(s.hMm * MM).toFixed(4)} 0 ${(H - (s.yMm + s.hMm) * MM).toFixed(4)} cm /Im${i} Do Q`).join('\n');
    const content = enc.encode(ops);
    obj(p.contents, { dict: `<< /Length ${content.length} >>`, data: content });
    p.strips.forEach((s, i) => obj(p.images[i], { dict: `<< /Type /XObject /Subtype /Image /Width ${s.width} /Height ${s.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${s.jpeg.length} >>`, data: s.jpeg }));
  }
  const xref = size;
  push(`xref\n0 ${next}\n0000000000 65535 f \n`);
  for (let n = 1; n < next; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${next} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
