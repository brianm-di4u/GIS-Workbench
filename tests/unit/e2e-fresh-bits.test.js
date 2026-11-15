// The release e2e records the native binaries it tests: what it built itself is as current as cargo
// made it, and a binary it didn't build is marked as outside this run's build.
import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { tempDir } from '../tools/temp-dir.mjs';
import { join } from 'node:path';
import { binary } from '../../build/e2e.mjs';

describe('the e2e record of a native binary', () => {
  const file = join(tempDir('e2e-bits'), 'gwb-sidecar.exe');
  writeFileSync(file, 'abc');
  const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  it('gives the SHA-256 of a binary e2e built, with no note', () => {
    expect(binary(file, true, 'unused')).toEqual({ file, sha256: abc, built: true });
  });
  it("marks a binary e2e didn't build as outside this run's build, and says why", () => {
    expect(binary(file, false, 'named in GWB_SIDECAR_EXE')).toEqual({ file, sha256: abc, built: false, note: "outside this run's build: named in GWB_SIDECAR_EXE" });
  });
});

describe('where the e2e suites find the Research samples', async () => {
  const { samplesDir } = await import('../../tests/e2e/helpers.js');
  const { resolve } = await import('node:path');
  it('is beside the main checkout, wherever the worktree is', () => {
    expect(samplesDir({}, () => 'C:/GIS Workbench/gwb-main/.git')).toBe(resolve('C:/GIS Workbench/Research/samples'));
  });
  it('can be set with GWB_SAMPLES', () => {
    expect(samplesDir({ GWB_SAMPLES: 'E:/samples' }, () => 'C:/x/.git')).toBe(resolve('E:/samples'));
  });
});

describe('the e2e packs check', async () => {
  const { missingPacks } = await import('../../build/e2e.mjs');
  const manifest = { geoid: { file: 'geoid-1.gwpack' }, ai: { file: 'ai-2.gwpack' } };
  const on = (...files) => (p) => files.some((f) => p.endsWith(f));
  it('names a pack a full build makes that this build lacks', () => {
    expect(missingPacks({ manifest, expected: ['geoid', 'ai', 'proj'], packsDir: 'd', exists: on('geoid-1.gwpack', 'ai-2.gwpack') })).toEqual([expect.stringMatching(/pack "proj" was not built/)]);
  });
  it("names a pack the manifest lists whose file isn't there", () => {
    expect(missingPacks({ manifest, expected: ['geoid', 'ai'], packsDir: 'd', exists: on('geoid-1.gwpack') })).toEqual([expect.stringMatching(/pack "ai" is in the manifest but ai-2.gwpack/)]);
  });
  it('passes a build with every pack', () => {
    expect(missingPacks({ manifest, expected: ['geoid', 'ai'], packsDir: 'd', exists: on('geoid-1.gwpack', 'ai-2.gwpack') })).toEqual([]);
    expect(missingPacks({ manifest: null, expected: [], packsDir: 'd' })).toEqual(['the build has no manifest']);
  });
});

describe('the e2e module bundle check', async () => {
  const { bundleProblems } = await import('../../build/e2e.mjs');
  const mod = (id, installed = true) => ({ id, installed });
  const full = {
    modules: ['core-gdal', 'points', 'sfm', 'vendor-mrsid', 'vendor-ecw'].map((id) => mod(id)).concat(mod('vendor-openh264', false)),
    raster_drivers: [{ name: 'GTiff' }, { name: 'HDF4' }, { name: 'HDF4Image' }],
    vendor: [{ id: 'vendor-mrsid', installed: true }, { id: 'vendor-ecw', installed: true }, { id: 'vendor-openh264', installed: false }],
  };
  it('passes a full bundle without OpenH264, the user\'s own download', () => {
    expect(bundleProblems(full)).toEqual([]);
  });
  it('names each gap of the 11-02 bundle: no Core GDAL, no HDF4, no MrSID or ECW plug-ins', () => {
    const old = { modules: [mod('core-gdal', false), mod('points')], raster_drivers: [], vendor: [{ id: 'vendor-mrsid', installed: false }] };
    expect(bundleProblems(old)).toEqual([
      'module "core-gdal" is not installed',
      'GDAL has no HDF4 driver (the HDF4 plug-ins)',
      'GDAL has no HDF4Image driver (the HDF4 plug-ins)',
      'the vendor-mrsid plug-ins are not loaded',
      'the vendor-ecw plug-ins are not loaded',
    ]);
  });
  it('asks Linux only for Core GDAL and HDF4', () => {
    expect(bundleProblems({ ...full, modules: [mod('core-gdal'), mod('sfm', false)], vendor: [] }, { linux: true })).toEqual([]);
  });
  it('refuses a sidecar that gave no caps', () => {
    expect(bundleProblems(null)).toEqual(['the test sidecar gave no caps']);
  });
});
