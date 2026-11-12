// Recipes dock (2.0 plan P6; REQ-PIP-01..04): one-click workflows run as a visible linear
// stepper. Each step shows its state, time and result; clicking a step opens its parameters in
// the drawer below, where a change re-runs from that step. Gate steps pause with the candidates
// on the map until the analyst has reviewed them (accept / reject in the queue, or 1 / 2 / 3)
// and presses Enter or Resume. Recipes are saved and opened as .gwrecipe.json files; four are
// built in.

import { h, clear } from '../shell/dom.js';
import { pickFiles, saveBlob } from '../storage/files.js';
import { walkFolder } from '../formats/sniff.js';
import { RecipeRunner, validateRecipe, FORMAT } from '../recipes/recipe.js';
import { t, N_, tr, msgOf } from '../i18n/index.js';
import { num, int } from '../i18n/format.js';

export const name = 'recipes';

/** Built-in recipes (REQ-PIP-04). */
export const BUILTIN = [
  {
    format: FORMAT,
    id: 'airfield-triage',
    name: N_('Airfield triage'),
    description: N_('Auto contrast, find aircraft in view, review them, then a chip deck and a GeoJSON of the accepted ones.'),
    steps: [
      { op: 'contrast', title: N_('Auto contrast') },
      { op: 'find', title: N_('Find aircraft'), params: { objects: ['aircraft', 'helicopter'], threshold: 0.15 } },
      { op: 'gate', title: N_('Review the detections'), params: { message: N_('Accept or reject each aircraft (✓ / ✗ in the queue, or J then 2 / 1), then press Enter.') } },
      { op: 'chips', title: N_('Chip the accepted ones'), params: { status: 'accepted', max: 20 } },
      { op: 'exportDeck', title: N_('Export the chip deck') },
      { op: 'exportGeojson', title: N_('Export GeoJSON'), params: { what: 'accepted-detections' } },
    ],
  },
  {
    format: FORMAT,
    id: 'damage-triage',
    name: N_('Damage triage'),
    description: N_('Align the post-event image to the pre-event one with learned matching, find damage, review it, export GeoJSON.'),
    steps: [
      { op: 'align', title: N_('Co-register (AI)') },
      { op: 'find', title: N_('Find damage'), params: { objects: ['collapsed building', 'flooded area', 'debris'], threshold: 0.12 } },
      { op: 'gate', title: N_('Review the candidates'), params: { message: N_('Use flicker (hold F) or swipe (S + drag) against the pre-event image; accept or reject each candidate, then press Enter.') } },
      { op: 'exportGeojson', title: N_('Export GeoJSON'), params: { what: 'accepted-detections' } },
    ],
  },
  {
    format: FORMAT,
    id: 'folder-to-cog',
    name: N_('Convert a folder to COG'),
    description: N_('Every raster in a folder becomes a Cloud-Optimized GeoTIFF; vectors become GeoParquet.'),
    steps: [{ op: 'convertFolder', title: N_('Convert the folder'), params: { vectors: 'geoparquet' } }],
  },
  {
    format: FORMAT,
    id: 'building-extraction',
    name: N_('Building extraction'),
    description: N_('Find buildings in view, outline each with SAM 2.1 and square its corners, review, export GeoJSON.'),
    steps: [
      { op: 'find', title: N_('Find buildings'), params: { objects: ['building'], threshold: 0.15 } },
      { op: 'outline', title: N_('Outline and square them'), params: { square: true, max: 60 } },
      { op: 'gate', title: N_('Review the outlines'), params: { message: N_('Delete wrong outlines (select, Del) or redraw them, then press Enter.') } },
      { op: 'exportGeojson', title: N_('Export GeoJSON'), params: { what: 'outlines' } },
    ],
  },
];

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const pane = () => app.activePane();
  const pending = () => S.all('detection').filter((d) => d.status === 'pending');

  /** The operations a step can run (REQ-PIP-02): params → {summary}. */
  const OPS = {
    contrast: { title: N_('Auto contrast'), pythonHint: 'gw.auto_contrast()', run: () => {
      const p = app.aiLocal.autoContrast();
      return { summary: t('CLAHE clip {clip}, gamma {gamma}', { clip: p.clip, gamma: p.gamma }) };
    } },
    find: { title: N_('Find objects'), defaults: { objects: ['vehicle'], threshold: 0.15 }, pythonHint: 'gw.find(objects, threshold)', run: async ({ objects, threshold }) => {
      const r = await app.aiLocal.find(objects, { threshold });
      return { summary: Object.entries(r.counts).map(([k, n]) => t('{n} {object}', { n, object: k })).join(', ') };
    } },
    search: { title: N_('Search imagery'), defaults: { text: '', k: 8 }, run: async ({ text, k }) => {
      const r = await app.aiLocal.search(text, { k });
      return { summary: t('{n, plural, one {# place} other {# places}}, best {best}', { n: r.hits.length, best: Number.isFinite(r.hits[0]?.score) ? num(r.hits[0].score, 2) : '–' }) };
    } },
    align: { title: N_('Co-register (AI)'), pythonHint: 'gw.auto_align_ai()', run: async () => {
      const r = await app.autoAlignAI();
      return { summary: t('{n, plural, one {# tie point} other {# tie points}}, RMS {rms} px', { n: r.used, rms: num(r.rms, 2) }) };
    } },
    outline: { title: N_('Outline detections'), defaults: { square: true, max: 60 }, run: async ({ square, max }, ctx) => {
      const l = pane()?.geoLayer?.() ?? pane()?.activeLayer?.();
      if (!l) throw new Error('open an image first');
      const list = pending().filter((d) => d.anchor === 'image' && d.ring).slice(0, max);
      let n = 0;
      for (const d of list) {
        const cx = d.ring.reduce((s, q) => s + q[0], 0) / d.ring.length;
        const cy = d.ring.reduce((s, q) => s + q[1], 0) / d.ring.length;
        // Detections in one 1024 px tile share the tile's embedding: the encoder runs once per tile.
        const r = await app.sam.select(l, cx, cy, { square, size: 1024, at: { x0: Math.floor(cx / 1024) * 1024, y0: Math.floor(cy / 1024) * 1024 } });
        if (r.graphic) {
          S.transact(t('Recipe outline'), (tx) => tx.set(r.graphic, 'tag', 'recipe-outline'));
          n++;
        }
        ctx.runner.state[ctx.index].summary = `${n} / ${list.length}`;
        ctx.runner.emit('change');
      }
      return { summary: t('{n, plural, one {# outline} other {# outlines}}', { n }) };
    } },
    gate: { title: N_('Review'), gate: true, defaults: { message: N_('Review, then press Enter.') }, run: ({ message }, ctx) => {
      const n = pending().length;
      if (ctx?.headless) return { summary: n ? t('{n} to review', { n }) : t('waiting for you') };
      if (n) {
        app.activeMp()?.docks.show('detections');
        app.detections.zoomTo?.(pending()[0].id);
      }
      app.toast(t('Recipe paused: {message}', { message: tr(message) }), { kind: 'info', ms: 8000 });
      return { summary: n ? t('{n} to review', { n }) : t('waiting for you') };
    }, after: () => ({ summary: t('{a} accepted, {r} rejected', { a: S.all('detection').filter((d) => d.status === 'accepted').length, r: S.all('detection').filter((d) => d.status === 'rejected').length }) }) },
    chips: { title: N_('Chip detections'), defaults: { status: 'accepted', max: 20 }, run: async ({ status, max }) => {
      const p = pane();
      const list = S.all('detection').filter((d) => d.status === status && d.anchor === 'image' && d.ring).slice(0, max);
      for (const d of list) {
        const xs = d.ring.map((q) => q[0]);
        const ys = d.ring.map((q) => q[1]);
        const pad = Math.max(32, 0.5 * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)));
        p.setView({ cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2 });
        const a = p.screenPoint(Math.min(...xs) - pad, Math.min(...ys) - pad);
        const b = p.screenPoint(Math.max(...xs) + pad, Math.max(...ys) + pad);
        await app.quickChip(p, { sx: Math.min(a.sx ?? a.x, b.sx ?? b.x), sy: Math.min(a.sy ?? a.y, b.sy ?? b.y) }, { sx: Math.max(a.sx ?? a.x, b.sx ?? b.x), sy: Math.max(a.sy ?? a.y, b.sy ?? b.y) });
      }
      return { summary: t('{n, plural, one {# chip} other {# chips}} in the session deck', { n: list.length }) };
    } },
    exportDeck: { title: N_('Export the deck'), run: async () => {
      if (!app.sessionDeck?.length) return { summary: t('nothing to export') };
      await C.run('deck.export');
      return { summary: t('{n, plural, one {# slide} other {# slides}}', { n: app.sessionDeck.length }) };
    } },
    exportGeojson: { title: N_('Export GeoJSON'), defaults: { what: 'accepted-detections' }, run: async ({ what }) => {
      if (what === 'outlines') {
        const gs = S.all('graphic').filter((g) => g.tag === 'recipe-outline' && g.anchor === 'ground');
        if (!gs.length) return { summary: t('no outlines') };
        const fc = { type: 'FeatureCollection', features: gs.map((g) => ({ type: 'Feature', properties: { source: g.provenance?.model ?? 'SAM', iou: g.provenance?.iou ?? null }, geometry: { type: 'Polygon', coordinates: [[...g.coords.map((c) => [c[0], c[1]]), [g.coords[0][0], g.coords[0][1]]]] } })) };
        await saveBlob(app, new Blob([JSON.stringify(fc)], { type: 'application/geo+json' }), { name: 'outlines.geojson', types: ['.geojson'], description: 'GeoJSON' });
        return { summary: t('{n, plural, one {# outline} other {# outlines}}', { n: gs.length }) };
      }
      const v = S.all('vlayer').find((x) => x.role === 'accepted-detections');
      if (!v) return { summary: t('no accepted detections') };
      const out = app.encodeLayer(v.id, 'geojson');
      await saveBlob(app, out.blob, { name: 'accepted-detections.geojson', types: out.types, description: 'GeoJSON' });
      return { summary: t('{n, plural, one {# feature} other {# features}}', { n: S.all('feature').filter((f) => f.vlayer === v.id).length }) };
    } },
    // dialog(params): the step opens a dialog when nobody gives it files (REG-150 refuses it).
    convertFolder: { title: N_('Convert a folder'), defaults: { vectors: 'geoparquet' }, dialog: (p) => !p.files?.length, run: async ({ vectors, files: given }, ctx) => {
      let files = given;
      if (ctx?.headless && !files?.length) throw new Error('headless: give the files to convert (params.files, File objects)');
      if (files?.length) {
        await app.convertFiles(files, vectors);
        return { summary: t('{n, plural, one {# file} other {# files}}', { n: files.length }) };
      }
      if (window.showDirectoryPicker) files = await walkFolder(await window.showDirectoryPicker({ mode: 'read' }));
      else files = await pickFiles(app, { multiple: true, accept: [], description: t('Files to convert') });
      await app.convertFiles(files, vectors);
      return { summary: t('{n, plural, one {# file} other {# files}}', { n: files.length }) };
    } },
    // Most commands open a dialog, and nothing says which: a run with nobody at the page refuses them all.
    command: { title: N_('Run a command'), defaults: { id: '' }, dialog: () => true, run: async ({ id, args }) => {
      await C.run(id, args);
      return { summary: id };
    } },
  };

  const runner = new RecipeRunner(OPS, { app });
  let panelEl = null;
  let selected = -1;

  const fmtMs = (ms) => (ms === null ? '' : ms < 1000 ? t('{ms} ms', { ms: int(ms) }) : t('{s} s', { s: num(ms / 1000, 1) }));
  // Step states as shown (the data-status attribute keeps the English value).
  const STATUS = { pending: N_('pending'), running: N_('running'), waiting: N_('waiting'), done: N_('done'), failed: N_('failed'), stale: N_('stale'), skipped: N_('skipped') };

  function drawer(i) {
    const step = runner.recipe.steps[i];
    const rows = Object.entries(step.params).map(([k, v]) => {
      const inp = h('input', { class: 'inp', value: Array.isArray(v) ? v.join(', ') : String(v), 'aria-label': k, 'data-id': `recipe:param:${k}` });
      inp.addEventListener('change', () => {
        const raw = inp.value.trim();
        const val = Array.isArray(v) ? raw.split(',').map((s) => s.trim()).filter(Boolean) : typeof v === 'number' ? Number(raw) : typeof v === 'boolean' ? raw === 'true' : raw;
        runner.setParam(i, k, val);
      });
      return h('label', { class: 'rcp-param' }, h('span', {}, k), inp);
    });
    const rerun = h('button', { class: 'btn btn-small btn-primary', 'data-id': 'recipe:rerun', disabled: runner.running }, t('Re-run from here'));
    rerun.addEventListener('click', () => go(i));
    return h('div', { class: 'rcp-drawer', 'data-id': 'recipe:drawer' }, h('strong', {}, `${i + 1}. ${tr(step.title)}`), step.note ? h('p', { class: 'hint' }, tr(step.note)) : null, rows.length ? h('div', { class: 'rcp-params' }, rows) : h('p', { class: 'hint' }, t('This step has no parameters.')), runner.state[i].error ? h('p', { class: 'err' }, msgOf(runner.state[i].error)) : null, h('div', { class: 'btn-row' }, rerun));
  }

  function render() {
    if (!panelEl) return;
    clear(panelEl);
    const pick = h('select', { class: 'inp', 'data-id': 'recipe:pick', 'aria-label': t('Recipe') }, h('option', { value: '' }, t('Choose a recipe…')), ...[...BUILTIN, ...(app.prefs.get('recipes') ?? [])].map((r) => h('option', { value: r.id, selected: runner.recipe?.id === r.id }, tr(r.name))));
    pick.addEventListener('change', () => {
      const r = [...BUILTIN, ...(app.prefs.get('recipes') ?? [])].find((x) => x.id === pick.value);
      if (r) open(r);
    });
    const btn = (label, id, fn, dis = false) => {
      const b = h('button', { class: 'btn btn-small', 'data-id': `recipe:${id}`, disabled: dis }, label);
      b.addEventListener('click', fn);
      return b;
    };
    const bar = h('div', { class: 'btn-row rcp-bar' }, pick, btn(t('Run'), 'run', () => go(0), !runner.recipe || runner.running), btn(t('Resume'), 'resume', () => runner.resume(), !runner.waiting), btn(t('Stop'), 'stop', () => runner.stop(), !runner.running), btn(t('Open…'), 'open', importRecipe), btn(t('Save…'), 'save', exportRecipe, !runner.recipe));
    const r = runner.recipe;
    const steps = r
      ? h(
          'ol',
          { class: 'rcp-steps', 'data-id': 'recipe:steps', role: 'list' },
          r.steps.map((s, i) => {
            const st = runner.state[i];
            const li = h('li', { class: ['rcp-step', `rcp-${st.status}`, i === selected ? 'sel' : null], tabindex: '0', 'data-step': String(i), 'data-status': st.status, title: tr(s.note || s.title) }, h('span', { class: 'rcp-n' }, String(i + 1)), h('span', { class: 'rcp-t' }, tr(s.title)), h('span', { class: 'rcp-s small muted' }, st.status === 'waiting' ? t('waiting for you · Enter') : [tr(STATUS[st.status] ?? st.status), st.summary, fmtMs(st.ms)].filter(Boolean).join(' · ')));
            li.addEventListener('click', () => {
              selected = selected === i ? -1 : i;
              render();
            });
            return li;
          }),
        )
      : h('p', { class: 'hint pad' }, t('A recipe runs a workflow step by step in front of you. Choose one, or open a .gwrecipe.json file.'));
    panelEl.append(h('div', { class: 'rcp' }, bar, r?.description ? h('p', { class: 'hint' }, tr(r.description)) : null, steps, r && selected >= 0 ? drawer(selected) : null));
  }
  runner.on('change', render);

  function open(r) {
    runner.load(r);
    selected = -1;
    app.panels?.show?.('recipes', 'bottom') ?? app.activeMp()?.docks.show('recipes');
    return runner.recipe;
  }
  async function go(from) {
    const r = await runner.run(from);
    if (r.ok) app.toast(t('Recipe "{name}" finished.', { name: tr(runner.recipe.name) }), { kind: 'info' });
    else if (r.error) app.toast(t('Recipe step {n} failed: {msg}', { n: r.failed + 1, msg: msgOf({ message: r.error, i18n: r.i18n }) }), { kind: 'warn', ms: 9000 });
    return r;
  }
  async function importRecipe() {
    const [f] = await pickFiles(app, { accept: ['.json'], description: t('GIS Workbench recipe') });
    if (f) await importRecipeFile(f);
  }
  /** A .gwrecipe.json file (Open… or a drop): validated, kept with the user's recipes and opened. */
  async function importRecipeFile(f) {
    const r = validateRecipe(JSON.parse(await f.text()), OPS);
    const mine = (app.prefs.get('recipes') ?? []).filter((x) => x.id !== r.id);
    app.prefs.set('recipes', [...mine, r].slice(-20));
    open(r);
  }
  async function exportRecipe() {
    const r = runner.toJSON();
    await saveBlob(app, new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }), { name: `${r.id}.gwrecipe.json`, types: ['.json'], description: t('GIS Workbench recipe') });
  }

  // Enter continues past a gate (not while typing).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !runner.waiting || e.target.closest?.('input, textarea, select, [contenteditable], .dlg')) return;
    e.preventDefault();
    runner.resume();
  });

  app.on('ready', (mp) => mp.docks.register({ id: 'recipes', title: t('Recipe'), icon: 'template', home: 'bottom', create: (a, m, el) => {
    panelEl = el;
    render();
    return { onShow: render };
  } }));
  C.implement('rcp.open', { run: () => app.panels?.toggle('recipes', 'bottom'), checked: () => !!app.activeMp()?.docks.isOpen('recipes') });
  for (const r of BUILTIN) C.implement(`rcp.${r.id}`, { run: () => (open(r), go(0)) });
  C.implement('rcp.import', { run: importRecipe });
  // ---- headless runner (REQ-GAP-01): no dock, no dialogs, files returned ----
  let runN = 0;
  const fileOf = async (blob, name) => {
    const out = { name, type: blob.type || 'application/octet-stream', size: blob.size };
    if (/^(text\/|application\/(json|geo\+json|vnd\.google-earth\.kml\+xml))/.test(out.type) && blob.size < 8e6) out.text = await blob.text();
    else out.blob = blob;
    return out;
  };
  /** Run fn with saves captured into `files` (the previous capture is restored afterwards). */
  async function capturing(files, fn) {
    const prev = app.saveCapture;
    app.saveCapture = (blob, name) => files.push(fileOf(blob, name));
    try {
      return await fn();
    } finally {
      app.saveCapture = prev;
    }
  }
  /**
   * A headless run of a recipe: {id, start(from), resume(), status()}. gates: 'continue' passes
   * every gate, 'stop' waits at a gate until resume(), 'fail' ends the run at the first gate.
   * params: overrides {stepId: {param: value}} applied before the run.
   */
  function headless(src, { gates = 'continue', params = {} } = {}) {
    const r = validateRecipe(src, OPS);
    for (const s of r.steps) if (params[s.id]) s.params = { ...s.params, ...params[s.id] };
    const id = `run-${++runN}`;
    const R = new RecipeRunner(OPS, { app, headless: true });
    R.load(r);
    const files = [];
    let state = 'idle';
    let result = null;
    let gateFailed = -1;
    let onWait = null;
    R.on('change', () => {
      const i = R.current;
      if (state !== 'running' || i < 0 || R.state[i]?.status !== 'waiting') return;
      // The runner sets its gate right after this event: act on the next microtask.
      queueMicrotask(() => {
        if (!R.waiting) return;
        if (gates === 'continue') R.resume();
        else if (gates === 'fail') {
          gateFailed = i;
          R.stop();
        } else {
          state = 'waiting';
          onWait?.();
        }
      });
    });
    let done = null;
    const until = () => new Promise((res) => (onWait = res));
    /** Run kick() (which starts or resumes the runner) with saves captured until the run ends or waits at a gate. */
    async function drive(kick) {
      // The capture is set before the runner starts: a step's first save can happen synchronously.
      await capturing(files, () => {
        kick();
        return Promise.race([done, until()]);
      });
    }
    const status = () => ({
      run: id,
      recipe: r.id,
      state,
      ok: state === 'done' && !!result?.ok,
      ...(result?.failed !== undefined ? { failed: result.failed, error: result.error } : {}),
      ...(gateFailed >= 0 ? { failed: gateFailed, error: `gate "${r.steps[gateFailed].title}" reached (gates: fail)` } : {}),
      steps: r.steps.map((s, i) => ({ id: s.id, op: s.op, status: R.state[i].status, ms: R.state[i].ms, summary: String(R.state[i].summary ?? '') })),
      files: files.filter((f) => !(f instanceof Promise)),
    });
    return {
      id,
      async start(from = 0) {
        state = 'running';
        await drive(() => {
          done = R.run(from).then((res) => {
            result = res;
            state = gateFailed >= 0 ? 'stopped' : res.ok ? 'done' : res.error ? 'failed' : 'stopped';
          });
        });
        for (let i = 0; i < files.length; i++) files[i] = await files[i];
      },
      async resume() {
        if (state !== 'waiting') throw new Error(`the run is ${state}, not waiting at a gate`);
        state = 'running';
        await drive(() => R.resume());
        for (let i = 0; i < files.length; i++) files[i] = await files[i];
      },
      status,
    };
  }
  /**
   * Why a recipe cannot run with nobody at the page (the command-line runner, REG-150), or null:
   * a review gate set to stop, or a step that opens a dialog. Checked before the run starts.
   * params: the run's overrides, with any files the command line gives a step.
   */
  function unattended(src, { gates = 'continue', params = {} } = {}) {
    const r = validateRecipe(src, OPS);
    for (const s of r.steps) {
      const o = OPS[s.op];
      if (o.gate && gates === 'stop') return { step: s.id, title: s.title, reason: 'is a review gate, and gates are set to stop' };
      if (o.dialog?.({ ...s.params, ...(params[s.id] ?? {}) })) return { step: s.id, title: s.title, reason: s.op === 'command' ? 'runs a command, which may open a dialog' : 'opens a dialog unless the command line gives it files' };
    }
    return null;
  }
  /** One operation headless → {summary, files}. */
  async function runOp(op, params = {}) {
    const o = OPS[op];
    if (!o) throw new Error(`no recipe operation ${op}; call recipes.ops`);
    const files = [];
    const p = { ...(o.defaults ?? {}), ...params };
    const fake = { state: [{ summary: '' }], emit() {} };
    const r = await capturing(files, async () => {
      const x = (await o.run(p, { app, headless: true, step: { op, params: p }, index: 0, runner: fake })) ?? {};
      if (o.gate && o.after) return (await o.after(p, { app, headless: true })) ?? x;
      return x;
    });
    return { summary: String(r.summary ?? ''), files: await Promise.all(files) };
  }

  app.recipes = { runner, ops: OPS, builtin: BUILTIN, open, run: go, validate: (r) => validateRecipe(r, OPS), importFile: importRecipeFile, headless, runOp, unattended };
}
