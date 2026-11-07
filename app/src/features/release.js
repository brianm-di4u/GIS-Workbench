// Release hygiene (REQ-SEC-11): a provenance and redaction notice whenever a product that carries
// metadata is exported, and an Image Splitter / Redaction tool that blacks out areas of a chip,
// crops it to a part (the split), and writes pixels only — no record, world file, tags or headers.

import { h } from '../shell/dom.js';
import { modal } from '../shell/dialogs.js';
import { saveBlob, saveStream } from '../storage/files.js';
import { t, N_, gwError, msgOf } from '../i18n/index.js';

export const name = 'release';

const META = {
  png: N_('a JSON record (image, sensor model, centre, analyst) and a world file with a .prj'),
  jpeg: N_('a JSON record and a world file with a .prj'),
  'tif-display': N_('GeoTIFF tags (GCPs, CRS)'),
  'tif-source': N_('GeoTIFF tags (GCPs, CRS) and the source samples'),
  'nitf-source': N_('NITF headers (IID, dates), RPC00B and ICHIPB TREs'),
};

/** Black out boxes and crop: returns a new canvas (pixels only). */
export function redactCanvas(src, { boxes = [], crop = null, fill = '#000000' } = {}) {
  const [cx, cy, cw, ch] = crop ?? [0, 0, src.width, src.height];
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(cw));
  c.height = Math.max(1, Math.round(ch));
  const g = c.getContext('2d');
  g.drawImage(src, -cx, -cy);
  g.fillStyle = fill;
  for (const [x, y, w, hh] of boxes) g.fillRect(x - cx, y - cy, w, hh);
  return c;
}

export function install(app) {
  const C = app.commands;
  const pane = () => app.activePane();

  app.provenanceNotice = (fmt, chip) => {
    if (!META[fmt]) return null;
    const p = { format: fmt.toUpperCase(), what: t(META[fmt]), image: chip?.record?.image };
    const msg = p.image ? t('Provenance: this {format} product carries {what} from {image}. Review it before release; Redact / Split Image writes pixels only.', p) : t('Provenance: this {format} product carries {what}. Review it before release; Redact / Split Image writes pixels only.', p);
    app.lastProvenanceNotice = { fmt, message: msg, at: new Date().toISOString() };
    app.toast(msg, { kind: 'warn', ms: 9000 });
    return msg;
  };

  /** Redact a chip of the panel: {boxes, crop} in chip pixels → {canvas, blob (PNG, no metadata)}. */
  async function redactChip(opts = {}) {
    const chip = await app.makeChip({ number: 0 });
    const canvas = redactCanvas(chip.canvas, opts);
    const blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(gwError('PNG encoding failed', null, 'E_PNG_ENCODE'))), 'image/png'));
    return { canvas, blob, source: chip.canvas };
  }
  /** Split a chip into a grid of parts (rows × cols): PNG blobs, pixels only. */
  async function splitChip(rows = 2, cols = 2) {
    const chip = await app.makeChip({ number: 0 });
    const W = chip.canvas.width;
    const H = chip.canvas.height;
    const out = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const crop = [Math.round((c * W) / cols), Math.round((r * H) / rows), Math.round(W / cols), Math.round(H / rows)];
        const cv = redactCanvas(chip.canvas, { crop });
        out.push({ row: r, col: c, canvas: cv, blob: await new Promise((res) => cv.toBlob(res, 'image/png')) });
      }
    return out;
  }
  app.redact = { redactCanvas, redactChip, splitChip };
  app.saveStream = (chunks, o) => saveStream(app, chunks, o);
  app.__test = { ...(app.__test ?? {}), saveStream: (chunks, o) => saveStream(app, chunks, { preferPicker: false, ...o }) };

  C.implement('meta.redact', {
    enabled: () => !!pane()?.layers().length,
    run: async () => {
      try {
        const chip = await app.makeChip({ number: 0 });
        const src = chip.canvas;
        const boxes = [];
        let crop = null;
        const cv = h('canvas', { width: String(src.width), height: String(src.height), class: 'redact-canvas', 'aria-label': t('Chip to redact') });
        cv.style.maxWidth = '760px';
        cv.style.width = '100%';
        const mode = h('select', { class: 'inp', 'aria-label': t('Drag to') }, h('option', { value: 'box' }, t('Drag to black out')), h('option', { value: 'crop' }, t('Drag to keep a part (split)')));
        const draw = () => {
          const g = cv.getContext('2d');
          g.drawImage(redactCanvas(src, { boxes }), 0, 0);
          if (crop) {
            g.strokeStyle = '#00e5ff';
            g.lineWidth = 3;
            g.strokeRect(...crop);
          }
        };
        let start = null;
        const at = (e) => {
          const r = cv.getBoundingClientRect();
          return [((e.clientX - r.left) / r.width) * src.width, ((e.clientY - r.top) / r.height) * src.height];
        };
        cv.addEventListener('pointerdown', (e) => (start = at(e)));
        cv.addEventListener('pointerup', (e) => {
          if (!start) return;
          const [x1, y1] = at(e);
          const rect = [Math.min(start[0], x1), Math.min(start[1], y1), Math.abs(x1 - start[0]), Math.abs(y1 - start[1])];
          if (rect[2] > 2 && rect[3] > 2) {
            if (mode.value === 'box') boxes.push(rect);
            else crop = rect;
          }
          start = null;
          draw();
        });
        draw();
        const r = await modal({ title: t('Redact / Split Image'), body: h('div', {}, mode, cv, h('p', { class: 'hint' }, t('The result is a PNG of pixels only: no record, world file, GeoTIFF tags or NITF headers.'))), buttons: [{ label: t('Save PNG…'), value: 'save', primary: true }, { label: t('Cancel'), value: 'cancel' }], width: 820, id: 'meta-redact' });
        if (r !== 'save') return;
        const out = redactCanvas(src, { boxes, crop });
        const blob = await new Promise((res) => out.toBlob(res, 'image/png'));
        await saveBlob(app, blob, { name: 'redacted.png', types: ['.png'], description: t('PNG (pixels only)') });
      } catch (e) {
        app.toast(msgOf(e), { kind: 'error' });
      }
    },
  });
}
