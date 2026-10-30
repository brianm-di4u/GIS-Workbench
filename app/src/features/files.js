// File commands: open imagery and DEMs (picker or drop), new/open/save project (.gwb),
// relink imagery by fingerprint, project properties, recovery offer (REQ-ARC-08..11).

import { pickFiles, saveBlob } from '../storage/files.js';
import { sniffName, walkFolder } from '../formats/sniff.js';
import { templateHtml } from '../storage/selfsave.js';
import { serialiseProject, readProject, relink } from '../storage/project.js';
import { Journal } from '../storage/journal.js';
import { groupFiles, openImageFile, attachFile, recoverHandle } from '../formats/open.js';
import { isImageryZip, expandZip, defaultPick } from '../formats/zip-container.js';
import { modal, field, confirmBox, promptBox } from '../shell/dialogs.js';
import { h } from '../shell/dom.js';
import { fmtBytes } from '../core/util.js';
import { FEEDBACK_EMAIL } from '../feedback/contact.js';

export const name = 'files';

// Everything the image readers take (formats/open.js IMAGE_EXT and SIDECAR_EXT), so the picker hides
// nothing a drop would open: JPEG 2000, GeoPDF, GIF/BMP/WebP with world files, RPF frames.
const RPF_ZONES = [...'0123456789abcdefghij'];
const IMAGE_ACCEPT = [
  ...['.ntf', '.nitf', '.nsf', '.tif', '.tiff', '.gtiff', '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.jp2', '.jpx', '.j2k', '.j2c', '.jpf', '.pdf'],
  ...['.jgw', '.pgw', '.tfw', '.tifw', '.sdw', '.wld', '.gfw', '.bpw', '.j2w', '.xml', '.prj', '.ovr', '.rpb', '.imd', '.til', '.att', '.eph', '.geo', '.clr', '.hdr'],
  ...['.zip', '.sid', '.dt0', '.dt1', '.dt2', '.hgt', '.gz', '.r0', '.r1', '.r2', '.img', '.dat', '.bsq', '.bil', '.bip', '.raw', '.h5', '.he5', '.hdf5', '.nc', '.gwpack'],
  ...['gn', 'jn', 'on', 'tp', 'lf', 'ja', 'jr', 'tc', 'tl', 'i1', 'i2', 'i3', 'i4', 'i5'].flatMap((s) => RPF_ZONES.map((z) => `.${s}${z}`)),
];

export async function install(app) {
  const C = app.commands;
  // A file whose worker was restarted is reopened in a fresh one, not left for the user to reopen.
  if (app.pool) app.pool.recover = (slotId, handle) => recoverHandle(app, slotId, handle);
  app.journal = new Journal(app);
  await app.journal.open();
  if (!app.journal.available) app.storageWarning = 'Browser storage is unavailable here: no crash recovery and no saved whiteboard sessions.';
  app.store.on('commit', (cs) => {
    app.journal.record(cs);
    app.dirty = true;
    for (const id of new Set(cs.ops.map((o) => o.id))) {
      const r = app.store.get(id);
      if (r?.type === 'layer' && r.saved !== false && cs.kind !== 'load') r.saved = false; // leading asterisk until saved
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (app.dirty && app.store.all('layer').length) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  /** Pick the entries of an imagery ZIP to open (IMP-21): a grouped checklist, defaults ticked. */
  async function chooseEntries(zip, entries) {
    const def = new Set(defaultPick(entries));
    const how = app.zipPick; // automation and tests: 'default', 'all' or a function of the entries
    if (how === 'default') return [...def];
    if (how === 'all') return entries;
    if (typeof how === 'function') return how(entries);
    const boxes = new Map();
    const groups = [...new Set(entries.map((e) => e.group))];
    const rows = groups.map((g) => {
      const mine = entries.filter((e) => e.group === g);
      const all = h('input', { type: 'checkbox', checked: mine.every((e) => def.has(e)), 'aria-label': `All of ${g}` });
      all.addEventListener('change', () => mine.forEach((e) => (boxes.get(e).checked = all.checked)));
      return h('fieldset', { class: 'sec' }, h('legend', {}, h('label', {}, all, ` ${g.slice(zip.name.length + 1) || zip.name}`)),
        mine.map((e) => {
          const b = h('input', { type: 'checkbox', checked: def.has(e) });
          boxes.set(e, b);
          return h('label', { class: 'chk', style: { display: 'block' } }, b, ` ${e.path.split('/').slice(-2).join('/')} `, h('small', { class: 'hint' }, `${fmtBytes(e.size)}${e.nested ? ' — a package of its own: its files are listed when it opens' : ''}`));
        }));
    });
    const body = h('div', {}, h('p', { class: 'dlg-msg' }, `${zip.name} holds ${entries.length} files. Choose what to open; nothing is unpacked to disk.`), h('div', { style: { maxHeight: '50vh', overflow: 'auto' } }, rows));
    const r = await modal({ title: 'Open from ZIP', body, buttons: ['Open', 'Cancel'], width: 560, id: 'zip-open' });
    return r === 'Open' ? entries.filter((e) => boxes.get(e).checked) : null;
  }

  /** Replace imagery ZIPs in a dropped set by the entries the user picks from them. */
  async function expandPackages(files) {
    const out = [];
    for (const f of files) {
      if (!/\.zip$/i.test(f.name) || !(await isImageryZip(f))) {
        out.push(f);
        continue;
      }
      try {
        const entries = await expandZip(f);
        const pick = await chooseEntries(f, entries);
        if (!pick?.length) continue;
        if (pick.some((e) => e.method === 8 && e.size > 64e6)) app.toast(`Unpacking ${f.name} in memory…`);
        // A package inside the ZIP that was not expanded opens as its own package (and picker).
        for (const e of pick) {
          if (e.nested) out.push(...(await expandPackages([await e.open()])));
          else {
            // Marked, so the vector reader treats a non-GeoJSON .json beside the imagery as a companion.
            const file = await e.open();
            file.fromZip = f.name;
            out.push(file);
          }
        }
        app.importLog.push({ file: f.name, errors: [], warnings: [`opened ${pick.length} of ${entries.length} files from the ZIP`] });
      } catch (e) {
        app.toast(`${f.name}: ${e.message}`, { kind: 'error', ms: 9000 });
        app.importLog.push({ file: f.name, errors: [e.message], warnings: [] });
      }
    }
    return out;
  }

  /**
   * Files that are not data layers but have a home in the app: recipes, product templates,
   * PowerPoint templates and local 3D Tiles archives open where they belong; single tiles of a tile
   * set are refused by name with the way to open the set. Each is logged like any other import.
   * Returns the files left for the data readers.
   */
  async function openSpecialFiles(files, pane) {
    // [name, available?, open → what the toast says]
    const routes = [
      [/\.gwrecipe\.json$/i, () => app.recipes?.importFile, async (f) => (await app.recipes.importFile(f), 'recipe opened in the Recipes panel')],
      [/\.gwt\.json$/i, () => app.loadTemplateFile, async (f) => `product template "${(await app.loadTemplateFile(f)).name}" is now the active template`],
      [/\.(pptx|potx)$/i, () => app.media?.importTemplate, async (f) => (await app.media.importTemplate(f), 'PowerPoint template in use for product slides')],
      [/\.3tz$/i, () => app.scene3d?.addTilesArchive, async (f) => `3D Tiles ${(await app.scene3d.addTilesArchive(f, { p: pane })).asset?.version ?? '1.x'} in the 3D view`],
      [/\.(b3dm|i3dm|pnts|cmpt|subtree)$/i, () => true, async (f) => {
        throw new Error(`a 3D Tiles content tile (${f.name.split('.').pop()}): open the whole tileset — its .3tz archive, or its tileset.json URL with 3D ▸ Add 3D Tiles`);
      }],
      [/(^|[\\/])tileset\.json$/i, () => true, async () => {
        throw new Error('a 3D Tiles tileset.json: open it by URL with 3D ▸ Add 3D Tiles, or the tileset packed as a .3tz archive');
      }],
      [/(^|[\\/])layer\.json$/i, () => true, async () => {
        throw new Error('a quantized-mesh layer.json: add the terrain by its URL with 3D ▸ Add Quantized-Mesh Terrain');
      }],
      [/\.terrain$/i, () => true, async () => {
        throw new Error('a quantized-mesh terrain tile: add the tile set by its layer.json URL with 3D ▸ Add Quantized-Mesh Terrain');
      }],
      [/(^|[\\/])a\.toc$/i, () => true, async () => {
        throw new Error('an RPF table of contents (A.TOC) is not read: open the frame files of its RPF folder (CADRG .ON2/.JN1…, CIB .I21…) instead');
      }],
      [/\.mbtiles$/i, () => true, async () => {
        throw new Error('MBTiles tile sets are not read; convert it to PMTiles (pmtiles convert in.mbtiles out.pmtiles) and open that as a basemap');
      }],
    ];
    const rest = [];
    for (let f of files) {
      // Gzipped vector text (Microsoft building footprints, feeds) is inflated in memory and read as itself.
      if (/\.(csv|geojson|json|kml|gpx|gml)\.gz$/i.test(f.name)) {
        try {
          const raw = await new Response(f.stream().pipeThrough(new DecompressionStream('gzip'))).blob();
          // Named by content: Microsoft's "….csv.gz" building tiles hold one GeoJSON Feature per line.
          const json = /^\s*[{[]/.test(await raw.slice(0, 64).text());
          f = new File([raw], json ? f.name.slice(0, -3).replace(/\.\w+$/, '.geojson') : f.name.slice(0, -3), { lastModified: f.lastModified });
        } catch (e) {
          app.importLog.push({ file: f.name, errors: [`the gzip data is damaged (${e.message})`], warnings: [] });
          app.toast(`${f.name}: the gzip data is damaged`, { kind: 'error', ms: 9000 });
          continue;
        }
      }
      const route = routes.find(([re, available]) => re.test(f.name) && available());
      if (!route) {
        rest.push(f);
        continue;
      }
      try {
        const what = await route[2](f);
        app.importLog.push({ file: f.name, errors: [], warnings: [] });
        app.toast(`${f.name}: ${what}`);
      } catch (e) {
        app.importLog.push({ file: f.name, errors: [e.message], warnings: [] });
        app.toast(`${f.name}: ${e.message}`, { kind: 'error', ms: 9000 });
      }
    }
    return rest;
  }

  async function openFiles(files, pane) {
    // Files whose name says nothing are identified by their first bytes (REQ-ING-03).
    files = await Promise.all([...files].map((f) => sniffName(f).catch(() => f)));
    // A project in the set opens as the project, as a drop does (catalog, panels and automation call here too).
    const proj = files.find((f) => /\.gwb$/i.test(f.name));
    if (proj) return openProjectFile(proj);
    files = await openSpecialFiles(files, pane);
    if (!files.length) return;
    // Imagery packages delivered as ZIPs open from inside the archive (IMP-21); what comes out goes
    // through the same routes as a dropped file.
    if ([...files].some((f) => /\.zip$/i.test(f.name))) {
      files = await openSpecialFiles(await expandPackages([...files]), pane);
      if (!files.length) return;
    }
    if (app.splitPackFiles) {
      // Data packs (REQ-ARC-14) open first: a dropped set may need them (PROJ codes for a point
      // cloud, h5wasm for HDF5) — they used to open after the point clouds.
      const { packs, rest } = app.splitPackFiles([...files]);
      if (packs.length) await app.openPackFiles(packs).catch((e) => app.toast(e.message, { kind: 'error', ms: 9000 }));
      files = rest;
      if (!files.length) return;
    }
    if (app.splitPointCloudFiles) {
      // A .txt of X Y Z rows (PDAL's text writer, scanner exports) is an ASCII point cloud: three or
      // more numeric columns on its first data rows, or a header naming X, Y and Z.
      for (const f of files) {
        if (!/\.txt$/i.test(f.name) || f.size < 16) continue;
        const lines = (await f.slice(0, 4096).text()).split(/\r?\n/).filter((l) => l.trim()).slice(0, 4);
        const cells = (l) => l.trim().split(/\s*[,;\t|]\s*|\s+/).map((c) => c.replace(/^"|"$/g, ''));
        const numeric = (l) => cells(l).length >= 3 && cells(l).every((c) => c !== '' && Number.isFinite(Number(c)));
        const head = lines[0] ? cells(lines[0]).map((c) => c.toLowerCase()) : [];
        if (lines.length >= 2 && (lines.slice(1).every(numeric) && (numeric(lines[0]) || ['x', 'y', 'z'].every((k) => head.includes(k))))) f.__asciiCloud = true;
      }
      // LAS/LAZ open into a 3D panel (REQ-LDR-01).
      const { clouds, rest } = app.splitPointCloudFiles([...files]);
      if (clouds.length) await app.openPointClouds(clouds, pane);
      files = rest;
      if (!files.length) return;
    }
    // TE-029 / IMP-13: GPX and glTF dropped with the other files go to their readers (they used to
    // fall through to the image reader as "unrecognised data").
    const gpx = files.filter((f) => /\.gpx$/i.test(f.name));
    const gltf = files.filter((f) => /\.(glb|gltf)$/i.test(f.name));
    const gltfRes = gltf.length ? files.filter((f) => /\.(bin|png|jpe?g|webp|ktx2)$/i.test(f.name)) : [];
    // A glTF's .bin buffers travel with it.
    files = [...files].filter((f) => !gpx.includes(f) && !gltf.includes(f) && !gltfRes.includes(f));
    for (const f of gpx) {
      try {
        const r = await app.loadGpx(f, pane);
        app.importLog.push({ file: f.name, errors: [], warnings: [] });
        app.toast(`${f.name}: ${r.waypoints} waypoint(s), ${r.routes} route(s), ${r.tracks} track segment(s)`);
      } catch (e) {
        app.importLog.push({ file: f.name, errors: [e.message], warnings: [] });
        app.toast(`${f.name}: ${e.message}`, { kind: 'error', ms: 8000 });
      }
    }
    for (const f of gltf) {
      try {
        const v = await app.scene3d.ensureView();
        const m = await v.addGltf(new Uint8Array(await f.arrayBuffer()), f.name, gltfRes);
        app.importLog.push({ file: f.name, errors: [], warnings: [`placed by its ${m.placedBy}`] });
        app.toast(`${f.name}: ${m.meshes} mesh(es), placed by its ${m.placedBy}`);
      } catch (e) {
        app.importLog.push({ file: f.name, errors: [e.message], warnings: [] });
        app.toast(`${f.name}: ${e.message}`, { kind: 'error', ms: 8000 });
      }
    }
    if (!files.length) return;
    // PMTiles open as a basemap (REQ-NET-05).
    const pmt = [...files].filter((f) => /.pmtiles$/i.test(f.name));
    for (const f of pmt) {
      if (!app.openPmtiles) break;
      await app.openPmtiles(f).then(
        () => app.importLog.push({ file: f.name, errors: [], warnings: [] }),
        (e) => {
          app.importLog.push({ file: f.name, errors: [e.message], warnings: [] });
          app.toast(`${f.name}: ${e.message}`, { kind: 'warn', ms: 8000 });
        },
      );
    }
    if (pmt.length) files = [...files].filter((f) => !pmt.includes(f));
    if (!files.length) return;
    if (app.splitMotionFiles) {
      // MPEG-TS video, STANAG 4607 GMTI and 4676 tracks (REQ-FMV-01, 11, 13).
      const { video, gmti, tracks, rest } = app.splitMotionFiles([...files]);
      if (video.length || gmti.length || tracks.length) await app.openMotionFiles({ video, gmti, tracks }, pane);
      files = rest;
      if (!files.length) return;
    }
    // ML detections as CSV (a class and a confidence column) go to the detection review queue,
    // not the vector reader, which has no pixel boxes (GUI-058).
    // They are imported after any images in the same drop, onto the image they belong to.
    const det = [];
    const lib = [];
    const csvHead = async (f) => (await f.slice(0, 2048).text()).replace(/^﻿/, '').split(/\r?\n/)[0].toLowerCase().split(',').map((x) => x.trim().replace(/^"|"$/g, ''));
    if (app.detections) {
      for (const f of files) {
        if (!/\.csv$/i.test(f.name)) continue;
        const head = await csvHead(f);
        if (head.some((x) => ['class', 'label', 'category'].includes(x)) && head.some((x) => ['confidence', 'score', 'conf', 'prob', 'probability'].includes(x))) det.push(f);
      }
      files = [...files].filter((f) => !det.includes(f));
    }
    // Spectral libraries (ENVI .sli with its .hdr, CSV whose first column is the wavelength) go to the
    // spectral plot (REQ-MSI-10), not the image or vector readers.
    if (app.msi?.importLibraryFiles) {
      for (const f of files) {
        if (/\.sli$/i.test(f.name)) {
          const stem = f.name.replace(/\.sli$/i, '').toLowerCase();
          lib.push(f, ...files.filter((g) => [`${stem}.hdr`, `${stem}.sli.hdr`].includes(g.name.toLowerCase())));
        } else if (/\.csv$/i.test(f.name) && /^wave(length)?([_ (]|$)/.test((await csvHead(f))[0] ?? '')) lib.push(f);
      }
      if (lib.length) {
        files = [...files].filter((f) => !lib.includes(f));
        try {
          const s = await app.msi.importLibraryFiles(lib);
          if (!s.length) throw new Error('no spectra found in the library files');
          lib.forEach((f) => app.importLog.push({ file: f.name, errors: [], warnings: [] }));
          app.toast(`${s.length} library spectra from ${lib.map((f) => f.name).join(', ')}`);
        } catch (e) {
          lib.forEach((f) => app.importLog.push({ file: f.name, errors: [e.message], warnings: [] }));
          app.toast(`${lib[0].name}: ${e.message}`, { kind: 'error', ms: 9000 });
        }
        if (!files.length && !det.length) return;
      }
    }
    const importDetections = async () => {
      for (const f of det) {
        if (!app.activeLayer?.()) {
          const msg = 'open the image these detections belong to first, then open the file again';
          app.importLog.push({ file: f.name, errors: [], warnings: [msg] });
          app.toast(`${f.name}: ${msg}`, { kind: 'warn', ms: 8000 });
          continue;
        }
        await app.detections.importFile(f).catch((e) => {
          app.importLog.push({ file: f.name, errors: [e.message], warnings: [] });
          app.toast(e.message, { kind: 'warn', ms: 8000 });
        });
      }
    };
    if (!files.length) return importDetections();
    if (app.splitVectorFiles) {
      // Vector data (GeoJSON, KML/KMZ, Shapefile sets) opens as feature layers (REQ-EXT-21).
      const { vector, rest } = app.splitVectorFiles([...files]);
      if (vector.length) await app.openVectorFiles(vector);
      files = rest;
    }
    const groups = groupFiles(files);
    for (const g of groups) {
      try {
        const { report, layers } = await openImageFile(app, g.file, { sidecars: g.sidecars, handle: g.file.__handle ?? null, pane });
        const extra = report.warnings.length ? ` (${report.warnings.length} note${report.warnings.length > 1 ? 's' : ''} in the import log)` : '';
        // Snackbar with one action (REQ-SHL-07): bring the new image into view.
        const lid = layers?.[0]?.id ?? layers?.[0];
        const zoom = lid ? { label: 'Zoom to layer', run: () => app.zoomToLayer?.(lid) } : undefined;
        app.toast(`Opened ${g.file.name} in ${report.ms} ms${extra}`, { action: zoom });
        // A large raster that is not cloud-optimized: offer a COG copy (REQ-CNV-03).
        const L0 = layers?.[0];
        const fmt = L0?.info?.meta?.format ?? '';
        if (L0 && !g.file.remote && L0.width * L0.height > 4e6 && !/COG/.test(fmt) && app.convertToCog) {
          app.toast(`${g.file.name} is not cloud-optimized: a COG copy pans faster and can be streamed from a server.`, { action: { label: 'Make COG copy', run: () => app.convertToCog(L0.id).then((m) => app.toast(m)).catch((e) => app.toast(e.message, { kind: 'warn', ms: 8000 })) } });
        }
        // A single-band elevation raster (a GeoTIFF DEM): offer it as terrain (GUI-056).
        if (L0 && app.elevationLike?.(L0)) app.toast(`${g.file.name} looks like elevation data: use it as terrain for heights, line of sight and the Surface tools.`, { action: { label: 'Use as terrain', run: () => app.terrainDialog(L0) } });
      } catch (e) {
        app.log('warn', `${g.file.name}: ${e.message}`); // a user-facing outcome, shown as a toast
        app.toast(`${g.file.name}: ${e.message}`, { kind: 'error', ms: 8000 });
        app.importLog.push({ file: g.file.name, errors: [e.message], warnings: [] });
      }
    }
    app.desktop.workspace.map.zoomToFootprints();
    await importDetections();
  }
  app.openFiles = openFiles;
  // Test and automation hooks (E2E PT-07); not a public API yet (REQ-ARC-17 is R1/R2).
  app.__test = { ...(app.__test ?? {}), serialiseProject, readProject, relink };

  app.openDropped = async (dt, pane) => {
    const files = [];
    for (const it of dt.items ?? []) {
      if (it.kind !== 'file') continue;
      let hd = null;
      try {
        hd = await it.getAsFileSystemHandle?.();
      } catch {}
      // A dropped folder is walked (REQ-ING-03): every file in it is routed by its content.
      if (hd?.kind === 'directory') {
        files.push(...(await walkFolder(hd)));
        continue;
      }
      const f = it.getAsFile();
      if (!f) continue;
      if (hd?.kind === 'file') f.__handle = hd;
      files.push(f);
    }
    if (!files.length && dt.files) files.push(...dt.files);
    const proj = files.find((f) => /\.gwb$/i.test(f.name));
    if (proj) return openProjectFile(proj);
    return openFiles(files, pane);
  };
  // Drops anywhere on the window open into the active pane.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    app.openDropped(e.dataTransfer, app.activePane());
  });

  C.implement('file.openimage', { run: async () => openFiles(await pickFiles(app, { accept: IMAGE_ACCEPT, description: 'Imagery and elevation' })) });
  C.implement('file.opendem', { run: async () => openFiles(await pickFiles(app, { accept: ['.dt0', '.dt1', '.dt2', '.hgt', '.gz', '.tif', '.tiff'], description: 'Elevation' })) });
  C.implement('dem.select', { run: () => C.run('file.opendem') });

  // ---- project ----
  async function save(as = false) {
    const bytes = serialiseProject(app);
    const blob = new Blob([bytes], { type: 'application/zip' });
    const name = `${(app.project()?.name || 'Untitled').replace(/[^\w.-]+/g, '_')}.gwb`;
    const r = await saveBlob(app, blob, { name, handle: as ? null : app.projectHandle, types: ['.gwb'], description: 'GIS Workbench project' });
    if (r.how === 'cancelled') return;
    if (r.handle) app.projectHandle = r.handle;
    app.store.transact(
      'Mark saved',
      (tx) => {
        for (const l of app.store.all('layer')) if (l.saved === false) tx.set(l.id, 'saved', true);
        tx.set('project', 'savedAt', new Date().toISOString());
      },
      { kind: 'load' },
    );
    app.dirty = false;
    await app.journal.clear();
    app.noteRecent?.(name, app.projectHandle);
    app.toast(r.how === 'in-place' ? `Saved ${name} in place` : r.how === 'download' ? `Downloaded ${name} (${fmtBytes(blob.size)})` : r.how === 'export-panel' ? 'Use the export panel to keep the project' : `Saved ${name}`);
    app.emit('state');
  }
  C.implement('file.save', { run: () => save(false) });
  C.implement('file.saveas', { run: () => save(true) });

  async function openProjectFile(file, { attach = null } = {}) {
    let parsed;
    try {
      parsed = readProject(new Uint8Array(await file.arrayBuffer()));
    } catch (e) {
      app.importLog?.push({ file: file.name, errors: [e.message], warnings: [] });
      return app.toast(`${file.name}: ${e.message}`, { kind: 'error', ms: 8000 });
    }
    const warnings = [];
    for (const mp of [...app.desktop.multiports]) app.desktop.removeMultiport(mp);
    for (const l of app.layers.all()) l.dispose();
    app.layers.clear();
    app.files.clear();
    app.store.load(parsed.records);
    app.undo.clear();
    app.projectHandle = file.__handle ?? null;
    for (const mp of app.store.all('multiport')) {
      const m = app.desktop.addMultiport(mp.id);
      for (const p of m.panes) if (parsed.views.views?.[p.id]) Object.assign(p.view, parsed.views.views[p.id]);
      m.docks.restore(parsed.views.docks?.[mp.id]);
    }
    app.emit('layers');
    const refs = app.store.all('fileref');
    if (attach) {
      // A snapshot carries its own files, keyed by file reference.
      for (const r of refs) {
        const a = attach.get(r.id);
        if (!a) continue;
        try {
          await attachFile(app, r, a.file, a.sidecars);
        } catch (e) {
          app.toast(`${a.file.name}: ${e.message}`, { kind: 'error' });
        }
      }
      app.emit('layers');
      const missing = refs.filter((r) => !app.files.has(r.id));
      if (missing.length) app.toast(`${missing.length} image file(s) were too large for the snapshot; use File ▸ Relink Imagery`, { kind: 'warn', ms: 8000 });
    } else if (refs.length) {
      // Automation and tests (like zipPick): 'skip' leaves the imagery to File ▸ Relink Imagery.
      if (app.relinkPick === 'skip') warnings.push(`${refs.length} image file(s) to relink (File ▸ Relink Imagery)`);
      else await relinkDialog(refs);
    }
    app.dirty = false;
    app.noteRecent?.(file.name, file.__handle ?? null);
    app.importLog?.push({ file: file.name, errors: [], warnings });
    app.toast(`Opened project ${parsed.manifest.project}`);
  }
  app.openProjectFile = openProjectFile;

  // ---- snapshot (REQ-ARC-19): the tool, the project and its smaller files in one HTML ----
  const b64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  async function snapshotHtml({ maxFileMB = 25, maxTotalMB = 100 } = {}) {
    const project = serialiseProject(app);
    const files = [];
    const skipped = [];
    let total = project.length;
    for (const r of app.store.all('fileref')) {
      const f = app.files.get(r.id);
      if (!f?.file) {
        skipped.push({ name: r.name, size: r.size, why: 'not linked' });
        continue;
      }
      const side = f.sidecars ?? [];
      const size = f.file.size + side.reduce((s, x) => s + x.size, 0);
      if (f.file.size > maxFileMB * 1048576 || total + size > maxTotalMB * 1048576) {
        skipped.push({ name: r.name, size: f.file.size, why: 'too large' });
        continue;
      }
      total += size;
      files.push({ ref: r.id, name: f.file.name, type: f.file.type, data: b64(new Uint8Array(await f.file.arrayBuffer())), sidecars: await Promise.all(side.map(async (x) => ({ name: x.name, data: b64(new Uint8Array(await x.arrayBuffer())) }))) });
    }
    const payload = { format: 'gw-snapshot', version: 1, created: new Date().toISOString(), project: b64(project), files, skipped };
    const json = JSON.stringify(payload).replace(/</g, '\\u003c');
    const html = templateHtml();
    const at = html.lastIndexOf('</body>');
    return { html: `${html.slice(0, at)}<script type="application/json" id="gw-snapshot">${json}</script>\n${html.slice(at)}`, files: files.length, skipped, bytes: total };
  }
  async function openSnapshot(el) {
    const s = JSON.parse(el.textContent);
    if (s.format !== 'gw-snapshot') return;
    const attach = new Map(s.files.map((f) => [f.ref, { file: new File([unb64(f.data)], f.name, { type: f.type }), sidecars: f.sidecars.map((x) => new File([unb64(x.data)], x.name)) }]));
    await openProjectFile(new File([unb64(s.project)], 'snapshot.gwb'), { attach });
    app.snapshotInfo = { created: s.created, files: s.files.length, skipped: s.skipped };
  }
  app.snapshotHtml = snapshotHtml;
  // After every ready handler (docks, panels) has run for the first multiport.
  app.on('ready', () =>
    setTimeout(() => {
      const el = document.getElementById('gw-snapshot');
      if (el) openSnapshot(el).catch((e) => app.toast(`Snapshot: ${e.message}`, { kind: 'error', ms: 8000 }));
    }, 0),
  );
  C.implement('file.snapshot', {
    enabled: () => app.store.all('layer').length > 0,
    run: async () => {
      try {
        const r = await snapshotHtml();
        const name = `${(app.project()?.name || 'snapshot').replace(/[^\w.-]+/g, '_')}-snapshot.html`;
        await saveBlob(app, new Blob([r.html], { type: 'text/html' }), { name, types: ['.html'], description: 'GIS Workbench snapshot' });
        app.toast(`Snapshot: ${r.files} file(s) embedded${r.skipped.length ? `; ${r.skipped.length} left out (${r.skipped.map((x) => x.name).join(', ')})` : ''}`, { ms: 8000 });
      } catch (e) {
        app.toast(`Snapshot: ${e.message}`, { kind: 'error' });
      }
    },
  });
  C.implement('file.openproject', { run: async () => {
    const [f] = await pickFiles(app, { multiple: false, accept: ['.gwb'], description: 'GIS Workbench project' });
    if (f) await openProjectFile(f);
  } });

  async function relinkDialog(refs = app.store.all('fileref').filter((r) => !app.files.has(r.id))) {
    if (!refs.length) return app.toast('All imagery is linked');
    const list = h('ul', { class: 'relink-list' }, refs.map((r) => h('li', { 'data-ref': r.id }, `${r.name} — ${fmtBytes(r.size)} — ${r.fingerprint.slice(0, 12)}…`)));
    const res = await modal({ title: 'Relink Imagery', body: h('div', {}, h('p', {}, `${refs.length} image file${refs.length > 1 ? 's are' : ' is'} referenced by this project. Pick the files (or several at once); they are matched by fingerprint, not by name.`), list), buttons: ['Pick Files…', 'Later'], id: 'relink' });
    if (res !== 'Pick Files…') return;
    const files = await pickFiles(app, { accept: IMAGE_ACCEPT, description: 'Imagery' });
    const groups = groupFiles(files);
    const r = await relink(refs, groups.map((g) => g.file));
    for (const [refId, file] of r.linked) {
      const ref = app.store.get(refId);
      const g = groups.find((x) => x.file === file);
      try {
        await attachFile(app, ref, file, g?.sidecars ?? []);
      } catch (e) {
        app.toast(`${file.name}: ${e.message}`, { kind: 'error' });
      }
    }
    for (const m of r.mismatched) app.toast(`${m.file.name} has the right name but a different fingerprint; it was not linked (REQ-ARC-09)`, { kind: 'warn', ms: 8000 });
    app.emit('layers');
    app.emit('state');
    if (r.missing.length) app.toast(`${r.missing.length} file(s) still missing; use File ▸ Relink Imagery`, { kind: 'warn' });
  }
  app.relinkDialog = relinkDialog;
  C.implement('file.relink', { run: () => relinkDialog() });

  C.implement('file.newproject', {
    run: async () => {
      if (app.dirty && !(await confirmBox('New Project', 'Discard unsaved changes in this project?', { ok: 'Discard', cancel: 'Cancel' }))) return;
      for (const mp of [...app.desktop.multiports]) app.desktop.removeMultiport(mp);
      const id = app.newProject();
      app.desktop.addMultiport(id);
      app.projectHandle = null;
      app.dirty = false;
      app.emit('layers');
    },
  });

  C.implement('file.projectprops', {
    run: async () => {
      const p = app.project();
      const nm = h('input', { class: 'inp', value: p.name, spellcheck: 'true' });
      const rcpt = h('input', { class: 'inp', type: 'email', value: p.feedbackRecipient || FEEDBACK_EMAIL, placeholder: FEEDBACK_EMAIL });
      const body = h('div', {}, field('Project name', nm), field('Feedback recipient', rcpt, 'Used to pre-fill whiteboard e-mail drafts. Nothing is sent without your click.'), h('p', { class: 'hint' }, `Created ${p.created}. Imagery files: ${app.store.all('fileref').length}. Origins added: ${(p.origins ?? []).length || 'none'}.`));
      if ((await modal({ title: 'Project Properties', body, buttons: ['OK', 'Cancel'], id: 'project-props' })) !== 'OK') return;
      app.store.transact('Project properties', (tx) => {
        tx.set('project', 'name', nm.value || 'Untitled');
        tx.set('project', 'feedbackRecipient', rcpt.value.trim());
      });
    },
  });

  C.implement('edit.history', {
    run: () => {
      const items = app.undo.history();
      const body = h('div', { class: 'history' }, items.length ? h('ol', {}, items.map((x) => h('li', { class: x.state }, `${x.state === 'redo' ? '↷ ' : ''}${x.label} — ${new Date(x.ts).toLocaleTimeString()}${x.author !== 'user' ? ` (${x.author})` : ''}`))) : h('p', {}, 'No edits yet.'));
      modal({ title: 'History', body, buttons: ['Close'], id: 'history' });
    },
  });
  C.implement('qat.undo', { run: () => app.undo.undo(), enabled: () => app.undo.canUndo });
  C.implement('qat.redo', { run: () => app.undo.redo(), enabled: () => app.undo.canRedo });
  app.undo.on('change', () => app.emit('state'));

  // Crash recovery offer (REQ-ARC-11).
  const rec = await app.journal.recoverable();
  if (rec && (rec.changesets?.length || rec.snapshot || rec.enc)) {
    app.on('ready', () =>
      app.toast(`Unsaved work from ${new Date(rec.updated).toLocaleString()} was found (${rec.enc ? `${rec.count} edits, encrypted` : `${rec.changesets.length} edits`}). Its imagery must be relinked.`, {
        ms: 15000,
        action: {
          label: 'Recover',
          run: async () => {
            if (rec.enc) {
              const pass = await promptBox('Recover Encrypted Journal', 'Session passphrase', '', { placeholder: 'the passphrase set in Save Options' });
              if (!pass) return;
              try {
                Object.assign(rec, await app.journal.unseal(rec, pass));
              } catch (e) {
                return app.toast(`Recovery: ${e.message}`, { kind: 'error' });
              }
            }
            const base = rec.snapshot ?? app.store.snapshot();
            app.store.load(base);
            for (const cs of rec.changesets) {
              try {
                app.store.applyChangeSet(cs, { kind: 'load' });
              } catch (e) {
                app.log('warn', `recovery: skipped "${cs.label}": ${e.message}`);
              }
            }
            for (const mp of [...app.desktop.multiports]) app.desktop.removeMultiport(mp);
            for (const mp of app.store.all('multiport')) app.desktop.addMultiport(mp.id);
            app.emit('layers');
            await relinkDialog(app.store.all('fileref'));
          },
        },
      }),
    );
  }
}
