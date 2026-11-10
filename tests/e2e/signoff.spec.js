// 2.7.0 I5 performance sign-off on the reference machine (#64; REQ-PRF-01, REQ-PRF-03; SCN-74).
// A measurement, not a gate: it runs only with GW_SIGNOFF set, one worker, on an idle machine:
//
//   GW_SIGNOFF=dry   records the numbers and asserts nothing about time (try the harness out)
//   GW_SIGNOFF=final also asserts the targets, and fails if the machine was not idle
//
//   npx playwright test --project=chrome tests/e2e/signoff.spec.js --workers=1
//
// GW_SIGNOFF_RUNS (default 7) cold starts per build and CPU rate; GW_SIGNOFF_MAX_BUSY (default 10)
// the most CPU use, in per cent, that still counts as idle; GW_SIGNOFF_OUT (default reports) where
// signoff-<build>.json and .md go.
//
// Procedure for the sign-off:
// 1. Main has #62's lazy pass. Check out main at the release candidate and `npm run build`.
// 2. Close other apps; on battery power, plug in. The run takes the machine lock, so no `verify`
//    overlaps it, and samples CPU use before each batch.
// 3. Run it with GW_SIGNOFF=final. Each start is in a new browser context (no cache, no storage),
//    with no stored preferences, so each build opens as a first start with its shipped defaults.
//    The figure is the median of the runs; min and max are kept.
// 4. Copy signoff-<build>.md into the 2.7.0 validation record (Docs/validation/2.7) against
//    REQ-PRF-01, REQ-PRF-03 and SCN-74, with the machine line it prints.
import { test, expect } from "@playwright/test";
import { cpus, totalmem, release } from "node:os";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DIST, DIST_DIR, openApp, openFiles, sample } from "./helpers.js";
import { acquire } from "../../.pipeline/lib/machine-lock.mjs";

const MODE = process.env.GW_SIGNOFF;
const FINAL = MODE === "final";
const RUNS = Number(process.env.GW_SIGNOFF_RUNS ?? 7);
const MAX_BUSY = Number(process.env.GW_SIGNOFF_MAX_BUSY ?? 10);
const OUT = resolve(process.env.GW_SIGNOFF_OUT ?? "reports");
const LITE = join(DIST_DIR, "gis-workbench-lite.html");
const VIEW = { viewport: { width: 1440, height: 900 } };
const MiB = 1024 * 1024;

// SDP-2.7 §6 budgets and §4.8 goals. `limit` fails the sign-off; `target` is reported against.
const SIZE_BUDGETS = [
  { id: "Full HTML", get: (s) => s.total, limit: 18_000_000 },
  {
    id: "Eager part (Full)",
    get: (s) => s.eager,
    limit: 6 * MiB,
    warn: 3 * MiB,
    target: 2_000_000,
  },
  { id: "Lite HTML", get: (s) => s.lite, limit: 5.5 * MiB },
  {
    id: "Eager part (Lite)",
    get: (s) => s.liteEager,
    limit: 6 * MiB,
    warn: 3 * MiB,
  },
  { id: "All WASM (gzip)", get: (s) => s.rustTotalGzip, limit: 4 * MiB },
];
const START_MS = 1500; // REQ-PRF-01 and SCN-74: interactive within 1.5 s of navigation, at 1× and 4×
const FIRST_TILE_MS = 1000; // REQ-PRF-03

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2
    ? s[(s.length - 1) / 2]
    : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const stats = (a) => ({
  runs: a,
  median: median(a),
  min: Math.min(...a),
  max: Math.max(...a),
});

/** Per cent of CPU time not idle across all cores over `ms`. */
async function busy(ms = 5000) {
  const snap = () =>
    cpus().reduce(
      (t, c) => ({
        idle: t.idle + c.times.idle,
        all: t.all + Object.values(c.times).reduce((x, y) => x + y, 0),
      }),
      { idle: 0, all: 0 },
    );
  const a = snap();
  await new Promise((r) => setTimeout(r, ms));
  const b = snap();
  return Math.round(1000 * (1 - (b.idle - a.idle) / (b.all - a.all))) / 10;
}

const result = {
  mode: MODE,
  started: new Date().toISOString(),
  runs: RUNS,
  machine: {},
  idle: [],
  sizes: [],
  start: {},
  firstTile: {},
};
let release_ = () => {};

test.describe.configure({ mode: "serial", timeout: 900_000 });

test.beforeAll(async ({ browser }) => {
  if (!MODE) return;
  // The machine lock keeps every `verify` run off the machine while this measures. Waiting for it
  // has no time limit: other runs may hold it for an hour.
  test.setTimeout(0);
  release_ = await acquire({ level: "signoff" });
  const report = JSON.parse(
    readFileSync(join(DIST_DIR, "build-report.json"), "utf8"),
  );
  result.build = report.build;
  result.machine = {
    cpu: cpus()[0]?.model,
    cores: cpus().length,
    memGiB: Math.round(totalmem() / 2 ** 30),
    os: `${process.platform} ${release()}`,
    browser: browser.version(),
    dist: DIST,
  };
});

test.afterAll(async () => {
  if (!MODE) return;
  release_();
  result.finished = new Date().toISOString();
  mkdirSync(OUT, { recursive: true });
  const id = String(result.build?.id ?? result.build?.hash ?? "build").slice(
    0,
    12,
  );
  writeFileSync(
    join(OUT, `signoff-${id}.json`),
    JSON.stringify(result, null, 1),
  );
  writeFileSync(join(OUT, `signoff-${id}.md`), markdown(result));
});

/** Waits for an idle machine (one 5 s sample); `final` fails if it never is. */
async function idle(label) {
  let pct = await busy();
  for (let i = 1; i < 6 && pct > MAX_BUSY; i++) pct = await busy();
  result.idle.push({ before: label, busyPct: pct, idle: pct <= MAX_BUSY });
  if (FINAL)
    expect(
      pct,
      `${label}: the machine is ${pct} % busy; a sign-off needs ≤ ${MAX_BUSY} %`,
    ).toBeLessThanOrEqual(MAX_BUSY);
}

test("SDP-2.7 §6 sizes against their budgets, Full and Lite", async () => {
  test.skip(!MODE, "a measurement: GW_SIGNOFF=dry or final, one worker");
  const s = JSON.parse(
    readFileSync(join(DIST_DIR, "build-report.json"), "utf8"),
  ).sizes;
  expect(s.total).toBe(statSync(DIST).size);
  for (const b of SIZE_BUDGETS)
    result.sizes.push({
      id: b.id,
      bytes: b.get(s),
      limit: b.limit,
      warn: b.warn ?? null,
      target: b.target ?? null,
    });
  // Each bundle may run 10 % over its budget, as the build gate allows (build/gates.mjs, REQ-RUST-08).
  for (const [name, r] of Object.entries(s.rust ?? {}))
    result.sizes.push({
      id: `WASM ${name} (gzip)`,
      bytes: r.gzip,
      limit: Math.floor(r.budget * 1.1),
      warn: r.budget,
      target: null,
    });
  for (const r of result.sizes)
    expect(r.bytes, r.id).toBeLessThanOrEqual(r.limit);
});

// A first start: no stored preferences, so each build opens with its shipped defaults.
for (const [name, html] of [
  ["Full", DIST],
  ["Lite", LITE],
]) {
  test(`SCN-74 REQ-PRF-01 ${name}: cold start from navigation at 1× and 4× CPU`, async ({
    browser,
  }) => {
    test.skip(!MODE, "a measurement: GW_SIGNOFF=dry or final, one worker");
    test.skip(!existsSync(html), `${html} is not built`);
    for (const rate of [1, 4]) {
      await idle(`${name} ${rate}×`);
      const total = [];
      const marks = [];
      for (let i = 0; i < RUNS; i++) {
        // A new context per run: no HTTP or code cache and no storage from the previous start.
        const ctx = await browser.newContext(VIEW);
        const page = await ctx.newPage();
        const cdp = await ctx.newCDPSession(page);
        await cdp.send("Emulation.setCPUThrottlingRate", { rate });
        const { frame } = await openApp(page, "file", {
          htmlPath: html,
          prefs: null,
        });
        const r = await frame.evaluate(() => ({
          total: Math.round(window.__gw.bootStart + window.gisworkbench.bootMs),
          marks: window.gisworkbench.bootMarks ?? null,
        }));
        total.push(r.total);
        marks.push(r.marks);
        await ctx.close();
      }
      result.start[`${name} ${rate}×`] = {
        ...stats(total),
        marks: marks[total.indexOf(median(total))] ?? marks[0],
      };
      if (FINAL)
        expect(
          median(total),
          `${name} at ${rate}× CPU, median of ${RUNS}: ${total}`,
        ).toBeLessThan(START_MS);
    }
  });
}

test("REQ-PRF-03 first tile of a local NITF and a COG, cold", async ({
  browser,
}) => {
  test.skip(!MODE, "a measurement: GW_SIGNOFF=dry or final, one worker");
  const files = [
    ["FX-01 NITF 4096² (16 MiB, one block)", resolve("fixtures/fx01/fx01.ntf")],
    ["WV3 COG", sample("geotiff-wv3-rpc-cog", "wv3_a_cog.tif")],
  ].filter(([, f]) => existsSync(f));
  test.skip(!files.length, "neither FX-01 nor the WV3 COG is on this machine");
  await idle("first tile");
  for (const [name, file] of files) {
    const ms = [];
    for (let i = 0; i < RUNS; i++) {
      const ctx = await browser.newContext(VIEW);
      const { frame } = await openApp(await ctx.newPage(), "file");
      const t0 = Date.now();
      await openFiles(frame, [file]);
      await frame.waitForFunction(
        () =>
          [...window.gisworkbench.layers.values()].some(
            (l) => l.lutTex && l.tiles.gpu.size > 0,
          ),
        null,
        { timeout: 15_000, polling: 10 },
      );
      ms.push(Date.now() - t0);
      await ctx.close();
    }
    result.firstTile[name] = stats(ms);
    if (FINAL)
      expect(median(ms), `${name}, median of ${RUNS}: ${ms}`).toBeLessThan(
        FIRST_TILE_MS,
      );
  }
});

function markdown(r) {
  const kb = (b) => (b == null ? "" : `${b.toLocaleString("en")} B`);
  const lines = [
    `# Performance sign-off (${r.mode}), ${r.started}`,
    "",
    `Build ${JSON.stringify(r.build)}. ${r.machine.cpu}, ${r.machine.cores} threads, ${r.machine.memGiB} GiB, ${r.machine.os}, Chrome ${r.machine.browser}.`,
    `Idle before each batch (≤ ${MAX_BUSY} % busy): ${r.idle.map((i) => `${i.before} ${i.busyPct} %`).join("; ")}.`,
    "",
    "## Start-up from navigation (ms)",
    "| Build and CPU | Median | Min | Max | Target |",
    "|---|---|---|---|---|",
    ...Object.entries(r.start).map(
      ([k, v]) =>
        `| ${k} | ${v.median} | ${v.min} | ${v.max} | < ${START_MS} |`,
    ),
    "",
    "## First tile (ms, REQ-PRF-03)",
    "| File | Median | Min | Max | Target |",
    "|---|---|---|---|---|",
    ...Object.entries(r.firstTile).map(
      ([k, v]) =>
        `| ${k} | ${v.median} | ${v.min} | ${v.max} | < ${FIRST_TILE_MS} |`,
    ),
    "",
    "## Sizes (SDP-2.7 §6)",
    "| Budget | Measured | Limit | Warn | Target |",
    "|---|---|---|---|---|",
    ...r.sizes.map(
      (s) =>
        `| ${s.id} | ${kb(s.bytes)} | ${kb(s.limit)} | ${kb(s.warn)} | ${kb(s.target)} |`,
    ),
    "",
  ];
  return lines.join("\n");
}
