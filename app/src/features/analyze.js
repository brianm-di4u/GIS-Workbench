// Image Tools ▸ Analyze: band statistics (REQ-MSI-07) and the Pixel Matrix Viewer
// (REQ-IMG-21) — raw DN values around the cursor for every band, read at full resolution
// from the decoder (never from display textures).

import { h, clear } from '../shell/dom.js';
import { modal } from '../shell/dialogs.js';
import { histBinValue, histMeanStd, histPercentile } from '../render/chain.js';
import { t } from '../i18n/index.js';
import { num, numMax, int } from '../i18n/format.js';

export const name = 'analyze';

export function install(app) {
  const C = app.commands;
  const layer = () => app.activeLayer();

  C.implement('bands.stats', {
    enabled: () => !!layer()?.handle,
    run: async () => {
      const l = layer();
      const bands = Array.from({ length: l.bands }, (_, i) => i);
      const s = await app.pool.run('stats', { handle: l.handle, bands }, { affinity: l.affinity, label: t('band statistics {layer}', { layer: l.rec?.name ?? '' }), timeout: 300000 });
      const rows = s.bands.map((hst, i) => {
        if (!hst?.count) return h('tr', {}, h('td', {}, String(i + 1)), h('td', { colspan: '7' }, t('no valid pixels')));
        const first = hst.bins.findIndex((x) => x > 0);
        let last = hst.bins.length - 1;
        while (last > 0 && !hst.bins[last]) last--;
        const { mean, std } = histMeanStd(hst);
        const b = l.info.subheader?.bands?.[i];
        const f = (v) => (Math.abs(v) >= 1000 || Number.isInteger(v) ? num(v, 0) : num(v, 3));
        return h('tr', {}, [String(i + 1), `${b?.IREPBAND ?? ''} ${b?.ISUBCAT ?? ''}`.trim() || '—', f(histBinValue(hst, first)), f(histBinValue(hst, last)), f(mean), f(std), f(histPercentile(hst, 0.5)), int(hst.count)].map((x) => h('td', {}, x)));
      });
      const body = h('div', {}, h('table', { class: 'grid-table', 'aria-label': t('Band statistics') }, h('thead', {}, h('tr', {}, [t('Band'), t('Role'), t('Min'), t('Max'), t('Mean'), t('Std dev'), t('Median'), t('Samples')].map((x) => h('th', {}, x)))), h('tbody', {}, rows)), h('p', { class: 'hint' }, t('Computed from the full image (or the pyramid level nearest 1024²) by the decode worker; no-data pixels are excluded.')));
      await modal({ title: t('Band Statistics — {layer}', { layer: l.rec?.name ?? '' }), body, buttons: [{ label: t('Close'), value: 'close', primary: true }], width: 640, id: 'band-stats' });
    },
  });

  let open = null;
  C.implement('display.pixels', {
    enabled: () => !!layer()?.handle,
    checked: () => !!open,
    run: () => {
      if (open) return open.focus();
      const N = 5;
      const host = h('div', { class: 'pixel-matrix', tabindex: '-1', 'aria-live': 'off' });
      const caption = h('div', { class: 'hint' }, t('Move the cursor over an image.'));
      let busy = false;
      let next = null;
      const show = async ({ pane, x, y }) => {
        const l = pane?.layers?.().find((q) => q.handle && q.rec?.visible !== false) ?? layer();
        if (!l?.handle || !Number.isFinite(x)) return;
        if (busy) return void (next = { pane, x, y });
        busy = true;
        try {
          const bands = Array.from({ length: Math.min(l.bands, 8) }, (_, i) => i);
          const cx = Math.floor(x);
          const cy = Math.floor(y);
          const r = await app.pool.run('pixels', { handle: l.handle, x: cx - (N >> 1), y: cy - (N >> 1), w: N, h: N, bands }, { affinity: l.affinity, priority: 'high', label: t('pixel matrix') });
          clear(host);
          caption.textContent = t('{layer} · centre column {x}, row {y} (full resolution, raw DN)', { layer: l.rec?.name ?? '', x: String(cx), y: String(cy) });
          for (const [k, vals] of r.values.entries()) {
            const tbl = h('table', { class: 'grid-table pm-table', 'aria-label': t('Band {n} values', { n: String(k + 1) }) });
            for (let j = 0; j < r.h; j++) {
              const row = h('tr');
              for (let i = 0; i < r.w; i++) {
                const v = vals[j * r.w + i];
                const centre = r.x0 + i === cx && r.y0 + j === cy;
                // Raw DN: integers as they are; floats to 5 significant digits in the locale's notation.
                row.appendChild(h('td', { class: centre ? 'pm-centre' : null }, Number.isInteger(v) ? String(v) : numMax(Number(Number(v).toPrecision(5)), 20)));
              }
              tbl.appendChild(row);
            }
            host.appendChild(h('div', { class: 'pm-band' }, h('b', {}, t('Band {n}', { n: String(k + 1) })), tbl));
          }
        } catch {
          /* cursor left the image */
        } finally {
          busy = false;
          if (next) {
            const n = next;
            next = null;
            show(n);
          }
        }
      };
      const off = app.on('cursor', show);
      const p = modal({ title: t('Pixel Matrix Viewer'), body: h('div', {}, caption, host), buttons: [{ label: t('Close'), value: 'close', primary: true }], width: 420, modeless: true, id: 'pixel-matrix' });
      open = host;
      app.emit('state');
      p.then(() => {
        off();
        open = null;
        app.emit('state');
      });
    },
  });
}
