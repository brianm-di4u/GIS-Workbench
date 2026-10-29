// File roles in corpus.json: primary (opened by the app), sidecar (dropped with its primary),
// metadata/truth (oracle inputs), archive (unpacked by fetch.mjs).
/** Sidecars travel with a primary file; metadata/truth files are inputs to oracles, not to the app's open path. */
export function roleOf(name) {
  const n = name.toLowerCase();
  if (/_truth\.json$/.test(n)) return 'truth';
  if (/\.(aux\.xml|[jpt]fw|[jp]gw|wld|prj|cpg|hdr|clr|ovr|imd|rpb|sdw|tifw|dbf|shx|sbn|sbx|qix|til)$/.test(n)) return 'sidecar';
  // Schemas, Maxar delivery manifests and ephemeris/attitude/geometry files: oracle inputs, never opened alone.
  if (/\.(txt|json|xml|xsl|xsd|html?|readme|info|plog|md|log|man|att|eph|geo)$|_eph$/.test(n) && !/\.geojson$/.test(n)) return 'metadata';
  // Tiles of a tile set (quantized-mesh .terrain, implicit-tiling content) open through the set, not one by one.
  if (/\.terrain$/.test(n) || /(^|\/)content\/[^/]+\.(glb|b3dm|i3dm|pnts|cmpt)$/.test(n)) return 'tile';
  if (/(^|\/)(readme|version|changelog|license|licence|copying|notice)[^/.]*$/i.test(name)) return 'metadata';
  return 'primary';
}
