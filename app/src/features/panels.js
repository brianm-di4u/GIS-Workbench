// Dock panels: Layer Manager (REQ-UI-18, REQ-UI-13), Mensuration Log (REQ-MEN-01, AC-02.2),
// Job Queue (REQ-ARC-06), Network Log (REQ-SEC-12), Cue Cards (REQ-UI-06) and Import Log.

import { h, clear, fmtNum } from '../shell/dom.js';
import { icon } from '../shell/icons.js';
import { openMenu } from '../shell/menu.js';
import { saveBlob, textBlob } from '../storage/files.js';
import { installTools } from '../tools/tools.js';

export const name = 'panels';

/** RFC 4180 CSV with formula-injection protection (cells starting = + - @ get a quote). */
export function toCsv(rows) {
  const esc = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}

import { MENLOG_COLUMNS, menRow } from '../tools/menlog.js';
export { MENLOG_COLUMNS, menRow };

export function install(app) {
  installTools(app);
  app.menRowOf = menRow; // display strings of a Mensuration Log row (reports, tests)
  const reg = (mp) => {
    const D = mp.docks;
    D.register({ id: 'layers', title: 'Layer Manager', icon: 'layers', home: 'left', create: (a, m, el) => layerManager(a, m, el) });
    D.register({ id: 'toolbox', title: 'ToolBox', icon: 'toolbox', home: 'left', create: (a, m, el) => toolbox(a, el) });
    D.register({ id: 'cues', title: 'Cue Cards', icon: 'help', home: 'left', create: (a, m, el) => cueCards(a, el) });
    D.register({ id: 'menlog', title: 'Mensuration Log', icon: 'log', home: 'bottom', marked: true, create: (a, m, el) => menLog(a, m, el) });
    D.register({ id: 'jobs', title: 'Job Queue', icon: 'job', home: 'bottom', create: (a, m, el) => jobQueue(a, el) });
    D.register({ id: 'netlog', title: 'Network Log', icon: 'network', home: 'bottom', create: (a, m, el) => netLog(a, el) });
    D.register({ id: 'importlog', title: 'Import Log', icon: 'list', home: 'bottom', create: (a, m, el) => importLog(a, el) });
    // The Classic layout opens the Layer Manager and Cue Cards at start, as in 1.x; the Modern
    // layout starts with no dock open (REQ-SHL-02).
    if (app.layoutMode() === 'classic') {
      D.show('layers', 'left');
      D.show('cues', 'left');
      D.show('layers', 'left');
    }
  };
  app.on('ready', (mp) => reg(mp));
  const orig = app.desktop.addMultiport.bind(app.desktop);
  app.desktop.addMultiport = (id) => {
    const mp = orig(id);
    if (app._ready) reg(mp);
    return mp;
  };
  app.on('ready', () => (app._ready = true));
  app.panels = {
    show: (id, side) => app.activeMp()?.docks.show(id, side),
    toggle: (id, side) => app.activeMp()?.docks.toggle(id, side),
  };
  const C = app.commands;
  C.implement('dock.layers', { run: () => app.panels.toggle('layers', 'left'), checked: () => !!app.activeMp()?.docks.isOpen('layers') });
  C.implement('dock.toolbox', { run: () => app.panels.toggle('toolbox', 'left') });
  C.implement('ext.toolbox', { run: () => app.panels.toggle('toolbox', 'left') });
  C.implement('men.log', { run: () => app.panels.toggle('menlog', 'bottom'), checked: () => !!app.activeMp()?.docks.isOpen('menlog') });
  C.implement('dock.jobs', { run: () => app.panels.toggle('jobs', 'bottom') });
  C.implement('dock.netlog', { run: () => app.panels.toggle('netlog', 'bottom') });
  C.implement('dock.importlog', { run: () => app.panels.toggle('importlog', 'bottom'), checked: () => !!app.activeMp()?.docks.isOpen('importlog') });
  C.implement('ribbon.minimise', { run: () => app.activeMp()?.ribbon.toggleMinimise(), checked: () => !!app.activeMp()?.ribbon.minimised });
  app.cue = (text) => {
    app.cueText = text;
    app.emit('cue');
  };
}

function layerManager(app, mp, el) {
  const head = h('div', { class: 'lm-head' });
  const list = h('div', { class: 'lm-list', role: 'list', 'aria-label': 'Layers', tabindex: '0' });
  el.append(head, list);
  const render = () => {
    clear(head);
    clear(list);
    const pane = mp.activePane;
    // A multiport closed by opening another project keeps no records: nothing to show.
    if (!pane?.rec || !app.desktop.multiports.includes(mp)) return;
    head.append(h('label', { class: 'fld fld-inline' }, h('span', {}, 'Active Panel:'), h('b', {}, `Panel.${mp.panes.indexOf(pane) + 1}`)));
    const layers = pane.layers().slice().reverse();
    const active = pane.rec.activeLayer;
    if (pane.rec.graphicsLayer) {
      const gl = app.store.get(pane.rec.graphicsLayer);
      const n = app.store.all('graphic').filter((g) => g.pane === pane.id).length;
      const cb = h('input', { type: 'checkbox', checked: gl.visible !== false, 'aria-label': 'Show graphics' });
      cb.addEventListener('change', () => {
        app.store.transact('Graphics visibility', (tx) => tx.set(gl.id, 'visible', cb.checked));
        pane.invalidate();
      });
      list.appendChild(h('div', { class: 'lm-row', role: 'listitem', 'data-id': `glayer:${gl.id}` }, cb, icon('polygon'), h('span', { class: 'lm-name' }, `${gl.saved === false ? '*' : ''}Graphics [${n} displayed]`)));
    }
    for (const l of layers) {
      const rec = l.rec;
      const cb = h('input', { type: 'checkbox', checked: rec.visible !== false, 'aria-label': `Show ${rec.name}` });
      cb.addEventListener('change', () => app.store.transact('Layer visibility', (tx) => tx.set(l.id, 'visible', cb.checked)));
      const op = h('input', { type: 'range', min: '0', max: '100', value: String(Math.round((rec.opacity ?? 1) * 100)), class: 'lm-opacity', 'aria-label': `Opacity of ${rec.name}`, title: 'Opacity' });
      op.addEventListener('input', () => app.store.transact('Layer opacity', (tx) => tx.set(l.id, 'opacity', +op.value / 100), { mergeKey: `opacity:${l.id}` }));
      op.addEventListener('change', () => app.undo.seal());
      const role = l.id === active ? ' (M)' : '';
      const row = h(
        'div',
        { class: ['lm-row', l.id === active && 'active'], role: 'listitem', 'aria-current': l.id === active ? 'true' : null, 'data-id': `layer:${l.id}` },
        cb,
        icon(l.kind === 'dem' ? 'terrain' : 'image'),
        h('span', { class: ['lm-name', l.error && 'lm-error'], title: l.error ? `${rec.name}: ${l.error}` : rec.name }, `${rec.saved === false ? '*' : ''}${rec.name} [${l.info.format}]${role}${l.error ? ' — not displayable' : ''}`),
        op,
      );
      row.addEventListener('click', (e) => {
        if (e.target === cb || e.target === op) return;
        app.store.transact('Set active layer', (tx) => tx.set(pane.id, 'activeLayer', l.id), { kind: 'load' });
        app.selectedLayerId = l.id;
        app.emit('state');
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openMenu(
          [
            { label: 'Set Active', run: () => app.store.transact('Set active layer', (tx) => tx.set(pane.id, 'activeLayer', l.id)) },
            { label: 'Zoom to Layer', run: () => pane.fitWhole() },
            ...(l.bands === 1 && l.kind !== 'dem' && (l.sampleType === 'f32' || l.sampleType === 'i16') && l.modelId ? [{ label: 'Use as Terrain…', run: () => app.terrainDialog?.(l) }] : []),
            { label: 'Metadata…', run: () => app.showMetadata(l) },
            '-',
            { label: 'Move Up', run: () => moveLayer(app, pane, l.id, 1) },
            { label: 'Move Down', run: () => moveLayer(app, pane, l.id, -1) },
            '-',
            { label: 'Remove', run: () => removeLayer(app, pane, l.id) },
          ],
          app,
          { x: e.clientX, y: e.clientY },
        );
      });
      list.appendChild(row);
    }
    if (!layers.length) list.appendChild(h('p', { class: 'muted pad' }, 'No layers. Open an image (File ▸ Open Image) or drop files on the panel.'));
  };
  for (const ev of ['state', 'layers']) app.on(ev, render);
  render();
  return { onShow: render };
}

export function moveLayer(app, pane, id, dir) {
  const ids = [...pane.rec.layers];
  const i = ids.indexOf(id);
  const j = i + dir;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  app.store.transact('Draw order', (tx) => tx.set(pane.id, 'layers', ids));
}

export function removeLayer(app, pane, id) {
  const l = app.layers.get(id);
  app.store.transact(`Remove ${l?.rec?.name ?? 'layer'}`, (tx) => {
    tx.set(pane.id, 'layers', pane.rec.layers.filter((x) => x !== id));
    if (pane.rec.activeLayer === id) tx.set(pane.id, 'activeLayer', pane.rec.layers.at(-1) ?? null);
  });
  app.emit('layers');
}

function toolbox(app, el) {
  el.append(
    h('div', { class: 'tb-drawer' }, h('div', { class: 'tb-drawer-head' }, 'Graphics'), h('div', { class: 'tb-grid' }, ['draw.point', 'draw.line', 'draw.polyline', 'draw.polygon', 'draw.rect', 'draw.circle', 'draw.arrow', 'draw.text', 'draw.callout', 'draw.marker'].map((id) => tbBtn(app, id)))),
    h('div', { class: 'tb-drawer' }, h('div', { class: 'tb-drawer-head' }, 'Mensuration'), h('div', { class: 'tb-grid' }, ['men.point', 'men.rangebearing', 'men.length', 'men.area'].map((id) => tbBtn(app, id)))),
    app.extractDrawer?.() ?? null,
    h('p', { class: 'hint pad' }, 'Double-click a tool (or tick Repeat) to keep it active until Esc. Schemas and attribute forms arrive in R2 (REQ-EXT-09).'),
  );
}

function tbBtn(app, id) {
  const c = app.commands.get(id);
  const b = h('button', { class: 'tb-tool', title: c.label, 'aria-label': c.label, 'data-id': `cmd:${id}` }, icon(c.icon, 24));
  b.addEventListener('click', () => app.commands.run(id));
  b.addEventListener('dblclick', () => c.sticky?.());
  return b;
}

function cueCards(app, el) {
  const body = h('div', { class: 'cue pad' });
  el.appendChild(body);
  const render = () => {
    clear(body);
    const t = app.tools?.current;
    body.append(
      h('h3', {}, t ? app.commands.get(t.id)?.label ?? t.id : 'Getting started'),
      h('p', {}, app.cueText && t ? app.cueText : 'Open an image with File ▸ Open Image (Ctrl+O) or drop files on the panel. Wheel zooms about the cursor; hold the middle button to roam; drag with the left button to pan; double-click centres and zooms. W shows the whole scene; F7 toggles full roam; Esc ends a tool. F1 opens help.'),
    );
  };
  app.on('cue', render);
  app.on('state', () => !app.tools?.current && render());
  render();
}

function menLog(app, mp, el) {
  const bar = h('div', { class: 'grid-bar' });
  const wrap = h('div', { class: 'grid-wrap' });
  el.append(bar, wrap);
  const exportCsv = async () => {
    const rows = app.store.all('measurement').map(menRow);
    const csv = toCsv([MENLOG_COLUMNS.map((c) => c[1]), ...rows.map((r) => MENLOG_COLUMNS.map(([k]) => r[k]))]);
    const mark = app.screenMarking();
    await saveBlob(app, textBlob(`# ${app.markingSuffix()} — ${mark.level ? '' : ''}GIS Workbench Mensuration Log\r\n${csv}`, 'text/csv'), { name: 'mensuration-log.csv', types: ['.csv'], description: 'CSV' });
  };
  const exportJson = async () => {
    const data = { kind: 'gisworkbench-mensuration-log', version: 1, build: app.build.id, marking: app.screenMarking(), rows: app.store.all('measurement') };
    await saveBlob(app, textBlob(JSON.stringify(data, null, 2), 'application/json'), { name: 'mensuration-log.json', types: ['.json'], description: 'JSON' });
  };
  for (const [label, fn] of [['Export CSV', exportCsv], ['Export JSON', exportJson]]) {
    const b = h('button', { class: 'btn btn-small' }, label);
    b.addEventListener('click', fn);
    bar.appendChild(b);
  }
  const render = () => {
    clear(wrap);
    const ms = app.store.all('measurement');
    const t = h('table', { class: 'grid-table menlog', role: 'grid', 'aria-label': 'Mensuration Log' });
    t.appendChild(h('thead', {}, h('tr', {}, MENLOG_COLUMNS.map(([, l]) => h('th', { scope: 'col' }, l)), h('th', {}, ''))));
    const tb = h('tbody');
    for (const m of ms) {
      const r = menRow(m);
      const obj = h('input', { class: 'cell-input', value: m.object ?? '', placeholder: 'N/A', 'aria-label': `Object for ${m.mid}`, spellcheck: 'true' });
      obj.addEventListener('change', () => app.store.transact('Rename measurement', (tx) => tx.set(m.id, 'object', obj.value)));
      const del = h('button', { class: 'icon-btn', 'aria-label': `Delete ${m.mid}`, title: 'Delete' }, icon('delete', 14));
      del.addEventListener('click', () => app.store.transact(`Delete ${m.mid}`, (tx) => tx.delete(m.id)));
      tb.appendChild(h('tr', { 'data-id': `measurement:${m.id}` }, MENLOG_COLUMNS.map(([k]) => h('td', { class: `c-${k}` }, k === 'object' ? obj : r[k])), h('td', {}, del)));
    }
    t.appendChild(tb);
    wrap.appendChild(ms.length ? t : h('p', { class: 'muted pad' }, 'No measurements yet. Use Draw ▸ Mensuration (Point Position, Range & Bearing, Length, Area).'));
  };
  app.on('state', render);
  render();
  return { onShow: render };
}

function jobQueue(app, el) {
  const wrap = h('div', { class: 'grid-wrap' });
  el.appendChild(wrap);
  let t = 0;
  const render = () => {
    t = 0;
    clear(wrap);
    const running = [...app.pool.jobs.values()];
    const tbl = h('table', { class: 'grid-table', 'aria-label': 'Job Queue' }, h('thead', {}, h('tr', {}, ['Job', 'State', 'Progress', 'Time (ms)', ''].map((x) => h('th', {}, x)))));
    const tb = h('tbody');
    for (const j of running) {
      const c = h('button', { class: 'btn btn-small' }, 'Cancel');
      c.addEventListener('click', () => app.pool.cancel(j.id));
      tb.appendChild(h('tr', {}, h('td', {}, j.label), h('td', {}, j.state), h('td', {}, `${Math.round((j.progress ?? 0) * 100)} %`), h('td', {}, String(Math.round(performance.now() - j.created))), h('td', {}, c)));
    }
    for (const j of app.pool.history.slice(0, 40)) {
      if (j.op === 'tile' && j.state === 'done') continue;
      tb.appendChild(h('tr', { class: j.state }, h('td', {}, j.label), h('td', {}, `${j.state}${j.trapped ? ' (WASM trap, module restarted)' : ''}${j.error ? `: ${j.error}` : ''}`), h('td', {}, ''), h('td', {}, String(Math.round(j.ms))), h('td', {}, '')));
    }
    tbl.appendChild(tb);
    wrap.appendChild(tbl);
  };
  app.pool.on('job', () => {
    if (!t) t = setTimeout(render, 250);
  });
  render();
}

function netLog(app, el) {
  const wrap = h('div', { class: 'grid-wrap' });
  el.appendChild(wrap);
  const render = () => {
    clear(wrap);
    const rows = app.netlog?.entries ?? [];
    wrap.appendChild(h('p', { class: 'hint pad' }, `connect-src allows: blob: ${(app.project()?.origins ?? []).join(' ') || '(no network origins added)'}. Every request the tool makes is listed here (REQ-SEC-12).`));
    if (!rows.length) return wrap.appendChild(h('p', { class: 'muted pad' }, 'No network requests have been made.'));
    const tbl = h('table', { class: 'grid-table' }, h('thead', {}, h('tr', {}, ['Time', 'Method', 'Origin', 'Path', 'Status', 'Bytes out', 'Bytes in', 'Purpose'].map((x) => h('th', {}, x)))));
    const tb = h('tbody');
    for (const r of rows) tb.appendChild(h('tr', {}, [r.time, r.method, r.origin, r.path, r.status, r.sent, r.received, r.purpose].map((x) => h('td', {}, String(x ?? '')))));
    tbl.appendChild(tb);
    wrap.appendChild(tbl);
  };
  app.on('netlog', render);
  render();
}

function importLog(app, el) {
  const wrap = h('div', { class: 'grid-wrap pad' });
  el.appendChild(wrap);
  const render = () => {
    clear(wrap);
    for (const r of [...app.importLog].reverse()) {
      wrap.appendChild(h('div', { class: 'import-entry' }, h('b', {}, r.file), r.ms ? ` (${r.kind}, ${r.ms} ms)` : '', h('ul', {}, ...(r.errors ?? []).map((e) => h('li', { class: 'err' }, e)), ...(r.warnings ?? []).map((w) => h('li', {}, w)))));
    }
    if (!app.importLog.length) wrap.appendChild(h('p', { class: 'muted' }, 'Nothing imported yet.'));
  };
  app.on('layers', render);
  render();
}
