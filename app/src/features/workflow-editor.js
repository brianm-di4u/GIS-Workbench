// The visual workflow builder (REQ-GAP-84, SDP-2.7 §4.11; Full; the lazy js-workflow block): a
// node editor over gw-recipe/2. Steps are nodes with their inputs on the left and outputs on the
// right; a wire runs from an output to an input of a fitting type. The same workflow shows as a
// list, which is the keyboard and screen-reader path: every step, its parameters (a form made from
// the operation's schema) and its inputs (a choice of the outputs upstream). The runner's state
// shows on each node and list item. Workflows are kept in the project (a `workflow` record, saved
// in the .gwb) and in a library in IndexedDB, with no cap.

import { h, clear } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { pickFiles, saveBlob, textBlob } from '../storage/files.js';
import { t, tr, msgOf, gwError } from '../i18n/index.js';
import { validateRecipe, checkParam, fits, splitPort, contentOf, defaults, FORMAT2 } from '../recipes/recipe.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) el.setAttribute(k, String(v));
  for (const c of kids) if (c) el.append(c);
  return el;
};
const NODE_W = 170;
const PORT = 18;
const nodeH = (op) => 36 + PORT * Math.max(op?.inputs?.length ?? 0, op?.outputs?.length ?? 0, 1);

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const R = app.recipes;
  const ops = R.ops;
  const runner = R.runner;
  const toast = (m, o) => app.toast(m, o);

  // ---- the workflow being edited: a plain gw-recipe/2 object ----
  const ed = { wf: null, base: null, sel: null, view: 'graph', el: null, wiring: null };
  const blank = () => ({ format: FORMAT2, id: `wf-${Date.now().toString(36)}`, name: t('New workflow'), description: '', version: 1, steps: [] });
  const stepById = (id) => ed.wf?.steps.find((x) => x.id === id) ?? null;
  const nextId = () => {
    let n = ed.wf.steps.length + 1;
    while (stepById(`s${n}`)) n++;
    return `s${n}`;
  };

  /** Add a step of operation `op` at a position; returns its id. */
  function addStep(op, at = null) {
    if (!ops[op]) throw gwError('unknown operation "{op}"', { op }, 'E_RECIPE_STEP');
    ed.wf ??= blank();
    const id = nextId();
    const k = ed.wf.steps.length;
    ed.wf.steps.push({ id, op, title: ops[op].title, params: {}, inputs: {}, note: '', at: at ?? { x: 20 + (k % 4) * (NODE_W + 40), y: 20 + Math.floor(k / 4) * 120 } });
    ed.sel = id;
    draw();
    return id;
  }
  /** Wire output `output` of step `from` to input `input` of step `to`; checks types and loops. */
  function wire(from, output, to, input) {
    const a = stepById(from);
    const b = stepById(to);
    if (!a || !b) throw gwError('no such step', {}, 'E_RECIPE_STEP');
    const out = ops[a.op].outputs?.find((o) => o.name === output);
    const want = ops[b.op].inputs?.find((x) => x.name === input);
    if (!out || !want) throw gwError('no such port', {}, 'E_RECIPE_STEP');
    if (!fits(out.type, want.type)) throw gwError('{input} takes {want}, not {got}', { input, want: want.type, got: out.type }, 'E_RECIPE_STEP');
    const old = b.inputs[input];
    b.inputs[input] = { from, output };
    try {
      validateRecipe(ed.wf, ops); // rejects a loop
    } catch (e) {
      if (old) b.inputs[input] = old;
      else delete b.inputs[input];
      throw e;
    }
    draw();
  }
  function unwire(to, input) {
    delete stepById(to)?.inputs[input];
    draw();
  }
  /** Give input `input` of step `to` a layer of the project, by name (a name travels with the workflow; an id does not). */
  function give(to, input, layer) {
    const b = stepById(to);
    if (!b) throw gwError('no such step', {}, 'E_RECIPE_STEP');
    b.inputs[input] = { value: layer };
    draw();
  }
  function removeStep(id) {
    ed.wf.steps = ed.wf.steps.filter((x) => x.id !== id);
    for (const x of ed.wf.steps) for (const [k, w] of Object.entries(x.inputs)) if (w.from === id) delete x.inputs[k];
    if (ed.sel === id) ed.sel = null;
    draw();
  }
  function setParam(id, key, value) {
    const st = stepById(id);
    if (!st) throw gwError('no step {id}', { id }, 'E_RECIPE_NO_STEP');
    // Checked and coerced now, so a bad value is named where it was typed and the file keeps numbers as numbers.
    const v = checkParam(ops[st.op].schema?.[key], value, { where: `step ${ed.wf.steps.indexOf(st) + 1} (${id})`, param: key });
    st.params = { ...st.params, [key]: v };
    validateRecipe(ed.wf, ops);
    // The loaded run goes stale from this step on (by id: the run may be of an earlier version).
    const i = runner.recipe?.id === ed.wf.id ? runner.recipe.steps.findIndex((x) => x.id === id) : -1;
    if (i >= 0 && !runner.running) runner.setParam(i, key, v);
  }

  // ---- keeping workflows ----
  /** A built-in opened here is edited under an id of its own (so the editor shows the id it will be kept
   * under); recipes.placeFor is the rule Save keeps to. */
  const own = (r) => (R.builtin.some((b) => b.id === r.id) ? { ...r, id: `${r.id}-${Date.now().toString(36)}` } : r);
  // One save at a time: a second Save (a double-click) waits for the first, and so sees its record.
  let saving = Promise.resolve();
  const saveToProject = () => (saving = saving.catch(() => {}).then(save));
  async function save() {
    const r = validateRecipe(ed.wf, ops);
    // Save may replace a kept copy of this id only if it is the copy that was opened (recipes.placeFor);
    // a built-in, or a different copy, stays, and this is kept beside it.
    const place = await R.placeFor(r, ed.base);
    if (place.moved) Object.assign(r, { id: place.id, version: place.version });
    // The version counts saves of the copy opened, wherever it is kept: its version, plus one if this differs.
    else if (place.version !== null) r.version = place.version + (ed.base === body(r) ? 0 : 1);
    if (place.fresh) toast(t('Saved as a new workflow: the project or your library already holds a different one under its id.'), { kind: 'info' });
    else if (place.moved) toast(t('Saved as {id}, which holds the same workflow.', { id: r.id }), { kind: 'info' });
    const rec = S.all('workflow').find((x) => x.recipe?.id === r.id);
    ed.wf.id = r.id;
    ed.wf.version = r.version;
    ed.base = body(r);
    S.transact(t('Save workflow'), (tx) => (rec ? tx.set(rec.id, 'recipe', toFile(r)) : tx.create('workflow', { recipe: toFile(r) })));
    if (!(await R.keep(toFile(r)))) toast(t('Saved in the project; this browser has no storage for your library.'), { kind: 'warn' });
    return r.id;
  }
  const toFile = (r) => JSON.parse(JSON.stringify({ ...r, format: FORMAT2 }));
  const body = (x) => contentOf(x, ops);

  /** Positions for steps a file gave none (a gw-recipe/1 chain, or a hand-written file): a column per depth of wiring. */
  function layout(steps) {
    const depth = new Map();
    const deep = (x, seen = new Set()) => {
      if (depth.has(x.id)) return depth.get(x.id);
      seen.add(x.id);
      const ups = Object.values(x.inputs ?? {}).filter((w) => w.from && !seen.has(w.from)).map((w) => stepById(w.from)).filter(Boolean);
      const d = ups.length ? 1 + Math.max(...ups.map((u) => deep(u, seen))) : 0;
      depth.set(x.id, d);
      return d;
    };
    const wired = steps.some((x) => Object.values(x.inputs ?? {}).some((w) => w.from));
    const rows = new Map();
    steps.forEach((x, k) => {
      if (x.at) return;
      const col = wired ? deep(x) : k;
      const row = rows.get(col) ?? 0;
      rows.set(col, row + 1);
      x.at = { x: 20 + col * (NODE_W + 40), y: 20 + row * 110 };
    });
  }

  function open(wf) {
    ed.wf = toFile(own(validateRecipe(wf, ops)));
    // The copy opened: Save may replace it, and nothing else stored under its id.
    ed.base = body(ed.wf);
    layout(ed.wf.steps);
    ed.sel = null;
    draw();
    return ed.wf;
  }
  /** Run the workflow being edited; `inputs` by "stepId.input" for its open inputs. */
  async function run(inputs = {}) {
    if (!ed.wf?.steps.length) throw gwError('the workflow has no steps', {}, 'E_RECIPE_STEP');
    runner.load(ed.wf);
    draw();
    return runner.run(0, { inputs });
  }

  // ---- drawing ----
  /** The loaded run's state of step `id`, by id: steps may have been added or removed since that run. */
  const runState = (id) => {
    const k = runner.recipe?.id === ed.wf?.id ? runner.recipe.steps.findIndex((x) => x.id === id) : -1;
    return k >= 0 ? runner.state[k] : null;
  };
  const status = (id) => runState(id)?.status ?? 'idle';
  const label = (st) => ({ idle: t('not run'), pending: t('pending'), running: t('running'), done: t('done'), failed: t('failed'), waiting: t('waiting'), skipped: t('skipped'), stale: t('out of date') })[st] ?? st;

  function graph() {
    const wf = ed.wf;
    const maxX = Math.max(600, ...wf.steps.map((x) => (x.at?.x ?? 0) + NODE_W + 40));
    const maxY = Math.max(300, ...wf.steps.map((x) => (x.at?.y ?? 0) + nodeH(ops[x.op]) + 40));
    const svg = s('svg', { class: 'wf-graph', width: maxX, height: maxY, viewBox: `0 0 ${maxX} ${maxY}`, role: 'group', 'aria-label': t('Workflow graph') });
    const port = (x, kind, name) => {
      const n = x.at;
      const list = kind === 'in' ? (ops[x.op].inputs ?? []) : (ops[x.op].outputs ?? []);
      const k = list.findIndex((p) => p.name === name);
      return [n.x + (kind === 'in' ? 0 : NODE_W), n.y + 34 + k * PORT];
    };
    // Wires first, under the nodes.
    for (const x of wf.steps) {
      for (const [k, w] of Object.entries(x.inputs)) {
        if (!('from' in w)) continue;
        const src = stepById(w.from);
        if (!src) continue;
        const [x0, y0] = port(src, 'out', w.output);
        const [x1, y1] = port(x, 'in', k);
        // A step between the two ends would hide a straight wire: go round under it.
        const lo = Math.min(y0, y1) - 12;
        const hi = Math.max(y0, y1) + 12;
        const between = wf.steps.filter((o) => o !== src && o !== x && o.at && o.at.x < Math.max(x0, x1) && o.at.x + NODE_W > Math.min(x0, x1) && o.at.y < hi && o.at.y + nodeH(ops[o.op]) > lo);
        const dip = between.length ? Math.max(...between.map((o) => o.at.y + nodeH(ops[o.op]))) + 20 : null;
        const d = dip === null ? `M${x0},${y0} C${x0 + 60},${y0} ${x1 - 60},${y1} ${x1},${y1}` : `M${x0},${y0} C${x0 + 40},${y0} ${x0 + 20},${dip} ${(x0 + x1) / 2},${dip} S${x1 - 40},${y1} ${x1},${y1}`;
        svg.append(s('path', { d, class: 'wf-wire', 'data-wire': `${w.from}.${w.output}>${x.id}.${k}` }));
      }
    }
    for (const [i, x] of wf.steps.entries()) {
      const op = ops[x.op];
      const st = status(x.id);
      const g = s('g', { class: `wf-node wf-${st}${ed.sel === x.id ? ' wf-sel' : ''}`, transform: `translate(${x.at.x},${x.at.y})`, tabindex: 0, role: 'button', 'aria-label': t('{title}, step {id}: {status}', { title: tr(x.title), id: x.id, status: label(st) }), 'data-step': x.id });
      g.append(s('rect', { width: NODE_W, height: nodeH(op), rx: 6 }), s('text', { x: 8, y: 16, class: 'wf-title' }, document.createTextNode(tr(x.title))), s('text', { x: 8, y: 28, class: 'wf-status' }, document.createTextNode(`${x.id} · ${label(st)}`)));
      (op.inputs ?? []).forEach((p, k) => {
        g.append(s('circle', { cx: 0, cy: 34 + k * PORT, r: 5, class: 'wf-port wf-in', 'data-port': `${x.id}.${p.name}` }), s('text', { x: 9, y: 38 + k * PORT, class: 'wf-port-label' }, document.createTextNode(p.name)));
      });
      (op.outputs ?? []).forEach((p, k) => {
        g.append(s('circle', { cx: NODE_W, cy: 34 + k * PORT, r: 5, class: 'wf-port wf-out', 'data-port': `${x.id}.${p.name}` }), s('text', { x: NODE_W - 9, y: 38 + k * PORT, class: 'wf-port-label', 'text-anchor': 'end' }, document.createTextNode(p.name)));
      });
      // Select, drag, and the keyboard: arrows move, Delete removes, Enter opens the step in the list.
      g.addEventListener('pointerdown', (e) => {
        if (e.target.classList?.contains('wf-out')) return startWire(e, x);
        ed.sel = x.id;
        const sx = e.clientX;
        const sy = e.clientY;
        const ox = x.at.x;
        const oy = x.at.y;
        const move = (m) => {
          x.at = { x: Math.max(0, ox + m.clientX - sx), y: Math.max(0, oy + m.clientY - sy) };
          g.setAttribute('transform', `translate(${x.at.x},${x.at.y})`);
        };
        const up = () => {
          removeEventListener('pointermove', move);
          removeEventListener('pointerup', up);
          draw();
        };
        addEventListener('pointermove', move);
        addEventListener('pointerup', up);
      });
      g.addEventListener('keydown', (e) => {
        const d = e.shiftKey ? 40 : 10;
        const mv = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] }[e.key];
        if (mv) {
          e.preventDefault();
          x.at = { x: Math.max(0, x.at.x + mv[0]), y: Math.max(0, x.at.y + mv[1]) };
          ed.sel = x.id;
          draw();
          ed.el?.querySelector(`[data-step="${x.id}"]`)?.focus();
        } else if (e.key === 'Delete') {
          removeStep(x.id);
        } else if (e.key === 'Enter') {
          ed.sel = x.id;
          ed.view = 'list';
          draw();
          ed.el?.querySelector(`[data-item="${x.id}"]`)?.focus();
        }
      });
      svg.append(g);
    }
    return svg;
  }
  function startWire(e, src) {
    e.stopPropagation();
    const [, name] = splitPort(e.target.getAttribute('data-port'));
    const up = (u) => {
      removeEventListener('pointerup', up);
      const hit = document.elementFromPoint(u.clientX, u.clientY);
      const p = hit?.getAttribute?.('data-port');
      if (!p || !hit.classList.contains('wf-in')) return;
      const [to, input] = splitPort(p);
      try {
        wire(src.id, name, to, input);
      } catch (err) {
        toast(msgOf(err), { kind: 'warn' });
      }
    };
    addEventListener('pointerup', up);
  }

  /** A form control for one parameter from its schema entry. */
  function control(x, key, spec, value) {
    const id = `wf-${x.id}-${key}`;
    const lbl = tr(spec?.label ?? key) + (spec?.unit ? ` (${spec.unit})` : '');
    let el;
    if (spec?.type === 'boolean') el = h('input', { type: 'checkbox', id, checked: !!value, 'aria-label': lbl });
    else if (spec?.type === 'enum') el = h('select', { class: 'inp', id, 'aria-label': lbl }, ...(spec.values ?? []).map((v) => (typeof v === 'object' ? v : { value: v, label: String(v) })).map((v) => h('option', { value: v.value, selected: v.value === value }, tr(v.label))));
    else if (spec?.multiline) el = h('textarea', { class: 'inp', id, rows: 4, value: value ?? '', 'aria-label': lbl });
    else el = h('input', { class: spec?.type === 'number' || spec?.type === 'integer' ? 'inp inp-num' : 'inp', id, type: spec?.type === 'number' || spec?.type === 'integer' ? 'number' : spec?.type === 'date' ? 'date' : 'text', value: Array.isArray(value) ? value.join(', ') : (value ?? ''), ...(spec?.min !== undefined ? { min: spec.min } : {}), ...(spec?.max !== undefined ? { max: spec.max } : {}), 'aria-label': lbl });
    el.addEventListener('change', () => {
      let v = spec?.type === 'boolean' ? el.checked : el.value;
      if (spec?.type === 'numbers' || spec?.type === 'lonlat') v = String(v).trim() ? String(v).split(/[,;\s]+/).filter(Boolean).map(Number) : (spec.default ?? null);
      try {
        setParam(x.id, key, v);
        const held = stepById(x.id)?.params[key];
        if (!String(el.value).trim() && held !== null && held !== undefined && el.type !== 'checkbox') el.value = Array.isArray(held) ? held.join(', ') : String(held);
        el.removeAttribute('aria-invalid');
      } catch (e) {
        el.setAttribute('aria-invalid', 'true');
        toast(msgOf(e), { kind: 'warn' });
      }
    });
    return field(lbl, el);
  }

  function list() {
    const wf = ed.wf;
    const ol = h('ol', { class: 'wf-list', 'aria-label': t('Workflow steps') });
    for (const [i, x] of wf.steps.entries()) {
      const op = ops[x.op];
      const st = status(x.id);
      const head = h('div', { class: 'wf-item-head' }, h('strong', {}, `${x.id} · ${tr(x.title)}`), h('span', { class: `wf-badge wf-${st}` }, label(st)));
      const form = h('div', { class: 'wf-form' });
      const params = { ...Object.fromEntries(Object.keys(op.schema ?? {}).map((k) => [k, undefined])), ...defaults(op), ...x.params };
      for (const [k, v] of Object.entries(params)) form.append(control(x, k, op.schema?.[k], v));
      // Inputs: a choice of the outputs upstream that fit, or none.
      for (const p of op.inputs ?? []) {
        const choices = wf.steps.filter((y) => y.id !== x.id).flatMap((y) => (ops[y.op].outputs ?? []).filter((o) => fits(o.type, p.type)).map((o) => ({ value: `${y.id}.${o.name}`, label: `${y.id} · ${tr(y.title)} → ${o.name}` })));
        const cur = x.inputs[p.name];
        // Or a layer of the project, of the kind the input takes.
        const named = (p.type === 'layer:vector' ? S.all('vlayer').map((v) => [v.id, v.name]) : p.type === 'layer:raster' ? [...(app.layers?.values() ?? [])].map((l) => [l.id, l.rec?.name]) : []).filter(([, n]) => n);
        // A name two layers share is listed once per layer, kept by id: the name alone would pick neither.
        const shared = (n) => named.filter(([, m]) => m === n).length > 1;
        const options = [...new Map(named.map(([id, n]) => (shared(n) ? [id, { key: id, label: `${n} (${id})` }] : [n, { key: n, label: n }]))).values()];
        const listed = options.map((o) => o.key);
        // A layer the workflow names but this project lacks (opened from elsewhere, renamed) still shows, so it can be changed or cleared.
        const given = cur && 'value' in cur ? String(cur.value) : null;
        const layers = [
          ...options.map((o) => h('option', { value: '', 'data-layer': o.key, selected: given === o.key }, t('Layer: {name}', { name: o.label }))),
          ...(given !== null && !listed.includes(given) ? [h('option', { value: '', 'data-layer': given, selected: true }, t('Layer: {name} (not in this project)', { name: given }))] : []),
        ];
        const sel = h('select', { class: 'inp', 'aria-label': t('Input {name}', { name: p.name }) }, h('option', { value: '' }, t('(given when run)')), ...choices.map((c) => h('option', { value: c.value, selected: cur && `${cur.from}.${cur.output}` === c.value }, c.label)), ...layers);
        sel.addEventListener('change', () => {
          try {
            const layer = sel.selectedOptions[0]?.dataset.layer;
            if (layer) give(x.id, p.name, layer);
            else if (!sel.value) unwire(x.id, p.name);
            else {
              const [from, output] = splitPort(sel.value);
              wire(from, output, x.id, p.name);
            }
          } catch (e) {
            toast(msgOf(e), { kind: 'warn' });
            draw();
          }
        });
        form.append(field(t('Input {name} ({type})', { name: p.name, type: p.type }), sel));
      }
      const del = h('button', { class: 'btn', type: 'button' }, t('Remove step'));
      del.addEventListener('click', () => removeStep(x.id));
      const rs = runState(x.id);
      const err = rs?.error ? h('p', { class: 'hint wf-error', role: 'alert' }, msgOf({ message: rs.error, i18n: rs.i18n })) : null;
      ol.append(h('li', { class: ['wf-item', ed.sel === x.id && 'wf-sel'], tabindex: 0, 'data-item': x.id }, head, form, err, del));
    }
    return ol;
  }

  function draw() {
    const el = ed.el;
    if (!el?.isConnected) return;
    clear(el);
    const wf = (ed.wf ??= blank());
    const name = h('input', { class: 'inp', value: wf.name, 'aria-label': t('Workflow name') });
    name.addEventListener('change', () => (wf.name = name.value.trim() || wf.name));
    const add = h('select', { class: 'inp', 'aria-label': t('Add a step') }, h('option', { value: '' }, t('Add a step…')), ...Object.entries(ops).map(([k, o]) => h('option', { value: k }, tr(o.title))));
    add.addEventListener('change', () => {
      if (add.value) addStep(add.value);
    });
    const btn = (text, fn, extra = {}) => {
      const b = h('button', { class: 'btn', type: 'button', ...extra }, text);
      b.addEventListener('click', () => Promise.resolve(fn()).catch((e) => toast(msgOf(e), { kind: 'error' })));
      return b;
    };
    const views = h('div', { class: 'btn-row', role: 'tablist' }, btn(t('Graph'), () => ((ed.view = 'graph'), draw()), { role: 'tab', 'aria-selected': String(ed.view === 'graph') }), btn(t('List'), () => ((ed.view = 'list'), draw()), { role: 'tab', 'aria-selected': String(ed.view === 'list') }));
    el.append(
      field(t('Workflow'), name),
      h('div', { class: 'btn-row' }, add, btn(t('Run'), () => run()), btn(t('Stop'), () => runner.stop()), btn(t('Save'), () => saveToProject().then(() => toast(t('Saved in the project and the library'), { kind: 'info' }))), btn(t('Open…'), openDialog), btn(t('Export…'), () => saveBlob(app, textBlob(JSON.stringify(toFile(validateRecipe(wf, ops)), null, 2), 'application/json'), { name: `${wf.id}.gwrecipe.json`, types: ['.json'], description: t('Workflow') }))),
      views,
      wf.steps.length ? (ed.view === 'graph' ? h('div', { class: 'wf-canvas' }, graph()) : list()) : h('p', { class: 'hint' }, t('Add a step to begin. In the graph, drag from an output on the right of a step to an input on the left of another; in the list, choose each input from the outputs before it.')),
    );
  }
  runner.on('change', () => draw());

  async function openDialog() {
    await R.library(true).catch(() => []);
    const where = { builtin: t('built in'), project: t('project'), library: t('library') };
    const all = R.known().map((r) => ({ r, where: where[r.source] }));
    const sel = h('select', { class: 'inp', 'aria-label': t('Workflow'), size: 8 }, ...all.map((x, i) => h('option', { value: String(i) }, `${tr(x.r.name)} (${x.where})`)));
    const file = h('button', { class: 'btn', type: 'button' }, t('From a file…'));
    let chosen = null;
    file.addEventListener('click', async () => {
      const [f] = await pickFiles(app, { multiple: false, accept: ['.json'], description: t('Workflow') });
      if (f) chosen = JSON.parse(await f.text());
    });
    const v = await modal({ title: t('Open Workflow'), body: h('div', {}, sel, file), buttons: [{ label: t('Open'), value: 'open', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'wf-open' });
    if (v !== 'open') return;
    open(chosen ?? all[+sel.value]?.r);
  }

  // ---- the dock and the command ----
  const reg = (mp) => mp?.docks?.register({ id: 'workflow', title: t('Workflow Builder'), icon: 'list', home: 'bottom', create: (a, m, el) => {
    ed.el = el;
    el.classList.add('wf-panel');
    draw();
    return { onShow: draw };
  } });
  if (app._ready) app.desktop.multiports.forEach(reg);
  else app.on('ready', reg);
  const addMp = app.desktop.addMultiport.bind(app.desktop);
  app.desktop.addMultiport = (id) => {
    const mp = addMp(id);
    if (app._ready) reg(mp);
    return mp;
  };
  let grown = false;
  const show = () => {
    const docks = app.activePane()?.mp?.docks;
    docks?.show('workflow');
    // A graph needs room: the first time, a short bottom dock grows to show it; the user's own size is kept after.
    const a = docks?.panel('workflow')?.area;
    if (!grown && a?.side === 'bottom' && a.el.getBoundingClientRect().height < 300) {
      a.el.style.height = `${Math.round(Math.min(440, innerHeight * 0.45))}px`;
      grown = true;
    }
  };

  C.implement('pip.builder', {
    enabled: () => true,
    run: async () => {
      show();
    },
  });

  Object.assign(app.workflows, { show, open, addStep, wire, unwire, give, removeStep, setParam, run, saveToProject, removeFromLibrary: (id) => R.forget(id), current: () => ed.wf, setView: (v) => ((ed.view = v), draw()) });
}
