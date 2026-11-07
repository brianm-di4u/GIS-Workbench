// Web Mercator helpers shared by the tile readers, writers and the main thread (no dependencies).

const RAD = 180 / Math.PI;

/** [lon, lat] → Web Mercator world coordinates in [0, 1], y down. */
export function lonLatToWorld(lon, lat) {
  const s = Math.sin(Math.max(-85.0511287798, Math.min(85.0511287798, lat)) / RAD);
  return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
}

/** World coordinates in [0, 1] → [lon, lat]. */
export function worldToLonLat(wx, wy) {
  return [wx * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * wy))) * RAD];
}
