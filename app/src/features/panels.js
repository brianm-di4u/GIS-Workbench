// Dock panels: Layer Manager (REQ-UI-18, REQ-UI-13), Mensuration Log (REQ-MEN-01, AC-02.2),
// Job Queue (REQ-ARC-06), Network Log (REQ-SEC-12), Cue Cards (REQ-UI-06) and Import Log.

import { h, clear, fmtNum } from '../shell/dom.js';
import { icon } from '../shell/icons.js';
import { openMenu } from '../shell/menu.js';
import { saveBlob, textBlob } from '../storage/files.js';
import { installTools } from '../tools/tools.js';
import { t, tr, N_, msgOf } from '../i18n/index.js';
import { int, num } from '../i18n/format.js';

// Job states as the Job Queue shows them (the pool's own values stay as they are).
const JOB_STATE = { queued: N_('queued'), dispatching: N_('dispatching'), recovering: N_('recovering'), running: N_('running'), done: N_('done'), failed: N_('failed') };
const jobState = (s) => (JOB_STATE[s] ? tr(JOB_STATE[s]) : s);

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
    D.register({ id: 'layers', title: t('Layer Manager'), icon: 'layers', home: 'left', create: (a, m, el) => layerManager(a, m, el) });
    D.register({ id: 'toolbox', title: t('ToolBox'), icon: 'toolbox', home: 'left', create: (a, m, el) => toolbox(a, el) });
    D.register({ id: 'cues', title: t('Cue Cards'), icon: 'help', home: 'left', create: (a, m, el) => cueCards(a, el) });
    D.register({ id: 'menlog', title: t('Mensuration Log'), icon: 'log', home: 'bottom', create: (a, m, el) => menLog(a, m, el) });
    D.register({ id: 'jobs', title: t('Job Queue'), icon: 'job', home: 'bottom', create: (a, m, el) => jobQueue(a, el) });
    D.register({ id: 'netlog', title: t('Network Log'), icon: 'network', home: 'bottom', create: (a, m, el) => netLog(a, el) });
    D.register({ id: 'importlog', title: t('Import Log'), icon: 'list', home: 'bottom', create: (a, m, el) => importLog(a, el) });
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
  const list = h('div', { class: 'lm-list', role: 'list', 'aria-label': t('Layers'), tabindex: '0' });
  el.append(head, list);
  const render = () => {
    clear(head);
    clear(list);
    const pane = mp.activePane;
    // A multiport closed by opening another project keeps no records: nothing to show.
    if (!pane?.rec || !app.desktop.multiports.includes(mp)) return;
    head.append(h('label', { class: 'fld fld-inline' }, h('span', {}, t('Active Panel:')), h('b', {}, t('Panel.{n}', { n: mp.panes.indexOf(pane) + 1 }))));
    const layers = pane.layers().slice().reverse();
    const active = pane.rec.activeLayer;
    if (pane.rec.graphicsLayer) {
      const gl = app.store.get(pane.rec.graphicsLayer);
      const n = app.store.all('graphic').filter((g) => g.pane === pane.id).length;
      const cb = h('input', { type: 'checkbox', checked: gl.visible !== false, 'aria-label': t('Show graphics') });
      cb.addEventListener('change', () => {
        app.store.transact(t('Graphics visibility'), (tx) => tx.set(gl.id, 'visible', cb.checked));
        pane.invalidate();
      });
      list.appendChild(h('div', { class: 'lm-row', role: 'listitem', 'data-id': `glayer:${gl.id}` }, cb, icon('polygon'), h('span', { class: 'lm-name' }, `${gl.saved === false ? '*' : ''}${t('Graphics [{n} displayed]', { n: int(n) })}`)));
    }
    for (const l of layers) {
      const rec = l.rec;
      const cb = h('input', { type: 'checkbox', checked: rec.visible !== false, 'aria-label': t('Show {layer}', { layer: rec.name }) });
      cb.addEventListener('change', () => app.store.transact(t('Layer visibility'), (tx) => tx.set(l.id, 'visible', cb.checked)));
      const op = h('input', { type: 'range', min: '0', max: '100', value: String(Math.round((rec.opacity ?? 1) * 100)), class: 'lm-opacity', 'aria-label': t('Opacity of {layer}', { layer: rec.name }), title: t('Opacity') });
      op.addEventListener('input', () => app.store.transact(t('Layer opacity'), (tx) => tx.set(l.id, 'opacity', +op.value / 100), { mergeKey: `opacity:${l.id}` }));
      op.addEventListener('change', () => app.undo.seal());
      const role = l.id === active ? ` ${t('(M)')}` : '';
      const row = h(
        'div',
        { class: ['lm-row', l.id === active && 'active'], role: 'listitem', 'aria-current': l.id === active ? 'true' : null, 'data-id': `layer:${l.id}` },
        cb,
        icon(l.kind === 'dem' ? 'terrain' : 'image'),
        h('span', { class: ['lm-name', l.error && 'lm-error'], title: l.error ? `${rec.name}: ${l.error}` : rec.name }, `${rec.saved === false ? '*' : ''}${rec.name} [${l.info.format}]${role}${l.error ? ` — ${t('not displayable')}` : ''}`),
        op,
      );
      row.addEventListener('click', (e) => {
        if (e.target === cb || e.target === op) return;
        app.store.transact(t('Set active layer'), (tx) => tx.set(pane.id, 'activeLayer', l.id), { kind: 'load' });
        app.selectedLayerId = l.id;
        app.emit('state');
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openMenu(
          [
            { label: t('Set Active'), run: () => app.store.transact(t('Set active layer'), (tx) => tx.set(pane.id, 'activeLayer', l.id)) },
            { label: t('Zoom to Layer'), run: () => pane.fitWhole() },
            ...(l.bands === 1 && l.kind !== 'dem' && (l.sampleType === 'f32' || l.sampleType === 'i16') && l.modelId ? [{ label: t('Use as Terrain…'), run: () => app.terrainDialog?.(l) }] : []),
            { label: t('Metadata…'), run: () => app.showMetadata(l) },
            '-',
            { label: t('Move Up'), run: () => moveLayer(app, pane, l.id, 1) },
            { label: t('Move Down'), run: () => moveLayer(app, pane, l.id, -1) },
            '-',
            { label: t('Remove'), run: () => removeLayer(app, pane, l.id) },
          ],
          app,
          { x: e.clientX, y: e.clientY },
        );
      });
      list.appendChild(row);
    }
    if (!layers.length) list.appendChild(h('p', { class: 'muted pad' }, t('No layers. Open an image (File ▸ Open Image) or drop files on the panel.')));
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
  app.store.transact(t('Draw order'), (tx) => tx.set(pane.id, 'layers', ids));
}

export function removeLayer(app, pane, id) {
  const l = app.layers.get(id);
  app.store.transact(t('Remove {layer}', { layer: l?.rec?.name ?? t('layer') }), (tx) => {
    tx.set(pane.id, 'layers', pane.rec.layers.filter((x) => x !== id));
    if (pane.rec.activeLayer === id) tx.set(pane.id, 'activeLayer', pane.rec.layers.at(-1) ?? null);
  });
  app.emit('layers');
}

function toolbox(app, el) {
  el.append(
    h('div', { class: 'tb-drawer' }, h('div', { class: 'tb-drawer-head' }, t('Graphics')), h('div', { class: 'tb-grid' }, ['draw.point', 'draw.line', 'draw.polyline', 'draw.polygon', 'draw.rect', 'draw.circle', 'draw.arrow', 'draw.text', 'draw.callout', 'draw.marker'].map((id) => tbBtn(app, id)))),
    h('div', { class: 'tb-drawer' }, h('div', { class: 'tb-drawer-head' }, t('Mensuration')), h('div', { class: 'tb-grid' }, ['men.point', 'men.rangebearing', 'men.length', 'men.area'].map((id) => tbBtn(app, id)))),
    app.extractDrawer?.() ?? null,
    h('p', { class: 'hint pad' }, t('Double-click a tool (or tick Repeat) to keep it active until Esc. Schemas and attribute forms arrive in R2 (REQ-EXT-09).')),
  );
}

function tbBtn(app, id) {
  const c = app.commands.get(id);
  const b = h('button', { class: 'tb-tool', title: tr(c.label), 'aria-label': tr(c.label), 'data-id': `cmd:${id}` }, icon(c.icon, 24));
  b.addEventListener('click', () => app.commands.run(id));
  b.addEventListener('dblclick', () => c.sticky?.());
  return b;
}

function cueCards(app, el) {
  const body = h('div', { class: 'cue pad' });
  el.appendChild(body);
  const render = () => {
    clear(body);
    const tool = app.tools?.current;
    body.append(
      h('h3', {}, tool ? tr(app.commands.get(tool.id)?.label) ?? tool.id : t('Getting started')),
      h('p', {}, app.cueText && tool ? app.cueText : t('Open an image with File ▸ Open Image (Ctrl+O) or drop files on the panel. Wheel zooms about the cursor; hold the middle button to roam; drag with the left button to pan; double-click centres and zooms. W shows the whole scene; F7 toggles full roam; Esc ends a tool. F1 opens help.')),
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
    const rows = app.store.all('measurement').map((m) => menRow(m, { machine: true })); // English, '.' decimals
    const csv = toCsv([MENLOG_COLUMNS.map((c) => c[1]), ...rows.map((r) => MENLOG_COLUMNS.map(([k]) => r[k]))]);
    await saveBlob(app, textBlob(`# GIS Workbench Mensuration Log\r\n${csv}`, 'text/csv'), { name: 'mensuration-log.csv', types: ['.csv'], description: 'CSV' });
  };
  const exportJson = async () => {
    const data = { kind: 'gisworkbench-mensuration-log', version: 1, build: app.build.id, rows: app.store.all('measurement') };
    await saveBlob(app, textBlob(JSON.stringify(data, null, 2), 'application/json'), { name: 'mensuration-log.json', types: ['.json'], description: 'JSON' });
  };
  for (const [label, fn] of [[t('Export CSV'), exportCsv], [t('Export JSON'), exportJson]]) {
    const b = h('button', { class: 'btn btn-small' }, label);
    b.addEventListener('click', fn);
    bar.appendChild(b);
  }
  const render = () => {
    clear(wrap);
    const ms = app.store.all('measurement');
    const tbl = h('table', { class: 'grid-table menlog', role: 'grid', 'aria-label': t('Mensuration Log') });
    tbl.appendChild(h('thead', {}, h('tr', {}, MENLOG_COLUMNS.map(([, l]) => h('th', { scope: 'col' }, tr(l))), h('th', {}, ''))));
    const tb = h('tbody');
    for (const m of ms) {
      const r = menRow(m);
      const obj = h('input', { class: 'cell-input', value: m.object ?? '', placeholder: t('N/A'), 'aria-label': t('Object for {id}', { id: m.mid }), spellcheck: 'true' });
      obj.addEventListener('change', () => app.store.transact(t('Rename measurement'), (tx) => tx.set(m.id, 'object', obj.value)));
      const del = h('button', { class: 'icon-btn', 'aria-label': t('Delete {id}', { id: m.mid }), title: t('Delete') }, icon('delete', 14));
      del.addEventListener('click', () => app.store.transact(t('Delete {id}', { id: m.mid }), (tx) => tx.delete(m.id)));
      tb.appendChild(h('tr', { 'data-id': `measurement:${m.id}` }, MENLOG_COLUMNS.map(([k]) => h('td', { class: `c-${k}` }, k === 'object' ? obj : r[k])), h('td', {}, del)));
    }
    tbl.appendChild(tb);
    wrap.appendChild(ms.length ? tbl : h('p', { class: 'muted pad' }, t('No measurements yet. Use Draw ▸ Mensuration (Point Position, Range & Bearing, Length, Area).')));
  };
  app.on('state', render);
  render();
  return { onShow: render };
}

function jobQueue(app, el) {
  const wrap = h('div', { class: 'grid-wrap' });
  el.appendChild(wrap);
  let timer = 0;
  const render = () => {
    timer = 0;
    clear(wrap);
    const running = [...app.pool.jobs.values()];
    // Network throughput over the last 3 s (remote reads, tiles, catalogues) (REQ-ING-02).
    const now = Date.now();
    const recent = (app.netlog?.entries ?? []).filter((e) => e.at && now - e.at < 3000);
    const mbps = recent.reduce((a, e) => a + (Number(e.received) || 0), 0) / 3 / 1048576;
    const counts = { running: int(running.length), queued: int(app.pool.queue?.length ?? 0) };
    wrap.appendChild(h('div', { class: 'jobs-head small' }, mbps > 0.01 ? t('{running} running · {queued} queued · network {rate} MB/s', { ...counts, rate: num(mbps, 1) }) : t('{running} running · {queued} queued', counts)));
    const tbl = h('table', { class: 'grid-table', 'aria-label': t('Job Queue') }, h('thead', {}, h('tr', {}, [t('Job'), t('State'), t('Progress'), t('Time (ms)'), ''].map((x) => h('th', {}, x)))));
    const tb = h('tbody');
    const eta = (ms) => (ms > 90000 ? t('{n} min left', { n: int(Math.round(ms / 60000)) }) : ms > 1500 ? t('{n} s left', { n: int(Math.round(ms / 1000)) }) : '');
    // Long local-AI jobs made of many worker jobs (whole-scene detection, model runs; REQ-GAP-56).
    for (const k of app.aiTasks?.() ?? []) {
      const c = h('button', { class: 'btn btn-small', 'data-id': `job:cancel:${k.id}` }, t('Cancel'));
      c.addEventListener('click', () => k.cancel());
      const pc = Math.round((k.progress ?? 0) * 100);
      tb.appendChild(h('tr', {}, h('td', {}, k.label), h('td', {}, jobState('running')), h('td', { class: 'job-progress' }, h('progress', { max: '100', value: String(pc), 'aria-label': t('{job} progress', { job: k.label }) }), ` ${t('{pct} %', { pct: int(pc) })}`), h('td', {}, ''), h('td', {}, c)));
    }
    for (const j of running) {
      const c = h('button', { class: 'btn btn-small' }, t('Cancel'));
      c.addEventListener('click', () => app.pool.cancel(j.id));
      const known = j.progress > 0;
      const pc = Math.round((j.progress ?? 0) * 100);
      // A job that reports no progress has no percentage: an indeterminate bar, not a false 0 %.
      const bar = h('progress', { ...(known ? { max: '100', value: String(pc) } : {}), 'aria-label': t('{job} progress', { job: j.label }) });
      const pct = known ? ` ${j.eta ? t('{pct} % · {eta}', { pct: int(pc), eta: eta(j.eta) }) : t('{pct} %', { pct: int(pc) })}` : '';
      tb.appendChild(h('tr', {}, h('td', {}, j.label), h('td', {}, jobState(j.state)), h('td', { class: 'job-progress' }, bar, pct), h('td', { 'data-started': String(j.created) }, int(Math.round(performance.now() - j.created))), h('td', {}, c)));
    }
    for (const a of app.activity?.tracked.values() ?? []) {
      const known = a.progress > 0;
      const pc = Math.round((a.progress || 0) * 100);
      const bar = h('progress', { ...(known ? { max: '100', value: String(pc) } : {}), 'aria-label': t('{job} progress', { job: a.label }) });
      const c = a.cancel ? h('button', { class: 'btn btn-small' }, t('Cancel')) : '';
      if (c) c.addEventListener('click', () => a.cancel());
      tb.appendChild(h('tr', {}, h('td', {}, a.label), h('td', {}, jobState('running')), h('td', { class: 'job-progress' }, bar, known ? ` ${t('{pct} %', { pct: int(pc) })}` : ''), h('td', { 'data-started': String(a.started) }, int(Math.round(performance.now() - a.started))), h('td', {}, c)));
    }
    for (const j of app.pool.history.slice(0, 40)) {
      if (j.op === 'tile' && j.state === 'done') continue;
      let act = '';
      if (j.retry) {
        act = h('button', { class: 'btn btn-small', 'data-id': `job:retry:${j.id}` }, t('Retry'));
        act.addEventListener('click', () => {
          const f = j.retry;
          j.retry = null;
          if (f?.remoteId) app.toast(t('Open the address again from the Catalog to retry a remote file.'), { kind: 'info' });
          else app.openFiles([f]);
          render();
        });
      }
      const st = j.trapped ? t('{state} (WASM trap, module restarted)', { state: jobState(j.state) }) : jobState(j.state);
      tb.appendChild(h('tr', { class: j.state }, h('td', {}, j.label), h('td', {}, j.error ? t('{state}: {msg}', { state: st, msg: msgOf({ message: j.error, i18n: j.i18n }) }) : st), h('td', {}, ''), h('td', {}, int(Math.round(j.ms))), h('td', {}, act)));
    }
    tbl.appendChild(tb);
    wrap.appendChild(tbl);
  };
  app.pool.on('job', () => {
    if (!timer) timer = setTimeout(render, 250);
  });
  app.on('activity', () => {
    if (!timer) timer = setTimeout(render, 250);
  });
  // The time column keeps counting for a job that reports nothing; only the cells change, so a
  // Cancel button keeps its focus.
  setInterval(() => {
    if (!wrap.isConnected) return;
    for (const td of wrap.querySelectorAll('td[data-started]')) td.textContent = int(Math.round(performance.now() - Number(td.dataset.started)));
  }, 1000);
  render();
}

function netLog(app, el) {
  const wrap = h('div', { class: 'grid-wrap' });
  el.appendChild(wrap);
  const render = () => {
    clear(wrap);
    const rows = app.netlog?.entries ?? [];
    wrap.appendChild(h('p', { class: 'hint pad' }, t('connect-src allows: blob: {origins}. Every request the tool makes is listed here (REQ-SEC-12).', { origins: (app.project()?.origins ?? []).join(' ') || t('(no network origins added)') })));
    if (!rows.length) return wrap.appendChild(h('p', { class: 'muted pad' }, t('No network requests have been made.')));
    const tbl = h('table', { class: 'grid-table' }, h('thead', {}, h('tr', {}, [t('Time'), t('Method'), t('Origin'), t('Path'), t('Status'), t('Bytes out'), t('Bytes in'), t('Purpose'), t('Sign-in')].map((x) => h('th', {}, x)))));
    const tb = h('tbody');
    // Sign-in column (REQ-GAP-10): which requests carried the browser's sign-in or a token (never the token itself).
    const authLabel = (a) => (a ? t('{how, select, browser {your sign-in} bearer {token} other {your sign-in and token}}', { how: a }) : '');
    for (const r of rows) tb.appendChild(h('tr', {}, [r.time, r.method, r.origin, r.path, r.status, r.sent, r.received, r.purpose, authLabel(r.auth)].map((x) => h('td', {}, String(x ?? '')))));
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
      wrap.appendChild(h('div', { class: 'import-entry' }, h('b', {}, r.file), r.ms ? ` ${t('({kind}, {ms} ms)', { kind: r.kind, ms: int(r.ms) })}` : '', h('ul', {}, ...(r.errors ?? []).map((e) => h('li', { class: 'err' }, e)), ...(r.warnings ?? []).map((w) => h('li', {}, w)))));
    }
    if (!app.importLog.length) wrap.appendChild(h('p', { class: 'muted' }, t('Nothing imported yet.')));
  };
  app.on('layers', render);
  render();
}
