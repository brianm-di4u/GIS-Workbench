// Workspace window (REQ-UI-01, Appendix C §2): menu bar, toolbar, Data View, Windows View,
// Preview, Map View and a one-row status bar.

import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { menuBar } from './menu.js';
import { WORKSPACE_MENUS } from './ribbon-data.js';
import { MapPane } from './mappane.js';
import { fmtBytes } from '../core/util.js';

export class Workspace {
  constructor(app) {
    this.app = app;
    this.view = 'data';
    const menus = WORKSPACE_MENUS.map((m) => (m.label === 'Window' ? { ...m, items: () => app.windowMenu() } : m));
    const toolbar = h('div', { class: 'ws-toolbar', role: 'toolbar', 'aria-label': 'Workspace toolbar' });
    for (const [id, ic] of [['file.newproject', 'new'], ['file.openimage', 'open'], ['file.save', 'save'], ['edit.copy', 'copy'], ['help.topics', 'help']]) {
      const c = app.commands.get(id);
      const b = h('button', { class: 'tb-btn', title: c.label, 'aria-label': c.label, 'data-id': `ws:${id}` }, icon(ic));
      b.addEventListener('click', () => app.commands.run(id));
      toolbar.appendChild(b);
    }
    this.viewTabs = h('div', { class: 'ws-viewtabs', role: 'tablist' });
    for (const [v, label] of [['data', 'Data View'], ['windows', 'Windows View']]) {
      const b = h('button', { class: 'ws-viewtab', role: 'tab', 'data-view': v, 'data-id': `ws:view:${v}` }, label);
      b.addEventListener('click', () => this.setView(v));
      this.viewTabs.appendChild(b);
    }
    this.tree = h('div', { class: 'ws-tree', role: 'treegrid', 'aria-label': 'Workspace items', tabindex: '0' });
    this.preview = h('div', { class: 'ws-preview', 'aria-label': 'Preview' }, h('div', { class: 'ws-preview-title' }, 'Preview'), h('div', { class: 'ws-preview-body' }, 'Select an item to see its metadata.'));
    const upper = h('div', { class: 'ws-upper' }, h('div', { class: 'ws-left' }, this.viewTabs, this.tree), this.preview);
    this.mapHost = h('div', { class: 'ws-map-host' });
    const mapTools = h('div', { class: 'ws-maptools', role: 'toolbar', 'aria-label': 'Map View toolbar' });
    for (const [label, ic, fn] of [
      ['Whole world', 'globe', () => this.map.zoomTo(20, 0, 2)],
      ['Zoom to data', 'whole', () => this.map.zoomToFootprints()],
      ['Zoom in', 'zoomin', () => this.map.zoomTo(this.map.view.lat, this.map.view.lon, this.map.view.zoom * 1.5)],
      ['Zoom out', 'zoomout', () => this.map.zoomTo(this.map.view.lat, this.map.view.lon, this.map.view.zoom / 1.5)],
    ]) {
      const b = h('button', { class: 'tb-btn', title: label, 'aria-label': label }, icon(ic));
      b.addEventListener('click', fn);
      mapTools.appendChild(b);
    }
    this.mapLegend = h('div', { class: 'ws-maplegend' }, ...['Images', 'Terrain', 'Maps and Charts', 'Vectors'].map((n, i) => h('label', { class: `ml ml-${i}` }, h('input', { type: 'checkbox', checked: true, disabled: true }), n)));
    this.bottomTabs = h('div', { class: 'ws-bottomtabs', role: 'tablist' }, h('button', { class: 'ws-btab active', role: 'tab', 'aria-selected': 'true' }, 'Map View'), h('button', { class: 'ws-btab', role: 'tab', 'aria-selected': 'false', 'data-id': 'ws:online' }, 'Online Sources'));
    this.bottomTabs.lastChild.addEventListener('click', () => app.commands.run('online.add'));
    const lower = h('div', { class: 'ws-lower' }, h('div', { class: 'ws-mapside' }, mapTools, this.mapLegend), this.mapHost);
    this.status = h('div', { class: 'statusbar ws-status', role: 'status' }, h('div', { class: 'status-row' }, h('div', { class: 'status-cell' }, 'Geographic | WGS_84 | MSL(EGM96)'), h('div', { class: 'status-cell ws-jobs' }, '')));
    this.title = h('span', { class: 'gwin-title-text' }, 'GIS Workbench — Workspace');
    const titleBar = h('div', { class: 'gwin-title', 'data-id': 'win:workspace:title' }, icon('app', 16), this.title);
    titleBar.addEventListener('dblclick', () => app.desktop.toggleMaximise(this));
    this.el = h('section', { class: 'gwin workspace', 'aria-label': 'Workspace', 'data-id': 'win:workspace' }, titleBar, menuBar(menus, app), toolbar, upper, h('div', { class: 'splitter splitter-h ws-split' }), this.bottomTabs, lower, this.status);
    this.map = new MapPane(app, this.mapHost);
    for (const ev of ['layers', 'state', 'terrain']) app.on(ev, () => this.render());
    app.pool.on('job', () => this.renderJobs());
    this.setView('data');
  }

  setView(v) {
    this.view = v;
    for (const b of this.viewTabs.children) {
      b.classList.toggle('active', b.dataset.view === v);
      b.setAttribute('aria-selected', String(b.dataset.view === v));
    }
    this.render();
  }

  render() {
    clear(this.tree);
    const app = this.app;
    const row = (cells, { level = 0, onClick, id, selected } = {}) => {
      const r = h('div', { class: ['ws-row', selected && 'selected'], role: 'row', 'aria-level': String(level + 1), tabindex: '-1', 'data-id': id ?? null }, ...cells.map((c, i) => h('div', { class: `ws-cell c${i}`, role: 'gridcell', style: i === 0 ? { paddingLeft: `${6 + level * 16}px` } : null }, c)));
      if (onClick) {
        r.addEventListener('click', onClick);
        r.addEventListener('keydown', (e) => e.key === 'Enter' && onClick());
      }
      this.tree.appendChild(r);
      return r;
    };
    if (this.view === 'data') {
      this.tree.appendChild(h('div', { class: 'ws-row ws-head', role: 'row' }, ...['Name', 'Date', 'Type', 'Size (KB)'].map((t, i) => h('div', { class: `ws-cell c${i}`, role: 'columnheader' }, t))));
      row([h('b', {}, 'Workspace (Data View)'), '', '', ''], { level: 0 });
      for (const f of app.store.all('fileref')) {
        row([f.name, '', f.kind, Math.round(f.size / 1024).toLocaleString()], { level: 1, id: `file:${f.id}` });
        for (const l of app.store.all('layer').filter((x) => x.file === f.id)) {
          const rt = app.layers.get(l.id);
          row([`${l.saved === false ? '' : ''}${l.name}`, fmtDate(rt?.info.datetime), rt ? `${rt.info.format} ${rt.width}×${rt.height}×${rt.bands} ${rt.sampleType}` : l.kind, ''], {
            level: 2,
            id: `layer:${l.id}`,
            selected: app.selectedLayerId === l.id,
            onClick: () => this.select(l.id),
          });
        }
      }
      if (!app.store.all('fileref').length) row([h('i', {}, 'No data yet. Open an image, or drop files on a panel.'), '', '', ''], { level: 1 });
    } else {
      row([h('b', {}, 'Workspace (Windows View)')], { level: 0 });
      for (const mp of app.desktop.multiports) {
        row([`${mp.rec.name} (${app.markingSuffix(mp)})`], { level: 1, id: `win:${mp.id}`, onClick: () => app.desktop.focus(mp) });
        mp.panes.forEach((p, i) => {
          row([`Panel.${i + 1}`], { level: 2, id: `pane:${p.id}`, onClick: () => mp.setActivePane(p) });
          for (const l of p.layers().reverse()) row([`${l.rec.saved === false ? '*' : ''}${l.rec.name}`], { level: 3, id: `layer:${l.id}`, onClick: () => this.select(l.id) });
        });
      }
    }
    this.renderPreview();
  }

  select(layerId) {
    this.app.selectedLayerId = layerId;
    this.render();
    this.app.renderer.invalidate();
  }

  renderPreview() {
    const body = this.preview.querySelector('.ws-preview-body');
    clear(body);
    const l = this.app.layers.get(this.app.selectedLayerId);
    // A layer an undo or Remove took out of the store keeps its runtime for a redo: not selectable.
    if (!l?.rec) {
      body.appendChild(h('p', { class: 'muted' }, 'Select an item to see its metadata.'));
      return;
    }
    const kv = (k, v) => h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v ?? '–'));
    const fp = l.footprint();
    body.append(
      kv('Name', l.rec.name),
      kv('Format', l.info.format),
      kv('Size', `${l.width} × ${l.height} px, ${l.bands} band${l.bands > 1 ? 's' : ''}, ${l.sampleType}`),
      kv('Image ID', l.info.iid),
      kv('Date/time', fmtDate(l.info.datetime)),
      kv('Marking', l.info.marking?.raw ? `${l.info.marking.raw} (${l.info.marking.source})` : 'none in file'),
      kv('Sensor model', l.modelName),
      kv('Footprint', fp ? fp.map(([a, b]) => `${a.toFixed(4)}, ${b.toFixed(4)}`).join(' · ') : 'unknown'),
      kv('File', `${l.info.fileName} (${fmtBytes(this.app.files.get(l.rec.file)?.file.size)})`),
    );
    const btn = h('button', { class: 'btn btn-small' }, 'Metadata…');
    btn.addEventListener('click', () => this.app.showMetadata(l));
    body.appendChild(btn);
  }

  renderJobs() {
    const s = this.app.pool.stats();
    const c = this.status.querySelector('.ws-jobs');
    c.textContent = s.running || s.queued ? `Jobs: ${s.running} running, ${s.queued} queued` : '';
  }
}

export function fmtDate(s) {
  if (!s) return '';
  const t = String(s).trim();
  // NITF CCYYMMDDhhmmss → ISO-like display (UTC).
  if (/^\d{14}$/.test(t)) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}Z`;
  return t;
}
