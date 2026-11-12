// CPHD (REQ-FMT-49, REQ-FMT-51) through the real `legacy` WASM bundle on the T&E corpus CPHDs (GDAL
// autotest 1.1.0, Capella C09/C13, Umbra) and the FX-21 CPHD 1.0.1: metadata and layout, PVP columns,
// signal windows against a direct big-endian read, and subsets read back by sarpy and checked by
// sarkit's cphdcheck (the gw-te environment). Skipped when the bundle, corpus or gw-te are absent.
import { describe, it, expect } from 'vitest';
import { existsSync, openAsBlob, readFileSync, openSync, readSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tempDir } from '../tools/temp-dir.mjs';
import { execFileSync } from 'node:child_process';
import { Bundle } from '../../app/src/wasm/abi.js';
import { openCphd, pvpColumns, cphdSubset } from '../../app/src/workers/decode/cphd.js';

const TE = process.env.TE_CORPUS ?? resolve('..', 'TE-corpus');
const wasmPath = (() => {
  try {
    const t = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory;
    return join(t, 'wasm32-unknown-unknown', 'release', 'gw_bundle_legacy.wasm');
  } catch {
    return null;
  }
})();
const haveWasm = !!wasmPath && existsSync(wasmPath);
const B = haveWasm ? new Bundle(new WebAssembly.Module(readFileSync(wasmPath)), 'legacy') : null;
const GWTE = 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te';
const haveTe = existsSync(`${GWTE}/python.exe`);
const env = { ...process.env, PATH: `${GWTE}/Library/bin;${GWTE};${GWTE}/Scripts;${process.env.PATH}` };
const file = async (p) => {
  const b = await openAsBlob(p);
  return Object.assign(b, { name: p.split(/[\\/]/).pop() });
};
const FILES = {
  gdal: join(TE, 'sar-cphd-gdal-autotest', 'test.cphd'),
  c09: join(TE, 'sar-capella-c09-sm-cphd-20240923', 'capella_C09_SM_CPHD.cphd'),
  c13: join(TE, 'capella-c13-sm-20240924', 'capella_C13_SM_CPHD.cphd'),
  umbra: join(TE, 'umbra-bingham-20230925-full', 'umbra_20230925_CPHD.cphd'),
};

/** Signal sample (v, s) of channel 0 read straight from the file. */
function direct(path, m, v, s) {
  const c = m.channels[0];
  const fd = openSync(path, 'r');
  const b = Buffer.alloc(m.bytesPerSample);
  readSync(fd, b, 0, b.length, c.signalOffset + (v * c.ns + s) * m.bytesPerSample);
  const k = m.signalFormat === 'CI2' ? [b.readInt8(0), b.readInt8(1)] : m.signalFormat === 'CI4' ? [b.readInt16BE(0), b.readInt16BE(2)] : [b.readFloatBE(0), b.readFloatBE(4)];
  return k;
}

describe.skipIf(!haveWasm)('CPHD reader (legacy bundle)', () => {
  for (const [key, path] of Object.entries(FILES)) {
    it.skipIf(!existsSync(path))(`${key}: metadata, PVP and signal windows`, async () => {
      const { meta, channels, ctx } = await openCphd(await file(path), B);
      expect(meta.version).toBe('1.1.0');
      expect(meta.channels.length).toBeGreaterThan(0);
      const c = meta.channels[0];
      expect(channels[0].info.series.vector.at(-1)).toBe(c.nv - 1);
      const cols = await pvpColumns(ctx, 0, 0, Math.min(c.nv, 64));
      expect(cols.TxTime[0].length).toBe(Math.min(c.nv, 64));
      if (key !== 'gdal') {
        // Real collects: positions on an orbit, the track on the map, the image area corners.
        expect(Math.hypot(cols.TxPos[0][0], cols.TxPos[1][0], cols.TxPos[2][0])).toBeGreaterThan(6.7e6);
        expect(channels[0].info.track.arp.length).toBeGreaterThan(10);
        expect(meta.iacp.length).toBe(4);
        expect(cols.TxTime[0][1]).toBeGreaterThan(cols.TxTime[0][0]);
      }
      const src = channels[0].source;
      const v = Math.floor(c.nv / 2);
      const s = Math.floor(c.ns / 3);
      const [re, im] = await src.readWindow(s, v, 4, 2, [0, 1]);
      const amp = cols.AmpSF ? (await pvpColumns(ctx, 0, v, v + 1)).AmpSF[0][0] : 1;
      const [dre, dim] = direct(path, meta, v, s);
      expect(re[0]).toBeCloseTo(dre * amp, 3);
      expect(im[0]).toBeCloseTo(dim * amp, 3);
      if (src.hasLevel(2)) {
        const [lr] = await src.readLevel(2, Math.floor(s / 4), Math.floor(v / 4), 2, 2, [0]);
        const [d2] = direct(path, meta, Math.min(c.nv - 1, Math.floor(v / 4) * 4 + 2), Math.min(c.ns - 1, Math.floor(s / 4) * 4 + 2));
        const amp2 = cols.AmpSF ? (await pvpColumns(ctx, 0, Math.floor(v / 4) * 4 + 2, Math.floor(v / 4) * 4 + 3)).AmpSF[0][0] : 1;
        expect(lr[0]).toBeCloseTo(d2 * amp2, 3);
      }
    }, 120000);
  }

  it.skipIf(!existsSync(FILES.umbra))('Umbra support arrays are summarised', async () => {
    const { meta } = await openCphd(await file(FILES.umbra), B);
    expect(meta.supportArrays.map((s) => s.id)).toEqual(['Antenna', 'Antenna_element']);
    expect(meta.supportPreview[0].stats.map((x) => x.name)).toEqual(['Gain', 'Phase']);
  });

  it('refuses truncated and damaged files by name', async () => {
    const path = FILES.gdal;
    if (!existsSync(path)) return;
    const b = readFileSync(path);
    const cut = Object.assign(new Blob([b.subarray(0, 4200)]), { name: 'cut.cphd' });
    await expect(openCphd(cut, B)).rejects.toThrow(/truncated|past the/);
    const bad = Buffer.from(b);
    bad.write('CPHD/0.3  ', 0, 'latin1');
    await expect(openCphd(Object.assign(new Blob([bad]), { name: 'v03.cphd' }), B)).rejects.toThrow(/version 0\.3/);
  });

  it.skipIf(!existsSync(FILES.c13) || !haveTe)('a Capella subset is read back by sarpy and passes cphdcheck', async () => {
    const { meta, ctx } = await openCphd(await file(FILES.c13), B);
    const c = meta.channels[0];
    const sub = { ch: 0, v0: 1000, v1: 1400, s0: 100, s1: 612 };
    const blob = await cphdSubset(ctx, [sub]);
    const dir = tempDir('gw-cphd');
    const out = join(dir, 'c13_subset.cphd');
    writeFileSync(out, Buffer.from(await blob.arrayBuffer()));
    // Our own reader first, then sarpy (an independent implementation) and sarkit's consistency checker.
    const back = await openCphd(await file(out), B);
    expect([back.meta.channels[0].nv, back.meta.channels[0].ns]).toEqual([400, 512]);
    const [re] = await back.channels[0].source.readWindow(0, 0, 1, 1, [0]);
    const [r0] = await (await openCphd(await file(FILES.c13), B)).channels[0].source.readWindow(100, 1000, 1, 1, [0]);
    expect(re[0]).toBeCloseTo(r0[0], 4);
    const code = `import sys, numpy as np
from sarpy.io.phase_history.converter import open_phase_history
r = open_phase_history(sys.argv[1])
d = r.cphd_meta.Data.Channels[0]
sig = r.read_signal_block()
k = list(sig.keys())[0]
print(d.NumVectors, d.NumSamples, sig[k].shape, abs(sig[k][0, 0]))`;
    const s = execFileSync(`${GWTE}/python.exe`, ['-I', '-c', code, out], { env, encoding: 'utf8' }).trim().split(/\s+/);
    expect(s.slice(0, 2)).toEqual(['400', '512']);
    let check = '';
    try {
      check = execFileSync(`${GWTE}/Scripts/cphdcheck.exe`, [out], { env, encoding: 'utf8' });
    } catch (e) {
      check = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    // The schema holds; the only errors left are the source file's own (its dwell polynomials).
    const errors = check.split('\n').filter((l) => /\[Error\]/.test(l));
    expect(check).not.toMatch(/\[Error\] Need: XML passes schema/);
    // The source itself fails the dwell-polynomial check; the subset's polynomials are rewritten to what
    // its vectors support, so it passes every check.
    expect(errors, check).toEqual([]);
    expect(c.nv).toBeGreaterThan(sub.v1);
  }, 300000);

  const FX = resolve('fixtures/fx21/sar/cphd-1.0.1-spot.cphd');
  it.skipIf(!existsSync(FX))('FX-21 CPHD 1.0.1: values as written; subsets keep or recompute the reference geometry and pass cphdcheck', async () => {
    const truth = JSON.parse(readFileSync(resolve('fixtures/fx21/sar/sar_truth.json'), 'utf8')).cphd;
    const { meta, channels, ctx } = await openCphd(await file(FX), B);
    expect(meta.version).toBe('1.0.1');
    expect([meta.channels[0].nv, meta.channels[0].ns]).toEqual([truth.nv, truth.ns]);
    expect(meta.supportArrays[0].kind).toBe('IAZArray');
    expect(meta.supportPreview[0].stats[0].min).toBe(610);
    expect(meta.iacp[0][0]).toBeCloseTo(truth.iacp[0][0], 9);
    const [re, im] = await channels[0].source.readWindow(0, 0, 1, 1, [0, 1]);
    expect([re[0], im[0]]).toEqual(truth.first);
    expect(meta.geometry.SideOfTrack).toBe(truth.side);
    for (const [v0, v1, s0, s1] of [[10, 40, 5, 70], [0, 20, 0, 80], [0, 64, 8, 40]]) {
      const blob = await cphdSubset(ctx, [{ ch: 0, v0, v1, s0, s1 }]);
      const out = join(tempDir('gw-cphd'), 'fx.cphd');
      writeFileSync(out, Buffer.from(await blob.arrayBuffer()));
      const back = await openCphd(await file(out), B);
      expect(back.meta.version).toBe('1.0.1');
      expect([back.meta.channels[0].nv, back.meta.channels[0].ns]).toEqual([v1 - v0, s1 - s0]);
      if (!haveTe) continue;
      const s = execFileSync(`${GWTE}/python.exe`, ['-I', '-c', 'import sys\nfrom sarpy.io.phase_history.converter import open_phase_history\nr = open_phase_history(sys.argv[1])\nb = r.read_signal_block()\nk = list(b)[0]\nprint(*b[k].shape, int(b[k][0, 0].real), int(b[k][0, 0].imag))', out], { env, encoding: 'utf8' }).trim();
      const ph = 0.37 * s0 + 0.11 * v0;
      expect(s).toBe(`${v1 - v0} ${s1 - s0} ${Math.round(800 * Math.cos(ph))} ${Math.round(800 * Math.sin(ph))}`);
      let check = '';
      try {
        check = execFileSync(`${GWTE}/Scripts/cphdcheck.exe`, [out], { env, encoding: 'utf8' });
      } catch (e) {
        check = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      }
      expect(check.split('\n').filter((l) => /\[Error\]/.test(l)), `${v0}-${v1}/${s0}-${s1}\n${check}`).toEqual([]);
    }
  }, 300000);
});
