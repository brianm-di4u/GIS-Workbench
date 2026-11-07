// R1 surface tools: GPU hillshade against a Horn oracle computed from the raw posts, slope,
// aspect, colour relief and contours (REQ-DEM-10, REQ-DEM-11), and Use as Terrain for a DEM
// GeoTIFF with its vertical datum recorded and converted to HAE (REQ-DEM-02).
import { test, expect } from '@playwright/test';
import { openApp, openFiles, sample } from './helpers.js';

async function ready(page, file) {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [file]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].every((l) => l.lutTex && !l.tiles.loading));
  return { frame, logs };
}

const centrePixel = (frame) =>
  frame.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 400));
    const app = window.gisworkbench;
    const cap = app.renderer.capture();
    const b = app.activePane().el.getBoundingClientRect();
    const x = Math.round((b.left + b.width / 2) * cap.dpr - 0.5);
    const y = Math.round((b.top + b.height / 2) * cap.dpr - 0.5);
    const i = (y * cap.width + x) * 4;
    return [cap.data[i], cap.data[i + 1], cap.data[i + 2]];
  });

test('REQ-DEM-10 GPU hillshade matches a Horn oracle at a post; slope, aspect, relief and contours draw', async ({ page }) => {
  test.setTimeout(240_000); // GPU read-backs: ~90 s under the 4-worker full run (TE-017)
  const { frame, logs } = await ready(page, sample('dted-gdal', 'w118n033.dt1'));
  // One post per device pixel near post (600, 600); the oracle blends the Horn shades of
  // the four posts around the exact image point of the sampled screen pixel, as the shader does.
  const o = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const l = p.layers()[0];
    const dpr = window.devicePixelRatio || 1;
    p.setView({ cx: 600.5, cy: 600.5, zoom: 1 / dpr, rot: 0, mode: 'native' });
    app.setChain((c) => (c.dem = { ...c.dem, mode: 'hillshade', az: 315, el: 45, z: 1 }));
    await new Promise((r) => setTimeout(r, 400));
    const b = p.el.getBoundingClientRect();
    const cap = app.renderer.capture();
    const X = Math.round((b.left + b.width / 2) * cap.dpr);
    const Y = Math.round((b.top + b.height / 2) * cap.dpr);
    const i = (Y * cap.width + X) * 4;
    const px = [cap.data[i], cap.data[i + 1], cap.data[i + 2]];
    // Image point of that device pixel's centre.
    const q = p.imagePoint((X + 0.5) / cap.dpr - b.left, (Y + 0.5) / cap.dpr - b.top);
    const fx0 = Math.floor(q.x - 0.5);
    const fy0 = Math.floor(q.y - 0.5);
    const v = await app.pool.run('pixels', { handle: l.handle, x: fx0 - 1, y: fy0 - 1, w: 4, h: 4, bands: [0] }, { affinity: l.affinity });
    const z = (cx, cy) => v.values[0][(cy - v.y0) * v.w + (cx - v.x0)];
    const [cxm, cym, rot] = l.demCell();
    const zen = Math.PI / 2 - Math.PI / 4;
    const shadeAt = (x, y) => {
      const dzdx = (z(x + 1, y - 1) + 2 * z(x + 1, y) + z(x + 1, y + 1) - (z(x - 1, y - 1) + 2 * z(x - 1, y) + z(x - 1, y + 1))) / (8 * cxm);
      const dzdy = (z(x - 1, y + 1) + 2 * z(x, y + 1) + z(x + 1, y + 1) - (z(x - 1, y - 1) + 2 * z(x, y - 1) + z(x + 1, y - 1))) / (8 * cym);
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(-dzdx, dzdy) + rot;
      return Math.max(0, Math.min(1, Math.cos(zen) * Math.cos(slope) + Math.sin(zen) * Math.sin(slope) * Math.cos((315 * Math.PI) / 180 - aspect)));
    };
    const fx = q.x - 0.5 - fx0;
    const fy = q.y - 0.5 - fy0;
    const shade = (shadeAt(fx0, fy0) * (1 - fx) + shadeAt(fx0 + 1, fy0) * fx) * (1 - fy) + (shadeAt(fx0, fy0 + 1) * (1 - fx) + shadeAt(fx0 + 1, fy0 + 1) * fx) * fy;
    return { shade, px };
  });
  const px = o.px;
  expect(px[0]).toBe(px[1]);
  expect(Math.abs(px[0] - o.shade * 255)).toBeLessThanOrEqual(2);

  // The other modes render distinct colour schemes over the whole mountain cell.
  const stats = async (mode, contour = 0) => {
    await frame.evaluate(([m, c]) => {
      const app = window.gisworkbench;
      app.activePane().fitWhole();
      app.setChain((ch) => (ch.dem = { ...ch.dem, mode: m, contour: c }));
    }, [mode, contour]);
    return frame.evaluate(async () => {
      await new Promise((r) => setTimeout(r, 500));
      const app = window.gisworkbench;
      const cap = app.renderer.capture();
      const b = app.activePane().el.getBoundingClientRect();
      let grey = 0;
      let red = 0;
      let hues = new Set();
      let brown = 0;
      let n = 0;
      for (let y = Math.round(b.top * cap.dpr) + 40; y < Math.round(b.bottom * cap.dpr) - 40; y += 7)
        for (let x = Math.round(b.left * cap.dpr) + 40; x < Math.round(b.right * cap.dpr) - 40; x += 7) {
          const i = (y * cap.width + x) * 4;
          const [r, g, bb] = [cap.data[i], cap.data[i + 1], cap.data[i + 2]];
          if (r + g + bb === 0) continue;
          n++;
          if (Math.abs(r - g) < 3 && Math.abs(g - bb) < 3) grey++;
          if (r > g + 20 && bb < 80) red++; // the yellow-to-red half of the slope ramp (≳ 25°)
          if (Math.max(r, g, bb) - Math.min(r, g, bb) > 60) hues.add(Math.round((Math.atan2(Math.sqrt(3) * (g - bb), 2 * r - g - bb) * 6) / Math.PI));
          if (Math.abs(r - 115) < 30 && Math.abs(g - 56) < 30 && bb < 50) brown++;
        }
      return { grey: grey / n, red: red / n, hues: hues.size, brown: brown / n };
    });
  };
  const slope = await stats('slope');
  expect(slope.red).toBeGreaterThan(0.01); // steep San Gabriel flanks
  const aspect = await stats('aspect');
  expect(aspect.hues).toBeGreaterThanOrEqual(8);
  const relief = await stats('relief');
  expect(relief.grey).toBeLessThan(0.3);
  const contours = await stats('relief', 100);
  expect(contours.brown).toBeGreaterThan(relief.brown + 0.01);
  expect(logs).toEqual([]);
});

test('REQ-DEM-02 a DEM GeoTIFF used as terrain records its vertical datum and agrees with the DTED of the same cell', async ({ page }) => {
  const { frame } = await ready(page, sample('dem-derived-s35w059', 'S35W059_crop1201_float32_cog.tif'));
  await openFiles(frame, [sample('dem-derived-s35w059', 's35_w059_from_srtm.dt1')]);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const tif = [...app.layers.values()].find((l) => l.kind !== 'dem');
    const { guessVertical } = { guessVertical: () => null };
    await app.useAsTerrain(tif, 'egm96');
    const dems = app.terrain.dems.map((d) => ({ name: d.name, vertical: d.vertical }));
    // Compare the two terrains at a few points inside the crop.
    const c = tif.groundAt(tif.width / 2, tif.height / 2, 0);
    const diffs = [];
    for (const [dl, dn] of [[0, 0], [0.05, 0.05], [-0.05, 0.03]]) {
      const lat = c.lat + dl;
      const lon = c.lon + dn;
      const a = app.core.demHae(app.terrain.dems.find((d) => d.layerId === tif.id).coreId, lat, lon);
      const b = app.core.demHae(app.terrain.dems.find((d) => d.layerId !== tif.id).coreId, lat, lon);
      diffs.push(Math.abs(a - b));
    }
    return { dems, diffs, rec: tif.rec.terrain, N: app.core.undulation(c.lat, c.lon) };
  });
  expect(r.rec).toEqual({ vertical: 'egm96' });
  expect(r.dems.some((d) => /MSL EGM96/.test(d.name) && d.vertical === 'egm96')).toBe(true);
  // Both derive from SRTM: they agree to a few metres; both are HAE now (geoid ≈ 14–15 m here).
  for (const d of r.diffs) expect(d).toBeLessThan(6);
  expect(r.N).toBeGreaterThan(10);
});
