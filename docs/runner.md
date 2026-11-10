# Running recipes from the command line

The sidecar can run a recipe with no page open: from a shell, from a script, or on a schedule. The run uses the same code as a run in the page, because it *is* the app. The runner starts your installed Chrome or Edge headless, opens the sidecar's own copy of the app, runs the recipe, and writes its files to a folder.

- **What you need:** the sidecar, unpacked or installed, with its `app` folder, and Chrome or Edge installed. If neither browser is found, the run stops and says so.
- **What it doesn't do:** nothing listens on a network port, and no window opens. The browser talks to the runner over a pipe ([decision 0013](decisions/0013-runner-drives-the-browser-over-a-pipe.md)). The browser profile is new for each run and is deleted afterwards. The runner checks the app against `app/SHA256SUMS` before opening it, and won't run a copy that doesn't match.

## Running a recipe

```
gwb-run <recipe> --out DIR [--in [STEP=]FILE]... [--gates continue|fail|stop] [--params FILE] [--timeout SECONDS]
gwb-run --check
```

- **`<recipe>`** is a `.gwrecipe.json` file (save one from the Recipe dock with **Save…**), or the id of a built-in recipe such as `folder-to-cog`.
- **`--in FILE`** opens a file in the app before the run, as if you had dropped it on the map. **`--in STEP=FILE`** gives the file to one step instead. For example, `--in s1=site.tif` gives it to the first step of `folder-to-cog`. Repeat `--in` for more files.
- **`--out DIR`** is where the run's files go. Each file gets a `.gwb-provenance.json` beside it, naming the recipe, the inputs, each step and the app build. The run also appends to `DIR/gwb-run.log` and writes its status to `DIR/gwb-run.json`.
- **`--gates`** decides what happens at a review gate:
  - `continue` (the default) goes on without a review;
  - `fail` ends the run at the first gate;
  - `stop` refuses a recipe that has a gate, because nobody is there to review it.
- **`--params FILE`** is a JSON object of parameter overrides by step id, as in `recipes.run`.
- **`--timeout`** ends the run after that many seconds. The default is one hour.
- **`--check`** starts the browser and the app, prints their versions, and stops. Run it first to see that everything is in place.

Before anything runs, the runner refuses a recipe that would wait for a person and names the step. That is a step that opens a dialog, such as **Run a command**, or **Convert a folder** with no files given. With `--gates stop`, a review gate is refused too.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | The run finished and every step succeeded |
| 1 | A step failed, or the run stopped at a gate |
| 2 | The command line is wrong, or an input or recipe file is missing |
| 3 | No browser was found, the app copy doesn't match `SHA256SUMS`, or the browser or app didn't start |
| 4 | The recipe was refused before it started |
| 5 | The run didn't finish within `--timeout` |

### Without a console window

`gwb-sidecar run …` takes the same arguments as `gwb-run`, but opens no window at all, not even a console. Use it from Windows Task Scheduler, which would otherwise show a console window while the run lasts. It prints nothing. Its log in the output folder, and its exit code, are its output.
