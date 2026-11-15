// A fixed delay is the quick fix for an ordering problem: wait 200 ms and hope the other thing has
// finished. Each one is copied by the next change that meets the same problem, and each makes the
// app slower and its tests flaky. This counts the timer calls in each module of app/src. The counts
// below are what was there before the check existed. A module may not gain one, and when it loses
// one its number goes down here, so the list only shrinks. core/util.js is where timing helpers
// such as debounce() live, so it is not counted.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

const SRC = 'app/src';
const HELPERS = 'core/util.js';
const TIMER = /\b(?:setTimeout|setInterval|requestAnimationFrame|requestIdleCallback)\(/g;
const BEFORE = {
  'ai/providers.js': 1,
  'automation/api-v2-core.js': 1,
  'connectors/auth.js': 1,
  'features/ai-local.js': 1,
  'features/basemaps.js': 1,
  'features/catalog.js': 2,
  'features/change.js': 1,
  'features/compare.js': 1,
  'features/convert.js': 1,
  'features/devices.js': 2,
  'features/extract.js': 1,
  'features/files.js': 1,
  'features/fmv.js': 4,
  'features/globe.js': 1,
  'features/hls-player.js': 3,
  'features/hud.js': 4,
  'features/measure.js': 1,
  'features/media.js': 2,
  'features/mie.js': 2,
  'features/ootf.js': 1,
  'features/panels.js': 3,
  'features/pansharpen.js': 1,
  'features/readout.js': 1,
  'features/sar.js': 1,
  'features/sarstereo.js': 1,
  'features/scene3d.js': 2,
  'features/sfm.js': 1,
  'features/signin.js': 2,
  'features/spectral.js': 1,
  'features/stereo-out.js': 2,
  'features/stereo.js': 1,
  'features/terrain-extract.js': 1,
  'features/timeseries-tools.js': 2,
  'feedback/capture.js': 3,
  'feedback/whiteboard.js': 2,
  'formats/open.js': 3,
  'host/runmode.js': 2,
  'input/keys.js': 1,
  'main.js': 1,
  'media/webm.js': 1,
  'mobile/gestures.js': 1,
  'mobile/shell.js': 3,
  'render/i3s-layer.js': 1,
  'render/offscreen.js': 1,
  'render/renderer.js': 3,
  'render/tiles3d.js': 1,
  'render/view3d.js': 5,
  'shell/activity.js': 4,
  'shell/dialogs.js': 1,
  'shell/menu.js': 1,
  'shell/mpeg1media.js': 2,
  'shell/pane.js': 2,
  'shell/statusbar.js': 3,
  'shell/toast.js': 2,
  'shell/tooltip.js': 2,
  'shell/videoview.js': 4,
  'shell2/appshell.js': 1,
  'sidecar/client.js': 2,
  'sidecar/feature.js': 1,
  'sidecar/native-ui.js': 1,
  'sidecar/pro-sync.js': 2,
  'sidecar/relay-host.js': 1,
  'storage/files.js': 1,
  'storage/journal.js': 1,
  'svc/services.js': 1,
  'workers/decode/mie-cache.js': 1,
  'workers/kinds/analysis.worker.js': 4,
  'workers/kinds/decode.worker.js': 1,
  'workers/pool.js': 4,
};

/** How many timer calls a module's text makes. */
export const timerCalls = (text) => (text.match(TIMER) ?? []).length;

/** What changed against the recorded counts: modules that gained a timer, and modules whose number should come down. */
export function compare(counts, before) {
  const names = [...new Set([...Object.keys(counts), ...Object.keys(before)])].sort();
  const row = (p) => `${p}: ${before[p] ?? 0} before, ${counts[p] ?? 0} now`;
  return {
    added: names.filter((p) => (counts[p] ?? 0) > (before[p] ?? 0)).map(row),
    removed: names.filter((p) => (counts[p] ?? 0) < (before[p] ?? 0)).map(row),
  };
}

const walk = (dir) => readdirSync(`${SRC}/${dir}`, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.m?js$/.test(e.name) ? [`${dir}/${e.name}`] : []));
const modules = readdirSync(SRC, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(e.name) : /\.m?js$/.test(e.name) ? [e.name] : []));

describe('the timer count', () => {
  it('counts each kind of timer call, and not a name that only contains one', () => {
    expect(timerCalls('setTimeout(f, 1); requestAnimationFrame(g); self.setInterval(h, 2); requestIdleCallback(i);')).toBe(4);
    expect(timerCalls('clearTimeout(t); cancelAnimationFrame(r); mySetTimeout(f); const setTimeout = 1;')).toBe(0);
  });

  it('reports a module that gained a timer and one that lost a timer', () => {
    expect(compare({ 'a.js': 2, 'b.js': 1, 'c.js': 1 }, { 'a.js': 1, 'b.js': 1, 'd.js': 3 })).toEqual({
      added: ['a.js: 1 before, 2 now', 'c.js: 0 before, 1 now'],
      removed: ['d.js: 3 before, 0 now'],
    });
  });
});

describe('timers in app/src', () => {
  const counts = {};
  for (const p of modules) {
    const n = p === HELPERS ? 0 : timerCalls(readFileSync(`${SRC}/${p}`, 'utf8'));
    if (n) counts[p] = n;
  }
  const { added, removed } = compare(counts, BEFORE);

  it('no module gains a timer call', () => {
    expect(modules.length).toBeGreaterThan(300);
    expect(added, 'a new timer call: await the event or promise the code is waiting for instead of a delay. To coalesce calls use debounce() from core/util.js, and put a new timing helper there').toEqual([]);
  });

  it('a module that lost a timer call has its number lowered', () => {
    expect(removed, 'fewer timer calls than recorded: lower these numbers in BEFORE, or take the line out at zero').toEqual([]);
  });
});
