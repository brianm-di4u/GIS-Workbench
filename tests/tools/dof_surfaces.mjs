// FAA Digital Obstacle File against the obstruction surfaces (REQ-GAP-73, OD-2.31 D8). Every object the
// file lists under an airport's surfaces goes through the kernel (the `aviation` WASM bundle, as the
// app calls it) and through tests/tools/obstruction_ref.py, written apart from it, and the two are
// compared. This is an oracle tool: nothing in the app reads the DOF.
//
//   CARGO_TARGET_DIR=... node tests/tools/dof_surfaces.mjs DOF.CSV OUT.json LAS HOU
//
// The DOF states no surface and no penetration: what it lists is an object, its top (AMSL) and the
// tolerances of that position and top. Whether the object penetrates is worked out here.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { AviationBundle } from '../../app/src/wasm/aviation.js';
import { nasrAirport, encodeAirport, csvRow, FT } from '../../app/src/analysis/obstruction.js';

const [dofPath, outPath, ...ids] = process.argv.slice(2);
const target = process.env.CARGO_TARGET_DIR ?? JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory;
const B = new AviationBundle(new WebAssembly.Module(readFileSync(join(target, 'wasm32-unknown-unknown', 'release', 'gw_bundle_aviation.wasm'))));
const FX = resolve('fixtures/fx25/aviation');
const T = { base: readFileSync(join(FX, 'APT_BASE.csv'), 'latin1'), rwy: readFileSync(join(FX, 'APT_RWY.csv'), 'latin1'), end: readFileSync(join(FX, 'APT_RWY_END.csv'), 'latin1') };
const PY = process.env.GW_TE_PY ?? 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te/python.exe';

// DOF README of 21 May 2026, columns 98 and 100.
const H_FT = { 1: 20, 2: 50, 3: 100, 4: 250, 5: 500, 6: 1000, 7: 3038, 8: 6076 };
const V_FT = { A: 3, B: 10, C: 20, D: 50, E: 125, F: 250, G: 500, H: 1000 };

function readDof(path) {
  const lines = readFileSync(path, 'latin1').split('\n');
  const head = csvRow(lines[0].replace(/\r$/, ''));
  const ix = (n) => head.indexOf(n);
  const out = [];
  for (const l of lines.slice(1)) {
    if (!l.trim()) continue;
    const f = csvRow(l.replace(/\r$/, ''));
    const acc = f[ix('ACCURACY')].trim();
    const hc = acc.slice(0, -1);
    const vc = acc.slice(-1);
    out.push({
      oas: f[ix('OAS')].trim(),
      status: f[ix('VERIFIED STATUS')].trim(),
      city: f[ix('CITY')].trim(),
      lat: Number(f[ix('LATDEC')]),
      lon: Number(f[ix('LONDEC')]),
      type: f[ix('TYPE')].trim(),
      qty: Number(f[ix('QUANTITY')]),
      aglFt: Number(f[ix('AGL')]),
      amslFt: Number(f[ix('AMSL')]),
      acc,
      hTolM: H_FT[hc] ? H_FT[hc] * FT : null,
      vTolM: V_FT[vc] ? V_FT[vc] * FT : null,
    });
  }
  return out;
}

function oracle(regime, ap, opts, pts) {
  const d = mkdtempSync(join(tmpdir(), 'dof-'));
  try {
    const inp = join(d, 'in.json');
    const out = join(d, 'out.json');
    const air = { elev: ap.elev, runways: ap.runways.map((r) => ({ paved: r.paved, code: r.code, ends: r.ends.map((e) => ({ lat: e.lat, lon: e.lon, elev: e.elev, p77: e.p77, icao: e.icao, disp: regime === 'icao' ? e.disp ?? 0 : 0, thrElev: e.thrElev, approach: e.approach !== false, takeoff: e.takeoff !== false, clearway: e.clearway ?? 0 })) })), ...opts };
    writeFileSync(inp, JSON.stringify({ regime, airport: air, points: pts }));
    execFileSync(PY, ['-I', resolve('tests/tools/obstruction_ref.py'), inp, out], { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 28 });
    return JSON.parse(readFileSync(out, 'utf8'));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

const dof = readDof(dofPath);
const header = readFileSync(dofPath.replace(/x-csv.*$/, 'x-dat/DOF.DAT'), 'latin1').slice(0, 40).split('\n')[0].trim();
const report = { dofCurrency: header, dofObjects: dof.length, airports: {} };
for (const id of ids) {
  const ap = nasrAirport(T, id);
  const rec = { ident: ap.ident, elevM: ap.elev, runways: ap.runways.map((r) => ({ id: r.id, code: r.code, ends: r.ends.map((e) => ({ id: e.id, p77: e.p77, icao: e.icao, elevM: e.elev, nasrObstacle: e.nasrObstacle, lat: e.lat, lon: e.lon, disp: e.disp, trueAlignment: e.trueAlignment })) })), regimes: {} };
  for (const regime of ['part77', 'icao']) {
    const def = encodeAirport(ap, regime);
    const model = B.surfaces(def);
    const [s, w, n, e] = model.bbox;
    const under = dof.filter((o) => o.lat >= s && o.lat <= n && o.lon >= w && o.lon <= e);
    const ll = Float64Array.from(under.flatMap((o) => [o.lat, o.lon]));
    const r = B.points64(def, ll);
    const ref = oracle(regime, ap, {}, under.map((o) => [o.lat, o.lon]));
    let worst = 0;
    let kindsDiffer = 0;
    let coverDiffer = 0;
    const rows = under.map((o, k) => {
      const lim = r.limit[k];
      const lr = ref.limit[k];
      const cov = Number.isFinite(lim);
      if (cov !== (lr !== null)) coverDiffer++;
      else if (cov) {
        worst = Math.max(worst, Math.abs(lim - lr));
        if (model.surfaces[r.sid[k]]?.kind !== ref.kind[k]) kindsDiffer++;
      }
      const top = o.amslFt * FT;
      const sf = model.surfaces[r.sid[k]];
      const zl = r.zoneLimit[k];
      return { ...o, topM: top, limit: cov ? lim : null, kind: cov ? sf.kind : null, end: cov ? sf.end : null, runway: cov ? sf.runway : null, pen: cov ? top - lim : null, zoneLimit: Number.isFinite(zl) ? zl : null, zoneKind: Number.isFinite(zl) ? model.surfaces[r.zoneSid[k]]?.kind : null, zonePen: Number.isFinite(zl) ? top - zl : null, refLimit: lr };
    });
    const covered = rows.filter((o) => o.limit !== null);
    const pens = covered.filter((o) => o.pen > 0);
    // How often a listed object lies within 150 m of a random place under the surfaces: what a match
    // by position alone is worth. A fixed LCG, so the figure repeats.
    let seed = 12345;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const rll = new Float64Array(40000);
    for (let k = 0; k < 20000; k++) {
      rll[2 * k] = s + rnd() * (n - s);
      rll[2 * k + 1] = w + rnd() * (e - w);
    }
    const rl = B.points64(def, rll);
    let tried = 0;
    let near = 0;
    for (let k = 0; k < 20000; k++) {
      if (!Number.isFinite(rl.limit[k])) continue;
      tried++;
      const la = rll[2 * k];
      const lo = rll[2 * k + 1];
      const c = Math.cos((la * Math.PI) / 180);
      if (under.some((o) => Math.hypot((o.lat - la) * 111320, (o.lon - lo) * 111320 * c) <= 150)) near++;
    }
    rec.regimes[regime] = { bbox: model.bbox, inBox: rows.length, covered: covered.length, penetrating: pens.length, kernelVsOracle: { worstM: worst, kindsDiffer, coverDiffer }, chanceWithin150m: near / tried, rows };
    console.log(`${id} ${regime}: ${rows.length} in box, ${covered.length} under a surface, ${pens.length} above it; kernel vs oracle worst ${worst.toFixed(4)} m, ${kindsDiffer} kinds differ, ${coverDiffer} coverage differs`);
  }
  report.airports[id] = rec;
}
writeFileSync(outPath, JSON.stringify(report));
