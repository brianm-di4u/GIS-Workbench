// GUI campaign sweep (docs/validation/GUI-findings.md): actuate every ribbon control, split
// caret, menu item, QAT button, dock, context menu, layout and hot key through real pointer and
// keyboard input on the built Standard, Lite and Air-gapped files in the Classic layout, in the
// data states that bring up each contextual tab set. A control fails on a page error, console
// error, CSP violation, unexpected error toast, a dialog that will not close or does not fit the
// window, or a missing control. The Modern layout is swept by gui-modern.spec.js.
//   GW_SWEEP_BUILDS=full,lite,airgap  GW_SWEEP_STATES=s0-empty,s1-image  (defaults: all)

import { test, expect } from '@playwright/test';
import { STATES, SEPARATE, ENDS_MODE, MP, enterState, observe, markNow, settle, report as writeReport, progress, reportDir } from './gui-lib.js';

test.describe.configure({ mode: 'parallel', timeout: 900_000 });
test.use({ actionTimeout: 5_000 });

const OUT = reportDir('gui');

async function activeTabControls(page) {
  return page.evaluate((mpSel) => {
    const mp = document.querySelector(mpSel);
    return [...mp.querySelectorAll('.ribbon-body [data-id^="cmd:"]')].map((e) => ({
      did: e.dataset.id,
      tag: e.tagName.toLowerCase(),
      type: e.type ?? null,
      kind: e.classList.contains('rsplit-caret') ? 'caret' : e.classList.contains('rlauncher') ? 'launcher' : e.tagName === 'SELECT' ? 'combo' : e.type === 'range' ? 'slider' : e.tagName === 'INPUT' ? 'input' : 'button',
    }));
  }, MP);
}

async function clickTab(page, tab) {
  const t = page.locator(`${MP} [data-id="ribbon:tab:${tab}"]`).first();
  if (!(await t.count())) return false;
  if ((await t.getAttribute('aria-selected')) !== 'true') await t.click();
  return true;
}

const INPUTS = { 'nav.jumpbox': '34.05 -117.25', 'rot.angle': '30' };

/** Actuate one ribbon control the way a user would. */
async function actuate(page, ctl) {
  const loc = page.locator(`${MP} .ribbon-body [data-id="${ctl.did}"]`).first();
  if (!(await loc.count())) return 'missing';
  if (await loc.isDisabled()) return 'disabled';
  const id = ctl.did.slice(4).replace(/:menu$/, '');
  if (ctl.kind === 'combo') {
    const opts = await loc.evaluate((s) => [...s.options].map((o) => o.value));
    const cur = await loc.inputValue();
    for (const v of opts.slice(0, 8)) {
      await loc.selectOption(v);
      await page.waitForTimeout(200);
    }
    if (await loc.isEnabled()) await loc.selectOption(cur).catch(() => {});
    return `combo ×${opts.length}`;
  }
  if (ctl.kind === 'slider') {
    await loc.focus();
    // Two steps up and back with the keyboard. Double-click reset on the colour sliders only:
    // under software WebGL a sharpened redraw takes seconds and the page is never "stable" (GUI-027).
    for (const k of ['ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowLeft']) await page.keyboard.press(k);
    await page.waitForTimeout(150);
    if (id !== 'enh.sharpness') await loc.dblclick({ timeout: 20_000 });
    const v = await loc.inputValue();
    return v === '0' ? 'slider' : `slider left at ${v}`;
  }
  if (ctl.kind === 'input') {
    await loc.fill(INPUTS[id] ?? '1');
    await loc.press('Enter');
    return 'input';
  }
  const pressed0 = await loc.getAttribute('aria-pressed');
  await loc.click();
  if (ctl.kind === 'caret') {
    const items = await page.locator('.menu-host .menu-item').count();
    if (!items) return 'caret: no menu';
    return `menu ×${items}`;
  }
  // Toggles go back to how they were once the side effects are observed.
  await page.waitForTimeout(300);
  const after = page.locator(`${MP} .ribbon-body [data-id="${ctl.did}"]`).first();
  if (pressed0 !== null && (await after.count()) && !(await page.locator('.dlg[role="dialog"]').count())) {
    if ((await after.getAttribute('aria-pressed')) !== pressed0 && (await after.isEnabled())) {
      await after.click().catch(() => {}); // an overlay (the whiteboard) may cover it; settle() closes it
      return 'toggled';
    }
  }
  return 'clicked';
}

const report = (name, rows) => writeReport(OUT, name, rows);

const builds = (process.env.GW_SWEEP_BUILDS ?? 'full,lite,airgap').split(',');
const wanted = process.env.GW_SWEEP_STATES?.split(',');

for (const build of builds) {
  test.describe(`GUI sweep ${build}`, () => {
    for (const st of STATES.filter((s) => !wanted || wanted.includes(s.id))) {
      test(`GUI ribbon ${build} ${st.id}: every control in every tab responds without error`, async ({ page }, info) => {
        test.skip(build === 'lite' && st.lite === 'skip', 'point clouds need the LiDAR module Lite leaves out (checked in the Lite refusal test)');
        let app = await enterState(page, build, st);
        const tabsNow = async () => page.evaluate((mpSel) => [...document.querySelector(mpSel).querySelectorAll('[data-id^="ribbon:tab:"]')].map((t) => ({ id: t.dataset.id.slice(11), ctx: t.classList.contains('rtab-ctx') })), MP);
        const tabs = (await tabsNow()).filter((t) => t.ctx || st.main).map((t) => t.id);
        if (st.id !== 's0-empty' && build !== 'lite') expect(tabs.length, `contextual tabs in ${st.id}`).toBeGreaterThan(0);
        const rows = [];
        for (const tab of tabs) {
          if (!(await clickTab(page, tab))) {
            app = await enterState(page, build, st);
            if (!(await clickTab(page, tab))) {
              rows.push({ tab, id: '(tab)', problems: ['tab missing after reload'] });
              continue;
            }
          }
          const ctls = (await activeTabControls(page)).filter((c) => !SEPARATE.has(c.did.slice(4).replace(/:menu$/, '')));
          ctls.sort((a, b) => ENDS_MODE.test(a.did.slice(4)) - ENDS_MODE.test(b.did.slice(4)));
          for (const ctl of ctls) {
            if (!(await clickTab(page, tab))) {
              app = await enterState(page, build, st);
              await clickTab(page, tab);
            }
            const mark = await markNow(page, app);
            let outcome;
            const problems = [];
            try {
              outcome = await actuate(page, ctl);
            } catch (e) {
              outcome = 'threw';
              problems.push(`actuate: ${e.message.split('\n')[0]}`);
            }
            const s = await settle(page);
            const o = await observe(page, app, mark, build);
            problems.push(...s.problems, ...o.problems);
            if (outcome === 'missing' && !ENDS_MODE.test(ctl.did.slice(4))) problems.push('control missing from its tab');
            if (outcome === 'caret: no menu') problems.push('split caret opens no menu');
            rows.push({ tab, id: ctl.did.slice(4), kind: ctl.kind, outcome, dialogs: s.dialogs, toasts: o.toasts, problems });
            progress(OUT, `${build} ${st.id} ${tab} ${ctl.did} ${outcome} ${problems.length}`);
          }
        }
        const bad = report(`ribbon-${build}-${info.project.name}-${st.id}`, rows);
        expect(bad, `${rows.length} controls swept`).toEqual([]);
      });
    }

    test(`GUI menus ${build}: every Workspace and File menu item opens, runs or refuses by name`, async ({ page }, info) => {
      const app = await enterState(page, build, STATES[1]);
      const rows = [];
      const menus = await page.locator('[data-id^="menu:"]').evaluateAll((bs) => bs.map((b) => b.dataset.id));
      const sweepMenu = async (openIt, name) => {
        await openIt();
        const leaves = await page.evaluate(() => {
          const out = [];
          for (const r of document.querySelectorAll('.menu-host .menu-item')) out.push({ label: r.querySelector('.menu-label').textContent, sub: r.getAttribute('aria-haspopup') === 'menu', disabled: r.classList.contains('disabled'), id: r.dataset.id ?? null });
          return out;
        });
        await page.keyboard.press('Escape');
        for (const leaf of leaves) {
          const path = [leaf.label];
          const items = leaf.sub ? await (async () => {
            await openIt();
            await page.locator('.menu-host .menu-item', { hasText: leaf.label }).first().hover();
            await page.waitForTimeout(150);
            const subs = await page.evaluate(() => [...document.querySelectorAll('.menu')].at(-1)._rows?.length ?? 0);
            const list = await page.evaluate(() => [...[...document.querySelectorAll('.menu')].at(-1).querySelectorAll('.menu-item')].map((r) => ({ label: r.querySelector('.menu-label').textContent, disabled: r.classList.contains('disabled'), id: r.dataset.id ?? null })));
            await page.keyboard.press('Escape');
            return subs ? list : [];
          })() : [leaf];
          for (const it of items) {
            if (SEPARATE.has(it.id)) continue;
            const mark = await markNow(page, app);
            let outcome = 'disabled';
            if (!it.disabled) {
              await openIt();
              if (leaf.sub) {
                await page.locator('.menu-host .menu-item', { hasText: leaf.label }).first().hover();
                await page.waitForTimeout(150);
                await page.locator('.menu').last().locator('.menu-item', { hasText: it.label }).first().click();
              } else await page.locator('.menu-host .menu-item', { hasText: it.label }).first().click();
              outcome = 'clicked';
            }
            const s = await settle(page);
            const o = await observe(page, app, mark, build);
            rows.push({ tab: name, id: [...(leaf.sub ? path : []), it.label].join(' ▸ '), outcome, dialogs: s.dialogs, toasts: o.toasts, problems: [...s.problems, ...o.problems] });
          }
        }
      };
      for (const m of menus) {
        if (m === 'menu:Window') continue; // dynamic; covered by the window test
        await sweepMenu(() => page.locator(`[data-id="${m}"]`).click(), m);
      }
      await sweepMenu(() => page.locator(`${MP} [data-id="ribbon:file"]`).first().click(), 'ribbon:file');
      const bad = report(`menus-${build}-${info.project.name}`, rows);
      expect(bad, `${rows.length} menu items swept`).toEqual([]);
    });

    test(`GUI QAT and workspace toolbar ${build}: every button responds`, async ({ page }, info) => {
      const app = await enterState(page, build, STATES[1]);
      const rows = [];
      const ids = [
        ...(await page.locator(`${MP} [data-id^="qat:"]`).evaluateAll((bs) => bs.map((b) => b.dataset.id).filter((d) => d !== 'qat:wb.count'))),
        ...(await page.locator('[data-id^="ws:"]').evaluateAll((bs) => bs.map((b) => b.dataset.id))),
      ];
      for (const did of ids) {
        const mark = await markNow(page, app);
        const b = page.locator(`[data-id="${did}"]`).first();
        let outcome = 'disabled';
        if (await b.isEnabled()) {
          await b.click();
          outcome = 'clicked';
        }
        const s = await settle(page);
        const o = await observe(page, app, mark, build);
        rows.push({ id: did, outcome, dialogs: s.dialogs, toasts: o.toasts, problems: [...s.problems, ...o.problems] });
      }
      const bad = report(`qat-${build}-${info.project.name}`, rows);
      expect(bad).toEqual([]);
    });

    test(`GUI docks ${build}: every dock panel opens, moves left/right/bottom, floats and closes`, async ({ page }, info) => {
      const app = await enterState(page, build, STATES[1]);
      const ids = await app.frame.evaluate(() => [...window.gisworkbench.activeMp().docks.registry.keys()]);
      const rows = [];
      for (const id of ids) {
        const mark = await markNow(page, app);
        const problems = [];
        await app.frame.evaluate((id) => window.gisworkbench.activeMp().docks.show(id), id);
        const panel = page.locator(`[data-id="panel:${id}"]`).first(); // floating panels live outside the Multiport
        if (!(await panel.isVisible())) problems.push('panel not visible after show');
        for (const where of ['Dock Right', 'Dock Bottom', 'Dock Left', 'Float']) {
          const btn = page.locator(`${MP} .dock:not([hidden]) .dock-title`).filter({ has: page.locator(`[aria-label="${await app.frame.evaluate((id) => window.gisworkbench.activeMp().docks.registry.get(id).title, id)} position"]`) }).locator('.dock-btn').first();
          if (!(await btn.count())) break;
          await btn.click();
          await page.locator('.menu-host .menu-item', { hasText: where }).click();
          await page.waitForTimeout(150);
          if (!(await panel.isVisible())) problems.push(`hidden after ${where}`);
        }
        // Floating window: Close.
        const fw = page.locator('.dock-float, .float-win').filter({ has: panel });
        if (await fw.count()) await fw.locator('[aria-label^="Close"], [title="Close"]').first().click().catch(() => {});
        else await app.frame.evaluate((id) => window.gisworkbench.activeMp().docks.toggle(id), id);
        await page.waitForTimeout(150);
        const s = await settle(page);
        const o = await observe(page, app, mark, build);
        rows.push({ id, problems: [...problems, ...s.problems, ...o.problems] });
      }
      const bad = report(`docks-${build}-${info.project.name}`, rows);
      expect(bad).toEqual([]);
    });

    test(`GUI context menus ${build}: panel, mini toolbar, layer row and status bar menus`, async ({ page }, info) => {
      const app = await enterState(page, build, STATES[1]);
      const rows = [];
      const pane = page.locator(`${MP} .pane`).first();
      const box = await pane.boundingBox();
      const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      // Panel right-click menu: every leaf, reopening the menu each time.
      await page.mouse.click(at.x, at.y, { button: 'right' });
      await page.waitForTimeout(200);
      const top = await page.locator('.menu-host .menu > .menu-item').evaluateAll((rs) => rs.map((r) => ({ label: r.querySelector('.menu-label').textContent, sub: r.getAttribute('aria-haspopup') === 'menu', disabled: r.classList.contains('disabled') })));
      const mini = await page.locator('[data-id="mini-toolbar"] [data-cmd]').evaluateAll((bs) => bs.map((b) => b.dataset.cmd));
      await page.keyboard.press('Escape');
      await page.mouse.click(2, 2);
      for (const it of top) {
        const leaves = [];
        if (it.sub) {
          await page.mouse.click(at.x, at.y, { button: 'right' });
          await page.locator('.menu-host .menu-item', { hasText: it.label }).first().hover();
          await page.waitForTimeout(150);
          leaves.push(...(await page.locator('.menu').last().locator('.menu-item').evaluateAll((rs) => rs.map((r) => r.querySelector('.menu-label').textContent))));
          await page.keyboard.press('Escape');
          await page.mouse.click(2, 2);
        } else leaves.push(null);
        for (const leaf of leaves) {
          if (it.disabled) continue;
          const mark = await markNow(page, app);
          await page.mouse.click(at.x, at.y, { button: 'right' });
          if (leaf) {
            await page.locator('.menu-host .menu-item', { hasText: it.label }).first().hover();
            await page.waitForTimeout(150);
            await page.locator('.menu').last().locator('.menu-item', { hasText: leaf }).first().click();
          } else await page.locator('.menu-host .menu-item', { hasText: it.label }).first().click();
          const s = await settle(page);
          const o = await observe(page, app, mark, build);
          rows.push({ tab: 'panel menu', id: leaf ? `${it.label} ▸ ${leaf}` : it.label, dialogs: s.dialogs, toasts: o.toasts, problems: [...s.problems, ...o.problems] });
        }
      }
      for (const cmd of mini) {
        const mark = await markNow(page, app);
        await page.mouse.click(at.x, at.y, { button: 'right' });
        const b = page.locator(`[data-id="mini-toolbar"] [data-cmd="${cmd}"]`);
        if (await b.isEnabled()) await b.click();
        else await page.keyboard.press('Escape'); // a disabled mini-toolbar button leaves the menu open
        const s = await settle(page);
        const o = await observe(page, app, mark, build);
        rows.push({ tab: 'mini toolbar', id: cmd, dialogs: s.dialogs, toasts: o.toasts, problems: [...s.problems, ...o.problems] });
      }
      // Layer Manager row menu.
      await app.frame.evaluate(() => window.gisworkbench.activeMp().docks.show('layers'));
      const row = page.locator(`${MP} [data-id="panel:layers"] [data-id^="layer:"], ${MP} [data-id="panel:layers"] .layer-row`).first();
      if (await row.count()) {
        await row.click({ button: 'right' });
        const items = await page.locator('.menu-host .menu-item').evaluateAll((rs) => rs.map((r) => ({ label: r.querySelector('.menu-label').textContent, disabled: r.classList.contains('disabled') })));
        await page.keyboard.press('Escape');
        for (const it of items.filter((i) => !i.disabled && !/^Remove$/.test(i.label))) {
          const mark = await markNow(page, app);
          await row.click({ button: 'right' });
          await page.locator('.menu-host .menu-item', { hasText: it.label }).first().click();
          const s = await settle(page);
          const o = await observe(page, app, mark, build);
          rows.push({ tab: 'layer menu', id: it.label, dialogs: s.dialogs, toasts: o.toasts, problems: [...s.problems, ...o.problems] });
        }
      } else rows.push({ tab: 'layer menu', id: '(row)', problems: ['no layer row in the Layer Manager'] });
      // Status bar menu: hide and show a cell.
      const sb = page.locator(`${MP} .statusbar`).first();
      await sb.click({ button: 'right' });
      const cells = await page.locator('.menu-host .menu-item').count();
      if (!cells) rows.push({ tab: 'status', id: 'menu', problems: ['status bar has no context menu'] });
      await page.keyboard.press('Escape');
      const bad = report(`context-${build}-${info.project.name}`, rows);
      expect(bad).toEqual([]);
    });

    test(`GUI keyboard ${build}: hot keys, KeyTips and Esc`, async ({ page }, info) => {
      const app = await enterState(page, build, STATES[1]);
      const rows = [];
      // KeyTips: Alt then a tab letter selects that tab.
      for (const [k, tab] of [['H', 'home'], ['S', 'select'], ['D', 'draw'], ['G', 'geospatial'], ['P', 'products'], ['V', 'view'], ['A', 'addins']]) {
        await page.locator(`${MP} .pane`).first().focus();
        await page.keyboard.press('Alt');
        await page.waitForTimeout(100);
        await page.keyboard.press(k);
        const sel = await page.locator(`${MP} [data-id="ribbon:tab:${tab}"]`).first().getAttribute('aria-selected');
        rows.push({ tab: 'keytips', id: `Alt ${k}`, problems: sel === 'true' ? [] : [`Alt, ${k} did not select ${tab}`] });
      }
      const map = await app.frame.evaluate(() => {
        const km = window.gisworkbench.keys.keyMap();
        return Object.entries(km.global ?? km).concat(Object.entries(km.pane ?? {})).map(([k, v]) => [k, typeof v === 'string' ? v : v?.cmd ?? String(v)]);
      });
      for (const [chord, cmd] of map) {
        if (SEPARATE.has(cmd) || /^Mod\+(Shift\+)?Key[SO]$/.test(chord)) continue; // save/open pickers: covered by menus
        const key = chord.replace(/Mod\+/g, 'Control+');
        const mark = await markNow(page, app);
        await page.locator(`${MP} .pane`).first().focus();
        await page.keyboard.press(key).catch((e) => rows.push({ tab: 'keys', id: chord, problems: [`press: ${e.message.split('\n')[0]}`] }));
        const s = await settle(page);
        const o = await observe(page, app, mark, build);
        rows.push({ tab: 'keys', id: `${chord} → ${cmd}`, dialogs: s.dialogs, toasts: o.toasts, problems: [...s.problems, ...o.problems] });
      }
      const bad = report(`keys-${build}-${info.project.name}`, rows);
      expect(bad).toEqual([]);
    });

    test(`GUI windows and layouts ${build}: split layouts, tabbed panels, new/close Multiport, arrange`, async ({ page }, info) => {
      const app = await enterState(page, build, STATES[1]);
      const rows = [];
      await clickTab(page, 'view');
      const caret = page.locator(`${MP} [data-id="cmd:win.split:menu"]`).first();
      await caret.click();
      const layouts = await page.locator('.menu-host .menu-item .menu-label').allTextContents();
      await page.keyboard.press('Escape');
      for (const l of layouts) {
        const mark = await markNow(page, app);
        await caret.click();
        await page.locator('.menu-host .menu-item', { hasText: l }).first().click();
        await page.waitForTimeout(250);
        const panes = await page.locator(`${MP} .pane`).count();
        const o = await observe(page, app, mark, build);
        rows.push({ tab: 'layout', id: l, outcome: `${panes} panels`, problems: o.problems });
      }
      for (const cmd of ['win.tabbed', 'win.tabbed', 'win.new', 'win.clone']) {
        const mark = await markNow(page, app);
        const b = page.locator(`${MP} [data-id="cmd:${cmd}"]`).first();
        if (await b.isEnabled()) await b.click();
        const s = await settle(page);
        const o = await observe(page, app, mark, build);
        rows.push({ tab: 'windows', id: cmd, problems: [...s.problems, ...o.problems] });
      }
      const mps = await page.locator('section.multiport').count();
      rows.push({ tab: 'windows', id: 'multiport count', outcome: mps, problems: mps >= 3 ? [] : [`expected ≥3 Multiports, got ${mps}`] });
      for (const label of ['Tabs', 'Tile']) {
        const mark = await markNow(page, app);
        // Four windows put the desktop in Tabs: the Window menu is in the Workspace tab.
        const wsTab = page.getByRole('tab', { name: 'Workspace', exact: true });
        if (await wsTab.count()) await wsTab.click();
        await page.locator('[data-id="menu:Window"]').click();
        const it = page.locator('.menu-host .menu-item', { hasText: label }).first();
        if (await it.count()) await it.click();
        else rows.push({ tab: 'windows', id: `Window ▸ ${label}`, problems: ['menu item missing'] });
        const s = await settle(page);
        const o = await observe(page, app, mark, build);
        rows.push({ tab: 'windows', id: `Window ▸ ${label}`, problems: [...s.problems, ...o.problems] });
      }
      const mark = await markNow(page, app);
      await app.frame.evaluate(() => window.gisworkbench.commands.run('win.close'));
      const s = await settle(page);
      const o = await observe(page, app, mark, build);
      rows.push({ tab: 'windows', id: 'win.close', problems: [...s.problems, ...o.problems] });
      const bad = report(`windows-${build}-${info.project.name}`, rows);
      expect(bad).toEqual([]);
    });
  });
}
