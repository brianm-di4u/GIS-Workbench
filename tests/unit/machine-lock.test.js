import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STALE_MS, acquire, decide, describeWait, duration, queueTurn, ticketName } from '../../.pipeline/lib/machine-lock.mjs';

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

describe('machine lock queue order', () => {
  const ticket = (name, pid = 1, idleMs = 0) => ({ name, pid, idleMs });

  it('puts waiters in arrival order, whatever order the directory lists them', () => {
    const tickets = [ticket('003-1-c'), ticket('001-1-a'), ticket('002-1-b')];
    expect(queueTurn({ tickets, self: '001-1-a', alive: up }).position).toBe(0);
    expect(queueTurn({ tickets, self: '002-1-b', alive: up }).position).toBe(1);
    expect(queueTurn({ tickets, self: '003-1-c', alive: up }).position).toBe(2);
  });

  it('does not let a later waiter jump ahead of an earlier one', () => {
    const tickets = [ticket('001-1-a'), ticket('002-1-b')];
    expect(queueTurn({ tickets, self: '002-1-b', alive: up }).position).not.toBe(0);
  });

  it('skips and reports tickets whose process is gone', () => {
    const tickets = [ticket('001-7-a', 7), ticket('002-1-b')];
    const turn = queueTurn({ tickets, self: '002-1-b', alive: (pid) => pid !== 7 });
    expect(turn.position).toBe(0);
    expect(turn.stale.map((t) => t.name)).toEqual(['001-7-a']);
  });

  it('skips a ticket nobody has touched for too long, even if the pid answers', () => {
    const tickets = [ticket('001-1-a', 1, STALE_MS + 1), ticket('002-1-b')];
    const turn = queueTurn({ tickets, self: '002-1-b', alive: up });
    expect(turn.position).toBe(0);
    expect(turn.stale).toHaveLength(1);
  });

  it('serves a release ticket that arrived later before every normal ticket (#268)', () => {
    const at = 1_794_640_789_180;
    const normal = ticketName({ now: at, pid: 1, tail: 'a' });
    const release = ticketName({ priority: 'release', now: at + 60_000, pid: 2, tail: 'b' });
    const laterRelease = ticketName({ priority: 'release', now: at + 90_000, pid: 3, tail: 'c' });
    const tickets = [ticket(normal, 1), ticket(laterRelease, 3), ticket(release, 2)];
    expect(queueTurn({ tickets, self: release, alive: up }).position).toBe(0);
    expect(queueTurn({ tickets, self: laterRelease, alive: up }).position).toBe(1); // arrival order among release tickets
    expect(queueTurn({ tickets, self: normal, alive: up }).position).toBe(2);
  });

  it('keeps the name layout older copies read: the pid second, and a plain sort in serving order', () => {
    const release = ticketName({ priority: 'release', now: 1_794_640_789_180, pid: 4242, tail: 'aaaaaa' });
    expect(release.split('-')[1]).toBe('4242');
    expect([ticketName({ now: 1_000_000_000_000, pid: 1, tail: 'a' }), release].sort()[0]).toBe(release); // a normal ticket from 2001 still sorts after it
  });

  it('refuses a priority it does not know', () => {
    expect(() => ticketName({ priority: 'urgent' })).toThrow(/release or normal/);
  });

  it('never calls its own ticket stale, and reports -1 when it has none', () => {
    expect(queueTurn({ tickets: [ticket('001-1-a', 1, STALE_MS + 1)], self: '001-1-a', alive: gone }).stale).toEqual([]);
    expect(queueTurn({ tickets: [], self: '001-1-a', alive: up }).position).toBe(-1);
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

  it('hands the lock to waiters in arrival order', async () => {
    const first = await acquire({ ...opts, path });
    const order = [];
    const waiters = [];
    for (const name of ['b', 'c', 'd']) {
      waiters.push(acquire({ ...opts, path }).then((release) => (order.push(name), release)));
      await new Promise((resolve) => setTimeout(resolve, 30)); // distinct arrival times
    }
    first();
    for (const waiter of waiters) (await waiter)();
    expect(order).toEqual(['b', 'c', 'd']);
    expect(readdirSync(`${path}.queue`)).toEqual([]);
  }, 30_000);

  it('hands the lock to a release waiter before a normal one that queued first (#268)', async () => {
    const first = await acquire({ ...opts, path });
    const order = [];
    const normal = acquire({ ...opts, path }).then((release) => (order.push('normal'), release));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const release = acquire({ ...opts, path, priority: 'release' }).then((r) => (order.push('release'), r));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(order).toEqual([]); // the holder is not pre-empted
    first();
    (await release)();
    (await normal)();
    expect(order).toEqual(['release', 'normal']);
  }, 30_000);

  it('takes the priority from GWB_VERIFY_PRIORITY when none is passed', async () => {
    const releaseLock = await acquire({ ...opts, path, env: { GWB_VERIFY_PRIORITY: 'release' } });
    expect(JSON.parse(readFileSync(path, 'utf8')).priority).toBe('release');
    releaseLock();
  });

  it('keeps beating while the holder blocks its own event loop, so it is not taken as stale', async () => {
    const releaseLock = await acquire({ ...opts, path, heartbeatMs: 50 });
    const before = statSync(path).mtimeMs;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); // as a long spawnSync would
    expect(statSync(path).mtimeMs).toBeGreaterThan(before + 200);
    releaseLock();
    expect(existsSync(path)).toBe(false);
  });

  it('does not wait behind a queued process that is gone', async () => {
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    mkdirSync(`${path}.queue`);
    writeFileSync(join(`${path}.queue`, `000000000000001-${dead}-aaaaaa`), '{}');
    const release = await acquire({ ...opts, path });
    release();
    expect(readdirSync(`${path}.queue`)).toEqual([]);
  }, 15_000);

  it('waits behind a queued process that is alive', async () => {
    mkdirSync(`${path}.queue`);
    const early = join(`${path}.queue`, `000000000000001-${process.pid}-aaaaaa`);
    writeFileSync(early, '{}');
    let got = false;
    const waiting = acquire({ ...opts, path }).then((release) => ((got = true), release));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(got).toBe(false); // the lock is free, but it is not our turn
    rmSync(early);
    (await waiting)();
    expect(got).toBe(true);
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
