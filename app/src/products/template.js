// Product templates (REQ-PRD-02/03/04, SCN-16, Research/04 §8.3–8.4): a JSON page (A4, Letter,
// A3 or a 16:9 slide, in mm) with a map frame bound to a pane at a fixed scale or fitted to its
// view, banners at top and bottom, a title, legend of visible layers, an inset locator, a
// metadata block and a source line, all with autolabel tokens. Pages render in strips (each
// under 16 MP) with the same image passes as the screen.

import { ChipView, renderImagery } from '../render/offscreen.js';
import { chipMarking, drawBanner, drawNorthArrow, drawScaleBar } from './chip.js';
import { tokenValues, resolveTokens } from './tokens.js';
import { bannerText, portionMark } from '../security/marking.js';

export const PAGES = { A4: [210, 297], Letter: [215.9, 279.4], A3: [297, 420], 'Slide 16:9': [142.875, 254] };
const MAX_CANVAS = 16e6;

export const BUILTIN_TEMPLATES = {
  sheet: {
    kind: 'gisworkbench-template',
    version: 1,
    name: 'Map sheet (A4 landscape)',
    page: { size: 'A4', orientation: 'landscape', dpi: 200, marginMm: 8 },
    layout: 'sheet',
    scale: null,
    raise: null,
    title: '{IMAGE_ID|Untitled image} · {ACQ_DAY|date unknown}',
    grid: 'mgrs',
    gridInterval: 0, // metres (UTM/MGRS) or degrees (lat/lon); 0 = automatic
    legend: true,
    inset: true,
    metadata: true,
    northArrow: true,
    scaleBar: true,
    metadataFields: [
      ['Image', '{IMAGE_ID}'],
      ['Acquired', '{ACQ_DATE|time unknown}'],
      ['Sensor', '{SENSOR|[n/a]}'],
      ['GSD', '{GSD|[n/a]}'],
      ['Sun', '{SUN|[n/a]}'],
      ['Obliquity', '{OBLIQUITY|[n/a]}'],
      ['Model', '{MODEL|none}'],
      ['Centre', '{MGRS_CENTER|no geolocation}'],
      ['Lat, lon', '{LATLON_CENTER|[n/a]}'],
      ['Scale', '{SCALE|fitted}'],
      ['Analyst', '{USER|[n/a]}'],
    ],
    source: 'Source: {SENSOR|sensor unknown} · {MODEL|no sensor model} · produced {NOW_UTC} with GIS Workbench',
  },
  slide: {
    kind: 'gisworkbench-template',
    version: 1,
    name: 'Briefing slide (16:9)',
    page: { size: 'Slide 16:9', orientation: 'landscape', dpi: 150, marginMm: 5 },
    layout: 'slide',
    scale: null,
    raise: null,
    title: '{IMAGE_ID|Untitled image}',
    grid: 'off',
    legend: false,
    inset: true,
    metadata: true,
    northArrow: true,
    scaleBar: true,
    metadataFields: [
      ['Acquired', '{ACQ_DATE|time unknown}'],
      ['Centre', '{MGRS_CENTER|no geolocation}'],
      ['GSD', '{GSD|[n/a]}'],
    ],
    source: '{SENSOR|sensor unknown} · {NOW_UTC}',
  },
  chip: {
    kind: 'gisworkbench-template',
    version: 1,
    name: 'Chip page (A4 portrait)',
    page: { size: 'A4', orientation: 'portrait', dpi: 200, marginMm: 10 },
    layout: 'chip',
    scale: null,
    raise: null,
    title: 'Chip of {IMAGE_ID|image}',
    grid: 'off',
    legend: true,
    inset: false,
    metadata: true,
    northArrow: true,
    scaleBar: true,
    metadataFields: [
      ['Image', '{IMAGE_ID}'],
      ['Acquired', '{ACQ_DATE|time unknown}'],
      ['Centre', '{MGRS_CENTER|no geolocation}'],
      ['GSD', '{GSD|[n/a]}'],
    ],
    source: 'Produced {NOW_UTC} · {USER|analyst not set}',
  },
};

/** Fill missing fields of a (possibly older or user-edited) template from the sheet default. */
export function normalizeTemplate(t) {
  const base = BUILTIN_TEMPLATES[t?.layout] ?? BUILTIN_TEMPLATES.sheet;
  const out = { ...structuredClone(base), ...(t ?? {}) };
  out.page = { ...base.page, ...(t?.page ?? {}) };
  if (!PAGES[out.page.size]) throw new Error(`unknown page size "${out.page.size}"`);
  if (!(out.page.dpi >= 72 && out.page.dpi <= 600)) throw new Error('DPI must be between 72 and 600');
  if (out.scale !== null && !(out.scale >= 100)) throw new Error('the scale must be 1:100 or smaller, or blank to fit the view');
  return out;
}

export function pageSizeMm(t) {
  const [a, b] = PAGES[t.page.size];
  return t.page.orientation === 'portrait' ? [Math.min(a, b), Math.max(a, b)] : [Math.max(a, b), Math.min(a, b)];
}

/** Layout boxes in mm: {banner, title, frame, side, legend, inset, meta, source}. */
export function layoutOf(t) {
  const [W, H] = pageSizeMm(t);
  const m = t.page.marginMm;
  const bh = t.layout === 'slide' ? 6 : 7;
  const titleH = t.layout === 'slide' ? 9 : 10;
  const srcH = 5;
  const top = bh + m * 0.5;
  const bottom = H - bh - m * 0.5;
  const body = { x: m, y: top + titleH, w: W - 2 * m, h: bottom - srcH - (top + titleH) - 1 };
  const sideW = t.legend || t.inset || t.metadata ? (t.layout === 'chip' ? 0 : t.layout === 'slide' ? 0.27 * body.w : 0.26 * body.w) : 0;
  const L = { page: [W, H], bannerH: bh, title: { x: m, y: top, w: W - 2 * m, h: titleH }, source: { x: m, y: bottom - srcH, w: W - 2 * m, h: srcH } };
  if (t.layout === 'chip') {
    const metaH = t.metadata || t.legend ? 0.22 * body.h : 0;
    L.frame = { x: body.x, y: body.y, w: body.w, h: body.h - metaH - (metaH ? 3 : 0) };
    L.meta = metaH ? { x: body.x, y: body.y + body.h - metaH, w: body.w * 0.6, h: metaH } : null;
    L.legend = t.legend && metaH ? { x: body.x + body.w * 0.62, y: body.y + body.h - metaH, w: body.w * 0.38, h: metaH } : null;
    L.inset = null;
    return L;
  }
  L.frame = { x: body.x, y: body.y, w: body.w - sideW - (sideW ? 3 : 0), h: body.h };
  const sx = L.frame.x + L.frame.w + 3;
  let y = body.y;
  const insetH = t.inset ? Math.min(sideW, body.h * 0.4) : 0;
  L.inset = t.inset ? { x: sx, y, w: sideW, h: insetH } : null;
  y += insetH + (insetH ? 3 : 0);
  const rest = body.y + body.h - y;
  L.legend = t.legend ? { x: sx, y, w: sideW, h: t.metadata ? rest * 0.32 : rest } : null;
  if (t.legend) y += L.legend.h + 3;
  L.meta = t.metadata ? { x: sx, y, w: sideW, h: body.y + body.h - y } : null;
  return L;
}

const wrapText = (g, text, maxW) => {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (g.measureText(t).width > maxW && cur) {
      lines.push(cur);
      cur = w;
    } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
};

/**
 * Render a template for a pane. Returns {strips: [{canvas, y0, h}], pagePx, pageMm, dpi, marking,
 * record}. Frames at a fixed scale use the page geometry (ground width = frame mm × n / 1000).
 */
export async function renderPage(app, tIn, pane, { dpi: dpiOverride } = {}) {
  const t = normalizeTemplate(tIn);
  const dpi = dpiOverride ?? t.page.dpi;
  const pxmm = dpi / 25.4;
  const L = layoutOf(t);
  const [Wmm, Hmm] = L.page;
  const PW = Math.round(Wmm * pxmm);
  const PH = Math.round(Hmm * pxmm);
  const P = (r) => ({ x: Math.round(r.x * pxmm), y: Math.round(r.y * pxmm), w: Math.round(r.w * pxmm), h: Math.round(r.h * pxmm) });
  const F = P(L.frame);
  if (F.w * F.h > MAX_CANVAS) throw new Error(`the map frame needs ${((F.w * F.h) / 1e6).toFixed(1)} MP at ${dpi} dpi; lower the DPI (at most 16 MP per frame)`);
  const l = pane.geoLayer() ?? pane.activeLayer?.() ?? pane.layers()[0];
  if (!l) throw new Error('the panel has no image');
  // The frame view: the pane's centre and rotation; zoom from the scale or fitted to the pane.
  const { w: pw } = pane.size();
  let zoom = pane.view.zoom * (F.w / pw);
  let mppImage = NaN;
  if (l.modelId) {
    const probe = new ChipView(pane, { ...pane.view, zoom: 1 }, 200, 200);
    mppImage = probe.groundScale(l);
  }
  if (t.scale) {
    if (!Number.isFinite(mppImage)) throw new Error('a fixed scale needs a geolocated image');
    const groundW = (L.frame.w * t.scale) / 1000;
    zoom = (F.w * mppImage) / groundW;
  }
  const cv = new ChipView(pane, { ...pane.view, zoom }, F.w, F.h);
  const img = await renderImagery(app, cv);
  const marking = chipMarking(app, cv, t.raise ? { level: t.raise, source: 'raised by the template' } : null);
  const mpp = cv.groundScale(l);
  const scaleDen = Number.isFinite(mpp) ? (mpp * pxmm * 1000) : null; // m per mm of paper × 1000
  const values = tokenValues({ app, layer: l, view: cv, scale: scaleDen, marking: bannerText(marking) });
  // The frame: imagery, grid, graphics, north arrow and scale bar.
  const frame = document.createElement('canvas');
  frame.width = F.w;
  frame.height = F.h;
  const fg = frame.getContext('2d');
  fg.putImageData(new ImageData(img.data, F.w, F.h), 0, 0);
  const k = dpi / 96; // marginalia sizes scale with the print resolution
  if (t.grid && t.grid !== 'off' && l.modelId) {
    fg.save();
    fg.scale(1, 1);
    app.drawGrid?.(cv, fg, F.w, F.h, l, { type: t.grid, colour: '#00e5ff', labels: true, interval: Number(t.gridInterval) || 0 });
    fg.restore();
  }
  app.graphics?.drawPane(cv, fg);
  if (t.northArrow && l.modelId) drawNorthArrow(app, fg, cv, l, 34 * k, 44 * k, 16 * k);
  const sb = t.scaleBar && l.modelId ? drawScaleBar(fg, mpp, F.w - 16 * k, F.h - 22 * k, F.w, 7 * k) : null;
  const legendItems = cv.visibleLayers().map((x) => ({ name: x.rec.name, mark: portionMark(x.info.marking) }));
  const drawPage = (g) => {
    g.fillStyle = '#fff';
    g.fillRect(0, 0, PW, PH);
    const bh = Math.round(L.bannerH * pxmm);
    drawBanner(g, marking, 0, 0, PW, bh);
    drawBanner(g, marking, 0, PH - bh, PW, bh);
    const T = P(L.title);
    g.fillStyle = '#111';
    g.font = `bold ${Math.round(T.h * 0.62)}px Arial, sans-serif`;
    g.textBaseline = 'middle';
    g.fillText(resolveTokens(t.title, values), T.x, T.y + T.h / 2, T.w);
    g.drawImage(frame, F.x, F.y);
    g.strokeStyle = '#000';
    g.lineWidth = Math.max(1, k);
    g.strokeRect(F.x, F.y, F.w, F.h);
    const fs = Math.round(2.6 * pxmm);
    const box = (r, title) => {
      const B = P(r);
      g.strokeStyle = '#444';
      g.lineWidth = Math.max(1, k * 0.8);
      g.strokeRect(B.x, B.y, B.w, B.h);
      g.fillStyle = '#111';
      g.font = `bold ${fs}px Arial, sans-serif`;
      g.textBaseline = 'top';
      g.fillText(title, B.x + fs * 0.4, B.y + fs * 0.35, B.w - fs);
      return B;
    };
    if (L.legend) {
      const B = box(L.legend, 'Legend');
      g.font = `${fs}px Arial, sans-serif`;
      let y = B.y + fs * 1.8;
      for (const it of legendItems) {
        if (y > B.y + B.h - fs) break;
        g.fillStyle = '#00a0c0';
        g.fillRect(B.x + fs * 0.4, y + fs * 0.15, fs * 0.8, fs * 0.8);
        g.fillStyle = '#111';
        g.fillText(`${it.mark} ${it.name}`, B.x + fs * 1.6, y, B.w - fs * 2);
        y += fs * 1.35;
      }
    }
    if (L.inset) {
      const B = box(L.inset, 'Locator');
      const S = Math.min(B.w, B.h - fs * 1.6) - fs * 0.6;
      g.save();
      app.drawAutomap?.(cv, g, { x: B.x + (B.w - S) / 2, y: B.y + fs * 1.6 }, { size: S / Math.min(F.w, F.h), style: { fill: '#203040', stroke: '#000' } });
      g.restore();
    }
    if (L.meta) {
      const B = box(L.meta, 'Image and product');
      g.font = `${fs}px Arial, sans-serif`;
      let y = B.y + fs * 1.8;
      for (const [label, tok] of t.metadataFields ?? []) {
        if (y > B.y + B.h - fs) break;
        const lines = wrapText(g, `${label}: ${resolveTokens(tok, values)}`, B.w - fs);
        for (const ln of lines) {
          g.fillStyle = '#111';
          g.fillText(ln, B.x + fs * 0.4, y);
          y += fs * 1.25;
        }
      }
    }
    const S = P(L.source);
    g.fillStyle = '#333';
    g.font = `${Math.round(S.h * 0.55)}px Arial, sans-serif`;
    g.textBaseline = 'middle';
    g.fillText(resolveTokens(t.source, values), S.x, S.y + S.h / 2, S.w);
    g.textBaseline = 'alphabetic';
  };
  const stripH = Math.max(256, Math.min(4096, Math.floor(MAX_CANVAS / PW)));
  const strips = [];
  for (let y0 = 0; y0 < PH; y0 += stripH) {
    const h = Math.min(stripH, PH - y0);
    const c = document.createElement('canvas');
    c.width = PW;
    c.height = h;
    const g = c.getContext('2d');
    g.translate(0, -y0);
    drawPage(g);
    strips.push({ canvas: c, y0, h });
  }
  const record = {
    template: t.name,
    page: { size: t.page.size, orientation: t.page.orientation, mm: [Wmm, Hmm], px: [PW, PH], dpi },
    frame: { mm: L.frame, px: F, view: cv.view, metresPerPixel: Number.isFinite(mpp) ? mpp : null, scale: scaleDen ? Math.round(scaleDen) : null, requestedScale: t.scale, corners: frameCorners(cv, l, F) },
    scaleBar: sb ? { metres: sb.metres, px: sb.px } : null,
    marking: { level: marking.level, text: bannerText(marking) },
    legend: legendItems,
    image: values.IMAGE_ID,
    created: new Date().toISOString(),
  };
  return { strips, pagePx: [PW, PH], pageMm: [Wmm, Hmm], dpi, marking, record, view: cv, template: t };
}

/** Ground corners of the map frame (UL, UR, LR, LL as [lat, lon]) for GeoPDF, or null. */
function frameCorners(cv, l, F) {
  if (!l?.modelId) return null;
  const out = [[0, 0], [F.w, 0], [F.w, F.h], [0, F.h]].map(([x, y]) => {
    const q = cv.imagePoint(x, y);
    const g = l.groundAt?.(q.x, q.y);
    return g ? [g.lat, g.lon] : null;
  });
  return out.every(Boolean) ? out : null;
}

/** One canvas of the whole page (PNG export, preview); throws above the canvas limit. */
export function stitch(page) {
  const [W, H] = page.pagePx;
  if (W * H > MAX_CANVAS * 1.05) throw new Error(`the page is ${((W * H) / 1e6).toFixed(1)} MP; save it as PDF, or lower the DPI for PNG`);
  if (page.strips.length === 1) return page.strips[0].canvas;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  for (const s of page.strips) g.drawImage(s.canvas, 0, s.y0);
  return c;
}
