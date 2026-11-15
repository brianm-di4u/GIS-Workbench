// The recipe library (SDP-2.8 REG-282): recipes that say what they are for and are checked against
// an oracle. Each entry is a gw-recipe/2 file with the library fields (recipes/recipe.js header):
// a category and keywords for the gallery, an explanation, the recipe's own parameters, the input
// preconditions and a Lite tag. Its strings go through N_() so the catalogue extract finds them;
// the gallery shows them with t().
//
// Each entry has, outside the app (tests/oracles/README.md):
//   fixtures/recipes/<id>/      a small input the regression test runs it on;
//   tests/oracles/<id>/         the oracle's committed outputs and their provenance;
//   tests/e2e/28-recipe-library.spec.js, which runs it in the page and compares.

import { N_ } from '../i18n/index.js';

export const LIBRARY = [
  {
    format: 'gw-recipe/2',
    id: 'folder-to-cog',
    version: 2,
    name: N_('Convert a folder to COG'),
    description: N_('Every raster in a folder becomes a Cloud-Optimized GeoTIFF; vectors become GeoParquet.'),
    category: 'conversion',
    keywords: [N_('cloud optimized'), 'COG', 'GeoTIFF', N_('convert'), N_('tiled'), N_('overviews'), 'GeoParquet', N_('folder')],
    lite: false,
    explanation: {
      what: N_('Writes each raster as a tiled, compressed GeoTIFF with overviews, so a viewer or a web server reads only the part it shows. Each vector file becomes GeoParquet (or FlatGeobuf or GeoJSON).'),
      when: N_('Before you publish imagery or elevation on a web server or object store, or to make a folder of mixed formats quick to open.'),
      limits: N_('The pixel values and the georeferencing are kept exactly; the overviews are averages. Multi-band rasters keep their bands; a MrSID or ECW footprint needs the sidecar. A file in a format Convert does not read stops the run before anything is written.'),
    },
    params: { vectors: { to: ['s1.vectors'], label: N_('Vectors to') } },
    steps: [{ id: 's1', op: 'convertFolder', title: N_('Convert the folder'), params: { vectors: 'geoparquet' } }],
  },
];
