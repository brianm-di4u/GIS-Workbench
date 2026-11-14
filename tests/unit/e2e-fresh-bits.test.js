// The release e2e refuses to test a sidecar binary older than the sidecar's code: the harness runs
// whatever binary sits in the target folder, so a stale one passed the suites on old code.
import { describe, expect, it } from 'vitest';
import { newestSidecarSource, staleSidecar } from '../../build/e2e.mjs';

const exe = 'C:/t/release/gwb-sidecar.exe';
const at = (iso) => Date.parse(iso);

describe('the e2e sidecar check', () => {
  it('refuses a binary older than the newest sidecar source', () => {
    expect(staleSidecar({ exe, exeTime: at('2026-11-13T10:00:00Z'), newestSource: at('2026-11-13T11:00:00Z') })).toMatch(/older than this checkout's newest sidecar source.*Build it again/);
  });

  it('refuses a missing binary', () => {
    expect(staleSidecar({ exe, exeTime: null, newestSource: at('2026-11-13T11:00:00Z') })).toMatch(/there is no sidecar at/);
  });

  it('accepts a binary built after the newest change', () => {
    expect(staleSidecar({ exe, exeTime: at('2026-11-13T12:00:00Z'), newestSource: at('2026-11-13T11:00:00Z') })).toBeNull();
  });

  it("takes the newest source from this checkout's files, as cargo does, not from commit times", async () => {
    const { utimesSync, statSync } = await import('node:fs');
    const file = 'sidecar/gwb-sidecar/src/main.rs';
    const was = statSync(file);
    try {
      const later = new Date(Date.now() + 60_000);
      utimesSync(file, later, later);
      expect(newestSidecarSource()).toBe(later.getTime());
    } finally {
      utimesSync(file, was.atime, was.mtime);
    }
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

describe("what counts as an input of gwb-sidecar.exe", async () => {
  const { sidecarInput } = await import('../../build/e2e.mjs');
  it("is its files, gwb-sidecar-api's, what it embeds and the manifests, not tests, other binaries or other crates", () => {
    for (const yes of ['sidecar/gwb-sidecar/src/main.rs', 'sidecar/gwb-sidecar/src/cdp.rs', 'sidecar/gwb-sidecar-api/src/lib.rs', 'sidecar/Cargo.lock', 'sidecar/Cargo.toml', 'sidecar/gwb-sidecar/Cargo.toml', 'sidecar/ui/ui.js', 'sidecar/ui/index.html', 'sidecar/profiles/raster-cog.toml', 'sidecar/profiles/linux/points-copc.toml', 'sidecar/gwb-sidecar/src/recipe_run_page.js']) expect(sidecarInput(yes), yes).toBe(true);
    for (const no of ['sidecar/gwb-sidecar/tests/gwb_run.rs', 'sidecar/gwb-sidecar/src/bin/run.rs', 'sidecar/gwb-sfm/src/ba.rs', 'sidecar/gwb-stereo/src/main.rs', 'sidecar/stubs/nolzo/src/lib.rs', 'sidecar/gwb-sidecar-api/src/bin/export-schema.rs', 'sidecar/installer/vendor-pins.toml']) expect(sidecarInput(no), no).toBe(false);
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
