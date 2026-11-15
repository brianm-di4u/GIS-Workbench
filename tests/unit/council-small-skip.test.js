// Decision 0024 (#277): a T1 change of council.maxMechanicalLines (40) changed lines or fewer skips the
// loop phase and goes straight to close-out; T2 keeps both phases at any size. The size is the strict
// count, so a binary file or a diff git couldn't produce never counts as small.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UNBOUNDED, countLines } from '../../.pipeline/lib/git.mjs';
import { buildVerdict, emptyLedger, nextStep, recordRound, skipsLoop } from '../../.pipeline/lib/ledger.mjs';
import { tempDir } from '../tools/temp-dir.mjs';

const council = { loopModel: 'sonnet', closeModel: 'opus', maxLoopRounds: 16, maxCloseRounds: 8, maxMechanicalLines: 40 };
const HASH = 'a'.repeat(64);
const step = (ledger, tier, lines) => nextStep({ ledger, tier, hash: HASH, council, cleanTree: true, evidenceOk: true, diffLines: lines, skipLines: lines });

function run(ledger, tier, lines) {
  const next = step(ledger, tier, lines);
  expect(next.status, JSON.stringify(next)).toBe('review');
  recordRound(ledger, {
    mode: next.mode, round: next.round, phase: next.phase, model: next.model, hash: HASH, sha: 's', diffLines: lines,
    result: { findings: [], seats: ['council-bug-hunter'], missing: [], refuted: 0, maxNits: 5 },
  });
  return next;
}

describe('a small T1 change', () => {
  it('skips the loop at 40 lines, and not at 41', () => {
    expect(step(emptyLedger(), 1, 40)).toMatchObject({ status: 'review', phase: 'close', model: 'opus', round: 1 });
    expect(step(emptyLedger(), 1, 41)).toMatchObject({ status: 'review', phase: 'loop', model: 'sonnet', round: 1 });
  });

  it('keeps both phases for T2 at any size', () => {
    expect(step(emptyLedger(), 2, 40)).toMatchObject({ phase: 'loop' });
    expect(step(emptyLedger(), 2, 2)).toMatchObject({ phase: 'loop' });
  });

  it('is done after two clean close-out rounds, and its verdict renders', () => {
    const ledger = emptyLedger();
    expect(run(ledger, 1, 40).phase).toBe('close');
    expect(run(ledger, 1, 40).phase).toBe('close');
    expect(step(ledger, 1, 40).status).toBe('done');
    const verdict = buildVerdict({ ledger, tier: 1, hash: HASH, skipLines: 40, council });
    expect(verdict.phases).toEqual({ loop: { rounds: 0, model: null }, close: { rounds: 2, model: 'opus' } });
  });

  it('refuses a verdict without loop rounds for T2, or for a T1 change past 40 lines', () => {
    const ledger = emptyLedger();
    run(ledger, 1, 40);
    run(ledger, 1, 40);
    expect(() => buildVerdict({ ledger, tier: 2, hash: HASH, skipLines: 40, council })).toThrow(/Close-out has not converged/);
    expect(() => buildVerdict({ ledger, tier: 1, hash: HASH, skipLines: 41, council })).toThrow(/Close-out has not converged/);
    // A change that grew past the line count goes back to the loop phase.
    expect(step(ledger, 1, 41)).toMatchObject({ status: 'review', phase: 'loop' });
  });

  it('follows maxMechanicalLines, and treats a missing or unbounded size as large', () => {
    expect(skipsLoop({ tier: 1, lines: 60, council: { maxMechanicalLines: 60 } })).toBe(true);
    expect(skipsLoop({ tier: 1, lines: 41, council: {} })).toBe(false);
    expect(skipsLoop({ tier: 1, lines: 40, council: {} })).toBe(true);
    expect(skipsLoop({ tier: 1, lines: undefined, council })).toBe(false);
    expect(skipsLoop({ tier: 1, lines: UNBOUNDED, council })).toBe(false);
    expect(skipsLoop({ tier: 0, lines: 1, council })).toBe(false);
    // The plan reads skipLines, not diffLines: a change whose seats see 10 lines but that holds a binary
    // file keeps the loop.
    const next = nextStep({ ledger: emptyLedger(), tier: 1, hash: HASH, council, cleanTree: true, evidenceOk: true, diffLines: 10, skipLines: UNBOUNDED });
    expect(next.phase).toBe('loop');
  });

  it('counts a change with a binary file as unbounded, so it never skips the loop', () => {
    const dir = tempDir('gwb-skip');
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'T');
    git('config', 'user.email', 't@example.com');
    git('config', 'core.autocrlf', 'false');
    writeFileSync(join(dir, 'a.js'), 'x\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    const base = git('rev-parse', 'HEAD').trim();
    writeFileSync(join(dir, 'a.js'), Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n') + '\n');
    mkdirSync(join(dir, 'fixtures'));
    writeFileSync(join(dir, 'fixtures', 'truth.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    git('add', '-A');
    git('commit', '-q', '-m', 'change');
    const loose = countLines(base, 'HEAD', base, [], { cwd: dir });
    const strict = countLines(base, 'HEAD', base, [], { strict: true, cwd: dir });
    expect(loose).toBeLessThanOrEqual(40);
    expect(strict).toBeGreaterThanOrEqual(UNBOUNDED);
    expect(skipsLoop({ tier: 1, lines: strict, council })).toBe(false);
  });
});
