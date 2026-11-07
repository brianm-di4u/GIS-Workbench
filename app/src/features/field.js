// Field tools (OD-2.23, REQ-HOST-05), the lazy js-field block: My Location through the Geolocation
// API (asked for in words first, then by the browser), a Field Observation with photos from the
// camera or the device, and Export Observations as KML/KMZ or GeoJSON, with the AOIs, GRG
// cells and annotations, shared through the Web Share API where the browser has it and saved
// otherwise. Full and Lite use the same code; the
// desktop shows it in dialogs, Lite's CSS turns the dialogs into bottom sheets.

import { h, clear } from '../shell/dom.js';
import { modal, field, confirmBox } from '../shell/dialogs.js';
import { saveBlob } from '../storage/files.js';
import { observationsGeoJSON, observationsKml, observationsKmz, placed } from '../vector/obs-export.js';
import { t, N_, tr, gwError, msgOf } from '../i18n/index.js';
import { length, int } from '../i18n/format.js';

const CONF = [N_('low'), N_('moderate'), N_('high')];
/** Longest side of a stored photo (px) and its JPEG quality: about 150–400 KB for a phone photo. */
export const PHOTO_MAX = 1600;
export const PHOTO_QUALITY = 0.85;
const PHOTO_LIMIT = 6;

/** Photo pixel size that keeps the aspect and fits `max` on the longer side (never upscales). */
export function fitSize(w, h, max = PHOTO_MAX) {
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** A picked or captured image file → {name, type, width, height, data (JPEG data: URL)}, scaled to PHOTO_MAX. */
async function readPhoto(file) {
  if (!/^image\//.test(file.type || '') && !/\.(jpe?g|png|webp|heic|heif|gif)$/i.test(file.name)) throw gwError('{file} is not an image', { file: file.name }, 'E_NOT_IMAGE');
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw gwError('{file} is an image this browser cannot decode (try JPEG or PNG)', { file: file.name }, 'E_PHOTO_DECODE');
  }
  const { w, h: hh } = fitSize(bmp.width, bmp.height);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = hh;
  c.getContext('2d').drawImage(bmp, 0, 0, w, hh);
  bmp.close?.();
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', PHOTO_QUALITY));
  if (!blob) throw gwError('{file}: the photo could not be encoded', { file: file.name }, 'E_PHOTO_ENCODE');
  const data = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
  return { name: file.name.replace(/\.[^.]+$/, '') + '.jpg', type: 'image/jpeg', width: w, height: hh, bytes: blob.size, data, taken: new Date(file.lastModified || Date.now()).toISOString() };
}

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const pane = () => app.activePane();

  // ---------------- My Location ----------------
  const loc = (app.location ??= { watching: false, fix: null, asked: false, centred: false });
  let watchId = null;
  /** Screen position of a ground point in a pane, or null when the image does not cover it. */
  const onImage = (p, lat, lon, hh) => {
    const l = p?.geoLayer?.();
    if (!l?.modelId) return null;
    const q = l.imageAt(lat, lon, hh ?? l.defaultHeight?.() ?? 0);
    if (!q || q.x < 0 || q.y < 0 || q.x >= l.width || q.y >= l.height) return null;
    return { image: q, screen: p.screenPoint(q.x, q.y) };
  };
  // The location dot and its accuracy circle, drawn over every panel (after the panel's own decorations).
  const prevDeco = app.paneDecorations;
  app.paneDecorations = (p, g, w, hh, l) => {
    prevDeco?.(p, g, w, hh, l);
    const f = loc.watching ? loc.fix : null;
    if (!f) return;
    const at = onImage(p, f.lat, f.lon, f.alt);
    if (!at) return;
    const { x, y } = at.screen;
    let r = 0;
    try {
      const edge = app.core.direct(f.lat, f.lon, 90, Math.max(1, f.accuracy));
      const e = onImage(p, edge.lat, edge.lon, f.alt);
      if (e) r = Math.hypot(e.screen.x - x, e.screen.y - y);
    } catch {
      /* no accuracy circle */
    }
    g.save();
    if (r > 8) {
      g.fillStyle = 'rgba(26,115,232,0.15)';
      g.strokeStyle = 'rgba(26,115,232,0.6)';
      g.lineWidth = 1;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    g.fillStyle = '#1a73e8';
    g.strokeStyle = '#ffffff';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(x, y, 8, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.restore();
  };

  const stop = () => {
    if (watchId !== null) navigator.geolocation?.clearWatch(watchId);
    watchId = null;
    loc.watching = false;
    loc.centred = false;
    app.emit('location', null);
    app.renderer.invalidate();
    app.emit('state');
  };
  const fixText = (f) => t('{coord} (± {acc})', { coord: app.core.format(f.lat, f.lon, 0, 6), acc: length(f.accuracy, 0) });
  const onFix = (pos) => {
    const c = pos.coords;
    loc.fix = { lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, alt: Number.isFinite(c.altitude) ? c.altitude : null, altAccuracy: c.altitudeAccuracy ?? null, heading: Number.isFinite(c.heading) ? c.heading : null, time: new Date(pos.timestamp || Date.now()).toISOString() };
    app.emit('location', loc.fix);
    const p = pane();
    const at = onImage(p, loc.fix.lat, loc.fix.lon, loc.fix.alt);
    if (!loc.centred) {
      loc.centred = true;
      if (at) {
        p.centreOn(at.image.x, at.image.y);
        app.toast(t('Your location: {fix}', { fix: fixText(loc.fix) }), { kind: 'info' });
      } else app.toast(t('Your location: {fix}. It is not on the open image.', { fix: fixText(loc.fix) }), { kind: 'info', ms: 8000 });
    }
    app.renderer.invalidate();
  };
  const onError = (e) => {
    const msg = e?.code === 1 ? t('Location is off: this browser or device did not allow it. Allow location for this page in the browser settings to use it.') : e?.code === 3 ? t('No location fix yet: the device took too long. Try again in the open.') : t('No location is available from this device.');
    stop();
    app.toast(msg, { kind: 'warn', ms: 9000 });
  };
  const locate = async () => {
    if (loc.watching) return stop();
    if (!navigator.geolocation) throw gwError('this browser offers no location (Geolocation API); it needs a secure page (https or a file)', null, 'E_NO_GEOLOCATION');
    // Explicit permission (OD-2.23): say what is asked and why before the browser's own prompt.
    if (!loc.asked) {
      const ok = await confirmBox(t('Use your location?'), t('GIS Workbench asks the browser for this device\'s position to show it on the image and to place observations. The position stays on this device; nothing is sent anywhere.'), { ok: t('Use my location'), cancel: t('Not now') });
      if (!ok) return;
      loc.asked = true;
    }
    loc.watching = true;
    loc.centred = false;
    app.emit('state');
    watchId = navigator.geolocation.watchPosition(onFix, onError, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  };
  C.implement('geo.locate', { run: locate, checked: () => !!loc.watching });

  // ---------------- Field Observation ----------------
  /** The place of a new observation: a pressed point, the device location or the view centre. */
  function places(arg) {
    const out = [];
    if (Number.isFinite(arg?.lat)) out.push({ value: 'point', label: t('The point you pressed'), lat: arg.lat, lon: arg.lon, h: arg.h });
    if (loc.fix) out.push({ value: 'gps', label: t('My location (± {acc})', { acc: length(loc.fix.accuracy, 0) }), lat: loc.fix.lat, lon: loc.fix.lon, h: loc.fix.alt ?? undefined });
    const p = pane();
    const g = p?.geoLayer?.()?.groundAt?.(p.view.cx, p.view.cy);
    if (g) out.push({ value: 'centre', label: t('The centre of the view'), lat: g.lat, lon: g.lon, h: g.h });
    out.push({ value: 'none', label: t('No position') });
    return out;
  }

  async function observe(arg = {}) {
    const text = h('textarea', { rows: 3, 'data-id': 'fobs-text', placeholder: t('(U) What you see, where and when'), spellcheck: 'true', enterkeyhint: 'done' });
    const cat = h('select', { 'data-id': 'fobs-category' }, ...(app.observations?.CATEGORIES ?? ['other']).map((c) => h('option', { value: c }, tr(c))));
    const conf = h('select', { 'data-id': 'fobs-confidence' }, ...CONF.map((c) => h('option', { value: c, selected: c === 'moderate' }, tr(c))));
    const opts = places(arg);
    const where = h('select', { 'data-id': 'fobs-place' }, ...opts.map((o) => h('option', { value: o.value, selected: o.value === (arg.where ?? opts[0].value) }, o.label)));
    const photos = [];
    const strip = h('ul', { class: 'fobs-photos', 'data-id': 'fobs-photos', 'aria-label': t('Photos') });
    const status = h('p', { class: 'hint', 'aria-live': 'polite', 'data-id': 'fobs-photo-status' });
    const render = () => {
      clear(strip);
      photos.forEach((p, i) => {
        const rm = h('button', { class: 'btn fobs-remove', type: 'button', 'aria-label': t('Remove photo {n}', { n: i + 1 }), 'data-id': `fobs-remove:${i}` }, '×');
        rm.addEventListener('click', () => {
          photos.splice(i, 1);
          render();
        });
        strip.appendChild(h('li', {}, h('img', { src: p.data, alt: t('Photo {n}', { n: i + 1 }), width: 96, height: Math.round((96 * p.height) / p.width) }), rm));
      });
      status.textContent = photos.length ? t('{n, plural, one {# photo} other {# photos}}', { n: photos.length }) : '';
    };
    // The camera on a phone (capture), the file picker elsewhere; several photos per observation.
    const camera = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'sr-only', 'data-id': 'fobs-camera', 'aria-label': t('Take a photo') });
    const gallery = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'sr-only', 'data-id': 'fobs-gallery', 'aria-label': t('Choose photos') });
    const add = async (input) => {
      for (const f of [...(input.files ?? [])]) {
        if (photos.length >= PHOTO_LIMIT) {
          app.toast(t('An observation keeps up to {n} photos', { n: PHOTO_LIMIT }), { kind: 'warn' });
          break;
        }
        status.textContent = t('Reading {file}…', { file: f.name });
        try {
          photos.push(await readPhoto(f));
        } catch (e) {
          app.toast(msgOf(e), { kind: 'warn', ms: 7000 });
        }
      }
      input.value = '';
      render();
    };
    camera.addEventListener('change', () => add(camera));
    gallery.addEventListener('change', () => add(gallery));
    const camBtn = h('button', { class: 'btn', type: 'button', 'data-id': 'fobs-take' }, t('Take photo'));
    camBtn.addEventListener('click', () => camera.click());
    const galBtn = h('button', { class: 'btn', type: 'button', 'data-id': 'fobs-choose' }, t('Choose photos'));
    galBtn.addEventListener('click', () => gallery.click());
    const body = h('div', { class: 'fobs' }, field(t('Observation'), text), field(t('Category'), cat), field(t('Confidence'), conf), field(t('Place'), where), h('div', { class: 'btn-row' }, camBtn, galBtn), camera, gallery, strip, status, h('p', { class: 'hint' }, t('Photos are kept in the project, scaled to {px} px.', { px: int(PHOTO_MAX) })));
    app.__fieldDialog = { add: (files) => add({ files, value: '' }), photos }; // test hook: photos without a picker
    const r = await modal({ title: t('Field Observation'), body, buttons: [{ label: t('Add'), value: 'add', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'field-observation' });
    app.__fieldDialog = null;
    if (r !== 'add') return null;
    const pl = opts.find((o) => o.value === where.value) ?? opts.at(-1);
    const rec = app.observations.add({ text: text.value, category: cat.value, confidence: conf.value, lat: Number.isFinite(pl.lat) ? pl.lat : undefined, lon: Number.isFinite(pl.lon) ? pl.lon : undefined, graphics: [], features: [], chips: [] });
    const extra = { photos, place: pl.value };
    if (Number.isFinite(pl.h)) extra.h = pl.h;
    if (pl.value === 'none') Object.assign(extra, { lat: null, lon: null });
    if (pl.value === 'gps') extra.accuracy = loc.fix?.accuracy ?? null;
    app.observations.update(rec.id, extra);
    app.toast(photos.length ? t('Observation added with {n, plural, one {# photo} other {# photos}}', { n: photos.length }) : t('Observation added'), { kind: 'info' });
    return S.get(rec.id);
  }
  C.implement('obs.field', { run: (arg) => observe(arg && typeof arg === 'object' ? arg : {}) });

  // ---------------- Export Observations ----------------
  const FORMATS = [
    { value: 'kml', label: t('KML (KMZ with the photos)') },
    { value: 'geojson', label: t('GeoJSON (photos inside)') },
  ];
  /**
   * The AOIs, GRG cells and annotations in ground positions: {items, left}, where `left` counts
   * those without one. A GRG cell's label is a text graphic beside its polygon, which already
   * carries the label.
   */
  function sceneItems() {
    const p = app.activePane?.();
    const l = p?.geoLayer?.();
    const ground = (r) => {
      if (!r.coords?.length) return null;
      if (r.anchor === 'ground') return r.coords;
      if (r.anchor !== 'image' || r.pane !== p?.id || !l) return null;
      const out = r.coords.map(([x, y]) => l.groundAt?.(x, y));
      return out.every((g) => g && Number.isFinite(g.lat)) ? out.map((g) => [g.lon, g.lat, g.h]) : null;
    };
    const graphics = S.all('graphic');
    const labelled = new Set(graphics.filter((g) => g.shape === 'polygon' && g.text).map((g) => `${g.glayer}\n${g.text}`));
    const items = [];
    let left = 0;
    const add = (r, item) => {
      const c = ground(r);
      if (c) items.push({ ...item, coords: c.length === 2 && r.shape === 'rect' ? [c[0], [c[1][0], c[0][1]], c[1], [c[0][0], c[1][1]]] : c });
      else left++;
    };
    for (const a of S.all('aoi')) add(a, { id: a.id, kind: 'aoi', name: a.name ?? '', shape: 'polygon' });
    for (const g of graphics) if (!(g.shape === 'text' && labelled.has(`${g.glayer}\n${g.text}`))) add(g, { id: g.id, kind: 'graphic', name: g.text ?? '', shape: g.shape });
    return { items, left };
  }
  /** {blob, name} of the observations in `format`. */
  function exportFile(format, obs = S.all('observation'), scene = []) {
    const withPhotos = obs.some((o) => o.photos?.length);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    if (format === 'geojson') return { blob: new Blob([JSON.stringify(observationsGeoJSON(obs, { scene }), null, 1)], { type: 'application/geo+json' }), name: `observations-${stamp}.geojson` };
    if (withPhotos) return { blob: new Blob([observationsKmz(obs, { scene })], { type: 'application/vnd.google-earth.kmz' }), name: `observations-${stamp}.kmz` };
    return { blob: new Blob([observationsKml(obs, { scene })], { type: 'application/vnd.google-earth.kml+xml' }), name: `observations-${stamp}.kml` };
  }
  // Chrome on Android answers yes through canShare, then refuses every format here with NotAllowedError
  // (it passes images, media, PDF and text): offering Share there would only ever end in the fallback.
  const canShare = (file) => {
    if (/Android/.test(navigator.userAgent)) return false;
    try {
      return !!navigator.share && !!navigator.canShare?.({ files: [file] });
    } catch {
      return false;
    }
  };
  async function exportDialog() {
    const all = S.all('observation');
    const n = placed(all).length;
    const scene = sceneItems();
    if (!n && !scene.items.length) throw gwError('add an observation or a graphic with a position first', null, 'E_STEP_FIRST');
    const fmt = h('select', { 'data-id': 'oexp-format' }, ...FORMATS.map((f) => h('option', { value: f.value }, f.label)));
    const probe = new File([new Uint8Array(1)], 'probe.kml', { type: 'application/vnd.google-earth.kml+xml' });
    const share = canShare(probe);
    const skipped = all.length - n;
    const hint = skipped ? t('{n, plural, one {# observation} other {# observations}} with a position; {k, plural, one {# without one is} other {# without one are}} left out.', { n, k: skipped }) : t('{n, plural, one {# observation} other {# observations}}.', { n });
    const buttons = [...(share ? [{ label: t('Share…'), value: 'share', primary: true }] : []), { label: t('Save'), value: 'save', primary: !share }, { label: t('Cancel'), value: 'cancel' }];
    const withScene = h('input', { type: 'checkbox', checked: true, 'data-id': 'oexp-scene', 'aria-label': t('Include the AOI, GRG and annotations') });
    const sceneHint = [t('{n, plural, one {# AOI, grid cell or annotation} other {# AOIs, grid cells and annotations}} with a ground position.', { n: scene.items.length }), ...(scene.left ? [t('{k, plural, one {# without a ground position is} other {# without a ground position are}} left out.', { k: scene.left })] : [])].join(' ');
    const r = await modal({ title: t('Export Observations'), body: h('div', {}, field(t('Format'), fmt), h('p', { class: 'hint' }, hint), ...(scene.items.length ? [field(t('Include the AOI, GRG and annotations'), withScene, sceneHint)] : [])), buttons, id: 'obs-export' });
    if (r !== 'share' && r !== 'save') return null;
    const { blob, name } = exportFile(fmt.value, all, withScene.checked ? scene.items : []);
    if (r === 'share') {
      const file = new File([blob], name, { type: blob.type });
      try {
        await navigator.share({ files: [file], title: t('Observations') });
        app.toast(t('Shared {file}', { file: name }), { kind: 'info' });
        return { name, shared: true, bytes: blob.size };
      } catch (e) {
        if (e?.name === 'AbortError') return null; // the user closed the share sheet
        app.log('warn', `share: ${e?.message ?? e}`);
        app.toast(t('Sharing is not available here; the file is saved instead.'), { kind: 'warn' });
      }
    }
    await saveBlob(app, blob, { name });
    return { name, shared: false, bytes: blob.size };
  }
  C.implement('obs.export', { enabled: () => placed(S.all('observation')).length > 0 || S.all('graphic').length > 0 || S.all('aoi').length > 0, run: exportDialog });
  app.field = { locate, stop, observe, exportFile, sceneItems, readPhoto, fitSize };
}
