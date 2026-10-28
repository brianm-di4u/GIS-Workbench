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

export const name = 'recipes';

/** Built-in recipes (REQ-PIP-04). */
export const BUILTIN = [
  {
    format: FORMAT,
    id: 'airfield-triage',
    name: 'Airfield triage',
    description: 'Auto contrast, find aircraft in view, review them, then a chip deck and a GeoJSON of the accepted ones.',
    steps: [
      { op: 'contrast', title: 'Auto contrast' },
      { op: 'find', title: 'Find aircraft', params: { objects: ['aircraft', 'helicopter'], threshold: 0.15 } },
      { op: 'gate', title: 'Review the detections', params: { message: 'Accept or reject each aircraft (✓ / ✗ in the queue, or J then 2 / 1), then press Enter.' } },
      { op: 'chips', title: 'Chip the accepted ones', params: { status: 'accepted', max: 20 } },
      { op: 'exportDeck', title: 'Export the chip deck' },
      { op: 'exportGeojson', title: 'Export GeoJSON', params: { what: 'accepted-detections' } },
    ],
  },
  {
    format: FORMAT,
    id: 'damage-triage',
    name: 'Damage triage',
    description: 'Align the post-event image to the pre-event one with learned matching, find damage, review it, export GeoJSON.',
    steps: [
      { op: 'align', title: 'Co-register (AI)' },
      { op: 'find', title: 'Find damage', params: { objects: ['collapsed building', 'flooded area', 'debris'], threshold: 0.12 } },
      { op: 'gate', title: 'Review the candidates', params: { message: 'Use flicker (hold F) or swipe (S + drag) against the pre-event image; accept or reject each candidate, then press Enter.' } },
      { op: 'exportGeojson', title: 'Export GeoJSON', params: { what: 'accepted-detections' } },
    ],
  },
  {
    format: FORMAT,
    id: 'folder-to-cog',
    name: 'Convert a folder to COG',
    description: 'Every raster in a folder becomes a Cloud-Optimized GeoTIFF; vectors become GeoParquet.',
    steps: [{ op: 'convertFolder', title: 'Convert the folder', params: { vectors: 'geoparquet' } }],
  },
  {
    format: FORMAT,
    id: 'building-extraction',
    name: 'Building extraction',
    description: 'Find buildings in view, outline each with SAM 2.1 and square its corners, review, export GeoJSON.',
    steps: [
      { op: 'find', title: 'Find buildings', params: { objects: ['building'], threshold: 0.15 } },
      { op: 'outline', title: 'Outline and square them', params: { square: true, max: 60 } },
      { op: 'gate', title: 'Review the outlines', params: { message: 'Delete wrong outlines (select, Del) or redraw them, then press Enter.' } },
      { op: 'exportGeojson', title: 'Export GeoJSON', params: { what: 'outlines' } },
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
    contrast: { title: 'Auto contrast', pythonHint: 'gw.auto_contrast()', run: () => {
      const p = app.aiLocal.autoContrast();
      return { summary: `CLAHE clip ${p.clip}, gamma ${p.gamma}` };
    } },
    find: { title: 'Find objects', defaults: { objects: ['vehicle'], threshold: 0.15 }, pythonHint: 'gw.find(objects, threshold)', run: async ({ objects, threshold }) => {
      const r = await app.aiLocal.find(objects, { threshold });
      return { summary: Object.entries(r.counts).map(([k, n]) => `${n} ${k}`).join(', ') };
    } },
    search: { title: 'Search imagery', defaults: { text: '', k: 8 }, run: async ({ text, k }) => {
      const r = await app.aiLocal.search(text, { k });
      return { summary: `${r.hits.length} places, best ${r.hits[0]?.score.toFixed(2) ?? '–'}` };
    } },
    align: { title: 'Co-register (AI)', pythonHint: 'gw.auto_align_ai()', run: async () => {
      const r = await app.autoAlignAI();
      return { summary: `${r.used} tie points, RMS ${r.rms.toFixed(2)} px` };
    } },
    outline: { title: 'Outline detections', defaults: { square: true, max: 60 }, run: async ({ square, max }, ctx) => {
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
          S.transact('Recipe outline', (tx) => tx.set(r.graphic, 'tag', 'recipe-outline'));
          n++;
        }
        ctx.runner.state[ctx.index].summary = `${n} / ${list.length}`;
        ctx.runner.emit('change');
      }
      return { summary: `${n} outlines` };
    } },
    gate: { title: 'Review', gate: true, defaults: { message: 'Review, then press Enter.' }, run: ({ message }) => {
      const n = pending().length;
      if (n) {
        app.activeMp()?.docks.show('detections');
        app.detections.zoomTo?.(pending()[0].id);
      }
      app.toast(`Recipe paused: ${message}`, { ms: 8000 });
      return { summary: n ? `${n} to review` : 'waiting for you' };
    }, after: () => ({ summary: `${S.all('detection').filter((d) => d.status === 'accepted').length} accepted, ${S.all('detection').filter((d) => d.status === 'rejected').length} rejected` }) },
    chips: { title: 'Chip detections', defaults: { status: 'accepted', max: 20 }, run: async ({ status, max }) => {
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
      return { summary: `${list.length} chips in the session deck` };
    } },
    exportDeck: { title: 'Export the deck', run: async () => {
      if (!app.sessionDeck?.length) return { summary: 'nothing to export' };
      await C.run('deck.export');
      return { summary: `${app.sessionDeck.length} slides` };
    } },
    exportGeojson: { title: 'Export GeoJSON', defaults: { what: 'accepted-detections' }, run: async ({ what }) => {
      if (what === 'outlines') {
        const gs = S.all('graphic').filter((g) => g.tag === 'recipe-outline' && g.anchor === 'ground');
        if (!gs.length) return { summary: 'no outlines' };
        const fc = { type: 'FeatureCollection', features: gs.map((g) => ({ type: 'Feature', properties: { source: g.provenance?.model ?? 'SAM', iou: g.provenance?.iou ?? null }, geometry: { type: 'Polygon', coordinates: [[...g.coords.map((c) => [c[0], c[1]]), [g.coords[0][0], g.coords[0][1]]]] } })) };
        await saveBlob(app, new Blob([JSON.stringify(fc)], { type: 'application/geo+json' }), { name: 'outlines.geojson', types: ['.geojson'], description: 'GeoJSON' });
        return { summary: `${gs.length} outlines` };
      }
      const v = S.all('vlayer').find((x) => x.role === 'accepted-detections');
      if (!v) return { summary: 'no accepted detections' };
      const out = app.encodeLayer(v.id, 'geojson');
      await saveBlob(app, out.blob, { name: 'accepted-detections.geojson', types: out.types, description: 'GeoJSON' });
      return { summary: `${S.all('feature').filter((f) => f.vlayer === v.id).length} features` };
    } },
    convertFolder: { title: 'Convert a folder', defaults: { vectors: 'geoparquet' }, run: async ({ vectors }) => {
      let files;
      if (window.showDirectoryPicker) files = await walkFolder(await window.showDirectoryPicker({ mode: 'read' }));
      else files = await pickFiles(app, { multiple: true, accept: [], description: 'Files to convert' });
      await app.convertFiles(files, vectors);
      return { summary: `${files.length} files` };
    } },
    command: { title: 'Run a command', defaults: { id: '' }, run: async ({ id }) => {
      await C.run(id);
      return { summary: id };
    } },
  };

  const runner = new RecipeRunner(OPS, { app });
  let panelEl = null;
  let selected = -1;

  const fmtMs = (ms) => (ms === null ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

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
    const rerun = h('button', { class: 'btn btn-small btn-primary', 'data-id': 'recipe:rerun', disabled: runner.running }, 'Re-run from here');
    rerun.addEventListener('click', () => go(i));
    return h('div', { class: 'rcp-drawer', 'data-id': 'recipe:drawer' }, h('strong', {}, `${i + 1}. ${step.title}`), step.note ? h('p', { class: 'hint' }, step.note) : null, rows.length ? h('div', { class: 'rcp-params' }, rows) : h('p', { class: 'hint' }, 'This step has no parameters.'), runner.state[i].error ? h('p', { class: 'err' }, runner.state[i].error) : null, h('div', { class: 'btn-row' }, rerun));
  }

  function render() {
    if (!panelEl) return;
    clear(panelEl);
    const pick = h('select', { class: 'inp', 'data-id': 'recipe:pick', 'aria-label': 'Recipe' }, h('option', { value: '' }, 'Choose a recipe…'), ...[...BUILTIN, ...(app.prefs.get('recipes') ?? [])].map((r) => h('option', { value: r.id, selected: runner.recipe?.id === r.id }, r.name)));
    pick.addEventListener('change', () => {
      const r = [...BUILTIN, ...(app.prefs.get('recipes') ?? [])].find((x) => x.id === pick.value);
      if (r) open(r);
    });
    const btn = (label, id, fn, dis = false) => {
      const b = h('button', { class: 'btn btn-small', 'data-id': `recipe:${id}`, disabled: dis }, label);
      b.addEventListener('click', fn);
      return b;
    };
    const bar = h('div', { class: 'btn-row rcp-bar' }, pick, btn('Run', 'run', () => go(0), !runner.recipe || runner.running), btn('Resume', 'resume', () => runner.resume(), !runner.waiting), btn('Stop', 'stop', () => runner.stop(), !runner.running), btn('Open…', 'open', importRecipe), btn('Save…', 'save', exportRecipe, !runner.recipe));
    const r = runner.recipe;
    const steps = r
      ? h(
          'ol',
          { class: 'rcp-steps', 'data-id': 'recipe:steps', role: 'list' },
          r.steps.map((s, i) => {
            const st = runner.state[i];
            const li = h('li', { class: ['rcp-step', `rcp-${st.status}`, i === selected ? 'sel' : null], tabindex: '0', 'data-step': String(i), 'data-status': st.status, title: s.note || s.title }, h('span', { class: 'rcp-n' }, String(i + 1)), h('span', { class: 'rcp-t' }, s.title), h('span', { class: 'rcp-s small muted' }, st.status === 'waiting' ? 'waiting for you · Enter' : [st.status, st.summary, fmtMs(st.ms)].filter(Boolean).join(' · ')));
            li.addEventListener('click', () => {
              selected = selected === i ? -1 : i;
              render();
            });
            return li;
          }),
        )
      : h('p', { class: 'hint pad' }, 'A recipe runs a workflow step by step in front of you. Choose one, or open a .gwrecipe.json file.');
    panelEl.append(h('div', { class: 'rcp' }, bar, r?.description ? h('p', { class: 'hint' }, r.description) : null, steps, r && selected >= 0 ? drawer(selected) : null));
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
    if (r.ok) app.toast(`Recipe "${runner.recipe.name}" finished.`);
    else if (r.error) app.toast(`Recipe step ${r.failed + 1} failed: ${r.error}`, { kind: 'warn', ms: 9000 });
    return r;
  }
  async function importRecipe() {
    const [f] = await pickFiles(app, { accept: ['.json'], description: 'GIS Workbench recipe' });
    if (!f) return;
    const r = validateRecipe(JSON.parse(await f.text()), OPS);
    const mine = (app.prefs.get('recipes') ?? []).filter((x) => x.id !== r.id);
    app.prefs.set('recipes', [...mine, r].slice(-20));
    open(r);
  }
  async function exportRecipe() {
    const r = runner.toJSON();
    await saveBlob(app, new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }), { name: `${r.id}.gwrecipe.json`, types: ['.json'], description: 'GIS Workbench recipe' });
  }

  // Enter continues past a gate (not while typing).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !runner.waiting || e.target.closest?.('input, textarea, select, [contenteditable], .dlg')) return;
    e.preventDefault();
    runner.resume();
  });

  app.on('ready', (mp) => mp.docks.register({ id: 'recipes', title: 'Recipe', icon: 'list', home: 'bottom', create: (a, m, el) => {
    panelEl = el;
    render();
    return { onShow: render };
  } }));
  C.implement('rcp.open', { run: () => app.panels?.toggle('recipes', 'bottom'), checked: () => !!app.activeMp()?.docks.isOpen('recipes') });
  for (const r of BUILTIN) C.implement(`rcp.${r.id}`, { run: () => (open(r), go(0)) });
  C.implement('rcp.import', { run: importRecipe });
  app.recipes = { runner, ops: OPS, builtin: BUILTIN, open, run: go, validate: (r) => validateRecipe(r, OPS) };
}
