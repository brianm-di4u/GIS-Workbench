// Annotated chips (REQ-PRD-01, AT-01.4, Research/04 §8.1–8.2): imagery rendered offscreen with
// the screen's passes, the panel's graphics and measurements, and burned-in marginalia —
// banners at top and bottom (rolled up, can be raised, never lowered), a caption with chip
// number, image ID, UTC time and centre MGRS, a north arrow and a scale bar valid at the
// chip centre. Each chip writes a chip record (image, corners, chain, banner, time).

import { ChipView, renderImagery } from '../render/offscreen.js';
import { highest, bannerText, bannerColorVar, rank } from '../security/marking.js';
import { chainRecord, chainSummary } from '../render/chain.js';
import { tokenValues, resolveTokens } from './tokens.js';

export const DEFAULT_CAPTION = 'Chip {CHIP_NO} · {IMAGE_ID|image} · {ACQ_DATE|time unknown} · {MGRS_CENTER|no geolocation}';

const cssVar = (name, fb) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;

/** The chip's marking: the highest of its visible layers, the project's and any raise. */
export function chipMarking(app, cv, raise = null) {
  const ms = cv.visibleLayers().map((l) => l.info.marking).filter(Boolean);
  const pm = app.project()?.marking;
  if (pm) ms.push(pm);
  if (raise) ms.push(raise);
  return highest(ms);
}

export function drawBanner(g, m, x, y, w, h) {
  g.fillStyle = cssVar(bannerColorVar(m), '#007a33');
  g.fillRect(x, y, w, h);
  g.fillStyle = '#fff';
  g.font = `bold ${Math.round(h * 0.62)}px Arial, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(bannerText(m), x + w / 2, y + h / 2 + 1);
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
}

/** North arrow at (x, y) pointing to north at the view centre; returns the angle (rad) or null. */
export function drawNorthArrow(app, g, cv, l, x, y, size = 18) {
  const { w, h } = cv.size();
  const c = cv.imagePoint(w / 2, h / 2);
  const gc = l.groundAt(c.x, c.y);
  if (!gc) return null;
  const t = app.core.direct(gc.lat, gc.lon, 0, 50);
  const p1 = l.imageAt(t.lat, t.lon, gc.h);
  if (!p1) return null;
  const a = cv.screenPoint(c.x, c.y);
  const b = cv.screenPoint(p1.x, p1.y);
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  g.save();
  g.translate(x, y);
  g.rotate(ang + Math.PI / 2);
  g.fillStyle = '#fff';
  g.strokeStyle = '#000';
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(0, -size);
  g.lineTo(size * 0.45, size * 0.55);
  g.lineTo(0, size * 0.25);
  g.lineTo(-size * 0.45, size * 0.55);
  g.closePath();
  g.fill();
  g.stroke();
  g.restore();
  g.font = `bold ${Math.round(size * 0.7)}px Arial, sans-serif`;
  g.textAlign = 'center';
  g.lineWidth = 3;
  g.strokeStyle = '#000';
  const nx = x + Math.cos(ang) * size * 1.6;
  const ny = y + Math.sin(ang) * size * 1.6 + size * 0.25;
  g.strokeText('N', nx, ny);
  g.fillStyle = '#fff';
  g.fillText('N', nx, ny);
  g.textAlign = 'left';
  return ang;
}

/** Scale bar along x at the chip centre: 1, 2 or 5 × 10^k filling 15–25 % of the width. */
export function scaleBarFor(mpp, width) {
  const target = 0.2 * width * mpp;
  const p = 10 ** Math.floor(Math.log10(target));
  const nice = [1, 2, 5, 10].map((k) => k * p).filter((v) => v / mpp <= 0.25 * width).pop() ?? p;
  return { metres: nice, px: nice / mpp, label: nice >= 1000 ? `${nice / 1000} km` : `${nice} m` };
}

export function drawScaleBar(g, mpp, x, y, width, size = 8) {
  if (!Number.isFinite(mpp) || mpp <= 0) return null;
  const sb = scaleBarFor(mpp, width);
  const x0 = x - sb.px;
  for (let i = 0; i < 4; i++) {
    g.fillStyle = i % 2 ? '#ffffff' : '#e00000';
    g.fillRect(x0 + (i * sb.px) / 4, y, sb.px / 4, size);
  }
  g.strokeStyle = '#000';
  g.lineWidth = 1;
  g.strokeRect(x0, y, sb.px, size);
  g.font = `${Math.round(size * 1.5)}px Arial, sans-serif`;
  g.lineWidth = 3;
  g.strokeText(sb.label, x0, y - 4);
  g.fillStyle = '#fff';
  g.fillText(sb.label, x0, y - 4);
  return { ...sb, x0, y };
}

/**
 * Make a chip of `pane`. opts: width, height (output image px, default the pane's device size),
 * zoom (image px per output px; default the pane's at device resolution), view overrides,
 * number, graphics (true), raise (marking), caption template.
 */
export async function makeChip(app, pane, opts = {}) {
  const dpr = window.devicePixelRatio || 1;
  const { w: pw, h: ph } = pane.size();
  const W = Math.round(opts.width ?? pw * dpr);
  const H = Math.round(opts.height ?? ph * dpr);
  const view = { ...pane.view, zoom: opts.zoom ?? pane.view.zoom * dpr * (opts.width ? W / (pw * dpr) : 1), ...(opts.view ?? {}) };
  const cv = new ChipView(pane, view, W, H);
  const l = cv.geoLayer() ?? cv.layers()[0];
  if (!l) throw new Error('the panel has no image');
  const img = await renderImagery(app, cv);
  const marking = chipMarking(app, cv, opts.raise ?? null);
  const number = opts.number ?? app.store.all('chip').length + 1;
  const bar = Math.max(18, Math.round(Math.min(W, H) * 0.03));
  const capH = Math.round(bar * 1.15);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H + 2 * bar + capH;
  const g = canvas.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.putImageData(new ImageData(img.data, W, H), 0, bar);
  // Graphics and measurements, in the image area.
  g.save();
  g.translate(0, bar);
  g.beginPath();
  g.rect(0, 0, W, H);
  g.clip();
  if (opts.graphics !== false) app.graphics?.drawPane(cv, g);
  const mpp = cv.groundScale(l);
  const north = l.modelId ? drawNorthArrow(app, g, cv, l, 30, 40, Math.max(14, bar * 0.8)) : null;
  const sb = l.modelId ? drawScaleBar(g, mpp, W - 20, H - 26, W, Math.max(6, bar * 0.35)) : null;
  g.restore();
  // Banners and caption.
  drawBanner(g, marking, 0, 0, W, bar);
  drawBanner(g, marking, 0, H + bar + capH, W, bar);
  const values = tokenValues({ app, layer: l, view: cv, chipNo: number, marking: bannerText(marking) });
  const caption = resolveTokens(opts.caption ?? DEFAULT_CAPTION, values);
  g.fillStyle = '#111';
  g.fillRect(0, H + bar, W, capH);
  g.fillStyle = '#fff';
  g.font = `${Math.round(capH * 0.55)}px Arial, sans-serif`;
  g.textBaseline = 'middle';
  g.fillText(caption, 8, H + bar + capH / 2, W - 16);
  g.textBaseline = 'alphabetic';
  // Chip record: everything needed to reproduce or georeference the chip.
  const cornersImg = [
    [0, 0],
    [W, 0],
    [W, H],
    [0, H],
  ].map(([x, y]) => cv.imagePoint(x, y));
  const cornersGround = l.modelId ? cornersImg.map((p) => l.groundAt(p.x, p.y)) : null;
  const rec = {
    number,
    caption,
    image: values.IMAGE_ID,
    layer: l.id,
    file: l.rec?.file ?? null,
    size: [W, H],
    imageTop: bar,
    view,
    chain: chainRecord(l.chain),
    chainSummary: chainSummary(l.chain),
    cornersImage: cornersImg.map((p) => [p.x, p.y]),
    cornersGround: cornersGround?.every(Boolean) ? cornersGround.map((p) => [p.lon, p.lat, p.h]) : null,
    centreMgrs: values.MGRS_CENTER,
    metresPerPixel: Number.isFinite(mpp) ? mpp : null,
    scaleBar: sb ? { metres: sb.metres, px: sb.px } : null,
    northAngle: north,
    marking: { level: marking.level, text: bannerText(marking) },
    created: new Date().toISOString(),
  };
  return { canvas, record: rec, image: img, view: cv, imageTop: bar, marking };
}

/** Least-squares affine pixel → (lon, lat) from the chip's image-area corners (world file). */
export function worldFileFor(rec, offsetY = 0) {
  if (!rec.cornersGround) return null;
  const [W, H] = rec.size;
  const px = [
    [0, 0],
    [W, 0],
    [W, H],
    [0, H],
  ];
  // Solve lon = A·x + B·y + C and lat = D·x + E·y + F by normal equations.
  const solve = (vals) => {
    let [sxx, sxy, syy, sx, sy, n, sxv, syv, sv] = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    px.forEach(([x, y], i) => {
      sxx += x * x;
      sxy += x * y;
      syy += y * y;
      sx += x;
      sy += y;
      n++;
      sxv += x * vals[i];
      syv += y * vals[i];
      sv += vals[i];
    });
    const M = [
      [sxx, sxy, sx],
      [sxy, syy, sy],
      [sx, sy, n],
    ];
    const b = [sxv, syv, sv];
    const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det(M);
    const col = (k) => M.map((r, i) => r.map((v, j) => (j === k ? b[i] : v)));
    return [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D];
  };
  const [A, B, C0] = solve(rec.cornersGround.map((c) => c[0]));
  const [D, E, F0] = solve(rec.cornersGround.map((c) => c[1]));
  // World files reference pixel centres.
  // offsetY: rows above the image area in the saved picture (the top banner).
  const C = C0 + A * 0.5 + B * (0.5 - offsetY);
  const F = F0 + D * 0.5 + E * (0.5 - offsetY);
  const resid = Math.max(...px.map(([x, y], i) => Math.hypot((A * x + B * y + C0 - rec.cornersGround[i][0]) * 111320 * Math.cos((rec.cornersGround[i][1] * Math.PI) / 180), (D * x + E * y + F0 - rec.cornersGround[i][1]) * 110940)));
  return { text: [A, D, B, E, C, F].map((v) => v.toPrecision(15)).join('\n') + '\n', residualM: resid, affine: [A, B, C0, D, E, F0] };
}

export const WGS84_PRJ = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]]';

export { rank };
