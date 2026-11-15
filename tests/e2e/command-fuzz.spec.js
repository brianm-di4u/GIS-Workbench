// Command fuzz (nightly only): seeded random sequences of command ids from the catalogue, run
// against the built app through window.gisworkbench. The GUI sweeps (gui-sweep, gui-modern)
// actuate every control once, in a fixed order; this finds what only a particular order of
// commands shows. After every sequence:
//   - no page error and no console error;
//   - no CSP violation;
//   - no network request (the app promises to work offline: openApp records every request that
//     is not file, data, blob or loopback);
//   - the app still answers (a trivial query returns, the main thread is not stuck);
//   - undoing the whole sequence puts the project's records back as they were, unless a command
//     in it is on NOT_UNDOABLE. This covers store records only (graphics, layers' records, window
//     layout records); a command that changes only the view, a preference or other UI state passes
//     it without being tested, and a command the API refuses as not available now (E_STEP_FIRST)
//     counts as run.
//
// Reproducing: the seed is fixed by default so a nightly run is the same run every night. A
// failure prints the seed and the shrunk sequence. Replay with
//   GW_FUZZ_SEED=<seed> npx playwright test --project=nightly tests/e2e/command-fuzz.spec.js
// or run one sequence by itself with
//   GW_FUZZ_SEQ='["qat.undo","ws.mapview"]' npx playwright test --project=nightly tests/e2e/command-fuzz.spec.js
// Size: GW_FUZZ_RUNS (default 40 sequences) and GW_FUZZ_LEN (default 8 commands each).

import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { enterState, settle, FX } from './gui-lib.js';

const SEED = Number(process.env.GW_FUZZ_SEED ?? 20261115);
const RUNS = Number(process.env.GW_FUZZ_RUNS ?? 40);
const LEN = Number(process.env.GW_FUZZ_LEN ?? 8);
/**
 * The project every sequence starts from: an image and a vector layer. In an empty project only
 * 179 of the 612 implemented commands are enabled, and the rest would do nothing.
 */
const START = { id: 'fuzz-start', files: [FX('fx01', 'fx01.ntf'), FX('fx12', 'fx12.geojson')] };
const OPTS = { prefs: { network: 'offline' } };
/** One sequence, from the environment: the way to replay a single shrunk counterexample. */
const ONE = process.env.GW_FUZZ_SEQ ? JSON.parse(process.env.GW_FUZZ_SEQ) : null;

/**
 * Commands the generator never picks. Each entry is [id or pattern, reason]. A command is here
 * because running it in a headless sequence is not possible or not meaningful, not because it is
 * broken. A command that fails the fuzz for real goes here too, with the issue that tracks it
 * as its reason, and comes off when the issue is fixed.
 *
 * Not excluded on purpose: commands that open a native file picker or start a download or print
 * (boot() answers every file chooser with no file, cancels downloads and dismisses browser
 * dialogs), and commands that open a dialog (settle() closes it). The survey that chose this list
 * ran all 612 implemented commands once; none threw, made a request or hung, so none needed
 * excluding for failing.
 */
const EXCLUDED = [
  [/^sidecar\./, 'needs the optional native sidecar, which the nightly project does not start (PT-13); with none running each command only reports that, and the sidecar has its own suites'],
  ['display.fullscreen', 'asks the browser for fullscreen, which resizes the viewport for the rest of the sequence'],
  ['file.print', 'opens the browser print dialog, which headless Chrome cannot show'],
  ['stereo.xr', 'starts a WebXR session, which needs a headset'],
  ['cmp.record', 'starts screen recording, which needs a capture permission prompt a test cannot answer'],
  ['3d.record', 'starts screen recording, which needs a capture permission prompt a test cannot answer'],
  ['stereo.mode.dual', 'opens a second browser window for the right eye (window.open), which a test run must not do (docs/POLICY.md)'],
  ['net.toggle', 'switches the app online, after which a request is the intended behaviour and the no-request check would fail for the wrong reason'],
];

/**
 * Commands that change the project in a way undo does not reverse (they replace it, or change
 * what is not a store record). A sequence with one still runs; only the undo check is skipped.
 */
const NOT_UNDOABLE = [
  ['file.newproject', 'replaces the project and clears the history, so there is nothing to undo back to'],
  ['file.openproject', 'replaces the project and clears the history, so there is nothing to undo back to'],
];

const matches = (m, id) => (m instanceof RegExp ? m.test(id) : m === id);
const isExcluded = (id) => EXCLUDED.some(([m]) => matches(m, id));
const isNotUndoable = (id) => NOT_UNDOABLE.some(([m]) => matches(m, id));

/**
 * Runs in the page. Undoes every step when `undoAll`, then returns the project's records
 * by id with keys sorted (key order is not part of the state, as in tests/unit/store.test.js).
 */
function recordsAfterUndoTo(undoAll) {
  const gw = window.gisworkbench;
  if (undoAll) for (let i = 0; i < 1000 && gw.undo.canUndo; i++) gw.undo.undo(); // 500 steps is the most the history keeps
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  return JSON.stringify(canon(gw.store.snapshot().sort((a, b) => (a.id < b.id ? -1 : 1))));
}

/** `promise`, or an error saying `what` if it takes longer than `ms` (the timer is cleared either way). */
async function within(ms, promise, what) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(what)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** Run one sequence in a fresh browser context; returns the problems found (empty: the sequence is clean). */
async function runSequence(browser, seq) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const problems = [];
  try {
    const app = await enterState(page, 'full', START, OPTS);
    // Loading the files is the baseline, not part of the sequence: a qat.undo must not reach below it.
    await page.evaluate(() => window.gisworkbench.undo.clear());
    const start = await page.evaluate(recordsAfterUndoTo, false);
    for (const id of seq) {
      // Fire, do not await: a command that opens a dialog resolves only when the dialog closes.
      // Each command has its own result slot, so a late finish of an earlier one cannot be read as this one's.
      const n = await within(
        30_000,
        page.evaluate((id) => {
          const n = (window.__fuzzN = (window.__fuzzN ?? 0) + 1);
          window.__fuzz ??= {};
          window.__fuzz[n] = 'pending';
          // A command that is not available now (E_STEP_FIRST) is the API saying "do this first": not a failure.
          window.gisworkbench.api.v2.commands.run({ id }).then(() => (window.__fuzz[n] = 'ok'), (e) => (window.__fuzz[n] = e?.code === 'E_STEP_FIRST' ? 'ok' : `threw: ${e?.code ?? ''} ${e?.message}`));
          return n;
        }, id),
        `${id}: the page did not take the command within 30 s (main thread blocked)`,
      );
      await settle(page, { layout: 'modern' });
      const st = await page.waitForFunction((n) => window.__fuzz[n] !== 'pending', n, { timeout: 5_000 }).then(() => page.evaluate((n) => window.__fuzz[n], n), () => 'pending');
      if (st !== 'ok') problems.push(`${id}: ${st === 'pending' ? 'did not finish within 5 s of its dialog closing' : st}`);
    }
    // Still answering: the page's main thread runs a query and the command table lists.
    const alive = await within(10_000, page.evaluate(() => window.gisworkbench.api.v2.commands.list({ filter: 'qat.undo' }).then((l) => l.length)), 'no answer within 10 s').catch((e) => `no answer: ${e.message}`);
    if (!(alive >= 1)) problems.push(`the app does not answer a trivial command: ${alive}`);
    else if (!seq.some(isNotUndoable)) {
      const back = await within(30_000, page.evaluate(recordsAfterUndoTo, true), 'undoing the sequence did not finish within 30 s (main thread blocked)');
      if (back !== start) problems.push('undoing the whole sequence did not restore the starting records');
    }
    // Read the page's errors, CSP violations and requests last, so whatever undoing the sequence
    // logged or requested is counted too.
    await page.waitForTimeout(300);
    for (const l of app.logs) problems.push(`console: ${l.slice(0, 300)}`);
    for (const c of await app.csp()) problems.push(`csp: ${c}`);
    for (const u of app.requests) problems.push(`network request: ${u}`);
  } catch (e) {
    problems.push(`harness: ${e.message.split('\n')[0]}`);
  } finally {
    await context.close().catch(() => {});
  }
  return problems;
}

test.describe.configure({ timeout: 900_000 });

test('REQ-ARC-13 command fuzz: every excluded command is in the catalogue and has a reason', async ({ page }) => {
  const app = await enterState(page, 'full', { id: 'none', files: [] }, OPTS);
  const ids = new Set(await app.frame.evaluate(async () => (await window.gisworkbench.api.v2.commands.list()).map((c) => c.id)));
  for (const [m, why] of [...EXCLUDED, ...NOT_UNDOABLE]) {
    expect([...ids].some((id) => matches(m, id)), `${m} is on a fuzz list but matches no command`).toBe(true);
    expect(why.length, `${m} needs a reason`).toBeGreaterThan(10);
  }
});

test(`REQ-NET-02 REQ-ARC-13 command fuzz: random command sequences leave the app clean (seed ${SEED}, ${RUNS} × ${LEN})`, async ({ browser, page }) => {
  const app = await enterState(page, 'full', { id: 'none', files: [] }, OPTS);
  const all = await app.frame.evaluate(async () => (await window.gisworkbench.api.v2.commands.list()).filter((c) => c.implemented).map((c) => c.id));
  const ids = all.filter((id) => !isExcluded(id)).sort();
  console.log(`command fuzz: seed ${SEED}, ${RUNS} sequences of up to ${LEN} from ${ids.length} commands (${all.length - ids.length} excluded)`);
  await page.close();
  if (ONE) {
    const problems = await runSequence(browser, ONE);
    expect(problems, `sequence ${JSON.stringify(ONE)}`).toEqual([]);
    return;
  }
  const ran = [];
  const found = new Map(); // sequence -> what was wrong with it, to print for the shrunk one
  const prop = fc.asyncProperty(fc.array(fc.constantFrom(...ids), { minLength: 1, maxLength: LEN }), async (seq) => {
    ran.push(seq);
    if (process.env.GW_FUZZ_VERBOSE) console.log(`sequence ${ran.length}: ${JSON.stringify(seq)}`);
    const problems = await runSequence(browser, seq);
    if (problems.length) {
      found.set(JSON.stringify(seq), problems);
      throw new Error(problems.join('; '));
    }
  });
  const result = await fc.check(prop, { seed: SEED, numRuns: RUNS, interruptAfterTimeLimit: 600_000, verbose: process.env.GW_FUZZ_VERBOSE ? 2 : 0 });
  // The same seed gives the same sequences: this fingerprint is how two runs are compared.
  console.log(`command fuzz: ${ran.length} sequences run, fingerprint ${createHash('sha1').update(JSON.stringify(ran)).digest('hex').slice(0, 12)}, ${result.failed ? 'FAILED' : 'clean'}`);
  if (!result.failed && result.interrupted) throw new Error(`command fuzz stopped at its 10 minute limit after ${ran.length} of ${RUNS} sequences, so most of the run did not happen (seed ${SEED}); lower GW_FUZZ_RUNS or run it on a faster machine`);
  if (!result.failed) return;
  if (process.env.GW_FUZZ_VERBOSE) console.log('every failing sequence seen while shrinking:', JSON.stringify(result.failures.map((f) => f[0])));
  const seq = result.counterexample[0];
  const why = (found.get(JSON.stringify(seq)) ?? []).map((p) => `  ${p}`);
  throw new Error(
    [
      `command fuzz failed after ${result.numRuns} sequences (shrunk ${result.numShrinks} times)`,
      `seed: ${SEED}`,
      `shrunk failing sequence: ${JSON.stringify(seq)}`,
      'what was wrong:',
      ...why,
      `replay the whole run: GW_FUZZ_SEED=${SEED}; replay just this sequence: GW_FUZZ_SEQ='${JSON.stringify(seq)}'`,
    ].join('\n'),
  );
});
