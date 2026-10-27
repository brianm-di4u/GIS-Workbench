// Video clips and animated GIFs in products (REQ-PRD-12), and PowerPoint templates (REQ-PRD-09).
// A GIF comes from frames of the active video (decoded exactly through WebCodecs) or from the
// layers of a panel (a flicker animation); a short video is the FMV burn-in clip. Media items are
// kept for the session and go into the HTML report (<img>/<video>) and PPTX slides.

import { encodeGif } from '../products/gif.js';
import { readPptxTemplate } from '../products/pptx-template.js';
import { pickFiles, saveBlob } from '../storage/files.js';
import { modal, field } from '../shell/dialogs.js';
import { h } from '../shell/dom.js';

export const name = 'media';

function toDataUrl(bytes, type) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(s)}`;
}

export function install(app) {
  const C = app.commands;
  const items = [];
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      app.toast(e.message, { kind: 'error', ms: 8000 });
    }
  };

  function add(item) {
    items.push({ id: `media${items.length + 1}`, created: new Date().toISOString(), ...item });
    app.emit('state');
    return items.at(-1);
  }

  /** GIF from video frames [from, to] every `step`, scaled to at most maxWidth. */
  async function gifFromClip(clip = app.fmv?.activeClip(), { from = clip?.current ?? 0, to = null, step = 3, maxWidth = 480, delayMs = null, caption = null } = {}) {
    if (!clip) throw new Error('open a video first');
    to ??= Math.min(clip.frames.length - 1, from + 60);
    const frames = [];
    let W = 0;
    let H = 0;
    for (let i = from; i <= to; i += step) {
      const px = await app.fmv.framePixels(clip, i);
      const s = Math.min(1, maxWidth / px.width);
      W = Math.round(px.width * s);
      H = Math.round(px.height * s);
      const c = new OffscreenCanvas(W, H);
      const g = c.getContext('2d');
      g.drawImage(px.canvas, 0, 0, W, H);
      frames.push({ data: g.getImageData(0, 0, W, H).data, width: W, height: H });
    }
    const gif = encodeGif(frames, { delayMs: delayMs ?? Math.round((1000 * step) / clip.fps) });
    const st = app.fmv.stateAt(clip, from);
    return add({ kind: 'gif', bytes: gif, dataUrl: toDataUrl(gif, 'image/gif'), width: W, height: H, frames: frames.length, caption: caption ?? `${clip.name} frames ${from + 1}–${to + 1} (${st?.utcText ?? ''} UTC)`, marking: clip.banner?.klv?.level ?? null, source: clip.name });
  }

  /** GIF that flickers through the image layers of a panel (one frame per layer). */
  async function gifFromLayers(p = app.activePane(), { maxWidth = 480, delayMs = 600, caption = null } = {}) {
    const layers = p?.layers?.().filter((l) => l.kind === 'image') ?? [];
    if (layers.length < 2) throw new Error('a layer animation needs two or more image layers in the panel');
    const frames = [];
    const visible = layers.map((l) => l.rec.visible !== false);
    try {
      for (const l of layers) {
        app.store.transact('a', (tx) => layers.forEach((x) => tx.set(x.id, 'visible', x === l)), { kind: 'load' });
        p.invalidate();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const chip = await app.makeChip({ number: 0 });
        const cv = chip.canvas;
        const s = Math.min(1, maxWidth / cv.width);
        const c = new OffscreenCanvas(Math.round(cv.width * s), Math.round(cv.height * s));
        const g = c.getContext('2d');
        g.drawImage(cv, 0, 0, c.width, c.height);
        frames.push({ data: g.getImageData(0, 0, c.width, c.height).data, width: c.width, height: c.height });
      }
    } finally {
      app.store.transact('a', (tx) => layers.forEach((x, i) => tx.set(x.id, 'visible', visible[i])), { kind: 'load' });
      p.invalidate();
    }
    const gif = encodeGif(frames, { delayMs });
    return add({ kind: 'gif', bytes: gif, dataUrl: toDataUrl(gif, 'image/gif'), width: frames[0].width, height: frames[0].height, frames: frames.length, caption: caption ?? `Layer animation: ${layers.map((l) => l.rec.name).join(' / ')}`, source: 'panel' });
  }

  /** A short burn-in video of the active clip (MP4 where the browser records it, else WebM). */
  async function videoFromClip(clip = app.fmv?.activeClip(), { from = clip?.current ?? 0, to = null, caption = null } = {}) {
    if (!clip) throw new Error('open a video first');
    to ??= Math.min(clip.frames.length - 1, from + 90);
    const blob = await app.fmv.exportClip(clip, { from, to, save: false });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return add({ kind: 'video', bytes, mime: blob.type, dataUrl: toDataUrl(bytes, blob.type), width: clip.width, height: clip.height, caption: caption ?? `${clip.name} frames ${from + 1}–${to + 1} with HUD`, marking: clip.banner?.klv?.level ?? null, source: clip.name });
  }

  /** PPTX of the media items (one slide each), with the imported template when there is one. */
  async function pptx({ title = 'Motion imagery products' } = {}) {
    if (!items.length) throw new Error('no media yet: make a GIF or a clip first');
    const slides = items.map((m) => ({ media: m, title: m.caption, marking: m.marking ? { level: m.marking } : app.screenMarking(), wIn: 13.333, hIn: 7.5, notes: `${m.kind === 'gif' ? `${m.frames} frames` : m.mime} · ${m.source}` }));
    return app.finishing.writePptx(slides, { title });
  }

  async function importTemplate(file) {
    const t = readPptxTemplate(new Uint8Array(await file.arrayBuffer()), file.name);
    app.pptxTemplate = t;
    app.prefs.set('pptxTemplateName', t.name);
    app.toast(`PowerPoint template ${t.name}: ${t.size.w.toFixed(2)} × ${t.size.h.toFixed(2)} in, fonts ${t.fonts.title}/${t.fonts.body}, ${t.pictures.length} picture(s)`);
    return t;
  }

  C.implement('prod.gif', {
    run: run(async () => {
      const src = h('select', { 'data-id': 'gif-source' }, h('option', { value: 'clip' }, 'Active video (frames from here)'), h('option', { value: 'layers' }, 'Layers of the active panel'), h('option', { value: 'video' }, 'Video clip with HUD (MP4/WebM)'));
      if ((await modal({ title: 'Make Animation', body: field('Source', src), id: 'make-gif' })) !== 'OK') return;
      const m = src.value === 'clip' ? await gifFromClip() : src.value === 'layers' ? await gifFromLayers() : await videoFromClip();
      app.toast(`${m.kind === 'gif' ? `GIF (${m.frames} frames)` : 'Video clip'} added to the report and the media slides`);
    }),
  });
  C.implement('prod.mediapptx', { enabled: () => items.length > 0, run: run(async () => saveBlob(app, new Blob([await pptx()], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), { name: 'media.pptx' })) });
  C.implement('prod.pptxtemplate', {
    run: run(async () => {
      const [f] = await pickFiles(app, { accept: ['.pptx', '.potx'], description: 'PowerPoint template', multiple: false });
      if (f) await importTemplate(f);
    }),
  });
  app.media = { items, add, gifFromClip, gifFromLayers, videoFromClip, pptx, importTemplate };
}
