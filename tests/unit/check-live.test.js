import { describe, expect, it } from 'vitest';
import { liveBuild, liveVerdict } from '../../build/check-live.mjs';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const sums = new Map([['gis-workbench.html', A]]);
const build = { id: '7a48ea70b1c18182', version: '2.6.0' };

describe('live app check', () => {
  it('passes when the live page is the release file', () => {
    const v = liveVerdict({ sha256: A, build, tag: 'v2.6.0', sums, file: 'gis-workbench.html' });
    expect(v).toEqual({ ok: true, message: "The live app is v2.6.0's gis-workbench.html (2.6.0, build 7a48ea70b1c18182)." });
  });

  it('fails on a different hash, and says which build the page claims', () => {
    const v = liveVerdict({ sha256: B, build, tag: 'v2.7.0', sums, file: 'gis-workbench.html' });
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/not v2\.7\.0's gis-workbench\.html: it hashes to b{64}, the release lists a{64}\. The page says 2\.6\.0, build 7a48ea70b1c18182\./);
  });

  it('fails when the release lists no such file, or the page has no manifest', () => {
    expect(liveVerdict({ sha256: A, build: null, tag: 'v2.6.0', sums, file: 'x.html' }).ok).toBe(false);
    expect(liveVerdict({ sha256: B, build: null, tag: 'v2.6.0', sums, file: 'gis-workbench.html' }).message).toMatch(/no build manifest/);
  });

  it('reads the build from the page manifest, and survives a broken one', () => {
    const page = `<html><script type="application/json" id="build-manifest">${JSON.stringify({ build })}</script></html>`;
    expect(liveBuild(page)).toEqual(build);
    expect(liveBuild('<html></html>')).toBeNull();
    expect(liveBuild('<script type="application/json" id="build-manifest">{oops</script>')).toBeNull();
  });
});
