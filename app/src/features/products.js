// Products ▸ Chip (REQ-PRD-01, REQ-PRD-10, REQ-IMG-28): chips of the current view, of a preset
// ground size and of every marker; Save Product As in PNG, JPEG (each with world file, .prj
// and chip record), GeoTIFF (as displayed, or source samples) and NITF 2.1 (source samples,
// marking, parent RPC00B + ICHIPB). Autolabels and the auto locator map are graphics that
// resolve for whichever image they are on.

import { h } from '../shell/dom.js';
import { modal, field, section } from '../shell/dialogs.js';
import { saveBlob } from '../storage/files.js';
import { zipSync, strToU8 } from 'fflate';
import { ChipView } from '../render/offscreen.js';
import { makeChip, worldFileFor, WGS84_PRJ, DEFAULT_CAPTION, chipMarking } from '../products/chip.js';
import { TOKENS, tokenValues, resolveTokens } from '../products/tokens.js';
import { writeGeoTiff } from '../formats/geotiff-writer.js';
import { writeNitf } from '../formats/nitf-writer.js';
import { LEVELS, LEVEL_NAME, bannerText, rank } from '../security/marking.js';

export const name = 'products';

export const FORMATS = [
  ['png', 'PNG + world file (.pgw, .prj, record)'],
  ['jpeg', 'JPEG + world file (.jgw, .prj, record)'],
  ['tif-display', 'GeoTIFF, as displayed (RGB, GCPs)'],
  ['tif-source', 'GeoTIFF, source samples (all bands)'],
  ['nitf-source', 'NITF 2.1, source samples (RPC00B + ICHIPB)'],
];

const canvasBlob = (c, type, q) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('the browser could not encode the chip'))), type, q));
const safeName = (s) => String(s || 'chip').replace(/[^\w.-]+/g, '_').slice(0, 60);

/** GCP grid (n × n) of a ChipView: output pixel corners-origin (x, y) → ground. */
function gcpGrid(cv, l, W, H, n = 5) {
  const out = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * W;
      const y = (j / (n - 1)) * H;
      const p = cv.imagePoint((x / W) * cv.width, (y / H) * cv.height);
      const g = l.groundAt(p.x, p.y);
      if (g) out.push({ x, y, lon: g.lon, lat: g.lat, h: g.h ?? 0 });
    }
  return out;
}

/** The layer's RPC record (92 values) when its active model is an RPC, plus the ICHIPB affine. */
function rpcOf(l) {
  if (!/^RPC/.test(l.modelName)) return null;
  const sh = l.info.subheader;
  const rec = sh?.rpc?.slice(0, 92) ?? l.info.meta?.rpc?.slice(0, 92);
  if (!rec || rec.length < 92 || rec.some((v) => !Number.isFinite(v))) return null;
  return { rec, chip: sh?.ichipb ?? null, full: sh?.fullImageSize ?? null };
}

/** Source samples under a view: the axis-aligned window, every `step`-th pixel. */
export async function sourceWindow(app, cv, l, step = null) {
  const { w, h: hh } = cv.size();
  const cs = [
    [0, 0],
    [w, 0],
    [w, hh],
    [0, hh],
  ].map(([x, y]) => cv.imagePoint(x, y));
  const x0 = Math.max(0, Math.floor(Math.min(...cs.map((p) => p.x))));
  const y0 = Math.max(0, Math.floor(Math.min(...cs.map((p) => p.y))));
  const x1 = Math.min(l.width, Math.ceil(Math.max(...cs.map((p) => p.x))));
  const y1 = Math.min(l.height, Math.ceil(Math.max(...cs.map((p) => p.y))));
  if (x1 <= x0 || y1 <= y0) throw new Error('the view does not cover the image');
  const s = step ?? Math.max(1, Math.floor(1 / cv.view.zoom));
  const bands = Array.from({ length: l.bands }, (_, i) => i);
  const r = await app.pool.run('window', { handle: l.handle, x0, y0, w: Math.ceil((x1 - x0) / s), h: Math.ceil((y1 - y0) / s), step: s, bands }, { affinity: l.affinity, label: `product: read ${l.rec.name}`, timeout: 300000 });
  return { ...r, bands: bands.length, type: l.sampleType };
}

/** Image-pixel (corner-origin) position of a source-window sample centre. */
const winToImage = (win, col, row) => ({ x: win.x0 + col * win.step + 0.5, y: win.y0 + row * win.step + 0.5 });

/** Encode a chip in one of FORMATS; returns {blob, name, types, description}. */
export async function encodeProduct(app, chip, fmt, { base = null } = {}) {
  const rec = chip.record;
  const stem = base ?? `chip${rec.number}_${safeName(rec.image)}`;
  const l = chip.view.geoLayer() ?? chip.view.layers()[0];
  const recJson = JSON.stringify({ ...rec, format: fmt }, null, 1);
  if (fmt === 'png' || fmt === 'jpeg') {
    const blob = await canvasBlob(chip.canvas, fmt === 'png' ? 'image/png' : 'image/jpeg', 0.92);
    const ext = fmt === 'png' ? 'png' : 'jpg';
    const files = { [`${stem}.${ext}`]: new Uint8Array(await blob.arrayBuffer()), [`${stem}.json`]: strToU8(recJson) };
    const wf = worldFileFor(rec, chip.imageTop);
    if (wf) {
      files[`${stem}.${fmt === 'png' ? 'pgw' : 'jgw'}`] = strToU8(wf.text);
      files[`${stem}.prj`] = strToU8(WGS84_PRJ);
      rec.worldFileResidualM = wf.residualM;
    }
    return { blob: new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' }), name: `${stem}.zip`, types: ['.zip'], description: 'Chip (ZIP)', world: wf };
  }
  const banner = bannerText(chip.marking);
  if (fmt === 'tif-display') {
    const [W, H] = rec.size;
    const px = chip.image.data;
    const rgb = new Uint8Array(W * H * 3);
    for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
      rgb[j] = px[i];
      rgb[j + 1] = px[i + 1];
      rgb[j + 2] = px[i + 2];
    }
    const gcps = l?.modelId ? gcpGrid(chip.view, l, W, H) : [];
    const u8 = await writeGeoTiff({ width: W, height: H, bands: 3, type: 'u8', data: rgb }, { photometric: 'rgb', epsg: gcps.length ? 4326 : null, gcps, description: `${banner} | ${rec.caption}` });
    return { blob: new Blob([u8], { type: 'image/tiff' }), name: `${stem}.tif`, types: ['.tif'], description: 'GeoTIFF' };
  }
  if (!l) throw new Error('the chip has no image layer');
  const win = await sourceWindow(app, chip.view, l);
  rec.source = { x0: win.x0, y0: win.y0, w: win.w, h: win.h, step: win.step };
  const rpc = rpcOf(l);
  if (fmt === 'tif-source') {
    const n = win.bands;
    const Arr = win.planes[0].constructor;
    const data = new Arr(win.w * win.h * n);
    for (let b = 0; b < n; b++) for (let i = 0; i < win.w * win.h; i++) data[i * n + b] = win.planes[b][i];
    const type = { Uint8Array: 'u8', Uint16Array: 'u16', Int16Array: 'i16', Float32Array: 'f32' }[Arr.name];
    if (!type) throw new Error(`no GeoTIFF writer for ${Arr.name} samples`);
    const opts = { description: `${banner} | ${rec.caption}`, nodata: l.nodata ?? undefined };
    const gt = l.info.meta?.geotransform;
    const epsg = l.info.meta?.epsg;
    if (gt && epsg && /^Map|World/.test(l.modelName) && !gt[2] && !gt[4]) {
      // Native map grid: an exact geotransform of the window (corner-origin).
      opts.epsg = epsg;
      opts.geotransform = [gt[0] + win.x0 * gt[1], gt[1] * win.step, 0, gt[3] + win.y0 * gt[5], 0, gt[5] * win.step];
    } else if (l.modelId) {
      opts.epsg = 4326;
      opts.gcps = [];
      for (let j = 0; j < 5; j++)
        for (let i = 0; i < 5; i++) {
          const col = (i / 4) * win.w;
          const row = (j / 4) * win.h;
          const g = l.groundAt(win.x0 + col * win.step, win.y0 + row * win.step);
          if (g) opts.gcps.push({ x: col, y: row, lon: g.lon, lat: g.lat, h: g.h ?? 0 });
        }
    }
    const A = rpc?.chip?.some((v) => v !== 0) ? rpc.chip : [0, 1, 0, 0, 0, 1];
    if (rpc && Math.abs(A[2]) < 1e-12 && Math.abs(A[4]) < 1e-12) {
      // RPC of the window. RPC sample s (pixel centres) of window column c: the parent-chip
      // corner coordinate x0 + c·step + 0.5 maps through ICHIPB to the full image, so
      // s = α + β·c with β = A1·step and α = A0 + A1·(x0 + 0.5) − 0.5; likewise for lines.
      const r = rpc.rec.slice();
      const [bs, as] = [A[1] * win.step, A[0] + A[1] * (win.x0 + 0.5) - 0.5];
      const [bl, al] = [A[5] * win.step, A[3] + A[5] * (win.y0 + 0.5) - 0.5];
      r[2] = (r[2] - al) / bl;
      r[3] = (r[3] - as) / bs;
      r[7] /= bl;
      r[8] /= bs;
      opts.rpc = r;
    }
    const u8 = await writeGeoTiff({ width: win.w, height: win.h, bands: n, type, data }, opts);
    return { blob: new Blob([u8], { type: 'image/tiff' }), name: `${stem}.tif`, types: ['.tif'], description: 'GeoTIFF' };
  }
  if (fmt === 'nitf-source') {
    const corners = l.modelId
      ? [
          [0, 0],
          [win.w - 1, 0],
          [win.w - 1, win.h - 1],
          [0, win.h - 1],
        ].map(([c, r]) => {
          const p = winToImage(win, c, r);
          const g = l.groundAt(p.x, p.y);
          return g ? [g.lat, g.lon] : null;
        })
      : null;
    const opts = {
      marking: chip.marking,
      title: rec.caption,
      iid1: `CHIP${String(rec.number).padStart(4, '0')}`,
      iid2: rec.image,
      idatim: String(l.info.subheader?.IDATIM ?? '').trim() || undefined,
      isorce: l.info.subheader?.ISORCE ?? '',
      icat: l.info.icat || 'VIS',
      irep: l.info.irep && ['MONO', 'RGB', 'MULTI'].includes(l.info.irep.trim()) && !(l.info.irep.trim() === 'MONO' && win.bands > 1) ? l.info.irep.trim() : undefined,
      abpp: l.info.subheader?.ABPP,
      corners: corners?.every(Boolean) ? corners : null,
    };
    if (rpc) {
      // RPC00B carries integer offsets: round them and shift the ICHIPB full-image frame by the
      // fractions, so the written model is the parent's exactly. A parent chip composes.
      const r = rpc.rec.slice();
      const dl = r[2] - Math.round(r[2]);
      const ds = r[3] - Math.round(r[3]);
      r[2] = Math.round(r[2]);
      r[3] = Math.round(r[3]);
      opts.rpc = r;
      const A = rpc.chip;
      opts.chip = {
        w: win.w,
        h: win.h,
        step: win.step,
        fullW: rpc.full?.[0] ?? l.width,
        fullH: rpc.full?.[1] ?? l.height,
        toFull: (row, col) => {
          const p = { x: win.x0 + (col - 0.5) * win.step + 0.5, y: win.y0 + (row - 0.5) * win.step + 0.5 };
          const q = A && A.some((v) => v !== 0) ? { x: A[0] + A[1] * p.x + A[2] * p.y, y: A[3] + A[4] * p.x + A[5] * p.y } : p;
          return [q.y - dl, q.x - ds];
        },
      };
    }
    const u8 = writeNitf({ width: win.w, height: win.h, bands: win.bands, type: win.type, planes: win.planes }, opts);
    return { blob: new Blob([u8], { type: 'application/vnd.nitf' }), name: `${stem}.ntf`, types: ['.ntf'], description: 'NITF' };
  }
  throw new Error(`unknown product format ${fmt}`);
}

/** Run fn with a busy cursor and the message announced in the status area. */
async function busy(msg, fn) {
  document.body.setAttribute('aria-busy', 'true');
  document.body.dataset.busy = msg;
  try {
    return await fn();
  } finally {
    document.body.removeAttribute('aria-busy');
    delete document.body.dataset.busy;
  }
}

export function install(app) {
  const C = app.commands;
  const pane = () => app.activePane();
  const hasImage = () => (pane()?.visibleLayers?.().length ?? 0) > 0;

  app.resolveLabel = (p, template) => {
    const l = p.geoLayer?.() ?? p.activeLayer?.();
    return resolveTokens(template, tokenValues({ app, layer: l, view: p, marking: p.visibleLayers ? bannerText(chipMarking(app, p)) : '' }));
  };

  const storeChip = (rec) => app.store.transact(`Chip ${rec.number}`, (tx) => tx.create('chip', { ...rec, pane: pane()?.id ?? null }));

  /** The chip dialog: preview, caption, marking raise, format; Save writes the product. */
  async function chipDialog(p, opts = {}) {
    let chip;
    try {
      chip = await busy('Rendering chip', () => makeChip(app, p, opts));
    } catch (e) {
      return app.toast(`Chip failed: ${e.message}`, { kind: 'error' });
    }
    const preview = h('div', { class: 'chip-preview', tabindex: '0', role: 'region', 'aria-label': 'Chip preview (scrolls)' });
    const show = () => {
      preview.replaceChildren(chip.canvas);
      chip.canvas.setAttribute('aria-label', `Chip preview: ${chip.record.caption}`);
      chip.canvas.setAttribute('role', 'img');
    };
    show();
    const caption = h('input', { class: 'inp', value: opts.caption ?? app.prefs.get('chipCaption') ?? DEFAULT_CAPTION, 'aria-label': 'Caption template' });
    const fmt = h('select', { class: 'inp', 'aria-label': 'Format' }, ...FORMATS.map(([v, t]) => h('option', { value: v }, t)));
    fmt.value = app.prefs.get('chipFormat') ?? 'png';
    const base = chip.marking;
    const raise = h('select', { class: 'inp', 'aria-label': 'Marking' }, ...LEVELS.filter((lv) => rank(lv) >= rank(base.level)).map((lv) => h('option', { value: lv }, LEVEL_NAME[lv])));
    raise.value = base.level;
    const gfx = h('input', { type: 'checkbox', checked: opts.graphics !== false, 'aria-label': 'Include graphics and measurements' });
    const info = h('p', { class: 'hint chip-info' });
    const updateInfo = () => {
      const r = chip.record;
      info.textContent = `${r.size[0]} × ${r.size[1]} px${r.metresPerPixel ? ` · ${r.metresPerPixel.toFixed(3)} m/px at the centre` : ''}${r.scaleBar ? ` · scale bar ${r.scaleBar.metres} m` : ''} · ${bannerText(chip.marking)}`;
    };
    updateInfo();
    const rerender = async () => {
      try {
        chip = await makeChip(app, p, { ...opts, caption: caption.value, graphics: gfx.checked, raise: raise.value !== base.level ? { ...base, level: raise.value, source: 'raised for this product' } : null, number: chip.record.number });
        show();
        updateInfo();
      } catch (e) {
        app.toast(`Chip failed: ${e.message}`, { kind: 'error' });
      }
    };
    caption.addEventListener('change', rerender);
    raise.addEventListener('change', rerender);
    gfx.addEventListener('change', rerender);
    const tokenHelp = h('details', {}, h('summary', {}, 'Caption tokens'), h('ul', { class: 'small' }, ...Object.entries(TOKENS).map(([k, v]) => h('li', {}, h('code', {}, `{${k}}`), ` ${v}`))), h('p', { class: 'hint' }, '{TOKEN[0:12]} takes a substring; {TOKEN|text} prints text when the value is unknown.'));
    const body = h('div', {}, preview, info, field('Caption', caption), tokenHelp, field('Marking (raise only)', raise), field('Graphics', h('label', {}, gfx, ' Include graphics and measurements')), field('Format', fmt));
    for (;;) {
      const r = await modal({ title: 'Chip', body, buttons: ['Save…', 'Close'], width: 720, id: 'chip', marking: bannerText(chip.marking) });
      if (r !== 'Save…') return chip;
      app.prefs.set('chipFormat', fmt.value);
      app.prefs.set('chipCaption', caption.value);
      try {
        const out = await busy('Writing product', () => encodeProduct(app, chip, fmt.value));
        storeChip({ ...chip.record, format: fmt.value });
        app.chipImages?.set(chip.record.number, chip.canvas.toDataURL('image/jpeg', 0.85)); // for reports
        await saveBlob(app, out.blob, { name: out.name, types: out.types, description: out.description });
        app.toast(`Saved ${out.name}`);
        return chip;
      } catch (e) {
        app.toast(`Save failed: ${e.message}`, { kind: 'error' });
      }
    }
  }
  app.chipDialog = chipDialog;
  app.makeChip = (opts) => makeChip(app, pane(), opts);
  app.encodeProduct = async (chip, fmt, o) => {
    const r = await encodeProduct(app, chip, fmt, o);
    app.provenanceNotice?.(fmt, chip, r);
    return r;
  };

  /** Chip Current View; with an AOI in the panel the chip frames the AOI (REQ-IMG-30). */
  const viewOpts = (p) => {
    if (!app.aoiFor?.(p)) return {};
    const dpr = window.devicePixelRatio || 1;
    const { w, h: hh } = p.size();
    const W = Math.round(w * dpr);
    const H = Math.round(hh * dpr);
    const view = app.aoiView(p, W, H);
    return view ? { width: W, height: H, view, zoom: view.zoom } : {};
  };
  app.chipViewOpts = viewOpts;
  C.implement('chip.view', { enabled: hasImage, run: () => chipDialog(pane(), viewOpts(pane())) });
  C.implement('prod.saveas', { enabled: hasImage, run: () => chipDialog(pane()) });

  /** View of a ground area `metres` wide centred on image point c, `px` output pixels wide. */
  const presetView = (p, c, metres, px) => {
    const l = p.geoLayer();
    const probe = new ChipView(p, { ...p.view, cx: c.x, cy: c.y, zoom: 1 }, 200, 200);
    const mpp = probe.groundScale(l);
    if (!Number.isFinite(mpp)) throw new Error('the image has no geolocation');
    return { ...p.view, cx: c.x, cy: c.y, zoom: (px * mpp) / metres };
  };
  const presetFields = () => {
    const size = h('select', { class: 'inp', 'aria-label': 'Ground size' }, ...[100, 250, 500, 1000, 2000, 5000].map((m) => h('option', { value: String(m) }, m >= 1000 ? `${m / 1000} km` : `${m} m`)));
    size.value = String(app.prefs.get('chipPresetMetres') ?? 500);
    const px = h('input', { class: 'inp', type: 'number', min: '128', max: '8192', step: '64', value: String(app.prefs.get('chipPresetPx') ?? 1024), 'aria-label': 'Output width (px)' });
    return { size, px, body: h('div', {}, field('Ground size (square)', size), field('Output size (px)', px)) };
  };
  C.implement('chip.preset', {
    enabled: () => !!pane()?.geoLayer?.()?.modelId,
    run: async () => {
      const p = pane();
      const f = presetFields();
      if ((await modal({ title: 'Chip by Preset Area Size', body: f.body, buttons: ['Chip', 'Cancel'], id: 'chip-preset' })) !== 'Chip') return;
      app.prefs.set('chipPresetMetres', +f.size.value);
      app.prefs.set('chipPresetPx', +f.px.value);
      const W = Math.round(+f.px.value);
      try {
        const view = presetView(p, { x: p.view.cx, y: p.view.cy }, +f.size.value, W);
        return chipDialog(p, { width: W, height: W, view, zoom: view.zoom });
      } catch (e) {
        app.toast(e.message, { kind: 'error' });
      }
    },
  });

  C.implement('chip.markers', {
    enabled: () => !!pane()?.geoLayer?.() && app.store.all('graphic').some((g) => g.shape === 'marker' && g.pane === pane()?.id),
    run: async () => {
      const p = pane();
      const f = presetFields();
      const fmt = h('select', { class: 'inp', 'aria-label': 'Format' }, ...FORMATS.map(([v, t]) => h('option', { value: v }, t)));
      fmt.value = app.prefs.get('chipFormat') ?? 'png';
      f.body.append(field('Format', fmt));
      if ((await modal({ title: 'Chip All Markers', body: f.body, buttons: ['Chip', 'Cancel'], id: 'chip-markers' })) !== 'Chip') return;
      const W = Math.round(+f.px.value);
      const markers = app.store.all('graphic').filter((g) => g.shape === 'marker' && g.pane === p.id).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      const files = {};
      const records = [];
      const first = app.store.all('chip').length + 1;
      await busy(`Chipping ${markers.length} markers`, async () => {
        for (const [i, m] of markers.entries()) {
          const sp = app.graphics.screenPoints(p, m, ...Object.values(p.size()))[0];
          if (!sp) continue;
          const c = p.imagePoint(sp.x, sp.y);
          const view = presetView(p, c, +f.size.value, W);
          const chip = await makeChip(app, p, { width: W, height: W, view, zoom: view.zoom, number: first + i });
          const out = await encodeProduct(app, chip, fmt.value, { base: `marker${m.seq ?? i + 1}_chip${chip.record.number}` });
          files[out.name] = new Uint8Array(await out.blob.arrayBuffer());
          records.push({ ...chip.record, marker: m.id, format: fmt.value });
          app.chipImages?.set(chip.record.number, chip.canvas.toDataURL('image/jpeg', 0.85));
        }
      });
      if (!records.length) return app.toast('No marker could be chipped', { kind: 'warn' });
      app.store.transact(`Chip ${records.length} markers`, (tx) => records.forEach((r) => tx.create('chip', { ...r, pane: p.id })));
      files['chips.json'] = strToU8(JSON.stringify(records, null, 1));
      await saveBlob(app, new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' }), { name: 'marker-chips.zip', types: ['.zip'], description: 'Chips (ZIP)' });
      app.toast(`${records.length} chips saved`);
    },
  });

  // ---- autolabels and the locator map (REQ-IMG-28) ----
  const ensureGlayer = (tx, p) => {
    let gl = p.rec.graphicsLayer;
    if (!gl) {
      gl = tx.create('glayer', { pane: p.id, name: 'Graphics', visible: true, saved: false });
      tx.set(p.id, 'graphicsLayer', gl);
    }
    return gl;
  };
  const CORNERS = { 'top-left': [0.02, 0.06], 'top-right': [0.7, 0.06], 'bottom-left': [0.02, 0.8], 'bottom-right': [0.7, 0.8] };
  C.implement('draw.autolabels', {
    enabled: hasImage,
    run: async () => {
      const p = pane();
      const tpl = h('textarea', { class: 'inp', rows: '4', 'aria-label': 'Label template' }, app.prefs.get('autolabel') ?? '{IMAGE_ID}\n{ACQ_DATE|time unknown}\n{MGRS_CENTER|no geolocation}');
      const pos = h('select', { class: 'inp', 'aria-label': 'Position' }, ...Object.keys(CORNERS).map((k) => h('option', { value: k }, k.replace('-', ' '))));
      const help = h('ul', { class: 'small' }, ...Object.entries(TOKENS).map(([k, v]) => h('li', {}, h('code', {}, `{${k}}`), ` ${v}`)));
      if ((await modal({ title: 'Auto Labels', body: h('div', {}, field('Template', tpl), field('Position', pos), section('Tokens', help)), buttons: ['Add', 'Cancel'], id: 'autolabels' })) !== 'Add') return;
      app.prefs.set('autolabel', tpl.value);
      app.store.transact('Auto label', (tx) => {
        const gl = ensureGlayer(tx, p);
        tx.create('graphic', { glayer: gl, pane: p.id, shape: 'text', anchor: 'screen', coords: [CORNERS[pos.value]], template: tpl.value, text: app.resolveLabel(p, tpl.value), style: { stroke: '#ffffff', width: 1, fill: '#ffffff', fontSize: 13 }, created: new Date().toISOString(), provenance: { kind: 'autolabel' } });
      });
    },
  });
  C.implement('draw.automap', {
    enabled: () => !!pane()?.geoLayer?.()?.modelId,
    run: () => {
      const p = pane();
      app.store.transact('Auto map', (tx) => {
        const gl = ensureGlayer(tx, p);
        tx.create('graphic', { glayer: gl, pane: p.id, shape: 'automap', anchor: 'screen', coords: [[0.76, 0.62]], size: 0.22, text: 'Locator', style: { stroke: '#ffffff', width: 1, fill: '#00000099' }, created: new Date().toISOString(), provenance: { kind: 'automap' } });
      });
    },
  });

  /** Locator map: graticule, the image footprint and the view's footprint, north up. */
  app.drawAutomap = (p, g, at, r) => {
    const l = p.geoLayer?.();
    if (!l) return;
    const { w: pw, h: ph } = p.size();
    const S = Math.max(90, (r.size ?? 0.22) * Math.min(pw, ph));
    const ring = (pts) => pts.map(([x, y]) => l.groundAt(x, y));
    const img = ring([
      [0, 0],
      [l.width, 0],
      [l.width, l.height],
      [0, l.height],
    ]);
    const vw = ring(
      [
        [0, 0],
        [pw, 0],
        [pw, ph],
        [0, ph],
      ].map(([x, y]) => {
        const q = p.imagePoint(x, y);
        return [q.x, q.y];
      }),
    );
    if (img.some((q) => !q)) return;
    const lat0 = img.reduce((s, q) => s + q.lat, 0) / 4;
    const lon0 = img.reduce((s, q) => s + q.lon, 0) / 4;
    const k = Math.cos((lat0 * Math.PI) / 180);
    const span = Math.max(...img.map((q) => Math.max(Math.abs(q.lat - lat0), Math.abs(q.lon - lon0) * k))) * 3 || 0.01;
    const toXY = (q) => ({ x: at.x + S / 2 + (((q.lon - lon0) * k) / span) * (S / 2), y: at.y + S / 2 - ((q.lat - lat0) / span) * (S / 2) });
    g.save();
    g.fillStyle = r.style?.fill ?? '#00000099';
    g.fillRect(at.x, at.y, S, S);
    g.beginPath();
    g.rect(at.x, at.y, S, S);
    g.clip();
    // Graticule at a round step.
    const stepDeg = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5].find((s) => (2 * span) / s <= 6) ?? 10;
    g.strokeStyle = '#ffffff40';
    g.lineWidth = 1;
    for (let la = Math.floor((lat0 - span) / stepDeg) * stepDeg; la <= lat0 + span; la += stepDeg) {
      const a = toXY({ lat: la, lon: lon0 - span / k });
      const b = toXY({ lat: la, lon: lon0 + span / k });
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
    }
    for (let lo = Math.floor((lon0 - span / k) / stepDeg) * stepDeg; lo <= lon0 + span / k; lo += stepDeg) {
      const a = toXY({ lat: lat0 - span, lon: lo });
      const b = toXY({ lat: lat0 + span, lon: lo });
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
    }
    const polyOf = (qs, stroke, fill) => {
      g.beginPath();
      qs.forEach((q, i) => {
        const s = toXY(q);
        i ? g.lineTo(s.x, s.y) : g.moveTo(s.x, s.y);
      });
      g.closePath();
      if (fill) {
        g.fillStyle = fill;
        g.fill();
      }
      g.strokeStyle = stroke;
      g.lineWidth = 1.5;
      g.stroke();
    };
    polyOf(img, '#00e5ff', '#00e5ff22');
    if (vw.every(Boolean)) polyOf(vw, '#ff3030', null);
    g.restore();
    g.strokeStyle = r.style?.stroke ?? '#fff';
    g.lineWidth = 1;
    g.strokeRect(at.x, at.y, S, S);
    g.font = '10px Arial, sans-serif';
    g.fillStyle = '#fff';
    g.fillText(`${Math.abs(lat0).toFixed(3)}°${lat0 < 0 ? 'S' : 'N'} ${Math.abs(lon0).toFixed(3)}°${lon0 < 0 ? 'W' : 'E'}  ▲N`, at.x + 4, at.y + S - 4);
  };
}
