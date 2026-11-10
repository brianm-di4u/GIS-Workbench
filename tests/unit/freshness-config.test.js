// This repo's branch-freshness setting (decision 0013): a PR that is behind main is held only when
// main changed a file it also changes, a floor path, or a path in a group it also touches.
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../.pipeline/lib/config.mjs';
import { cleanFreshness, expandEntries, freshnessOf } from '../../.pipeline/lib/freshness.mjs';

const warnings = [];
const config = loadConfig('pipeline.config.json', { warn: (message) => warnings.push(message) });
const setting = cleanFreshness(config.freshness, (message) => warnings.push(message));
const stale = (main, pr) => freshnessOf(setting, main, pr).stale;

describe('the freshness setting', () => {
  it('is valid, in overlap mode, with no warnings', () => {
    expect(warnings).toEqual([]);
    expect(setting.mode).toBe('overlap');
    expect(setting.floor.length).toBeGreaterThan(0);
  });

  it('keeps every group non-empty and gives each crate its own group', () => {
    for (const [name, globs] of Object.entries(setting.groups)) expect(globs.length, name).toBeGreaterThan(0);
    // Every crate directory, so a new crate fails here until its group is added.
    const crates = readdirSync('crates', { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('gw-')).map((d) => d.name);
    expect(crates.length).toBeGreaterThan(0);
    for (const crate of crates) expect(setting.groups[`crate-${crate}`], crate).toEqual([`crates/${crate}/**`]);
  });

  it('lets unrelated PRs merge without updating', () => {
    expect(stale(['app/src/features/files.js'], ['app/src/features/tin-editor.js'])).toBe(false);
    expect(stale(['docs/RUNBOOK.md'], ['app/src/features/files.js'])).toBe(false);
    expect(stale(['crates/gw-tin/src/lib.rs'], ['crates/gw-raster/src/lib.rs'])).toBe(false);
  });

  it('holds a PR when main changed a file it also changes', () => {
    expect(stale(['app/src/features/files.js'], ['app/src/features/files.js'])).toBe(true);
  });

  it('holds a PR when main changed another file in a group it touches', () => {
    expect(stale(['crates/gw-tin/src/lib.rs'], ['crates/gw-tin/src/other.rs'])).toBe(true);
    expect(stale(['app/src/i18n/catalog/en.json'], ['app/src/shell/ribbon-data.js'])).toBe(true);
    expect(stale(['app/src/shell/commands.js'], ['app/src/shell/command-meta.js'])).toBe(true);
    expect(stale(['tests/quarantine.json'], ['tests/e2e/helpers.js'])).toBe(true);
    expect(stale(['sidecar/gwb-stereo/src/lib.rs'], ['sidecar/gwb-sfm/src/lib.rs'])).toBe(true);
    expect(stale(['sidecar/gwb-sidecar-api/src/lib.rs'], ['app/src/sidecar/client.js'])).toBe(true);
  });

  it('holds every PR when main changed a floor path, built in or added here', () => {
    const unrelated = ['app/src/features/files.js'];
    for (const path of [
      'pipeline.config.json', '.pipeline/gate.mjs', '.github/workflows/gate.yml', 'package-lock.json', 'sidecar/Cargo.lock', 'crates/Cargo.toml',
      'build/rust.mjs', 'build/release/stage.mjs', 'playwright.config.js', 'playwright.webkit.config.js', 'vitest.config.js', '.node-version',
      'crates/rust-toolchain.toml', 'sidecar/rust-toolchain.toml', 'crates/deny.toml', 'sidecar/deny.toml',
      '.cargo/config.toml', 'crates/.cargo/config.toml', 'crates/gw-tin/build.rs', 'crates/vendor/fax/src/lib.rs',
      'REVIEW.md', 'CLAUDE.md', '.claude/agents/council-architect.md',
      '.claude/workflows/council-round.js', '.claude/skills/full-send/SKILL.md',
    ]) {
      expect(stale([path], unrelated), path).toBe(true);
    }
  });

  it('writes a directory as a glob list that covers what is under it', () => {
    expect(expandEntries(['schema/'])).toEqual(['schema', 'schema/**']);
  });
});
