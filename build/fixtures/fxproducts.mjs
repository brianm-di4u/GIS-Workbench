// Inputs for the R3 product and review tests (REQ-PRD-09, REQ-EXT-19):
//   template.pptx   a 10 × 5.625 in template (Georgia/Verdana theme fonts, a navy background and a
//                   logo picture on the master), written with pptxgenjs;
//   fx08_detections.geojson / .csv   ML detections over FX-08: true positives at the field
//                   centres and the 4 × 4 anomaly, false positives on field borders, with
//                   confidences; the truth says which are real.
//
//   node build/fixtures/fxproducts.mjs [outdir]

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import PptxGenJS from 'pptxgenjs';
import proj4 from 'proj4';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.argv[2] ? join(process.argv[2], 'products') : join(ROOT, 'fixtures', 'products');
mkdirSync(OUT, { recursive: true });

// A 64 × 32 PNG logo (orange bar with a white square).
function png(w, h, px) {
  const crc = (b) => {
    let c = ~0;
    for (const x of b) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    return ~c >>> 0;
  };
  const chunk = (t, d) => {
    const b = Buffer.alloc(12 + d.length);
    b.writeUInt32BE(d.length, 0);
    b.write(t, 4, 'latin1');
    d.copy(b, 8);
    b.writeUInt32BE(crc(b.subarray(4, 8 + d.length)), 8 + d.length);
    return b;
  };
  const raw = Buffer.alloc(h * (1 + 4 * w));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + 4 * w)] = 0;
    for (let x = 0; x < w; x++) px(x, y).forEach((v, c) => (raw[y * (1 + 4 * w) + 1 + 4 * x + c] = v));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const logo = png(64, 32, (x, y) => (x > 24 && x < 40 && y > 8 && y < 24 ? [255, 255, 255, 255] : [255, 140, 0, 255]));

const pptx = new PptxGenJS();
pptx.defineLayout({ name: 'T169', width: 10, height: 5.625 });
pptx.layout = 'T169';
pptx.theme = { headFontFace: 'Georgia', bodyFontFace: 'Verdana' };
pptx.defineSlideMaster({ title: 'GW_TEST_TEMPLATE', background: { color: '1F3864' }, objects: [{ image: { x: 8.5, y: 0.2, w: 1.2, h: 0.6, data: `data:image/png;base64,${logo.toString('base64')}` } }] });
pptx.addSlide({ masterName: 'GW_TEST_TEMPLATE' }).addText('Template', { x: 0.5, y: 2, w: 9, h: 1, fontSize: 32, color: 'FFFFFF' });
writeFileSync(join(OUT, 'template.pptx'), await pptx.write({ outputType: 'nodebuffer' }));

// Detections over FX-08 (UTM 11N 2 m; 4 × 4 fields of 128 px).
const t8 = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'fx08', 'fx08_truth.json'), 'utf8'));
const gt = t8.geo.geotransform;
const ll = (c, r) => proj4('+proj=utm +zone=11 +datum=WGS84 +units=m +no_defs', 'EPSG:4326', [gt[0] + gt[1] * c + gt[2] * r, gt[3] + gt[4] * c + gt[5] * r]);
const dets = [];
const box = (cx, cy, half) => [[cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half], [cx - half, cy + half], [cx - half, cy - half]];
// The anomaly (4 × 4 px at 60, 70): a confident true detection.
dets.push({ cls: 'painted metal', confidence: 0.97, ring: box(62, 72, 4), real: true });
// Field centres of class 0 (bare soil?) and 4: true; borders: false, mostly low confidence.
t8.layout.forEach((row, r) =>
  row.forEach((cls, c) => {
    if (cls === 4) dets.push({ cls: t8.classes[cls], confidence: 0.6 + 0.1 * ((r + c) % 3), ring: box(c * 128 + 64, r * 128 + 64, 20), real: true });
    if (cls === 0) dets.push({ cls: 'vehicle', confidence: 0.35 + 0.05 * r, ring: box(c * 128 + 2, r * 128 + 2, 6), real: false });
  }),
);
const features = dets.map((d, i) => ({ type: 'Feature', properties: { label: d.cls, score: d.confidence, id: i + 1 }, geometry: { type: 'Polygon', coordinates: [d.ring.map(([c, r]) => ll(c, r))] } }));
writeFileSync(join(OUT, 'fx08_detections.geojson'), JSON.stringify({ type: 'FeatureCollection', features }));
// The same detections as a pixel-box CSV (image coordinates of fx08.tif).
writeFileSync(join(OUT, 'fx08_detections.csv'), ['class,confidence,xmin,ymin,xmax,ymax', ...dets.map((d) => [d.cls, d.confidence, d.ring[0][0], d.ring[0][1], d.ring[2][0], d.ring[2][1]].join(','))].join('\n') + '\n');
writeFileSync(join(OUT, 'products_truth.json'), JSON.stringify({ template: { size: [10, 5.625], fonts: ['Georgia', 'Verdana'], background: '1F3864', logo: { x: 8.5, y: 0.2, w: 1.2, h: 0.6 } }, detections: dets.map((d, i) => ({ id: i + 1, cls: d.cls, confidence: d.confidence, real: d.real })) }));
console.log(`products fixtures → ${OUT} (${dets.length} detections)`);
