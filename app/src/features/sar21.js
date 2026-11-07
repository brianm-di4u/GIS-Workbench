// 2.1 SAR and swath formats on the main thread (SDP-2.1 FC-21, FC-24, FC-26):
// - CPHD (REQ-FMT-49..51): collection geometry on the map (image area, SRP, IARP, ARP track), the
//   Phase History panel (summary, PVP plots, support arrays, XML tree) and Save CPHD Subset;
// - UAVSAR annotation files opened alone (REQ-FMT-53): the product's footprint and annotation as a layer;
// - Sentinel-1 SAFE products (REQ-FMT-55): see formats/safe.js.

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { saveBlob } from '../storage/files.js';
import { fromParts } from '../vector/geom.js';
import { t, tc, N_, msgOf } from '../i18n/index.js';
import { num } from '../i18n/format.js';

export const name = 'sar21';

/** A value for display: d decimals in the UI locale's notation, '–' when not finite. */
const f = (x, d = 3) => (Number.isFinite(x) ? num(Number(x), d) : '–');
/** Escape text for the plot's SVG markup. */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** A small SVG line plot: series [{label, ys}] over xs, own y range per plot. */
export function linePlot(title, xs, series, { unit = '', W = 560, H = 120 } = {}) {
  const all = series.flatMap((s) => s.ys).filter(Number.isFinite);
  if (!all.length || !xs.length) return null;
  let [lo, hi] = [Math.min(...all), Math.max(...all)];
  if (hi === lo) [lo, hi] = [lo - 1, hi + 1];
  const [x0, x1] = [xs[0], xs.at(-1) || 1];
  const px = (x) => 40 + ((x - x0) / (x1 - x0 || 1)) * (W - 50);
  const py = (y) => H - 18 - ((y - lo) / (hi - lo)) * (H - 30);
  const colours = ['#4fc3f7', '#ffcb5f', '#a5d6a7', '#ef9a9a'];
  const lines = series.map((s, k) => {
    const pts = xs.map((x, i) => (Number.isFinite(s.ys[i]) ? `${px(x).toFixed(1)},${py(s.ys[i]).toFixed(1)}` : null)).filter(Boolean).join(' ');
    return `<polyline points="${pts}" fill="none" stroke="${colours[k % 4]}" stroke-width="1.2"/>`;
  });
  const g = (v) => (Math.abs(v) >= 1e5 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(3) : num(v, 3));
  const legend = series.map((s, k) => `<tspan fill="${colours[k % 4]}">${esc(s.label)}</tspan>`).join(' ');
  // `title` is the plot's key (data-plot, for tests and automation); it is shown translated.
  const shown = esc(t(title));
  const el = h('div', { class: 'cphd-plot', 'data-plot': title });
  el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="${shown}"><rect width="${W}" height="${H}" fill="#1b1f24"/>${lines.join('')}<text x="40" y="11" fill="#c8ccd0" font-size="10">${esc(unit ? t('{title} ({unit}): ', { title: t(title), unit }) : t('{title}: ', { title: t(title) }))}${legend}</text><text x="2" y="${py(hi) + 3}" fill="#9aa0a6" font-size="9">${g(hi)}</text><text x="2" y="${py(lo)}" fill="#9aa0a6" font-size="9">${g(lo)}</text><text x="${W - 60}" y="${H - 4}" fill="#9aa0a6" font-size="9">${esc(t('vector {n}', { n: x1 }))}</text></svg>`;
  return el;
}

function treeView(node) {
  const kids = node.c ?? [];
  const label = `${node.n}${node.a ? ` ${Object.entries(node.a).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}`;
  if (!kids.length) return h('div', { class: 'sar-leaf' }, h('span', { class: 'sar-k' }, label), node.t !== undefined ? h('span', { class: 'sar-v' }, ` ${node.t}`) : '');
  return h('details', {}, h('summary', {}, label), ...kids.map(treeView));
}

export function install(app) {
  const C = app.commands;
  const layer = () => app.activeLayer?.() ?? null;
  const cphdOf = (l) => (l?.info?.sar?.kind === 'CPHD' ? l.info.cphd ?? null : null);
  const toast = (m, o) => app.toast(m, o);

  /** CPHD summary rows (also the SAR Metadata card for a phase history). */
  function cphdRows(l) {
    const m = cphdOf(l);
    const ch = l.info.sar.channel;
    const g = m.geometry ?? {};
    const c = m.channels[ch.index];
    const chan = t('{id} of {n}', { id: c.id, n: m.channels.length });
    const size = t('{nv, plural, one {# vector} other {# vectors}} × {ns, plural, one {# sample} other {# samples}}', { nv: c.nv, ns: c.ns });
    return [
      [t('Format'), `CPHD ${m.version} (${m.namespace || t('no namespace')})`],
      [t('Collector'), `${m.collector || '–'}${m.coreName ? ` · ${m.coreName}` : ''}`],
      [t('Collect'), `${m.collectType || '–'} ${m.modeType || ''} · ${m.collectStart || '–'}`],
      [t('Domain / signal'), `${m.domain || '–'} · ${m.signalFormat}${ch.ampSF ? ' × AmpSF' : ''}`],
      [t('Channel'), `${chan}${ch.pol ? ` · ${ch.pol}` : ''} · ${size}`],
      [t('Band (Hz)'), `${f(m.fxMin, 0)} – ${f(m.fxMax, 0)}${Number.isFinite(c.fxC) ? ` · ${t('channel centre {fc}, bandwidth {bw}', { fc: f(c.fxC, 0), bw: f(c.fxBW, 0) })}` : ''}`],
      [t('Tx time (s)'), `${f(m.txTime1, 6)} – ${f(m.txTime2, 6)}`],
      [t('SRP (ECF m)'), m.srpEcf ? m.srpEcf.map((v) => f(v, 2)).join(', ') : '–'],
      [t('IARP lat, lon, HAE'), m.iarpLlh ? `${f(m.iarpLlh[0], 7)}, ${f(m.iarpLlh[1], 7)}, ${f(m.iarpLlh[2], 2)} ${t('m')}` : '–'],
      [t('Graze / incidence / azimuth (°)'), `${f(g.GrazeAngle, 2)} / ${f(g.IncidenceAngle, 2)} / ${f(g.AzimuthAngle, 2)}`],
      [t('Look side · slant range'), `${g.SideOfTrack === 'L' ? t('Left') : g.SideOfTrack === 'R' ? t('Right') : '–'} · ${f(g.SlantRange, 1)} ${t('m')}`],
      [t('PVP fields'), m.pvp.map((p) => p.name).join(', ')],
      [t('Support arrays'), m.supportArrays.length ? m.supportArrays.map((s) => `${s.id} (${s.kind || t('support')}, ${s.rows} × ${s.cols}, ${s.format || `${s.bpe} B`})`).join('; ') : t('none')],
      [t('Classification'), `${m.classification || '–'}${m.releaseInfo ? ` · ${m.releaseInfo}` : ''}`],
    ];
  }

  /** The collection geometry as a vector layer: image area corners, IARP, SRP and the ARP track. */
  function geometryLayer(d, file) {
    const m = d.res.meta.cphd;
    const feats = [];
    const iacp = m.iacp ?? [];
    if (iacp.length >= 3) {
      const ring = iacp.map(([la, lo]) => [lo, la, m.iarpLlh?.[2] ?? 0]);
      feats.push({ geom: fromParts('Polygon', [ring]), name: t('Image area'), attrs: { kind: 'image area', collector: m.collector, core: m.coreName } });
    }
    if (m.iarpLlh) feats.push({ geom: fromParts('Point', [[[m.iarpLlh[1], m.iarpLlh[0], m.iarpLlh[2]]]]), name: 'IARP', attrs: { kind: 'IARP' } });
    for (const r of d.res.rasters) {
      const tk = r.sar?.channel?.track;
      if (tk?.srp) feats.push({ geom: fromParts('Point', [[tk.srp]]), name: `SRP (${r.sar.channel.id})`, attrs: { kind: 'SRP', channel: r.sar.channel.id } });
      if (tk?.arp?.length >= 2) feats.push({ geom: fromParts('LineString', [tk.arp]), name: t('ARP track ({channel})', { channel: r.sar.channel.id }), attrs: { kind: 'ARP track', channel: r.sar.channel.id, vectors: r.sar.channel.nv, heightMinM: Math.min(...tk.arp.map((p) => p[2])), heightMaxM: Math.max(...tk.arp.map((p) => p[2])) } });
    }
    if (!feats.length || !app.addVectorLayer) return null;
    return app.addVectorLayer({ name: t('{file} — collection geometry', { file: file.name }), features: feats }, { format: 'CPHD geometry', file: file.name });
  }

  async function cphdPanel(l = layer()) {
    const m = cphdOf(l);
    if (!m) throw new Error('the active layer is not a CPHD phase history');
    const ch = l.info.sar.channel;
    const s = ch.series;
    const plots = [];
    const add = (title, names, unit) => {
      const ss = names.filter((n) => s[n]).map((n) => ({ label: n.endsWith('|h') ? t('{field} height', { field: n.slice(0, -2) }) : n, ys: s[n] }));
      const el = ss.length ? linePlot(title, s.vector, ss, { unit }) : null;
      if (el) plots.push(el);
    };
    add(N_('Time'), ['TxTime', 'RcvTime'], 's');
    add(N_('Positions'), ['TxPos|h', 'RcvPos|h', 'SRPPos|h'], 'm HAE');
    add(N_('Frequencies'), m.domain === 'TOA' ? ['TOA1', 'TOA2'] : ['FX1', 'FX2'], m.domain === 'TOA' ? 's' : 'Hz');
    add(N_('Sample coordinates'), ['SC0'], m.domain === 'TOA' ? 's' : 'Hz');
    add(N_('Sample spacing'), ['SCSS'], m.domain === 'TOA' ? 's' : 'Hz');
    add(N_('Amplitude scale and signal'), ['AmpSF', 'SIGNAL'], '');
    const card = h('table', { class: 'tbl', 'data-id': 'cphd-summary' }, h('tbody', {}, ...cphdRows(l).map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v)))));
    const sup = (m.supportPreview ?? []).map((p) => h('div', { class: 'hint' }, `${p.id}: ${p.skipped ? t('not previewed ({reason})', { reason: p.skipped }) : p.stats.map((x) => t('{name} {min} … {max} (mean {mean})', { name: x.name, min: f(x.min), max: f(x.max), mean: f(x.mean) })).join(', ')}`));
    const tree = m.tree ? h('div', { class: 'sar-tree', style: 'max-height:240px;overflow:auto;font:12px monospace' }, treeView(m.tree)) : '';
    const body = h(
      'div',
      { class: 'cphd-panel' },
      card,
      h('h4', {}, t('Per-vector parameters')),
      ...plots,
      sup.length ? h('h4', {}, t('Support arrays')) : '',
      ...sup,
      h('h4', {}, 'XML'), // i18n-ignore: format name
      tree,
    );
    const buttons = [{ label: t('Save Subset'), value: 'subset', primary: true }, { label: t('Close'), value: 'close' }];
    const r = await modal({ title: t('CPHD Phase History — {name}', { name: l.rec?.name ?? '' }), body, buttons, width: 620, id: 'cphd-panel', modeless: true });
    if (r === 'subset') await subsetDialog(l);
  }

  /** Save a CPHD subset (REQ-FMT-51): channels, a vector range and a sample range. */
  async function subset(l, { channels = null, v0 = 0, v1 = null, s0 = 0, s1 = null } = {}) {
    const m = cphdOf(l);
    if (!m) throw new Error('the active layer is not a CPHD phase history');
    const ids = channels ?? [l.info.sar.channel.index];
    const subs = ids.map((ch) => {
      const c = m.channels[ch];
      return { ch, v0: Math.max(0, Math.floor(v0)), v1: Math.min(c.nv, Math.floor(v1 ?? c.nv)), s0: Math.max(0, Math.floor(s0)), s1: Math.min(c.ns, Math.floor(s1 ?? c.ns)) };
    });
    for (const s of subs) if (!(s.v1 > s.v0 && s.s1 > s.s0)) throw new Error('the subset holds no vectors or no samples');
    const r = await app.pool.run('cphdSubset', { handle: l.handle, subs }, { affinity: l.affinity, label: t('CPHD subset {name}', { name: l.rec?.name ?? '' }), timeout: 600000 });
    const nm = `${(l.info.fileName ?? 'phase-history').replace(/\.cphd$/i, '')}_subset.cphd`;
    return { blob: r.blob, name: nm, subs };
  }

  async function subsetDialog(l = layer()) {
    const m = cphdOf(l);
    if (!m) throw new Error('the active layer is not a CPHD phase history');
    const c = m.channels[l.info.sar.channel.index];
    // The view's window is the default subset, when one is visible.
    const p = app.activePane?.();
    let box = null;
    try {
      const sz = p?.size?.();
      const q = sz ? [p.imagePoint(0, 0), p.imagePoint(sz.w, sz.h)] : null;
      if (q) box = { x0: Math.max(0, Math.floor(Math.min(q[0].x, q[1].x))), x1: Math.min(c.ns, Math.ceil(Math.max(q[0].x, q[1].x))), y0: Math.max(0, Math.floor(Math.min(q[0].y, q[1].y))), y1: Math.min(c.nv, Math.ceil(Math.max(q[0].y, q[1].y))) };
    } catch {
      box = null;
    }
    const numIn = (v, label) => h('input', { class: 'inp inp-num', type: 'number', min: '0', value: String(v), 'aria-label': label });
    const cv0 = numIn(box?.y0 ?? 0, t('First vector'));
    const cv1 = numIn(box?.y1 ?? c.nv, t('Last vector (exclusive)'));
    const cs0 = numIn(box?.x0 ?? 0, t('First sample'));
    const cs1 = numIn(box?.x1 ?? c.ns, t('Last sample (exclusive)'));
    const chk = m.channels.map((ch, i) => {
      const cb = h('input', { type: 'checkbox', 'aria-label': t('Channel {id}', { id: ch.id }) });
      cb.checked = i === l.info.sar.channel.index;
      return [cb, h('label', {}, cb, ` ${ch.id} (${ch.nv} × ${ch.ns})`)];
    });
    const body = h('div', {}, field(t('Channels'), h('div', {}, ...chk.map((x) => x[1]))), field(t('Vectors (from, to)'), h('span', { class: 'btn-row' }, cv0, cv1)), field(t('Samples (from, to)'), h('span', { class: 'btn-row' }, cs0, cs1), t('The same ranges for every channel; the support arrays are copied as they are')));
    const buttons = [{ label: t('OK'), value: 'ok', primary: true }, { label: t('Cancel'), value: 'cancel' }];
    if ((await modal({ title: t('Save CPHD Subset — {name}', { name: l.rec?.name ?? '' }), body, buttons, id: 'cphd-subset' })) !== 'ok') return null;
    const channels = chk.map((x, i) => (x[0].checked ? i : -1)).filter((i) => i >= 0);
    const r = await subset(l, { channels: channels.length ? channels : null, v0: +cv0.value, v1: +cv1.value, s0: +cs0.value, s1: +cs1.value });
    await saveBlob(app, r.blob, { name: r.name, types: ['.cphd'], description: t('CPHD phase history') });
    toast(t('{file}: {n, plural, one {# channel} other {# channels}}, {size} MB', { file: r.name, n: r.subs.length, size: num(r.blob.size / 1048576, 1) }), { kind: 'info' });
    return r;
  }

  // ---- UAVSAR (REQ-FMT-53) ----
  const UAVSAR_EXT = /\.(grd|mlc|slc|hgt|inc|slope|cor|unw|int|amp[12]?)$/i;

  /**
   * Pair each UAVSAR product with the dropped .ann that names it (or the only .ann, by its flight-line
   * stem); an .ann that names nothing dropped opens as the swath footprint with its annotation.
   * Returns the files left for the image readers.
   */
  async function pairUavsar(files) {
    const anns = files.filter((f) => /\.ann$/i.test(f.name));
    if (!anns.length) return files;
    const texts = await Promise.all(anns.map((a) => (a.size <= 4 << 20 ? a.text() : Promise.resolve(''))));
    const used = new Set();
    for (const f of files) {
      if (!UAVSAR_EXT.test(f.name)) continue;
      let k = texts.findIndex((t) => t.includes(f.name));
      if (k < 0 && anns.length === 1) {
        // UAVSAR names: <site>_<line>_<flight>_<seq>_<date>_<band><pol>_<…>; the annotation drops the pol.
        const stem = anns[0].name.replace(/\.ann$/i, '');
        if (f.name.replace(/(L|P|S|Ka)(\d{3})(HH|HV|VH|VV){1,2}/i, '$1$2').startsWith(stem)) k = 0;
      }
      if (k >= 0) {
        f.__ann = anns[k];
        used.add(k);
      }
    }
    for (const [k, a] of anns.entries()) {
      if (used.has(k)) continue;
      try {
        const s = await app.pool.run('uavsarAnn', { bytes: new Uint8Array(await a.arrayBuffer()) }, { label: t('annotation {file}', { file: a.name }) });
        const id = uavsarFootprint(a, s);
        app.importLog.push({ file: a.name, errors: [], warnings: [t('UAVSAR annotation: {n, plural, one {# product file} other {# product files}} named; open them together with {file} for their pixels', { n: Object.keys(s.files).length, file: a.name })] });
        toast(id ? t('{file}: UAVSAR {mode} swath footprint; open its .grd/.mlc/.slc files with it for the pixels', { file: a.name, mode: s.mode || '' }) : t('{file}: UAVSAR {mode} swath footprint (the annotation gives no corners); open its .grd/.mlc/.slc files with it for the pixels', { file: a.name, mode: s.mode || '' }), { kind: 'info' });
      } catch (e) {
        app.importLog.push({ file: a.name, errors: [msgOf(e)], warnings: [] });
        toast(t('{file}: {msg}', { file: a.name, msg: msgOf(e) }), { kind: 'error', ms: 8000 });
      }
    }
    return files.filter((f) => !anns.includes(f));
  }

  function uavsarFootprint(a, s) {
    if (!s.corners?.length || !app.addVectorLayer) return null;
    const ring = s.corners.map(([la, lo]) => [lo, la, 0]);
    const attrs = { site: s.site, mode: s.mode, start: s.start, stop: s.stop, look: s.look, wavelengthCm: s.wavelengthCm, products: Object.values(s.files).join(' ').slice(0, 2000), layers: Object.keys(s.layers).join(' ') };
    return app.addVectorLayer({ name: t('{file} — UAVSAR swath', { file: a.name }), features: [{ geom: fromParts('Polygon', [ring]), name: s.site || a.name, attrs }] }, { format: 'UAVSAR annotation', file: a.name });
  }

  function uavsarRows(l) {
    const u = l.info.meta?.uavsar;
    if (!u) return null;
    const p = u.product;
    return [
      [t('Format'), l.info.format],
      [t('Site'), u.site || '–'],
      [t('Acquisition'), `${u.mode || '–'} · ${u.start || '–'} – ${u.stop || '–'}`],
      [t('Layer'), `${p.key} (${p.layer}) · ${p.rows} × ${p.cols} · ${p.kind} ${p.valSize} B, ${p.littleEndian ? t('little-endian') : t('big-endian')}`],
      [t('Geometry'), p.proj === 'EQA' ? t('equiangular lat/lon grid, {dx}″ × {dy}″', { dx: f(p.geotransform?.[1] * 3600, 3), dy: f(-p.geotransform?.[5] * 3600, 3) }) : t('slant range (radar geometry, no map model)')],
      [t('Units'), p.units || '–'],
      [t('Look direction · wavelength'), `${u.look || '–'} · ${f(u.wavelengthCm, 3)} cm`],
      [tc('metadata file', 'Annotation'), u.annName],
    ];
  }

  // ---- Sentinel-1 SAFE (REQ-FMT-55) ----
  const S1_MEAS = /^s1[a-d]-[a-z0-9]+-(slc|grd[a-z]?)-[hv]{2}-.*\.tiff?$/i;
  const stemOf = (n) => n.replace(/\.[^.]+$/, '').toLowerCase();

  /**
   * A dropped SAFE product (the folder, its files, or what a ZIP gave): each measurement TIFF goes with
   * its annotation, calibration and noise XML and the manifest that lists it; the product's other files
   * (support schemas, previews, RFI reports) are not opened as layers of their own. A manifest whose
   * measurements were not dropped opens as the product footprint. Returns the files left to open.
   */
  async function pairSafe(files) {
    const meas = files.filter((f) => S1_MEAS.test(f.name));
    const manifests = files.filter((f) => /^manifest\.safe$/i.test(f.name));
    if (!meas.length && !manifests.length) return files;
    const xml = files.filter((f) => /\.xml$/i.test(f.name));
    const used = new Set();
    const mf = [];
    for (const m of manifests) {
      try {
        mf.push({ file: m, s: await app.pool.run('safeXml', { kind: 'manifest', bytes: new Uint8Array(await m.arrayBuffer()) }, { label: t('SAFE manifest {file}', { file: m.name }) }) });
      } catch (e) {
        used.add(m);
        app.importLog.push({ file: m.name, errors: [msgOf(e)], warnings: [] });
        toast(t('{file}: {msg}', { file: m.name, msg: msgOf(e) }), { kind: 'error', ms: 8000 });
      }
    }
    for (const f of meas) {
      const st = stemOf(f.name);
      const find = (pre) => xml.find((x) => stemOf(x.name) === `${pre}${st}`);
      const annotation = find('');
      if (!annotation) continue;
      const man = mf.find((m) => m.s.objects.some((o) => o.href.toLowerCase().endsWith(`/${f.name.toLowerCase()}`))) ?? (mf.length === 1 ? mf[0] : null);
      f.__s1 = { annotation, calibration: find('calibration-') ?? null, noise: find('noise-') ?? null, manifest: man?.file ?? null };
      for (const x of [annotation, f.__s1.calibration, f.__s1.noise, man?.file]) if (x) used.add(x);
    }
    // A manifest without its measurements: the footprint and what the product holds.
    for (const m of mf) {
      if (meas.some((f) => f.__s1?.manifest === m.file)) continue;
      used.add(m.file);
      const s = m.s;
      const ring = (s.footprint ?? []).map(([la, lo]) => [lo, la, 0]);
      const n = s.objects.filter((o) => o.kind === 'measurement').length;
      if (ring.length >= 3 && app.addVectorLayer) app.addVectorLayer({ name: t('{product} footprint', { product: `${s.mission} ${s.mode} ${s.productType}` }), features: [{ geom: fromParts('Polygon', [ring]), name: `${s.mission} ${s.mode} ${s.productType}`, attrs: { mission: s.mission, mode: s.mode, productType: s.productType, start: s.start, stop: s.stop, pass: s.pass, orbit: s.orbit, relativeOrbit: s.relativeOrbit, polarisations: s.polarisations.join(' '), swaths: s.swaths.join(' '), measurements: n } }] }, { format: 'Sentinel-1 SAFE manifest', file: m.file.name });
      app.importLog.push({ file: m.file.name, errors: [], warnings: [t('Sentinel-1 SAFE {product}: footprint opened; open the SAFE folder (or its measurement TIFFs with the annotation folder) for the {n, plural, one {# measurement image} other {# measurement images}}', { product: `${s.mission} ${s.mode} ${s.productType}`, n })] });
      toast(t('{file}: Sentinel-1 {product} footprint ({n, plural, one {# measurement} other {# measurements}}, {pols}); open the SAFE folder for the images', { file: m.file.name, product: `${s.mode} ${s.productType}`, n, pols: s.polarisations.join('+') }), { kind: 'info' });
    }
    // The product's own support files are part of it, not layers.
    const paired = meas.some((m) => m.__s1);
    const part = (f) => used.has(f) || (paired && (/\.xsd$/i.test(f.name) || /\.SAFE-report-[^/]*\.pdf$/i.test(f.name) || /^(rfi-|calibration-|noise-)?s1[a-d]-.*\.xml$/i.test(f.name) || /^(quick-look\.png|map-overlay\.kml|product-preview\.html|logo\.png)$/i.test(f.name)));
    const n = meas.filter((m) => m.__s1).length;
    if (n) app.importLog.push({ file: meas.find((m) => m.__s1).__s1.manifest?.name ?? 'SAFE', errors: [], warnings: [t('Sentinel-1 SAFE: {n, plural, one {# measurement} other {# measurements}} opened as one product with their annotation, calibration and noise; {k, plural, one {# support file} other {# support files}} read with them', { n, k: files.filter(part).length })] });
    return files.filter((f) => !part(f));
  }

  const safeSeen = new Set();
  /** Burst outlines of a swath from its annotation (geolocation grid rows at the burst boundaries). */
  function burstLayer(l, a, name) {
    const g = a.grid;
    if (!g?.regular || !a.bursts?.length || !app.addVectorLayer) return null;
    const P = g.pixels.length;
    // The grid row at a line (TOPS grids have one per burst boundary), else the next one down.
    const rowAt = (line) => {
      const r = g.lines.findIndex((x) => x >= line);
      return r < 0 ? g.lines.length - 1 : r;
    };
    const feats = a.bursts.map((b, k) => {
      const r0 = rowAt(b.firstLine);
      const r1 = rowAt(b.firstLine + b.lines - 1);
      const top = Array.from({ length: P }, (_, i) => [g.lon[r0 * P + i], g.lat[r0 * P + i], g.height[r0 * P + i]]);
      const bot = Array.from({ length: P }, (_, i) => [g.lon[r1 * P + i], g.lat[r1 * P + i], g.height[r1 * P + i]]).reverse();
      return { geom: fromParts('Polygon', [[...top, ...bot]]), name: t('{swath} burst {n}', { swath: a.swath, n: k + 1 }), attrs: { swath: a.swath, burst: k + 1, burstId: b.burstId, azimuthTime: b.azimuthTime, firstLine: b.firstLine, lines: b.lines, validLines: b.validLines?.join('–') ?? '', validSamples: b.validSamples?.join('–') ?? '' } };
    });
    return app.addVectorLayer({ name, features: feats }, { format: 'Sentinel-1 SAFE bursts', file: l.info.fileName });
  }

  function safeRows(l) {
    const s = l.info.meta?.s1;
    if (!s) return null;
    const a = s.annotation;
    const m = s.manifest;
    const r = l.info.sar?.radiometry;
    return [
      [t('Format'), l.info.format],
      [t('Product'), m ? t('{product} · {pass} · orbit {orbit} (relative {rel})', { product: `${m.mission} ${m.mode} ${m.productType}`, pass: m.pass, orbit: String(m.orbit), rel: String(m.relativeOrbit) }) : `${a.missionId} ${a.mode} ${a.productType}`],
      [t('Swath / polarisation'), m ? t('{swath} of {swaths} × {pols}', { swath: `${a.swath} ${a.polarisation}`, swaths: m.swaths.join(', '), pols: m.polarisations.join(', ') }) : `${a.swath} ${a.polarisation}`],
      [t('Time'), `${a.startTime} – ${a.stopTime}`],
      [t('Size · spacing'), t('{w} × {h} · range {rs} m, azimuth {as} m', { w: a.samples, h: a.lines, rs: f(a.rangeSpacing), as: f(a.azimuthSpacing) })],
      [t('Bursts'), a.bursts.length ? t('{n} × {lines, plural, one {# line} other {# lines}}', { n: a.bursts.length, lines: a.linesPerBurst }) : t('none (stripmap or GRD)')],
      [t('Geolocation grid'), a.grid.regular ? t('{rows} × {cols} points (model)', { rows: a.grid.lines.length, cols: a.grid.pixels.length }) : t('{n, plural, one {# point} other {# points}} (irregular)', { n: a.grid.count })],
      [t('Incidence (mid swath)'), `${f(a.incidenceMid, 2)}°`],
      [t('Radiometry'), r?.reason ? t('none — {reason}', { reason: r.reason }) : r?.note ?? (s.files.calibration ? t('calibration read') : t('no calibration XML given'))],
      [t('Annotation files'), [s.files.annotation, s.files.calibration, s.files.noise].filter(Boolean).join(', ')],
    ];
  }

  /** Summary rows of a 2.1 SAR layer for the SAR Metadata card, or null. */
  function rows(l) {
    const k = l?.info?.sar?.kind;
    if (k === 'CPHD') return cphdRows(l);
    if (k === 'UAVSAR') return uavsarRows(l);
    if (k === 'Sentinel-1') return safeRows(l);
    return null;
  }

  function onOpen(d, layers, file) {
    if (d.res.meta?.s1) {
      const a = d.res.meta.s1.annotation;
      const key = `${a.missionId}|${a.startTime}|${a.swath}`;
      const l = layers[0];
      if (l && !safeSeen.has(key)) {
        safeSeen.add(key);
        try {
          burstLayer(l, a, t('{swath} bursts ({start})', { swath: `${a.missionId} ${a.mode} ${a.swath}`, start: a.startTime.slice(0, 19) }));
        } catch (e) {
          d.report.warnings.push(t('Sentinel-1 bursts: {msg}', { msg: msgOf(e) }));
        }
      } else if (l) {
        // The other polarisation of a swath already shown opens hidden (the same footprint).
        app.store.transact(t('Hide second polarisation'), (tx) => tx.set(l.id, 'visible', false), { kind: 'load' });
      }
    }
    if (d.kind === 'cphd') {
      try {
        geometryLayer(d, file);
      } catch (e) {
        d.report.warnings.push(t('CPHD collection geometry: {msg}', { msg: msgOf(e) }));
      }
      d.report.warnings.push(t('CPHD is a phase history, not an image: the view shows the signal array (vectors down, samples across)'));
    }
  }

  app.sar21 = { onOpen, rows, cphdRows, uavsarRows, safeRows, cphdPanel, subset, subsetDialog, geometryLayer, pairUavsar, pairSafe };
  const hasCphd = () => !!cphdOf(layer());
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      toast(msgOf(e), { kind: 'error', ms: 8000 });
    }
  };
  C.implement('sar.cphd', { enabled: hasCphd, run: run(() => cphdPanel()) });
  C.implement('sar.cphdsubset', { enabled: hasCphd, run: run(() => subsetDialog()) });
}
