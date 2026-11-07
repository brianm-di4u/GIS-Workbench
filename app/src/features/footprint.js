// MrSID and ECW footprints (FC-01, FC-02, REQ-FMT-22): a file whose pixels have no open decoder
// opens at once as a footprint — the hatched placeholder raster (workers/decode/mrsid-header.js) placed
// by the container's georeferencing, its outline as a polygon layer with the file's facts as
// attributes, and a metadata panel. "Convert with Sidecar" runs the sidecar command `sidecar.convert`
// ({files, profile: 'raster-cog', reason}); without a sidecar it says how to get one (REQ-FMT-56).

import { readGeoJSON } from '../vector/io.js';
import { modal } from '../shell/dialogs.js';
import { h } from '../shell/dom.js';
import { t, tr, N_ } from '../i18n/index.js';
import { int } from '../i18n/format.js';

export const name = 'footprint';
export const SIDECAR_RELEASES = 'https://github.com/brianm-di4u/GIS-Workbench/releases';

const fmtInt = (v) => Number(v).toLocaleString('en-US');

/**
 * The facts shown in the panel and stored on the polygon: [label, value]. The stored facts stay
 * English (their labels become the attribute names); { display: true } gives them in the UI
 * language with locale digits, for the panel.
 */
export function footprintFacts(fp, layer, { display = false } = {}) {
  const L = display ? tr : (x) => x;
  const n = display ? int : fmtInt;
  const g = fp.georef;
  const model = layer?.modelName ?? null;
  const res = g && g.gt[1] ? `${Math.abs(g.gt[1]).toPrecision(6)} × ${Math.abs(g.gt[5]).toPrecision(6)}${g.epsg === 4326 ? '°' : ` ${L(N_('(CRS units)'))}`}` : '—';
  const crs = g?.epsg ? `EPSG:${g.epsg}` : g?.wkt ? (/(?:PROJCS|GEOGCS|PROJCRS|GEOGCRS)\s*\[\s*"([^"]+)"/.exec(g.wkt)?.[1] ?? g.wkt.slice(0, 80)) : '—';
  return [
    [L(N_('Format')), fp.version],
    [L(N_('Size')), display ? t('{w} × {h} px', { w: n(fp.width), h: n(fp.height) }) : `${n(fp.width)} × ${n(fp.height)} px`],
    [L(N_('Bands')), display ? t('{n} × {bits}-bit', { n: fp.bands, bits: fp.bits }) : `${fp.bands} × ${fp.bits}-bit`],
    [L(N_('CRS')), crs],
    [L(N_('Resolution')), res],
    [L(N_('Georeferencing')), g?.source ?? L(N_('none in the container'))],
    [L(N_('Placed by')), model ?? L(N_('not placed (no usable georeferencing)'))],
    ...(fp.meta ?? []).map(([k, v]) => [k, String(v)]),
  ];
}

export function install(app) {
  const reasonOf = (l) => (l.info.footprint?.format === 'ECW' ? 'ECW' : 'MrSID');
  const fileOf = (l) => app.files?.get(l.rec?.file)?.file ?? null;

  /** Convert with Sidecar: the sidecar's command when it is there, else how to install one. */
  async function convert(l) {
    const reason = reasonOf(l);
    const file = fileOf(l);
    const cmd = app.commands.get('sidecar.convert');
    if (cmd?.run) return app.commands.run('sidecar.convert', { files: file ? [file] : [], profile: 'raster-cog', reason });
    const link = h('a', { href: SIDECAR_RELEASES, target: '_blank', rel: 'noopener' }, SIDECAR_RELEASES);
    const body = h(
      'div',
      { class: 'dlg-msg' },
      h('p', {}, t('{format} pixels are a proprietary wavelet codestream with no open decoder, so the browser shows the footprint and metadata only.', { format: reason })),
      h('p', {}, t('The GIS Workbench sidecar (a small local helper with GDAL; its Windows build adds the vendor plug-in, which exists for Windows only) converts it to a Cloud-Optimized GeoTIFF beside the file and opens that in place.')),
      h('p', {}, t('Download it from the release page:'), ' ', link),
    );
    await modal({ title: t('Install the GIS Workbench sidecar'), body, buttons: [{ label: t('Close'), value: 'close', primary: true }], width: 560, id: 'sidecar-install' });
  }

  /** View with Sidecar (REQ-GAP-70): the pixels by tiles, nothing converted. */
  const view = (l) => {
    const e = app.files?.get(l.rec?.file);
    return app.commands.run('sidecar.view', { files: e?.file ? [e.file, ...(e.sidecars ?? [])] : [], reason: reasonOf(l) });
  };

  /** Metadata panel of a footprint layer, with the Convert with Sidecar action. */
  async function panel(l) {
    const fp = l.info.footprint;
    const rows = footprintFacts(fp, l, { display: true });
    const body = h('div', {}, h('table', { class: 'grid-table' }, h('tbody', {}, rows.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v))))), h('p', { class: 'hint' }, t("{format} pixels are not decoded in the browser; the hatched area is the file's footprint.", { format: reasonOf(l) })));
    const r = await modal({ title: t('Footprint — {name}', { name: l.rec?.name ?? '' }), body, buttons: [{ label: t('Convert with Sidecar'), value: 'convert', primary: true }, { label: t('View with Sidecar'), value: 'view' }, { label: t('Close'), value: 'close' }], width: 640, id: 'footprint-panel' });
    if (r === 'convert') await convert(l);
    if (r === 'view') await view(l);
  }

  /** After a footprint opens: its outline as a polygon layer, and the convert action. */
  function opened(layers, file) {
    for (const l of layers) {
      const fp = l.info.footprint;
      if (!fp) continue;
      if (l.modelId && app.addVectorLayer) {
        const ring = [];
        const W = l.width;
        const H = l.height;
        const N = 8;
        const edge = (x0, y0, x1, y1) => {
          for (let i = 0; i < N; i++) ring.push([x0 + ((x1 - x0) * i) / N, y0 + ((y1 - y0) * i) / N]);
        };
        edge(0, 0, W, 0);
        edge(W, 0, W, H);
        edge(W, H, 0, H);
        edge(0, H, 0, 0);
        try {
          const pts = ring.map(([x, y]) => l.groundAt(x, y, 0)).map((g) => [g.lon, g.lat]);
          if (pts.every(([lo, la]) => Number.isFinite(lo) && Number.isFinite(la))) {
            pts.push(pts[0]);
            const props = Object.fromEntries(footprintFacts(fp, l).map(([k, v]) => [k.toLowerCase().replace(/[^a-z0-9]+/g, '_'), v]));
            props.file = file?.name ?? l.rec?.name ?? '';
            const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [pts] }, properties: props }] };
            app.addVectorLayer(readGeoJSON(fc, { name: file?.name ? t('{file} footprint', { file: file.name }) : t('footprint') }).layer, { format: `${reasonOf(l)} footprint`, file: file?.name ?? '' });
          }
        } catch (e) {
          app.log?.('warn', `${file?.name}: footprint outline not drawn: ${e.message}`);
        }
      }
      app.toast(t('{file}: {format}, {w} × {h} px — footprint and metadata only; pixels through the sidecar.', { file: file?.name ?? t('File'), format: fp.version, w: int(fp.width), h: int(fp.height) }), { kind: 'info', ms: 9000, action: { label: t('Convert with Sidecar'), run: () => convert(l) } });
      if (app.sidecar?.decodes?.(reasonOf(l))) app.toast(t('{file}: the sidecar can show its pixels by tiles, with nothing converted.', { file: file?.name ?? t('File') }), { kind: 'info', ms: 9000, action: { label: t('View with Sidecar'), run: () => view(l) } });
    }
  }

  app.footprints = { opened, panel, convert, view, facts: footprintFacts };
}
