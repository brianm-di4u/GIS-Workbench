# Running recipes from the command line

The sidecar can run a recipe with no page open: from a shell, from a script, or on a schedule. The run uses the same code as a run in the page, because it *is* the app. The runner starts your installed Chrome or Edge headless, opens the sidecar's own copy of the app, runs the recipe, and writes its files to a folder.

- **What you need:** the sidecar, unpacked or installed, with its `app` folder, and Chrome or Edge installed. If neither browser is found, the run stops and says so.
- **What it doesn't do:** nothing listens on a network port, and no window opens. The browser talks to the runner over a pipe ([decision 0017](decisions/0017-runner-drives-the-browser-over-a-pipe.md)). The browser profile is new for each run and is deleted afterwards. A run that is stopped from outside, by Task Scheduler's time limit for example, leaves its temporary folder, and a later run removes it two days on. The runner checks the app against `app/SHA256SUMS` before opening it, and won't run a copy that doesn't match.

## Running a recipe

```
gwb-run <recipe> --out DIR [--in [STEP=]FILE]... [--gates continue|fail|stop] [--params FILE] [--timeout SECONDS]
gwb-run --check
```

- **`<recipe>`** is a `.gwrecipe.json` file (save one from the Recipe dock with **Save…**), or the id of a built-in recipe such as `folder-to-cog`.
- **`--in FILE`** opens a file in the app before the run, as if you had dropped it on the map. **`--in STEP=FILE`** gives the file to one step instead. For example, `--in s1=site.tif` gives it to the first step of `folder-to-cog`. Repeat `--in` for more files. When the part before the first `=` is a plain name (ASCII letters, digits, `-` and `_`), it is a step; so a file whose own name has an `=` in it, such as `site=2024.tif`, is given with a folder, as in `./site=2024.tif`. A project (`.gwb`) has to be the only file to open: the app drops files opened with it. A project that references imagery can't run unattended, because nobody is there to relink its imagery; the run stops at **Relink Imagery** and says so.
- **`--out DIR`** is where the run's files go. Each file gets a `.gwb-provenance.json` beside it, naming the recipe, the inputs, each step and the app build. The run also appends to `DIR/gwb-run.log` and, when it gets to the end, writes its status to `DIR/gwb-run.json`. A run that stops before then (refused, timed out, or unable to start) removes the last run's `gwb-run.json`, so a missing one means the last run didn't finish, and `gwb-run.log` says why. Files from an earlier run stay until a run writes over them.
- **`--gates`** decides what happens at a review gate:
  - `continue` (the default) goes on without a review;
  - `fail` ends the run at the first gate;
  - `stop` refuses a recipe that has a gate, because nobody is there to review it.
- **`--params FILE`** is a JSON object of parameter overrides by step id, as in `recipes.run`.
- **`--timeout`** ends the run after that many seconds. The default is one hour, and the most is one day.
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

`gwb-sidecar run …` takes the same arguments as `gwb-run`, but opens no window at all, not even a console. Use it from Windows Task Scheduler, which would otherwise show a console window while the run lasts. It prints nothing. Its log in the output folder, and its exit code, are its output. A run that can't start, such as one whose input is missing, still writes why to that log; only a command line it can't read leaves nothing but exit code 2.

## Running it on a schedule

The sidecar never registers a task or a service. A schedule is one that you create, and it runs as you, when you are signed in.

### Windows Task Scheduler

Change the paths, then run this in PowerShell. It creates a task that runs every night at 02:00, runs later if the computer was off at 02:00, runs on a laptop's battery too (Task Scheduler's default is AC power only), and is stopped after two hours:

<!-- example: windows-task -->
```powershell
$sidecar = 'C:\Tools\GIS Workbench Sidecar\gwb-sidecar.exe'
$arguments = 'run folder-to-cog --in "s1=C:\GIS\in\site.tif" --out "C:\GIS\nightly"'
$action = New-ScheduledTaskAction -Execute $sidecar -Argument $arguments
$trigger = New-ScheduledTaskTrigger -Daily -At 2am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName 'GIS Workbench nightly' -Action $action -Trigger $trigger -Settings $settings
```

The same command and schedule with `schtasks`, from a Command Prompt. `schtasks` can't set the other three settings, so this task doesn't run on battery or after a missed 02:00, and has Task Scheduler's default time limit. On a laptop, use the PowerShell form:

<!-- example: windows-schtasks -->
```
schtasks /Create /TN "GIS Workbench nightly" /SC DAILY /ST 02:00 /TR "\"C:\Tools\GIS Workbench Sidecar\gwb-sidecar.exe\" run folder-to-cog --in \"s1=C:\GIS\in\site.tif\" --out \"C:\GIS\nightly\""
```

To see how it went, open `C:\GIS\nightly\gwb-run.log`, or look at the task's **Last Run Result** in Task Scheduler (0 is success; the other codes are in the table above). To remove the task, run `Unregister-ScheduledTask -TaskName 'GIS Workbench nightly'`, or `schtasks /Delete /TN "GIS Workbench nightly"`.

### Linux: cron

Add this line with `crontab -e`:

<!-- example: linux-cron -->
```
0 2 * * * /usr/bin/gwb-run folder-to-cog --in s1=/home/me/gis/in/site.tif --out /home/me/gis/nightly >/dev/null 2>&1
```

The run's own log is in the output folder, so cron doesn't need to mail you its output.

### Linux: a systemd timer

Save these two files in `~/.config/systemd/user/`:

<!-- example: linux-service -->
```ini
# gwb-nightly.service
[Unit]
Description=GIS Workbench nightly recipe

[Service]
Type=oneshot
ExecStart=/usr/bin/gwb-run folder-to-cog --in s1=%h/gis/in/site.tif --out %h/gis/nightly
```

<!-- example: linux-timer -->
```ini
# gwb-nightly.timer
[Unit]
Description=GIS Workbench nightly recipe

[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

Then run `systemctl --user daemon-reload` and `systemctl --user enable --now gwb-nightly.timer`. `systemctl --user list-timers` shows when it runs next. To run it while you are signed out, run `loginctl enable-linger` once.

## How these examples are tested

The automated tests never register a task. They run each example's command directly, and check each task definition without creating it (`sidecar/gwb-sidecar/tests/gwb_run.rs`):

- **Windows:** the PowerShell example builds its task with `New-ScheduledTask` instead of registering it.
- **Linux:** `systemd-analyze verify` checks the units, and a transient `systemd-run --user` timer runs the command.

Before each release, `npm run test:schedule-live` registers a real one-shot task with a unique name. It waits for the task to run, checks its files and provenance, and deletes the task. Its report goes in the release evidence.
