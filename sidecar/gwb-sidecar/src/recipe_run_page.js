// gwb-run's half in the page (REG-150): one recipe, run with nobody at the page. gwb-run evaluates
// this function over the DevTools pipe as (FN)(ARGS). The files the command line gives are already
// on the hidden file input #gwb-run-inputs, in the order of ARGS.inputs.
//
// ARGS: { id | recipe, gates, params, inputs: [name, …], timeoutMs }. An input named "open" is
// opened in the app before the run; any other name is a step id, and the step gets the file in its
// `files` parameter.
//
// Returns { refused } when the recipe cannot run unattended (nothing has run), else { status } with
// the run's status from recipes.run and window.__gwbRun.chunk(i, offset, length) to read file i's
// bytes as base64.
async ({ id, recipe, gates, params, inputs, timeoutMs }) => {
  const app = window.gisworkbench;
  const el = document.getElementById('gwb-run-inputs');
  const files = el ? [...el.files] : [];
  el?.remove();
  const R = app.recipes;
  const src = recipe ?? [...R.builtin, ...(app.prefs.get('recipes') ?? [])].find((r) => r.id === id);
  if (!src) return { refused: `there is no built-in recipe "${id}" (give a .gwrecipe.json file instead)` };
  let checked;
  try {
    checked = R.validate(src);
  } catch (e) {
    return { refused: `the recipe is not valid: ${e.message}` };
  }
  const steps = new Set(checked.steps.map((s) => s.id));
  const open = [];
  const run = { ...params };
  for (let i = 0; i < inputs.length; i++) {
    const name = inputs[i];
    if (name === 'open') open.push(files[i]);
    else if (steps.has(name)) run[name] = { ...run[name], files: [...(run[name]?.files ?? []), files[i]] };
    else return { refused: `--in ${name}=…: the recipe has no step "${name}" (its steps: ${[...steps].join(', ')})` };
  }
  const why = R.unattended(checked, { gates, params: run });
  if (why) return { refused: `step "${why.title}" (${why.step}) ${why.reason}` };
  if (open.length) {
    const packs = open.filter((f) => /\.gwpack$/i.test(f.name));
    if (packs.length) await app.openPackFiles(packs);
    const rest = open.filter((f) => !/\.gwpack$/i.test(f.name));
    if (rest.length) await app.openFiles(rest);
    // Rasters read their statistics after they open; the first step may need them.
    const t0 = Date.now();
    while (![...app.layers.values()].every((l) => l.stats)) {
      if (Date.now() - t0 > timeoutMs) throw new Error('the inputs did not finish opening');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const status = await app.api.v2.recipes.run({ ...(recipe ? { recipe } : { id }), gates, params: run });
  const blobs = status.files.map((f) => f.blob ?? new Blob([f.text], { type: f.type }));
  window.__gwbRun = {
    async chunk(i, offset, length) {
      const url = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = () => rej(r.error);
        r.readAsDataURL(blobs[i].slice(offset, offset + length));
      });
      return url.slice(url.indexOf(',') + 1);
    },
  };
  return { status: { ...status, files: status.files.map((f, i) => ({ name: f.name, type: f.type, size: blobs[i].size })) } };
}
