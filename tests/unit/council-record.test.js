// Issue 210: only a council round's own result is recorded. The Workflow tool's wrapper around it,
// or anything else with no findings or seats, is refused rather than read as a clean round.
import { describe, expect, it } from 'vitest';
import { emptyLedger, nextStep, recordRound } from '../../.pipeline/lib/ledger.mjs';

const council = { loopModel: 'sonnet', closeModel: 'opus', maxLoopRounds: 16, maxCloseRounds: 8 };
const HASH = 'a'.repeat(64);

function record(ledger, result) {
  const next = nextStep({ ledger, tier: 1, hash: HASH, council, cleanTree: true, evidenceOk: true, diffLines: 100 });
  return recordRound(ledger, { mode: next.mode, round: next.round, phase: next.phase, model: next.model, hash: HASH, sha: 's', diffLines: 100, result });
}

describe('recording a round', () => {
  const real = { findings: [], seats: ['council-bug-hunter'], missing: [], partial: [], refuted: 0 };

  it('refuses what is not a round result, and leaves the ledger as it was', () => {
    const wrapped = { summary: 'One council review round', agentCount: 9, logs: [], result: real };
    for (const bad of [wrapped, { ...wrapped, result: JSON.stringify(real) }, {}, null, { findings: [] }, { seats: ['council-bug-hunter'] }, { findings: [], seats: [], missing: [] }, { findings: 'none', seats: ['council-bug-hunter'] }]) {
      const ledger = emptyLedger();
      expect(() => record(ledger, bad), JSON.stringify(bad)).toThrow(/not a council round's result/);
      expect(ledger).toEqual(emptyLedger());
    }
  });

  it('refuses a finding whose severity the ledger does not know, which would count as neither blocking nor raised (issue 258)', () => {
    const finding = { file: 'a.js', line: 1, class: 'c', claim: 'x', preExisting: false };
    for (const severity of ['high', 'Should', undefined]) {
      const ledger = emptyLedger();
      expect(() => record(ledger, { ...real, findings: [{ ...finding, severity }] }), String(severity)).toThrow(/severity/);
      expect(ledger).toEqual(emptyLedger());
    }
    expect(record(emptyLedger(), { ...real, findings: [{ ...finding, severity: 'should' }] }).added).toHaveLength(1);
  });

  it('counts a planned seat the result leaves out as missing, so the round is rerun (issue 256)', () => {
    const next = (ledger) => nextStep({ ledger, tier: 1, hash: HASH, council, cleanTree: true, evidenceOk: true, diffLines: 100 });
    const recordPlanned = (ledger, result, planned) => {
      const n = next(ledger);
      return recordRound(ledger, { mode: n.mode, round: n.round, phase: n.phase, model: n.model, hash: HASH, sha: 's', diffLines: 100, result, planned });
    };
    const planned = ['council-bug-hunter', 'council-architect'];
    const ledger = emptyLedger();
    const out = recordPlanned(ledger, real, planned);
    expect(out).toMatchObject({ complete: false, missing: ['council-architect'] });
    expect(ledger.rounds.at(-1)).toMatchObject({ complete: false, raised: null, missing: ['council-architect'] });
    expect(recordPlanned(ledger, { ...real, seats: planned }, planned).complete).toBe(true);
  });

  it('records a clean round, and a round whose every seat was missing as incomplete', () => {
    const ledger = emptyLedger();
    expect(record(ledger, real).complete).toBe(true);
    expect(record(ledger, { findings: [], seats: [], missing: ['council-bug-hunter'] }).complete).toBe(false);
  });
});
