import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CI_SUMS, HTML, ciProblems, digestProblems, family, formatSums, missingFamilies, parseSums, uploadPlan } from '../../build/release/assets.mjs';
import { manifestParts, webSbom } from '../../build/release/sbom.mjs';
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
    // The release workflow's own asset isn't staged, and isn't a stray.
    expect(digestProblems(new Map([['SHA256SUMS', h('s')]]), [{ name: 'SHA256SUMS', state: 'uploaded', digest: `sha256:${h('s')}` }, { name: CI_SUMS, state: 'uploaded', digest: 'sha256:00' }])).toEqual([]);
  });

  it('passes only when every staged HTML file matches the CI rebuild', () => {
    const sums = new Map([...HTML.map((n) => [n, h(n)]), ['x.gwpack', h('x')]]);
    const ci = formatSums(HTML.map((n) => ({ name: n, sha256: h(n) })));
    expect(ciProblems(sums, ci)).toEqual([]);
    // Git Bash's sha256sum on Windows writes `hash *name` with CRLF.
    expect(ciProblems(sums, ci.replace(/\n/g, '\r\n').replace(/  /g, ' *'))).toEqual([]);
    expect(ciProblems(sums, null)).toEqual([`${CI_SUMS} is not on the release, so the HTML can't be checked against the CI rebuild`]);
    expect(ciProblems(sums, '')).toEqual(HTML.map((n) => `${n} is not in ${CI_SUMS}`));
    const lite = 'gis-workbench-lite.html';
    expect(ciProblems(sums, ci.replace(h(lite), h('other')))).toEqual([`${lite} doesn't match the CI rebuild: staged ${h(lite)}, CI ${h('other')}`]);
    const unstaged = new Map(sums);
    unstaged.delete(lite);
    expect(ciProblems(unstaged, ci)).toEqual([`${lite} is not staged`]);
  });
});

describe('web app SBOM', () => {
  const report = {
    build: { id: 'abc', version: '2.7.0', date: '2026-11-08T00:00:00.000Z' },
    packages: [{ name: '@mapbox/vector-tile', version: '3.0.0', license: 'BSD-3-Clause' }],
    rustCrates: [{ name: 'brotli', version: '8.0.0', license: 'BSD-3-Clause/MIT' }, { name: 'nolicence', version: '1.0.0' }],
  };

  it('lists the embedded third-party blocks, and skips ours and those the package lists cover', () => {
    const blocks = {
      'wasm-sqlite': { kind: 'wasm', sha256: h('s'), licence: 'SQLite public domain; sql.js MIT' },
      'data-egm96': { kind: 'data', sha256: h('e'), licence: 'public domain (NGA)' },
      'wasm-core': { kind: 'wasm', sha256: h('c'), licence: 'Apache-2.0' },
      'js-three': { kind: 'js', sha256: h('t'), licence: 'see notices' },
      'data-tokens': { kind: 'data', sha256: h('k'), licence: 'own' },
    };
    const c = webSbom(report, { blocks }).components.filter((x) => x.properties[0].value === 'html-block');
    expect(c).toEqual([
      { type: 'data', name: 'data-egm96', hashes: [{ alg: 'SHA-256', content: h('e') }], licenses: [{ license: { name: 'public domain (NGA)' } }], properties: [{ name: 'gwb:part', value: 'html-block' }] },
      { type: 'library', name: 'wasm-sqlite', hashes: [{ alg: 'SHA-256', content: h('s') }], licenses: [{ license: { name: 'SQLite public domain; sql.js MIT' } }], properties: [{ name: 'gwb:part', value: 'html-block' }] },
    ]);
  });

  it('lists the bundled packages, crates and packs, with SPDX licences and purls', () => {
    const s = webSbom(report, { packs: { proj: { title: 'PROJ', version: '9.7.0', file: 'proj-9.7.0.gwpack', sha256: h('p') }, ai: { title: 'AI', version: '1.0', file: 'ai-1.0.gwpack', sha256: h('a') } } });
    expect(s).toMatchObject({ bomFormat: 'CycloneDX', specVersion: '1.5', metadata: { timestamp: report.build.date, component: { name: 'gis-workbench', version: '2.7.0' } } });
    expect(s.components.map((c) => [c.name, c.purl ?? c.properties[1].value, c.licenses?.[0].expression])).toEqual([
      ['@mapbox/vector-tile', 'pkg:npm/%40mapbox/vector-tile@3.0.0', 'BSD-3-Clause'],
      ['brotli', 'pkg:cargo/brotli@8.0.0', 'BSD-3-Clause OR MIT'],
      ['nolicence', 'pkg:cargo/nolicence@1.0.0', undefined],
      ['ai.gwpack', 'ai-1.0.gwpack', undefined],
      ['proj.gwpack', 'proj-9.7.0.gwpack', undefined],
    ]);
    expect(JSON.stringify(webSbom(report))).toBe(JSON.stringify(webSbom(report)));
  });

  it('reads the packs and blocks from the HTML build manifest', () => {
    expect(manifestParts('<script type="application/json" id="build-manifest">{"packs":{"x":{"version":"1"}},"blocks":{"b":{"kind":"wasm"}}}</script>')).toEqual({ packs: { x: { version: '1' } }, blocks: { b: { kind: 'wasm' } } });
    expect(manifestParts('<html></html>')).toEqual({ packs: {}, blocks: {} });
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
    const manifest = { packs: { proj: { title: 'PROJ', version: '9.7.0', file: 'proj-9.7.0.gwpack', sha256: h('proj') } } };
    const report = { build: { id: 'b1', version: '2.7.0', date: '2026-11-08T00:00:00.000Z' }, packages: [{ name: 'a', version: '1.0.0', license: 'MIT' }], rustCrates: [] };
    const files = {
      'gis-workbench.html': `<script type="application/json" id="build-manifest">${JSON.stringify(manifest)}</script>`,
      'gis-workbench-lite.html': 'lite',
      'gis-workbench-airgap.html': 'airgap',
      'packs/proj-9.7.0.gwpack': 'proj',
      'build-report.json': JSON.stringify(report),
    };
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
      'gis-workbench-2.7.0-sbom.cdx.json', 'gis-workbench-airgap.html', 'gis-workbench-lite.html', 'gis-workbench.html', 'gwb-sidecar-module-media-0.3.0.zip', 'gwb-sidecar-module-sfm-0.3.0.tar.gz', 'proj-9.7.0.gwpack',
    ]);
    const sums = parseSums(readFileSync(join(out, 'SHA256SUMS'), 'utf8'));
    expect(sums.get('GWB-Sidecar-0.3.0-sbom.cdx.json')).toBe(h('sbom.cdx.json'));
    expect(sums.size).toBe(14);
    const sbom = JSON.parse(readFileSync(join(out, 'gis-workbench-2.7.0-sbom.cdx.json'), 'utf8'));
    expect(sbom.components.map((c) => c.name)).toEqual(['a', 'proj.gwpack']);
    expect(sbom.components[1].hashes).toEqual([{ alg: 'SHA-256', content: h('proj') }]);
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

  it('refuses a build report that changed after the build', () => {
    const t = tree();
    put(join(t.dist, 'build-report.json'), '{}');
    expect(plan(t).problems).toEqual([expect.stringMatching(/build-report\.json doesn't match dist\/SHA256SUMS/)]);
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
