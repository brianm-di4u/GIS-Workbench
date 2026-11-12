// Scale (SDP-2.1 §7.3, S-42 "10 GB output read by range", REQ-SDC-07): the COG that
// scale-hamilton.mjs made from the 10.7 GB Hamilton County MrSID is opened in the app in place from
// the sidecar that made it — by HTTP Range, never downloaded — and the first view is drawn.
// Skipped until E:/gwb-sidecar-deps/scale/scale.json reports a finished job.
import { test, expect } from '@playwright/test';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openApp } from '../helpers.js';
import { DIST_DIR, startSidecar, stopSidecar } from './harness.js';

const SCALE = 'E:/gwb-sidecar-deps/scale/scale.json';
const rep = existsSync(SCALE) ? JSON.parse(readFileSync(SCALE, 'utf8')) : null;

test('Scale: the Hamilton 10.7 GB MrSID → COG opens in place by range from the sidecar', async ({ page }) => {
  test.skip(rep?.last?.state !== 'succeeded', 'the Hamilton conversion has not finished (scale-hamilton.mjs)');
  test.setTimeout(300_000);
  const out = rep.last.outputs[0];
  // The 19.4 GB COG must still be on disk (reports/sidecar/scale-range-read.json keeps the last result).
  const recs = JSON.parse(readFileSync(join(dirname(SCALE), 'data', 'files.json'), 'utf8'));
  const path = recs.find((f) => f.id === out.id || f.name === out.name)?.path;
  test.skip(!path || !existsSync(path), 'the Hamilton COG is no longer on disk: run scale-hamilton.mjs again (about 5.5 h)');
  // The sidecar that made the COG serves it; start it again from its data folder if it has stopped.
  const up = await fetch(`http://127.0.0.1:${rep.port}/v1/caps`, {
    headers: { Origin: 'null', Authorization: `Bearer ${rep.token}` },
  })
    .then((r) => r.ok)
    .catch(() => false);
  const own = up
    ? null
    : await startSidecar({
        dataDir: join(dirname(SCALE), 'data'),
        port: rep.port,
        keep: true,
        token: rep.token,
      });
  test.info().attach('sidecar', {
    body: own ? 'restarted from its data folder' : 'already running',
  });
  try {
    const { frame, csp } = await openApp(page, 'file', {
      htmlPath: join(DIST_DIR, 'gis-workbench.html'),
      prefs: { welcomeDone: true },
    });
    const t0 = Date.now();
    const r = await frame.evaluate(
      async ({ token, port, out }) => {
        const app = window.gisworkbench;
        const c = app.sidecar.client;
        c.base = `http://127.0.0.1:${port}`;
        c.token = token;
        await app.sidecar.refresh();
        const t = performance.now();
        await app.sidecar.openOutput(out);
        const opened = performance.now() - t;
        // Wait for the first tiles of the whole-scene view.
        await new Promise((r) => setTimeout(r, 500));
        for (let i = 0; i < 600 && [...(app.pool?.jobs?.values() ?? [])].some((j) => j.op === 'tile'); i++) await new Promise((r) => setTimeout(r, 100));
        const net = app.netlog.entries.filter((e) => e.loopback && e.path.startsWith('/v1/files/'));
        const l = [...app.layers.values()].at(-1);
        return {
          opened_ms: Math.round(opened),
          w: l?.width,
          h: l?.height,
          levels: l?.levels?.length ?? l?.info?.levels,
          ranges: net.length,
          statuses: [...new Set(net.map((e) => e.status))],
          bytes: net.reduce((a, e) => a + (Number(e.received) || 0), 0),
        };
      },
      { token: rep.token, port: rep.port, out },
    );
    r.total_ms = Date.now() - t0;
    r.output_bytes = out.size;
    mkdirSync(resolve('reports', 'sidecar'), { recursive: true });
    writeFileSync(
      resolve('reports', 'sidecar', 'scale-range-read.json'),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          conversion_seconds: rep.seconds,
          input_bytes: rep.input_bytes,
          ...r,
        },
        null,
        2,
      ),
    );
    expect(r.w).toBe(340000);
    expect(r.h).toBe(220000);
    expect(r.statuses).toEqual([206]);
    expect(r.bytes).toBeLessThan(out.size / 20); // read in place: a small part of the file
    expect(await csp()).toEqual([]);
  } finally {
    if (own) stopSidecar(own.pid);
  }
});
