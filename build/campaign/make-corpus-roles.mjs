// File roles in corpus.json: primary (opened by the app), sidecar (dropped with its primary),
// metadata/truth (oracle inputs), archive (unpacked by fetch.mjs).
/** Sidecars travel with a primary file; metadata/truth files are inputs to oracles, not to the app's open path. */
export function roleOf(name) {
  const n = name.toLowerCase();
  if (/_truth\.json$/.test(n)) return 'truth';
  if (/\.(aux\.xml|[jpt]fw|[jp]gw|wld|prj|cpg|hdr|clr|ovr|imd|rpb|sdw|tifw)$/.test(n)) return 'sidecar';
  if (/\.(txt|json|xml|xsl|html?|readme|info|plog|md|log)$|_eph$/.test(n) && !/\.geojson$/.test(n)) return 'metadata';
  if (/(^|\/)(readme|version|changelog|license|licence|copying|notice)[^/.]*$/i.test(name)) return 'metadata';
  return 'primary';
}
