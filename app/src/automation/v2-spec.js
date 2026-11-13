// Automation API v2 (REQ-GAP-01, GR-01): the published contract. One table of methods, each with
// its parameters as a JSON schema (the subset the AI registry validates: type, enum, minimum,
// maximum, required, additionalProperties), whether it changes the project, the release it
// appeared in and its result type. Everything else is derived from this table:
//   - the run-time API (`gisworkbench.api.v2`, automation/api-v2.js) checks every call against it;
//   - the MCP tools (`gw2_*`, ai/tools-auto.js) are generated from it;
//   - the typed reference `docs/api/gisworkbench-api-3.d.ts` is generated from it
//     (build/api-dts.mjs) and a unit test fails when the committed file differs;
//   - tests/unit/api-v2-contract.test.js holds the frozen 2.0.0 surface: a later 2.x may add
//     methods and optional parameters, never remove or rename them or add a required one.
//
// Semantic versioning: API_VERSION is MAJOR.MINOR.PATCH of this table, independent of the app
// version. v1 (`gisworkbench.api`, 12 methods, `api: 1`) is unchanged and keeps working.
//
// Developer API text (DN-62 rule 7): summaries and errors stay English for scripts and AI models.

export const API_VERSION = '3.0.0';

const str = (description, extra = {}) => ({ type: 'string', ...(description ? { description } : {}), ...extra });
const num = (description, extra = {}) => ({ type: 'number', ...(description ? { description } : {}), ...extra });
const int = (description, extra = {}) => ({ type: 'integer', ...(description ? { description } : {}), ...extra });
const bool = (description) => ({ type: 'boolean', ...(description ? { description } : {}) });
const arr = (description, items, extra = {}) => ({ type: 'array', ...(description ? { description } : {}), ...(items ? { items } : {}), ...extra });
const anyObj = (description) => ({ type: 'object', ...(description ? { description } : {}) });
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const LAYER = str('Image layer id (layers.list); the active panel\'s image when omitted');
const VLAYER = str('Vector layer id (vectors.list)');
const LONLAT = arr('[lon, lat] or [lon, lat, h] in degrees (WGS 84) and metres HAE', { type: 'number' });
const SAVE = bool('true: write the file through the save dialog or a download; false (default): return it in the result (headless)');
const BOX = arr('Image pixel box [x0, y0, x1, y1]', { type: 'number' });

/**
 * Methods. `readOnly`: does not change the project (MCP runs it directly; other methods become
 * proposals the analyst accepts). `files`: takes File objects, so it is JavaScript only (no MCP
 * tool). `dialog`: may open a dialog (only commands.run). `returns`: a TypeScript type name or
 * expression for the reference.
 */
export const METHODS = {
  // ---- meta ----
  'api.version': { since: '2.0.0', readOnly: true, summary: 'The API version (semantic), the v1 level kept, and the app version and build.', params: obj(), returns: 'ApiVersion' },
  'api.describe': { since: '2.0.0', readOnly: true, summary: 'Every method with its parameter schema, result type and whether it changes the project.', params: obj({ method: str('One method name; all when omitted') }), returns: 'MethodInfo[]' },
  'events.recent': { since: '2.0.0', readOnly: true, summary: 'Events kept in the ring (the last 500): layer, selection, view and job changes, newest last. Poll with `since` (the last seq seen); in JavaScript, on() delivers them as they happen.', params: obj({ since: int('Return events with seq greater than this', { minimum: 0 }), types: arr('Event types to keep: layer, selection, view, job', { type: 'string', enum: ['layer', 'selection', 'view', 'job'] }), limit: int('At most this many (default 200)', { minimum: 1, maximum: 500 }) }), returns: 'ApiEvent[]' },

  // ---- layers and vectors ----
  'layers.list': { since: '2.0.0', readOnly: true, summary: 'Open image, DEM and video layers.', params: obj(), returns: 'LayerInfo[]' },
  'layers.open': { since: '2.0.0', readOnly: false, files: true, summary: 'Open image, vector, DEM, pack or project files (File objects) as if dropped. Returns the new image layer ids.', params: obj({ files: arr('File objects', null) }, ['files']), returns: 'string[]' },
  'layers.activate': { since: '2.0.0', readOnly: false, summary: 'Make a layer the active one of its panel (the target of image tools).', params: obj({ layer: str('Image layer id') }, ['layer']), returns: 'LayerInfo' },
  'vectors.list': { since: '2.0.0', readOnly: true, summary: 'Vector layers with their feature counts, fields and feature-catalogue schema.', params: obj(), returns: 'VectorLayerInfo[]' },
  'vectors.features': { since: '2.0.0', readOnly: true, summary: 'Features of a vector layer as GeoJSON, optionally filtered by one attribute.', params: obj({ layer: VLAYER, field: str('Attribute to filter on'), op: str('Comparison', { enum: ['=', '≠', '<', '>', '≤', '≥', 'contains'] }), value: { type: ['string', 'number', 'boolean'], description: 'Value to compare with' }, offset: int('Skip this many', { minimum: 0 }), limit: int('At most this many (default 500)', { minimum: 1, maximum: 10000 }) }, ['layer']), returns: 'FeatureCollection' },
  'vectors.addGeoJson': { since: '2.0.0', readOnly: false, summary: 'Add a GeoJSON FeatureCollection (WGS 84) as a new vector layer.', params: obj({ name: str('Layer name'), geojson: anyObj('A GeoJSON FeatureCollection, Feature or geometry') }, ['geojson']), returns: '{ layer: string; features: number }' },
  'vectors.export': { since: '2.0.0', readOnly: true, summary: 'Encode a vector layer as GeoJSON, KML, KMZ, zipped shapefile or CSV.', params: obj({ layer: VLAYER, format: str('Output format', { enum: ['geojson', 'kml', 'kmz', 'shp', 'csv'] }), save: SAVE }, ['layer', 'format']), returns: 'FileResult' },

  // ---- view and selection ----
  'view.get': { since: '2.0.0', readOnly: true, summary: 'The active panel view: centre in image pixels and on the ground, zoom, rotation.', params: obj(), returns: 'ViewInfo' },
  'view.set': { since: '2.0.0', readOnly: true, summary: 'Set the active panel view (image pixels, zoom 1 = one image pixel per screen pixel, rotation in radians).', params: obj({ cx: num('Centre x (image pixels)'), cy: num('Centre y (image pixels)'), zoom: num('Zoom', { minimum: 0 }), rot: num('Rotation (radians)') }), returns: 'ViewInfo' },
  'view.jumpTo': { since: '2.0.0', readOnly: true, summary: 'Centre the active panel on a coordinate: text in any supported notation (MGRS, DD, DMS, UTM) or lat/lon.', params: obj({ text: str('Coordinate text'), lat: num('Latitude (degrees)', { minimum: -90, maximum: 90 }), lon: num('Longitude (degrees)', { minimum: -180, maximum: 360 }) }), returns: 'ViewInfo' },
  'view.zoomToLayer': { since: '2.0.0', readOnly: true, summary: 'Fit a vector layer (or the whole image when omitted) in the active panel.', params: obj({ layer: str('Vector layer id; the whole image when omitted') }), returns: 'ViewInfo' },
  'selection.get': { since: '2.0.0', readOnly: true, summary: 'The selected items (graphics, features, measurements) with their type.', params: obj(), returns: 'SelectionItem[]' },
  'selection.set': { since: '2.0.0', readOnly: true, summary: 'Replace the selection with these ids (unknown ids are ignored).', params: obj({ ids: arr('Record ids', { type: 'string' }) }, ['ids']), returns: 'SelectionItem[]' },
  'selection.byAttribute': { since: '2.0.0', readOnly: true, summary: 'Select the features of a layer whose attribute matches.', params: obj({ layer: VLAYER, field: str('Attribute'), op: str('Comparison', { enum: ['=', '≠', '<', '>', '≤', '≥', 'contains'] }), value: { type: ['string', 'number', 'boolean'] } }, ['layer', 'field', 'value']), returns: 'SelectionItem[]' },

  // ---- coordinates and measurement (all numbers from the Rust core) ----
  'geo.groundPoint': { since: '2.0.0', readOnly: true, summary: 'Image (x, y) to ground through the sensor model and the terrain.', params: obj({ x: num('Image x (pixels)'), y: num('Image y (pixels)'), layer: LAYER }, ['x', 'y']), returns: 'GroundPoint' },
  'geo.imagePoint': { since: '2.0.0', readOnly: true, summary: 'Ground to image (x, y); height from the terrain when not given.', params: obj({ lat: num('Latitude'), lon: num('Longitude'), h: num('Height HAE (m)'), layer: LAYER }, ['lat', 'lon']), returns: '{ x: number; y: number; h: number }' },
  'geo.parse': { since: '2.0.0', readOnly: true, summary: 'Parse coordinate text in any supported notation.', params: obj({ text: str('Coordinate text') }, ['text']), returns: '{ lat: number; lon: number; format: string; precisionM?: number }' },
  'geo.format': { since: '2.0.0', readOnly: true, summary: 'Format a position in a notation: 0 DD, 1 DMS, 2 DM, 3 MGRS, 4 UTM.', params: obj({ lat: num('Latitude'), lon: num('Longitude'), format: int('Notation', { minimum: 0, maximum: 4 }), precision: int('Digits', { minimum: 0, maximum: 10 }) }, ['lat', 'lon']), returns: 'string' },
  'measure.distance': { since: '2.0.0', readOnly: true, summary: 'Geodesic length of a path (WGS 84) and the azimuth of each leg.', params: obj({ points: arr('[[lon, lat], …]', LONLAT) }, ['points']), returns: '{ metres: number; legs: { metres: number; azimuth: number }[] }' },
  'measure.area': { since: '2.0.0', readOnly: true, summary: 'Geodesic area and perimeter of a ring (WGS 84).', params: obj({ ring: arr('[[lon, lat], …]', LONLAT) }, ['ring']), returns: '{ squareMetres: number; perimeterMetres: number }' },
  'measure.lineOfSight': { since: '2.0.0', readOnly: true, summary: 'Whether two ground points see each other over the loaded terrain (curvature and refraction k = 0.13).', params: obj({ from: LONLAT, to: LONLAT, observerH: num('Observer height above ground (m)'), targetH: num('Target height above ground (m)'), samples: int('Profile samples', { minimum: 16, maximum: 4096 }) }, ['from', 'to']), returns: '{ visible: boolean; minClearance: number; blocked: { lat: number; lon: number; d: number } | null; lengthMetres: number }' },
  'measure.volume': { since: '2.0.0', readOnly: true, summary: 'Cut and fill volume of the terrain inside a ring against a plane through the vertices, the lowest vertex or a constant height.', params: obj({ ring: arr('[[lon, lat], …]', LONLAT), reference: str('Reference surface', { enum: ['plane', 'lowest', 'constant'] }), height: num('Constant reference height HAE (m)') }, ['ring']), returns: 'Record<string, unknown>' },

  // ---- graphics and imagery ----
  'graphics.create': { since: '2.0.0', readOnly: false, summary: 'A ground graphic in the active panel (as v1 createGraphic).', params: obj({ shape: str('Shape', { enum: ['marker', 'polyline', 'polygon', 'rect', 'ellipse', 'text'] }), coordinates: arr('[[lon, lat(, h)], …]', LONLAT), text: str('Label'), style: anyObj('{stroke, width, fill}') }, ['coordinates']), returns: 'string' },
  'graphics.list': { since: '2.0.0', readOnly: true, summary: 'Graphics of the project.', params: obj({ pane: str('Only this panel') }), returns: 'GraphicInfo[]' },
  'graphics.delete': { since: '2.0.0', readOnly: false, summary: 'Delete graphics by id (one undoable step).', params: obj({ ids: arr('Graphic ids', { type: 'string' }) }, ['ids']), returns: 'number' },
  'image.setChain': { since: '2.0.0', readOnly: false, summary: 'Set the image chain (as v1 setChain).', params: obj({ layer: LAYER, stretch: str('Stretch'), draScope: str('DRA scope'), brightness: num(), contrast: num(), gamma: num(), saturation: num(), invert: bool(), palette: str('Palette'), interpolation: str('Resampling kernel') }), returns: 'string' },
  'image.autoContrast': { since: '2.0.0', readOnly: false, summary: 'Auto Contrast (CLAHE and gamma from the histogram, REQ-LAI-07).', params: obj({ layer: LAYER }), returns: '{ clip: number; gamma: number }' },
  'image.spectralIndex': { since: '2.0.0', readOnly: false, summary: 'Show a spectral index of a multispectral layer (NDVI, NDWI…; the keys the layer offers).', params: obj({ layer: LAYER, index: str('Index key, for example ndvi') }, ['index']), returns: 'string' },
  'image.bandMath': { since: '2.0.0', readOnly: false, summary: 'Show a band-math expression (b1…bn) of a multispectral layer.', params: obj({ layer: LAYER, expression: str('Expression, for example (b4-b3)/(b4+b3)'), palette: str('Palette') }, ['expression']), returns: 'string' },

  // ---- analysis ----
  'analysis.viewshed': { since: '2.0.0', readOnly: true, summary: 'Viewshed over the terrain from one or more observers; returns the statistics, and with show: true adds the overlay layer.', params: obj({ observers: arr('[[lon, lat], …]', LONLAT), observerH: num('Observer height above ground (m)'), targetH: num('Target height above ground (m)'), maxDist: num('Maximum range (m); 0 unlimited', { minimum: 0 }), curvature: bool('Earth curvature and refraction'), inverse: bool('Where the observer can be seen from'), show: bool('Open the result as an overlay layer') }, ['observers']), returns: 'Record<string, unknown>' },
  'analysis.hlz': { since: '2.0.0', readOnly: true, summary: 'Helicopter landing zones on a DSM by doctrine.', params: obj({ doctrine: str('Doctrine', { enum: ['light', 'medium', 'heavy'] }), centre: LONLAT, radius: num('AOI radius (m)', { minimum: 0 }) }), returns: 'Record<string, unknown>' },
  'analysis.contours': { since: '2.0.0', readOnly: false, summary: 'Contour lines of the terrain as a vector layer.', params: obj({ interval: num('Interval (m)', { minimum: 0.01 }), indexEvery: int('Index line every n lines', { minimum: 2 }) }, ['interval']), returns: '{ layer: string; lines: number; index: number }' },
  'analysis.demDifference': { since: '2.0.0', readOnly: true, summary: 'DEM difference A − B statistics, with optional co-registration.', params: obj({ a: str('DEM name or layer id'), b: str('DEM name or layer id'), coregister: bool() }, ['a', 'b']), returns: 'Record<string, unknown>' },
  'analysis.autoAlign': { since: '2.0.0', readOnly: false, summary: 'Auto Align the active image to the reference by classical tie points (affine or projective).', params: obj({ kind: str('Fit', { enum: ['affine', 'projective'] }) }), returns: 'Record<string, unknown>' },

  // ---- extraction ----
  'extract.createFeature': { since: '2.0.0', readOnly: false, summary: 'Capture a feature on the active vector layer (or a new one) from ground coordinates, optionally squared, with attributes checked against its feature catalogue.', params: obj({ type: str('Geometry', { enum: ['Point', 'LineString', 'Polygon'] }), coordinates: arr('[[lon, lat(, h)], …]', LONLAT), layer: VLAYER, square: bool('Square the corners (polygons)'), attrs: anyObj('Attribute values') }, ['type', 'coordinates']), returns: '{ feature: string; layer: string; issues: AttributeIssue[] }' },
  'extract.setAttributes': { since: '2.0.0', readOnly: false, summary: 'Set attributes of a feature; every value is checked against the feature catalogue (domain, range, type) and nothing is set when one fails.', params: obj({ feature: str('Feature id'), attrs: anyObj('Values by attribute name') }, ['feature', 'attrs']), returns: '{ feature: string; attrs: Record<string, unknown> }' },
  'extract.validate': { since: '2.0.0', readOnly: true, summary: 'Attribute issues of a schema layer, including conditional rules.', params: obj({ layer: VLAYER }, ['layer']), returns: 'AttributeIssue[]' },
  'extract.newSchemaLayer': { since: '2.0.0', readOnly: false, summary: 'A new vector layer for a feature class of a catalogue (the layer fields come from the catalogue).', params: obj({ code: str('Feature class code, for example AL013'), catalog: str('Catalogue id (catalogs.list)'), subtype: str('Subtype code, when the class has subtypes'), name: str('Layer name') }, ['code']), returns: 'string' },
  'catalogs.list': { since: '2.0.0', readOnly: true, summary: 'Feature catalogues available: built-in, from data packs, imported by the user and from GeoPackages.', params: obj(), returns: 'CatalogInfo[]' },
  'catalogs.get': { since: '2.0.0', readOnly: true, summary: 'One feature class of a catalogue with its attributes, subtypes and rules.', params: obj({ catalog: str('Catalogue id'), code: str('Feature class code') }, ['code']), returns: 'Record<string, unknown>' },
  'catalogs.import': { since: '2.0.0', readOnly: false, summary: 'Import a feature catalogue (gw-catalog/1 JSON) into the project and the settings.', params: obj({ catalog: anyObj('The catalogue JSON'), keep: str('Where to keep it', { enum: ['project', 'settings', 'both'] }) }, ['catalog']), returns: 'CatalogInfo' },
  'detections.list': { since: '2.0.0', readOnly: true, summary: 'Detections in the review queue.', params: obj({ status: str('Status', { enum: ['pending', 'accepted', 'rejected'] }), limit: int('At most this many', { minimum: 1, maximum: 10000 }) }), returns: 'DetectionInfo[]' },
  'detections.add': { since: '2.0.0', readOnly: false, summary: 'Add detections to the review queue (image pixel boxes on a layer, or ground points).', params: obj({ detections: arr('[{cls, confidence, box?: [x0,y0,x1,y1], point?: [lon,lat]}]', anyObj()), layer: LAYER, source: str('Source label') }, ['detections']), returns: 'number' },
  'detections.setStatus': { since: '2.0.0', readOnly: false, summary: 'Accept or reject detections.', params: obj({ ids: arr('Detection ids', { type: 'string' }), status: str('Status', { enum: ['pending', 'accepted', 'rejected'] }) }, ['ids', 'status']), returns: 'number' },
  'observations.add': { since: '2.0.0', readOnly: false, summary: 'Add an observation at a place (the panel centre when lat/lon are omitted).', params: obj({ text: str('Observation text'), category: str('Category'), confidence: str('Confidence', { enum: ['low', 'moderate', 'high'] }), lat: num(), lon: num(), graphics: arr('Linked graphic ids', { type: 'string' }), features: arr('Linked feature ids', { type: 'string' }) }, ['text']), returns: 'string' },

  // ---- local AI (results are candidates or drafts; numbers come from the tool, D30) ----
  'ai.find': { since: '2.0.0', readOnly: false, summary: 'Open-vocabulary detection (OWLv2) of the named objects in the view or over the whole scene as a job; results go to the review queue.', params: obj({ objects: arr('What to find', { type: 'string' }), threshold: num('Score threshold', { minimum: 0, maximum: 1 }), scope: str('view (default) or scene', { enum: ['view', 'scene'] }), layer: LAYER, batch: int('Tiles per model run (scene)', { minimum: 1, maximum: 8 }), commit: bool('Add to the review queue (default true)') }, ['objects']), returns: 'FindResult' },
  'ai.search': { since: '2.0.0', readOnly: false, summary: 'CLIP search of the image for a text; the best places are outlined.', params: obj({ text: str('What to look for'), k: int('How many places', { minimum: 1, maximum: 50 }), layer: LAYER }, ['text']), returns: '{ hits: { x0: number; y0: number; size: number; score: number }[]; chips: number; device: string }' },
  'ai.segment': { since: '2.0.0', readOnly: false, summary: 'SAM outline of the object at image (x, y) as a polygon graphic, optionally squared.', params: obj({ x: num('Image x'), y: num('Image y'), layer: LAYER, square: bool('Square the corners') }, ['x', 'y']), returns: 'Record<string, unknown>' },
  'ai.align': { since: '2.0.0', readOnly: false, summary: 'Auto Align (AI): DISK + LightGlue tie points and a robust fit to the reference image.', params: obj({ kind: str('Fit', { enum: ['affine', 'projective'] }) }), returns: 'Record<string, unknown>' },
  'ai.changeMask': { since: '2.0.0', readOnly: false, summary: 'Change mask between the active image and the reference (after alignment): changed regions become candidates in the change list and, optionally, polygons.', params: obj({ threshold: num('Change threshold in standard deviations (default 2.5)', { minimum: 0.5, maximum: 10 }), minArea: num('Smallest region (image pixels²)', { minimum: 0 }), polygons: bool('Also add the regions as a vector layer') }), returns: 'ChangeMaskResult' },
  'ai.describe': { since: '2.0.0', readOnly: false, summary: 'Draft an observation for an image box with the local vision-language model (Moondream2). The draft is a proposal labelled AI; it never sets a measurement.', params: obj({ box: BOX, question: str('What to ask (default: describe for an analyst)'), count: str('Count these objects instead (the count is a draft)'), layer: LAYER }), returns: 'DraftResult' },
  'ai.models.list': { since: '2.0.0', readOnly: true, summary: 'The shipped model packs and the user models added in this browser.', params: obj(), returns: 'ModelInfo[]' },
  'ai.models.add': { since: '2.0.0', readOnly: false, files: true, summary: 'Add a user ONNX model: a gw-model/1 descriptor (task, input spec, SPDX licence, SHA-256) and its .onnx file. Refused when the hash, licence or input spec does not check.', params: obj({ descriptor: anyObj('The gw-model/1 descriptor'), model: anyObj('The .onnx File') }, ['descriptor', 'model']), returns: 'ModelInfo' },
  'ai.models.run': { since: '2.0.0', readOnly: false, summary: 'Run a model (a user model or a shipped pixel classifier) on the view, a box or the whole scene; detections go to the review queue, masks and classes become an overlay and polygons.', params: obj({ model: str('Model id (ai.models.list)'), scope: str('Region', { enum: ['view', 'scene', 'box'] }), box: BOX, layer: LAYER, threshold: num('Score threshold (detection, segmentation)', { minimum: 0, maximum: 1 }) }, ['model']), returns: 'ModelRunResult' },

  // ---- products (files come back in the result unless save is true) ----
  'products.chip': { since: '2.0.0', readOnly: true, summary: 'A chip of the active panel with caption, north arrow and scale bar (PNG).', params: obj({ width: int('Width (px)', { minimum: 64, maximum: 8192 }), height: int('Height (px)', { minimum: 64, maximum: 8192 }), save: SAVE }), returns: 'ChipResult' },
  'products.report': { since: '2.0.0', readOnly: true, summary: 'The product report of the project as HTML or DOCX.', params: obj({ format: str('Format', { enum: ['html', 'docx'] }), title: str('Report title'), save: SAVE }), returns: 'FileResult' },
  'products.cog': { since: '2.0.0', readOnly: true, summary: 'A Cloud-Optimized GeoTIFF of an image layer.', params: obj({ layer: LAYER, save: SAVE }), returns: 'FileResult' },
  'products.deck': { since: '2.0.0', readOnly: true, summary: 'The session chip deck as PowerPoint.', params: obj({ save: SAVE }), returns: 'FileResult' },

  // ---- recipes (headless runner) ----
  'recipes.list': { since: '2.0.0', readOnly: true, summary: 'Built-in recipes, workflows saved in the project, and the library.', params: obj(), returns: '{ id: string; name: string; steps: number; builtin: boolean; source: "builtin" | "project" | "library"; clash?: true }[]' },
  'recipes.ops': { since: '2.0.0', readOnly: true, summary: 'The operations a recipe step can run, with their default parameters, parameter schema and typed inputs and outputs (gw-recipe/2).', params: obj(), returns: '{ op: string; title: string; defaults: Record<string, unknown>; gate: boolean; schema: Record<string, { type: string; min?: number; max?: number; unit?: string; values?: unknown[]; default?: unknown; label?: string }>; inputs: { name: string; type: string }[]; outputs: { name: string; type: string }[] }[]' },
  'recipes.validate': { since: '2.0.0', readOnly: true, summary: 'Check a gw-recipe/1 or gw-recipe/2 JSON recipe; returns it normalised as gw-recipe/2 or throws naming the problem.', params: obj({ recipe: anyObj('The recipe JSON') }, ['recipe']), returns: 'Record<string, unknown>' },
  'recipes.run': { since: '2.0.0', readOnly: false, summary: 'Run a recipe headless: no dock, no dialogs; files come back in the result. Gates continue (default), stop (the run waits for recipes.resume) or fail.', params: obj({ id: str('Built-in or saved recipe id'), source: str('Which copy, when the project and the library both hold the id and they differ (recipes.list marks it clash)', { enum: ['project', 'library'] }), recipe: anyObj('A recipe JSON instead of an id'), params: anyObj('Parameter overrides by step id: {stepId: {param: value}}'), inputs: anyObj('Values for inputs left unwired: {"stepId.input": value}, such as a layer id'), gates: str('At a gate', { enum: ['continue', 'stop', 'fail'] }), from: int('First step (0-based); a workflow with wires runs from 0', { minimum: 0 }) }), returns: 'RecipeRun' },
  'recipes.resume': { since: '2.0.0', readOnly: false, summary: 'Continue a headless run stopped at a gate.', params: obj({ run: str('Run id') }, ['run']), returns: 'RecipeRun' },
  'recipes.status': { since: '2.0.0', readOnly: true, summary: 'State of a headless run.', params: obj({ run: str('Run id') }, ['run']), returns: 'RecipeRun' },
  'recipes.op': { since: '2.0.0', readOnly: false, summary: 'Run one recipe operation headless with parameters (every recipe operation is callable this way).', params: obj({ op: str('Operation (recipes.ops)'), params: anyObj('Its parameters'), inputs: anyObj('Its inputs by name, such as {layer: id} (recipes.ops lists them)') }, ['op']), returns: '{ summary: string; files: FileResult[] }' },

  // ---- commands and jobs ----
  'commands.list': { since: '2.0.0', readOnly: true, summary: 'Catalogued commands with their state.', params: obj({ filter: str('Substring of the id or label') }), returns: '{ id: string; label: string; enabled: boolean; checked: boolean; implemented: boolean }[]' },
  'commands.run': { since: '2.0.0', readOnly: false, dialog: true, summary: 'Run a catalogued command by id, with an optional argument; most commands open their dialog (use the typed methods for headless work).', params: obj({ id: str('Command id'), args: { type: ['string', 'number', 'boolean', 'object'], description: 'Argument passed to the command' } }, ['id']), returns: 'string' },
  'jobs.list': { since: '2.0.0', readOnly: true, summary: 'Running and recent worker jobs (the Job Queue).', params: obj({ limit: int('At most this many recent ones', { minimum: 1, maximum: 200 }) }), returns: 'JobInfo[]' },
  'jobs.cancel': { since: '2.0.0', readOnly: false, summary: 'Cancel a running or queued job.', params: obj({ id: str('Job id') }, ['id']), returns: 'boolean' },
};

/** Events delivered by on(type, fn) and kept for events.recent. */
export const EVENTS = {
  layer: { summary: 'An image, DEM or vector layer was added, removed or changed.', type: 'LayerEvent' },
  selection: { summary: 'The selection changed.', type: 'SelectionEvent' },
  view: { summary: 'A panel view moved (coalesced to one event per panel per animation frame).', type: 'ViewEvent' },
  job: { summary: 'A worker job was queued, started, progressed (at most every 250 ms), finished, failed or was cancelled.', type: 'JobEvent' },
};

/** Named types of the reference (TypeScript). */
export const TYPES = {
  ApiVersion: '{ api: string; major: number; minor: number; patch: number; v1: 1; app: string | null; build: string | null }',
  MethodInfo: '{ method: string; since: string; summary: string; readOnly: boolean; files: boolean; dialog: boolean; params: JsonSchema; returns: string; mcp: string | null }',
  JsonSchema: 'Record<string, unknown>',
  LonLat: '[number, number] | [number, number, number]',
  LayerInfo: '{ id: string; name: string; kind: string; width: number; height: number; bands: number; format: string | null; model: string | null; pane: string | null; active: boolean }',
  VectorLayerInfo: '{ id: string; name: string; features: number; fields: { name: string; type: string; title?: string }[]; schema: { catalog: string; code: string; name: string; subtype?: string } | null }',
  FeatureCollection: '{ type: "FeatureCollection"; features: { type: "Feature"; id: string; geometry: unknown; properties: Record<string, unknown> }[]; total: number }',
  ViewInfo: '{ pane: string | null; cx: number; cy: number; zoom: number; rot: number; ground: { lat: number; lon: number } | null }',
  SelectionItem: '{ id: string; type: string; layer?: string }',
  GroundPoint: '{ lat: number; lon: number; h: number; heightSource: string | null; mgrs: string }',
  GraphicInfo: '{ id: string; shape: string; anchor: string; text: string; pane: string; coords: number[][] }',
  FileResult: '{ name: string; type: string; size: number; text?: string; blob?: Blob; saved?: string; summary?: string }',
  ChipResult: '{ caption: string; image: string; cornersGround: unknown; metresPerPixel: number; file?: FileResult }',
  AttributeIssue: '{ featureId?: string; field: string; message: string; code: string; rule?: string }',
  CatalogInfo: '{ id: string; name: string; version: string; types: number; attributes: number; source: "builtin" | "pack" | "user" | "geopackage"; kept: ("project" | "settings")[] }',
  DetectionInfo: '{ id: string; n: number; cls: string; confidence: number; status: string; anchor: string; ring: number[][] | null; point: number[] | null; layer: string | null; source: string }',
  FindResult: '{ count: number; counts: Record<string, number>; tiles: number; batches: number; step: number; ms: number; device: string; scope: "view" | "scene"; job?: string }',
  ChangeMaskResult: '{ changedFraction: number; regions: number; threshold: number; mask: { width: number; height: number; step: number }; layer: string | null; candidates: number }',
  DraftResult: '{ text: string; draft: true; model: string; device: string; proposal: string | null; removedMeasurements: string[]; count?: number | null; ms: number; tokens: number }',
  ModelInfo: '{ id: string; title: string; task: "detection" | "segmentation" | "classification"; source: "pack" | "user"; licence: string; sha256: string | null; input: Record<string, unknown> }',
  ModelRunResult: '{ model: string; task: string; device: string; ms: number; tiles: number; detections?: number; classes?: Record<string, number>; layer?: string | null }',
  RecipeRun: '{ run: string; recipe: string; state: "running" | "waiting" | "done" | "failed" | "stopped"; ok: boolean; failed?: number; error?: string; steps: { id: string; op: string; status: string; ms: number | null; summary: string }[]; files: FileResult[] }',
  JobInfo: '{ id: string; op: string; kind: string; label: string; state: string; progress: number; ms: number | null; error?: string }',
  ApiEvent: 'LayerEvent | SelectionEvent | ViewEvent | JobEvent',
  LayerEvent: '{ seq: number; type: "layer"; time: string; action: "added" | "removed" | "changed"; layer: string; kind: string }',
  SelectionEvent: '{ seq: number; type: "selection"; time: string; ids: string[] }',
  ViewEvent: '{ seq: number; type: "view"; time: string; pane: string; cx: number; cy: number; zoom: number; rot: number }',
  JobEvent: '{ seq: number; type: "job"; time: string; id: string; op: string; label: string; state: string; progress: number }',
};

/** The MCP tool name of a method: gw2_ plus the dotted name with underscores (null: JavaScript only). */
export const mcpName = (method) => (METHODS[method]?.files ? null : `gw2_${method.replace(/\./g, '_')}`);

export function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v));
  if (!m) throw new Error(`not a semantic version: ${v}`);
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

/**
 * Compatibility of a newer method table with a frozen one (semver rules for 2.x): every frozen
 * method is still there, keeps its readOnly flag, every frozen parameter still exists with the
 * same type, no new parameter is required. Returns the list of breaks (empty when compatible).
 */
export function compatBreaks(frozen, current) {
  const out = [];
  for (const [name, f] of Object.entries(frozen)) {
    const c = current[name];
    if (!c) {
      out.push(`${name}: removed`);
      continue;
    }
    if (!!f.readOnly !== !!c.readOnly) out.push(`${name}: readOnly changed`);
    const fp = f.params?.properties ?? {};
    const cp = c.params?.properties ?? {};
    for (const [k, s] of Object.entries(fp)) {
      if (!cp[k]) out.push(`${name}: parameter ${k} removed`);
      else if (JSON.stringify(s.type) !== JSON.stringify(cp[k].type)) out.push(`${name}: parameter ${k} changed type`);
    }
    const freq = new Set(f.params?.required ?? []);
    for (const r of c.params?.required ?? []) if (!freq.has(r)) out.push(`${name}: parameter ${r} became required`);
  }
  return out;
}
