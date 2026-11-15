// Issue 273: a full council round of a large diff runs each seat once per shard of at most 800 lines,
// split by file and between hunks, so every line gets a seat's full budget. Runs the real workflow
// script with agent() simulated (no model runs), and the real shard planner on a real repository.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../tools/temp-dir.mjs';
import { SHARD_CAP, diffShards, parseHunks, parseNumstatZ, planShards, shardable } from '../../.pipeline/lib/shards.mjs';

const SCRIPT = readFileSync('.claude/workflows/council-round.js', 'utf8').replace('export const meta', 'const meta');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const PLAN = {
  tier: 2, hash: 'h'.repeat(64), mode: 'full', phase: 'loop', model: 'opus', round: 1,
  seats: [{ agent: 'council-bug-hunter', model: 'opus' }, { agent: 'council-minimalist', model: 'opus' }],
  panel: ['opus', 'opus'], head: 'b'.repeat(40), mergeBase: 'a'.repeat(40), lastReviewedSha: 'c'.repeat(40),
  evidenceDir: 'E:/evidence', intent: 'test intent', openFindings: [], cwd: 'C:/repo',
};

async function runRound(plan, answer) {
  const calls = [];
  const agent = async (prompt, opts) => {
    calls.push({ label: opts.label, prompt });
    return answer(opts.label, prompt);
  };
  const parallel = async (thunks) => Promise.all(thunks.map((t) => t()));
  const run = new AsyncFunction('agent', 'parallel', 'phase', 'log', 'args', SCRIPT);
  const result = await run(agent, parallel, () => {}, () => {}, plan);
  return { result, calls };
}
const clean = { headVisible: true, finished: true, summary: 'nothing found', findings: [] };
const vote = { headVisible: true, votes: [] };

// A synthetic 3,000-line diff: 9 files of 110–320 lines, a renamed file, a binary file, and one
// file of 1,040 lines in 13 hunks of 80 that is too big for any one shard.
const SMALL = [320, 150, 280, 200, 310, 160, 240, 190, 110];
const numstat = [
  ...SMALL.map((n, i) => `${n}\t0\tsrc/f${i}.js\0`),
  '0\t0\t\0old/name.js\0new/name.js\0',
  '-\t-\tassets/icon.png\0',
  '1040\t0\tsrc/big.js\0',
].join('');
const bigHunks = Array.from({ length: 13 }, (_, i) => ({ from: 1 + i * 100, to: 80 + i * 100, lines: 80 }));

describe('the shard planner', () => {
  const files = parseNumstatZ(numstat);
  const shards = planShards(files, (f) => (f.path === 'src/big.js' ? bigHunks : []));

  it('reads numstat -z, renames and binary files included', () => {
    expect(files.reduce((s, f) => s + f.lines, 0)).toBe(3000);
    expect(files.find((f) => f.path === 'new/name.js')).toEqual({ path: 'new/name.js', old: 'old/name.js', lines: 0 });
    expect(files.find((f) => f.path === 'assets/icon.png').lines).toBe(0);
  });

  it('cuts a 3,000-line diff into shards of at most 800 lines that cover every file once', () => {
    expect(shards.length).toBeGreaterThanOrEqual(4);
    expect(shards.every((s) => s.lines <= 800)).toBe(true);
    expect(shards.reduce((s, x) => s + x.lines, 0)).toBe(3000);
    const whole = shards.flatMap((s) => s.parts).filter((p) => !p.from).map((p) => p.path);
    expect(whole.sort()).toEqual(files.filter((f) => f.path !== 'src/big.js').map((f) => f.path).sort());
  });

  it('splits a file too big for one shard between its hunks, never inside one', () => {
    const big = shards.flatMap((s) => s.parts).filter((p) => p.path === 'src/big.js');
    expect(big.length).toBe(2);
    expect(big.every((p) => p.from && p.to)).toBe(true);
    // Every hunk is in exactly one part.
    for (const h of bigHunks) expect(big.filter((p) => p.from <= h.from && h.to <= p.to).length).toBe(1);
  });

  it('keeps a tab in a file name, so no file can drop out of every shard', () => {
    expect(parseNumstatZ('3\t1\tsrc/a\tevil.js\x00900\t0\tbig.js\x00')).toEqual([
      { path: 'src/a\tevil.js', lines: 4 },
      { path: 'big.js', lines: 900 },
    ]);
  });

  it('gives a big file that is one hunk, such as a deleted file, whole and without a range', () => {
    const one = planShards([{ path: 'gone.js', lines: 900 }, { path: 'a.js', lines: 100 }], () => [{ from: 1, to: 1, lines: 900 }]);
    expect(one).toEqual([{ lines: 900, parts: [{ path: 'gone.js' }] }, { lines: 100, parts: [{ path: 'a.js' }] }]);
  });

  it('reads hunk headers as new-file ranges, removals included', () => {
    expect(parseHunks('@@ -1,3 +1,5 @@\n+a\n@@ -10 +12 @@\n@@ -20,4 +21,0 @@\n')).toEqual([
      { from: 1, to: 5, lines: 8 },
      { from: 12, to: 12, lines: 2 },
      { from: 21, to: 21, lines: 4 },
    ]);
  });
});

describe('a sharded full round', () => {
  const shards = planShards(parseNumstatZ(numstat), (f) => (f.path === 'src/big.js' ? bigHunks : []));

  it('runs each seat once per shard, with that shard in its brief and a budget for its size', async () => {
    const { result, calls } = await runRound({ ...PLAN, diffLines: 3000, shards }, (label) => (label.startsWith('verifier') ? vote : clean));
    for (const seat of ['bug-hunter', 'minimalist']) {
      const runs = calls.filter((c) => c.label.startsWith(`${seat} `));
      expect(runs.map((c) => c.label)).toEqual(shards.map((_, i) => `${seat} ${i + 1}/${shards.length}`));
      runs.forEach((c, i) => {
        expect(c.prompt).toContain(`Review part ${i + 1} of ${shards.length} of the change, about ${shards[i].lines} changed lines`);
        expect(c.prompt).toContain(`Turn budget: about ${Math.max(24, 16 + Math.ceil(shards[i].lines / 50))} tool calls.`);
      });
    }
    expect(calls.find((c) => c.label === `bug-hunter 1/${shards.length}`).prompt).toContain(`-- ':(literal)src/f0.js'`);
    expect(calls.some((c) => c.prompt.includes(`':(literal)new/name.js' ':(literal)old/name.js'`))).toBe(true);
    expect(calls.some((c) => c.prompt.includes('"src/big.js": only the hunks in new lines 1–'))).toBe(true);
    expect(result).toMatchObject({ seats: ['council-bug-hunter', 'council-minimalist'], missing: [], partial: [] });
  });

  it('merges every shard\'s findings through the verifier, deduped by place', async () => {
    const found = (file) => ({ severity: 'should', class: 'c', file, line: 3, claim: 'x', evidence: 'e', fix: 'f', preExisting: false });
    const { result, calls } = await runRound({ ...PLAN, diffLines: 3000, shards }, (label) => {
      if (label.startsWith('verifier')) return { headVisible: true, votes: [0, 1].map((key) => ({ key, verdict: 'real', reason: 'r' })) };
      // Two shard runs of one seat reporting one place still count as one seat.
      if (label === `bug-hunter 1/${shards.length}` || label === `bug-hunter 2/${shards.length}`) return { ...clean, findings: [found('src/f0.js')] };
      if (label === `bug-hunter ${shards.length}/${shards.length}` || label === `minimalist ${shards.length}/${shards.length}`) return { ...clean, findings: [found('src/big.js')] };
      return clean;
    });
    expect(calls.filter((c) => c.label.startsWith('verifier')).length).toBe(2);
    expect(result.findings.map((f) => [f.file, f.seats])).toEqual([
      ['src/f0.js', ['council-bug-hunter']],
      ['src/big.js', ['council-bug-hunter', 'council-minimalist']],
    ]);
  });

  it('counts a seat only when every shard answered, and as partial when one stopped short twice', async () => {
    const { result } = await runRound({ ...PLAN, diffLines: 3000, shards }, (label) => {
      if (label.startsWith('verifier')) return vote;
      if (label.startsWith(`bug-hunter 2/${shards.length}`)) throw new Error('subagent completed without calling StructuredOutput');
      if (label.startsWith(`minimalist 3/${shards.length}`)) return { ...clean, finished: false };
      return clean;
    });
    expect(result.missing).toEqual(['council-bug-hunter']);
    expect(result.partial).toEqual(['council-minimalist']);
  });

  it('runs a shard that went silent or stopped short once more at its full budget, so one slip does not spoil the round', async () => {
    const found = { severity: 'should', class: 'c', file: 'src/f0.js', line: 9, claim: 'x', evidence: 'e', fix: 'f', preExisting: false };
    const { result, calls } = await runRound({ ...PLAN, diffLines: 3000, shards }, (label) => {
      if (label.startsWith('verifier')) return { headVisible: true, votes: [{ key: 0, verdict: 'real', reason: 'r' }] };
      if (label === `bug-hunter 2/${shards.length}`) throw new Error('subagent completed without calling StructuredOutput');
      // Stopped short, with a finding: it is kept, and the second run covers the part.
      if (label === `minimalist 3/${shards.length}`) return { ...clean, finished: false, findings: [found] };
      return clean;
    });
    expect(result).toMatchObject({ missing: [], partial: [] });
    expect(result.findings.map((f) => f.file)).toEqual(['src/f0.js']);
    const budget = `Turn budget: about ${Math.max(24, 16 + Math.ceil(shards[1].lines / 50))} tool calls.`;
    expect(calls.find((c) => c.label === `bug-hunter 2/${shards.length} (again)`).prompt).toContain(budget);
    expect(calls.map((c) => c.label)).toContain(`minimalist 3/${shards.length} (again)`);
    // Only the failed parts ran again, and no 12-call retry was needed.
    expect(calls.filter((c) => c.label.endsWith('(again)')).length).toBe(2);
    expect(calls.filter((c) => c.label.endsWith('(retry)'))).toEqual([]);
  });

  it('verifies only blockers and shoulds, in lists of at most 20 per verifier call; nits pass unverified', async () => {
    const at = (severity, line) => ({ severity, class: 'c', file: `src/f${line % 9}.js`, line, claim: 'x', evidence: 'e', fix: 'f', preExisting: false });
    const lists = [];
    const { result } = await runRound({ ...PLAN, diffLines: 3000, shards }, (label, prompt) => {
      if (label.startsWith('verifier')) {
        const keys = JSON.parse(prompt.slice(prompt.indexOf('['))).map((f) => f.key);
        lists.push({ label, keys });
        return { headVisible: true, votes: keys.map((key) => ({ key, verdict: 'real', reason: 'r' })) };
      }
      // 45 shoulds and 30 nits, each at its own place, spread over one seat's shards.
      const m = /^bug-hunter (\d+)\//.exec(label);
      if (!m) return clean;
      const n = Number(m[1]);
      return { ...clean, findings: Array.from({ length: 75 }, (_, i) => i).filter((i) => i % shards.length === n - 1).map((i) => at(i < 45 ? 'should' : 'nit', 100 + i)) };
    });
    expect(lists.every((l) => l.keys.length <= 20)).toBe(true);
    // Each of the 2 verifiers saw every should once, in 3 lists, and no nit.
    expect(lists.length).toBe(6);
    const seen = lists.filter((l) => l.label.startsWith('verifier-1')).flatMap((l) => l.keys);
    expect(seen.length).toBe(45);
    expect(result.findings.filter((f) => f.severity === 'should').length).toBe(45);
    expect(result.findings.filter((f) => f.severity === 'nit').length).toBe(30);
    expect(result.missing).toEqual([]);
  });

  it('runs in waves of one run per seat when each run gets its own worktree', async () => {
    let live = 0;
    let most = 0;
    const plan = { ...PLAN, cwd: undefined, diffLines: 3000, shards };
    const calls = [];
    const agent = async (prompt, opts) => {
      calls.push(opts);
      live += 1;
      most = Math.max(most, live);
      await new Promise((r) => setTimeout(r, 1));
      live -= 1;
      return opts.label.startsWith('verifier') ? vote : clean;
    };
    const parallel = async (thunks) => Promise.all(thunks.map((t) => t()));
    const run = new AsyncFunction('agent', 'parallel', 'phase', 'log', 'args', SCRIPT);
    const result = await run(agent, parallel, () => {}, () => {}, plan);
    expect(most).toBe(plan.seats.length);
    expect(calls.filter((c) => !c.label.startsWith('verifier')).every((c) => c.isolation === 'worktree')).toBe(true);
    expect(calls.length).toBe(plan.seats.length * shards.length);
    expect(result.missing).toEqual([]);
  });

  it('puts one run of each seat in every wave', async () => {
    const waves = [];
    let current = null;
    const plan = { ...PLAN, cwd: undefined, diffLines: 3000, shards };
    const agent = async (prompt, opts) => {
      if (!current) {
        current = [];
        waves.push(current);
        setTimeout(() => (current = null), 0);
      }
      current.push(opts.label);
      await new Promise((r) => setTimeout(r, 2));
      return opts.label.startsWith('verifier') ? vote : clean;
    };
    const parallel = async (thunks) => Promise.all(thunks.map((t) => t()));
    const run = new AsyncFunction('agent', 'parallel', 'phase', 'log', 'args', SCRIPT);
    await run(agent, parallel, () => {}, () => {}, plan);
    expect(waves.length).toBe(shards.length);
    waves.forEach((w, i) => expect(w.sort()).toEqual([`bug-hunter ${i + 1}/${shards.length}`, `minimalist ${i + 1}/${shards.length}`]));
  });

  it('asks a shard run to cover its part, and an unsharded run the whole change', async () => {
    const sharded = await runRound({ ...PLAN, diffLines: 3000, shards }, () => clean);
    expect(sharded.calls[0].prompt).toContain("If you can't cover your part, set finished to false");
    expect(sharded.calls[0].prompt).not.toContain('cover the whole change');
    const whole = await runRound({ ...PLAN, diffLines: 600 }, () => clean);
    expect(whole.calls[0].prompt).toContain("If you can't cover the whole change, set finished to false");
  });

  it('sends verifier lists in waves of one call per verifier, and a list that came back unread once more', async () => {
    const at = (line) => ({ severity: 'should', class: 'c', file: 'src/f1.js', line, claim: 'x', evidence: 'e', fix: 'f', preExisting: false });
    const waves = [];
    let current = null;
    const plan = { ...PLAN, cwd: undefined, diffLines: 3000, shards };
    const agent = async (prompt, opts) => {
      if (opts.label.startsWith('verifier')) {
        if (!current) {
          current = [];
          waves.push(current);
          setTimeout(() => (current = null), 0);
        }
        current.push(opts.label);
        await new Promise((r) => setTimeout(r, 2));
        if (opts.label === 'verifier-2 2/2') throw new Error('subagent completed without calling StructuredOutput');
        const keys = JSON.parse(prompt.slice(prompt.indexOf('['))).map((f) => f.key);
        return { headVisible: true, votes: keys.map((key) => ({ key, verdict: 'real', reason: 'r' })) };
      }
      return opts.label === `bug-hunter 1/${shards.length}` ? { ...clean, findings: Array.from({ length: 25 }, (_, i) => at(i + 1)) } : clean;
    };
    const parallel = async (thunks) => Promise.all(thunks.map((t) => t()));
    const run = new AsyncFunction('agent', 'parallel', 'phase', 'log', 'args', SCRIPT);
    const result = await run(agent, parallel, () => {}, () => {}, plan);
    expect(waves.map((w) => w.sort())).toEqual([
      ['verifier-1 1/2', 'verifier-2 1/2'],
      ['verifier-1 2/2', 'verifier-2 2/2'],
      ['verifier-2 2/2 (again)'],
    ]);
    expect(result.missing).toEqual([]);
    expect(result.findings.length).toBe(25);
  });

  it('counts a verifier\'s vote only for a key in the list it was given', async () => {
    const at = (line) => ({ severity: 'should', class: 'c', file: 'src/f1.js', line, claim: 'x', evidence: 'e', fix: 'f', preExisting: false });
    const { result } = await runRound({ ...PLAN, diffLines: 3000, shards }, (label, prompt) => {
      if (label.startsWith('verifier')) {
        const keys = JSON.parse(prompt.slice(prompt.indexOf('['))).map((f) => f.key);
        const votes = keys.map((key) => ({ key, verdict: 'real', reason: 'r' }));
        // The first list also "refutes" every key of the second: those votes must not count.
        if (keys.includes(0)) for (let k = 20; k < 25; k++) votes.unshift({ key: k, verdict: 'refuted', reason: 'stray' });
        return { headVisible: true, votes };
      }
      return label === `bug-hunter 1/${shards.length}` ? { ...clean, findings: Array.from({ length: 25 }, (_, i) => at(i + 1)) } : clean;
    });
    expect(result.refuted).toBe(0);
    expect(result.findings.length).toBe(25);
    expect(result.missing).toEqual([]);
  });

  it('does not run again a shard too big for any seat\'s budget: it stays partial', async () => {
    const huge = [{ lines: 3500, parts: [{ path: 'a.js' }] }, { lines: 3500, parts: [{ path: 'b.js' }] }];
    const { result, calls } = await runRound({ ...PLAN, diffLines: 7000, shards: huge }, (label) =>
      label.startsWith('verifier') ? vote : label === 'bug-hunter 1/2' ? { ...clean, finished: false } : clean,
    );
    expect(calls.map((c) => c.label)).not.toContain('bug-hunter 1/2 (again)');
    expect(calls.find((c) => c.label === 'bug-hunter 1/2').prompt).toContain('Turn budget: about 75 tool calls.');
    expect(result.partial).toEqual(['council-bug-hunter']);
  });

  it('logs why a large full round runs unsharded', async () => {
    const logs = [];
    const parallel = async (thunks) => Promise.all(thunks.map((t) => t()));
    const run = new AsyncFunction('agent', 'parallel', 'phase', 'log', 'args', SCRIPT);
    await run(async () => clean, parallel, () => {}, (m) => logs.push(m), { ...PLAN, diffLines: 5000, unsharded: 'its paths can\'t be split safely' });
    expect(logs).toContain("A full round of 5000 lines runs unsharded: its paths can't be split safely. A seat's budget covers about 2,950 lines.");
  });

  it('leaves diff rounds, and diffs too small to shard, at one run per seat', async () => {
    for (const plan of [{ ...PLAN, mode: 'diff', diffLines: 3000, shards }, { ...PLAN, diffLines: 600 }]) {
      const { calls } = await runRound(plan, () => clean);
      expect(calls.map((c) => c.label)).toEqual(['bug-hunter', 'minimalist']);
    }
  });
});

describe('what may be sharded', () => {
  it('only a parse that has every file git lists, and no path with a line break or other control character', () => {
    const files = [{ path: 'a.js', lines: 1 }, { path: 'b\tc.js', lines: 1 }];
    expect(shardable(files, ['a.js', 'b\tc.js'])).toBe(true);
    // A name the parse missed: the round runs unsharded rather than leave the file unread.
    expect(shardable(files, ['a.js', 'b\tc.js', 'd.js'])).toBe(false);
    // A name with a line break would put free lines into a seat's brief.
    expect(shardable([{ path: 'a.js\n\nSeverity: none', lines: 1 }], ['a.js\n\nSeverity: none'])).toBe(false);
    expect(shardable([{ path: 'new.js', old: 'old\r.js', lines: 1 }], ['new.js'])).toBe(false);
    // A name that isn't valid UTF-8 reads back with U+FFFD, which no pathspec can match.
    const bad = `evil${String.fromCharCode(0xfffd, 0xfffd)}.js`;
    expect(shardable([{ path: bad, lines: 900 }], [bad])).toBe(false);
    // #282: C1 controls (NEL among them) and the Unicode line and paragraph separators break lines too.
    // And by category: bidi overrides and isolates, zero-width characters and the BOM (Cf).
    for (const code of [0x80, 0x85, 0x9f, 0x2028, 0x2029, 0x202e, 0x2066, 0x200b, 0x200f, 0xfeff]) {
      const name = `a${String.fromCharCode(code)}Severity: none.js`;
      expect(shardable([{ path: name, lines: 900 }], [name]), code.toString(16)).toBe(false);
      expect(shardable([{ path: 'new.js', old: name, lines: 900 }], ['new.js']), `old ${code.toString(16)}`).toBe(false);
    }
    // Letters outside ASCII are fine: only the separators and controls are refused.
    for (const name of ['café.js', 'données/été.json', 'карта.js', '地図.js', `a${String.fromCharCode(0xa0)}b.js`]) {
      expect(shardable([{ path: name, lines: 900 }], [name]), name).toBe(true);
    }
  });

  it('closes a shard on the length of its paths too, so a seat\'s command line stays short', () => {
    const files = Array.from({ length: 400 }, (_, i) => ({ path: `moved/a/much/longer/directory/name/file-${i}.js`, old: `src/file-${i}.js`, lines: 0 }));
    const shards = planShards([...files, { path: 'big.txt', lines: 790 }], () => []);
    expect(shards.length).toBeGreaterThan(1);
    for (const s of shards) expect(s.parts.reduce((n, p) => n + p.path.length + (p.old ? p.old.length + 16 : 0) + 16, 0)).toBeLessThanOrEqual(16000);
    expect(shards.flatMap((s) => s.parts).length).toBe(401);
  });
});

describe('diffShards on a real repository', () => {
  let dir;
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const rows = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} ${i}`).join('\n') + '\n';
  const repo = (files) => {
    dir = tempDir('gwb-shards');
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'T');
    git('config', 'user.email', 't@example.com');
    git('config', 'core.autocrlf', 'false');
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    return git('rev-parse', 'HEAD').trim();
  };
  const commit = () => {
    git('add', '-A');
    git('commit', '-q', '-m', 'change');
  };
  const numstatLines = (base, globs = []) =>
    git('diff', '-M', '--numstat', base, 'HEAD', ...(globs.length ? ['--', '.', ...globs.map((g) => `:(exclude,glob)${g}`)] : []))
      .split('\n').filter(Boolean).reduce((n, l) => n + Number(l.split('\t')[0]) + Number(l.split('\t')[1]), 0);

  it('shards a 3,000-line change, splitting the big file between hunks, with a rename and a generated file', () => {
    const base = repo({ 'big.js': rows(2000, 'keep'), 'old.js': rows(200, 'r') });
    // big.js: 1,200 changed lines in 12 hunks of 100 (50 removed, 50 added), with untouched lines between.
    const big = rows(2000, 'keep').split('\n');
    for (let h = 0; h < 12; h++) for (let i = 0; i < 50; i++) big[h * 160 + i] = `edit ${h} ${i}`;
    writeFileSync(join(dir, 'big.js'), big.join('\n'));
    for (let f = 0; f < 6; f++) writeFileSync(join(dir, `f ${f}.js`), rows(300, `f${f}`));
    // A rename with edits: read as a rename, with both paths.
    mkdirSync(join(dir, 'moved'));
    git('mv', 'old.js', 'moved/new.js');
    writeFileSync(join(dir, 'moved', 'new.js'), rows(200, 'r').replace('r 5\n', 'r five\n'));
    // A generated file is left out, as the seats' diff leaves it out.
    mkdirSync(join(dir, 'gen'));
    writeFileSync(join(dir, 'gen', 'out.json'), rows(500, 'gen'));
    commit();
    const total = numstatLines(base, ['gen/**']);
    const shards = diffShards(base, 'HEAD', ['gen/**'], { diffLines: total, cwd: dir });
    const parts = shards.flatMap((s) => s.parts);
    expect(parts.some((p) => p.path.startsWith('gen/'))).toBe(false);
    expect(parts.find((p) => p.path === 'moved/new.js')).toEqual({ path: 'moved/new.js', old: 'old.js' });
    expect(shards.reduce((s, x) => s + x.lines, 0)).toBe(total);
    expect(shards.every((s) => s.lines <= 800)).toBe(true);
    const bigParts = parts.filter((p) => p.path === 'big.js');
    expect(bigParts.length).toBe(2);
    expect(bigParts[0]).toMatchObject({ from: 1 });
    expect(parts.filter((p) => p.path.startsWith('f ')).length).toBe(6);
    expect(diffShards(base, 'HEAD', [], { diffLines: 800, cwd: dir })).toBeNull();
  });

  it(`plans at most ${SHARD_CAP} shards, with bigger ones, for a diff that would need more`, () => {
    const base = repo({ 'keep.txt': 'x\n' });
    for (let f = 0; f < 12; f++) writeFileSync(join(dir, `f${f}.js`), rows(700, `f${f}`));
    commit();
    const shards = diffShards(base, 'HEAD', [], { diffLines: 8400, cwd: dir });
    expect(shards.length).toBeLessThanOrEqual(SHARD_CAP);
    expect(shards.length).toBeGreaterThan(1);
    expect(shards.reduce((s, x) => s + x.lines, 0)).toBe(8400);
    expect(shards.flatMap((s) => s.parts).length).toBe(12);
  });
});
