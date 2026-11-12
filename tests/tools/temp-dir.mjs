// Temp folders for tests, removed when the test process ends (#228). Tests that made their own
// folder under the OS temp directory and never removed it left thousands behind. Make one here
// instead: `tempDir('gw-name')` returns a new, empty folder, deleted when the process exits, pass
// or fail. Vitest workers don't always run exit handlers, so temp-dir-vitest.mjs also removes
// each test file's folders when the file ends. tests/unit/temp-dir.test.js flags tests that reach
// for tmpdir() themselves.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made = new Set();
let hooked = false;

/** Delete every folder tempDir made in this process. Safe to call more than once. Best effort: a
 *  folder a process still holds open on Windows is left, and must not fail a run that passed. */
export function removeTempDirs() {
  for (const dir of made) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* still open elsewhere: leave it */
    }
  }
  made.clear();
}

/** A new, empty folder `<base>/<prefix>-XXXXXX`, deleted when this process exits. */
export function tempDir(prefix, base = tmpdir()) {
  if (!hooked) process.once('exit', removeTempDirs);
  hooked = true;
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, `${prefix}-`));
  made.add(dir);
  return dir;
}
