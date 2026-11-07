// Photoshop bridge (2.0 plan P7; REQ-HUB-01): the view as a layered PSD. The base layer holds the
// image linearly scaled from its full data range, and the app's look is rebuilt as live
// adjustment layers over it: Levels per channel (the stretch: black and white points, gamma) and
// Curves (the tonal curve). Graphics come as a pixel layer on top. ag-psd (MIT) writes 8-bit
// PSD only, so 11–16-bit imagery keeps its depth in the GeoTIFF export instead (DN-58). A world
// file (.pgw-style, for the PSD's pixel grid) and a .prj carry the georeference.

import { stretchRange, histPercentile } from '../render/chain.js';
import { worldFileFor, WGS84_PRJ } from '../products/chip.js';

/** Levels channel (Photoshop's 0–255 input domain of the base) for a band's display range. */
export function levelsFor(full, shown, gamma = 0) {
  const span = Math.max(1e-12, full.hi - full.lo);
  const lo = Math.max(0, Math.min(253, Math.round((255 * (shown.lo - full.lo)) / span)));
  const hi = Math.max(lo + 2, Math.min(255, Math.round((255 * (shown.hi - full.lo)) / span)));
  return { shadowInput: lo, highlightInput: hi, shadowOutput: 0, highlightOutput: 255, midtoneInput: Math.round(2 ** (gamma / 50) * 100) / 100 };
}

/** Curves points from the chain's tonal curve ([[x, y]] in 0…1), or null. */
export function curvesFor(curve) {
  if (!curve?.length) return null;
  const pts = curve.map(([x, y]) => ({ input: Math.round(x * 255), output: Math.round(y * 255) }));
  if (pts[0].input > 0) pts.unshift({ input: 0, output: 0 });
  if (pts.at(-1).input < 255) pts.push({ input: 255, output: 255 });
  return pts;
}

/**
 * A Photoshop Curves preset (.acv, version 1: composite then red, green, blue) that rebuilds the
 * look on the 16-bit TIFF export: each channel maps its stretch range (`levels` on the 0–255
 * domain) through the gamma and tonal curve, as at most 16 points.
 */
export function acvPreset(levels, curve = null) {
  const tone = (t, g) => {
    let v = t ** (1 / g);
    if (curve?.length) {
      const p = [[0, 0], ...curve, [1, 1]];
      const k = Math.max(1, p.findIndex(([x]) => x >= v));
      const [x0, y0] = p[k - 1];
      const [x1, y1] = p[k];
      v = y0 + ((y1 - y0) * (v - x0)) / Math.max(1e-9, x1 - x0);
    }
    return Math.max(0, Math.min(1, v));
  };
  const chan = (L) => {
    const pts = [];
    // At most 16 points: the end points (0, 0) and (255, 255) when the range does not reach them.
    const n = Math.min(15 - (L.shadowInput > 0) - (L.highlightInput < 255), L.highlightInput - L.shadowInput);
    if (L.shadowInput > 0) pts.push([0, 0]);
    for (let i = 0; i <= n; i++) {
      const input = Math.round(L.shadowInput + ((L.highlightInput - L.shadowInput) * i) / n);
      if (!pts.length || input > pts.at(-1)[0]) pts.push([input, Math.round(255 * tone(i / n, L.midtoneInput))]);
    }
    if (pts.at(-1)[0] < 255) pts.push([255, 255]);
    return pts;
  };
  const identity = [[0, 0], [255, 255]];
  const curves = [identity, ...levels.map(chan), identity]; // composite, R, G, B, (alpha)
  const words = [1, curves.length];
  for (const c of curves) {
    words.push(c.length);
    for (const [input, output] of c) words.push(output, input); // .acv stores output first
  }
  const out = new Uint8Array(words.length * 2);
  words.forEach((w, i) => {
    out[2 * i] = w >> 8;
    out[2 * i + 1] = w & 255;
  });
  return out;
}

/**
 * The PSD of a panel's view: {bytes, world, prj, name, size}. `read(l, region, step, bands)` →
 * {planes, w, h} (the pool's window op); `graphics` an optional canvas of the overlays at w × h.
 */
export async function viewPsd({ l, region, step, read, writePsd, graphics = null, groundAt }) {
  const bands = (l.chain?.bands ?? [0]).slice(0, 3);
  const r = await read(l, region, step, bands);
  const W = r.w;
  const H = r.h;
  const rgba = new Uint8ClampedArray(W * H * 4);
  const full = [];
  const levels = [];
  for (let c = 0; c < 3; c++) {
    const b = Math.min(c, r.planes.length - 1);
    const hst = l.stats?.[bands[b]];
    const f = hst ? { lo: histPercentile(hst, 0), hi: histPercentile(hst, 1) } : { lo: 0, hi: 255 };
    if (!(f.hi > f.lo)) f.hi = f.lo + 1;
    full.push(f);
    levels.push(levelsFor(f, hst ? stretchRange(hst, l.chain, bands[b]) : f, l.chain?.tone?.gamma ?? 0));
    const pl = r.planes[b];
    for (let i = 0; i < W * H; i++) rgba[4 * i + c] = Math.round(((pl[i] - f.lo) / (f.hi - f.lo)) * 255);
  }
  for (let i = 0; i < W * H; i++) rgba[4 * i + 3] = 255;
  const children = [{ name: `${l.rec?.name ?? 'Image'} (raw, full range)`, imageData: { width: W, height: H, data: rgba } }];
  const mono = r.planes.length === 1;
  children.push({ name: 'Stretch (Levels)', adjustment: mono ? { type: 'levels', rgb: levels[0] } : { type: 'levels', red: levels[0], green: levels[1], blue: levels[2] } });
  const curves = curvesFor(l.chain?.tone?.curve);
  if (curves) children.push({ name: 'Tonal curve (Curves)', adjustment: { type: 'curves', rgb: curves } });
  if (graphics) children.push({ name: 'Graphics', canvas: graphics });
  const bytes = writePsd({ width: W, height: H, children }, { generateThumbnail: false, noBackground: true });
  // Georeference of the PSD grid: the region's corners on the ground.
  const corners = [[region.x0, region.y0], [region.x0 + W * step, region.y0], [region.x0 + W * step, region.y0 + H * step], [region.x0, region.y0 + H * step]].map(([x, y]) => groundAt?.(x, y));
  const world = corners.every(Boolean) ? worldFileFor({ size: [W, H], cornersGround: corners.map((g) => [g.lon, g.lat, g.h]) }) : null;
  return { bytes: new Uint8Array(bytes), world: world?.text ?? null, prj: world ? WGS84_PRJ : null, size: [W, H], layers: children.map((c) => c.name) };
}
