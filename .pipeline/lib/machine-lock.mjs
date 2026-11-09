// One machine-wide lock so concurrent `verify full` and `verify e2e` runs queue instead of
// overlapping. Overlapping runs starve each other of CPU and fail timing tests on code nobody
// touched. Waiters take the lock in the order they arrived, by a ticket file each, so one can't
// starve while others keep winning the race after a release. The decisions are pure functions;
// the file handling around them is thin.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
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

// `tickets` are the waiters' ticket files, { name, pid, idleMs }. Names sort in arrival order.
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

// Ticket names are arrival time, then pid and a random tail, so a plain sort is arrival order.
const ticketName = () => `${String(Date.now()).padStart(15, '0')}-${process.pid}-${randomBytes(3).toString('hex')}`;

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

// Resolves once this process holds the lock. Returns release(). Skipped under CI.
export async function acquire({ level, path = LOCK_PATH, log = console.error, env = process.env } = {}) {
  if (env.CI === 'true') return () => {};
  const mine = { pid: process.pid, level, cwd: process.cwd(), startedAt: Date.now() };
  const began = Date.now();
  let lastSaid = '';
  let lastAt = 0;
  const queueDir = `${path}.queue`;
  mkdirSync(queueDir, { recursive: true });
  const ticket = ticketName();
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
