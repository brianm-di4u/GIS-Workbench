// R0–R2 Shoulds and Coulds closed in R3, shell and platform side: the context menu with its mini
// toolbar and cue-card tooltips (REQ-UI-06), Exploitation Fullscreen (REQ-UI-10), the
// Preferences tree with User and Common tabs and locks (REQ-UI-11) in the uniform dialog
// (REQ-UI-14), spell check in free text (REQ-UI-23), Ribbon customization (REQ-UI-24), the Job
// Queue (REQ-ARC-06), the Lite profile (REQ-ARC-15), the automation API and console
// (REQ-ARC-17), snapshots (REQ-ARC-19), feedback pages for the assistant (REQ-WB-14), streamed
// replies with Stop (REQ-AI-16), and every catalogued command has an implementation.
import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { openApp, openFiles } from './helpers.js';

test.describe.configure({ timeout: 180000 });
const A = resolve('fixtures/fx02/fx02_a.ntf');

test('REQ-UI-06 REQ-UI-10 REQ-UI-11 REQ-UI-14 REQ-UI-23 REQ-UI-24 context menu, fullscreen, preferences, spell check and ribbon customization', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [A]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 60000 });
  // UI-06: right-click → context menu and mini toolbar; ribbon tooltips carry the cue text.
  await frame.evaluate(() => {
    const el = window.gisworkbench.activePane().el;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 300, clientY: r.top + 250, button: 2 }));
  });
  await expect(frame.locator('[data-id="mini-toolbar"]')).toBeVisible();
  expect(await frame.locator('[data-id="mini-toolbar"] button').count()).toBeGreaterThanOrEqual(5);
  await expect(frame.locator('.menu-host .menu').first()).toContainText('Re-center Here');
  await page.keyboard.press('Escape');
  const tipText = await frame.evaluate(async () => {
    document.querySelector('[data-id="ribbon:tab:draw"]').click();
    await new Promise((r) => setTimeout(r, 50));
    const t = document.querySelector('.ribbon-body [data-id="cmd:men.medial"]')?.title;
    document.querySelector('[data-id="ribbon:tab:home"]').click();
    return t;
  });
  expect(tipText).toMatch(/Medial Axis — .*medial axis/i);
  // UI-10: Exploitation Fullscreen from a user gesture, with Keyboard Lock where offered.
  await frame.evaluate(() => window.gisworkbench.desktop.multiports[0].ribbon?.render?.());
  const fsOn = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const r = await app.commands.run('display.fullscreen').then(() => !!document.fullscreenElement, () => false);
    return { r, lockApi: !!navigator.keyboard?.lock };
  });
  if (!fsOn.r) {
    // Without transient activation the request is refused: drive it from a real click.
    await frame.evaluate(() => {
      const b = document.createElement('button');
      b.id = 'fs-test';
      b.textContent = 'fs';
      b.style.cssText = 'position:fixed;left:0;top:0;z-index:99999';
      b.onclick = () => window.gisworkbench.commands.run('display.fullscreen');
      document.body.appendChild(b);
    });
    await frame.locator('#fs-test').click();
  }
  await frame.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 10000 });
  expect(await frame.evaluate(() => window.gisworkbench.commands.checked('display.fullscreen'))).toBe(true);
  await frame.evaluate(() => document.exitFullscreen());
  await frame.waitForFunction(() => !document.fullscreenElement);
  // UI-11 / UI-14: the Preferences dialog.
  await frame.evaluate(() => void window.gisworkbench.commands.run('file.prefs'));
  const dlg = frame.locator('[data-id="dialog:prefs"]');
  await expect(dlg).toBeVisible();
  for (const b of ['Help', 'Reset', 'OK', 'Cancel', 'Apply']) await expect(dlg.locator('.dlg-buttons button', { hasText: new RegExp(`^${b}$`) })).toHaveCount(1);
  await expect(dlg.locator('[role="tree"] [role="treeitem"]')).toHaveCount(8); // All + 7 categories (Security Markings added in 1.3, REQ-SHL-03)
  await expect(dlg.locator('[data-tab="user"]')).toBeVisible();
  await expect(dlg.locator('[data-tab="common"]')).toBeVisible();
  await dlg.locator('[data-id="prefs-search"]').fill('sigma');
  await expect(dlg.locator('[data-id="prefs-table"] tbody tr')).toHaveCount(1);
  await dlg.locator('[data-id="prefs-search"]').fill('');
  await dlg.locator('[data-cat="Mensuration"]').click();
  await expect(dlg.locator('[data-id="prefs-table"] tbody tr')).toHaveCount(3);
  await dlg.locator('[data-cat="all"]').click();
  // Common tab: lock the analyst name to a site value.
  await dlg.locator('[data-tab="common"]').click();
  const analystCommon = dlg.locator('tr[data-k="analyst"] input.inp');
  await analystCommon.fill('Site Analyst');
  await analystCommon.dispatchEvent('change');
  await dlg.locator('tr[data-k="analyst"] [data-lock="analyst"]').check();
  await dlg.locator('.dlg-buttons button', { hasText: /^Apply$/ }).click();
  await dlg.locator('[data-tab="user"]').click();
  await expect(dlg.locator('tr[data-k="analyst"] input.inp')).toBeDisabled();
  expect(await dlg.locator('tr[data-k="analyst"] input.inp').getAttribute('spellcheck')).toBe('true');
  await dlg.locator('.dlg-buttons button', { hasText: /^Cancel$/ }).click();
  const prefs = await frame.evaluate(() => {
    const P = window.gisworkbench.prefs;
    const refused = P.set('analyst', 'someone else');
    const v = P.get('analyst');
    P.setCommon('analyst', undefined, { lock: false });
    P.set('analyst', 'me');
    return { refused, v, after: P.get('analyst'), locked: P.isLocked('analyst') };
  });
  expect(prefs).toEqual({ refused: false, v: 'Site Analyst', after: 'me', locked: false });
  // UI-23: free text checks spelling, code and data do not.
  const spell = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    app.commands.run('ai.assistant');
    await new Promise((r) => setTimeout(r, 300));
    const ta = document.querySelector('.ai-input');
    return { assistant: ta?.spellcheck, jump: document.querySelector('[data-id="cmd:nav.jumpbox"]')?.spellcheck ?? false };
  });
  expect(spell).toEqual({ assistant: true, jump: false });
  // UI-24: hide a group, add a custom tab, and open the dialog.
  const rib = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    app.setRibbonCustom({ hidden: ['home:Bookmarks'], tab: { label: 'Mine', items: ['nav.whole', 'men.point', 'gps.load'] } });
    const tab = document.querySelector('[data-id="ribbon:tab:custom"]');
    tab?.click();
    await new Promise((r) => setTimeout(r, 50));
    const inCustom = [...document.querySelectorAll('.ribbon-body [data-id^="cmd:"]')].map((e) => e.dataset.id);
    document.querySelector('[data-id="ribbon:tab:home"]').click();
    await new Promise((r) => setTimeout(r, 50));
    const groups = [...document.querySelectorAll('.ribbon-body .rgroup')].map((g) => g.getAttribute('aria-label'));
    app.setRibbonCustom(null);
    const groupsAfter = [...document.querySelectorAll('.ribbon-body .rgroup')].map((g) => g.getAttribute('aria-label'));
    return { label: tab?.textContent, inCustom, bookmarks: groups.includes('Bookmarks'), back: groupsAfter.includes('Bookmarks'), customGone: !document.querySelector('[data-id="ribbon:tab:custom"]') };
  });
  expect(rib).toEqual({ label: 'Mine', inCustom: ['cmd:nav.whole', 'cmd:men.point', 'cmd:gps.load'], bookmarks: false, back: true, customGone: true });
  await frame.evaluate(() => void window.gisworkbench.commands.run('ribbon.customize'));
  await expect(frame.locator('[data-id="dialog:ribbon-customize"]')).toBeVisible();
  expect(await frame.locator('[data-id="dialog:ribbon-customize"] [data-id^="rgrp:"]').count()).toBeGreaterThan(20);
  await frame.locator('[data-id="dialog:ribbon-customize"] .dlg-buttons button', { hasText: /^Cancel$/ }).click();
  expect(logs).toEqual([]);
});

test('REQ-ARC-06 REQ-ARC-15 REQ-ARC-17 REQ-ARC-19 job queue, Lite profile, automation API and console, snapshot round trip; every command is implemented', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [A]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 60000 });
  // Every catalogued command does something (no "planned" placeholders left).
  const unimpl = await frame.evaluate(() => window.gisworkbench.commands.list().filter((c) => !c.implemented).map((c) => c.id));
  expect(unimpl).toEqual([]);
  // ARC-06: jobs listed with progress and Cancel while running, then in the history.
  const jq = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    app.commands.run('dock.jobs');
    const l = [...app.layers.values()][0];
    const p = app.pool.run('window', { handle: l.handle, x0: 0, y0: 0, w: 2048, h: 2048, step: 1, bands: [0] }, { affinity: l.affinity, label: 'queue test window' });
    await new Promise((r) => setTimeout(r, 300));
    await p;
    await new Promise((r) => setTimeout(r, 400));
    const rows = [...document.querySelectorAll('table[aria-label="Job Queue"] tbody tr')].map((tr) => tr.textContent);
    return { seen: rows.some((t) => /queue test window/.test(t) && /done/.test(t)), header: [...document.querySelectorAll('table[aria-label="Job Queue"] th')].map((t) => t.textContent) };
  });
  expect(jq.seen).toBe(true);
  expect(jq.header).toEqual(['Job', 'State', 'Progress', 'Time (ms)', '']);
  // ARC-17: the API and the console (method + JSON; nothing is evaluated).
  const api = await frame.evaluate(async () => {
    const a = window.gisworkbench.api;
    const g = a.groundPoint({ x: 1024, y: 1024 });
    const q = a.imagePoint({ lat: g.lat, lon: g.lon, h: g.h });
    const id = a.createGraphic({ shape: 'marker', coordinates: [[g.lon, g.lat]], text: 'API marker' });
    const chain = a.setChain({ stretch: 'linear', brightness: 10 });
    const chip = await a.exportChip({ width: 400, height: 300 });
    const line = await a.runLine('groundPoint {"x": 10, "y": 20}');
    let bad = null;
    try {
      await a.runLine('alert(1)');
    } catch (e) {
      bad = e.message;
    }
    window.gisworkbench.commands.run('auto.console');
    await new Promise((r) => setTimeout(r, 200));
    const inp = document.querySelector('[data-id="auto-in"]');
    inp.value = 'layers';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await new Promise((r) => setTimeout(r, 200));
    return { back: Math.hypot(q.x - 1024, q.y - 1024), graphic: !!window.gisworkbench.store.get(id), chain, chip: chip.cornersGround?.length, line: Number.isFinite(line.lat), bad, out: document.querySelector('[data-id="auto-out"]').textContent, help: a.help().length };
  });
  expect(api.back).toBeLessThan(0.01);
  expect(api.graphic).toBe(true);
  expect(api.chain).toMatch(/linear/i);
  expect(api.chip).toBe(4);
  expect(api.line).toBe(true);
  expect(api.bad).toMatch(/no method|JSON/);
  expect(api.out).toMatch(/fx02_a/);
  expect(api.help).toBeGreaterThanOrEqual(10);
  // ARC-19: snapshot HTML → reopen → the image and the marker are back without relinking.
  const snap = await frame.evaluate(async () => {
    const r = await window.gisworkbench.snapshotHtml();
    return { html: r.html, files: r.files, skipped: r.skipped.length };
  });
  expect(snap.files).toBe(1);
  expect(snap.skipped).toBe(0);
  const dir = join(tmpdir(), 'gw-snapshot');
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'snapshot.html');
  writeFileSync(f, snap.html);
  const page2 = await page.context().newPage();
  const { frame: f2, logs: logs2 } = await openApp(page2, 'file', { htmlPath: f });
  await f2.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 60000 });
  const back = await f2.evaluate(() => ({ layers: [...window.gisworkbench.layers.values()].map((l) => l.info.fileName), marker: window.gisworkbench.store.all('graphic').some((g) => g.text === 'API marker'), info: window.gisworkbench.snapshotInfo?.files }));
  expect(back).toEqual({ layers: ['fx02_a.ntf'], marker: true, info: 1 });
  expect(logs2).toEqual([]);
  await page2.close();
  // ARC-15: the Lite file leaves out the lazy 3D, LiDAR, video and SAR modules, and says so.
  const liteFile = readFileSync('dist/gis-workbench-lite.html', 'utf8');
  const lite = gunzipSync(Buffer.from(/id="gw-payload">([^<]*)</.exec(liteFile)[1], 'base64')).toString('utf8');
  const std = readFileSync('dist/gis-workbench.html', 'utf8');
  const man = (h) => JSON.parse(/<script type="application\/json" id="build-manifest">([\s\S]*?)<\/script>/.exec(h)[1]);
  const lm = man(lite);
  const sm = man(std);
  expect(lm.build.profile).toBe('lite');
  expect(lm.omitted).toEqual(['js-three', 'js-mpegts', 'wasm-pointcloud', 'js-worker-pointcloud', 'wasm-sar']);
  for (const b of lm.omitted) {
    expect(sm.blocks[b]).toBeTruthy();
    expect(lm.blocks[b]).toBeUndefined();
    expect(lite.includes(`id="blk-${b}"`)).toBe(false);
  }
  expect(liteFile.length).toBeLessThan(std.length * 0.85);
  const page3 = await page.context().newPage();
  const { frame: f3, logs: logs3 } = await openApp(page3, 'file', { htmlPath: resolve('dist/gis-workbench-lite.html') });
  const why = await f3.evaluate(async () => {
    try {
      await globalThis.__gw.text('js-three');
      return 'loaded';
    } catch (e) {
      return e.message;
    }
  });
  expect(why).toMatch(/3D module, which GIS Workbench Lite leaves out/);
  expect(logs3).toEqual([]);
  await page3.close();
  expect(logs).toEqual([]);
});

test('REQ-WB-14 REQ-AI-16 feedback pages are a read-only tool without images; replies stream and Stop cancels one', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const reg = app.ai.registry;
    const tool = reg.tools.get('gw_feedback_pages');
    const res = await reg.call('gw_feedback_pages', {});
    const resources = [...reg.resources.keys()];
    // Streaming with the mock provider: the transcript grows while the reply arrives.
    const conn = { id: 'conn_mock', name: 'Mock', provider: 'mock', model: 'mock-model' };
    const asst = app.ai.assistant;
    asst.consented = true;
    const mock = app.ai.mock;
    mock.delayMs = 5;
    const long = 'A long streamed answer. '.repeat(30);
    mock.script.push({ id: 'm1', role: 'assistant', model: 'mock-model', stop_reason: 'end_turn', content: [{ type: 'text', text: long }], usage: {} });
    const seen = [];
    const off = asst.on('change', () => {
      const live = asst.transcript.find((t) => t.streaming);
      if (live) seen.push(live.text.length);
    });
    await asst.ask('stream please', { provider: mock, conn });
    off?.();
    const final = asst.transcript.at(-1);
    // Stop part-way.
    mock.delayMs = 20;
    mock.script.push({ id: 'm2', role: 'assistant', model: 'mock-model', stop_reason: 'end_turn', content: [{ type: 'text', text: long }], usage: {} });
    const p = asst.ask('again', { provider: mock, conn });
    await new Promise((res) => setTimeout(res, 150));
    asst.stop();
    await p;
    const tail = asst.transcript.slice(-2).map((t) => ({ who: t.who, partial: !!t.partial, text: t.text.slice(0, 20) }));
    return { readOnly: tool?.readOnly, res: JSON.parse(res.content), resources, growth: seen.length, monotone: seen.every((v, i) => !i || v >= seen[i - 1]), final: final.text === long, streamingLeft: asst.transcript.some((t) => t.streaming), tail, messages: asst.messages.length };
  });
  expect(r.readOnly).toBe(true);
  expect(Array.isArray(r.res.pages)).toBe(true);
  expect(JSON.stringify(r.res)).not.toMatch(/data:image/);
  expect(r.resources.some((u) => /feedback/.test(u))).toBe(true);
  expect(r.growth).toBeGreaterThan(5);
  expect(r.monotone).toBe(true);
  expect(r.final).toBe(true);
  expect(r.streamingLeft).toBe(false);
  expect(r.tail[0]).toMatchObject({ who: 'ai', partial: true });
  expect(r.tail[1].text).toMatch(/Stopped/);
  // The stopped question was rolled back: only the first exchange remains.
  expect(r.messages).toBe(2);
  expect(logs).toEqual([]);
});
