# Runbook

## When something breaks

1. **Stop the bleeding.** Revert or turn off the flag. See [ROLLBACK.md](ROLLBACK.md).
2. **Open an incident record** in `docs/incidents/` from [TEMPLATE.md](incidents/TEMPLATE.md).
3. **Fix the cause** on a branch.
4. **Add an eval case,** so the reviewer would catch this next time.

Ask the admin only if data, money, or legal exposure is involved.

## Where to look

- **Nightly issues.** The nightly run files an issue when something fails. Check open `triage` issues.
- **The digest.** The summary of what agents did and what waits for the admin.
- **Smoke check.** `node .pipeline/smoke.mjs`.
- **GitHub Releases.** Published files and `SHA256SUMS`.
- **The site.** `https://www.gisworkbench.com`, hosted on Vercel. The apps are at `/app/gis-workbench` and `/app/gis-workbench-lite`.

There is no telemetry, so there are no usage dashboards or user error logs. Reports come from issues.

## Common operations

- **Cut a release.** Use the `release` skill. Every public release needs a decision from the admin.
- **Soak time.** A prerelease soaks for 24 hours before it is promoted.
- **Update the site.** Open a PR on the site repo with the app files, changelog, and `BUILD`. The admin merges it. Pushing the site's `main` deploys production in about 10 seconds. Check the live app's hash against `SHA256SUMS`.
- **Rotate the agent token.** The admin creates a new restricted token with the same permissions, stores it in the agents' separate GitHub CLI profile, then revokes the old one. Agents never handle the token. Do this on expiry, or at once if it may have leaked.

## The delegate

The Gardener is the GitHub account `gwb-gardener`, listed under `delegates` in `pipeline.config.json`. [Decision 0012](decisions/0012-gardener-delegate.md) says what it may and may not do.

- **Rotate its token.** Do this on expiry, or at once if the token may have leaked. In your own terminal, never in an agent session:
  1. On the `gwb-gardener` account, create a new classic token with only `public_repo` and `workflow`.
  2. Run `pwsh -File "C:\Development Pipeline\tools\setup-delegate.ps1" -Clone "C:\GIS Workbench\gwb-garden"`. It prompts for the token without echoing it and writes the clone's untracked `.claude/settings.local.json`.
  3. Revoke the old token on the account.
  4. In the Gardener's clone, check that `gh api user --jq .login` prints `gwb-gardener`.
- **Lift a suspension.** Two bad gardener-approved merges inside the breaker window, or a forged `pipeline/gate` check, make the bot open a `pipeline:delegate-suspended` issue. Read why, fix the cause, then comment `/rearm` on that issue yourself. Only an admin's comment lifts it. A command the delegate posted while suspended never counts, so it must post it again.
- **Turn it off.** Remove `delegates` from `pipeline.config.json` in a PR you approve. With the key gone the pipeline behaves as it did before: only an admin's commands count, and the admin-only paths no longer apply. Then revoke the token, and remove the account as a collaborator. `tiers.adminOnlyPaths` and `models` can stay.

## Dependencies

| Service | Used for | If it is down |
|---|---|---|
| GitHub | Code, CI, Releases | No merges or releases. Released files are unaffected |
| Vercel | The site and hosted apps | The site is down. A downloaded file still works |
| npm and crates.io | Building | Builds from a clean cache fail. Released files are unaffected |

The app itself depends on nothing at run time.

## Failure notes

- Release files are built on the admin's machine, not in CI, so a release needs the admin.
- A red `main` blocks T1 and T2 merges until it is fixed or reverted. T0 changes, clean reverts, and PRs that cite the red-main issue can still merge.
- Headless browser runs use SwiftShader. Pixel differences on other GPUs are not failures.
