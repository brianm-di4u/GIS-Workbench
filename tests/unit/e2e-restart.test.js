import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Chromium on Linux can lose a file:// page's localStorage on a same-tab reload (#9), so a browser
// suite that starts the app again uses restart() from tests/e2e/helpers.js. The sidecar suites run
// on Windows only.
describe('browser suites start the app again with restart()', () => {
  it('no suite calls page.reload()', () => {
    const dir = join('tests', 'e2e');
    const hits = readdirSync(dir)
      .filter((f) => f.endsWith('.js') && f !== 'helpers.js')
      .flatMap((f) =>
        readFileSync(join(dir, f), 'utf8')
          .split('\n')
          .map((line, i) => [`${f}:${i + 1}`, line])
          .filter(([, line]) => /\.reload\(/.test(line)),
      )
      .map(([at]) => at);
    expect(hits).toEqual([]);
  });
});
