#!/usr/bin/env node
// The single verification entry point: node .pipeline/verify.mjs <fast|full|e2e>
//
// Runs the commands set in pipeline.config.json and records evidence: each
// command, its exit code, and its output. Agents cite this instead of claiming
// that something works. Evidence is written under .pipeline/evidence/, which is
// gitignored.
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { changeSet, tryGit } from './lib/git.mjs';
import { acquire } from './lib/machine-lock.mjs';
import { installProblem } from './lib/node-modules.mjs';

const LEVELS = ['fast', 'full', 'e2e'];

function run(command, log) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const tee = (stream, target) =>
      stream.on('data', (chunk) => {
        target.write(chunk);
        log.write(chunk);
      });
    tee(child.stdout, process.stdout);
    tee(child.stderr, process.stderr);
    child.on('close', (code) => resolve({ command, exit: code ?? 1, ms: Date.now() - started }));
    child.on('error', () => resolve({ command, exit: 1, ms: Date.now() - started }));
  });
}

function evidenceDir() {
  // Keyed by change hash so the gate can match evidence to exact content.
  const base = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'origin/main';
  try {
    return changeSet(base, 'HEAD').hash.slice(0, 12);
  } catch {
    return 'unbased';
  }
}

async function main() {
  const level = process.argv[2];
  if (!LEVELS.includes(level)) {
    console.error(`Usage: verify.mjs <${LEVELS.join('|')}>`);
    return 2;
  }
  // A stale node_modules fails a long queued run for a reason that isn't the change, so say so first.
  // The sidecar leg runs only cargo steps and installs no npm packages, so it has nothing to check.
  const stale = process.env.GWB_LEG === 'sidecar' ? null : installProblem();
  if (stale) {
    console.error(stale);
    return 2;
  }
  const configured = loadConfig().verify[level];
  const commands = [configured ?? []].flat();
  if (commands.length === 0 || commands.some((c) => /^TODO\b/.test(c))) {
    console.error(`Set verify.${level} in pipeline.config.json. It is still: ${JSON.stringify(configured)}`);
    return 2;
  }
  // Full and e2e queue behind each other on one machine, because overlapping runs fail timing
  // tests. The quick licence/acceptance/docs checks below run before the lock is taken.
  let lockFrom = level === 'fast' ? Infinity : 0;
  // These always run before a full verify, whatever the stack.
  if (level === 'full') {
    lockFrom = 3;
    commands.unshift('node .pipeline/check-licenses.mjs', 'node .pipeline/check-acceptance.mjs', 'node .pipeline/check-docs.mjs');
  }

  const dir = join('.pipeline', 'evidence', evidenceDir());
  mkdirSync(dir, { recursive: true });
  const log = createWriteStream(join(dir, `${level}.log`));

  const results = [];
  for (const [index, command] of commands.entries()) {
    if (index === lockFrom) await acquire({ level });
    console.log(`\n$ ${command}`);
    log.write(`\n$ ${command}\n`);
    const result = await run(command, log);
    results.push(result);
    if (result.exit !== 0) break;
  }
  await new Promise((resolve) => log.end(resolve));

  const ok = results.length === commands.length && results.every((r) => r.exit === 0);
  const evidence = {
    level,
    ok,
    head: tryGit(['rev-parse', 'HEAD'])?.trim() ?? null,
    dirty: Boolean(tryGit(['status', '--porcelain'])?.trim()),
    results,
    log: join(dir, `${level}.log`).replaceAll('\\', '/'),
  };
  writeFileSync(join(dir, `${level}.json`), `${JSON.stringify(evidence, null, 2)}\n`);

  console.log(`\nverify ${level}: ${ok ? 'PASS' : 'FAIL'} (evidence: ${evidence.log})`);
  return ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
