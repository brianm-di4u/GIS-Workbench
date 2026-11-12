// #228: tests that made folders under the OS temp directory themselves left thousands behind.
// New temp folders come from tests/tools/temp-dir.mjs, which removes them; this flags a test that
// calls os.tmpdir itself. The files below did so before the helper existed. Moving one to tempDir()
// means taking it off the list, and the list may only shrink. The check reads .js and .mjs files
// for the plain call; a Python helper cleans up its own scratch (hydro_oracle.py registers atexit).
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import config from '../../vitest.config.js';
import { removeTempDirs, tempDir } from '../tools/temp-dir.mjs';

const CALLS_TMPDIR = /\btmpdir\(\)/;
const HELPER = 'tests/tools/temp-dir.mjs';
const BEFORE_THE_HELPER = new Set([
  'tests/e2e/21-nitf.spec.js',
  'tests/e2e/21-sar.spec.js',
  'tests/e2e/24-auth.spec.js',
  'tests/e2e/24-geopdf.spec.js',
  'tests/e2e/24-sensor.spec.js',
  'tests/e2e/24-svc.spec.js',
  'tests/e2e/25-aero.spec.js',
  'tests/e2e/25-lidarreg.spec.js',
  'tests/e2e/25-streams.spec.js',
  'tests/e2e/27-hydro.spec.js',
  'tests/e2e/27-las-crs.spec.js',
  'tests/e2e/27-sargeo.spec.js',
  'tests/e2e/27-terrain-detail.spec.js',
  'tests/e2e/closeout-ui.spec.js',
  'tests/e2e/extract.spec.js',
  'tests/e2e/graphics.spec.js',
  'tests/e2e/l10n-exports.spec.js',
  'tests/e2e/nav.spec.js',
  'tests/e2e/pip-p6.spec.js',
  'tests/e2e/platform.spec.js',
  'tests/e2e/r2-gaps.spec.js',
  'tests/e2e/remote-edit.spec.js',
  'tests/e2e/scn17-gpkg.spec.js',
  'tests/e2e/scn17.spec.js',
  'tests/e2e/sidecar/26-python.spec.js',
  'tests/e2e/stream-pc.spec.js',
  'tests/e2e/tiles3d.spec.js',
  'tests/golden/grids.test.js',
  'tests/tools/dof_surfaces.mjs',
  'tests/unit/aridpcm.test.js',
  'tests/unit/cargo-target.test.js',
  'tests/unit/change-hash-generated.test.js',
  'tests/unit/change-hash.test.js',
  'tests/unit/changelog.test.js',
  'tests/unit/classify-failure.test.js',
  'tests/unit/cors-relay.test.js',
  'tests/unit/csm-gate.test.js',
  'tests/unit/endmember.test.js',
  'tests/unit/filework26.test.js',
  'tests/unit/geopdf-read.test.js',
  'tests/unit/geoproc.test.js',
  'tests/unit/glibc-gate.test.js',
  'tests/unit/i18n.test.js',
  'tests/unit/machine-lock.test.js',
  'tests/unit/media-gate.test.js',
  'tests/unit/models3d.test.js',
  'tests/unit/node-modules-check.test.js',
  'tests/unit/obs-export.test.js',
  'tests/unit/obstruction25.test.js',
  'tests/unit/pdf-text.test.js',
  'tests/unit/polsar24.test.js',
  'tests/unit/python-client.test.js',
  'tests/unit/release-tools.test.js',
  'tests/unit/reproducible-build.test.js',
  'tests/unit/streams25.test.js',
  'tests/unit/verify-sidecar-leg.test.js',
]);

describe('test temp folders', () => {
  it('makes a new, empty folder each call and removes them all', () => {
    const a = tempDir('gw-temp-dir-test');
    const b = tempDir('gw-temp-dir-test');
    expect(a).not.toBe(b);
    writeFileSync(join(a, 'x.txt'), 'x');
    removeTempDirs();
    expect([existsSync(a), existsSync(b)]).toEqual([false, false]);
  });

  it('removes its folders when a process exits without cleaning up', () => {
    const helper = pathToFileURL(HELPER).href;
    const dir = execFileSync(process.execPath, ['--input-type=module', '-e', `import { tempDir } from '${helper}'; process.stdout.write(tempDir('gw-temp-dir-exit'));`], { encoding: 'utf8' });
    expect(dir).toContain('gw-temp-dir-exit-');
    expect(existsSync(dir)).toBe(false);
  });

  it("vitest removes each test file's folders, since its workers may skip exit handlers", () => {
    expect(config.test.setupFiles).toContain('tests/tools/temp-dir-vitest.mjs');
  });

  it('no test calls os.tmpdir itself unless it did before the helper', () => {
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'tests'], { encoding: 'utf8' })
      .split('\n')
      .filter((f) => /\.m?js$/.test(f) && f !== HELPER && existsSync(f));
    const calling = files.filter((f) => CALLS_TMPDIR.test(readFileSync(f, 'latin1')));
    const added = calling.filter((f) => !BEFORE_THE_HELPER.has(f));
    expect(added, 'make temp folders with tempDir() from tests/tools/temp-dir.mjs, which removes them').toEqual([]);
    const moved = [...BEFORE_THE_HELPER].filter((f) => !calling.includes(f));
    expect(moved, 'these no longer call os.tmpdir: take them off BEFORE_THE_HELPER').toEqual([]);
  });
});
