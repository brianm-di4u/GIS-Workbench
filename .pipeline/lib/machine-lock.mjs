// One machine-wide lock so concurrent `verify full` and `verify e2e` runs queue instead of
// overlapping. Overlapping runs starve each other of CPU and fail timing tests on code nobody
// touched. The decision is a pure function; the file handling around it is thin.
import { readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const LOCK_PATH = process.env.GWB_VERIFY_LOCK || join(tmpdir(), 'gwb-verify.lock');
const POLL_MS = 2000;
const HEARTBEAT_MS = 10_000;
// A live holder touches the file every HEARTBEAT_MS. A silent one is a reused PID or a hung run.
export const STALE_MS = 120_000;

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// `lock` is the parsed lock file, or null when there is none. `unreadable` means the file exists
// but is not valid yet (a holder mid-write). `idleMs` is how long since the holder last touched it.
export function decide({ lock, unreadable = false, idleMs = 0, alive }) {
  if (unreadable) return idleMs > STALE_MS ? { action: 'recover', why: 'unreadable lock file' } : { action: 'wait' };
  if (!lock) return { action: 'acquire' };
  if (!alive(lock.pid)) return { action: 'recover', why: `pid ${lock.pid} is gone` };
  if (idleMs > STALE_MS) return { action: 'recover', why: `pid ${lock.pid} stopped updating the lock` };
  return { action: 'wait', holder: lock };
}

export function describeWait({ holder, now, waitedMs }) {
  const who = `pid ${holder.pid}, verify ${holder.level}, ${holder.cwd}`;
  return `Waiting for the machine lock held by ${who} (running ${duration(now - holder.startedAt)}). Waited ${duration(waitedMs)} so far.`;
}

export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

function readLock(path) {
  try {
    const idleMs = Date.now() - statSync(path).mtimeMs;
    try {
      const lock = JSON.parse(readFileSync(path, 'utf8'));
      return Number.isInteger(lock?.pid) ? { lock, idleMs } : { unreadable: true, idleMs };
    } catch {
      return { unreadable: true, idleMs };
    }
  } catch {
    return { lock: null, idleMs: 0 };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Resolves once this process holds the lock. Returns release(). Skipped under CI.
export async function acquire({ level, path = LOCK_PATH, log = console.error, env = process.env } = {}) {
  if (env.CI === 'true') return () => {};
  const mine = { pid: process.pid, level, cwd: process.cwd(), startedAt: Date.now() };
  const began = Date.now();
  let lastSaid = '';
  let lastAt = 0;

  for (;;) {
    const seen = readLock(path);
    const step = decide({ ...seen, alive: pidAlive });
    if (step.action === 'recover') {
      log(`Removing a stale machine lock (${step.why}).`);
      // Re-read just before removing, so a lock another waiter took in between is left alone.
      const again = readLock(path);
      if (JSON.stringify(again.lock) === JSON.stringify(seen.lock)) {
        try {
          unlinkSync(path);
        } catch {}
      }
    } else if (step.action === 'acquire') {
      try {
        writeFileSync(path, JSON.stringify(mine), { flag: 'wx' });
        // Confirm that the file is ours, in case a recovery elsewhere removed and replaced it.
        if (readLock(path).lock?.pid === mine.pid) break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    } else {
      const text = step.holder ? describeWait({ holder: step.holder, now: Date.now(), waitedMs: Date.now() - began }) : '';
      const key = step.holder ? `${step.holder.pid}` : '';
      if (text && (key !== lastSaid || Date.now() - lastAt >= 30_000)) {
        log(text);
        lastSaid = key;
        lastAt = Date.now();
      }
    }
    await sleep(POLL_MS);
  }

  if (Date.now() - began > 1000) log(`Got the machine lock after ${duration(Date.now() - began)}.`);
  const beat = setInterval(() => {
    try {
      utimesSync(path, new Date(), new Date());
    } catch {}
  }, HEARTBEAT_MS);
  beat.unref();

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(beat);
    // Only remove the file if it is still ours.
    if (readLock(path).lock?.pid === mine.pid) {
      try {
        unlinkSync(path);
      } catch {}
    }
  };
  process.on('exit', release);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      release();
      process.exit(130);
    });
  }
  return release;
}
