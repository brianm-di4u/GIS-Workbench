// SAR exploitation (R3, `Research/09`): SICD complex views and remaps (REQ-SAR-03), the metadata
// tree and summary card (REQ-SAR-02), anamorphic correction, the slant/ground display, shadows-
// down and north-up, the SAR overlay legend (REQ-SAR-04), calibrated β⁰/σ⁰/γ⁰/RCS views
// (REQ-SAR-06), speckle filters with GPU preview and worker export (REQ-SAR-07), amplitude change
// (REQ-SAR-08), CCD (REQ-SAR-09/14), the pair finder (REQ-SAR-10), sub-apertures and CSI
// (REQ-SAR-11), SIDD (REQ-SAR-12) and polarimetric composites (REQ-SAR-13).
//
// Projections are the Rust SICD Volume 3 port in the core (REQ-SAR-05); derived products are
// written as NITF with the SICD XML (chip offsets updated), so they keep the rigorous geometry.

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { openImageFile } from '../formats/open.js';
import { writeNitf, xmlDesUser } from '../formats/nitf-writer.js';
import { SAR_REMAPS, sarRemap, sarStats } from '../render/chain.js';
import { fromParts } from '../vector/geom.js';
import { contourLines } from './dem-tools.js';

export const name = 'sar';

export const SAR_VIEWS = [
  ['magnitude', 'Magnitude', 0],
  ['phase', 'Phase', 1],
  ['i', 'I (real)', 2],
  ['q', 'Q (imaginary)', 3],
  ['power', 'Power (dB)', 4],
  ['beta0', 'β⁰ (dB)', 5],
  ['sigma0', 'σ⁰ (dB)', 6],
  ['gamma0', 'γ⁰ (dB)', 7],
  ['rcs', 'RCS (dB m²)', 8],
];
export const SPECKLE = [
  ['none', 'None'],
  ['mean', 'Mean (boxcar)'],
  ['median', 'Median 3×3'],
  ['lee', 'Lee'],
  ['kuan', 'Kuan'],
  ['gammamap', 'Gamma-MAP'],
  ['frost', 'Frost'],
  ['refinedlee', 'Refined Lee (7×7)'],
];

/** Serialise a {n, a, t, c} tree as XML (namespace on the root). */
export function treeToXml(node, ns) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const out = [];
  const walk = (n, root) => {
    const attrs = Object.entries(n.a ?? {}).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
    out.push(`<${n.n}${root && ns ? ` xmlns="${esc(ns)}"` : ''}${attrs}>`);
    if (n.t !== undefined) out.push(esc(n.t));
    for (const c of n.c ?? []) walk(c, false);
    out.push(`</${n.n}>`);
  };
  walk(node, true);
  return '<?xml version="1.0" encoding="UTF-8"?>' + out.join('');
}

/** A copy of a SICD tree for a chip (x0, y0, w, h) of the file's pixels. */
export function chipTree(tree, { x0, y0, w, h }) {
  const t = structuredClone(tree);
  const find = (n, path) => path.split('/').reduce((a, k) => a?.c?.find((c) => c.n === k), n);
  const set = (path, v) => {
    const e = find(t, path);
    if (e) e.t = String(v);
  };
  set('ImageData/FirstRow', Number(find(t, 'ImageData/FirstRow')?.t ?? 0) + y0);
  set('ImageData/FirstCol', Number(find(t, 'ImageData/FirstCol')?.t ?? 0) + x0);
  set('ImageData/NumRows', h);
  set('ImageData/NumCols', w);
  // ValidData of the chip: its own rectangle (full-image row/col).
  const vd = find(t, 'ImageData/ValidData');
  if (vd) {
    const fr = Number(find(t, 'ImageData/FirstRow').t);
    const fc = Number(find(t, 'ImageData/FirstCol').t);
    const v = (i, r, c) => ({ n: 'Vertex', a: { index: String(i) }, c: [{ n: 'Row', t: String(r) }, { n: 'Col', t: String(c) }] });
    vd.a = { size: '4' };
    vd.c = [v(1, fr, fc), v(2, fr, fc + w - 1), v(3, fr + h - 1, fc + w - 1), v(4, fr + h - 1, fc)];
  }
  return t;
}

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const pane = () => app.activePane();
  const layer = () => app.activeLayer();
  const core = app.core;
  const toast = (m, o) => app.toast(m, o);
  const sarOf = (l) => l?.info?.sar ?? null;
  const isSicd = (l) => sarOf(l)?.kind === 'SICD' && !!sarOf(l)?.complex;
  const isSar = (l) => !!sarOf(l);
  // Complex samples without SICD geometry (a complex SLC GeoTIFF, IMP-16) still have every view.
  const isComplex = (l) => isSicd(l) || (sarOf(l)?.kind === 'Complex GeoTIFF' && !!sarOf(l)?.complex);
  const sicdLayers = () => [...app.layers.values()].filter(isSicd);

  // ---- views and remaps (REQ-SAR-03/06) ----

  function viewAvailable(l, v) {
    const m = sarOf(l);
    if (!isComplex(l)) return { ok: false, reason: 'not a complex SAR image' };
    if (['beta0', 'sigma0', 'gamma0', 'rcs'].includes(v)) {
      const r = m.radiometry;
      if (!r || r.reason) return { ok: false, reason: `${v} needs the SICD Radiometric block: ${r?.reason ?? 'absent'}` };
      if (!r[v]) return { ok: false, reason: `${v} cannot be derived from the Radiometric block` };
    }
    return { ok: true, reason: null };
  }
  const viewOf = (l) => SAR_VIEWS.find((v) => v[2] === l?.chain?.bands?.[0])?.[0] ?? 'magnitude';

  function setView(l, v) {
    const a = viewAvailable(l, v);
    if (!a.ok) throw new Error(a.reason);
    const [, label, band] = SAR_VIEWS.find((x) => x[0] === v);
    app.setChain(
      (c) => {
        c.bands = [band];
        c.stretch = v === 'magnitude' ? c.sarRemap ?? 'sar-density' : v === 'phase' ? 'phase' : v === 'i' || v === 'q' ? 'symmetric' : 'linear1';
        c.colour.palette = v === 'phase' ? 'cyclic' : 'grey';
        c.enabled.stretch = true;
      },
      `SAR view: ${label}`,
      { layerId: l.id },
    );
    return l.ensureStats().then(() => {
      l.updateLut(true);
      app.renderer.invalidate();
      app.emit('state');
    });
  }

  /** Change the remap; only the LUT is rebuilt (no file read, AC-12.2). Returns ms. */
  function setRemap(l, kind) {
    if (!SAR_REMAPS.some(([k]) => k === kind)) throw new Error(`unknown remap ${kind}`);
    const t0 = performance.now();
    app.setChain(
      (c) => {
        c.sarRemap = kind;
        if (viewOf(l) === 'magnitude') c.stretch = kind;
      },
      `SAR remap: ${SAR_REMAPS.find(([k]) => k === kind)[1]}`,
      { layerId: l.id },
    );
    l.updateLut(true);
    app.renderer.invalidate();
    return performance.now() - t0;
  }

  // ---- geometry: anamorphic, ground plane, orientation, overlay (REQ-SAR-04) ----

  /** The ground azimuth (° from north) as a screen angle (rad, x right, y down) in a pane. */
  function screenAngle(p, l, az) {
    const g = l.groundAt(p.view.cx, p.view.cy);
    if (!g) return null;
    const t = core.direct(g.lat, g.lon, az, 40);
    const qa = l.imageAt(g.lat, g.lon, g.h);
    const qb = l.imageAt(t.lat, t.lon, g.h);
    if (!qa || !qb) return null;
    const a = p.screenPoint(qa.x, qa.y);
    const b = p.screenPoint(qb.x, qb.y);
    return Math.atan2(b.y - a.y, b.x - a.x);
  }

  /** The 2 × 2 image → local ground (E, −N) metres Jacobian at the image centre, and its residual. */
  function groundPlaneLinear(l) {
    const m = sarOf(l);
    const hh = m?.scpHae ?? l.defaultHeight?.() ?? 0;
    const cx = l.width / 2;
    const cy = l.height / 2;
    const g0 = l.groundAt(cx, cy, hh);
    const enu = (g) => {
      const d = core.inverse(g0.lat, g0.lon, g.lat, g.lon);
      const a = (d.azi1 * Math.PI) / 180;
      return [d.distance * Math.sin(a), d.distance * Math.cos(a)];
    };
    const d = 20;
    const ex = enu(l.groundAt(cx + d, cy, hh));
    const ey = enu(l.groundAt(cx, cy + d, hh));
    const J = [ex[0] / d, ey[0] / d, -ex[1] / d, -ey[1] / d]; // (E, −N) per pixel
    // Residual of the affine at the image corners (metres).
    let res = 0;
    for (const [x, y] of [[0, 0], [l.width, 0], [l.width, l.height], [0, l.height]]) {
      const [e, n] = enu(l.groundAt(x, y, hh));
      const pe = J[0] * (x - cx) + J[1] * (y - cy);
      const pn = -(J[2] * (x - cx) + J[3] * (y - cy));
      res = Math.max(res, Math.hypot(e - pe, n - pn));
    }
    const s = Math.min(Math.hypot(J[0], J[2]), Math.hypot(J[1], J[3]));
    return { lin: J.map((v) => v / s), residual: res, gsd: s };
  }

  function displayMode(p, mode) {
    const l = p.geoLayer();
    if (!isSar(l)) throw new Error('the active image is not SAR');
    const m = sarOf(l);
    p.sar ??= { mode: 'native', overlay: false };
    let lin = null;
    let note = '';
    if (mode === 'anamorphic') {
      const k = Math.min(m.rowSS, m.colSS);
      if (!(k > 0)) throw new Error('the SICD has no Grid Row/Col sample spacing');
      lin = [m.colSS / k, 0, 0, m.rowSS / k];
      note = `Anamorphic ×${(Math.max(m.rowSS, m.colSS) / k).toFixed(3)} (${m.imagePlane ?? 'SLANT'} plane)`;
    } else if (mode === 'ground') {
      const gp = groundPlaneLinear(l);
      lin = gp.lin;
      note = `Ground plane (affine display; corner residual ${gp.residual.toFixed(2)} m)`;
      p.sar.groundResidual = gp.residual;
    }
    p.sar.mode = mode;
    p.sar.note = note;
    const g = l.groundAt(p.view.cx, p.view.cy);
    p.setView({ lin, ...(mode === 'ground' ? { rot: 0, mode: 'native' } : {}) });
    p.fitWhole();
    if (g) {
      try {
        p.centreOnGround(g.lat, g.lon, g.h);
      } catch {}
    }
    p.mp?.status?.set?.({ sar: note });
    return { lin, note };
  }

  /** Overlay state: screen angles (rad) of north, layover, look and shadow, and the values. */
  function overlayState(p) {
    const l = p.geoLayer();
    const m = sarOf(l);
    if (!m || !l.modelId) return null;
    const az = m.azimuth;
    const lay = m.layover;
    const look = Number.isFinite(az) ? (az + 180) % 360 : NaN; // the radar looks from the sensor to the scene
    return {
      north: screenAngle(p, l, 0),
      layover: Number.isFinite(lay) ? screenAngle(p, l, lay) : null,
      look: Number.isFinite(look) ? screenAngle(p, l, look) : null,
      shadow: Number.isFinite(look) ? screenAngle(p, l, look) : null,
      values: { graze: m.graze, slope: m.slope, twist: m.twist, squint: Number.isFinite(m.dopplerCone) ? m.dopplerCone - 90 : NaN, side: m.sideOfTrack, layover: lay, azimuth: az },
    };
  }

  function drawOverlay(p, g, w) {
    const s = overlayState(p);
    if (!s) return;
    const cx = w - 92;
    const cy = 96;
    g.save();
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.fillRect(cx - 78, cy - 78, 156, 214);
    const arrow = (ang, colour, label, len = 58) => {
      if (ang === null || ang === undefined) return;
      const x = cx + Math.cos(ang) * len;
      const y = cy + Math.sin(ang) * len;
      g.strokeStyle = colour;
      g.fillStyle = colour;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(x, y);
      g.stroke();
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x - 8 * Math.cos(ang - 0.4), y - 8 * Math.sin(ang - 0.4));
      g.lineTo(x - 8 * Math.cos(ang + 0.4), y - 8 * Math.sin(ang + 0.4));
      g.closePath();
      g.fill();
      g.font = '11px Arial, sans-serif';
      g.fillText(label, x + 6 * Math.cos(ang) - 6, y + 6 * Math.sin(ang) + 4);
    };
    arrow(s.north, '#ffffff', 'N', 62);
    arrow(s.layover, '#ffcb5f', 'Layover', 52);
    arrow(s.look, '#5fd0ff', 'Look', 44);
    arrow(s.shadow, '#a0a0a0', 'Shadow', 30);
    const v = s.values;
    const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '–');
    g.fillStyle = '#ffffff';
    g.font = '11px Arial, sans-serif';
    [`Graze ${f(v.graze)}°  Slope ${f(v.slope)}°`, `Twist ${f(v.twist)}°  Squint ${f(v.squint)}°`, `Looking ${v.side === 'L' ? 'left' : v.side === 'R' ? 'right' : '–'}`, `Layover ${f(v.layover)}° from N`].forEach((t, i) => g.fillText(t, cx - 72, cy + 76 + 14 * i));
    g.restore();
  }
  const prevDeco = app.paneDecorations;
  app.paneDecorations = (p, g, w, hh, l) => {
    prevDeco?.(p, g, w, hh, l);
    if (p.sar?.overlay && isSar(l)) drawOverlay(p, g, w);
  };

  // ---- metadata (REQ-SAR-02) ----

  function summaryRows(l) {
    const m = sarOf(l);
    const f = (x, d = 3) => (Number.isFinite(x) ? Number(x).toFixed(d) : '–');
    if (m.kind === 'SIDD') {
      return [
        ['Format', `SIDD ${m.version}`],
        ['Product', m.productName ?? '–'],
        ['Pixel type', m.pixelType ?? '–'],
        ['Collector', m.collector ?? '–'],
        ['Collect time', m.collectStart ?? '–'],
        ['Mode', m.modeType ?? '–'],
        ['Measurement', m.measurement ?? '–'],
        ['Graze / slope / twist (°)', `${f(m.graze, 2)} / ${f(m.slope, 2)} / ${f(m.twist, 2)}`],
        ['Azimuth (°)', f(m.azimuth, 2)],
        ['Shadow direction', m.shadowDirection ?? '–'],
      ];
    }
    const rad = m.radiometry;
    return [
      ['Format', `SICD ${m.version} (${m.namespace})`],
      ['Collector', `${m.collector ?? '–'}${m.coreName ? ` · ${m.coreName}` : ''}`],
      ['Mode', `${m.modeType ?? '–'}${m.modeId ? ` (${m.modeId})` : ''}`],
      ['Collect time', `${m.collectStart ?? '–'}${Number.isFinite(m.collectDuration) ? ` · ${f(m.collectDuration, 2)} s` : ''}`],
      ['Grid / image formation', `${m.gridType ?? '–'} / ${m.ifa ?? '–'} (${m.imagePlane ?? '–'} plane)`],
      ['Pixel type', m.pixelType ?? '–'],
      ['Size', `${m.numRows} × ${m.numCols} (first row ${m.firstRow}, column ${m.firstCol} of ${m.fullRows} × ${m.fullCols})`],
      ['Pixel spacing row / col (m)', `${f(m.rowSS)} / ${f(m.colSS)}`],
      ['Resolution row / col (m)', `${f(m.rowRes)} / ${f(m.colRes)}`],
      ['Graze / slope / twist (°)', `${f(m.graze, 2)} / ${f(m.slope, 2)} / ${f(m.twist, 2)}`],
      ['Incidence / Doppler cone (°)', `${f(m.incidence, 2)} / ${f(m.dopplerCone, 2)}`],
      ['Layover / azimuth (°)', `${f(m.layover, 2)} / ${f(m.azimuth, 2)}`],
      ['Look side', m.sideOfTrack === 'L' ? 'Left' : m.sideOfTrack === 'R' ? 'Right' : '–'],
      ['Polarisation', m.polarization ?? '–'],
      ['Radiometric', rad?.reason ? `none — ${rad.reason}` : Object.entries(rad?.derived ?? {}).map(([k, v]) => `${k} (${v})`).join(', ')],
      ['Error (CompositeSCP)', Number.isFinite(m.errRg) ? `Rg ${f(m.errRg, 2)} m, Az ${f(m.errAz, 2)} m${m.apo ? ' · APOs applied' : ''}` : 'not stated'],
      ['Projection', l.modelName ?? '–'],
      ['Image corners vs projection', cornerCheck(l)],
    ];
  }

  /** ImageCorners against the Volume 3 projection of the corner pixels (information only). */
  function cornerCheck(l) {
    const m = sarOf(l);
    if (!m.imageCorners?.length || !l.modelId) return '–';
    const px = [[0.5, 0.5], [l.width - 0.5, 0.5], [l.width - 0.5, l.height - 0.5], [0.5, l.height - 0.5]];
    const d = px.map(([x, y], i) => {
      const g = l.groundAt(x, y, m.scpHae ?? 0);
      const [la, lo] = m.imageCorners[i] ?? [];
      return g && Number.isFinite(la) ? core.inverse(g.lat, g.lon, la, lo).distance : NaN;
    });
    return `${d.map((v) => (Number.isFinite(v) ? v.toFixed(2) : '–')).join(' / ')} m (for information: producers fill ImageCorners differently)`;
  }

  function treeView(node) {
    const kids = node.c ?? [];
    const label = `${node.n}${node.a ? ` ${Object.entries(node.a).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}`;
    if (!kids.length) return h('div', { class: 'sar-leaf' }, h('span', { class: 'sar-k' }, label), node.t !== undefined ? h('span', { class: 'sar-v' }, ` ${node.t}`) : '');
    return h('details', {}, h('summary', {}, label), ...kids.map(treeView));
  }

  async function metadataDialog(l = layer()) {
    if (!isSar(l)) throw new Error('the active image has no SICD or SIDD metadata');
    const m = sarOf(l);
    const card = h('table', { class: 'tbl', 'data-id': 'sar-summary' }, h('tbody', {}, ...summaryRows(l).map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v)))));
    const chainList = m.kind === 'SIDD' && m.display?.length ? h('div', {}, h('h4', {}, 'Display chain (producer, read-only)'), h('ol', {}, ...m.display.map((d) => h('li', {}, `${d.stage === 'InteractiveProcessing' ? 'Interactive' : 'Non-interactive'}: ${d.step}${d.detail ? ` (${d.detail})` : ''}`)))) : '';
    const tree = m.tree ? h('div', { class: 'sar-tree', style: 'max-height:280px;overflow:auto;font:12px monospace' }, treeView(m.tree)) : '';
    await modal({ title: `${m.kind} Metadata — ${l.rec?.name ?? ''}`, body: h('div', {}, card, chainList, h('h4', {}, 'XML'), tree), buttons: ['Close'], width: 640, id: 'sar-metadata', modeless: true });
  }

  // ---- products: a raster on a chip of a SICD, written with the chip's SICD XML ----

  /**
   * planes: typed arrays (w·h each), type 'f32'|'u8'. Opens the product in the pane above the
   * source. palette/stretch set the first display.
   */
  async function product(src, { x0, y0, w, h: hh }, planes, { name: nm, type = 'f32', irep, palette, stretch, pane: p = pane(), select = true } = {}) {
    const m = sarOf(src);
    const tree = m.tree ? chipTree(m.tree, { x0: Math.round(x0), y0: Math.round(y0), w, h: hh }) : null;
    const xml = tree ? treeToXml(tree, m.namespace) : null;
    const corners = [[0.5, 0.5], [w - 0.5, 0.5], [w - 0.5, hh - 0.5], [0.5, hh - 0.5]].map(([x, y]) => {
      const g = src.groundAt(x + x0, y + y0, m.scpHae ?? 0);
      return g ? [g.lat, g.lon] : null;
    });
    const bytes = writeNitf(
      { width: w, height: hh, bands: planes.length, type, planes },
      {
        title: nm,
        iid1: 'SARPROD',
        iid2: nm,
        icat: 'SAR',
        irep: irep ?? (planes.length === 3 ? 'RGB' : planes.length === 1 ? 'MONO' : 'MULTI'),
        marking: src.info.marking ?? undefined,
        corners: corners.every(Boolean) ? corners : null,
        des: xml ? [{ desid: 'XML_DATA_CONTENT', ver: 1, user: xmlDesUser({ version: m.version, ns: m.namespace, corners: corners.every(Boolean) ? corners : null }), data: xml }] : [],
      },
    );
    const { layers } = await openImageFile(app, new File([bytes], `${nm}.ntf`, { type: 'application/octet-stream' }), { pane: p });
    const L = layers[0];
    if (palette || stretch)
      app.setChain(
        (c) => {
          if (palette) c.colour.palette = palette;
          if (stretch) c.stretch = stretch;
        },
        `${nm} display`,
        { layerId: L.id },
      );
    if (!select) S.transact('Keep source active', (tx) => tx.set(p.id, 'activeLayer', src.id), { kind: 'load' });
    return L;
  }

  /** The AOI chip of a layer: the panel AOI box, else the view, clamped to the image. */
  function chipOf(p, l, max = 2048) {
    const box = app.aoiBox?.(p, l);
    let x0;
    let y0;
    let x1;
    let y1;
    if (box) ({ x0, y0, x1, y1 } = box);
    else {
      const { w, h: hh } = p.size();
      const c = [p.imagePoint(0, 0), p.imagePoint(w, 0), p.imagePoint(w, hh), p.imagePoint(0, hh)];
      x0 = Math.min(...c.map((q) => q.x));
      x1 = Math.max(...c.map((q) => q.x));
      y0 = Math.min(...c.map((q) => q.y));
      y1 = Math.max(...c.map((q) => q.y));
    }
    x0 = Math.max(0, Math.floor(x0));
    y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(l.width, Math.ceil(x1));
    y1 = Math.min(l.height, Math.ceil(y1));
    let w = x1 - x0;
    let hh = y1 - y0;
    if (w > max) {
      x0 += Math.floor((w - max) / 2);
      w = max;
    }
    if (hh > max) {
      y0 += Math.floor((hh - max) / 2);
      hh = max;
    }
    if (w < 16 || hh < 16) throw new Error('the AOI chip is smaller than 16 × 16 pixels');
    return { x0, y0, w, h: hh };
  }

  const complexChip = (l, c) => app.pool.run('complex', { handle: l.handle, ...c }, { affinity: l.affinity, label: `complex chip ${l.rec?.name}`, timeout: 120000 });

  /** Intensity chip (|z|²) of a SICD layer. */
  async function intensityChip(l, c) {
    const r = await complexChip(l, c);
    const n = r.w * r.h;
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = r.z[2 * i] * r.z[2 * i] + r.z[2 * i + 1] * r.z[2 * i + 1];
    return { ...r, v };
  }

  // ---- speckle (REQ-SAR-07) ----

  function setSpeckle(l, op, { win = 7, looks = 1, damping = 2 } = {}) {
    app.setChain((c) => (c.sarFilter = op === 'none' ? null : { op, win, looks, damping }), `Speckle filter: ${op}`, { layerId: l.id });
    app.renderer.invalidate();
  }

  /** Full-resolution filtered amplitude of a chip, in a worker (export). */
  async function exportSpeckle(l, op, opts = {}, c = chipOf(pane(), l)) {
    if (!isSicd(l)) throw new Error('speckle export needs a complex SICD (the filter runs on intensity from the complex data)');
    const ic = await intensityChip(l, c);
    const r = await app.pool.run('sar.speckle', { kind: op, v: ic.v, w: ic.w, h: ic.h, opts }, { kind: 'analysis', transfer: [ic.v.buffer], label: `speckle ${op}` });
    const amp = new Float32Array(r.v.length);
    for (let i = 0; i < amp.length; i++) amp[i] = Math.sqrt(Math.max(0, r.v[i]));
    return product(l, { x0: ic.x0, y0: ic.y0, w: ic.w, h: ic.h }, [amp], { name: `${l.info.iid} ${op} filtered`, stretch: 'sar-density' });
  }

  // ---- amplitude change and CCD (REQ-SAR-08/09/14) ----

  /** Compatibility of two collects for CCD (refuse different look sides; warn otherwise). */
  function compatibility(a, b) {
    const ma = sarOf(a);
    const mb = sarOf(b);
    const warn = [];
    if (ma.sideOfTrack !== mb.sideOfTrack) return { ok: false, warnings: ['the collects look from opposite sides: not CCD-compatible'] };
    if (ma.polarization !== mb.polarization) warn.push(`polarisation ${ma.polarization} vs ${mb.polarization}`);
    if ((ma.collector ?? '').split(/[-_ ]/)[0] !== (mb.collector ?? '').split(/[-_ ]/)[0]) warn.push('different collectors');
    if (Math.abs((ma.incidence ?? 0) - (mb.incidence ?? 0)) > 2) warn.push(`incidence differs by ${Math.abs(ma.incidence - mb.incidence).toFixed(2)}°`);
    const da = Math.abs((((ma.azimuth ?? 0) - (mb.azimuth ?? 0) + 540) % 360) - 180);
    if (da > 5) warn.push(`azimuth differs by ${da.toFixed(2)}°`);
    const linked = (ma.match ?? []).some((x) => x.coreName === mb.coreName) || (mb.match ?? []).some((x) => x.coreName === ma.coreName);
    return { ok: true, warnings: warn, matchInfo: linked };
  }

  /** The chip in layer b that covers chip c of layer a, through the projections (coarse). */
  function partnerChip(a, b, c) {
    const hh = sarOf(a).scpHae ?? 0;
    const g = a.groundAt(c.x0 + c.w / 2, c.y0 + c.h / 2, hh);
    const q = b.imageAt(g.lat, g.lon, hh);
    if (!q) throw new Error('the second image does not cover the AOI');
    // Clamped inside image b: the registration absorbs the few pixels this moves the chip.
    const x0 = Math.round(q.x - c.w / 2);
    const y0 = Math.round(q.y - c.h / 2);
    const cx = Math.min(Math.max(0, x0), Math.max(0, b.width - c.w));
    const cy = Math.min(Math.max(0, y0), Math.max(0, b.height - c.h));
    if (Math.abs(cx - x0) > c.w / 4 || Math.abs(cy - y0) > c.h / 4) throw new Error('the second image does not cover the AOI chip');
    return { x0: cx, y0: cy, w: c.w, h: c.h };
  }

  function noisePower(l) {
    const r = sarOf(l)?.radiometry;
    const np = r?.noise;
    if (!np?.c?.length) return 0;
    return 10 ** (np.c[0] / 10); // constant term, pixel power units (ABSOLUTE)
  }

  /**
   * CCD of two SICD layers over an AOI chip. opts: win (5), register, flatEarth, cnrDb (3; NaN
   * off; the amplitude threshold is used when there is no NoisePoly), compensate, goldstein (0),
   * products ['coherence', 'mtc', 'masked', 'interferogram'].
   */
  async function ccd(a, b, opts = {}) {
    if (!isSicd(a) || !isSicd(b)) throw new Error('CCD needs two complex SICD images');
    const comp = compatibility(a, b);
    if (!comp.ok) throw new Error(comp.warnings[0]);
    const p = opts.pane ?? pane();
    const c = opts.chip ?? chipOf(p, a, opts.max ?? 2048);
    const cb = partnerChip(a, b, c);
    const [fa, fb] = await Promise.all([complexChip(a, c), complexChip(b, cb)]);
    if (fa.w !== fb.w || fa.h !== fb.h) throw new Error('the second image does not cover the whole AOI chip');
    let noise = [noisePower(a), noisePower(b)];
    let cnr = opts.cnrDb ?? 3;
    if (!noise[0] || !noise[1]) {
      // No NoisePoly: an amplitude threshold (the 2nd percentile of power) stands in for the floor.
      const pw = (z) => {
        const v = [];
        for (let i = 0; i < z.length; i += 2 * 97) v.push(z[i] * z[i] + z[i + 1] * z[i + 1]);
        v.sort((x, y) => x - y);
        return v[Math.floor(v.length * 0.02)] ?? 0;
      };
      noise = [noise[0] || pw(fa.z), noise[1] || pw(fb.z)];
    }
    const t0 = performance.now();
    const r = await app.pool.run('sar.ccd', { f: fa.z, g: fb.z, w: fa.w, h: fa.h, opts: { win: opts.win ?? 5, register: opts.register !== false, flatEarth: opts.flatEarth !== false, noise, compensate: !!opts.compensate, cnrDb: Number.isNaN(cnr) ? NaN : cnr, goldstein: opts.goldstein ?? 0 } }, { kind: 'analysis', transfer: [fa.z.buffer, fb.z.buffer], label: 'CCD', timeout: 600000 });
    const ms = performance.now() - t0;
    const n = fa.w * fa.h;
    const out = { chip: c, chipB: cb, ms, warnings: comp.warnings, matchInfo: comp.matchInfo, warp: r.warp, rms: r.rms, ties: r.ties?.length ?? 0, fringe: r.fringe, gamma: r.gamma, phase: r.phase, i1: r.i1, i2: r.i2, layers: {} };
    const want = new Set(opts.products ?? ['coherence', 'mtc']);
    const dB = (v) => 10 * Math.log10(v + 1e-30);
    const st = (arr) => {
      const s = [];
      for (let i = 0; i < arr.length; i += 61) if (Number.isFinite(arr[i]) && arr[i] > 0) s.push(dB(arr[i]));
      s.sort((x, y) => x - y);
      return [s[Math.floor(s.length * 0.02)] ?? -40, s[Math.floor(s.length * 0.98)] ?? 0];
    };
    const [lo1, hi1] = st(r.i1);
    const [lo2, hi2] = st(r.i2);
    const u8 = (v, lo, hi) => Math.max(0, Math.min(255, Math.round((255 * (v - lo)) / (hi - lo || 1))));
    const tag = `${a.info.iid} vs ${b.info.iid}`;
    if (want.has('coherence')) {
      const g = Float32Array.from(r.gamma, (v) => (Number.isFinite(v) ? v : NaN));
      out.layers.coherence = await product(a, c, [g], { name: `Coherence ${opts.win ?? 5}×${opts.win ?? 5} ${tag}`, stretch: 'none', select: false, pane: p });
    }
    if (want.has('mtc')) {
      // Two-date composite: R = date-1 backscatter (dB), G = date-2 (dB), B = coherence.
      const R = new Uint8Array(n);
      const G = new Uint8Array(n);
      const B = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        R[i] = u8(dB(r.i1[i]), lo1, hi1);
        G[i] = u8(dB(r.i2[i]), lo2, hi2);
        B[i] = Number.isFinite(r.gamma[i]) ? Math.round(255 * r.gamma[i]) : 0;
      }
      out.layers.mtc = await product(a, c, [R, G, B], { name: `CCD composite ${tag}`, type: 'u8', select: false, pane: p });
    }
    if (want.has('masked')) {
      // Mean amplitude in grey, low coherence tinted red, no decision (CNR mask) in blue-grey.
      const R = new Uint8Array(n);
      const G = new Uint8Array(n);
      const B = new Uint8Array(n);
      const th = opts.threshold ?? 0.5;
      for (let i = 0; i < n; i++) {
        const gr = u8(0.5 * (dB(r.i1[i]) + dB(r.i2[i])), lo1, hi1);
        const gm = r.gamma[i];
        if (!Number.isFinite(gm)) [R[i], G[i], B[i]] = [Math.round(gr * 0.6), Math.round(gr * 0.6), Math.round(gr * 0.6 + 60)];
        else if (gm < th) [R[i], G[i], B[i]] = [255, Math.round(gr * 0.3), Math.round(gr * 0.3)];
        else [R[i], G[i], B[i]] = [gr, gr, gr];
      }
      out.layers.masked = await product(a, c, [R, G, B], { name: `Coherence-masked change ${tag}`, type: 'u8', select: false, pane: p });
    }
    if (want.has('interferogram')) {
      const R = new Uint8Array(n);
      const G = new Uint8Array(n);
      const B = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const hue = (r.phase[i] + Math.PI) / (2 * Math.PI);
        const v = Number.isFinite(r.gamma[i]) ? r.gamma[i] : 0;
        const k = (q) => {
          const t = (q + hue * 6) % 6;
          return Math.round(255 * v * (1 - Math.max(0, Math.min(1, Math.min(t, 4 - t)))));
        };
        [R[i], G[i], B[i]] = [k(5), k(3), k(1)];
      }
      out.layers.interferogram = await product(a, c, [R, G, B], { name: `Interferogram ${tag}`, type: 'u8', select: false, pane: p });
    }
    app.sar.lastCcd = out;
    return out;
  }

  /**
   * Amplitude change (REQ-SAR-08): log-ratio of window-mean intensities after registration,
   * 2CMV (R = old, G/B = new), and change polygons where |ratio| ≥ threshold dB.
   */
  async function acd(a, b, opts = {}) {
    const win = opts.win ?? 5;
    const r = await ccd(a, b, { ...opts, win, flatEarth: false, products: [], cnrDb: NaN });
    const c = r.chip;
    const n = c.w * c.h;
    const lr = new Float32Array(n);
    // The registration resamples image 2: a border of the maximum shift plus the window is not valid.
    const edge = Math.ceil(opts.maxShift ?? 8) + win;
    for (let y = 0; y < c.h; y++)
      for (let x = 0; x < c.w; x++) {
        const i = y * c.w + x;
        const inside = x >= edge && y >= edge && x < c.w - edge && y < c.h - edge;
        lr[i] = inside && r.i1[i] > 0 && r.i2[i] > 0 ? 10 * Math.log10(r.i2[i] / r.i1[i]) : NaN;
      }
    const th = opts.threshold ?? 3;
    const p = opts.pane ?? pane();
    const out = { chip: c, logRatio: lr, threshold: th, layers: {} };
    out.layers.logRatio = await product(a, c, [lr], { name: `Log-ratio ${a.info.iid} → ${b.info.iid}`, palette: 'diverging', stretch: 'manual', select: false, pane: p });
    app.setChain((ch) => (ch.manual = { 0: { lo: -2 * th, hi: 2 * th } }), 'Log-ratio stretch', { layerId: out.layers.logRatio.id });
    // 2CMV: R = remapped older amplitude, G = B = remapped newer amplitude (shared statistics).
    const amp1 = Float32Array.from(r.i1, (v) => Math.sqrt(Math.max(0, v)));
    const amp2 = Float32Array.from(r.i2, (v) => Math.sqrt(Math.max(0, v)));
    const stats = (amp) => {
      let s = 0;
      let k = 0;
      for (let i = 0; i < amp.length; i += 7) if (Number.isFinite(amp[i])) {
        s += amp[i];
        k++;
      }
      return { mean: s / Math.max(1, k), min: 0, max: 1, minNonZero: 0, p99: 1 };
    };
    const s1 = stats(amp1);
    const R = new Uint8Array(n);
    const G = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      R[i] = Math.round(sarRemap('sar-density', amp1[i], s1));
      G[i] = Math.round(sarRemap('sar-density', amp2[i], s1));
    }
    out.layers.cmv = await product(a, c, [R, G, G.slice()], { name: `2CMV ${a.info.iid} → ${b.info.iid}`, type: 'u8', select: false, pane: p });
    // Change polygons: |r| ≥ th, a 3 × 3 majority clean-up, traced in image pixels and projected.
    const mask = new Float32Array(n);
    for (let y = 1; y < c.h - 1; y++)
      for (let x = 1; x < c.w - 1; x++) {
        let k = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (Math.abs(lr[(y + dy) * c.w + x + dx]) >= th) k++;
        mask[y * c.w + x] = k >= 5 ? (lr[y * c.w + x] >= 0 ? 2 : 1) : 0;
      }
    const rings = [];
    for (const [val, kind] of [[2, 'increase'], [1, 'decrease']]) {
      const m = new Float32Array((c.w + 2) * (c.h + 2));
      for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) m[(y + 1) * (c.w + 2) + x + 1] = mask[y * c.w + x] === val ? 1 : 0;
      // Pixel grid as a fake geographic grid: lon = x, lat = −y.
      const pg = { lat0: 1, lon0: -1, dlat: 1, dlon: 1, width: c.w + 2, height: c.h + 2 };
      for (const l of contourLines(pg, m, 0.5, { indexEvery: 1, maxLines: 20000, levels: [0.5] })) {
        if (l.pts.length < 4) continue;
        const ring = l.pts.map(([lon, lat]) => ({ x: lon + 0.5 + c.x0, y: -lat + 0.5 + c.y0 }));
        let area = 0;
        for (let i = 0; i < ring.length; i++) {
          const p1 = ring[i];
          const p2 = ring[(i + 1) % ring.length];
          area += p1.x * p2.y - p2.x * p1.y;
        }
        if (Math.abs(area / 2) >= (opts.minPixels ?? 12)) rings.push({ ring, kind, pixels: Math.abs(area / 2) });
      }
    }
    const hh = sarOf(a).scpHae ?? 0;
    let vid = null;
    if (rings.length) {
      S.transact(`Change polygons ${a.info.iid}`, (tx) => {
        vid = tx.create('vlayer', { name: `Amplitude change ±${th} dB`, visible: true, style: { stroke: '#ff4040', width: 2, fill: '#ff404030', outline: '#ff4040' }, fields: [{ name: 'CHANGE', type: 'text' }, { name: 'PIXELS', type: 'real' }, { name: 'AREA_M2', type: 'real' }], source: { format: 'sar-change' }, created: new Date().toISOString() });
        for (const r2 of rings) {
          const pts = r2.ring.map((q) => a.groundAt(q.x, q.y, hh)).filter(Boolean);
          if (pts.length < 3) continue;
          const area = core.polygonArea(pts.map((g) => [g.lat, g.lon])).area;
          tx.create('feature', { vlayer: vid, geom: fromParts('Polygon', [[...pts, pts[0]].map((g) => [g.lon, g.lat, hh])]), attrs: { CHANGE: r2.kind, PIXELS: r2.pixels, AREA_M2: Math.abs(area) }, name: `${r2.kind} ${Math.round(Math.abs(area))} m²`, prov: { kind: 'sar-change' } });
        }
      });
    }
    out.polygons = rings.map((r2) => ({ kind: r2.kind, pixels: r2.pixels, ring: r2.ring }));
    out.vlayer = vid;
    app.sar.lastAcd = out;
    return out;
  }

  // ---- pair finder (REQ-SAR-10) ----

  async function findPairs(layers = sicdLayers(), limits = {}) {
    const ids = new Map();
    const id = (s) => {
      const k = String(s ?? '');
      if (!ids.has(k)) ids.set(k, ids.size + 1);
      return ids.get(k);
    };
    const collects = layers.map((l) => {
      const m = sarOf(l);
      const fp = [[0.5, 0.5], [l.width - 0.5, 0.5], [l.width - 0.5, l.height - 0.5], [0.5, l.height - 0.5]].map(([x, y]) => {
        const g = l.groundAt(x, y, m.scpHae ?? 0);
        return [g.lat, g.lon];
      });
      return { family: id((m.collector ?? '').split(/[-_ ]/)[0].toUpperCase()), core: id(m.coreName), mode: id(m.modeType), pol: id(m.polarization), side: id(m.sideOfTrack), start: Date.parse(m.collectStart) / 1000, incidence: m.incidence ?? 0, azimuth: m.azimuth ?? 0, footprint: fp, matches: (m.match ?? []).map((x) => id(x.coreName)) };
    });
    const pairs = await app.pool.run('sar.pairs', { collects, limits }, { kind: 'analysis', label: 'pair finder' });
    return pairs.map((q) => ({ ...q, a: layers[q.a], b: layers[q.b] }));
  }

  // ---- sub-apertures and CSI (REQ-SAR-11), polarimetric (REQ-SAR-13) ----

  /** Azimuth is the SICD column dimension for these grids (Col = azimuth). */
  const azDim = () => 1;

  async function subaperture(l, opts = {}) {
    if (!isSicd(l)) throw new Error('the sub-aperture stack needs a complex SICD');
    const m = sarOf(l);
    const dk = m.colDeltaKCOAPoly;
    if (dk?.c?.some((v) => Math.abs(v) > 1e-9)) toast('Col DeltaKCOAPoly is not zero: the spectrum is deskewed approximately (constant term only)', { kind: 'warn' });
    const c = opts.chip ?? chipOf(pane(), l, 1024);
    const z = await complexChip(l, c);
    const frames = Math.min(9, opts.frames ?? 9);
    const fill = Number.isFinite(m.colSS * m.colBW) && m.colSS * m.colBW > 0 ? Math.max(1, 1 / (m.colSS * m.colBW)) : 1;
    const r = await app.pool.run('sar.subaperture', { z: z.z, w: z.w, h: z.h, opts: { dim: azDim(l), frames, fraction: opts.fraction ?? 0.2, fill } }, { kind: 'analysis', transfer: [z.z.buffer], label: 'sub-aperture stack' });
    const n = z.w * z.h;
    const planes = Array.from({ length: frames }, (_, k) => r.v.subarray(k * n, (k + 1) * n).slice());
    const L = await product(l, z, planes, { name: `${l.info.iid} sub-apertures (${frames} × ${Math.round((opts.fraction ?? 0.2) * 100)}%)`, irep: 'MULTI', stretch: 'sar-density' });
    app.setChain((ch) => (ch.bands = [0]), 'Sub-aperture frame 1', { layerId: L.id });
    return { layer: L, frames, fill };
  }

  /** Step through the frames of a sub-aperture layer (movie mode). */
  function animate(L, { rate = 4, loops = 1 } = {}) {
    const n = L.bands;
    let k = 0;
    return new Promise((res) => {
      const step = () => {
        app.setChain((ch) => (ch.bands = [k % n]), `Frame ${(k % n) + 1}`, { layerId: L.id, mergeKey: `subap:${L.id}` });
        L.ensureStats().then(() => {
          L.updateLut(true);
          app.renderer.invalidate();
        });
        k++;
        if (k < n * loops) setTimeout(step, 1000 / rate);
        else res(k);
      };
      step();
    });
  }

  async function csi(l, opts = {}) {
    if (!isSicd(l)) throw new Error('CSI needs a complex SICD');
    const m = sarOf(l);
    const c = opts.chip ?? chipOf(pane(), l, 1024);
    const z = await complexChip(l, c);
    const fill = Number.isFinite(m.colSS * m.colBW) && m.colSS * m.colBW > 0 ? Math.max(1, 1 / (m.colSS * m.colBW)) : 1;
    const r = await app.pool.run('sar.csi', { z: z.z, w: z.w, h: z.h, opts: { dim: azDim(l), fill } }, { kind: 'analysis', transfer: [z.z.buffer], label: 'CSI' });
    const n = z.w * z.h;
    const planes = [0, 1, 2].map((k) => r.v.subarray(k * n, (k + 1) * n).slice());
    return product(l, z, planes, { name: `${l.info.iid} CSI`, irep: 'RGB', stretch: 'linear2' });
  }

  async function pauli(layers, opts = {}) {
    const pol = (l) => String(sarOf(l)?.polarization ?? '').toUpperCase().replace(/:/g, '');
    const by = {};
    for (const l of layers) by[pol(l)] = l;
    const hh = by.HH;
    const hv = by.HV ?? by.VH;
    const vv = by.VV;
    if (!hh || !hv || !vv) throw new Error(`a Pauli composite needs HH, HV (or VH) and VV collects; found ${Object.keys(by).join(', ') || 'none'}`);
    const c = opts.chip ?? chipOf(pane(), hh, 2048);
    const [a, b, d] = await Promise.all([complexChip(hh, c), complexChip(hv, partnerChip(hh, hv, c)), complexChip(vv, partnerChip(hh, vv, c))]);
    const r = await app.pool.run('sar.pauli', { hh: a.z, hv: b.z, vv: d.z }, { kind: 'analysis', transfer: [a.z.buffer, b.z.buffer, d.z.buffer], label: 'Pauli' });
    const n = c.w * c.h;
    const planes = [0, 1, 2].map((k) => r.v.subarray(k * n, (k + 1) * n).slice());
    const L = await product(hh, c, planes, { name: `Pauli |HH−VV|, |HV|, |HH+VV| ${hh.info.iid}`, irep: 'RGB', stretch: 'linear2' });
    return { layer: L, planes, chip: c };
  }

  // ---- cursor read-out of SAR values (REQ-SAR-06) ----
  let readSeq = 0;
  const prevMoved = app.cursorMoved;
  app.cursorMoved = (p, x, y) => {
    prevMoved?.(p, x, y);
    const l = p?.geoLayer?.();
    if (!isSicd(l) || !Number.isFinite(x) || x < 0 || y < 0 || x >= l.width || y >= l.height) return;
    const seq = ++readSeq;
    const cal = viewOf(l);
    const bands = [0, 1, 4, ...(['beta0', 'sigma0', 'gamma0', 'rcs'].includes(cal) ? [SAR_VIEWS.find((v) => v[0] === cal)[2]] : [])];
    app.pool
      .run('pixels', { handle: l.handle, x, y, w: 1, h: 1, bands }, { affinity: l.affinity, priority: 'interactive', label: 'SAR read-out' })
      .then((r) => {
        if (seq !== readSeq) return;
        const v = r.values.map((a) => a[0]);
        const f = (q, d = 2) => (Number.isFinite(q) ? q.toFixed(d) : '–');
        const calTxt = bands.length > 3 ? ` · ${SAR_VIEWS.find((s) => s[0] === cal)[1].replace(' (dB)', '').replace(' (dB m²)', '')} ${f(v[3])} ${cal === 'rcs' ? 'dB m²' : 'dB'}` : '';
        p.mp?.status?.set?.({ dn: `|z| ${f(v[0], 4)} · φ ${f(v[1], 3)} rad · ${f(v[2])} dB${calTxt}` });
        app.sar.lastReadout = { amplitude: v[0], phase: v[1], powerDb: v[2], cal: bands.length > 3 ? { view: cal, db: v[3] } : null };
      })
      .catch(() => {});
  };

  app.sar = { isSicd, isSar, viewAvailable, setView, viewOf, setRemap, displayMode, overlayState, groundPlaneLinear, metadataDialog, summaryRows, setSpeckle, exportSpeckle, ccd, acd, compatibility, findPairs, subaperture, animate, csi, pauli, product, chipOf, partnerChip, sarStats, lastCcd: null, lastAcd: null };

  // ---- commands ----
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      toast(e.message, { kind: 'error', ms: 8000 });
    }
  };
  const has = () => isSar(layer());
  const hasC = () => isSicd(layer());
  C.implement('sar.metadata', { enabled: has, run: run(() => metadataDialog()) });
  C.implement('sar.view', {
    run: () => {},
    enabled: hasC,
    options: () => SAR_VIEWS.map(([value, label]) => ({ value, label, disabled: !viewAvailable(layer(), value).ok, title: viewAvailable(layer(), value).reason ?? '' })),
    value: () => viewOf(layer()),
    setValue: (v) => setView(layer(), v).catch((e) => toast(e.message, { kind: 'error' })),
  });
  C.implement('sar.remap', {
    run: () => {},
    enabled: hasC,
    options: () => SAR_REMAPS.map(([value, label]) => ({ value, label })),
    value: () => layer()?.chain?.sarRemap ?? 'sar-density',
    setValue: (v) => setRemap(layer(), v),
  });
  for (const [cmd, mode] of [['sar.anamorphic', 'anamorphic'], ['sar.ground', 'ground']])
    C.implement(cmd, { enabled: has, checked: () => pane()?.sar?.mode === mode, run: run(() => displayMode(pane(), pane()?.sar?.mode === mode ? 'native' : mode)) });
  C.implement('sar.shadows', { enabled: has, checked: () => pane()?.view.mode === 'shadows', run: run(() => pane().applyOrientation('shadows')) });
  C.implement('sar.northup', { enabled: has, checked: () => pane()?.view.mode === 'north', run: run(() => pane().applyOrientation('north')) });
  C.implement('sar.overlay', {
    enabled: has,
    checked: () => !!pane()?.sar?.overlay,
    run: () => {
      const p = pane();
      p.sar ??= { mode: 'native' };
      p.sar.overlay = !p.sar.overlay;
      p.invalidate();
    },
  });
  C.implement('sar.speckle', {
    enabled: hasC,
    run: run(async () => {
      const l = layer();
      const cur = l.chain.sarFilter ?? { op: 'none', win: 7, looks: 1, damping: 2 };
      const op = h('select', { class: 'inp', 'aria-label': 'Filter' }, ...SPECKLE.map(([v, t]) => h('option', { value: v, selected: v === cur.op }, t)));
      const win = h('select', { class: 'inp', 'aria-label': 'Window' }, ...[3, 5, 7, 9].map((k) => h('option', { value: String(k), selected: k === cur.win }, `${k} × ${k}`)));
      const looks = h('input', { class: 'inp inp-num', type: 'number', step: 'any', min: '0.5', value: cur.looks ?? 1, 'aria-label': 'Looks' });
      const damp = h('input', { class: 'inp inp-num', type: 'number', step: 'any', min: '0', value: cur.damping ?? 2, 'aria-label': 'Damping' });
      const body = h('div', {}, field('Filter', op), field('Window', win, 'Refined Lee always uses 7 × 7.'), field('Looks', looks, 'L ≈ 1 for single-look complex data.'), field('Frost damping', damp), h('p', { class: 'hint' }, 'The preview runs on the GPU at the displayed level; Export runs at full resolution in a worker on the AOI (or the view). Filters act on intensity; CCD always uses the unfiltered complex data.'));
      const b = await modal({ title: 'Speckle Filter', body, buttons: ['Preview', 'Export', 'Cancel'], id: 'sar-speckle' });
      const o = { win: Number(win.value), looks: Number(looks.value), damping: Number(damp.value) };
      if (b === 'Preview') setSpeckle(l, op.value, o);
      else if (b === 'Export' && op.value !== 'none') await exportSpeckle(l, op.value, o);
    }),
  });
  const partnerSelect = (a) => h('select', { class: 'inp', 'aria-label': 'Second image' }, ...sicdLayers().filter((l) => l !== a).map((l) => h('option', { value: l.id }, l.rec?.name ?? l.id)));
  C.implement('sar.acd', {
    enabled: () => hasC() && sicdLayers().length >= 2,
    run: run(async () => {
      const a = layer();
      const sel = partnerSelect(a);
      const th = h('input', { class: 'inp inp-num', type: 'number', step: 'any', value: 3, 'aria-label': 'Threshold dB' });
      const win = h('select', { class: 'inp', 'aria-label': 'Window' }, ...[3, 5, 7, 9].map((k) => h('option', { value: String(k), selected: k === 5 }, `${k} × ${k}`)));
      if ((await modal({ title: 'Amplitude Change', body: h('div', {}, field('Newer image', sel), field('Log-ratio threshold (± dB)', th), field('Multi-look window', win), h('p', { class: 'hint' }, 'Registers the AOI chips, then makes the log-ratio, a 2CMV composite (red: gone, cyan: new) and change polygons.')), buttons: ['Run', 'Cancel'], id: 'sar-acd' })) !== 'Run') return;
      const r = await acd(a, app.layers.get(sel.value), { threshold: Number(th.value), win: Number(win.value) });
      toast(`Amplitude change: ${r.polygons.length} polygon(s) at ±${r.threshold} dB`);
    }),
  });
  C.implement('sar.ccd', {
    enabled: () => hasC() && sicdLayers().length >= 2,
    run: run(async () => {
      const a = layer();
      const sel = partnerSelect(a);
      const win = h('select', { class: 'inp', 'aria-label': 'Coherence window' }, ...[3, 5, 7, 9].map((k) => h('option', { value: String(k), selected: k === 5 }, `${k} × ${k}`)));
      const reg = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Register' });
      const fe = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Flat earth' });
      const cnr = h('input', { class: 'inp inp-num', type: 'number', step: 'any', value: 3, 'aria-label': 'CNR threshold dB' });
      const comp = h('input', { type: 'checkbox', 'aria-label': 'Noise-compensated estimator' });
      const gold = h('input', { class: 'inp inp-num', type: 'number', step: 'any', min: 0, max: 1, value: 0, 'aria-label': 'Goldstein alpha' });
      const body = h('div', {}, field('Second image', sel), field('Coherence window', win), h('label', { class: 'fld fld-inline' }, reg, h('span', {}, 'Automatic registration (amplitude tie offsets, affine, 8-tap sinc resampling)')), h('label', { class: 'fld fld-inline' }, fe, h('span', {}, 'Remove the flat-earth fringe')), field('CNR mask (dB, blank = off)', cnr), h('label', { class: 'fld fld-inline' }, comp, h('span', {}, 'Noise-compensated estimator (after Wahl et al. 2016)')), field('Goldstein α (0 = off; interferogram only)', gold));
      if ((await modal({ title: 'Coherent Change Detection', body, buttons: ['Run', 'Cancel'], id: 'sar-ccd' })) !== 'Run') return;
      const r = await ccd(a, app.layers.get(sel.value), { win: Number(win.value), register: reg.checked, flatEarth: fe.checked, cnrDb: cnr.value === '' ? NaN : Number(cnr.value), compensate: comp.checked, goldstein: Number(gold.value), products: ['coherence', 'mtc', 'masked', 'interferogram'] });
      toast(`CCD: ${r.chip.w} × ${r.chip.h} in ${(r.ms / 1000).toFixed(1)} s${r.warnings.length ? ` — ${r.warnings.join('; ')}` : ''}`);
    }),
  });
  C.implement('sar.pairs', {
    enabled: () => sicdLayers().length >= 2,
    run: run(async () => {
      const pairs = await findPairs();
      const rows = pairs.map((q) => h('tr', { class: q.ok ? '' : 'muted' }, h('td', {}, q.a.rec?.name ?? ''), h('td', {}, q.b.rec?.name ?? ''), h('td', {}, `${Math.round(q.overlap * 100)}%`), h('td', {}, q.days.toFixed(1)), h('td', {}, q.dInc.toFixed(2)), h('td', {}, q.dAz.toFixed(2)), h('td', {}, q.matched ? 'yes' : ''), h('td', {}, q.ok ? 'compatible' : q.reasons.join(', '))));
      await modal({ title: 'Interferometric Pair Finder', body: h('table', { class: 'tbl', 'data-id': 'sar-pairs' }, h('thead', {}, h('tr', {}, ...['Image A', 'Image B', 'Overlap', 'Days', 'ΔInc °', 'ΔAz °', 'MatchInfo', 'Result'].map((t) => h('th', {}, t)))), h('tbody', {}, ...rows)), buttons: ['Close'], width: 720, id: 'sar-pairs' });
    }),
  });
  C.implement('sar.subap', {
    enabled: hasC,
    run: run(async () => {
      const r = await subaperture(layer());
      toast(`Sub-aperture stack: ${r.frames} frames`);
      await animate(r.layer, { rate: 4, loops: 2 });
    }),
  });
  C.implement('sar.csi', { enabled: hasC, run: run(() => csi(layer())) });
  C.implement('sar.pauli', { enabled: () => sicdLayers().length >= 3, run: run(() => pauli(sicdLayers())) });
}
