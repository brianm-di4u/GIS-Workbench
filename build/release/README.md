# Release tooling

The assets are built on the admin's Windows PC, with WSL for the Linux packages, because CI can't build about 70 files and 4 GB in its time limit. The [release skill](../../.claude/skills/release/SKILL.md) says when each step runs and who runs it. These tools replace the one-off scripts earlier releases used.

| Step | Command | What it does |
|---|---|---|
| 1 | `npm run build` | Builds `dist/`, with every pack. A build that skipped packs is caught in step 3. |
| 2 | `node build/release/sidecar.mjs --version <sidecar v>` | Builds the Windows packages, then the Linux ones in WSL. Earlier output is moved aside, not deleted. Run it every release, even when the sidecar version doesn't change, because the packages carry this build's HTML. |
| 3 | `node build/release/stage.mjs --sidecar-version <sidecar v> --out <new folder> --like <previous tag>` | Copies the assets into one folder, checks the HTML and packs against `dist/SHA256SUMS`, compares asset families with the previous release, writes the web app's SBOM (`gis-workbench-<v>-sbom.cdx.json`) from `dist/build-report.json`, and writes `SHA256SUMS`. |
| 4 | The admin runs the `release` workflow, `action: cut` | Creates the draft prerelease. |
| 5 | `node build/release/upload.mjs --tag <tag> --dir <staged folder>` | Uploads to the draft, six at a time, smallest first. Run it again to resume. It ends by checking every digest. |
| 6 | `node build/release/upload.mjs --tag <tag> --dir <staged folder> --check` | Checks the digests again just before the admin publishes. |
| 7 | `wsl.exe -e bash "<repo in WSL>/build/release/wsl-e2e.sh" "<repo in WSL>"` | Runs the sidecar browser tests on Linux. |

Defaults: the sidecar output folder is `D:/gwb-sidecar-deps/release`, and the WSL tools live in `~/gwb` (set `GWB_WSL_HOME` to move them). Keep the staged folder on D:. A release is over 4 GB.

`upload.mjs` uses `gh`, so it uploads with whatever login `gh` has. It never handles a token itself.

The c61 and c22 campaign checks run from the private Docs repository, against the same build.
