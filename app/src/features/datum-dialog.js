// Georeference ▸ Datum Transform (REQ-GAP-16, SDP-2.3 GR-05), the dialog: points between frames,
// grid datums and vertical systems, with the operations, grids and accuracy it used. This module
// is the lazy js-geod block (lazy/geod.lazy.js); features/datum-grids.js keeps the grid engine,
// the grid packs, the geoid hooks and app.datumTransform eager (CRS routes and heights need them
// as soon as a pack loads) and loads this the first time the command runs.

import { h, clear, copyText } from '../shell/dom.js';
import { modal, field, section } from '../shell/dialogs.js';
import { t, N_, tr, msgOf, gwError } from '../i18n/index.js';
import { num } from '../i18n/format.js';

/** Vertical systems offered in the dialog: [key, label]. Datum names are not translated (DN-62 rule 7). */
const HEIGHTS = [
  ['hae', N_('Ellipsoidal height (h)')],
  ['navd88', N_('NAVD88 height (GEOID18)')],
  ['odn', N_('ODN height (OSGM15)')],
  ['ahd', N_('AHD height (AUSGeoid2020)')],
  ['cgvd2013', N_('CGVD2013 height (CGG2013a)')],
  ['egm2008', N_('EGM2008 height (2.5′ grid)')],
];

/** Implement geo.transform for features/datum-grids.js: ctx = {grids, transform} and the geo/grids.js tables it shows (passed, so the block carries no copy). */
export function installDatumDialog(app, ctx) {
  const C = app.commands;
  const { grids, transform, ROUTES, VERTICALS, WGS84_NOW, parsePoints } = ctx;
  C.implement('geo.transform', {
    run: async () => {
      await grids.ensure();
      const frames = grids.bundle.frames().map((f) => f.name);
      const datums = Object.keys(ROUTES);
      const systems = () => [
        ...frames.map((f) => ({ value: f, text: f })),
        ...datums.map((d) => ({
          value: `grid:${d}`,
          text: grids.chainsOf(d).some((c) => c.grids.length) ? t('{datum} (through grids)', { datum: d }) : t('{datum} (needs a grid pack)', { datum: d }),
          disabled: !grids.chainsOf(d).length,
        })),
      ];
      const sel = (opts, value, label) => {
        const s = h(
          'select',
          { class: 'inp', 'aria-label': label },
          opts.map((o) => h('option', { value: o.value, disabled: !!o.disabled }, o.text)),
        );
        s.value = value;
        return s;
      };
      const heightOpts = () =>
        HEIGHTS.map(([k, l]) => ({
          value: k,
          text: tr(l),
          disabled: k !== 'hae' && !grids.has(VERTICALS[k].grid),
        }));
      const srcSel = sel(systems(), WGS84_NOW, t('Source system'));
      const tgtSel = sel(systems(), 'ITRF2014', t('Target system'));
      const srcH = sel(heightOpts(), 'hae', t('Source heights'));
      const tgtH = sel(heightOpts(), 'hae', t('Target heights'));
      const epochIn = h('input', {
        class: 'inp inp-short',
        type: 'number',
        step: '0.01',
        min: '1980',
        max: '2100',
        value: grids.epoch.toFixed(2),
        'aria-label': t('Coordinate epoch (decimal year)'),
      });
      const cg = app.cursorGround;
      const ptsIn = h(
        'textarea',
        {
          class: 'inp mono',
          rows: 4,
          spellcheck: 'false',
          'aria-label': t('Points: latitude, longitude, height per line'),
          'data-id': 'datum-points',
        },
        cg ? `${cg.lat.toFixed(8)} ${cg.lon.toFixed(8)} ${(cg.h ?? 0).toFixed(3)}` : '51.4778 -0.0014 45.0',
      );
      const table = h('table', {
        class: 'grid-table',
        'data-id': 'datum-results',
      });
      const report = h('div', {
        'data-id': 'datum-report',
        role: 'status',
        'aria-live': 'polite',
      });
      let last = null;
      const update = async () => {
        clear(table);
        clear(report);
        last = null;
        try {
          const pts = parsePoints(ptsIn.value);
          const epoch = Number(epochIn.value);
          if (!Number.isFinite(epoch) || epoch < 1980 || epoch > 2100) throw gwError('The epoch must be a decimal year between 1980 and 2100', null, 'E_DATUM_EPOCH');
          const r = await transform({
            src: srcSel.value,
            tgt: tgtSel.value,
            srcHeight: srcH.value,
            tgtHeight: tgtH.value,
            epoch,
            pts,
          });
          last = r;
          table.appendChild(h('tr', {}, h('th', {}, t('Latitude')), h('th', {}, t('Longitude')), h('th', {}, t('Height')), h('th', {}, t('Moved'))));
          r.pts.forEach((p, i) => {
            const q = pts[i];
            const moved = Number.isFinite(p[0]) ? Math.hypot((p[1] - q[1]) * 111_320, (p[0] - q[0]) * 111_320 * Math.cos((q[1] * Math.PI) / 180)) : NaN;
            table.appendChild(
              Number.isFinite(p[0])
                ? h('tr', {}, h('td', { class: 'mono' }, num(p[1], 9)), h('td', { class: 'mono' }, num(p[0], 9)), h('td', { class: 'mono' }, t('{v} m', { v: num(p[2], 4) })), h('td', { class: 'mono' }, t('{v} m', { v: num(moved, 3) })))
                : h('tr', {}, h('td', { class: 'err', colspan: 4 }, t('Point {n}: outside the grids or on nodata — no result', { n: i + 1 }))),
            );
          });
          const items = r.steps.map((s) => {
            const acc = Number.isFinite(s.accuracy) ? t('{v} m', { v: num(s.accuracy, 3) }) : t('accuracy unknown');
            const p = {
              code: String(s.epsg),
              name: s.name,
              grid: s.grid,
              op: s.op,
              interp: s.interpolation,
              acc,
            };
            if (s.kind === 'grid') return h('li', {}, s.inverse ? t('Inverse of EPSG:{code} {name}: grid {grid} ({op}, {interp}), {acc}', p) : t('EPSG:{code} {name}: grid {grid} ({op}, {interp}), {acc}', p));
            if (s.kind === 'frame') {
              if (s.timeDependent) return h('li', {}, s.inverse ? t('Inverse of EPSG:{code} {name}: time-dependent Helmert, {acc}', p) : t('EPSG:{code} {name}: time-dependent Helmert, {acc}', p));
              return h('li', {}, s.inverse ? t('Inverse of EPSG:{code} {name}: Helmert, {acc}', p) : t('EPSG:{code} {name}: Helmert, {acc}', p));
            }
            return h('li', {}, t('{name}, {acc}', { name: s.name, acc }));
          });
          report.append(
            ...[
              h('p', {}, r.steps.length ? t('Transformation used ({n, plural, one {# step} other {# steps}}):', { n: r.steps.length }) : t('Same system: no transformation.')),
              h('ol', {}, ...items),
              h('p', { 'data-id': 'datum-accuracy' }, Number.isFinite(r.accuracy) ? t('Accuracy: about {v} m (EPSG accuracies of the steps, summed).', { v: num(r.accuracy, 3) }) : t('Accuracy: unknown for at least one step.')),
              r.epoch
                ? h(
                    'p',
                    {},
                    t('Time-dependent steps evaluated at epoch {epoch}.', {
                      epoch: num(r.epoch, 2),
                    }),
                  )
                : null,
              r.outside ? h('p', { class: 'err' }, t('{n, plural, one {# point is} other {# points are}} outside the grids or on nodata.', { n: r.outside })) : null,
            ].filter(Boolean),
          );
        } catch (e) {
          report.appendChild(h('p', { class: 'err' }, msgOf(e)));
        }
      };
      for (const el of [srcSel, tgtSel, srcH, tgtH, epochIn, ptsIn]) el.addEventListener(el === ptsIn || el === epochIn ? 'input' : 'change', update);
      const loaded = [...grids.catalogue.values()].filter((g) => !g.user).length;
      // Copy sits in the body (one footer button keeps the WCAG 2.2 target spacing).
      const copyBtn = h('button', { class: 'btn', type: 'button', 'data-id': 'datum-copy' }, t('Copy Results'));
      copyBtn.addEventListener('click', async () => {
        if (!last) return;
        const lines = last.pts.map((p) => (Number.isFinite(p[0]) ? `${p[1].toFixed(9)} ${p[0].toFixed(9)} ${p[2].toFixed(4)}` : 'NaN NaN NaN'));
        await copyText([...lines, `# ${last.steps.map((s) => `${s.inverse ? 'inv ' : ''}EPSG:${s.epsg ?? '-'}${s.grid ? ` (${s.grid})` : ''}`).join(' + ')}; accuracy ${last.accuracy.toFixed(3)} m${last.epoch ? `; epoch ${last.epoch.toFixed(2)}` : ''}`].join('\n'));
        app.toast(t('Copied {n, plural, one {# point} other {# points}}', { n: lines.length }), { kind: 'info' });
      });
      const body = h(
        'div',
        { 'data-id': 'datum-transform' },
        field(t('Source system'), srcSel),
        field(t('Source heights'), srcH),
        field(t('Target system'), tgtSel),
        field(t('Target heights'), tgtH),
        field(t('Coordinate epoch (decimal year)'), epochIn, t('Time-dependent frames (ITRF, WGS 84 realisations, NAD83(2011), GDA2020, ETRF) are related at this epoch.')),
        field(t('Points: latitude, longitude, height per line'), ptsIn),
        table,
        h('p', {}, copyBtn),
        section(t('Transformation and accuracy'), report),
        h('p', { class: 'hint' }, loaded ? t('{n, plural, one {# grid} other {# grids}} loaded from data packs.', { n: loaded }) : t('No grid pack loaded: frames only. Open grids-na, grids-eu, grids-oceania or geoid-egm2008-25 with File ▸ Open ▸ Open Data Pack.')),
      );
      update();
      await modal({ title: t('Datum Transform'), body, buttons: [{ label: t('Close'), value: 'close', primary: true }], width: 720, id: 'datum-transform' });
    },
  });
}
