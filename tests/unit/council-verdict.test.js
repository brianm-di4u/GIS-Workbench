// Decision 0021 (#255, #79): the verdict carries its round log, and the gate rebuilds the ledger from
// it and applies the council's own rules. A verdict whose numbers were edited, whose rounds named no
// seats, or that never converged on this content doesn't stand.
import { describe, expect, it } from 'vitest';
import { buildVerdict, emptyLedger, nextStep, recordRound, resolveFinding, verdictProblems } from '../../.pipeline/lib/ledger.mjs';
import { evaluateGate } from '../../.pipeline/lib/gate-core.mjs';
import { parseVerdict, renderVerdict } from '../../.pipeline/lib/contract.mjs';

const council = { loopModel: 'sonnet', closeModel: 'opus', maxLoopRounds: 16, maxCloseRounds: 8 };
const HASH = 'a'.repeat(64);
const SEATS = ['council-bug-hunter', 'council-architect'];

let n = 0;
const should = () => ({ severity: 'should', class: `class ${n}`, file: `src/f${n}.js`, line: 10, claim: `claim ${n++}`, preExisting: false });

function round(ledger, findings = [], hash = HASH) {
  const next = nextStep({ ledger, tier: 1, hash, council, cleanTree: true, evidenceOk: true, diffLines: 50 });
  expect(next.status, JSON.stringify(next)).toBe('review');
  return recordRound(ledger, { mode: next.mode, round: next.round, phase: next.phase, model: next.model, hash, sha: 's', diffLines: 50, result: { findings, seats: SEATS, missing: [], partial: [], refuted: 0 }, planned: SEATS });
}

// A should found and fixed on an earlier hash, then two clean loop rounds and two clean close rounds.
function converged() {
  const ledger = emptyLedger();
  round(ledger, [should()], 'b'.repeat(64));
  resolveFinding(ledger, ledger.findings[0].id, 'fixed');
  for (let i = 0; i < 4; i += 1) round(ledger);
  return ledger;
}

const copy = (v) => JSON.parse(JSON.stringify(v));

describe('a verdict and its round log', () => {
  it('carries a log that the gate reads back to the same verdict', () => {
    const verdict = buildVerdict({ ledger: converged(), tier: 1, hash: HASH });
    expect(verdict.schema).toBe(2);
    expect(verdict.log).toHaveLength(5);
    expect(verdict.log[0]).toMatchObject({ phase: 'loop', hash: 'b'.repeat(64), complete: true, seats: SEATS, missing: [], raised: { should: 1 } });
    expect(verdictProblems(verdict, HASH)).toEqual([]);
    // Through the PR body, as the gate reads it.
    expect(verdictProblems(parseVerdict(`x\n${renderVerdict(verdict)}\n`).verdict, HASH)).toEqual([]);
  });

  it('refuses edited numbers, rounds with no reviewers, and a verdict that never converged here', () => {
    const good = buildVerdict({ ledger: converged(), tier: 1, hash: HASH });
    const cases = {
      'no log': (v) => { delete v.log; v.schema = 1; },
      'round count': (v) => { v.rounds += 1; },
      'open should hidden': (v) => { v.findings[0].status = 'open'; },
      'a round with no seats': (v) => { v.log[2].seats = []; },
      'complete with seats missing': (v) => { v.log[2].missing = ['council-architect']; },
      'a should hidden from its round': (v) => { v.log[0].raised.should = 0; },
      'a should deleted from the findings': (v) => { v.findings.splice(0, 1); },
      'a should moved to another round': (v) => { v.findings[0].round = 2; },
      'last round on other content': (v) => { v.log.at(-1).hash = 'c'.repeat(64); },
      'not converged': (v) => { v.log = v.log.slice(0, 3); v.rounds = 3; },
      'a dirty close round called clean': (v) => { v.log.at(-1).raised.should = 1; },
    };
    for (const [name, edit] of Object.entries(cases)) {
      const v = copy(good);
      edit(v);
      expect(verdictProblems(v, HASH), name).not.toEqual([]);
    }
    expect(verdictProblems(good, 'd'.repeat(64))).not.toEqual([]);
  });

  it('counts what a round recorded when two of its findings merged, so the gate accepts it', () => {
    const ledger = emptyLedger();
    const near = { severity: 'should', class: 'merged class', file: 'src/m.js', preExisting: false };
    round(ledger, [{ ...near, line: 10, claim: 'first' }, { ...near, line: 12, claim: 'second' }], 'b'.repeat(64));
    expect(ledger.findings).toHaveLength(1);
    expect(ledger.rounds[0].raised.should).toBe(2);
    resolveFinding(ledger, ledger.findings[0].id, 'fixed');
    for (let i = 0; i < 4; i += 1) round(ledger);
    const verdict = buildVerdict({ ledger, tier: 1, hash: HASH });
    expect(verdict.log[0].raised.should).toBe(1);
    expect(verdictProblems(verdict, HASH)).toEqual([]);
  });

  it("takes a small T1 change's close-out alone only when the gate counts it small (decision 0024)", () => {
    const ledger = emptyLedger();
    for (let i = 0; i < 2; i += 1) {
      const next = nextStep({ ledger, tier: 1, hash: HASH, council, cleanTree: true, evidenceOk: true, diffLines: 30, skipLines: 30 });
      expect(next.phase).toBe('close');
      recordRound(ledger, { mode: next.mode, round: next.round, phase: next.phase, model: next.model, hash: HASH, sha: 's', diffLines: 30, result: { findings: [], seats: SEATS, missing: [], partial: [], refuted: 0 }, planned: SEATS });
    }
    const verdict = buildVerdict({ ledger, tier: 1, hash: HASH, skipLines: 30, council });
    expect(verdictProblems(verdict, HASH, { skipLoop: true })).toEqual([]);
    expect(verdictProblems(verdict, HASH)).toEqual([expect.stringMatching(/never converged/)]);
    const config = { admins: ['admin'], merge: { t0: 'auto', t1: 'auto', t2: 'human' }, tiers: { t2Paths: [], t1Paths: ['**'] }, council: { maxMechanicalLines: 40 } };
    const body = `## Testing\nran it\n\n## Risk\nnone\n\n## How to revert\nrevert\n\n${renderVerdict(verdict)}\n`;
    const gate = (skipLines) => evaluateGate({ pr: { body, draft: false, base: 'main', author: 'admin' }, changes: [{ path: 'app/src/a.js', status: 'modified' }], hash: HASH, config, verify: 'success', skipLines }).blockers.join('\n');
    expect(gate(30)).not.toMatch(/stand up/);
    expect(gate(41)).toMatch(/never converged/);
    expect(gate(undefined)).toMatch(/never converged/);
  });

  it('blocks the gate on a verdict that does not stand', () => {
    const config = JSON.parse(JSON.stringify({ admins: ['admin'], merge: { t0: 'auto', t1: 'auto', t2: 'human' }, tiers: { t2Paths: [], t1Paths: ['**'] } }));
    const body = (verdict) => `## Testing\nran it\n\n## Risk\nnone\n\n## How to revert\nrevert\n\n${renderVerdict(verdict)}\n`;
    const gate = (verdict) => evaluateGate({ pr: { body: body(verdict), draft: false, base: 'main', author: 'admin' }, changes: [{ path: 'app/src/a.js', status: 'modified' }], hash: HASH, config, verify: 'success' });
    const good = buildVerdict({ ledger: converged(), tier: 1, hash: HASH });
    expect(gate(good).blockers.join('\n')).not.toMatch(/stand up/);
    const forged = copy(good);
    forged.log[3].seats = [];
    expect(gate(forged).blockers.join('\n')).toMatch(/doesn't stand up against its own rounds: a round names no seats/);
  });
});
