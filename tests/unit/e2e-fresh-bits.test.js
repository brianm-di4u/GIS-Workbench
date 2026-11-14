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
