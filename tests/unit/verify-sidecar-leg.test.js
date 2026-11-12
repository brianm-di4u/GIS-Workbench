// The sidecar CI leg installs no npm packages, so verify's stale node_modules check (issue 169) must
// not stop it. Other legs, and a plain run, still get the check.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const VERIFY = resolve('.pipeline/verify.mjs');
const NO_INSTALL = /no install record/;
let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gwb-leg-'));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// No pipeline.config.json here, so a run that gets past the check fails at the config instead.
const run = (leg) => {
  const env = { ...process.env };
  delete env.GWB_LEG;
  if (leg) env.GWB_LEG = leg;
  return spawnSync(process.execPath, [VERIFY, 'fast'], { cwd: dir, env, encoding: 'utf8' });
};

describe('verify and the stale node_modules check', () => {
  it('stops a run with a lockfile and no install', () => {
    const result = run(undefined);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(NO_INSTALL);
  });

  it('stops the linux leg the same way', () => {
    expect(run('linux').stderr).toMatch(NO_INSTALL);
  });

  it('does not stop the sidecar leg, which installs no packages', () => {
    expect(run('sidecar').stderr).not.toMatch(NO_INSTALL);
  });
});
