# Recipe oracles

Every library recipe (`app/src/recipes/catalog.js`) is checked against an independent tool's output, as SDP-2.8 §4.5 requires. The oracle runs offline and is never shipped. CI never runs it; it compares against the outputs committed here.

## Layout

One folder per recipe, named after its id:

```
tests/oracles/<recipe-id>/
  case.json         what to run and what to compare (below)
  provenance.json   the oracle, its version, the command, the inputs and the date
  <outputs>         the oracle's outputs, or what CI compares of them
fixtures/recipes/<recipe-id>/
  <inputs>          a small test fixture, separate from the recipe's sample data
  SOURCE.txt        where each file came from, how it was cut, and its licence
tests/tools/oracles/<recipe_id>.py
                    the script that ran the oracle and wrote the folder above
```

`case.json`:

- `recipe`: the library recipe's id.
- `inputs`: files by step, as gwb-run's `--in STEP=FILE` gives them.
- `outputs`: each file the recipe writes, with its `kind` (how it is compared) and its `oracle` file here.
- `tolerance`: in words, what must be equal and what may differ.
- `second`: an input unlike the first (another CRS, data type or size), with `why`. The recipe must run on it.
- `refuse`: an input the recipe's preconditions must refuse, with the `reason` the refusal must contain. Nothing may be written.

## Who reads it

- `tests/e2e/28-recipe-library.spec.js` runs each case in the built app, through gwb-run's page script and through `recipes.run`. It compares the outputs with the oracle and checks the second input, the refusal and the gallery entry. It runs in the `ci` project, so on every PR.
- `tests/e2e/sidecar/28-gwb-run-library.spec.js` runs each case through gwb-run itself and checks that the command line gives the page's bytes. It runs in the `sidecar` projects, and skips, saying so, without gwb-run.
- `tests/tools/recipe-oracle.mjs` reads the cases and does the comparing.

A folder here without a `case.json` fails both specs. A recipe is never left out quietly.

## Adding a recipe

1. Add it to `catalog.js` with its library fields.
2. Cut a small fixture into `fixtures/recipes/<id>/`, with its `SOURCE.txt`.
3. Write `tests/tools/oracles/<id>.py`. Check the oracle's licence from its primary source first.
4. Run the script, commit what it writes, and add a comparison to `recipe-oracle.mjs` if the output kind is new.

## Kinds

| Kind | Oracle record | Compared |
|---|---|---|
| `cog` | GDAL's COG of the same input: size, EPSG, geotransform, each band's type, no-data and SHA-256 of its samples, the overview sizes | All of it equal; tiled. Overview samples are not compared. |
