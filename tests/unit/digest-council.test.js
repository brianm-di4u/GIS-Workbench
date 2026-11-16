// The weekly digest's count of what the council found, read from the run ledgers
// in .pipeline/runs/. The functions live in .pipeline/lib/digest.mjs.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../.pipeline/lib/config.mjs';
import { buildDigest, councilFindings, readLedgers, renderDigest } from '../../.pipeline/lib/digest.mjs';
import { tempDir } from '../tools/temp-dir.mjs';

const ledger = (...findings) => ({ findings });
const f = (seat, severity, status = 'open') => ({ seat, severity, status });
const NONE = { ledgers: 0, total: 0, preExisting: 0, bySeat: [] };

describe('councilFindings', () => {
  it('counts findings by seat and severity across ledgers', () => {
    const out = councilFindings([
      ledger(f('council-bug-hunter', 'should'), f('council-bug-hunter', 'nit'), f('council-architect', 'blocker')),
      ledger(f('council-bug-hunter', 'should', 'fixed'), f('council-architect', 'nit', 'pre-existing')),
    ]);
    expect(out.total).toBe(5);
    expect(out.preExisting).toBe(1);
    expect(out.bySeat).toEqual([
      { seat: 'council-architect', blocker: 1, should: 0, nit: 1, other: 0 },
      { seat: 'council-bug-hunter', blocker: 0, should: 2, nit: 1, other: 0 },
    ]);
  });

  it('credits every seat that raised a finding, once in the total', () => {
    const out = councilFindings([ledger({ seat: 'council-bug-hunter', seats: ['council-bug-hunter', 'council-architect'], severity: 'should', status: 'fixed' })]);
    expect(out.total).toBe(1);
    expect(out.bySeat.map((r) => [r.seat, r.should])).toEqual([['council-architect', 1], ['council-bug-hunter', 1]]);
  });

  it('files a finding with no seat, or an unknown severity, rather than dropping it', () => {
    const out = councilFindings([ledger({ severity: 'should' }, f('council-minimalist', 'odd'))]);
    expect(out.total).toBe(2);
    expect(out.bySeat.find((r) => r.seat === 'unknown').should).toBe(1);
    expect(out.bySeat.find((r) => r.seat === 'council-minimalist').other).toBe(1);
  });

  it('gives an empty result for no ledgers, an empty ledger, or a malformed one', () => {
    expect(councilFindings([])).toEqual(NONE);
    expect(councilFindings(undefined)).toEqual(NONE);
    // Other tools keep state files in the same folder (autopilot.json, garden.json): not ledgers.
    expect(councilFindings([ledger(), {}, null, { findings: 'x' }, { lastRun: 1 }, ledger(null, 3)])).toEqual({ ...NONE, ledgers: 2 });
  });
});

describe('readLedgers', () => {
  it('reads every ledger in a folder and skips files that are not JSON', () => {
    const dir = tempDir('gwb-digest');
    writeFileSync(join(dir, 'a.json'), JSON.stringify(ledger(f('council-architect', 'nit'))));
    writeFileSync(join(dir, 'broken.json'), '{ not json');
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    expect(councilFindings(readLedgers(dir)).total).toBe(1);
  });

  it('treats a missing folder as no ledgers, and an old ledger as outside the window', () => {
    const dir = tempDir('gwb-digest');
    expect(readLedgers(join(dir, 'does-not-exist'))).toEqual([]);
    writeFileSync(join(dir, 'a-file'), 'x');
    expect(readLedgers(join(dir, 'a-file'))).toEqual([]); // a path that is not a folder
    writeFileSync(join(dir, 'a.json'), JSON.stringify(ledger(f('council-architect', 'nit'))));
    expect(readLedgers(dir, '2999-01-01T00:00:00.000Z')).toEqual([]);
    expect(readLedgers(dir, '2000-01-01T00:00:00.000Z')).toHaveLength(1);
  });
});

describe('renderDigest council section', () => {
  const data = (council) => ({
    since: '2026-11-08T00:00:00Z',
    summary: {
      merged: 0, byTier: { 0: 0, 1: 0, 2: 0, revert: 0 }, humanTouches: { median: null, p95: null },
      rounds: { median: null, p95: null, fiveOrMore: 0 }, size: { median: null, p95: null }, dispositions: {},
      approvals: [], reverted: [], decisionWait: { median: null, open: 0 },
    },
    decisions: [], state: { breaker: [], mainRed: [], audit: [] }, council,
  });

  it('says no ledgers were found, rather than no findings, when there are none (as in CI)', () => {
    for (const council of [councilFindings([]), undefined]) {
      expect(renderDigest(data(council))).toMatch(/## What the council found\n\nNo council run ledgers were found here\..*not a count of zero/);
    }
  });

  it('says no findings when ledgers were read and hold none', () => {
    expect(renderDigest(data(councilFindings([ledger()])))).toContain('No council findings recorded in 1 ledgers updated since 2026-11-08.');
  });

  it('renders a table row per seat', () => {
    const text = renderDigest(data(councilFindings([ledger(f('council-bug-hunter', 'should'), f('council-bug-hunter', 'nit'))])));
    expect(text).toContain('| council-bug-hunter | 0 | 1 | 1 |');
    expect(text).toContain('2 findings (0 pre-existing) in 1 local ledgers updated since 2026-11-08.');
  });
});

describe('buildDigest', () => {
  const client = { list: async () => [], get: async () => ({}) };
  const botIssues = async () => [];
  const build = (runsDir) => buildDigest({ client, repo: 'o/r', now: new Date('2026-11-15T00:00:00Z'), config: loadConfig(), botIssues, runsDir });

  it('carries the council findings from the runs folder into the digest', async () => {
    const dir = tempDir('gwb-digest');
    writeFileSync(join(dir, 'a.json'), JSON.stringify(ledger(f('council-architect', 'should'))));
    expect((await build(dir)).council).toMatchObject({ ledgers: 1, total: 1 });
  });

  it('builds with no runs folder at all, and renders it as no ledgers rather than no findings', async () => {
    const data = await build(join(tempDir('gwb-digest'), 'missing'));
    expect(data.council.ledgers).toBe(0);
    expect(renderDigest(data)).toContain('No council run ledgers were found here.');
  });
});
