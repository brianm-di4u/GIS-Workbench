// One machine-wide lock so concurrent `verify full` and `verify e2e` runs queue instead of
// overlapping. Overlapping runs starve each other of CPU and fail timing tests on code nobody
// touched. Waiters take the lock in the order they arrived, by a ticket file each, so one can't
// starve while others keep winning the race after a release. A `release` ticket (a release-path
// verify, #268) goes ahead of every `normal` one, in arrival order among release tickets; a
// running holder is never pre-empted. The decisions are pure functions; the file handling around
// them is thin.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

export const LOCK_PATH = process.env.GWB_VERIFY_LOCK || join(tmpdir(), 'gwb-verify.lock');
const POLL_MS = 2000;
const HEARTBEAT_MS = 10_000;
// A live holder touches the file every HEARTBEAT_MS, from a worker thread, so it beats even while
// its main thread is blocked. A silent one is a process that has gone and whose pid now answers
// for another process (a reused pid).
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

// `tickets` are the waiters' ticket files, { name, pid, idleMs }. Names sort in serving order:
// release tickets first, then arrival (see ticketName).
// `position` is how many live waiters are ahead of `self` (0 means it is next), or -1 when it has
// no ticket. `stale` are tickets to delete: their process is gone, or stopped touching the file.
export function queueTurn({ tickets, self, alive, staleMs = STALE_MS }) {
  const sorted = [...tickets].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const stale = sorted.filter((t) => t.name !== self && (!alive(t.pid) || t.idleMs > staleMs));
  const live = sorted.filter((t) => !stale.includes(t));
  return { position: live.findIndex((t) => t.name === self), stale };
}

export function describeWait({ holder, now, waitedMs, ahead = 0 }) {
  const who = `pid ${holder.pid}, verify ${holder.level}, ${holder.cwd}`;
  const line = ahead > 0 ? ` ${ahead} waiting ahead of you.` : '';
  return `Waiting for the machine lock held by ${who} (running ${duration(now - holder.startedAt)}). Waited ${duration(waitedMs)} so far.${line}`;
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

export const PRIORITIES = ['release', 'normal'];

// Ticket names are arrival time, then pid and a random tail, so a plain sort is arrival order.
// A release ticket's time has one more leading zero ("000…" against "00…" while Date.now() has
// 13 digits), so it sorts before every normal ticket. Older copies of this file sort names the
// same way and read the pid from the same place, so they honour the order too.
export function ticketName({ priority = 'normal', now = Date.now(), pid = process.pid, tail = randomBytes(3).toString('hex') } = {}) {
  if (!PRIORITIES.includes(priority)) throw new Error(`machine lock priority "${priority}": use ${PRIORITIES.join(' or ')}`);
  return `${priority === 'release' ? '0' : ''}${String(now).padStart(15, '0')}-${pid}-${tail}`;
}

function readTickets(dir) {
  const tickets = [];
  for (const name of readdirSync(dir)) {
    try {
      tickets.push({ name, pid: Number(name.split('-')[1]), idleMs: Date.now() - statSync(join(dir, name)).mtimeMs });
    } catch {} // taken between the listing and the stat
  }
  return tickets;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Touches the lock file from a worker thread. A holder that blocks its own event loop (a long
// spawnSync, say) still beats, so a waiter never takes a busy holder's lock as stale. A holder
// whose process has gone stops beating, and that is still recovered (a reused pid).
const BEAT = `const { workerData: { path, ms } } = require('node:worker_threads');
const { utimesSync } = require('node:fs');
setInterval(() => { try { utimesSync(path, new Date(), new Date()); } catch {} }, ms);`;

// Resolves once this process holds the lock. Returns release(). Skipped under CI.
// `priority` is 'release' for a release-path run and 'normal' otherwise; GWB_VERIFY_PRIORITY sets
// it for a run that does not pass one (`GWB_VERIFY_PRIORITY=release node .pipeline/verify.mjs full`).
export async function acquire({ level, path = LOCK_PATH, log = console.error, env = process.env, priority = env.GWB_VERIFY_PRIORITY || 'normal', heartbeatMs = HEARTBEAT_MS } = {}) {
  if (env.CI === 'true') return () => {};
  const mine = { pid: process.pid, level, priority, cwd: process.cwd(), startedAt: Date.now() };
  const began = Date.now();
  let lastSaid = '';
  let lastAt = 0;
  const queueDir = `${path}.queue`;
  mkdirSync(queueDir, { recursive: true });
  const ticket = ticketName({ priority });
  const ticketPath = join(queueDir, ticket);
  const takeTicket = () => writeFileSync(ticketPath, JSON.stringify(mine));
  const dropTicket = () => {
    try {
      unlinkSync(ticketPath);
    } catch {}
  };
  takeTicket();
  const onExit = () => dropTicket();
  process.on('exit', onExit);

  for (;;) {
    try {
      utimesSync(ticketPath, new Date(), new Date()); // a live waiter touches its ticket every poll
    } catch {
      takeTicket(); // removed by a cleanup that mistook us for stale; take our place back
    }
    const turn = queueTurn({ tickets: readTickets(queueDir), self: ticket, alive: pidAlive });
    for (const t of turn.stale) {
      try {
        unlinkSync(join(queueDir, t.name));
      } catch {}
    }
    const seen = readLock(path);
    let step = decide({ ...seen, alive: pidAlive });
    // A free lock is only ours when we are first in line.
    if (step.action === 'acquire' && turn.position > 0) step = { action: 'wait', queued: true };
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
        mine.startedAt = Date.now(); // when the lock is taken, not when the wait began
        writeFileSync(path, JSON.stringify(mine), { flag: 'wx' });
        // Confirm that the file is ours, in case a recovery elsewhere removed and replaced it.
        if (readLock(path).lock?.pid === mine.pid) {
          dropTicket(); // after the lock is written, so the next waiter sees it taken
          break;
        }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    } else {
      const text = step.holder ? describeWait({ holder: step.holder, now: Date.now(), waitedMs: Date.now() - began, ahead: turn.position }) : '';
      const key = step.holder ? `${step.holder.pid} ${turn.position}` : '';
      if (text && (key !== lastSaid || Date.now() - lastAt >= 30_000)) {
        log(text);
        lastSaid = key;
        lastAt = Date.now();
      }
    }
    await sleep(POLL_MS);
  }

  process.off('exit', onExit);
  if (Date.now() - began > 1000) log(`Got the machine lock after ${duration(Date.now() - began)}.`);
  const beat = new Worker(BEAT, { eval: true, workerData: { path, ms: heartbeatMs } });
  beat.unref();

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    beat.terminate();
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
