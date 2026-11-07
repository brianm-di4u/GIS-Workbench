// File > Save As > GeoPDF Map and the vector layers of opened GeoPDFs (REQ-GAP-66, SDP-2.3 §2
// GR-24). The work is in the lazy js-geopdf block (formats/geopdf-map.js, geopdf-vectors.js,
// geopdf-writer.js); this module hands it the app's own modules once, on first use.

import proj4 from 'proj4';
import { zlibSync } from 'fflate';
import { h } from '../shell/dom.js';
import { modal, field, section } from '../shell/dialogs.js';
import { saveBlob } from '../storage/files.js';
import { makeChip } from '../products/chip.js';
import { toGeoJSON } from '../vector/geom.js';
import { readGeoJSON } from '../vector/io.js';
import { crsOf, converter, sameDatumGeographic } from '../geo/crs.js';
import { layerCrs, wkt1, unitsToMeters } from '../formats/raster-crs.js';
import { pdfFontsFor } from '../formats/font-pack.js';
import { forWorker } from '../connectors/remote.js';
import { t, tr, msgOf, gwError } from '../i18n/index.js';
import { HOST } from './services.js';

export const name = 'geopdf';

export function install(app) {
  const C = app.commands;
  const S = app.store;
  let ready = null;
  const lib = () => {
    // The block's import of the i18n module (its N_ marker) resolves to the app's own (build/host-modules.mjs).
    globalThis.__gwHost = Object.assign(globalThis.__gwHost ?? {}, HOST);
    ready ??= app.gw.runScript('js-geopdf').then((L) => {
      L.init({ proj4, zlibSync, h, modal, field, section, saveBlob, makeChip, toGeoJSON, readGeoJSON, crsOf, converter, sameDatumGeographic, layerCrs, wkt1, unitsToMeters, pdfFontsFor, forWorker, t, tr, msgOf, gwError });
      return { L, map: L.geoPdfMap(app) };
    });
    ready.catch(() => (ready = null));
    return ready;
  };
  const pane = () => app.activePane?.();
  C.implement('file.geopdf', {
    enabled: () => !!pane()?.geoLayer?.()?.modelId || S.all('vlayer').some((v) => v.visible !== false && S.all('feature').some((f) => f.vlayer === v.id)),
    run: async () => (await lib()).map.run(),
  });
  app.geopdf = {
    /** The GeoPDF bytes of the view (formats/geopdf-map.js exportMap). */
    exportMap: async (o) => (await lib()).map.exportMap(o),
    /** A GeoPDF's vector layers into the project (formats/geopdf-vectors.js openGeoPdfVectors). */
    openVectors: async (file, o) => (await lib()).L.openGeoPdfVectors(app, file, o),
  };
}
