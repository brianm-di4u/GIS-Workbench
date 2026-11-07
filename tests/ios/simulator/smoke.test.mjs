// The first check on a macOS runner: Safari opens Lite at all. Everything else depends on this.

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { Safari, deviceFacts, note, shot } from './device.mjs';

let s;
before(async () => {
  s = await Safari.start();
});
after(() => s?.stop());

test('Safari in the iOS Simulator starts Lite', async () => {
  note('device', deviceFacts(s));
  await s.openLite();
  const f = await s.js(`() => ({ ua: navigator.userAgent, edition: document.documentElement.dataset.edition, secure: isSecureContext, problems: window.gisworkbench.runMode.problems, bootMs: window.gisworkbench.bootMs, viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, shell: !!document.querySelector('.m-shell') })`);
  note('smoke', f);
  await shot('smoke');
  assert.match(f.ua, /iPhone.*Version\/.*Mobile.*Safari/);
  assert.equal(f.edition, 'lite');
  assert.equal(f.shell, true);
});
