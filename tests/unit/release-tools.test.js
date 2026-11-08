import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { digestProblems, family, formatSums, missingFamilies, parseSums, uploadPlan } from '../../build/release/assets.mjs';
import { copyAndHash, plan } from '../../build/release/stage.mjs';

const h = (s) => createHash('sha256').update(s).digest('hex');

describe('release assets', () => {
  it('reads and writes SHA256SUMS', () => {
    const text = formatSums([{ name: 'b.zip', sha256: h('b') }, { name: 'a.html', sha256: h('a') }]);
    expect(text).toBe(`${h('a')}  a.html\n${h('b')}  b.zip\n`);
    expect(parseSums(`${text}${h('c')} *c.bin\r\nnot a line\n`)).toEqual(new Map([['a.html', h('a')], ['b.zip', h('b')], ['c.bin', h('c')]]));
  });

  it('compares asset families across versions', () => {
    expect(family('GWB-Sidecar-0.3.0-x64.msi')).toBe('GWB-Sidecar-<v>-x64.msi');
    expect(family('locale-pt-BR-2.6.0.gwpack')).toBe('locale-pt-BR-<v>.gwpack');
    expect(missingFamilies(['proj-9.7.0.gwpack', 'gis-workbench.html'], ['proj-9.6.2.gwpack', 'grids-eu-1.0+projdata.gwpack', 'gis-workbench.html'])).toEqual(['grids-eu-<v>+projdata.gwpack']);
  });

  it('plans uploads smallest first and skips only assets with the staged digest', () => {
    const want = new Map([['big', h('big')], ['done', h('done')], ['partial', h('partial')], ['new', h('new')], ['rebuilt', h('rebuilt')], ['SHA256SUMS', h('sums v2')]]);
    const local = [['big', 300], ['done', 10], ['partial', 50], ['new', 20], ['rebuilt', 40], ['SHA256SUMS', 60]].map(([name, size]) => ({ name, size }));
    const remote = [
      { name: 'done', size: 10, state: 'uploaded', digest: `sha256:${h('done')}` },
      { name: 'partial', size: 50, state: 'starter', digest: null },
      { name: 'big', size: 299, state: 'uploaded', digest: `sha256:${h('old big')}` },
      // Same size as the staged file, different content: a rebuilt asset and a re-staged SHA256SUMS.
      { name: 'rebuilt', size: 40, state: 'uploaded', digest: `sha256:${h('rebuilt v1')}` },
      { name: 'SHA256SUMS', size: 60, state: 'uploaded', digest: `sha256:${h('sums v1')}` },
    ];
    expect(uploadPlan(local, remote, want).map((f) => f.name)).toEqual(['new', 'rebuilt', 'partial', 'SHA256SUMS', 'big']);
  });

  it('finds every way a release differs from what was staged, SHA256SUMS included', () => {
    const want = new Map([['a', h('a')], ['b', h('b')], ['c', h('c')], ['d', h('d')], ['e', h('e')], ['SHA256SUMS', h('sums')]]);
    const remote = [
      { name: 'a', state: 'uploaded', digest: `sha256:${h('a')}` },
      { name: 'b', state: 'uploaded', digest: `sha256:${h('x')}` },
      { name: 'c', state: 'starter', digest: null },
      { name: 'd', state: 'uploaded', digest: null },
      { name: 'SHA256SUMS', state: 'uploaded', digest: `sha256:${h('old sums')}` },
      { name: 'stray', state: 'uploaded', digest: 'sha256:00' },
    ];
    expect(digestProblems(want, remote)).toEqual([
      `b has digest sha256:${h('x')}, but the staged file's is ${h('b')}`,
      'c is not fully uploaded (starter)',
      'GitHub reports no digest for d',
      'e is not on the release',
      `SHA256SUMS has digest sha256:${h('old sums')}, but the staged file's is ${h('sums')}`,
      'stray is on the release but not in SHA256SUMS',
    ]);
    expect(digestProblems(new Map([['SHA256SUMS', h('s')]]), [])).toEqual(['SHA256SUMS is not on the release']);
    expect(digestProblems(new Map([['a', h('a')], ['SHA256SUMS', h('s')]]), [remote[0], { name: 'SHA256SUMS', state: 'uploaded', digest: `sha256:${h('s')}` }])).toEqual([]);
  });
});

describe('stage', () => {
  let root;
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, text) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  };
  const tree = ({ stale = false, tamper = false } = {}) => {
    root = mkdtempSync(join(tmpdir(), 'gwb-stage-'));
    const dist = join(root, 'dist');
    const files = { 'gis-workbench.html': 'full', 'gis-workbench-lite.html': 'lite', 'gis-workbench-airgap.html': 'airgap', 'packs/proj-9.7.0.gwpack': 'proj' };
    for (const [n, t] of Object.entries(files)) put(join(dist, n), t);
    put(join(dist, 'SHA256SUMS'), formatSums(Object.entries(files).map(([name, t]) => ({ name, sha256: h(t) }))));
    if (stale) put(join(dist, 'packs', 'old-1.0.gwpack'), 'old');
    if (tamper) put(join(dist, 'gis-workbench.html'), 'changed');
    const win = join(root, 'side', '0.3.0');
    for (const n of ['GWB-Sidecar-0.3.0-x64.msi', 'GWB-Sidecar-0.3.0-x64-portable.zip', 'gwb-sidecar-module-media-0.3.0.zip', 'sbom.cdx.json', 'GWB-Sidecar-0.3.0-x64.wixpdb', 'package-report.json']) put(join(win, n), n);
    for (const n of ['GWB-Sidecar-0.3.0-amd64.deb', 'GWB-Sidecar-0.3.0-x86_64.AppImage', 'GWB-Sidecar-0.3.0-linux-x86_64.tar.gz', 'gwb-sidecar-module-sfm-0.3.0.tar.gz', 'GWB-Sidecar-0.3.0-linux-sbom.cdx.json', 'SHA256SUMS']) put(join(win, 'linux', n), n);
    return { dist, sidecar: join(root, 'side'), version: '0.3.0' };
  };

  it('stages the published files only, with renamed SBOMs and a SHA256SUMS', async () => {
    const { picks, problems } = plan(tree());
    expect(problems).toEqual([]);
    const out = join(root, 'out');
    const done = await copyAndHash(picks, out);
    expect(done.problems).toEqual([]);
    expect(done.entries.map((e) => e.name).sort()).toEqual([
      'GWB-Sidecar-0.3.0-amd64.deb', 'GWB-Sidecar-0.3.0-linux-sbom.cdx.json', 'GWB-Sidecar-0.3.0-linux-x86_64.tar.gz', 'GWB-Sidecar-0.3.0-sbom.cdx.json',
      'GWB-Sidecar-0.3.0-x64-portable.zip', 'GWB-Sidecar-0.3.0-x64.msi', 'GWB-Sidecar-0.3.0-x86_64.AppImage',
      'gis-workbench-airgap.html', 'gis-workbench-lite.html', 'gis-workbench.html', 'gwb-sidecar-module-media-0.3.0.zip', 'gwb-sidecar-module-sfm-0.3.0.tar.gz', 'proj-9.7.0.gwpack',
    ]);
    const sums = parseSums(readFileSync(join(out, 'SHA256SUMS'), 'utf8'));
    expect(sums.get('GWB-Sidecar-0.3.0-sbom.cdx.json')).toBe(h('sbom.cdx.json'));
    expect(sums.size).toBe(13);
    await expect(copyAndHash(picks, out)).rejects.toThrow(/isn't empty/);
  });

  it('refuses a stale pack and missing sidecar files', () => {
    const t = tree({ stale: true });
    rmSync(join(t.sidecar, '0.3.0', 'linux', 'GWB-Sidecar-0.3.0-amd64.deb'));
    expect(plan(t).problems).toEqual([
      expect.stringMatching(/old-1\.0\.gwpack isn't in dist\/SHA256SUMS/),
      expect.stringMatching(/linux: no \.deb$/),
    ]);
  });

  it('refuses two different SBOMs for one platform', () => {
    const t = tree();
    put(join(t.sidecar, '0.3.0', 'GWB-Sidecar-0.3.0-sbom.cdx.json'), 'older');
    expect(plan(t).problems).toEqual([expect.stringMatching(/differ, so it's unclear which SBOM is current/)]);
    put(join(t.sidecar, '0.3.0', 'GWB-Sidecar-0.3.0-sbom.cdx.json'), 'sbom.cdx.json');
    expect(plan(t).problems).toEqual([]);
  });

  it('catches a file that changed after the build', async () => {
    const { picks } = plan(tree({ tamper: true }));
    const done = await copyAndHash(picks, join(root, 'out'));
    expect(done.problems).toEqual(["gis-workbench.html doesn't match dist/SHA256SUMS"]);
  });
});
