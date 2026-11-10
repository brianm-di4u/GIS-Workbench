// Council bookkeeping. Which seats run, which model they run on, and when review stops all live
// here as plain code, so convergence doesn't depend on a model remembering the rules. Upstream's
// unbounded loop is what produced an 80,000-line PR; the per-phase caps are the fix.
//
// A change is reviewed in two phases. In the loop phase every seat and the verifier run on
// `council.loopModel`. Rounds repeat until no blocker or should is open and the last two rounds in a
// row raised nothing above a nit. Then close-out repeats the same rule on `council.closeModel`. The
// verdict is rendered only after close-out converges. Each phase has a hard cap, and hitting it parks
// the change.
import { matchesAny } from './paths.mjs';

export const SEVERITIES = ['blocker', 'should', 'nit'];
const BLOCKING = new Set(['blocker', 'should']);
export const CLEAN_ROUNDS = 2;

export const PHASES = ['loop', 'close'];
export const modelFor = (phase, council = {}) => (phase === 'close' ? council.closeModel ?? 'opus' : council.loopModel ?? 'sonnet');
// A cap has to leave room for the clean rounds a phase needs, and a value that isn't a number falls
// back to the default rather than removing the cap.
export const capFor = (phase, council = {}) => {
  const [value, fallback] = phase === 'close' ? [council.maxCloseRounds, 4] : [council.maxLoopRounds, 8];
  return Number.isInteger(value) ? Math.max(CLEAN_ROUNDS, value) : fallback;
};

export const DEFAULT_TRIGGERS = {
  ui: ['**/*.html', '**/*.css', '**/*.scss', '**/*.jsx', '**/*.tsx', '**/*.vue', '**/*.svelte', '**/ui/**'],
  runtime: [
    '**/*.js', '**/*.mjs', '**/*.cjs', '**/*.ts', '**/*.jsx', '**/*.tsx', '**/*.rs', '**/*.py', '**/*.go',
    '**/*.swift', '**/*.kt', '**/*.sql', '**/*.c', '**/*.cpp', '**/*.h',
  ],
  content: [
    '**/package.json', '**/package-lock.json', '**/Cargo.toml', '**/Cargo.lock', '**/assets/**', '**/data/**',
    '**/content/**', 'THIRD_PARTY*', 'LICENSE*',
  ],
};

const ALWAYS = ['council-bug-hunter', 'council-minimalist'];
const T1_CORE = ['council-security-auditor', 'council-evidence-auditor'];
// Most droppable first. Security and architect never drop on T2.
const DROP_ORDER = ['council-ux-a11y-reviewer', 'council-reliability-engineer', 'council-legal-reviewer'];

export function selectSeats({ tier, paths, council = {}, diffLines = 0, model = null }) {
  const triggers = { ...DEFAULT_TRIGGERS, ...council.triggers };
  const code = paths.filter((p) => !matchesAny(p, ['**/*.md', 'tests/**', '**/*.test.*']));
  const touches = (globs) => code.some((p) => matchesAny(p, globs));

  if (tier === 0) {
    return {
      seats: ALWAYS.map((agent) => ({ agent, model: model ?? 'sonnet' })),
      panel: [model ?? 'sonnet'],
      dropped: [],
    };
  }

  const wanted = [...ALWAYS, ...T1_CORE];
  const structural =
    tier === 2 ||
    diffLines > (council.structuralLines ?? 400) ||
    paths.some((p) => matchesAny(p, ['docs/decisions/**']));
  if (structural) wanted.push('council-architect');
  if (touches(triggers.content)) wanted.push('council-legal-reviewer');
  if (touches(triggers.runtime)) wanted.push('council-reliability-engineer');
  if (touches(triggers.ui)) wanted.push('council-ux-a11y-reviewer');

  // A project's own seats, each called for by the paths it names. They're the last
  // to drop: a project adds one because no generic seat can do its job.
  const extras = (council.extraSeats ?? []).filter((seat) => touches(seat.paths)).map((seat) => seat.agent);
  wanted.push(...extras);

  const limit = council.maxSeats ?? 6;
  const dropped = [];
  for (const seat of [...DROP_ORDER, ...extras]) {
    if (wanted.length <= limit) break;
    const index = wanted.indexOf(seat);
    if (index !== -1) {
      wanted.splice(index, 1);
      dropped.push(seat);
    }
  }

  // A model passed in overrides every seat's own model and the whole verifier panel. Without one
  // (a caller that isn't running a phase), seats keep their own and the panel is as it always was.
  const size = tier === 2 ? 3 : 2;
  return {
    seats: wanted.map((agent) => (model ? { agent, model } : { agent })),
    panel: model ? Array(size).fill(model) : tier === 2 ? ['sonnet', 'sonnet', 'opus'] : ['sonnet', 'sonnet'],
    dropped,
  };
}

export function emptyLedger() {
  return { rounds: [], findings: [], nextId: 1, growthAccepted: null, raise: null };
}

const STOPWORDS = new Set(['this', 'that', 'with', 'from', 'when', 'which', 'bug', 'class', 'missing', 'error', 'issue', 'problem']);
const words = (text) =>
  new Set((text ?? '').toLowerCase().match(/[a-z0-9]{4,}/g)?.filter((word) => !STOPWORDS.has(word)) ?? []);
const overlap = (a, b) => [...a].filter((word) => b.has(word)).length;

// Seats reword a finding from round to round, and fixes shift its line, so a repeat
// is the same file, a nearby line, and the same subject.
export function sameFinding(a, b) {
  if ((a.file ?? '') !== (b.file ?? '')) return false;
  if (Math.abs((a.line ?? 0) - (b.line ?? 0)) > 5) return false;
  if (overlap(words(a.class), words(b.class)) > 0) return true;
  const claimA = words(a.claim);
  const claimB = words(b.claim);
  const shared = overlap(claimA, claimB);
  return shared > 0 && shared / new Set([...claimA, ...claimB]).size >= 0.25;
}

const unanswered = (ledger) => ledger.findings.filter((f) => f.status === 'open');
const blockingOpen = (ledger) => unanswered(ledger).filter((f) => BLOCKING.has(f.severity));

// The round a new one is diffed from. An incomplete round is rerun on the same head, so a diff from
// it would be empty and read as clean.
export const lastCompleteRound = (ledger) => ledger.rounds.filter((r) => r.complete).at(-1);

// A round is clean when it finished and raised nothing above a nit. A round from before phases
// were recorded has no `raised`, so it is never clean and doesn't count toward either phase.
const isClean = (round) => round.complete && round.raised != null && round.raised.blocker + round.raised.should === 0;
const roundsIn = (ledger, phase) => ledger.rounds.filter((r) => r.phase === phase && r.complete);

// How many of the latest rounds in a row were clean on the same content. A round after the content
// changed starts the count again, so two clean rounds are two looks at the same change.
export function cleanTail(rounds) {
  const hash = rounds.at(-1)?.hash;
  let count = 0;
  for (let i = rounds.length - 1; i >= 0 && isClean(rounds[i]) && rounds[i].hash === hash; i -= 1) count += 1;
  return count;
}

// Where a change stands: the loop phase is done once its latest rounds are two clean ones in a row on
// the same content, whatever happens after. Close-out is done when its latest rounds are two clean ones
// in a row on this exact content, with nothing open. The caps count every round in a phase, clean or not.
export function phaseState(ledger, hash) {
  const loop = roundsIn(ledger, 'loop');
  const close = roundsIn(ledger, 'close');
  const loopDone = cleanTail(loop) >= CLEAN_ROUNDS;
  const closeDone = loopDone && cleanTail(close) >= CLEAN_ROUNDS && close.at(-1).hash === hash && blockingOpen(ledger).length === 0;
  return { loop, close, loopDone, closeDone };
}

export function nextStep({ ledger, tier, hash, council = {}, cleanTree, evidenceOk, diffLines }) {
  const last = ledger.rounds.at(-1);
  const complete = ledger.rounds.filter((r) => r.complete);
  const base = { tier, hash, roundsUsed: complete.length };

  if (!cleanTree) return { ...base, status: 'commit-first', message: 'Commit everything first. The council reviews commits.' };
  if (!evidenceOk) {
    return { ...base, status: 'prove-first', message: 'Run node .pipeline/verify.mjs full on this exact change first.' };
  }
  if (last && !last.complete) {
    // Timeout or no reply isn't approval. Rerun the same round, on the same phase and model.
    return {
      ...base,
      status: 'review',
      mode: last.mode,
      phase: last.phase ?? 'loop',
      model: last.model ?? modelFor('loop', council),
      round: last.number,
      message: 'The last round was incomplete: a seat or voter gave no answer. Run it again.',
    };
  }
  if (blockingOpen(ledger).length > 0) {
    return {
      ...base,
      status: 'answer-findings',
      message: 'Answer every open blocker and should first, with: node .pipeline/council.mjs resolve',
      open: blockingOpen(ledger),
    };
  }

  // Docs-only changes get the one round.
  if (tier === 0) {
    if (last && last.hash === hash) return { ...base, status: 'done', message: 'The council has reviewed this exact change. Render the verdict.' };
    const cap = capFor('loop', council);
    if (roundsIn(ledger, 'loop').length >= cap) {
      return { ...base, status: 'parked', phase: 'loop', message: `A docs-only change that needs more than ${cap} rounds isn't settling. Stop, leave the PR open, and summarize on it what each round raised and what is still open, for the admin. This isn't approval.` };
    }
    return { ...base, status: 'review', mode: 'full', phase: 'loop', model: modelFor('loop', council), round: complete.length + 1 };
  }

  const state = phaseState(ledger, hash);
  if (state.closeDone) {
    return { ...base, status: 'done', message: 'Close-out has converged on this exact change. Render the verdict.' };
  }

  const phase = state.loopDone ? 'close' : 'loop';
  const used = (phase === 'close' ? state.close : state.loop).length;
  const cap = capFor(phase, council);
  if (used >= cap) {
    return {
      ...base,
      status: 'parked',
      phase,
      message: `The ${phase === 'close' ? 'close-out' : 'loop'} phase hit its cap of ${cap} rounds without converging. Stop, leave the PR open, and summarize on it what each round raised and what is still open, for the admin. This isn't approval.`,
    };
  }

  const firstLines = ledger.rounds[0]?.diffLines ?? null;
  const growth = council.maxDiffGrowth ?? 1.5;
  if (firstLines !== null && diffLines > Math.max(firstLines * growth, firstLines + 40) && !ledger.growthAccepted) {
    return {
      ...base,
      status: 'cut-first',
      message: `The diff grew from ${firstLines} to ${diffLines} lines during review. Cut what the intent doesn't need. If the growth is justified: node .pipeline/council.mjs accept-growth "reason"`,
    };
  }

  // The first round of a phase looks at everything. After that a changed head gets a diff from the
  // last reviewed commit, and an unchanged one gets another full, independent look.
  const previous = (phase === 'close' ? state.close : state.loop).at(-1);
  const mode = !previous || previous.hash === hash ? 'full' : 'diff';
  return {
    ...base,
    status: 'review',
    mode,
    phase,
    model: modelFor(phase, council),
    round: complete.length + 1,
    phaseRound: used + 1,
    phaseCap: cap,
  };
}

export function recordRound(ledger, { mode, round, phase = 'loop', model = null, hash, sha, diffLines, result }) {
  // What this round raised. A bug this change didn't introduce never blocks. An incomplete round
  // raised nothing we can count.
  // A repeat of a finding already on the ledger doesn't count: that is a reviewer asking again. Two
  // things are not repeats: a finding the author fixed, because the bug came back, and a more severe
  // finding than the earlier one at that place, because an automatically declined nit has not
  // answered a blocker.
  const repeatOf = (list, f) =>
    list.some((earlier) => earlier.status !== 'fixed' && SEVERITIES.indexOf(f.severity) >= SEVERITIES.indexOf(earlier.severity) && sameFinding(earlier, f));
  const answered = (f) => repeatOf(ledger.findings, f);
  const raised = (result.missing ?? []).length === 0
    ? Object.fromEntries(SEVERITIES.map((severity) => [severity, (result.findings ?? []).filter((f) => f.severity === severity && !f.preExisting && !answered(f)).length]))
    : null;
  const seen = [...ledger.findings];
  const added = [];
  const repeats = [];
  let nits = ledger.findings.filter((f) => f.severity === 'nit').length;
  const maxNits = result.maxNits ?? 5;
  const droppedNits = [];

  // An incomplete round is rerun, so its findings arrive with the rerun.
  const incomplete = (result.missing ?? []).length > 0;
  const ordered = [...(incomplete ? [] : (result.findings ?? []))].sort(
    (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity),
  );
  for (const finding of ordered) {
    if (repeatOf(seen, finding)) {
      repeats.push(finding);
      continue;
    }
    seen.push(finding);
    if (finding.preExisting) {
      ledger.findings.push({ ...finding, id: `P${ledger.nextId++}`, status: 'pre-existing', round });
      continue;
    }
    if (finding.severity === 'nit') {
      if (nits >= maxNits) {
        droppedNits.push(finding);
        continue;
      }
      nits += 1;
      // Declined by default: an agent fixing a nit costs another round.
      ledger.findings.push({ ...finding, id: `N${ledger.nextId++}`, status: 'declined', disposition: 'deferred', round });
      continue;
    }
    const entry = { ...finding, id: `S${ledger.nextId++}`, status: 'open', round };
    ledger.findings.push(entry);
    added.push(entry);
    if (finding.raise && !ledger.raise) ledger.raise = finding.raise;
  }

  const complete = (result.missing ?? []).length === 0;
  // A rerun replaces an incomplete round, so a timeout doesn't use up a phase's cap.
  if (ledger.rounds.at(-1)?.complete === false) ledger.rounds.pop();
  ledger.rounds.push({
    number: round,
    mode,
    phase,
    model,
    raised,
    hash,
    sha,
    diffLines,
    complete,
    seats: result.seats ?? [],
    missing: result.missing ?? [],
    refuted: result.refuted ?? 0,
  });
  return { added, repeats, droppedNits, complete };
}

const DISPOSITIONS = new Set(['fixed', 'wrong', 'intentional', 'wont-matter', 'deferred']);

export function resolveFinding(ledger, id, disposition, reason) {
  if (!DISPOSITIONS.has(disposition)) {
    throw new Error(`Disposition must be one of: ${[...DISPOSITIONS].join(', ')}`);
  }
  const finding = ledger.findings.find((f) => f.id === id);
  if (!finding) throw new Error(`No finding ${id}`);
  if (disposition !== 'fixed' && !reason) throw new Error(`Declining ${id} needs a written reason.`);
  finding.status = disposition === 'fixed' ? 'fixed' : 'declined';
  finding.disposition = disposition;
  finding.reason = reason ?? null;
  return finding;
}

export function buildVerdict({ ledger, tier: reviewedTier, hash }) {
  // A finding that raised the change to the admin raises its tier, here as in the plan.
  const tier = ledger.raise ? Math.max(reviewedTier, 2) : reviewedTier;
  const last = ledger.rounds.at(-1);
  if (!last) throw new Error('The council has not reviewed this change.');
  if (last.hash !== hash) throw new Error('The last round reviewed different content. Run another round.');
  if (!last.complete) throw new Error('The last round was incomplete.');
  const open = blockingOpen(ledger);
  if (open.length > 0) throw new Error(`Open findings: ${open.map((f) => f.id).join(', ')}`);
  // The verdict comes only after close-out converges (a docs-only change has the one round).
  if (tier > 0 && !phaseState(ledger, hash).closeDone) {
    throw new Error('Close-out has not converged on this change: it needs two clean rounds in a row on the close-out model. Run another round.');
  }

  const counted = ledger.rounds.filter((r) => r.complete);
  const count = (severity) =>
    ledger.findings.filter((f) => f.severity === severity && f.status === 'open').length;
  const phases = Object.fromEntries(PHASES.map((phase) => [phase, { rounds: roundsIn(ledger, phase).length, model: roundsIn(ledger, phase).at(-1)?.model ?? null }]));
  return {
    schema: 1,
    changeHash: hash,
    tier,
    rounds: counted.length,
    ...(tier > 0 ? { phases } : {}),
    open: { blocker: count('blocker'), should: count('should'), nit: ledger.findings.filter((f) => f.severity === 'nit').length },
    ...(ledger.raise ? { raise: ledger.raise } : {}),
    // Self-reported by `council.mjs plan --worker <model>`, for the digest.
    ...(ledger.worker ? { worker: { model: ledger.worker } } : {}),
    seats: [...new Set(ledger.rounds.flatMap((r) => r.seats))],
    diff: { first: ledger.rounds[0]?.diffLines ?? 0, final: last.diffLines },
    findings: ledger.findings.map((f) => ({
      id: f.id,
      severity: f.severity,
      class: f.class ?? null,
      disposition: f.disposition ?? f.status,
    })),
  };
}
