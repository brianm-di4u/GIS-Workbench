// GDAL routes through the sidecar (2.6, group gdalroutes; the lazy js-gdalroutes block): dialogs for
// pan-sharpening very large scenes (REQ-GAP-15), reprojection with every PROJ grid (REQ-GAP-17), the
// catalogue of a FileGDB (REQ-GAP-54) and 3D model export to multipatch,
// FBX and IFC (REQ-GAP-36). The work is in the sidecar's fixed profiles: these dialogs choose the
// files, show each profile's own options and start the job. The native routes stay the app's own:
// these are for what is too large for the browser or needs a native library.

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { t, gwError } from '../i18n/index.js';
import { pickFiles } from '../storage/files.js';
import { catalogFromGdb } from '../vector/gdb-catalog.js';

/** Upload each file as its own job input (the first file's companions travel with it). */
async function uploadEach(app, files) {
  const ids = [];
  for (const f of files) ids.push((await app.sidecar.send(f)).id);
  return ids;
}

export function install(app) {
  const profileOf = async (id) => {
    const caps = await app.sidecar.ready();
    const p = caps.profiles.find((x) => x.id === id);
    if (!p) throw gwError('the sidecar has no {profile} profile', { profile: id }, 'E_SIDECAR_NO_PROFILE');
    if (!p.available) throw gwError("the sidecar's {module} module is not installed (needed for {title})", { module: p.module, title: p.title }, 'E_SIDECAR_NO_MODULE');
    return { p, caps };
  };

  /** One profile's dialog: an intro, its options, a Run button → the job's result. */
  async function run({ id, title, intro, files, extra = null, dialog, open = true, outputName, read = null }) {
    const { p, caps } = await profileOf(id);
    const form = app.sidecar.optionsForm(p, caps);
    const body = h('div', {}, h('p', {}, intro), extra, form.el);
    const r = await modal({ title, body, buttons: [{ label: t('Run'), value: 'run', primary: true }, { label: t('Cancel'), value: 'cancel' }], width: 600, id: dialog });
    if (r !== 'run') return null;
    const ids = typeof files === 'function' ? await files() : files;
    const options = { ...form.read(), ...(read?.() ?? {}) };
    return app.sidecar.convert({ files: ids, profile: id, options, open, reason: title, outputName });
  }

  async function pansharpen(args = {}) {
    await app.sidecar.ready();
    const pan = args.pan ?? (await pickFiles(app, { accept: [], description: t('The panchromatic band') }))?.[0];
    if (!pan) return null;
    const ms = args.ms ?? (await pickFiles(app, { multiple: true, accept: [], description: t('The spectral bands: one multi-band file, or a file per band in order') }));
    if (!ms?.length) return null;
    return run({ id: 'raster-pansharpen', title: t('Pan-Sharpen with Sidecar'), dialog: 'sidecar-pansharpen', intro: t('{pan} and {n, plural, one {# spectral file} other {# spectral files}}: weighted Brovey at the pan resolution, by GDAL. For scenes too large for the browser; Pan-Sharpened Product has the other methods and the quality measures.', { pan: pan.name, n: ms.length }), files: () => uploadEach(app, [pan, ...ms]), outputName: pan.name });
  }

  async function reproject(args = {}) {
    await app.sidecar.ready();
    const f = args.file ?? (await pickFiles(app, { accept: [], description: t('The raster to reproject') }))?.[0];
    if (!f) return null;
    const { caps } = await profileOf('raster-reproject');
    const grids = caps.modules.find((m) => m.id === 'proj-grids');
    const note = h('p', { class: 'hint', 'data-id': 'sidecar:grids' }, grids?.installed ? t('The full PROJ grid set is installed.') : t('The PROJ grid module is not installed: a shift that needs a grid is refused while "refuse if the grid is missing" is on. Add it in the sidecar window (Add or remove modules…).'));
    return run({ id: 'raster-reproject', title: t('Reproject with Sidecar'), dialog: 'sidecar-reproject', intro: f.name, extra: note, files: () => uploadEach(app, [f]) });
  }

  async function modelExport(args = {}) {
    await app.sidecar.ready();
    const f = args.file ?? (await pickFiles(app, { accept: ['.glb', '.gltf', '.obj', '.stl', '.ply', '.dae', '.fbx'], description: t('The 3D model (uncompressed glTF, OBJ, STL, PLY or COLLADA)') }))?.[0];
    if (!f) return null;
    const caps = await app.sidecar.ready();
    const list = caps.profiles.filter((p) => p.input === 'model' && p.available);
    if (!list.length) throw gwError("the sidecar's {module} module is not installed (needed for {title})", { module: 'model3d', title: t('Export 3D Model with Sidecar') }, 'E_SIDECAR_NO_MODULE');
    const sel = h('select', { class: 'inp', 'data-id': 'sidecar:modelformat' }, ...list.map((p) => h('option', { value: p.id }, p.title)));
    const r = await modal({ title: t('Export 3D Model with Sidecar'), body: h('div', {}, h('p', {}, f.name), field(t('Format'), sel)), buttons: [{ label: t('Next'), value: 'next', primary: true }, { label: t('Cancel'), value: 'cancel' }], width: 480, id: 'sidecar-modelformat' });
    if (r !== 'next') return null;
    const id = args.profile ?? sel.value;
    return run({ id, title: t('Export 3D Model with Sidecar'), dialog: 'sidecar-modelexport', intro: t('{file}: for a georeferenced result give the origin and a projected CRS. glTF is taken as Y up unless you say otherwise.', { file: f.name }), files: () => uploadEach(app, [f]), open: false });
  }

  async function gdbCatalogue(args = {}) {
    const caps = await app.sidecar.ready();
    const prof = caps.profiles.find((p) => p.id === 'gdb-catalogue');
    if (!prof?.available) throw gwError('the sidecar has no {profile} profile', { profile: 'gdb-catalogue' }, 'E_SIDECAR_NO_PROFILE');
    let name;
    let ids;
    if (args.file) {
      name = args.file.name;
      ids = await uploadEach(app, [args.file]);
    } else {
      const pick = await app.sidecar.client.pick('folder', t('Choose the .gdb folder'));
      const folder = pick.files[0];
      if (!folder) return null;
      name = folder.name;
      ids = [folder.id];
    }
    const fin = await app.sidecar.convert({ files: ids, profile: 'gdb-catalogue', open: false, reason: t('Catalogue from FileGDB') });
    const { catalog, warnings, counts } = catalogFromGdb(name, fin.result);
    const list = warnings.length ? h('ul', { class: 'hint', 'data-id': 'sidecar:gdbwarnings' }, ...warnings.slice(0, 40).map((w) => h('li', {}, w))) : null;
    const r = await modal({
      title: t('Catalogue from FileGDB'),
      body: h('div', {}, h('p', { 'data-id': 'sidecar:gdbcounts' }, t('{file}: {classes, plural, one {# feature class} other {# feature classes}}, {domains, plural, one {# domain} other {# domains}}, {subtypes, plural, one {# subtype} other {# subtypes}}.', { file: name, classes: counts.classes, domains: counts.domains, subtypes: counts.subtypes })), counts.tables ? h('p', { class: 'hint' }, t('{n, plural, one {# table without geometry is} other {# tables without geometry are}} left out.', { n: counts.tables })) : null, list),
      buttons: [{ label: t('Import'), value: 'import', primary: true }, { label: t('Cancel'), value: 'cancel' }],
      width: 560,
      id: 'sidecar-gdbcatalog',
    });
    if (r !== 'import' && !args.yes) return { catalog, warnings, counts, imported: false };
    const out = await app.catalogs.import(catalog, { keep: args.keep ?? 'both' });
    app.toast(t('Feature catalogue {name} imported: {types, plural, one {# feature type} other {# feature types}}. New Layer from Schema offers it.', { name: catalog.name, types: counts.classes }), { kind: 'info', ms: 7000 });
    return { ...out, catalog, warnings, counts, imported: true };
  }

  const C = app.commands;
  const guard = app.sidecar.guard;
  C.implement('sidecar.pansharpen', { run: guard((a) => pansharpen(a)) });
  C.implement('sidecar.reproject', { run: guard((a) => reproject(a)) });
  C.implement('sidecar.modelexport', { run: guard((a) => modelExport(a)) });
  C.implement('sidecar.gdbcatalog', { run: guard((a) => gdbCatalogue(a)) });
}
