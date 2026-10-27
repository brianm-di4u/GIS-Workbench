// Layer Tools ▸ Compare and Animation (REQ-IMG-24, REQ-IMG-25): porthole, swiper, blend,
// flicker with a rate control and two-colour multiview (date 1 red, date 2 cyan) with a date
// legend, drawn by the GPU in the pane's own pass; WebM (WebCodecs) and GIF recording.

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { saveBlob } from '../storage/files.js';
import { muxWebM, encodeGif } from '../media/webm.js';

export const name = 'compare';

/** IDATIM / ISO-like strings → 'YYYY-MM-DD hh:mm:ssZ' (or the input). */
export function fmtDate(s) {
  const t = String(s ?? '').trim();
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}Z`;
  const tif = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(t); // TIFF DateTime
  if (tif) return `${tif[1]}-${tif[2]}-${tif[3]} ${tif[4]}:${tif[5]}:${tif[6]}`;
  const n = /^(\d{2})(\d{2})(\d{2})(\d{2})Z([A-Z]{3})(\d{2})$/.exec(t); // NITF 2.0 DDHHMMSSZMONYY
  if (n) return `${n[1]} ${n[5]} 20${n[6]} ${n[2]}:${n[3]}:${n[4]}Z`;
  return t || 'date unknown';
}

export function install(app) {
  const C = app.commands;
  const pane = () => app.activePane();
  const two = () => (pane()?.visibleLayers().filter((l) => l.kind !== 'dem').length ?? 0) >= 2;
  const state = (p) => (p.compare ??= { mode: 'none', pos: 0.5, radius: 120, rate: 2, alpha: 0.5 });
  const setMode = (mode) => {
    const p = pane();
    const c = state(p);
    c.mode = c.mode === mode ? 'none' : mode;
    p.invalidate();
    app.renderer.invalidate();
    app.emit('state');
    if (c.mode === 'porthole') app.toast('Porthole: the lower image shows through the circle around the cursor. Alt + wheel changes its size.');
    if (c.mode === 'swipe') app.toast('Swiper: the upper image is shown left of the line, which follows the cursor.');
  };
  for (const [cmd, mode] of [['cmp.porthole', 'porthole'], ['cmp.swiper', 'swipe'], ['cmp.twocolour', 'twocolour'], ['cmp.play', 'flicker']]) {
    C.implement(cmd, { enabled: two, checked: () => pane()?.compare?.mode === mode, run: () => setMode(mode) });
  }

  let blendDlg = null;
  C.implement('cmp.blend', {
    enabled: two,
    checked: () => pane()?.compare?.mode === 'blend',
    run: () => {
      const p = pane();
      const c = state(p);
      if (c.mode === 'blend') {
        blendDlg?.finish?.(null);
        return setMode('blend');
      }
      setMode('blend');
      const rng = h('input', { type: 'range', min: '0', max: '100', value: String(Math.round(c.alpha * 100)), 'aria-label': 'Opacity of the upper image' });
      const out = h('span', { class: 'hint' }, `${Math.round(c.alpha * 100)} %`);
      rng.addEventListener('input', () => {
        c.alpha = +rng.value / 100;
        out.textContent = `${rng.value} %`;
        p.invalidate();
      });
      modal({ title: 'Blend', body: h('div', {}, field('Upper image opacity', rng), out), buttons: ['Close'], width: 320, modeless: true, id: 'blend' });
      blendDlg = document.querySelector('[data-id="dialog:blend"]');
    },
  });

  C.implement('cmp.rate', {
    enabled: two,
    run: async () => {
      const p = pane();
      const c = state(p);
      const rng = h('input', { type: 'range', min: '1', max: '40', value: String(Math.round(c.rate * 4)), 'aria-label': 'Flicker rate' });
      const out = h('span', { class: 'hint' }, `${c.rate} Hz`);
      rng.addEventListener('input', () => {
        c.rate = +rng.value / 4;
        out.textContent = `${c.rate} Hz`;
      });
      await modal({ title: 'Flicker Rate', body: h('div', {}, field('Images per second ÷ 2', rng), out, h('p', { class: 'hint' }, 'Play (Flicker) alternates the upper image on and off at this rate.')), buttons: ['Close'], width: 320, id: 'flicker-rate' });
    },
  });

  // Overlays: swipe line, porthole ring, flicker label and the two-colour date legend.
  app.compareOverlay = (p, g, w, hh) => {
    const c = p.compare;
    const cmp = p.compareLayers?.();
    if (!c || !cmp) return;
    g.save();
    g.font = '12px Arial, sans-serif';
    if (c.mode === 'swipe') {
      const x = (c.pos ?? 0.5) * w;
      g.strokeStyle = '#ffffff';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, hh);
      g.stroke();
    } else if (c.mode === 'porthole' && p.cursor) {
      g.strokeStyle = '#ffff00';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(p.cursor.sx, p.cursor.sy, c.radius ?? 120, 0, Math.PI * 2);
      g.stroke();
    }
    const legend = (lines) => {
      const x = 10;
      let y = hh - 70;
      g.fillStyle = 'rgba(0,0,0,0.7)';
      g.fillRect(x - 4, y - 14, Math.max(...lines.map(([t]) => g.measureText(t).width)) + 34, lines.length * 18 + 6);
      for (const [t, col] of lines) {
        g.fillStyle = col;
        g.fillRect(x, y - 9, 14, 10);
        g.fillStyle = '#fff';
        g.fillText(t, x + 20, y);
        y += 18;
      }
    };
    const nm = (l) => `${l.rec?.name ?? ''} — ${fmtDate(l.info.datetime)}`;
    if (c.mode === 'twocolour') legend([[`Date 1: ${nm(cmp.bottom)}`, '#ff0000'], [`Date 2: ${nm(cmp.top)}`, '#00ffff']]);
    else if (c.mode === 'flicker') legend([[`Flicker ${c.rate} Hz — now: ${nm(c.showingTop ? cmp.top : cmp.bottom)}`, c.showingTop ? '#00ffff' : '#ff0000']]);
    g.restore();
  };

  // ---- recording (REQ-IMG-25): the active pane to WebM (WebCodecs VP8) or GIF ----
  let rec = null;
  const start = async (format) => {
    const p = pane();
    const r = p.el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    // GIF frames are kept small (≤ 640 px wide); WebM keeps the panel's device pixels.
    const scale = format === 'gif' ? Math.min(1, 640 / (r.width * dpr)) : 1;
    const W = Math.max(2, Math.round(r.width * dpr * scale) & ~1);
    const H = Math.max(2, Math.round(r.height * dpr * scale) & ~1);
    const cv = new OffscreenCanvas(W, H);
    const g = cv.getContext('2d', { willReadFrequently: format === 'gif' });
    const t0 = performance.now();
    const fps = format === 'gif' ? 10 : 25;
    let lastT = -1e9;
    const frames = [];
    const chunks = [];
    let encoder = null;
    if (format === 'webm') {
      encoder = new VideoEncoder({
        output: (c) => {
          const data = new Uint8Array(c.byteLength);
          c.copyTo(data);
          chunks.push({ data, timestamp: c.timestamp, key: c.type === 'key' });
        },
        error: (e) => app.toast(`Recording failed: ${e.message}`, { kind: 'error' }),
      });
      encoder.configure({ codec: 'vp8', width: W, height: H, bitrate: 4e6, framerate: fps });
    }
    let n = 0;
    const copy = (renderer) => {
      const now = performance.now();
      if (now - lastT < 1000 / fps - 2) return;
      lastT = now;
      const b = p.el.getBoundingClientRect();
      g.drawImage(renderer.canvas, b.left * dpr, b.top * dpr, b.width * dpr, b.height * dpr, 0, 0, W, H);
      g.drawImage(p.overlay, 0, 0, W, H);
      if (format === 'gif') {
        if (frames.length < 600) frames.push(g.getImageData(0, 0, W, H));
      } else {
        const f = new VideoFrame(cv, { timestamp: Math.round((now - t0) * 1000) });
        encoder.encode(f, { keyFrame: n % (fps * 2) === 0 });
        f.close();
      }
      n++;
    };
    (app.renderer.afterRender ??= []).push(copy);
    const keep = setInterval(() => app.renderer.invalidate(), 1000 / fps);
    rec = {
      format,
      async stop() {
        clearInterval(keep);
        app.renderer.afterRender = app.renderer.afterRender.filter((f) => f !== copy);
        rec = null;
        app.emit('state');
        const base = (p.activeLayer()?.rec?.name ?? 'pane').replace(/[^\w.-]+/g, '_');
        let blob;
        if (format === 'gif') {
          if (!frames.length) return app.toast('Nothing was recorded', { kind: 'warn' });
          blob = new Blob([encodeGif(frames, Math.round(100 / fps))], { type: 'image/gif' });
        } else {
          await encoder.flush();
          encoder.close();
          if (!chunks.length) return app.toast('Nothing was recorded', { kind: 'warn' });
          blob = new Blob([muxWebM({ width: W, height: H, chunks, durationMs: performance.now() - t0 })], { type: 'video/webm' });
        }
        await saveBlob(app, blob, { name: `${base}.${format}`, types: [`.${format}`], description: format === 'gif' ? 'GIF animation' : 'WebM video' });
      },
    };
    app.toast(`Recording the panel to ${format.toUpperCase()}. Record again to stop and save.`);
    app.emit('state');
  };
  C.implement('cmp.record', {
    enabled: () => !!pane()?.layers().length && typeof VideoEncoder === 'function',
    checked: () => !!rec,
    run: () => (rec ? rec.stop() : start(app.prefs.get('recordFormat') ?? 'webm')),
    menu: () => [
      { label: 'Record WebM video', checked: (app.prefs.get('recordFormat') ?? 'webm') === 'webm', run: () => (app.prefs.set('recordFormat', 'webm'), rec ? null : start('webm')) },
      { label: 'Record GIF animation', checked: app.prefs.get('recordFormat') === 'gif', run: () => (app.prefs.set('recordFormat', 'gif'), rec ? null : start('gif')) },
    ],
  });
  app.compareRecording = () => rec;
}
