// OD-2.18 at the packaging step: a stage that holds the CSM plug-in host, or a service built with
// it, fails (REQ-GAP-25). The Rust side is tests/csmgate.rs and csm_host_stays_off in security.rs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { csmHostProblems } from '../../sidecar/installer/gates.mjs';

describe('the CSM plug-in host stays out of a package', () => {
  let stage;
  let exe;
  beforeEach(() => {
    stage = mkdtempSync(join(tmpdir(), 'gwb-gate-'));
    mkdirSync(join(stage, 'modules', 'core-gdal', 'bin'), { recursive: true });
    exe = join(stage, 'gwb-sidecar.exe');
    writeFileSync(exe, 'a service with no plug-in host in it');
    writeFileSync(join(stage, 'modules', 'core-gdal', 'bin', 'gdalinfo.exe'), 'x');
  });
  afterEach(() => rmSync(stage, { recursive: true, force: true }));
  const problems = () => csmHostProblems(stage, exe, { run: false });

  it('passes a clean stage', () => expect(problems()).toEqual([]));

  for (const f of ['gwb-csm-host.exe', 'gwb-csm-host', 'csmapi.dll', 'libcsmapi.so', 'gwb_mock_csm_plugin.dll', 'gwb_mock_csm_v2.so']) {
    it(`refuses ${f}, wherever it is`, () => {
      writeFileSync(join(stage, 'modules', 'core-gdal', 'bin', f), 'x');
      expect(problems().join()).toContain('must not ship');
    });
  }

  it('refuses a service built with the feature', () => {
    writeFileSync(exe, 'code ... the plug-in host never runs with the sandbox turned off ... code');
    expect(problems().join()).toContain('csm-host feature');
  });
});
