// Feedback whiteboard (REQ-WB-01..10, 14, 15): a see-through drawing layer over the whole
// application, toggled by B, the Add-Ins Ribbon or the QAT button (with the page count);
// Esc leaves. While open a key shield keeps drawing keys from the application. Pins link to
// application items by stable data-id and can jump to them or show "gone".

import { h, clear } from '../shell/dom.js';
import { icon } from '../shell/icons.js';
import { Marks, TOOLS, COLOURS, WIDTHS, constrain, newPage } from './model.js';
import { composePage } from './capture.js';
import { openReview, importFeedback } from './review.js';
import { chainSummary } from '../render/chain.js';
import { bannerText } from '../security/marking.js';

const TOOL_ICON = { interact: 'select', pen: 'pen', highlight: 'highlight', arrow: 'arrow', rect: 'rect', ellipse: 'ellipse', text: 'text', pin: 'pin', erase: 'eraser' };
const KEY_OF = Object.fromEntries(Object.entries(TOOLS).map(([k, v]) => [v, k]));

export class Whiteboard {
  constructor(app) {
    this.app = app;
    this.active = false;
    this.tool = 'pen';
    this.colour = 0;
    this.width = 1;
    this.marks = new Marks(200);
    this.pages = [];
    this.captureState = {};
    this.method = app.prefs.get('wbCapture') ?? 'auto';
    this.canvas = h('canvas', { class: 'wb-canvas', 'aria-label': 'Feedback whiteboard drawing layer' });
    this.bar = this._toolbar();
    this.el = h('div', { class: 'wb-overlay', hidden: true, 'data-id': 'wb:overlay', role: 'region', 'aria-label': 'Feedback whiteboard' }, this.canvas, this.bar);
    document.body.appendChild(this.el);
    this._bind();
    window.addEventListener('resize', () => this.active && this.redraw());
  }

  pageCount() {
    return this.pages.length;
  }

  // ---- open/close ----
  toggle(on = !this.active) {
    this.active = on;
    this.el.hidden = !on;
    document.body.classList.toggle('wb-on', on);
    if (on) {
      this.redraw();
      this.setTool(this.tool);
      this.app.toast('Whiteboard on: draw on the application. V interacts, N pins an item, Capture saves a page, Esc leaves.', { ms: 4500 });
    } else if (this.captureState.stream) {
      for (const t of this.captureState.stream.getTracks()) t.stop();
      this.captureState.stream = null;
    }
    this.app.emit('state');
  }

  /** Key shield (REQ-WB-01): returns true when the whiteboard consumed the key. */
  handlesKey(e) {
    if (e.target.closest?.('.wb-bar input, .wb-bar textarea, .dlg')) return false;
    const k = e.key.toUpperCase();
    const mod = e.ctrlKey || e.metaKey;
    let used = true;
    if (e.key === 'Escape') this.toggle(false);
    else if (mod && k === 'Z' && e.shiftKey) this.marks.redo();
    else if (mod && k === 'Z') this.marks.undo();
    else if (mod && k === 'Y') this.marks.redo();
    else if (!mod && TOOLS[k]) this.setTool(TOOLS[k]);
    else if (!mod && /^[1-6]$/.test(e.key)) this.setColour(+e.key - 1);
    else if (!mod && k === 'B') this.toggle(false);
    else if (!mod && (e.key === '[' || e.key === ']')) this.setWidth(Math.max(0, Math.min(2, this.width + (e.key === ']' ? 1 : -1))));
    else used = this.tool !== 'interact' && !mod;
    if (used) {
      e.preventDefault();
      e.stopPropagation();
      this.redraw();
      this._syncBar();
    }
    return used || this.tool !== 'interact';
  }

  setTool(t) {
    this.tool = t;
    // Interact passes pointer events through to the application.
    this.canvas.style.pointerEvents = t === 'interact' ? 'none' : 'auto';
    this.canvas.style.cursor = t === 'erase' ? 'not-allowed' : t === 'text' ? 'text' : 'crosshair';
    this._syncBar();
  }

  setColour(i) {
    this.colour = i;
    this._syncBar();
  }

  setWidth(i) {
    this.width = i;
    this._syncBar();
  }

  // ---- toolbar ----
  _toolbar() {
    const bar = h('div', { class: 'wb-bar', role: 'toolbar', 'aria-label': 'Whiteboard tools' });
    this.toolBtns = {};
    for (const t of ['interact', 'pen', 'highlight', 'arrow', 'rect', 'ellipse', 'text', 'pin', 'erase']) {
      const b = h('button', { class: 'wb-btn', title: `${t[0].toUpperCase()}${t.slice(1)} (${KEY_OF[t]})`, 'aria-label': t, 'aria-pressed': 'false', 'data-id': `wb:tool:${t}` }, icon(TOOL_ICON[t], 18));
      b.addEventListener('click', () => this.setTool(t));
      this.toolBtns[t] = b;
      bar.appendChild(b);
    }
    bar.appendChild(h('span', { class: 'wb-sep' }));
    this.colourBtns = COLOURS.map((c, i) => {
      const b = h('button', { class: 'wb-colour', style: { background: c }, title: `Colour ${i + 1}`, 'aria-label': `Colour ${i + 1}`, 'aria-pressed': 'false' });
      b.addEventListener('click', () => this.setColour(i));
      bar.appendChild(b);
      return b;
    });
    bar.appendChild(h('span', { class: 'wb-sep' }));
    this.widthBtns = WIDTHS.map((w, i) => {
      const b = h('button', { class: 'wb-width', title: `Width ${w}`, 'aria-label': `Width ${w}`, 'aria-pressed': 'false' }, h('span', { style: { height: `${w}px` } }));
      b.addEventListener('click', () => this.setWidth(i));
      bar.appendChild(b);
      return b;
    });
    bar.appendChild(h('span', { class: 'wb-sep' }));
    const mk = (label, title, fn, id) => {
      const b = h('button', { class: 'btn btn-small', title, 'data-id': id }, label);
      b.addEventListener('click', fn);
      bar.appendChild(b);
      return b;
    };
    mk('Undo', 'Undo mark (Ctrl+Z)', () => {
      this.marks.undo();
      this.redraw();
    }, 'wb:undo');
    mk('Clear', 'Clear all marks', () => {
      this.marks.clear();
      this.redraw();
    }, 'wb:clear');
    this.captureBtn = mk('Capture page', 'Capture screenshot + marks + notes as a page', () => this.capture(), 'wb:capture');
    this.reviewBtn = mk('Review & Send (0)', 'Review pages and export', () => openReview(this.app, this), 'wb:review');
    const method = h('select', { class: 'wb-method', title: 'Capture method', 'aria-label': 'Capture method' }, h('option', { value: 'auto' }, 'Tab capture, else snapshot'), h('option', { value: 'snapshot' }, 'Rendered snapshot'), h('option', { value: 'marks' }, 'Marks only'));
    method.value = this.method;
    method.addEventListener('change', () => {
      this.method = method.value;
      this.app.prefs.set('wbCapture', this.method);
    });
    bar.appendChild(method);
    mk('Close', 'Leave the whiteboard (Esc)', () => this.toggle(false), 'wb:close');
    return bar;
  }

  _syncBar() {
    for (const [t, b] of Object.entries(this.toolBtns)) b.setAttribute('aria-pressed', String(t === this.tool));
    this.colourBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(i === this.colour)));
    this.widthBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(i === this.width)));
    this.reviewBtn.textContent = `Review & Send (${this.pages.length})`;
  }

  // ---- drawing ----
  _bind() {
    const c = this.canvas;
    let cur = null;
    const pt = (e) => ({ x: e.clientX, y: e.clientY });
    c.addEventListener('pointerdown', async (e) => {
      if (this.tool === 'interact') return;
      c.setPointerCapture(e.pointerId);
      const p = pt(e);
      const style = { color: COLOURS[this.colour], width: WIDTHS[this.width] };
      if (this.tool === 'erase') {
        const hit = this._hit(p);
        if (hit) this.marks.remove(hit.id);
        this.redraw();
        return;
      }
      if (this.tool === 'pin') {
        const target = this.elementAt(p);
        this.marks.add({ tool: 'pin', ...style, points: [p], target, note: '' });
        this.redraw();
        return;
      }
      if (this.tool === 'text') {
        const text = await this._textInput(p);
        if (text) this.marks.add({ tool: 'text', ...style, points: [p], text });
        this.redraw();
        return;
      }
      cur = { tool: this.tool, ...style, points: [p] };
    });
    c.addEventListener('pointermove', (e) => {
      if (!cur) return;
      let p = pt(e);
      if (cur.tool === 'pen' || cur.tool === 'highlight') cur.points.push(p);
      else {
        if (e.shiftKey) p = constrain(cur.tool, cur.points[0], p);
        cur.points[1] = p;
      }
      this.redraw(cur);
    });
    c.addEventListener('pointerup', () => {
      if (cur && cur.points.length > 1) this.marks.add(cur);
      cur = null;
      this.redraw();
    });
  }

  _textInput(p) {
    return new Promise((resolve) => {
      const inp = h('input', { class: 'wb-text-input', style: { left: `${p.x}px`, top: `${p.y - 12}px` }, spellcheck: 'true', 'aria-label': 'Whiteboard text' });
      const done = (v) => {
        inp.remove();
        resolve(v);
      };
      inp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') done(inp.value);
        if (e.key === 'Escape') done(null);
      });
      inp.addEventListener('blur', () => done(inp.value));
      this.el.appendChild(inp);
      setTimeout(() => inp.focus(), 0);
    });
  }

  /** Stable id of the application item under a point (REQ-WB-06). */
  elementAt(p) {
    const stack = document.elementsFromPoint(p.x, p.y).filter((el) => !el.closest('.wb-overlay'));
    for (const el of stack) {
      const host = el.closest('[data-id]');
      if (host) {
        const id = host.dataset.id;
        return { id, label: this.describe(id, host), kind: id.split(':')[0] };
      }
    }
    return null;
  }

  describe(id, el) {
    const [kind, rest] = [id.split(':')[0], id.slice(id.indexOf(':') + 1)];
    if (kind === 'layer') return `Layer: ${this.app.store.get(rest)?.name ?? rest}`;
    if (kind === 'measurement') return `Measurement ${this.app.store.get(rest)?.mid ?? rest}`;
    if (kind === 'cmd' || kind === 'qat') return `Command: ${this.app.commands.get(rest.replace(/:menu$/, ''))?.label ?? rest}`;
    if (kind === 'pane') return `Panel ${rest.split(':')[0]}`;
    return (el?.getAttribute('aria-label') || el?.textContent || id).trim().slice(0, 60);
  }

  /** Whether a pin target still exists ("gone" state). */
  targetExists(t) {
    if (!t) return true;
    if (document.querySelector(`[data-id="${CSS.escape(t.id)}"]`)) return true;
    const [kind, rest] = [t.id.split(':')[0], t.id.slice(t.id.indexOf(':') + 1)];
    if (['layer', 'measurement', 'graphic', 'pane'].includes(kind)) return this.app.store.has(rest.split(':')[0]);
    return false;
  }

  /** Jump to a pinned item: flash it and make it active where that makes sense. */
  jumpTo(t) {
    if (!t) return;
    const [kind, rest] = [t.id.split(':')[0], t.id.slice(t.id.indexOf(':') + 1)];
    if (kind === 'layer' && this.app.layers.has(rest)) {
      const l = this.app.layers.get(rest);
      const pane = [...this.app.desktop.multiports.flatMap((m) => m.panes)].find((p) => p.id === l.rec.pane);
      if (pane) this.app.store.transact('Set active layer', (tx) => tx.set(pane.id, 'activeLayer', rest), { kind: 'load' });
    }
    const el = document.querySelector(`[data-id="${CSS.escape(t.id)}"]`);
    if (!el) return this.app.toast(`${t.label}: gone`, { kind: 'warn' });
    el.scrollIntoView?.({ block: 'nearest' });
    el.classList.add('wb-flash');
    setTimeout(() => el.classList.remove('wb-flash'), 1500);
  }

  _hit(p) {
    for (let i = this.marks.items.length - 1; i >= 0; i--) {
      const m = this.marks.items[i];
      if (m.points.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 10)) return m;
      if (m.points.length === 2) {
        const [a, b] = m.points;
        if (p.x >= Math.min(a.x, b.x) - 6 && p.x <= Math.max(a.x, b.x) + 6 && p.y >= Math.min(a.y, b.y) - 6 && p.y <= Math.max(a.y, b.y) + 6) return m;
      }
    }
    return null;
  }

  redraw(live) {
    const dpr = window.devicePixelRatio || 1;
    const c = this.canvas;
    const W = Math.round(innerWidth * dpr);
    const H = Math.round(innerHeight * dpr);
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, innerWidth, innerHeight);
    this.drawMarks(g, live);
  }

  drawMarks(g, live) {
    const items = live ? [...this.marks.items, live] : this.marks.items;
    for (const m of items) drawMark(g, m, this);
  }

  // ---- pages ----
  context() {
    const app = this.app;
    const pane = app.activePane();
    const l = pane?.geoLayer();
    let centre = null;
    if (l?.modelId) {
      const g = l.groundAt(pane.view.cx, pane.view.cy);
      if (g) centre = { lat: +g.lat.toFixed(7), lon: +g.lon.toFixed(7), mgrs: app.core.mgrs(g.lat, g.lon, 5) };
    }
    const m = app.screenMarking();
    return {
      build: app.build.id,
      version: app.build.version,
      pane: pane ? `Panel.${pane.mp.panes.indexOf(pane) + 1} of ${pane.mp.rec.name}` : null,
      image: l?.info.iid ?? null,
      imageFile: l?.info.fileName ?? null,
      centre,
      zoom: pane ? +pane.view.zoom.toFixed(4) : null,
      rotation: pane ? +((pane.view.rot * 180) / Math.PI).toFixed(2) : null,
      orientation: pane?.view.mode ?? null,
      chain: l?.chain ? chainSummary(l.chain) : null,
      model: l?.modelName ?? null,
      marking: bannerText(m),
      theme: document.documentElement.dataset.theme,
      runMode: app.runMode.mode,
      browser: navigator.userAgent,
      viewport: `${innerWidth}×${innerHeight}@${window.devicePixelRatio}`,
    };
  }

  async capture() {
    this.captureBtn.disabled = true;
    try {
      this.bar.hidden = true;
      const page = await composePage({
        app: this.app,
        method: this.method,
        state: this.captureState,
        drawMarks: (g) => this.drawMarks(g),
        exclude: (el) => el.classList?.contains('wb-overlay') || el.classList?.contains('toasts'),
      });
      const p = newPage({ image: page.dataUrl, width: page.width, height: page.height, marks: this.marks.snapshot(), context: this.context(), reporter: this.app.prefs.get('analyst') ?? '', capture: page.method });
      this.pages.push(p);
      this.marks = new Marks(200);
      this.redraw();
      await this.app.feedbackSession?.save(this);
      this.app.toast(`Page ${this.pages.length} captured (${page.method}). Marks cleared for the next page.`);
      this.app.emit('state');
      return p;
    } finally {
      this.bar.hidden = false;
      this.captureBtn.disabled = false;
      this._syncBar();
    }
  }
}

export function drawMark(g, m, wb) {
  const [a, b] = m.points;
  g.save();
  g.strokeStyle = m.color;
  g.fillStyle = m.color;
  g.lineWidth = m.width;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  switch (m.tool) {
    case 'pen':
    case 'highlight':
      if (m.tool === 'highlight') {
        g.globalAlpha = 0.35;
        g.lineWidth = m.width * 5;
      }
      g.beginPath();
      m.points.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.stroke();
      break;
    case 'arrow': {
      if (!b) break;
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const hl = 10 + m.width * 2;
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
      g.beginPath();
      g.moveTo(b.x, b.y);
      g.lineTo(b.x - hl * Math.cos(ang - 0.45), b.y - hl * Math.sin(ang - 0.45));
      g.lineTo(b.x - hl * Math.cos(ang + 0.45), b.y - hl * Math.sin(ang + 0.45));
      g.closePath();
      g.fill();
      break;
    }
    case 'rect':
      if (b) g.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      break;
    case 'ellipse':
      if (b) {
        g.beginPath();
        g.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
        g.stroke();
      }
      break;
    case 'text':
      g.font = `bold ${12 + m.width * 2}px Segoe UI, Arial, sans-serif`;
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(0,0,0,.8)';
      g.strokeText(m.text, a.x, a.y);
      g.fillText(m.text, a.x, a.y);
      break;
    case 'pin': {
      const gone = wb && m.target && !wb.targetExists(m.target);
      g.beginPath();
      g.arc(a.x, a.y, 11, 0, Math.PI * 2);
      g.fillStyle = gone ? '#777' : m.color;
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = '#000';
      g.stroke();
      g.fillStyle = m.color === '#ffffff' || m.color === '#fdd835' ? '#000' : '#fff';
      g.font = 'bold 12px Arial, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(m.n), a.x, a.y + 0.5);
      if (m.target) {
        g.textAlign = 'left';
        g.font = '11px Segoe UI, Arial, sans-serif';
        g.fillStyle = '#000';
        const label = `${m.target.label}${gone ? ' (gone)' : ''}`;
        const w = g.measureText(label).width + 8;
        g.fillStyle = 'rgba(255,255,255,.92)';
        g.fillRect(a.x + 14, a.y - 8, w, 16);
        g.fillStyle = '#000';
        g.fillText(label, a.x + 18, a.y);
      }
      break;
    }
    default:
      break;
  }
  g.restore();
}

export { importFeedback, clear };
