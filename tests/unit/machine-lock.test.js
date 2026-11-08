import { describe, expect, it } from 'vitest';
import { STALE_MS, decide, describeWait, duration } from '../../.pipeline/lib/machine-lock.mjs';

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
