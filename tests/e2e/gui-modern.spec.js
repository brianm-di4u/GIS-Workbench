// GUI campaign sweep of the Modern layout, the 2.0 default (docs/validation/GUI-findings.md,
// GUI-028 onwards), on the built Standard, Lite and Air-gapped files through real pointer and
// keyboard input:
//   - every command through the Ctrl+K palette, in every data state (each state sweeps the
//     commands that state enables), with the buttons of every dialog it opens;
//   - the app bar, its main and Help menus, the workspace chip, theme and settings;
//   - the navigation rail and its Products menu; the status bar;
//   - the contextual pill and the radial menu in every state;
//   - every dock panel: open, tiled beside the imagery (never over it), every control in it, close;
//   - the cursor shortcuts (flicker, swipe, quick chip, patrol, paste-to-pan);
//   - the first-run welcome card;
//   - the chrome at 1920, 1440, 1280 and 1024 px wide.
// Fail criteria are those of gui-sweep.spec.js (gui-lib.js) plus controls without a name.
//   GW_SWEEP_BUILDS=full,lite,airgap  GW_SWEEP_STATES=s0-empty,s1-image  (defaults: all)

import { test, expect } from '@playwright/test';
import { STATES, SEPARATE, ENDS_MODE, boot, enterState, observe, markNow, settle as settleAny, report, progress, reportDir } from './gui-lib.js';

test.describe.configure({ mode: 'parallel', timeout: 1_800_000 });
test.use({ actionTimeout: 5_000 });

const OUT = reportDir('gui2');
const MODERN = { layout: 'modern', welcomeDone: true, persona: 'explorer' };
const settle = (page) => settleAny(page, { layout: 'modern' });

/** Dialog buttons the sweep does not press: they end the state the rest of the sweep needs. */
const KEEP_STATE = /^(Remove|Delete|Delete all|Clear|Clear all|Close project|New project|Reset all|Discard|Don’t save|Quit)\b/i;
/** Long or external actions run from a dialog button: they have their own feature tests. */
const SLOW = /^(Run|Start|Download|Fetch|Install|Train|Benchmark|Record)\b/i;

const CTL = 'button, select, input[type="checkbox"], input[type="radio"]';

const builds = (process.env.GW_SWEEP_BUILDS ?? 'full,lite,airgap').split(',');
const wanted = process.env.GW_SWEEP_STATES?.split(',');

async function enabledSet(frame) {
  return frame.evaluate(() => {
    const C = window.gisworkbench.commands;
    return C.list()
      .filter((c) => c.implemented && !C.liteGap(c.id) && C.enabled(c.id))
      .map((c) => c.id);
  });
}

async function paneCentre(page) {
  const b = await page.locator('section.multiport .pane').first().boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 + 30 };
}

/** Open the palette with Ctrl+K and find a command by its label (falling back to its id). */
async function paletteFind(page, cmd) {
  const sel = `[data-id="palette:cmd:${cmd.id}"]`;
  for (const q of [cmd.label.replace(/…$/, ''), cmd.id]) {
    if (!(await page.locator('[data-id="palette"]').count())) {
      await page.locator('section.multiport .pane').first().focus().catch(() => {});
      await page.keyboard.press('Control+k');
    }
    const input = page.locator('[data-id="palette:input"]');
    await input.fill(q);
    await page.waitForTimeout(60);
    if (await page.locator(sel).count()) return { loc: page.locator(sel), byLabel: q !== cmd.id };
  }
  return { loc: null, byLabel: false };
}

/** Press every button of the dialog (or docked tool panel) `run` opens, reopening it each time. */
async function sweepDialogButtons(page, app, build, open, dlgId, rows, tab) {
  const btnSel = `.dlg[role="dialog"][data-id="${dlgId}"] button, .tool-panel[data-id="${dlgId}"] button`;
  await open();
  await page.waitForTimeout(300);
  const labels = await page.locator(btnSel).evaluateAll((bs) => bs.filter((b) => b.getClientRects().length && !b.disabled && !b.classList.contains('dlg-x')).map((b) => b.textContent.trim()).filter(Boolean));
  await settle(page);
  for (const label of [...new Set(labels)]) {
    if (KEEP_STATE.test(label) || SLOW.test(label)) continue;
    const mark = await markNow(page, app);
    const problems = [];
    await open();
    await page.waitForTimeout(250);
    const b = page.locator(btnSel).filter({ hasText: label }).first();
    let outcome = 'clicked';
    try {
      // A toggle command (CLAHE on/off…) may switch its effect off instead of reopening.
      if (await b.count()) await b.click();
      else outcome = 'not reopened (toggle)';
    } catch (e) {
      problems.push(`click: ${e.message.split('\n')[0]}`);
    }
    const s = await settle(page);
    const o = await observe(page, app, mark, build);
    problems.push(...s.problems, ...o.problems);
    rows.push({ tab, id: `${dlgId} ▸ ${label}`, outcome, dialogs: s.dialogs, toasts: o.toasts, problems });
  }
}

for (const build of builds) {
  test.describe(`GUI modern ${build}`, () => {
    for (const st of STATES.filter((s) => !wanted || wanted.includes(s.id))) {
      test(`GUI modern palette ${build} ${st.id}: every command this state enables runs from Ctrl+K`, async ({ page }, info) => {
        test.skip(build === 'lite' && st.lite === 'skip', 'point clouds need the LiDAR module Lite leaves out');
        // The commands an empty session already enables are swept in s0 only.
        let app = await boot(page, build, { prefs: MODERN });
        const base = new Set(await enabledSet(app.frame));
        const all = await app.frame.evaluate(() => window.gisworkbench.commands.list().filter((c) => c.implemented).map((c) => ({ id: c.id, label: c.label })));
        app = await enterState(page, build, st, { prefs: MODERN });
        const now = new Set(await enabledSet(app.frame));
        let cmds = all.filter((c) => (st.id === 's0-empty' ? true : now.has(c.id) && !base.has(c.id)) && !SEPARATE.has(c.id));
        cmds.sort((a, b) => ENDS_MODE.test(a.id) - ENDS_MODE.test(b.id));
        const rows = [];
        const dialogsSwept = new Set();
        // Coordinates, URLs and layers in the palette.
        if (st.id === 's1-image') {
          for (const [q, kind] of [['34.05 -117.25', 'coord'], ['https://example.com/x.tif', 'url'], ['fx01', 'layer']]) {
            await page.keyboard.press('Control+k');
            await page.locator('[data-id="palette:input"]').fill(q);
            await page.waitForTimeout(150);
            const n = await page.locator(`[data-id^="palette:${kind}:"]`).count();
            rows.push({ tab: 'palette', id: `query "${q}"`, outcome: `${n} ${kind}`, problems: n ? [] : [`no ${kind} result`] });
            await page.keyboard.press('Escape');
          }
        }
        for (const c of cmds) {
          const mark = await markNow(page, app);
          const problems = [];
          let outcome;
          const { loc, byLabel } = await paletteFind(page, c);
          if (!loc) {
            outcome = 'not found';
            problems.push('the palette does not list this command');
            await page.keyboard.press('Escape');
          } else {
            const off = (await loc.getAttribute('aria-disabled')) === 'true';
            if (off) {
              const why = (await loc.locator('.pal-detail').textContent()) ?? '';
              outcome = `not now: ${why.replace(/^Not now: /, '')}`;
              if (!/^Not now: \S/.test(why)) problems.push('a disabled command gives no reason');
              await page.keyboard.press('Escape');
            } else {
              // Heavy redraws on software WebGL (CLAHE, sharpening: GUI-027) keep the page busy for
              // seconds after a click: do not wait on the page here, settle() does.
              await loc.click({ noWaitAfter: true, timeout: 30_000 });
              outcome = 'ran';
            }
            if (!byLabel) outcome += ' (found by id only)';
          }
          const s = await settle(page);
          const o = await observe(page, app, mark, build);
          problems.push(...s.problems, ...o.problems);
          rows.push({ tab: 'palette', id: c.id, outcome, dialogs: s.dialogs, toasts: o.toasts, problems });
          progress(OUT, `${build} ${st.id} palette ${c.id} ${outcome} ${problems.length}`);
          // Every button of each dialog the command opened, once per state.
          for (const d of s.dialogs.filter((d) => d.startsWith('dialog:') && !dialogsSwept.has(d))) {
            dialogsSwept.add(d);
            if (ENDS_MODE.test(c.id)) continue;
            await sweepDialogButtons(page, app, build, () => app.frame.evaluate((id) => { window.gisworkbench.commands.run(id); }, c.id), d, rows, `dialog of ${c.id}`);
          }
          // A command that ended the state (closed the image, the video…) reloads it.
          if (st.files.length && !(await app.frame.evaluate(() => window.gisworkbench.layers.size || window.gisworkbench.store.all('vlayer').length || window.gisworkbench.store.all('pointcloud').length || window.gisworkbench.fmv?.clips?.size))) app = await enterState(page, build, st, { prefs: MODERN });
        }
        const found = rows.filter((r) => r.tab === 'palette' && r.outcome !== 'not found').length;
        info.annotations.push({ type: 'swept', description: `${cmds.length} commands, ${found} found, ${dialogsSwept.size} dialogs` });
        const bad = report(OUT, `palette-${build}-${info.project.name}-${st.id}`, rows);
        expect(bad, `${rows.length} actions`).toEqual([]);
      });

      test(`GUI modern pill and radial ${build} ${st.id}: every button responds`, async ({ page }, info) => {
        test.skip(build === 'lite' && st.lite === 'skip', 'point clouds need the LiDAR module Lite leaves out');
        let app = await enterState(page, build, st, { prefs: MODERN });
        const rows = [];
        const pillIds = await page.locator('[data-id="pill"]:not([hidden]) [data-id]').evaluateAll((bs) => bs.map((b) => b.dataset.id));
        if (st.files.length && st.id !== 's9-vector' && !pillIds.length) rows.push({ tab: 'pill', id: '(pill)', problems: ['no contextual pill over the data'] });
        for (const did of pillIds.sort((a, b) => ENDS_MODE.test(a.slice(4)) - ENDS_MODE.test(b.slice(4)))) {
          const mark = await markNow(page, app);
          const b = page.locator(`[data-id="pill"] [data-id="${did}"]`);
          let outcome = 'gone';
          if (await b.count()) {
            if (await b.isDisabled()) outcome = 'disabled';
            else {
              await b.click();
              outcome = 'clicked';
            }
          }
          const s = await settle(page);
          const o = await observe(page, app, mark, build);
          rows.push({ tab: 'pill', id: did, outcome, dialogs: s.dialogs, toasts: o.toasts, problems: [...s.problems, ...o.problems] });
        }
        // Radial menu: tap Space over the image, pick each slice in turn.
        if (st.files.length) {
          const at = await paneCentre(page);
          await page.mouse.move(at.x, at.y);
          await page.locator('section.multiport .pane').first().focus();
          await page.keyboard.press('Space');
          await page.waitForTimeout(250);
          const slices = await page.locator('[data-id="radial"] [data-id^="radial:"]').evaluateAll((bs) => bs.map((b) => ({ id: b.dataset.id, off: b.classList.contains('off') })));
          await page.keyboard.press('Escape');
          if (!slices.length) rows.push({ tab: 'radial', id: '(radial)', problems: ['Space over the image opens no radial menu'] });
          for (const sl of slices) {
            if (SEPARATE.has(sl.id.slice(7))) continue;
            const mark = await markNow(page, app);
            await page.mouse.move(at.x, at.y);
            await page.locator('section.multiport .pane').first().focus();
            await page.keyboard.press('Space');
            await page.waitForTimeout(200);
            const b = page.locator(`[data-id="radial"] [data-id="${sl.id}"]`);
            let outcome = 'gone';
            if (await b.count()) {
              await b.click();
              outcome = sl.off ? 'off' : 'clicked';
            }
            const s = await settle(page);
            const o = await observe(page, app, mark, build);
            rows.push({ tab: 'radial', id: sl.id, outcome, dialogs: s.dialogs, toasts: o.toasts, problems: [...s.problems, ...o.problems] });
            if (st.files.length && !(await app.frame.evaluate(() => window.gisworkbench.layers.size || window.gisworkbench.store.all('vlayer').length || window.gisworkbench.fmv?.clips?.size))) app = await enterState(page, build, st, { prefs: MODERN });
          }
        }
        const bad = report(OUT, `pill-${build}-${info.project.name}-${st.id}`, rows);
        expect(bad, `${rows.length} actions`).toEqual([]);
      });
    }

    test(`GUI modern chrome ${build}: app bar, menus, workspace chip, rail, Products, status bar`, async ({ page }, info) => {
      const app = await enterState(page, build, STATES[1], { prefs: MODERN });
      const rows = [];
      const act = async (tab, id, fn) => {
        const mark = await markNow(page, app);
        const problems = [];
        let outcome = 'clicked';
        try {
          outcome = (await fn()) ?? outcome;
        } catch (e) {
          outcome = 'threw';
          problems.push(`actuate: ${e.message.split('\n')[0]}`);
        }
        const s = await settle(page);
        const o = await observe(page, app, mark, build);
        problems.push(...s.problems, ...o.problems);
        rows.push({ tab, id, outcome, dialogs: s.dialogs, toasts: o.toasts, problems });
      };
      // Plain app-bar buttons.
      const bar = await page.locator('[data-id="shell:appbar"] [data-id^="cmd:"], [data-id="shell:appbar"] [data-id="shell:search"], [data-id="shell:appbar"] [data-id="shell:theme"]').evaluateAll((bs) => bs.map((b) => ({ id: b.dataset.id, name: b.getAttribute('aria-label') || b.textContent.trim(), tip: b.title || b.dataset.tipCmd || b.getAttribute('aria-label') })));
      for (const b of bar) {
        if (!b.name) rows.push({ tab: 'app bar', id: b.id, problems: ['button without a name'] });
        if (SEPARATE.has(b.id.slice(4))) continue;
        await act('app bar', b.id, async () => {
          const el = page.locator(`[data-id="shell:appbar"] [data-id="${b.id}"]`);
          if (await el.isDisabled()) return 'disabled';
          await el.click();
        });
        if (b.id === 'shell:theme') await act('app bar', 'shell:theme (back)', () => page.locator('[data-id="shell:theme"]').click());
      }
      // Menus that open from the app bar and the rail: every item and submenu item.
      const sweepMenu = async (tab, openIt) => {
        await openIt();
        await page.waitForTimeout(150);
        const top = await page.locator('.menu-host .menu').first().locator(':scope > .menu-item').evaluateAll((rs) => rs.map((r) => ({ label: r.querySelector('.menu-label').textContent, sub: r.getAttribute('aria-haspopup') === 'menu', disabled: r.classList.contains('disabled'), id: r.dataset.id ?? null })));
        await page.keyboard.press('Escape');
        await page.mouse.click(2, 2);
        if (!top.length) rows.push({ tab, id: '(menu)', problems: ['menu opens empty'] });
        for (const it of top) {
          let leaves = [it];
          if (it.sub) {
            await openIt();
            await page.locator('.menu-host .menu-item', { hasText: it.label }).first().hover();
            await page.waitForTimeout(200);
            leaves = await page.locator('.menu').last().locator('.menu-item').evaluateAll((rs) => rs.map((r) => ({ label: r.querySelector('.menu-label').textContent, disabled: r.classList.contains('disabled'), id: r.dataset.id ?? null })));
            await page.keyboard.press('Escape');
            await page.mouse.click(2, 2);
            if (!leaves.length) rows.push({ tab, id: `${it.label} ▸`, problems: ['submenu opens empty'] });
          }
          for (const leaf of leaves) {
            const name = it.sub ? `${it.label} ▸ ${leaf.label}` : leaf.label;
            if (SEPARATE.has(leaf.id) || /^Exit|^Close Window/.test(leaf.label)) continue;
            await act(tab, name, async () => {
              if (leaf.disabled) return 'disabled';
              await openIt();
              if (it.sub) {
                await page.locator('.menu-host .menu-item', { hasText: it.label }).first().hover();
                await page.waitForTimeout(200);
                await page.locator('.menu').last().locator('.menu-item', { hasText: leaf.label }).first().click();
              } else await page.locator('.menu-host .menu-item', { hasText: leaf.label }).first().click();
            });
          }
        }
      };
      await sweepMenu('main menu', () => page.locator('[data-id="shell:menu"]').click());
      await sweepMenu('help menu', () => page.locator('[data-id="shell:help"]').click());
      await sweepMenu('workspace chip', () => page.locator('[data-id="shell:persona"]').click());
      // The workspace chip changed the persona: go back to the explorer set-up.
      await app.frame.evaluate(() => window.gisworkbench.personas.apply('explorer'));
      await settle(page);
      // Rail: each item toggles its panel; aria-pressed follows.
      const rail = await page.locator('[data-id="shell:rail"] .rail-item').evaluateAll((bs) => bs.map((b) => ({ id: b.dataset.id, rail: b.dataset.rail, name: b.getAttribute('aria-label') })));
      for (const r of rail) {
        if (r.rail === 'products') continue;
        for (const pass of ['open', 'close']) {
          await act('rail', `${r.rail} (${pass})`, async () => {
            const el = page.locator(`[data-id="shell:rail"] [data-rail="${r.rail}"]`);
            const before = await el.getAttribute('aria-pressed');
            await el.click();
            await page.waitForTimeout(250);
            const after = await el.getAttribute('aria-pressed');
            if (after === before) throw new Error(`aria-pressed stayed ${before}`);
            return `pressed ${after}`;
          });
        }
      }
      await sweepMenu('rail products', () => page.locator('[data-id="shell:rail"] [data-rail="products"]').click());
      // Status bar: the Online/Offline switch (twice: back to where it was) and the jobs cell.
      for (const sel of ['[data-id^="status:net:"] button', '[data-id^="status:net:"] button', '[data-id^="status:jobs:"]']) {
        await act('status bar', sel, async () => {
          const el = page.locator(sel).first();
          if (!(await el.count()) || !(await el.isVisible())) return 'hidden';
          if (await el.isDisabled()) return `disabled: ${await el.getAttribute('title')}`;
          await el.click();
        });
      }
      const bad = report(OUT, `chrome-${build}-${info.project.name}`, rows);
      expect(bad, `${rows.length} actions`).toEqual([]);
    });

    test(`GUI modern docks ${build}: every panel opens beside the imagery, every control in it responds, and it closes`, async ({ page }, info) => {
      let app = await enterState(page, build, STATES[1], { prefs: MODERN });
      const ids = await app.frame.evaluate(() => [...window.gisworkbench.activeMp().docks.registry.keys()].filter((id) => !id.startsWith('tool:')));
      const rows = [];
      for (const id of ids) {
        const mark = await markNow(page, app);
        const problems = [];
        await app.frame.evaluate((id) => window.gisworkbench.activeMp().docks.show(id), id);
        await page.waitForTimeout(300);
        const panel = page.locator(`[data-id="panel:${id}"]`).first();
        if (!(await panel.isVisible())) problems.push('panel not visible after show');
        // Tiled, never over the imagery (REQ-SHL-09).
        const overlapNow = () => page.evaluate((id) => {
          // A floating panel may sit over the image by the user's choice.
          if (window.gisworkbench.activeMp().docks.registry.get(id)?.floatWin) return 0;
          const p = document.querySelector(`[data-id="panel:${id}"]`)?.getBoundingClientRect();
          const v = document.querySelector('section.multiport .pane')?.getBoundingClientRect();
          if (!p || !v) return 0;
          const w = Math.min(p.right, v.right) - Math.max(p.left, v.left);
          const hh = Math.min(p.bottom, v.bottom) - Math.max(p.top, v.top);
          return w > 2 && hh > 2 ? `${Math.round(w * hh)} (panel ${[p.left, p.top, p.width, p.height].map(Math.round)} over image ${[v.left, v.top, v.width, v.height].map(Math.round)})` : 0;
        }, id);
        // The panel re-lays out on the next frames: judge once it has settled.
        let overlap = await overlapNow();
        if (overlap) {
          await page.waitForTimeout(1000);
          overlap = await overlapNow();
        }
        if (overlap) problems.push(`panel covers ${overlap} px² of the image panel`);
        // Every control in the panel.
        const listCtls = () => page.locator(`[data-id="panel:${id}"]`).first().locator(CTL).evaluateAll((es) => es.map((e, i) => ({ i, tag: e.tagName.toLowerCase(), type: e.type, name: (e.getAttribute('aria-label') || e.title || e.textContent.trim() || e.labels?.[0]?.textContent.trim() || '').slice(0, 80), vis: !!e.getClientRects().length, off: e.disabled })));
        const ctls = await listCtls();
        for (const c of ctls) if (c.vis && !c.name) problems.push(`unnamed ${c.tag}[${c.type}] #${c.i}`);
        rows.push({ tab: 'dock', id, outcome: `${ctls.length} controls`, problems: [...problems, ...(await observe(page, app, mark, build)).problems] });
        for (const c of ctls.filter((c) => c.vis && !c.off)) {
          if (KEEP_STATE.test(c.name) || SLOW.test(c.name) || /^(Close|Dock|Float)\b/.test(c.name) || /position$/.test(c.name)) continue;
          const m2 = await markNow(page, app);
          const pr = [];
          await app.frame.evaluate((id) => window.gisworkbench.activeMp().docks.show(id), id);
          // Controls come and go as others are pressed: find this one again by kind and name.
          const again = (await listCtls()).find((x) => x.tag === c.tag && x.type === c.type && x.name === c.name);
          if (!again) continue;
          const el = page.locator(`[data-id="panel:${id}"]`).first().locator(CTL).nth(again.i);
          try {
            if (!(await el.count()) || !(await el.isVisible()) || (await el.isDisabled())) continue;
            if (c.tag === 'select') {
              const opts = await el.evaluate((s) => [...s.options].map((o) => o.value));
              const cur = await el.inputValue();
              for (const v of opts.slice(0, 6)) await el.selectOption(v);
              await el.selectOption(cur).catch(() => {});
            } else if (c.type === 'checkbox') {
              await el.click();
              await el.click();
            } else await el.click();
          } catch (e) {
            pr.push(`actuate: ${e.message.split('\n')[0]}`);
          }
          const s = await settle(page);
          const o = await observe(page, app, m2, build);
          rows.push({ tab: `dock ${id}`, id: c.name || `#${c.i}`, dialogs: s.dialogs, toasts: o.toasts, problems: [...pr, ...s.problems, ...o.problems] });
        }
        // Close from the panel's own title bar.
        const m3 = await markNow(page, app);
        await app.frame.evaluate((id) => window.gisworkbench.activeMp().docks.show(id), id);
        const close = page.locator(`.dock:not([hidden]) .dock-title`).filter({ hasText: await app.frame.evaluate((id) => window.gisworkbench.activeMp().docks.registry.get(id).title, id) }).locator('[aria-label^="Close"]').first();
        const pr = [];
        if (await close.count()) {
          await close.click();
          await page.waitForTimeout(150);
          if (await app.frame.evaluate((id) => window.gisworkbench.activeMp().docks.isOpen(id), id)) pr.push('still open after Close');
        } else {
          pr.push('no Close button in the title bar');
          await app.frame.evaluate((id) => window.gisworkbench.activeMp().docks.toggle(id), id);
        }
        const o = await observe(page, app, m3, build);
        rows.push({ tab: 'dock', id: `${id} close`, problems: [...pr, ...o.problems] });
        // Reload the state if a panel control closed the image.
        if (!(await app.frame.evaluate(() => window.gisworkbench.layers.size))) {
          rows.push({ tab: 'dock', id: `${id} (state reloaded)`, problems: [] });
          app = await enterState(page, build, STATES[1], { prefs: MODERN });
        }
      }
      const bad = report(OUT, `docks-${build}-${info.project.name}`, rows);
      expect(bad, `${rows.length} actions`).toEqual([]);
    });

    test(`GUI modern cursor shortcuts ${build}: flicker, swipe, quick chip, patrol, paste-to-pan`, async ({ page }, info) => {
      const app = await enterState(page, build, STATES.find((s) => s.id === 's5-pair'), { prefs: MODERN, keepDownloads: true });
      const rows = [];
      const at = await paneCentre(page);
      const step = async (id, fn) => {
        const mark = await markNow(page, app);
        const problems = [];
        let outcome;
        try {
          outcome = await fn();
        } catch (e) {
          problems.push(`actuate: ${e.message.split('\n')[0]}`);
        }
        const s = await settle(page);
        const o = await observe(page, app, mark, build);
        rows.push({ tab: 'cursor', id, outcome, toasts: o.toasts, problems: [...problems, ...s.problems, ...o.problems] });
      };
      const focus = async () => {
        await page.mouse.move(at.x, at.y);
        await page.locator('section.multiport .pane').first().focus();
      };
      await step('hold F flicker', async () => {
        await focus();
        const before = await app.frame.evaluate(() => window.gisworkbench.activePane().layers().map((l) => l.visible ?? l.rec?.visible).join());
        await page.keyboard.down('f');
        await page.waitForTimeout(400);
        const during = await app.frame.evaluate(() => window.gisworkbench.activePane().layers().map((l) => l.visible ?? l.rec?.visible).join());
        await page.keyboard.up('f');
        return `layers ${before} → ${during}`;
      });
      await step('S + drag swipe', async () => {
        await focus();
        await page.keyboard.down('s');
        await page.mouse.down();
        await page.mouse.move(at.x + 120, at.y, { steps: 6 });
        await page.mouse.up();
        await page.keyboard.up('s');
      });
      await step('C + drag quick chip', async () => {
        await focus();
        await page.keyboard.down('c');
        await page.mouse.move(at.x - 60, at.y - 60);
        await page.mouse.down();
        await page.mouse.move(at.x + 60, at.y + 60, { steps: 6 });
        await page.mouse.up();
        await page.keyboard.up('c');
      });
      await step('Alt + wheel opacity', async () => {
        await focus();
        await page.keyboard.down('Alt');
        await page.mouse.wheel(0, 120);
        await page.keyboard.up('Alt');
      });
      await step('J / K patrol with nothing to patrol', async () => {
        await focus();
        await page.keyboard.press('j');
        await page.keyboard.press('k');
      });
      await step('paste coordinates to pan', async () => {
        await focus();
        await page.evaluate(() => {
          const dt = new DataTransfer();
          dt.setData('text/plain', '34.05 -117.25');
          document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
        });
      });
      const bad = report(OUT, `cursor-${build}-${info.project.name}`, rows);
      expect(bad, `${rows.length} actions`).toEqual([]);
    });

    test(`GUI modern workspaces and radial ${build}: each workspace's radial tools respond`, async ({ page }, info) => {
      let app = await enterState(page, build, STATES[1], { prefs: MODERN });
      const rows = [];
      const personas = await app.frame.evaluate(() => window.gisworkbench.personas.list().map((p) => p.id));
      for (const per of personas) {
        await app.frame.evaluate((p) => window.gisworkbench.personas.apply(p), per);
        await settle(page);
        const at = await paneCentre(page);
        const open = async () => {
          await page.mouse.move(at.x, at.y);
          await page.locator('section.multiport .pane').first().focus();
          await page.keyboard.press('Space');
          await page.waitForTimeout(200);
        };
        await open();
        const slices = await page.locator('[data-id="radial"] [data-id^="radial:"]').evaluateAll((bs) => bs.map((b) => b.dataset.id));
        await page.keyboard.press('Escape');
        if (!slices.length) rows.push({ tab: per, id: '(radial)', problems: ['no radial menu'] });
        for (const sl of slices) {
          if (SEPARATE.has(sl.slice(7))) continue;
          const mark = await markNow(page, app);
          await open();
          const b = page.locator(`[data-id="radial"] [data-id="${sl}"]`);
          if (await b.count()) await b.click();
          const s = await settle(page);
          const o = await observe(page, app, mark, build);
          rows.push({ tab: `radial ${per}`, id: sl, dialogs: s.dialogs, toasts: o.toasts, problems: [...s.problems, ...o.problems] });
          if (!(await app.frame.evaluate(() => window.gisworkbench.layers.size))) {
            app = await enterState(page, build, STATES[1], { prefs: MODERN });
            await app.frame.evaluate((p) => window.gisworkbench.personas.apply(p), per);
          }
        }
      }
      const bad = report(OUT, `radial-${build}-${info.project.name}`, rows);
      expect(bad, `${rows.length} actions`).toEqual([]);
    });

    test(`GUI modern window commands ${build}: new, clone, separate and close window, full screen, print, recordings, XR`, async ({ page }, info) => {
      const app = await enterState(page, build, STATES.find((s) => s.id === 's5-pair'), { prefs: MODERN });
      const rows = [];
      // Each through the palette, as a user would; recordings are started and stopped again.
      for (const id of ['win.new', 'win.clone', 'win.separate', 'win.close', 'display.fullscreen', 'display.fullscreen', 'file.print', 'cmp.record', 'cmp.record', 'stereo.xr', '3d.record']) {
        const mark = await markNow(page, app);
        const problems = [];
        let outcome = 'ran';
        const cmd = await app.frame.evaluate((c) => ({ id: c, label: window.gisworkbench.commands.get(c).label }), id);
        const { loc } = await paletteFind(page, cmd);
        if (!loc) problems.push('the palette does not list this command');
        else if ((await loc.getAttribute('aria-disabled')) === 'true') {
          outcome = `not now: ${(await loc.locator('.pal-detail').textContent()).replace(/^Not now: /, '')}`;
          await page.keyboard.press('Escape');
        } else {
          const popup = page.waitForEvent('popup', { timeout: 1500 }).catch(() => null);
          await loc.click({ noWaitAfter: true, timeout: 30_000 });
          const p = await popup;
          if (p) {
            outcome = 'opened a window';
            await p.close().catch(() => {});
          }
        }
        await page.waitForTimeout(400);
        const s = await settle(page);
        const o = await observe(page, app, mark, build);
        rows.push({ tab: 'window', id, outcome, dialogs: s.dialogs, toasts: o.toasts, problems: [...problems, ...s.problems, ...o.problems] });
      }
      await page.evaluate(() => document.fullscreenElement && document.exitFullscreen().catch(() => {}));
      const bad = report(OUT, `window-${build}-${info.project.name}`, rows);
      expect(bad, `${rows.length} actions`).toEqual([]);
    });

    test(`GUI modern welcome ${build}: every choice on the first-run card`, async ({ browser }, info) => {
      const rows = [];
      for (const choice of ['welcome:explorer', 'welcome:analyst', 'welcome:pro', 'welcome:classic', 'welcome:skip', 'welcome:online']) {
        // A fresh profile each time: the card shows only before any choice was made.
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await ctx.newPage();
        const app = await boot(page, build, { prefs: {} });
        const mark = await markNow(page, app);
        const problems = [];
        if (!(await page.locator('[data-id="welcome"]').count())) problems.push('no welcome card on first start');
        const b = page.locator(`[data-id="${choice}"]`);
        if (choice === 'welcome:online' && build === 'airgap') {
          if (await b.count()) problems.push('the air-gapped file offers to work online');
        } else if (await b.count()) await b.click();
        else problems.push('choice missing');
        await page.waitForTimeout(400);
        const after = await page.evaluate(() => ({ card: !!document.querySelector('[data-id="welcome"]'), layout: document.documentElement.dataset.layout, persona: window.gisworkbench.personas.current()?.id ?? null, online: window.gisworkbench.network?.isOnline?.() }));
        if (choice !== 'welcome:online' && after.card) problems.push('card still shown after the choice');
        if (choice === 'welcome:classic' && after.layout !== 'classic') problems.push('Classic choice left the Modern layout');
        if (choice === 'welcome:online' && build !== 'airgap' && !after.online) problems.push('Work online did not go online');
        const o = await observe(page, app, mark, build);
        rows.push({ tab: 'welcome', id: choice, outcome: JSON.stringify(after), problems: [...problems, ...o.problems] });
        await ctx.close();
      }
      const bad = report(OUT, `welcome-${build}-${info.project.name}`, rows);
      expect(bad).toEqual([]);
    });

    test(`GUI modern sizes ${build}: the chrome fits and every control is named at 1920, 1440, 1280 and 1024 px`, async ({ page }, info) => {
      await enterState(page, build, STATES[1], { prefs: MODERN });
      const rows = [];
      for (const [w, hgt] of [[1920, 1080], [1440, 900], [1280, 720], [1024, 768]]) {
        await page.setViewportSize({ width: w, height: hgt });
        await page.waitForTimeout(400);
        const r = await page.evaluate(() => {
          const out = [];
          const vis = (e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
          for (const e of document.querySelectorAll('[data-id="shell:appbar"] button, [data-id="shell:rail"] button, [data-id="pill"] button, .statusbar button, .pane-corner button, .pane button')) {
            if (!vis(e)) continue;
            const b = e.getBoundingClientRect();
            const name = e.getAttribute('aria-label') || e.title || e.textContent.trim();
            if (!name) out.push(`unnamed ${e.dataset.id ?? e.className}`);
            if (b.right > innerWidth + 1 || b.bottom > innerHeight + 1 || b.left < -1 || b.top < -1) out.push(`off-screen ${e.dataset.id ?? name}`);
          }
          if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`page scrolls sideways (${document.documentElement.scrollWidth} px)`);
          const bar = document.querySelector('[data-id="shell:appbar"]');
          if (bar && bar.scrollWidth > bar.clientWidth + 1) out.push(`app bar overflows by ${bar.scrollWidth - bar.clientWidth} px`);
          const rail = document.querySelector('[data-id="shell:rail"]');
          if (rail && rail.scrollHeight > rail.clientHeight + 1 && getComputedStyle(rail).overflowY !== 'auto') out.push('rail items cut off');
          return out;
        });
        rows.push({ tab: 'size', id: `${w}×${hgt}`, problems: r });
      }
      const bad = report(OUT, `sizes-${build}-${info.project.name}`, rows);
      expect(bad).toEqual([]);
    });
  });
}
