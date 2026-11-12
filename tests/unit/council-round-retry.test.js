// Issue 231: a council seat that ends without answering is asked once more, with a budget small
// enough for any turn ceiling. Runs the real workflow script with agent() simulated: no model runs.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const SCRIPT = readFileSync('.claude/workflows/council-round.js', 'utf8').replace('export const meta', 'const meta');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const PLAN = {
  tier: 2, hash: 'h'.repeat(64), mode: 'full', phase: 'close', model: 'opus', round: 3,
  seats: [{ agent: 'council-bug-hunter', model: 'opus' }, { agent: 'council-minimalist', model: 'opus' }],
  panel: ['opus', 'opus'], head: 'b'.repeat(40), mergeBase: 'a'.repeat(40), diffLines: 2500,
  evidenceDir: 'E:/evidence', intent: 'test intent', openFindings: [], cwd: 'C:/repo',
};

/** Runs the workflow; `answer(label, prompt, call)` stands in for each subagent. */
async function runRound(answer) {
  const calls = [];
  const logs = [];
  const agent = async (prompt, opts) => {
    const call = calls.filter((c) => c.label === opts.label).length + 1;
    calls.push({ label: opts.label, prompt });
    return answer(opts.label, prompt, call);
  };
  // The runtime's parallel() turns a rejected thunk into null; here a rejection fails the test instead,
  // so the script must catch its own failures.
  const parallel = async (thunks) => Promise.all(thunks.map((t) => t()));
  const run = new AsyncFunction('agent', 'parallel', 'phase', 'log', 'args', SCRIPT);
  const result = await run(agent, parallel, () => {}, (m) => logs.push(m), PLAN);
  return { result, calls, logs };
}

const SILENT = new Error('subagent completed without calling StructuredOutput (after in-conversation nudge)');
const clean = { headVisible: true, finished: true, summary: 'nothing found', findings: [] };

describe('a council seat that ends without answering', () => {
  it('is asked once more with a small budget, and its answer counts as partial', async () => {
    const { result, calls, logs } = await runRound((label) => {
      if (label === 'bug-hunter') throw SILENT; // cut off by a lower turn ceiling, as in issue 231
      return clean;
    });
    expect(result.missing).toEqual([]);
    expect(result.seats).toEqual(['council-bug-hunter', 'council-minimalist']);
    // A 12-call look can't cover a change sized for 66: its findings count, the round is never clean.
    expect(result.partial).toEqual(['council-bug-hunter']);
    const first = calls.find((c) => c.label === 'bug-hunter');
    const retry = calls.find((c) => c.label === 'bug-hunter (retry)');
    expect(first.prompt).toContain('Turn budget: about 66 tool calls.');
    expect(retry.prompt).toContain('Turn budget: about 12 tool calls.');
    expect(calls.filter((c) => c.label === 'minimalist (retry)')).toEqual([]);
    expect(logs.some((m) => m.includes('bug-hunter ended without answering (subagent completed without calling StructuredOutput'))).toBe(true);
  });

  it('is retried when agent() returns nothing, or something that is not an answer', async () => {
    for (const nothing of [null, undefined, 'I ran out of turns.', {}]) {
      const { result, calls } = await runRound((label) => (label === 'minimalist' ? nothing : clean));
      expect(result.missing, JSON.stringify(nothing)).toEqual([]);
      expect(calls.map((c) => c.label)).toContain('minimalist (retry)');
    }
  });

  it('is retried only once: silent twice, the round does not count', async () => {
    const { result, calls, logs } = await runRound((label) => {
      if (label.startsWith('bug-hunter')) throw SILENT;
      return clean;
    });
    expect(result.missing).toEqual(['council-bug-hunter']);
    expect(calls.filter((c) => c.label.startsWith('bug-hunter')).map((c) => c.label)).toEqual(['bug-hunter', 'bug-hunter (retry)']);
    expect(logs.some((m) => m.startsWith('bug-hunter retry failed (subagent completed without calling StructuredOutput'))).toBe(true);
  });

  it('is not retried when it answered that it could not see the change', async () => {
    const { result, calls } = await runRound((label) => (label === 'bug-hunter' ? { headVisible: false, summary: '', findings: [] } : clean));
    expect(result.missing).toEqual(['council-bug-hunter']);
    expect(calls.map((c) => c.label)).not.toContain('bug-hunter (retry)');
  });
});
