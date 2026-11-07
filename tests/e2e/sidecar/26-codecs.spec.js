// SCN-59 (2.6, group codecs; REQ-GAP-69, 70, 51). Windows: MrSID and ECW pixels by tiles over
// loopback through the real vendor plug-ins, with nothing converted, checked against GDAL reading
// the same file directly. Linux: H.264 through Cisco's OpenH264 with the KLV kept, and the vendor
// path against the mock plug-ins (tests/tools/mock-vendor): modules from build.sh, passed in
// GWB_SIDECAR_MODULES; the Linux tests skip without them. Writes reports/sidecar/26-codecs.json.

import { test, expect } from '@playwright/test';
import { join, resolve, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, createWriteStream, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { openApp, openFiles } from '../helpers.js';
import { state, approvePending, startSidecar, stopSidecar, MODULES, DIST_DIR, CORPUS, DATA_ROOT, LINUX } from './harness.js';

const DIST = join(DIST_DIR, 'gis-workbench.html');
const PREFS = { welcomeDone: true };
const REPORT = resolve('reports', 'sidecar', '26-codecs.json');
const results = existsSync(REPORT) ? JSON.parse(readFileSync(REPORT, 'utf8')) : {};
const save = () => {
  mkdirSync(dirname(REPORT), { recursive: true });
  results.at = new Date().toISOString();
  writeFileSync(REPORT, JSON.stringify(results, null, 2));
};

const MRSID = join(CORPUS, 'raster-mrsid-gdal-samples');
const ECWS = join(CORPUS, 'raster-ecw-negatives-gdal');
const SAMPLES = [join(MRSID, 'lossless-mg3', 'utm11-27.sid'), join(MRSID, 'lossy-mg3', 'mercator.sid'), join(MRSID, 'lossy-mg3', 'laea.sid'), join(MRSID, 'lossy-mg2', 'utm11-27.sid'), join(MRSID, 'autotest', 'mercator_new.sid'), join(ECWS, 'jrc.ecw'), join(ECWS, 'spif83.ecw'), join(ECWS, 'sandiego2m_null.ecw'), join(ECWS, 'red_flower.ecw'), join(ECWS, 'stefan_full_rgba_ecwv3_meta.ecw')];
const HAMILTON = process.env.GWB_HAMILTON ?? 'C:/GIS Workbench/Research/Additional Data Samples/Hamilton_2018_rgb_20x-002/Hamilton_2018_rgb_20x.sid';
const MPEG2 = join(CORPUS, 'derived-fmv-variants', 'truck_mpeg2_klv.ts');
/** GDAL 3.13 with every driver, test time only: the oracle reads the source files itself. */
const OSGEO = process.env.GWB_OSGEO ?? 'D:/gwb-sidecar-deps/osgeo4w/root';
const SCRATCH = resolve(DATA_ROOT, 'codecs-scratch');

function oracleEnv() {
  return { ...process.env, PATH: `${OSGEO}/bin;${process.env.PATH}`, GDAL_DATA: `${OSGEO}/apps/gdal/share/gdal`, PROJ_DATA: `${OSGEO}/share/proj`, GDAL_DRIVER_PATH: `${OSGEO}/apps/gdal/lib/gdalplugins` };
}
const oracle = (tool, args) => execFileSync(join(OSGEO, 'bin', `${tool}.exe`), args, { env: oracleEnv(), encoding: 'utf8', maxBuffer: 1 << 28 });
const haveOracle = !LINUX && existsSync(join(OSGEO, 'bin', 'gdalinfo.exe'));
/** Band checksums and the geotransform of a raster, read by the oracle. */
function facts(path, extra = []) {
  const j = JSON.parse(oracle('gdalinfo', ['-json', '-checksum', ...extra, path]));
  return { sums: j.bands.map((b) => b.checksum), gt: j.geoTransform, size: j.size, wkt: (j.coordinateSystem?.wkt ?? '').replace(/\s+/g, ' '), driver: j.driverShortName };
}

const auth = (s) => ({ Origin: 'null', Authorization: `Bearer ${s.token}` });

async function api(s, method, path, { json, body, headers = {} } = {}) {
  const r = await fetch(`${s.base}${path}`, { method, headers: { ...auth(s), ...headers, ...(json ? { 'Content-Type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : body });
  return r;
}

/** Upload a file and open a view of it. */
async function viewOf(s, path) {
  const name = path.split(/[\\/]/).pop();
  const up = await (await api(s, 'PUT', `/v1/files?name=${encodeURIComponent(name)}`, { body: readFileSync(path), headers: { 'Content-Type': 'application/octet-stream' } })).json();
  const r = await api(s, 'POST', '/v1/views', { json: { file: up.id } });
  return { status: r.status, body: await r.json() };
}

/** The whole of a view as a local TIFF, by ranges of at most 8 MB, as a client would read it. */
async function saveView(s, v, out) {
  mkdirSync(dirname(out), { recursive: true });
  const w = createWriteStream(out);
  let ranges = 0;
  for (let a = 0; a < v.size; a += 8 << 20) {
    const b = Math.min(v.size, a + (8 << 20));
    const r = await api(s, 'GET', `/v1/views/${v.id}`, { headers: { Range: `bytes=${a}-${b - 1}` } });
    expect(r.status).toBe(206);
    if (!w.write(Buffer.from(await r.arrayBuffer()))) await once(w, 'drain');
    ranges++;
  }
  w.end();
  await once(w, 'finish');
  return ranges;
}

async function pair(frame, s) {
  await frame.evaluate(() => {
    window.gisworkbench.commands.run('sidecar.pair');
  });
  await expect(frame.locator('[data-id="sidecar:code"]')).toHaveText(/^\d{6}$/, { timeout: 20_000 });
  await approvePending(s);
  await frame.waitForFunction(() => window.gisworkbench.sidecar.state.status === 'paired', null, { timeout: 20_000 });
}

test.describe.configure({ mode: 'serial' });

test.describe('Windows: the real vendor plug-ins', () => {
  test.skip(LINUX, 'the vendor plug-ins are Windows only');

  test('REQ-GAP-70 every corpus sample: a view is the file, band for band, against GDAL reading it directly', async () => {
    test.skip(!haveOracle, 'no OSGeo4W GDAL here');
    test.setTimeout(420_000);
    // Its own sidecar: sidecar.spec.js revokes the shared test token in the project before Edge's.
    const s = await startSidecar({ dataDir: resolve(DATA_ROOT, 'codecs-pixels'), port: 47829 });
    const rows = [];
    for (const path of SAMPLES) {
      if (!existsSync(path)) continue;
      const v = await viewOf(s, path);
      expect(v.status, JSON.stringify(v.body)).toBe(201);
      const tif = join(SCRATCH, `${rows.length}-${v.body.name}.tif`);
      const t0 = Date.now();
      const ranges = await saveView(s, v.body, tif);
      const ms = Date.now() - t0;
      const direct = facts(path);
      const seen = facts(tif);
      expect(seen.size).toEqual(direct.size);
      expect(seen.sums, v.body.name).toEqual(direct.sums);
      expect(seen.gt, v.body.name).toEqual(direct.gt);
      expect(seen.driver).toBe('GTiff');
      // Each overview against GDAL asked for that size directly. Nearest resampling at a size that
      // is not an exact power of two depends on how GDAL chunks its reads (a GeoTIFF and an ENVI
      // output of the same command differ), so the oracle writes ENVI as the sidecar does, and
      // levels of more than one metatile are recorded by their differences.
      const ovr = [];
      for (let k = 1; k < v.body.levels; k++) {
        const w = Math.ceil(direct.size[0] / 2 ** k);
        const h = Math.ceil(direct.size[1] / 2 ** k);
        const a = `${tif}.direct${k}.bin`;
        const b = `${tif}.view${k}.bin`;
        oracle('gdal_translate', ['-q', '-of', 'ENVI', '-co', 'INTERLEAVE=BIP', '-outsize', String(w), String(h), '-r', 'nearest', path, a]);
        oracle('gdal_translate', ['-q', '-of', 'ENVI', '-co', 'INTERLEAVE=BIP', '-oo', `OVERVIEW_LEVEL=${k - 1}`, tif, b]);
        const [x, y] = [readFileSync(a), readFileSync(b)];
        expect(y.length).toBe(x.length);
        let differ = 0;
        let sum = 0;
        let max = 0;
        for (let i = 0; i < x.length; i++) {
          const d = Math.abs(x[i] - y[i]);
          if (d) differ++;
          sum += d;
          max = Math.max(max, d);
        }
        ovr.push({ level: k, width: w, height: h, oneMetatile: w <= 2048 && h <= 2048, differingSamples: differ, samples: x.length, meanAbs: sum / x.length, maxAbs: max });
      }
      for (const o of ovr) if (o.oneMetatile) expect(o.differingSamples, `${v.body.name} level ${o.level}`).toBe(0);
      rows.push({ file: path.replace(CORPUS, '').replace(/\\/g, '/'), driver: v.body.driver, width: v.body.width, height: v.body.height, bands: v.body.bands, type: v.body.sample_type, levels: v.body.levels, ranges, ms, checksums: direct.sums, geotransformEqual: true, sameCrsText: seen.wkt.replace(/ USAGE\[.*?\]\],/, '').replace(/,? USAGE\[.*\]\]/, '') === direct.wkt || seen.wkt === direct.wkt, overviews: ovr });
      await api(s, 'DELETE', `/v1/views/${v.body.id}`);
      rmSync(tif, { force: true });
    }
    expect(rows.length).toBeGreaterThanOrEqual(8);
    results.pixels = rows;
    save();
    stopSidecar(s.pid);
    rmSync(SCRATCH, { recursive: true, force: true });
    rmSync(resolve(DATA_ROOT, 'codecs-pixels'), { recursive: true, force: true });
  });

  test('SCN-59 MrSID: footprint → View with Sidecar → pixels in place, placed as the footprint, then converted', async ({ page }) => {
    test.setTimeout(240_000);
    const s = state();
    const { frame } = await openApp(page, 'file', { htmlPath: DIST, prefs: PREFS });
    await pair(frame, s);
    await openFiles(frame, [SAMPLES[0]]);
    await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.info?.footprint), null, { timeout: 30_000 });
    // The toast offers it once a sidecar is paired; the panel always does.
    await frame.locator('.toast .toast-action', { hasText: 'View with Sidecar' }).first().click();
    await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.rec?.name?.endsWith('.view.tif')), null, { timeout: 60_000 });
    const r = await frame.evaluate(async () => {
      const app = window.gisworkbench;
      const all = [...app.layers.values()];
      const fp = all.find((l) => l.info?.footprint);
      const v = all.find((l) => l.rec?.name?.endsWith('.view.tif'));
      const corners = [[0, 0], [v.width, 0], [v.width, v.height], [0, v.height]];
      const gap = Math.max(...corners.map(([x, y]) => {
        const a = v.groundAt(x, y, 0);
        const b = fp.groundAt(x, y, 0);
        return Math.hypot(a.lon - b.lon, a.lat - b.lat);
      }));
      const win = await app.pool.run('window', { handle: v.handle, x0: 100, y0: 100, w: 64, h: 64, step: 1, bands: [0], maxSamples: 1e6 }, { affinity: v.affinity, timeout: 60000 });
      const px = win.planes[0];
      return { w: v.width, h: v.height, fw: fp.width, fh: fp.height, gap, spread: Math.max(...px) - Math.min(...px), overviews: v.info?.meta?.overviews?.length ?? 0, log: app.netlog.entries.filter((e) => e.loopback && /\/v1\/views\//.test(e.path)).map((e) => e.status) };
    });
    expect([r.w, r.h]).toEqual([r.fw, r.fh]);
    expect(r.gap, 'same place as the footprint (degrees)').toBeLessThan(1e-9);
    expect(r.spread, 'real image content').toBeGreaterThan(0);
    expect(r.log.length).toBeGreaterThan(0);
    expect(r.log.every((x) => x === 206)).toBe(true);
    results.scn59_mrsid = r;
    save();
  });

  test('SCN-59 ECW with alpha: viewed through the command, four bands', async ({ page }) => {
    test.setTimeout(120_000);
    const s = state();
    const { frame } = await openApp(page, 'file', { htmlPath: DIST, prefs: PREFS });
    await pair(frame, s);
    const input = await frame.evaluateHandle(() => {
      const i = document.createElement('input');
      i.type = 'file';
      i.style.display = 'none';
      document.body.appendChild(i);
      return i;
    });
    await input.asElement().setInputFiles(SAMPLES[SAMPLES.length - 1]);
    const r = await frame.evaluate(async (i) => {
      const app = window.gisworkbench;
      const out = await app.commands.run('sidecar.view', { files: [...i.files], reason: 'ECW' });
      i.remove();
      const l = app.layers.get(out.layers[0].id);
      return { driver: out.view.driver, bands: out.view.bands, layerBands: l.bands, w: l.width, h: l.height };
    }, input);
    expect(r.driver).toBe('ECW');
    expect(r.bands).toBe(4);
    expect(r.layerBands).toBe(4);
  });

  test('View with Sidecar: refusals by name, and the large-file dialog passes axe', async ({ page }) => {
    test.setTimeout(120_000);
    const s = state();
    const { frame } = await openApp(page, 'file', { htmlPath: DIST, prefs: PREFS });
    await pair(frame, s);
    const r = await frame.evaluate(async () => {
      const app = window.gisworkbench;
      const up = await app.sidecar.client.upload(new Blob(['not an image at all, not by a long way']), { name: 'x.sid' });
      try {
        await app.sidecar.client.openView(up.id);
        return 'opened';
      } catch (e) {
        return e.code;
      }
    });
    expect(r).toBe('unreadable');
    // A file past the copy limit asks first.
    await frame.evaluate(() => {
      window.__big = window.gisworkbench.commands.run('sidecar.view', { files: [{ name: 'big.sid', size: 3e9 }], reason: 'MrSID' });
      window.__big.catch(() => {});
    });
    const dlg = frame.locator('[data-id="dialog:sidecar-view"]');
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('big.sid');
    const axe = readFileSync(join(resolve('node_modules'), 'axe-core', 'axe.min.js'), 'utf8');
    await frame.evaluate(axe);
    const v = await frame.evaluate(async () => (await window.axe.run('[data-id="dialog:sidecar-view"]', { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] })).violations.map((x) => x.id));
    expect(v).toEqual([]);
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    expect(await frame.evaluate(() => window.__big)).toBeNull();
  });

  test('Perf: Hamilton County, 11 GB MrSID, 340 000 × 220 000: picked, opened, a viewport of tiles', async () => {
    test.skip(!existsSync(HAMILTON), 'tier U field data, not here');
    test.setTimeout(600_000);
    const data = resolve(DATA_ROOT, 'codecs-hamilton');
    const s = await startSidecar({ dataDir: data, port: 47829, extra: ['--test-pick', HAMILTON] });
    try {
      const pick = await (await api(s, 'POST', '/v1/pick', { json: { mode: 'file' } })).json();
      const t0 = performance.now();
      const v = await (await api(s, 'POST', '/v1/views', { json: { file: pick.files[0].id } })).json();
      const open = performance.now() - t0;
      expect(v.width).toBe(340000);
      const head = await api(s, 'GET', `/v1/views/${v.id}`, { headers: { Range: `bytes=0-${64 * 1024 - 1}` } });
      expect(head.status).toBe(206);
      // The header gives the geometry the client would compute.
      const tile = 512 * 512 * v.bands;
      const stride = Math.ceil(tile / 65536) * 65536;
      const levels = [];
      for (let k = 0; k < v.levels; k++) {
        const w = Math.ceil(v.width / 2 ** k);
        const h = Math.ceil(v.height / 2 ** k);
        levels.push({ tx: Math.ceil(w / 512), ty: Math.ceil(h / 512) });
      }
      // Tile data starts on the first 64 KiB boundary after the header; find it from level 0's first offset.
      const hb = Buffer.from(await (await api(s, 'GET', `/v1/views/${v.id}`, { headers: { Range: 'bytes=0-4095' } })).arrayBuffer());
      const n = Number(hb.readBigUInt64LE(16));
      let data0 = 0;
      for (let i = 0; i < n; i++) {
        const e = 24 + i * 20;
        if (hb.readUInt16LE(e) === 324) {
          const off = Number(hb.readBigUInt64LE(e + 12));
          const b = Buffer.from(await (await api(s, 'GET', `/v1/views/${v.id}`, { headers: { Range: `bytes=${off}-${off + 7}` } })).arrayBuffer());
          data0 = Number(b.readBigUInt64LE(0));
        }
      }
      let first = data0;
      const firsts = levels.map((l) => {
        const f = first;
        first += l.tx * l.ty * stride;
        return f;
      });
      const read = async (lv, x, y) => {
        const off = firsts[lv] + (y * levels[lv].tx + x) * stride;
        const t = performance.now();
        const r = await api(s, 'GET', `/v1/views/${v.id}`, { headers: { Range: `bytes=${off}-${off + stride - 1}` } });
        expect(r.status).toBe(206);
        await r.arrayBuffer();
        return performance.now() - t;
      };
      // Top of the pyramid, then a 1920 × 1080 viewport of 5 × 3 tiles at full resolution, four at a
      // time as the app's reader does, then a pan by one column, then the same tiles again.
      const top = await read(v.levels - 1, 0, 0);
      const vp = async (x0, y0) => {
        const q = [];
        for (let y = 0; y < 3; y++) for (let x = 0; x < 5; x++) q.push([x0 + x, y0 + y]);
        const t = performance.now();
        const each = [];
        await Promise.all([...Array(4)].map(async () => {
          for (let c = q.shift(); c; c = q.shift()) each.push(await read(0, c[0], c[1]));
        }));
        return { ms: performance.now() - t, tiles: each.length, slowest: Math.max(...each), median: each.sort((a, b) => a - b)[each.length >> 1] };
      };
      const first1 = await vp(300, 200);
      const pan = await vp(301, 200);
      const again = await vp(300, 200);
      const coarse = await read(4, 20, 12);
      results.hamilton = { input_bytes: statSync(HAMILTON).size, width: v.width, height: v.height, levels: v.levels, viewBytes: v.size, open_ms: Math.round(open), topTile_ms: Math.round(top), viewport: first1, pan, cached: again, level4Tile_ms: Math.round(coarse) };
      save();
      expect(again.ms).toBeLessThan(first1.ms);
    } finally {
      stopSidecar(s.pid);
      rmSync(data, { recursive: true, force: true });
    }
  });
});

test.describe('Linux: OpenH264 and the vendor path on mocks', () => {
  const oh = join(MODULES, 'vendor-openh264', 'ACCEPTED.json');
  test.skip(!LINUX || !existsSync(oh), 'needs the Linux test modules (tests/tools/mock-vendor/build.sh)');

  test('REQ-GAP-51 SCN-59 MPEG-2 → H.264 through Cisco OpenH264: the KLV bytes and their times survive', async () => {
    test.setTimeout(900_000);
    const s = state();
    const caps = await (await api(s, 'GET', '/v1/caps')).json();
    expect(caps.modules.find((m) => m.id === 'vendor-openh264').title).toBe('OpenH264 Video Codec provided by Cisco Systems, Inc.');
    const prof = caps.profiles.find((p) => p.id === 'video-h264-openh264');
    expect(prof.available).toBe(true);
    const up = await (await api(s, 'PUT', '/v1/files?name=truck_mpeg2_klv.ts', { body: readFileSync(MPEG2), headers: { 'Content-Type': 'application/octet-stream' } })).json();
    const job = await (await api(s, 'POST', '/v1/jobs', { json: { profile: 'video-h264-openh264', inputs: [up.id], reason: 'e2e' } })).json();
    let done;
    for (let i = 0; i < 1700; i++) {
      done = await (await api(s, 'GET', `/v1/jobs/${job.id}`)).json();
      if (['succeeded', 'failed', 'cancelled'].includes(done.state)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(done.state, JSON.stringify(done)).toBe('succeeded');
    const out = done.outputs[0];
    expect(out.name).toBe('truck_mpeg2_klv.h264.ts');
    const dest = resolve(DATA_ROOT, 'codecs-out', out.name);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from(await (await api(s, 'GET', `/v1/files/${out.id}`)).arrayBuffer()));
    const probe = (file, what) => execFileSync(join(MODULES, 'media/bin/ffprobe'), ['-v', 'error', ...what, '-of', 'json', file], { env: { ...process.env, LD_LIBRARY_PATH: join(MODULES, 'media/lib') }, encoding: 'utf8', maxBuffer: 1 << 28 });
    const streams = (f) => JSON.parse(probe(f, ['-show_entries', 'stream=codec_name,codec_type,profile,width,height,nb_read_frames', '-count_frames'])).streams;
    const klv = (f) => JSON.parse(probe(f, ['-select_streams', 'd:0', '-show_entries', 'packet=pts,data_hash', '-show_data_hash', 'SHA256'])).packets;
    const inp = klv(MPEG2);
    const res = klv(dest);
    expect(res.length).toBe(inp.length);
    expect(res.map((p) => p.data_hash)).toEqual(inp.map((p) => p.data_hash));
    expect(res.map((p) => p.pts)).toEqual(inp.map((p) => p.pts));
    const v = streams(dest).find((x) => x.codec_type === 'video');
    expect(v.codec_name).toBe('h264');
    const v0 = streams(MPEG2).find((x) => x.codec_type === 'video');
    expect(Number(v.nb_read_frames)).toBe(Number(v0.nb_read_frames));
    results.h264 = { packets: res.length, frames: Number(v.nb_read_frames), profile: v.profile, output: dest, bytes: out.size, ms: done.provenance?.steps?.[0]?.ms };
    save();
  });

  test('REQ-GAP-69 the Linux vendor path on the mock: caps, conversion and a view', async () => {
    test.setTimeout(300_000);
    const s = state();
    const caps = await (await api(s, 'GET', '/v1/caps')).json();
    const sdk = caps.vendor.find((v) => v.id === 'vendor-mrsid');
    expect(sdk.installed).toBe(true);
    expect(sdk.source).not.toMatch(/Windows only/);
    // A mock file: the magic padded to 64 bytes, then a GeoTIFF.
    const dir = resolve(DATA_ROOT, 'codecs-mock');
    mkdirSync(dir, { recursive: true });
    const src = join(CORPUS, 'derived-raster-negatives', 'naip_b1_hfa.img');
    const tif = join(dir, 'in.tif');
    execFileSync(join(MODULES, 'core-gdal/bin/gdal_translate'), ['-q', '-of', 'GTiff', src, tif], { env: { ...process.env, LD_LIBRARY_PATH: join(MODULES, 'core-gdal/lib'), GDAL_DATA: join(MODULES, 'core-gdal/share/gdal'), PROJ_DATA: join(MODULES, 'core-gdal/share/proj') } });
    const sid = join(dir, 'mock.sid');
    writeFileSync(sid, Buffer.concat([Buffer.from('GWBMOCKVENDOR\n'.padEnd(64, ' ')), readFileSync(tif)]));
    const v = await viewOf(s, sid);
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    expect(v.body.driver).toBe('MrSID');
    const out = join(dir, 'view.tif');
    await saveView(s, v.body, out);
    const info = (f) => JSON.parse(execFileSync(join(MODULES, 'core-gdal/bin/gdalinfo'), ['-json', '-checksum', f], { env: { ...process.env, LD_LIBRARY_PATH: join(MODULES, 'core-gdal/lib'), GDAL_DATA: join(MODULES, 'core-gdal/share/gdal'), PROJ_DATA: join(MODULES, 'core-gdal/share/proj') }, encoding: 'utf8', maxBuffer: 1 << 28 }));
    const a = info(tif);
    const b = info(out);
    expect(b.bands.map((x) => x.checksum)).toEqual(a.bands.map((x) => x.checksum));
    expect(b.geoTransform).toEqual(a.geoTransform);
    const up = await (await api(s, 'PUT', '/v1/files?name=mock2.sid', { body: readFileSync(sid), headers: { 'Content-Type': 'application/octet-stream' } })).json();
    const job = await (await api(s, 'POST', '/v1/jobs', { json: { profile: 'raster-cog', inputs: [up.id], reason: 'e2e' } })).json();
    let done;
    for (let i = 0; i < 300; i++) {
      done = await (await api(s, 'GET', `/v1/jobs/${job.id}`)).json();
      if (['succeeded', 'failed', 'cancelled'].includes(done.state)) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(done.state, JSON.stringify(done)).toBe('succeeded');
    results.linuxMock = { view: { width: v.body.width, height: v.body.height, sums: b.bands.map((x) => x.checksum) }, convert: done.outputs[0].name };
    save();
    rmSync(dir, { recursive: true, force: true });
  });
});

const H264_TS = process.env.GWB_H264_TS ?? 'D:/gwb26/data-codecs/linux-out/truck_mpeg2_klv.h264.ts';
test.describe('Windows: what the Linux sidecar wrote', () => {
  test.skip(LINUX || !existsSync(H264_TS), 'plays in Chrome and Edge on Windows; needs the file the Linux run made');
  test('Linux output: H.264 made with OpenH264 plays in the FMV player with every KLV packet', async ({ page }) => {
  test.setTimeout(120_000);
  const { frame } = await openApp(page, 'file', { htmlPath: DIST, prefs: PREFS });
  await openFiles(frame, [H264_TS]);
  await frame.waitForFunction(() => window.gisworkbench.fmv?.activeClip?.()?.packets?.length > 0, null, { timeout: 60_000 });
  const c = await frame.evaluate(() => {
    const clip = window.gisworkbench.fmv.activeClip();
    return { packets: clip.packets.length, ok: clip.packets.filter((k) => k.ok).length, frames: clip.frames.length, codec: String(clip.codec), playable: window.gisworkbench.fmv.playable?.(clip) ?? null };
  });
  expect(c.packets).toBe(288);
  expect(c.ok).toBe(288);
  expect(c.codec).toMatch(/h264|avc/i);
  expect(c.frames).toBeGreaterThan(1000);
  expect(c.playable).not.toBe(false);
  results.h264Played = c;
  save();
});
});
