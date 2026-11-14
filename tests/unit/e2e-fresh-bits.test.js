// The release e2e refuses to test a sidecar binary older than the sidecar's code: the harness runs
// whatever binary sits in the target folder, so a stale one passed the suites on old code.
import { describe, expect, it } from 'vitest';
import { newestSidecarSource, staleSidecar } from '../../build/e2e.mjs';

const exe = 'C:/t/release/gwb-sidecar.exe';
const at = (iso) => Date.parse(iso);

describe('the e2e sidecar check', () => {
  it('refuses a binary older than the newest change to sidecar/', () => {
    expect(staleSidecar({ exe, exeTime: at('2026-11-13T10:00:00Z'), newestSource: at('2026-11-13T11:00:00Z') })).toMatch(/older than the newest change to sidecar\/.*Build it again/);
  });

  it('refuses a missing binary', () => {
    expect(staleSidecar({ exe, exeTime: null, newestSource: at('2026-11-13T11:00:00Z') })).toMatch(/there is no sidecar at/);
  });

  it('accepts a binary built after the newest change', () => {
    expect(staleSidecar({ exe, exeTime: at('2026-11-13T12:00:00Z'), newestSource: at('2026-11-13T11:00:00Z') })).toBeNull();
  });

  it("reads the newest change from this checkout's history", () => {
    const newest = newestSidecarSource();
    expect(newest).toBeGreaterThan(at('2026-01-01T00:00:00Z'));
    expect(newest).toBeLessThanOrEqual(Date.now());
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
