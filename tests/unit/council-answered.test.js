// Council convergence, two more ways a run of clean rounds survives (issue 184), and a round where a
// seat ran out of turns (issue 174). The rules live in .pipeline/lib/ledger.mjs.
import { describe, expect, it } from 'vitest';
import { cleanTail, emptyLedger, linkMechanical, nextStep, recordRound, resolveFinding } from '../../.pipeline/lib/ledger.mjs';

const council = { loopModel: 'sonnet', closeModel: 'opus', maxLoopRounds: 16, maxCloseRounds: 8 };
const HASH = 'a'.repeat(64);
const B = 'b'.repeat(64);

const step = (ledger, hash = HASH) => nextStep({ ledger, tier: 1, hash, council, cleanTree: true, evidenceOk: true, diffLines: 100 });

let counter = 0;
const finding = (severity) => ({ severity, class: `class ${severity} ${counter}`, file: `src/file${counter++}.js`, line: 10, claim: `claim ${counter}`, evidence: 'e', fix: 'f', preExisting: false });

function run(ledger, findings = [], { hash = HASH, partial = [] } = {}) {
  const next = step(ledger, hash);
  expect(next.status, JSON.stringify(next)).toBe('review');
  recordRound(ledger, {
    mode: next.mode, round: next.round, phase: next.phase, model: next.model, hash, sha: 's', diffLines: 100,
    result: { findings, seats: ['council-bug-hunter'], missing: [], partial, refuted: 0, maxNits: 5 },
  });
  return next;
}
const open = (ledger) => ledger.findings.filter((f) => f.status === 'open');
const fixAll = (ledger) => open(ledger).forEach((f) => resolveFinding(ledger, f.id, 'fixed'));
const declineAll = (ledger) => open(ledger).forEach((f) => resolveFinding(ledger, f.id, 'intentional', 'why'));
const tail = (ledger) => cleanTail(ledger.rounds, { findings: ledger.findings });

describe('a should answered without a change', () => {
  it('does not end the run of clean rounds, and does not count as one', () => {
    const ledger = emptyLedger();
    run(ledger); // clean
    run(ledger, [finding('should')]);
    declineAll(ledger);
    expect(tail(ledger)).toBe(0); // the latest round isn't clean
    expect(step(ledger)).toMatchObject({ status: 'review', phase: 'loop' });
    run(ledger); // clean, and the round before it was answered with no change
    expect(tail(ledger)).toBe(2);
    expect(step(ledger)).toMatchObject({ status: 'review', phase: 'close' });
  });

  it('still ends the run when the should was fixed, since a fix changes the content', () => {
    const ledger = emptyLedger();
    run(ledger);
    run(ledger, [finding('should')]);
    fixAll(ledger);
    run(ledger);
    expect(tail(ledger)).toBe(1);
  });

  it('still ends the run for a blocker, even one that was declined', () => {
    const ledger = emptyLedger();
    run(ledger);
    run(ledger, [finding('blocker')]);
    declineAll(ledger);
    run(ledger);
    expect(tail(ledger)).toBe(1);
  });

  it('is not undone by a pre-existing finding raised in the same round, which never blocks', () => {
    const ledger = emptyLedger();
    run(ledger);
    run(ledger, [finding('should'), { ...finding('blocker'), preExisting: true }]);
    declineAll(ledger);
    run(ledger);
    expect(tail(ledger)).toBe(2);
  });

  it('is applied in close-out, where PR 178 needed it', () => {
    const ledger = emptyLedger();
    run(ledger);
    run(ledger);
    run(ledger); // close-out, clean
    run(ledger, [finding('should')]);
    declineAll(ledger);
    run(ledger); // clean
    expect(step(ledger).status).toBe('done');
  });
});

describe('a mechanical change', () => {
  it('carries clean rounds over, so one clean round on the new diff is enough', () => {
    const ledger = emptyLedger();
    run(ledger);
    linkMechanical(ledger, { to: B, reason: 'a conflict resolved', lines: 3 });
    expect(step(ledger, B)).toMatchObject({ status: 'review', phase: 'loop', mode: 'diff' });
    run(ledger, [], { hash: B });
    expect(step(ledger, B)).toMatchObject({ status: 'review', phase: 'close' });
  });

  it('is undone by a round that finds something', () => {
    const ledger = emptyLedger();
    run(ledger);
    linkMechanical(ledger, { to: B, reason: 'r', lines: 3 });
    run(ledger, [finding('should')], { hash: B });
    fixAll(ledger);
    run(ledger, [], { hash: B });
    expect(step(ledger, B)).toMatchObject({ status: 'review', phase: 'loop' });
  });

  it('does not let a should answered before the change skip its own fresh review', () => {
    const ledger = emptyLedger();
    run(ledger);
    run(ledger);
    run(ledger); // close-out, clean
    run(ledger, [finding('should')]); // close-out, answered without a change
    declineAll(ledger);
    linkMechanical(ledger, { to: B, reason: 'r', lines: 3 });
    run(ledger, [], { hash: B }); // the diff-only round, clean
    expect(step(ledger, B).status).toBe('review');
    run(ledger, [], { hash: B });
    expect(step(ledger, B).status).toBe('done');
  });

  it('does not let a should answered on the new diff bridge back over the link', () => {
    const ledger = emptyLedger();
    run(ledger);
    run(ledger);
    run(ledger); // close-out, clean
    linkMechanical(ledger, { to: B, reason: 'r', lines: 3 });
    run(ledger, [finding('should')], { hash: B });
    declineAll(ledger);
    run(ledger, [], { hash: B });
    expect(step(ledger, B).status).toBe('review'); // one clean round on B is not two
    run(ledger, [], { hash: B });
    expect(step(ledger, B).status).toBe('done');
  });

  it('does not carry over past a second, unlinked change', () => {
    const ledger = emptyLedger();
    run(ledger);
    linkMechanical(ledger, { to: B, reason: 'r', lines: 3 });
    const C = 'c'.repeat(64);
    run(ledger, [], { hash: C });
    expect(step(ledger, C)).toMatchObject({ status: 'review', phase: 'loop' });
  });

  it('is refused for a big change, an unchanged one, no reason, or before any round', () => {
    const ledger = emptyLedger();
    expect(() => linkMechanical(ledger, { to: B, reason: 'r', lines: 3 })).toThrow(/nothing to carry over/);
    run(ledger);
    expect(() => linkMechanical(ledger, { to: B, reason: 'r', lines: 41 })).toThrow(/at most 40/);
    expect(() => linkMechanical(ledger, { to: B, reason: 'r', lines: null })).toThrow(/at most 40/);
    expect(() => linkMechanical(ledger, { to: HASH, reason: 'r', lines: 1 })).toThrow(/not changed/);
    expect(() => linkMechanical(ledger, { to: B, reason: '', lines: 1 })).toThrow(/why/);
    expect(ledger.mechanical).toBeUndefined();
  });

  it('takes the line limit from the caller', () => {
    const ledger = emptyLedger();
    run(ledger);
    expect(() => linkMechanical(ledger, { to: B, reason: 'r', lines: 10, maxLines: 5 })).toThrow(/at most 5/);
  });
});

describe('a partial round', () => {
  it('keeps its findings, counts toward the cap, and is never clean', () => {
    const ledger = emptyLedger();
    const next = step(ledger);
    const out = recordRound(ledger, {
      mode: next.mode, round: next.round, phase: next.phase, model: next.model, hash: HASH, sha: 's', diffLines: 1,
      result: { findings: [finding('should')], seats: ['council-bug-hunter'], missing: [], partial: ['council-bug-hunter'], maxNits: 5 },
    });
    expect(out.complete).toBe(true);
    expect(out.added).toHaveLength(1);
    expect(ledger.rounds[0].partial).toEqual(['council-bug-hunter']);
    declineAll(ledger);
    expect(tail(ledger)).toBe(0);
  });

  it('with nothing found still does not count as a clean look', () => {
    const ledger = emptyLedger();
    run(ledger, [], { partial: ['council-bug-hunter'] });
    run(ledger);
    expect(tail(ledger)).toBe(1);
    expect(step(ledger)).toMatchObject({ status: 'review', phase: 'loop' });
  });
});
