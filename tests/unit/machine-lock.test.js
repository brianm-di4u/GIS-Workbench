import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STALE_MS, acquire, decide, describeWait, duration } from '../../.pipeline/lib/machine-lock.mjs';

const holder = { pid: 4242, level: 'full', cwd: 'C:/work/a', startedAt: 1_000_000 };
const up = () => true;
const gone = () => false;

describe('machine lock decisions', () => {
  it('takes a free lock', () => {
    expect(decide({ lock: null, alive: up }).action).toBe('acquire');
  });

  it('waits behind a live, recently touched holder', () => {
    expect(decide({ lock: holder, idleMs: 5000, alive: up })).toEqual({ action: 'wait', holder });
  });

  it('recovers a lock whose process is gone', () => {
    const step = decide({ lock: holder, idleMs: 5000, alive: gone });
    expect(step.action).toBe('recover');
    expect(step.why).toContain('4242');
  });

  it('recovers a lock nobody has touched for too long, even if the pid answers (a reused pid)', () => {
    expect(decide({ lock: holder, idleMs: STALE_MS + 1, alive: up }).action).toBe('recover');
  });

  it('gives a half-written lock file time, then recovers it', () => {
    expect(decide({ unreadable: true, idleMs: 100, alive: up }).action).toBe('wait');
    expect(decide({ unreadable: true, idleMs: STALE_MS + 1, alive: up }).action).toBe('recover');
  });

  it('says who holds the lock and how long everyone has waited', () => {
    const text = describeWait({ holder, now: holder.startedAt + 125_000, waitedMs: 42_000 });
    expect(text).toContain('pid 4242');
    expect(text).toContain('verify full');
    expect(text).toContain('C:/work/a');
    expect(text).toContain('running 2m 5s');
    expect(text).toContain('Waited 42s');
  });

  it('formats short and long durations', () => {
    expect(duration(0)).toBe('0s');
    expect(duration(59_400)).toBe('59s');
    expect(duration(3_725_000)).toBe('62m 5s');
  });
});

describe('machine lock files', () => {
  let dir;
  let path;
  const lines = [];
  const opts = { level: 'full', env: {}, log: (m) => lines.push(m) };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gwb-lock-test-'));
    path = join(dir, 'lock');
    lines.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes our pid, and release removes the file', async () => {
    const release = await acquire({ ...opts, path });
    expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(process.pid);
    release();
    expect(existsSync(path)).toBe(false);
  });

  it('makes a second acquirer wait for the first, and says who holds it', async () => {
    const first = await acquire({ ...opts, path });
    // Our own pid is alive, so the file is a live holder to the second acquirer.
    let got = false;
    const second = acquire({ ...opts, path }).then((release) => {
      got = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(got).toBe(false);
    expect(lines.join(' ')).toContain(`pid ${process.pid}`);
    first();
    (await second)();
    expect(got).toBe(true);
    expect(existsSync(path)).toBe(false);
  }, 15_000);

  it('recovers a lock left by a process that is gone', async () => {
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    writeFileSync(path, JSON.stringify({ pid: dead, level: 'full', cwd: 'x', startedAt: 0 }));
    const release = await acquire({ ...opts, path });
    expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(process.pid);
    expect(lines.join(' ')).toContain('stale');
    release();
  }, 15_000);

  it('does nothing under CI', async () => {
    writeFileSync(path, JSON.stringify({ pid: process.pid, level: 'e2e', cwd: 'x', startedAt: 0 }));
    const release = await acquire({ ...opts, path, env: { CI: 'true' } });
    release();
    expect(JSON.parse(readFileSync(path, 'utf8')).level).toBe('e2e');
  });
});
