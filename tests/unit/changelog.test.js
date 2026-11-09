import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assemble, insertRelease, parseFragment } from '../../build/release/changelog.mjs';

describe('changelog fragments', () => {
  it('reads sections and items, nested items and wrapped lines included', () => {
    const { sections, problems } = parseFragment('### Fixed\n- **A:** one\n  - detail\n  wrapped\n\n### Added\n- two\n', 'a.md');
    expect(problems).toEqual([]);
    expect(sections).toEqual({ Fixed: ['- **A:** one', '  - detail', '  wrapped'], Added: ['- two'] });
  });

  it('refuses what the site parser would refuse', () => {
    const bad = (text, name = 'a.md') => parseFragment(text, name).problems;
    expect(bad('- an item before any heading')[0]).toMatch(/start with/);
    expect(bad('### Fixes\n- x')[0]).toMatch(/unknown section "Fixes"/);
    expect(bad('## [2.7.0] - 2026-12-01\n### Fixed\n- x')[0]).toMatch(/only "### Section"/);
    expect(bad('### Fixed\nplain text')[0]).toMatch(/list item/);
    expect(bad('### Fixed\n')).toEqual(['a.md: no items']);
    expect(bad('### Fixed\n- x', 'Fix Labels.md')[0]).toMatch(/lower case/);
    expect(bad('### Fixed\n* x')[0]).toMatch(/list item/); // the app's What's New reads only "- "
  });

  it('assembles from the command line, and refuses a version or date the site would reject', () => {
    const root = mkdtempSync(join(tmpdir(), 'gwb-changes-'));
    const cli = (...args) => spawnSync(process.execPath, ['build/release/changelog.mjs', 'assemble', '--root', root, ...args], { encoding: 'utf8' });
    try {
      mkdirSync(join(root, 'changes'));
      writeFileSync(join(root, 'changes', 'fix-a.md'), '### Fixed\n- fix a\n');
      writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## [2.6.0] - 2026-11-06\n\n### Fixed\n- old\n');
      expect(cli('--version', 'v2.7.0').status).toBe(2);
      expect(cli('--version', '2.7.0', '--date', '2026-12-1').status).toBe(2);
      expect(existsSync(join(root, 'changes', 'fix-a.md'))).toBe(true);
      const ok = cli('--version', '2.7.0', '--date', '2026-12-01');
      expect(ok.status).toBe(0);
      expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toBe('# Changelog\n\n## [2.7.0] - 2026-12-01\n\n### Fixed\n- fix a\n\n## [2.6.0] - 2026-11-06\n\n### Fixed\n- old\n');
      expect(existsSync(join(root, 'changes', 'fix-a.md'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('assembles fragments in Keep a Changelog order and puts the release on top', () => {
    const a = parseFragment('### Fixed\n- fix a\n', 'a.md');
    const b = parseFragment('### Added\n- add b\n### Fixed\n- fix b\n', 'b.md');
    const block = assemble([a, b], { version: '2.7.0', date: '2026-12-01', summary: 'Summary.' });
    expect(block).toBe('## [2.7.0] - 2026-12-01\n\nSummary.\n\n### Added\n- add b\n\n### Fixed\n- fix a\n- fix b\n');
    const log = '# Changelog\n\nIntro.\n\n## [2.6.0] - 2026-11-06\n\n### Fixed\n- old\n';
    expect(insertRelease(log, block, '2.7.0')).toBe(`# Changelog\n\nIntro.\n\n${block}\n## [2.6.0] - 2026-11-06\n\n### Fixed\n- old\n`);
    expect(() => insertRelease(log, block, '2.6.0')).toThrow(/already has 2.6.0/);
  });

  it('accepts every section of the real CHANGELOG.md as a fragment', () => {
    const latest = readFileSync('CHANGELOG.md', 'utf8').split(/^## \[/m)[1];
    const body = latest.slice(latest.indexOf('\n### '));
    expect(parseFragment(body, 'latest.md').problems).toEqual([]);
  });
});
