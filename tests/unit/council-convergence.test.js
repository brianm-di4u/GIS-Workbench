// The council's two-phase convergence rule (decision 0014): a loop phase on one model, then close-out
// on another, each ending after two clean rounds in a row with nothing open, each with a hard cap.
import { describe, expect, it } from 'vitest';
import { buildVerdict, cleanTail, emptyLedger, nextStep, phaseState, recordRound, resolveFinding, selectSeats } from '../../.pipeline/lib/ledger.mjs';

const council = { loopModel: 'sonnet', closeModel: 'opus', maxLoopRounds: 8, maxCloseRounds: 4 };
const HASH = 'a'.repeat(64);

const step = (ledger, over = {}) =>
  nextStep({ ledger, tier: over.tier ?? 1, hash: over.hash ?? HASH, council: over.council ?? council, cleanTree: true, evidenceOk: true, diffLines: over.diffLines ?? 100 });

let counter = 0;
const finding = (severity, over = {}) => ({ severity, class: `class ${severity} ${counter}`, file: `src/file${counter++}.js`, line: 10, claim: `claim ${counter}`, evidence: 'e', fix: 'f', preExisting: false, ...over });

// Run the round the ledger says is next, with these findings, and record it.
function run(ledger, findings = [], over = {}) {
  const next = step(ledger, over);
  expect(next.status, JSON.stringify(next)).toBe('review');
  const missing = over.missing ?? [];
  recordRound(ledger, {
    mode: next.mode, round: next.round, phase: next.phase, model: next.model,
    hash: over.hash ?? HASH, sha: 's', diffLines: over.diffLines ?? 100,
    result: { findings, seats: ['council-bug-hunter'], missing, refuted: 0, maxNits: 5 },
  });
  return next;
}
const fixAll = (ledger) => ledger.findings.filter((f) => f.status === 'open').forEach((f) => resolveFinding(ledger, f.id, 'fixed'));

describe('the loop phase', () => {
  it('starts with a full round on the loop model', () => {
    expect(step(emptyLedger())).toMatchObject({ status: 'review', mode: 'full', phase: 'loop', model: 'sonnet', round: 1 });
  });

  it('needs two clean rounds in a row before it ends', () => {
    const ledger = emptyLedger();
    run(ledger);
    expect(step(ledger)).toMatchObject({ status: 'review', phase: 'loop', model: 'sonnet' });
    run(ledger);
    expect(step(ledger)).toMatchObject({ status: 'review', phase: 'close', model: 'opus' });
  });

  it('counts a round with only nits as clean', () => {
    const ledger = emptyLedger();
    run(ledger, [finding('nit')]);
    run(ledger, [finding('nit'), finding('nit')]);
    expect(phaseState(ledger, HASH).loopDone).toBe(true);
  });

  it('is reset by a should, even after a clean round', () => {
    const ledger = emptyLedger();
    run(ledger); // clean
    run(ledger, [finding('should')]); // raises a should
    expect(step(ledger).status).toBe('answer-findings');
    fixAll(ledger);
    run(ledger); // clean again, but only one in a row
    expect(step(ledger)).toMatchObject({ status: 'review', phase: 'loop' });
    run(ledger);
    expect(step(ledger)).toMatchObject({ status: 'review', phase: 'close' });
  });

  it('is reset by a blocker, and a should that was answered as wrong still resets it', () => {
    const ledger = emptyLedger();
    run(ledger);
    run(ledger, [finding('blocker')]);
    fixAll(ledger);
    expect(cleanTail(ledger.rounds)).toBe(0);
    run(ledger, [finding('should')]);
    ledger.findings.filter((f) => f.status === 'open').forEach((f) => resolveFinding(ledger, f.id, 'wrong', 'evidence: src/x.js:1'));
    expect(step(ledger)).toMatchObject({ status: 'review', phase: 'loop' });
    expect(cleanTail(ledger.rounds)).toBe(0);
  });

  it('asks for a diff after a changed head and a full look at an unchanged one', () => {
    const ledger = emptyLedger();
    run(ledger);
    expect(step(ledger).mode).toBe('full'); // same head: an independent second look
    run(ledger);
    run(ledger, [], { hash: 'b'.repeat(64) });
    expect(step(ledger, { hash: 'b'.repeat(64) }).mode).toBe('full'); // the first round of close-out looks at everything
  });

  it('does not count an incomplete round, and reruns it on the same phase and model', () => {
    const ledger = emptyLedger();
    run(ledger);
    run(ledger, [], { missing: ['council-architect'] });
    expect(step(ledger)).toMatchObject({ status: 'review', phase: 'loop', model: 'sonnet', round: 2 });
    expect(phaseState(ledger, HASH).loop).toHaveLength(1);
  });
});

describe('close-out', () => {
  const toCloseOut = () => {
    const ledger = emptyLedger();
    run(ledger);
    run(ledger);
    return ledger;
  };

  it('runs on the close-out model and ends after two clean rounds', () => {
    const ledger = toCloseOut();
    const first = run(ledger);
    expect(first).toMatchObject({ phase: 'close', model: 'opus', mode: 'full' });
    expect(step(ledger)).toMatchObject({ status: 'review', phase: 'close' });
    run(ledger);
    expect(step(ledger).status).toBe('done');
  });

  it('puts the phase and model of each round in the ledger', () => {
    const ledger = toCloseOut();
    run(ledger);
    expect(ledger.rounds.map((r) => [r.phase, r.model])).toEqual([['loop', 'sonnet'], ['loop', 'sonnet'], ['close', 'opus']]);
  });

  it('goes back to fixing on a should, and stays on the close-out model', () => {
    const ledger = toCloseOut();
    run(ledger);
    run(ledger, [finding('should')]);
    expect(step(ledger).status).toBe('answer-findings');
    fixAll(ledger);
    expect(step(ledger, { hash: 'c'.repeat(64) })).toMatchObject({ status: 'review', phase: 'close', model: 'opus', mode: 'diff' });
    run(ledger, [], { hash: 'c'.repeat(64) });
    expect(step(ledger, { hash: 'c'.repeat(64) }).status).toBe('review'); // one clean round is not enough
    run(ledger, [], { hash: 'c'.repeat(64) });
    expect(step(ledger, { hash: 'c'.repeat(64) }).status).toBe('done');
  });

  it('needs the clean rounds to be on the current content', () => {
    const ledger = toCloseOut();
    run(ledger);
    run(ledger);
    expect(step(ledger, { hash: 'd'.repeat(64) })).toMatchObject({ status: 'review', phase: 'close', mode: 'diff' });
  });
});

describe('the verdict', () => {
  it('is refused until close-out converges, then built with the phases', () => {
    const ledger = emptyLedger();
    run(ledger);
    run(ledger);
    expect(() => buildVerdict({ ledger, tier: 1, hash: HASH })).toThrow(/Close-out has not converged/);
    run(ledger);
    expect(() => buildVerdict({ ledger, tier: 1, hash: HASH })).toThrow(/Close-out has not converged/);
    run(ledger);
    const verdict = buildVerdict({ ledger, tier: 1, hash: HASH });
    expect(verdict.rounds).toBe(4);
    expect(verdict.phases).toEqual({ loop: { rounds: 2, model: 'sonnet' }, close: { rounds: 2, model: 'opus' } });
    expect(verdict.open).toMatchObject({ blocker: 0, should: 0 });
  });

  it('is refused while a blocker or should is open', () => {
    const ledger = emptyLedger();
    run(ledger, [finding('should')]);
    expect(() => buildVerdict({ ledger, tier: 1, hash: HASH })).toThrow(/Open findings/);
  });
});

describe('the caps', () => {
  it('park a change that does not converge in the loop phase', () => {
    const small = { ...council, maxLoopRounds: 3 };
    const ledger = emptyLedger();
    for (let i = 0; i < 3; i += 1) {
      run(ledger, [finding('should')], { council: small });
      fixAll(ledger);
    }
    expect(step(ledger, { council: small })).toMatchObject({ status: 'parked', phase: 'loop' });
  });

  it('park a change that does not converge in close-out, and say it is not approval', () => {
    const small = { ...council, maxCloseRounds: 2 };
    const ledger = emptyLedger();
    run(ledger, [], { council: small });
    run(ledger, [], { council: small });
    for (let i = 0; i < 2; i += 1) {
      run(ledger, [finding('should')], { council: small });
      fixAll(ledger);
    }
    const parked = step(ledger, { council: small });
    expect(parked).toMatchObject({ status: 'parked', phase: 'close' });
    expect(parked.message).toContain("isn't approval");
  });

  it('count rounds in each phase on their own', () => {
    const small = { ...council, maxLoopRounds: 2, maxCloseRounds: 2 };
    const ledger = emptyLedger();
    run(ledger, [], { council: small });
    run(ledger, [], { council: small });
    expect(step(ledger, { council: small }).status).toBe('review'); // the loop is done, so its cap no longer applies
  });
});

describe('repeats and content', () => {
  const same = (severity) => ({ severity, class: 'null dereference', file: 'src/same.js', line: 10, claim: 'the lookup can return null', evidence: 'e', fix: 'f', preExisting: false });

  it('does not count a repeat of a finding the author already declined', () => {
    const ledger = emptyLedger();
    run(ledger, [same('should')]);
    ledger.findings.filter((f) => f.status === 'open').forEach((f) => resolveFinding(ledger, f.id, 'wrong', 'evidence: src/same.js:10'));
    run(ledger, [same('should')]); // a reviewer asking again
    run(ledger, [same('should')]);
    expect(cleanTail(ledger.rounds)).toBe(2);
    expect(step(ledger)).toMatchObject({ status: 'review', phase: 'close' });
  });

  it('counts a repeat of a finding that was fixed, shows it to the author, and waits for an answer', () => {
    const ledger = emptyLedger();
    run(ledger, [same('should')]);
    fixAll(ledger);
    run(ledger, [same('should')]);
    expect(cleanTail(ledger.rounds)).toBe(0);
    expect(ledger.findings.filter((f) => f.status === 'open')).toHaveLength(1);
    expect(step(ledger).status).toBe('answer-findings');
  });

  it('does not let a nit that was declined by default answer a later blocker at the same place', () => {
    const ledger = emptyLedger();
    run(ledger, [same('nit')]);
    run(ledger, [same('blocker')]);
    expect(cleanTail(ledger.rounds)).toBe(0);
    expect(ledger.findings.filter((f) => f.status === 'open').map((f) => f.severity)).toEqual(['blocker']);
    expect(step(ledger).status).toBe('answer-findings');
  });

  it('still treats a nit again, or a lesser finding, at an answered place as a repeat', () => {
    const ledger = emptyLedger();
    run(ledger, [same('should')]);
    ledger.findings.filter((f) => f.status === 'open').forEach((f) => resolveFinding(ledger, f.id, 'intentional', 'why'));
    run(ledger, [same('nit')]);
    expect(cleanTail(ledger.rounds)).toBe(1);
    expect(ledger.findings).toHaveLength(1);
  });

  it('needs both clean rounds on the same content', () => {
    const b = 'b'.repeat(64);
    const ledger = emptyLedger();
    run(ledger);
    run(ledger, [], { hash: b }); // clean, but the first clean round saw other content
    expect(step(ledger, { hash: b })).toMatchObject({ status: 'review', phase: 'loop', mode: 'full' });
    run(ledger, [], { hash: b });
    expect(step(ledger, { hash: b })).toMatchObject({ status: 'review', phase: 'close' });
  });

  it('holds a docs-only change to the loop cap too', () => {
    const small = { ...council, maxLoopRounds: 2 };
    const ledger = emptyLedger();
    for (let i = 0; i < 2; i += 1) {
      run(ledger, [finding('should')], { tier: 0, council: small, hash: String(i).repeat(64) });
      fixAll(ledger);
    }
    expect(step(ledger, { tier: 0, council: small, hash: '9'.repeat(64) })).toMatchObject({ status: 'parked' });
  });

  it('holds a change a finding raised to T2 to close-out, whatever tier it started at', () => {
    const ledger = emptyLedger();
    run(ledger, [], { tier: 0 });
    ledger.raise = { class: 'security', reason: 'r' };
    expect(() => buildVerdict({ ledger, tier: 0, hash: HASH })).toThrow(/Close-out has not converged/);
  });
});

describe('the rest', () => {
  it('gives a docs-only change the one round', () => {
    const ledger = emptyLedger();
    expect(step(ledger, { tier: 0 })).toMatchObject({ status: 'review', phase: 'loop', model: 'sonnet' });
    run(ledger, [], { tier: 0 });
    expect(step(ledger, { tier: 0 }).status).toBe('done');
    expect(buildVerdict({ ledger, tier: 0, hash: HASH }).rounds).toBe(1);
  });

  it('measures diff growth from the first round', () => {
    const ledger = emptyLedger();
    run(ledger, [], { diffLines: 100 });
    expect(step(ledger, { diffLines: 400 }).status).toBe('cut-first');
    expect(step(ledger, { diffLines: 130 }).status).toBe('review');
  });

  it('puts every seat and the whole verifier panel on the phase model', () => {
    const paths = ['src/a.js', 'package.json'];
    const loop = selectSeats({ tier: 2, paths, council: {}, diffLines: 50, model: 'sonnet' });
    expect(loop.seats.every((seat) => seat.model === 'sonnet')).toBe(true);
    expect(loop.panel).toEqual(['sonnet', 'sonnet', 'sonnet']);
    const close = selectSeats({ tier: 1, paths, council: {}, diffLines: 50, model: 'opus' });
    expect(close.seats.every((seat) => seat.model === 'opus')).toBe(true);
    expect(close.panel).toEqual(['opus', 'opus']);
  });

  it('treats a round recorded before phases as never clean', () => {
    const ledger = emptyLedger();
    ledger.rounds.push({ number: 1, mode: 'full', hash: HASH, complete: true, seats: [], missing: [], refuted: 0 });
    expect(step(ledger)).toMatchObject({ status: 'review', phase: 'loop', round: 2 });
  });
});
