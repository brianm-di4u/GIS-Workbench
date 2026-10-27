// Image Tools ▸ Analyze: band statistics (REQ-MSI-07) and the Pixel Matrix Viewer
// (REQ-IMG-21) — raw DN values around the cursor for every band, read at full resolution
// from the decoder (never from display textures).

import { h, clear } from '../shell/dom.js';
import { modal } from '../shell/dialogs.js';
import { histBinValue, histMeanStd, histPercentile } from '../render/chain.js';

export const name = 'analyze';

export function install(app) {
  const C = app.commands;
  const layer = () => app.activeLayer();

  C.implement('bands.stats', {
    enabled: () => !!layer()?.handle,
    run: async () => {
      const l = layer();
      const bands = Array.from({ length: l.bands }, (_, i) => i);
      const s = await app.pool.run('stats', { handle: l.handle, bands }, { affinity: l.affinity, label: `band statistics ${l.rec?.name}`, timeout: 300000 });
      const rows = s.bands.map((hst, i) => {
        if (!hst?.count) return h('tr', {}, h('td', {}, String(i + 1)), h('td', { colspan: '7' }, 'no valid pixels'));
        const first = hst.bins.findIndex((x) => x > 0);
        let last = hst.bins.length - 1;
        while (last > 0 && !hst.bins[last]) last--;
        const { mean, std } = histMeanStd(hst);
        const b = l.info.subheader?.bands?.[i];
        const f = (v) => (Math.abs(v) >= 1000 || Number.isInteger(v) ? v.toFixed(0) : v.toFixed(3));
        return h('tr', {}, [String(i + 1), `${b?.IREPBAND ?? ''} ${b?.ISUBCAT ?? ''}`.trim() || '—', f(histBinValue(hst, first)), f(histBinValue(hst, last)), f(mean), f(std), f(histPercentile(hst, 0.5)), hst.count.toLocaleString()].map((x) => h('td', {}, x)));
      });
      const body = h('div', {}, h('table', { class: 'grid-table', 'aria-label': 'Band statistics' }, h('thead', {}, h('tr', {}, ['Band', 'Role', 'Min', 'Max', 'Mean', 'Std dev', 'Median', 'Samples'].map((x) => h('th', {}, x)))), h('tbody', {}, rows)), h('p', { class: 'hint' }, 'Computed from the full image (or the pyramid level nearest 1024²) by the decode worker; no-data pixels are excluded.'));
      await modal({ title: `Band Statistics — ${l.rec?.name ?? ''}`, body, buttons: ['Close'], width: 640, id: 'band-stats' });
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
      const caption = h('div', { class: 'hint' }, 'Move the cursor over an image.');
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
          const r = await app.pool.run('pixels', { handle: l.handle, x: cx - (N >> 1), y: cy - (N >> 1), w: N, h: N, bands }, { affinity: l.affinity, priority: 'high', label: 'pixel matrix' });
          clear(host);
          caption.textContent = `${l.rec?.name ?? ''} · centre column ${cx}, row ${cy} (full resolution, raw DN)`;
          for (const [k, vals] of r.values.entries()) {
            const t = h('table', { class: 'grid-table pm-table', 'aria-label': `Band ${k + 1} values` });
            for (let j = 0; j < r.h; j++) {
              const tr = h('tr');
              for (let i = 0; i < r.w; i++) {
                const v = vals[j * r.w + i];
                const centre = r.x0 + i === cx && r.y0 + j === cy;
                tr.appendChild(h('td', { class: centre ? 'pm-centre' : null }, Number.isInteger(v) ? String(v) : Number(v).toPrecision(5)));
              }
              t.appendChild(tr);
            }
            host.appendChild(h('div', { class: 'pm-band' }, h('b', {}, `Band ${k + 1}`), t));
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
      const p = modal({ title: 'Pixel Matrix Viewer', body: h('div', {}, caption, host), buttons: ['Close'], width: 420, modeless: true, id: 'pixel-matrix' });
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
